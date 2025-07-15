// index.js (FHIR Event Forwarder Mediator)
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import {
  registerMediator,
  activateHeartbeat
} from 'openhim-mediator-utils'
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


// HTTPS agent in development
if (process.env.NODE_ENV === 'development') {
  const agent = new https.Agent({ rejectUnauthorized: false })
  axios.defaults.httpsAgent = agent
  console.log('⚠️  DEV MODE: Self‑signed certs accepted')
}

// Register mediator & channels, then start heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Forwarder registration error:', err)
    process.exit(1)
  }
  console.log('✅ Forwarder registered')

  const channels = mediatorConfig.defaultChannelConfig || []
  Promise.all(channels.map(ch =>
    axios.post(
      `${openhimConfig.apiURL}/channels`,
      { ...ch, mediator_urn: mediatorConfig.urn },
      { auth: { username: openhimConfig.username, password: openhimConfig.password } }
    )
    .then(() => console.log(`✅ Channel created: ${ch.name}`))
    .catch(e => console.error(`❌ Channel ${ch.name} error:`, e.response?.data || e.message))
  ))
  .then(() => {
    console.log('✅ All channels processed')
    activateHeartbeat(openhimConfig)
  })
})

const app = express()
app.use(express.json({ limit: '20mb' }))

// Seen set persistence
const SEEN_FILE = './seen.json'
let seen = new Set()
try {
  if (fs.existsSync(SEEN_FILE)) {
    seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE)))
  }
} catch {
  console.warn('No se pudo leer seen.json, se creará uno nuevo.')
}
function saveSeen() {
  fs.writeFile(SEEN_FILE, JSON.stringify([...seen]), err => {
    if (err) console.error('❌ Error guardando seen.json:', err)
  })
}

// Generic retry
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

async function getFromProxy(path) {
  const url = `${process.env.FHIR_PROXY_URL}/fhir${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, { validateStatus: false })
  return resp.data
}

async function putToNode(resource) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  return retryRequest(async () => {
    logStep('PUT (node)', url)
    const resp = await axios.put(url, resource, {
      headers: { 'Content-Type': 'application/fhir+json' }
    })
    logStep('✅ PUT OK', resource.resourceType, resource.id, resp.status)
    return resp.status
  })
}

// Health endpoints (strip prefix)
app.get(['/forwarder/_health'], (_req, res) => res.status(200).send('OK'))

// Event endpoint (strip prefix, then handle /event)
app.post(['/forwarder/_event'], async (req, res) => {
  logStep('📩 [FORWARDER] POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Falta uuid' })
  if (seen.has(uuid)) {
    logStep('🔁 Evento duplicado, ignorado', uuid)
    return res.status(200).json({ status: 'duplicado', uuid })
  }
  seen.add(uuid); saveSeen()
  logStep('🔔 Procesando nuevo evento', uuid)

  const results = []
  try {
    // 1. Encounter
    const encounter = await getFromProxy(`/Encounter/${uuid}`)
    results.push(await putToNode(encounter))

    // 2. Patient
    const patientId = encounter.subject?.reference?.split('/').pop()
    if (patientId) {
      const patient = await getFromProxy(`/Patient/${patientId}`)
      results.push(await putToNode(patient))
    }

    // 3. Related resources
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

    logStep('🎉 Process completed', uuid)
    res.json({ status: 'ok', uuid, sent: results.length })
  } catch (err) {
    logStep('❌ ERROR processing:', err.message)
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.FORWARDER_MEDIATOR_PORT || 8003
app.listen(PORT, () => logStep(`FHIR Forwarder listening on port ${PORT}`))
