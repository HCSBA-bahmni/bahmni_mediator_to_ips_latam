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

// HTTPS agent for development (self‑signed)
if (process.env.NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false })
  console.log('⚠️  DEV MODE: self‑signed certs accepted')
}

// 1) Register mediator & channels, then heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err)
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

// 2) seen.json: track last versionId per uuid
const SEEN_FILE = './seen.json'
let seenVersions = {}
try {
  if (!fs.existsSync(SEEN_FILE)) {
    fs.writeFileSync(SEEN_FILE, JSON.stringify({}), { flag: 'wx' })
  }
  seenVersions = JSON.parse(fs.readFileSync(SEEN_FILE))
} catch (e) {
  console.warn('⚠️ Could not init seen.json:', e.message)
  seenVersions = {}
}
function saveSeen() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seenVersions))
  } catch (err) {
    console.error('❌ Could not write seen.json:', err)
  }
}

// 3) retry helper
const MAX_RETRIES = 3
async function retryRequest(fn, max = MAX_RETRIES) {
  let attempt = 0, lastErr
  while (attempt < max) {
    try { return await fn() }
    catch (e) {
      lastErr = e; attempt++
      console.warn(`⏳ Retry ${attempt}/${max}:`, e.message)
      await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }
  throw lastErr
}

function logStep(msg, ...d) {
  console.log(new Date().toISOString(), msg, ...d)
}

// 4) FHIR proxy calls
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')

async function getFromProxy(path) {
  // path like "/Encounter/{uuid}" or "/Patient/{id}"
  const url = `${baseProxy}/fhir${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    auth: {
      username: process.env.OPENHIM_USER,
      password: process.env.OPENHIM_PASS
    },
    validateStatus: false
  })
  logStep('DEBUG proxy status:', resp.status)
  logStep('DEBUG proxy headers:', JSON.stringify(resp.headers))
  const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
  logStep('DEBUG proxy body (500ch):', body.substring(0,500))
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
      headers: {'Content-Type':'application/fhir+json'}
    })
    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
    return r.status
  })
}

// 5) Health endpoint
app.get('/forwarder/_health', (_req, res) => res.send('OK'))

// 6) Event endpoint
app.post('/forwarder/_event', async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  try {
    // fetch Encounter
    const enc = await getFromProxy(`/Encounter/${uuid}`)
    if (!enc.resourceType) throw new Error('Invalid FHIR resource')
    const ver = enc.meta?.versionId
    if (seenVersions[uuid] === ver) {
      logStep('🔁 No version change, skipping', uuid, ver)
      return res.json({ status:'duplicate', uuid, version:ver })
    }

    // new version
    seenVersions[uuid] = ver
    saveSeen()
    logStep('🔔 Processing version', uuid, ver)

    const results = []
    results.push(await putToNode(enc))

    // patient
    const pid = enc.subject?.reference?.split('/').pop()
    if (pid) {
      const pat = await getFromProxy(`/Patient/${pid}`)
      results.push(await putToNode(pat))
    }

    // related types
    const types = [
      'Observation','Condition','Procedure','MedicationRequest',
      'Medication','AllergyIntolerance','DiagnosticReport',
      'Immunization','CarePlan','Appointment','DocumentReference'
    ]
    for (const t of types) {
      const bundle = await getFromProxy(`/${t}?encounter=${uuid}`)
      if (bundle.entry) {
        for (const {resource} of bundle.entry) {
          results.push(await putToNode(resource))
        }
      }
    }

    logStep('🎉 Done', uuid)
    res.json({ status:'ok', uuid, sent:results.length })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error:e.message })
  }
})

const PORT = process.env.FORWARDER_MEDIATOR_PORT || 8003
app.listen(PORT, () => logStep(`FHIR Forwarder on port ${PORT}`))
