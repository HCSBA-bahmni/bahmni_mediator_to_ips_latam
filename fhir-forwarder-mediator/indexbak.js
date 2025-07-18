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
// FHIR_PROXY_URL must include the full prefix, e.g.
//   FHIR_PROXY_URL=https://10.68.174.206:5000/proxy/fhir
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')

async function getFromProxy(path) {
  const url = `${baseProxy}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    validateStatus: false,
    auth: {
      username: openhimConfig.username,
      password: openhimConfig.password
    }
  })
  logStep('DEBUG proxy status:', resp.status)
  const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
  logStep('DEBUG proxy body (500ch):', body.substring(0, 500))
  return resp.data
}

// 5) PUT al FHIR Node
async function putToNode(resource) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  logStep('PUT (node)', url)
  const r = await axios.put(url, resource, {
    headers: { 'Content-Type': 'application/fhir+json' },
    validateStatus: false
  })
  if (r.status >= 400) {
    logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2))
    throw new Error(`PUT failed ${r.status}`)
  }
  logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
}

// 6) Health endpoint
app.get('/forwarder/_health', (_req, res) => res.send('OK'))

// 7) Event endpoint
app.post('/forwarder/_event', async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  try {
    // 7.1) Traer Encounter
    const enc = await getFromProxy(`/Encounter/${uuid}`)
    if (!enc.resourceType) throw new Error('Invalid FHIR resource')

    // 7.2) Subir Patient
    const patientRef = enc.subject?.reference
    if (!patientRef) throw new Error('Missing subject.reference')
    const patientId = patientRef.split('/')[1]
    logStep('📤 Subiendo Patient…', patientId)
    const patient = await getFromProxy(`/Patient/${patientId}`)
    await putToNode(patient)

    // 7.3) Subir Practitioners referenciados en el Encounter
    if (Array.isArray(enc.participant)) {
      for (const p of enc.participant) {
        const indyRef = p.individual?.reference
        if (indyRef?.startsWith('Practitioner/')) {
          const pracId = indyRef.split('/')[1]
          logStep('📤 Subiendo Practitioner…', pracId)
          const prac = await getFromProxy(`/Practitioner/${pracId}`)
          await putToNode(prac)
        }
      }
    }

    // 7.4) (Opcional) Subir Locations referenciadas
    if (Array.isArray(enc.location)) {
      for (const loc of enc.location) {
        const locRef = loc.location?.reference
        if (locRef?.startsWith('Location/')) {
          const locId = locRef.split('/')[1]
          logStep('📤 Subiendo Location…', locId)
          const location = await getFromProxy(`/Location/${locId}`)
          await putToNode(location)
        }
      }
    }

    // 7.5) Subir el Encounter
    logStep('📤 Subiendo Encounter…', uuid)
    await putToNode(enc)

    // 7.6) Subir recursos relacionados al Encounter
    const types = [
      'Observation','Condition','Procedure','MedicationRequest',
      'Medication','AllergyIntolerance','DiagnosticReport',
      'Immunization','CarePlan','Appointment','DocumentReference'
    ]
    let sent = 1 /*Encounter*/ + 1 /*Patient*/
    if (enc.participant) sent += enc.participant.length
    if (enc.location)    sent += enc.location.length

    for (const t of types) {
      const bundle = await getFromProxy(`/${t}?encounter=${uuid}`)
      if (bundle.entry) {
        for (const { resource } of bundle.entry) {
          logStep('📤 Subiendo', resource.resourceType, resource.id)
          await putToNode(resource)
          sent++
        }
      }
    }

    logStep('🎉 Done', uuid)
    res.json({ status:'ok', uuid, sent })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_MEDIATOR_PORT || 8003
app.listen(PORT, () => logStep(`FHIR Forwarder on port ${PORT}`))
