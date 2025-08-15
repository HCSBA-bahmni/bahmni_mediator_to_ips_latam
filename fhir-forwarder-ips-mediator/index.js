// index.improved.js (FHIR Event Forwarder Mediator — mejoras IPS e integridad referencial)
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
    (mediatorConfig.defaultChannelConfig || []).map(ch =>
      axios.post(
        `${openhimConfig.apiURL}/channels`,
        { ...ch, mediator_urn: mediatorConfig.urn },
        { auth: { username: openhimConfig.username, password: openhimConfig.password } }
      )
      .then(() => console.log(`✅ Channel created: ${ch.name}`))
      .catch(e => {
        const msg = e?.response?.data || e?.message || e.toString()
        if (typeof msg === 'string' && msg.includes('duplicate key error')) {
          console.log(`ℹ️ Channel already exists: ${ch.name}`)
        } else {
          console.error(`❌ Channel ${ch.name} error:`, msg)
        }
      })
    )
  ).then(() => {
    console.log('✅ All channels processed')
    activateHeartbeat(openhimConfig)
  })
})

const app = express()
app.use(express.json({ limit: '20mb' }))

// 2) seen.json: track last versionId per uuid (no-op si no usas versión)
const SEEN_FILE = './seen.json'
let seenVersions = {}

try {
  if (!fs.existsSync(SEEN_FILE)) fs.writeFileSync(SEEN_FILE, '{}', 'utf8')
  const raw = fs.readFileSync(SEEN_FILE, 'utf8').trim()
  seenVersions = raw ? JSON.parse(raw) : {}
} catch (e) {
  console.warn('⚠️ Could not parse seen.json, re-initializing:', e.message)
  seenVersions = {}
  try { fs.writeFileSync(SEEN_FILE, '{}', 'utf8') } catch (err) {
    console.error('❌ Could not overwrite seen.json:', err)
  }
}

function saveSeen() {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seenVersions), 'utf8') }
  catch (err) { console.error('❌ Could not write seen.json:', err) }
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
//   FHIR_PROXY_URL debe incluir el prefijo completo, ej:
//   FHIR_PROXY_URL=https://10.68.174.206:5000/proxy/fhir
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')
async function getFromProxy(path) {
  const url = `${baseProxy}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    validateStatus: false,
    auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS }
  })
  logStep('DEBUG proxy status:', resp.status)
  if (resp.status >= 400) throw new Error(`${path} returned ${resp.status}`)
  return resp.data
}

// 5) PUT al FHIR Node con retry si falta Encounter
async function putToNode(resource) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`

  const doPut = async () => {
    logStep('PUT (node)', url)
    const r = await axios.put(url, resource, {
      headers:{ 'Content-Type':'application/fhir+json' },
      validateStatus: false
    })
    if (r.status >= 400) {
      logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2))
      const diag = r?.data?.issue?.[0]?.diagnostics || ''
      const m = typeof diag === 'string' ? diag.match(/Resource Encounter\/([A-Za-z0-9\-\.]{1,64})/) : null
      if (m) return { status: r.status, missingEncounterId: m[1] }
      throw new Error(`PUT failed ${r.status}`)
    }
    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
    return { status: r.status }
  }

  const first = await doPut()
  if (first.missingEncounterId) {
    logStep('ℹ️ Missing Encounter detected on PUT:', first.missingEncounterId)
    await uploadEncounterWithParents(first.missingEncounterId)
    const second = await doPut()
    if (second.missingEncounterId) {
      throw new Error(`Encounter ${second.missingEncounterId} still missing after retry`)
    }
    return second.status
  }
  return first.status
}

// --- Caches para evitar re-subidas
const uploadedLocations     = new Set()
const uploadedEncounters    = new Set()
const uploadedObservations  = new Set()
const uploadedPractitioners = new Set()

// Helper: asegurar Encounter referenciado existe
async function ensureEncounterRefs(resource) {
  const encRef = resource?.encounter?.reference
  if (encRef?.startsWith('Encounter/')) {
    const encId = encRef.split('/')[1]
    if (!uploadedEncounters.has(encId)) {
      await uploadEncounterWithParents(encId)
    }
  }
}

// recursion para Location.partOf
async function uploadLocationWithParents(locId) {
  if (uploadedLocations.has(locId)) return;
  logStep('🔍 Fetching Location…', locId);
  const loc = await getFromProxy(`/Location/${locId}`);
  const parentRef = loc.partOf?.reference;
  if (parentRef && parentRef.startsWith('Location/')) {
    const parentId = parentRef.split('/')[1];
    await uploadLocationWithParents(parentId);
  }
  logStep('📤 Subiendo Location…', locId);
  await putToNode(loc);
  uploadedLocations.add(locId);
}

// recursion para Encounter.partOf
async function uploadEncounterWithParents(encId) {
  if (uploadedEncounters.has(encId)) return
  logStep('🔍 Fetching Encounter…', encId)
  const encRes = await getFromProxy(`/Encounter/${encId}`)
  const parentRef = encRes.partOf?.reference
  if (parentRef?.startsWith('Encounter/')) {
    const parentId = parentRef.split('/')[1]
    await uploadEncounterWithParents(parentId)
  }
  logStep('📤 Subiendo Encounter…', encId)
  await putToNode(encRes)
  uploadedEncounters.add(encId)
}

// --- Recursive upload para Observation.hasMember
async function uploadObservationWithMembers(obsId) {
  if (uploadedObservations.has(obsId)) return 0
  uploadedObservations.add(obsId)

  const obs = await getFromProxy(`/Observation/${obsId}`)

  // Asegura Encounter antes del PUT
  await ensureEncounterRefs(obs)

  let count = 1
  if (Array.isArray(obs.hasMember)) {
    for (const m of obs.hasMember) {
      if (m.reference?.startsWith('Observation/')) {
        count += await uploadObservationWithMembers(m.reference.split('/')[1])
      }
    }
  }
  logStep('📤 Subiendo Observation…', obsId)
  await putToNode(obs)
  return count
}

async function uploadPractitioner(pracRef) {
  const pracId = pracRef.split('/')[1]
  if (uploadedPractitioners.has(pracId)) return 0
  logStep('🔍 Fetching Practitioner…', pracId)
  const prac = await getFromProxy(`/Practitioner/${pracId}`)
  logStep('📤 Subiendo Practitioner…', pracId)
  await putToNode(prac)
  uploadedPractitioners.add(pracId)
  return 1
}

// 6) Health endpoint del forwarder
app.get('/forwarder/_health', (_req, res) => res.send('OK'))

// 7) Event endpoint
app.post('/forwarder/_event', async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  let sent = 0

  try {
    // 7.1) Fetch Encounter desde el proxy
    const enc = await getFromProxy(`/Encounter/${uuid}`)
    if (!enc.resourceType) throw new Error('Invalid FHIR resource')

    // 7.3) Extraer patientId de enc.subject.reference
    const pid = enc.subject?.reference?.split('/').pop()
    if (!pid) throw new Error('Encounter.subject.reference inválido')

    // 7.4.1) Subir Patient 
    const [, patientId] = enc.subject.reference.split('/')
    logStep('📤 Subiendo Patient…', patientId)
    const patient = await getFromProxy(`/Patient/${patientId}`)
    await putToNode(patient)
    sent++

    // 7.4.2) NOTIFICAR al ITI‑65 Mediator que el Patient ya existe
    try {
      logStep('🔔 Notificando ITI‑65 Mediator para', patientId)
      await axios.post(
        `${process.env.OPENHIM_SUMMARY_ENDPOINT}`,
        { uuid: patientId },
        {
          auth: {
            username: process.env.OPENHIM_USER,
            password: process.env.OPENHIM_PASS
          },
          httpsAgent: axios.defaults.httpsAgent
        }
      )
      logStep('✅ Mediator ITI‑65 notificado')
    } catch (e) {
      console.error('❌ Error notificando ITI‑65 Mediator:', e.response?.data || e.message)
    }

    // 7.5) Subir Practitioners referenciados en el Encounter
    if (Array.isArray(enc.participant)) {
      for (const p of enc.participant) {
        const indyRef = p.individual?.reference
        if (indyRef?.startsWith('Practitioner/')) {
          sent += await uploadPractitioner(indyRef)
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

    // 7.6) Subir Encounter (y recursivamente sus padres)
    await uploadEncounterWithParents(uuid)
    sent++

    // 7.7) Subir recursos relacionados por paciente (IPS-friendly)
    const types = [
      'Observation','Condition','Procedure','MedicationRequest',
      'Medication','AllergyIntolerance','DiagnosticReport'
    ];

    for (const t of types) {
      let bundle;

      // 1) Buscar por paciente (longitudinal)
      try {
        bundle = await getFromProxy(`/${t}?patient=${encodeURIComponent(pid)}`);
        if (!bundle?.entry?.length) {
          logStep(`ⓘ ${t}: 0 resultados para patient=${pid}`);
          continue;
        }
        logStep(`✓ ${t} by patient`);
      } catch (err) {
        logStep(`⚠️ Skip ${t} by patient:`, err?.message ?? err);
        continue;
      }

      if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) continue;

      for (const { resource } of bundle.entry) {
        // 0) Asegura Encounter referenciado (clave para evitar 400)
        await ensureEncounterRefs(resource)

        // --- Pre-upload referenced Practitioners ---
        const pracRefs = [
          resource.recorder?.reference,
          resource.requester?.reference,
          ...(resource.performer||[]).map(p => p.actor?.reference)
        ].filter(r => r?.startsWith('Practitioner/'));

        for (const r of pracRefs) sent += await uploadPractitioner(r);

        // --- Eliminar recorder/requester si su Practitioner no quedó subido ---
        for (const field of ['recorder','requester']) {
          const ref = resource[field]?.reference
          if (ref?.startsWith('Practitioner/')) {
            const id = ref.split('/')[1]
            if (!uploadedPractitioners.has(id)) {
              logStep(`⚠️ Omitiendo ${field} no subido:`, id)
              delete resource[field]
            }
          }
        }

        // --- Filtrar performer[] si no están subidos ---
        if (Array.isArray(resource.performer)) {
          resource.performer = resource.performer.filter(p => {
            const ref = p.actor?.reference;
            if (ref?.startsWith('Practitioner/')) {
              const perfId = ref.split('/')[1];
              if (!uploadedPractitioners.has(perfId)) {
                logStep('⚠️ Omitiendo performer no subido:', perfId);
                return false;
              }
            }
            return true;
          });
          if (resource.performer.length === 0) delete resource.performer;
        }

        // --- Subida (Observations con recursión para hasMember)
        if (resource.resourceType === 'Observation') {
          sent += await uploadObservationWithMembers(resource.id)
        } else {
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
