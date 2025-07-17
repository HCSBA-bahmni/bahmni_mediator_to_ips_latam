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
  // 2.1) Si no existe, crearlo con {}
  if (!fs.existsSync(SEEN_FILE)) {
    fs.writeFileSync(SEEN_FILE, '{}', 'utf8')
  }
  // 2.2) Leerlo y parsearlo, o inicializar a {} si está vacío
  const raw = fs.readFileSync(SEEN_FILE, 'utf8').trim()
  seenVersions = raw ? JSON.parse(raw) : {}
} catch (e) {
  console.warn('⚠️ Could not parse seen.json, re-initializing:', e.message)
  seenVersions = {}
  try {
    fs.writeFileSync(SEEN_FILE, '{}', 'utf8')
  } catch (err) {
    console.error('❌ Could not overwrite seen.json:', err)
  }
}

function saveSeen() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seenVersions), 'utf8')
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
  // path es "/Encounter/{uuid}", "/Patient/{id}", etc.
  const url = `${baseProxy}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    validateStatus: false,
    auth: {
      username: process.env.OPENHIM_USER,
      password: process.env.OPENHIM_PASS
    }
  })
  // Logs de depuración
  logStep('DEBUG proxy status:', resp.status)
  logStep('DEBUG proxy headers:', JSON.stringify(resp.headers))
  const body = typeof resp.data === 'string'
    ? resp.data
    : JSON.stringify(resp.data)
  logStep('DEBUG proxy body (500ch):', body.substring(0, 500))
  return resp.data
}

//async function putToNode(resource) {
//  if (!resource?.resourceType || !resource.id) {
//    throw new Error('Invalid FHIR resource')
//  }
//  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
//  return retryRequest(async () => {
//    logStep('PUT (node)', url)
//    const r = await axios.put(url, resource, {
//      headers: {'Content-Type':'application/fhir+json'}
//    })
//    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
//    return r.status
//  })
//}
// Añadir arriba, justo tras la definición de putToNode:
const uploadedLocations = new Set();

async function uploadLocationWithParents(locId) {
  if (uploadedLocations.has(locId)) return;
  // 1) Traer el Location
  logStep('🔍 Fetching Location…', locId);
  const loc = await getFromProxy(`/Location/${locId}`);
  // 2) Si tiene partOf, sube primero al padre
  const parentRef = loc.partOf?.reference;
  if (parentRef && parentRef.startsWith('Location/')) {
    const parentId = parentRef.split('/')[1];
    await uploadLocationWithParents(parentId);
  }
  // 3) Subir este Location
  logStep('📤 Subiendo Location…', locId);
  await putToNode(loc);
  uploadedLocations.add(locId);
}


// 5) PUT al FHIR Node
async function putToNode(resource) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`;
  try {
    logStep('PUT (node)', url);
    const r = await axios.put(url, resource, {
      headers:{ 'Content-Type':'application/fhir+json' },
      validateStatus: false
    });
    if (r.status >= 400) {
      logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2));
      throw new Error(`PUT failed ${r.status}`);
    }
    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status);
    return r.status;
  } catch (e) {
    if (e.response?.data) {
      logStep('❌ Axios error body:', JSON.stringify(e.response.data, null, 2));
    }
    throw e;
  }
}

// 6) Health endpoint del forwarder
app.get('/forwarder/_health', (_req, res) => res.send('OK'))

// 7) Event endpoint
app.post('/forwarder/_event', async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

// inicializamos el contador ANTES de usarlo
  let sent = 0

  try {
    // 7.1) Fetch Encounter desde el proxy
    const enc = await getFromProxy(`/Encounter/${uuid}`)
    if (!enc.resourceType) throw new Error('Invalid FHIR resource')

    // 7.2) Extraer patientId de enc.subject.reference
    const pid = enc.subject?.reference?.split('/').pop()
    if (!pid) {
      throw new Error('Encounter.subject.reference inválido')
    }

    // (opcional) lógica duplicate comentada:
    // const ver = enc.meta?.versionId
    // if (seenVersions[uuid] === ver) {
    //   logStep('🔁 No version change, skipping', uuid, ver)
    //   return res.json({ status:'duplicate', uuid, version:ver })
    // }
    // seenVersions[uuid] = ver
    // saveSeen()
    // logStep('🔔 Processing version', uuid, ver)

    // 7.3) Subir Patient primero
    const [ , patientId ] = enc.subject.reference.split('/')
    logStep('📤 Subiendo Patient…', patientId)
    const patient = await getFromProxy(`/Patient/${patientId}`)
    await putToNode(patient)
    sent++

    // 7.4) Subir Practitioners referenciados en el Encounter
    if (Array.isArray(enc.participant)) {
      for (const p of enc.participant) {
        const indyRef = p.individual?.reference
        if (indyRef?.startsWith('Practitioner/')) {
          const pracId = indyRef.split('/')[1]
          logStep('📤 Subiendo Practitioner…', pracId)
          const prac = await getFromProxy(`/Practitioner/${pracId}`)
          await putToNode(prac)
          sent++
        }
      }
    }

    // 7.5) (Opcional) Subir Locations referenciadas
    if (Array.isArray(enc.location)) {
      for (const locEntry of enc.location) {
        const locRef = locEntry.location?.reference;
        if (locRef?.startsWith('Location/')) {
          const locId = locRef.split('/')[1];
          await uploadLocationWithParents(locId);
          sent++;
        }
      }
    }

    // 7.6) Subir Encounter
    logStep('📤 Subiendo Encounter…', uuid)
    await putToNode(enc)
    sent++

    // 7.7) Subir recursos relacionados
    const types = [
      'Observation','Condition','Procedure','MedicationRequest',
      'Medication','AllergyIntolerance','DiagnosticReport',
      'Immunization','CarePlan','Appointment','DocumentReference'
    ]
    //let sent = 1 /*Encounter*/ + 1 /*Patient*/
    //if (enc.participant) sent += enc.participant.length
    //if (enc.location)    sent += enc.location.length

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
