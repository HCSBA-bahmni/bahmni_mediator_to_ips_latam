// index.js (FHIR Event Forwarder Mediator)
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')

// --- OpenHIM config ---
const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL:   process.env.OPENHIM_API_URL || process.env.OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
}

// HTTPS agent for development (self-signed)
if (process.env.NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false })
  console.log('⚠️  DEV MODE: self‑signed certs accepted')
}

// 1) Register mediator & channels, then start heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Forwarder registration error:', err)
    process.exit(1)
  }
  console.log('✅ Forwarder registered')

  Promise.all(
    mediatorConfig.defaultChannelConfig.map(ch =>
      axios.post(
        `${openhimConfig.apiURL}/channels`,
        { ...ch, mediator_urn: mediatorConfig.urn },
        { auth: { username: openhimConfig.username, password: openhimConfig.password } }
      )
      .then(() => console.log(`✅ Channel created: ${ch.name}`))
      .catch(e => console.error(`❌ Channel ${ch.name} error:`, e.response?.data || e.message))
    )
  ).then(() => {
    console.log('✅ All channels processed')
    activateHeartbeat(openhimConfig)
  })
})

const app = express()
app.use(express.json({ limit: '20mb' }))

// 2) Ensure seen.json exists and load versions
const SEEN_FILE = './seen.json'
let seenVersions = {}
try {
  if (!fs.existsSync(SEEN_FILE)) {
    fs.writeFileSync(SEEN_FILE, JSON.stringify({}), { flag: 'wx' })
  }
  seenVersions = JSON.parse(fs.readFileSync(SEEN_FILE))
} catch (e) {
  console.warn('⚠️ Could not initialize seen.json:', e.message)
  seenVersions = {}
}
function saveSeen() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seenVersions))
  } catch (err) {
    console.error('❌ Error writing seen.json:', err)
  }
}

// 3) Retry helper
const MAX_RETRIES = 3
async function retryRequest(fn, maxRetries = MAX_RETRIES) {
  let attempt = 0, lastErr
  while (attempt < maxRetries) {
    try { return await fn() }
    catch (err) {
      lastErr = err; attempt++
      console.warn(`⏳ Retry ${attempt}/${maxRetries}:`, err.message)
      await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }
  throw lastErr
}

function logStep(msg, ...data) {
  console.log(new Date().toISOString(), msg, ...data)
}

// 4) FHIR proxy functions
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')

async function getFromProxy(path) {
  const url = `${baseProxy}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, { validateStatus: false })
  // DEBUG: show HTTP status, headers, body
  logStep('DEBUG proxy status:', resp.status)
  logStep('DEBUG proxy headers:', JSON.stringify(resp.headers))
  const bodyString = typeof resp.data === 'string'
    ? resp.data
    : JSON.stringify(resp.data)
  logStep('DEBUG proxy body (first 500 chars):', bodyString.substring(0, 500))
  return resp.data
}

async function putToNode(resource) {
  if (!resource?.resourceType || !resource.id) {
    throw new Error('Invalid FHIR resource')
  }
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  return retryRequest(async () => {
    logStep('PUT (node)', url)
    const r = await axios.put(url, resource, {
      headers: { 'Content-Type': 'application/fhir+json' }
    })
    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
    return r.status
  })
}

// 5) Healthcheck del forwarder
app.get('/forwarder/_health', (_req, res) => res.send('OK'))

// 6) Endpoint de eventos: procesa solo si cambia la versionId
app.post('/forwarder/_event', async (req, res) => {
  logStep('📩 [FORWARDER] POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  try {
    // 1) Traer Encounter
    const encounter = await getFromProxy(`/Encounter/${uuid}`)
    if (!encounter.resourceType) throw new Error('Invalid FHIR resource')

    const versionId = encounter.meta?.versionId
    if (seenVersions[uuid] === versionId) {
      logStep('🔁 Same version, skipping', uuid, versionId)
      return res.json({ status: 'duplicate', uuid, versionId })
    }

    // 2) Nueva version: marcar y guardar
    seenVersions[uuid] = versionId
    saveSeen()
    logStep('🔔 New version, processing', uuid, versionId)

    const results = []
    // 3) Put Encounter
    results.push(await putToNode(encounter))

    // 4) Put Patient
    const patId = encounter.subject?.reference?.split('/').pop()
    if (patId) {
      const patient = await getFromProxy(`/Patient/${patId}`)
      results.push(await putToNode(patient))
    }

    // 5) Otros recursos
    const types = [
      'Observation','Condition','Procedure','MedicationRequest',
      'Medication','AllergyIntolerance','DiagnosticReport',
      'Immunization','CarePlan','Appointment','DocumentReference'
    ]
    for (const type of types) {
      const bundle = await getFromProxy(`/${type}?encounter=${uuid}`)
      if (bundle.entry) {
        for (const { resource } of bundle.entry) {
          results.push(await putToNode(resource))
        }
      }
    }

    logStep('🎉 Processing complete', uuid)
    res.json({ status: 'ok', uuid, sent: results.length })
  } catch (err) {
    logStep('❌ ERROR processing:', err.message)
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.FORWARDER_MEDIATOR_PORT || 8003
app.listen(PORT, () => logStep(`FHIR Forwarder listening on port ${PORT}`))
