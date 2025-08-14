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
  const url = `${baseProxy}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    validateStatus: false,
    auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS }
  })
  logStep('DEBUG proxy status:', resp.status)
  if (resp.status >= 400) {
    // lanza para que el try/catch te lo capture
    throw new Error(`${path} returned ${resp.status}`)
  }
  return resp.data
}

// 5) PUT al FHIR Node
async function putToNode(resource) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  try {
    logStep('PUT (node)', url)
    const r = await axios.put(url, resource, {
      headers:{ 'Content-Type':'application/fhir+json' },
      validateStatus: false
    })
    if (r.status >= 400) {
      logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2))
      throw new Error(`PUT failed ${r.status}`)
    }
    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
    return r.status
  } catch (e) {
    if (e.response?.data) {
      logStep('❌ Axios error body:', JSON.stringify(e.response.data, null, 2))
    }
    throw e
  }
}

// --- Recursive helpers ---
const uploadedLocations     = new Set()
const uploadedEncounters    = new Set()
const uploadedObservations  = new Set()
const uploadedPractitioners = new Set()

// recursion para Location.partOf
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

// recursion para Encounter.partOf
async function uploadEncounterWithParents(encId) {
  if (uploadedEncounters.has(encId)) return

  // 1) fetch del Encounter
  logStep('🔍 Fetching Encounter…', encId)
  const encRes = await getFromProxy(`/Encounter/${encId}`)

  // 2) si tiene parent, lo sube primero
  const parentRef = encRes.partOf?.reference
  if (parentRef?.startsWith('Encounter/')) {
    const parentId = parentRef.split('/')[1]
    await uploadEncounterWithParents(parentId)
  }

  // 3) Subir este Encounter
  logStep('📤 Subiendo Encounter…', encId)
  await putToNode(encRes)
  uploadedEncounters.add(encId)
}

// --- Recursive upload for Observation.hasMember ---
// recursion para Observation.hasMember: devuelve cuántos sube
async function uploadObservationWithMembers(obsId) {
  if (uploadedObservations.has(obsId)) return 0
  uploadedObservations.add(obsId)

  const obs = await getFromProxy(`/Observation/${obsId}`)
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

async function uploadPractitioner(pracRef, sentCounter) {
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

// inicializamos el contador ANTES de usarlo
  let sent = 0

  try {
    // 7.1) Fetch Encounter desde el proxy
    const enc = await getFromProxy(`/Encounter/${uuid}`)
    if (!enc.resourceType) throw new Error('Invalid FHIR resource')




    // 7.2) Duplicate check
    //const ver = enc.meta?.versionId
    //if (seenVersions[uuid] === ver) {
    //  logStep('🔁 No version change, skipping', uuid, ver)
    //  return res.json({ status:'duplicate', uuid, version:ver })
    //}
    //seenVersions[uuid] = ver
    //saveSeen()
    //logStep('🔔 Processing version', uuid, ver)


    // 7.3) Extraer patientId de enc.subject.reference
    const pid = enc.subject?.reference?.split('/').pop()
    if (!pid) throw new Error('Encounter.subject.reference inválido')


    // 7.4.1) Subir Patient 
    const [ , patientId ] = enc.subject.reference.split('/')
    logStep('📤 Subiendo Patient…', patientId)
    const patient = await getFromProxy(`/Patient/${patientId}`)
    await putToNode(patient)
    sent++


    // 7.4.2) NOTIFICAR al ITI‑65 Mediator que el Patient ya existe
    try {
      logStep('🔔 Notificando ITI‑65 Mediator para', patientId)   // <<-- AQUI
      await axios.post(
        `${process.env.OPENHIM_SUMMARY_ENDPOINT}`,                // = https://10.68.174.206:5000/lacpass/_iti65
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

    // 7.7) Subir recursos relacionados
    //const types = [
    //  'Observation','Condition','Procedure','MedicationRequest',
    //  'Medication','AllergyIntolerance','DiagnosticReport',
    //  'Immunization','CarePlan','Appointment','DocumentReference'
    //];

    const types = [
      'Observation','Condition','Procedure','MedicationRequest',
      'Medication','AllergyIntolerance','DiagnosticReport'
    ];

    //este bloque busca primero por encuentro y luego por paciente. para el ips necesito que pregunte por todo. 
    //for (const t of types) {
    //  let bundle;

      // 1) Intentar search por Encounter
    //  try {
    //    bundle = await getFromProxy(`/${t}?encounter=${uuid}`);
    //  } catch (err) {
    //    logStep(`⚠️ Skip ${t} by encounter:`, err.message);
        // 2) Fallback por Patient
    //    try {
    //      bundle = await getFromProxy(`/${t}?patient=${pid}`)
    //      logStep(`ℹ️ Fallback ${t} by patient`)
    //    } catch {
    //      logStep(`⚠️ Skip ${t} by patient`)
    //      continue
    //    }
    //  }

        for (const t of types) {
      let bundle;

      // 1) Intentar search por Encounter
      try {
        bundle = await getFromProxy(`/${t}?patient=${encodeURIComponent(pid)}`);
        if (!bundle?.entry?.length) {
          logStep(`ⓘ ${t}: 0 resultados para patient=${pid}`);
          continue;
        }
        logStep(`✓ ${t} by patient`);
      } catch (err) {
        logStep(`⚠️ Skip ${t} by patient: ${err?.message ?? err}`);
        continue;
      }


      // 3) Sólo procesar Bundles con entries
      if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) continue;

      for (const { resource } of bundle.entry) {
        // --- Pre-upload referenced Practitioners ---
        const pracRefs = [
          resource.recorder?.reference,
          resource.requester?.reference,
          ...(resource.performer||[]).map(p => p.actor?.reference)
        ].filter(r => r?.startsWith('Practitioner/'));

        for (const r of pracRefs) {
          sent += await uploadPractitioner(r);
        }

        // --- Eliminar recorder si no está subido ---
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

        // --- Subida con retry en caso de fallo por Practitioner faltante ---
        try {
          if (resource.resourceType === 'Observation') {
            sent += await uploadObservationWithMembers(resource.id)
          } else {
            logStep('📤 Subiendo', resource.resourceType, resource.id)
            await putToNode(resource)
            sent++
          }
        } catch (e) {
          const diag = e.response?.data?.issue?.[0]?.diagnostics || ''
          if (diag.includes('Resource Practitioner/')) {
            try {
              logStep('⚠️ Retry sin referencias Practitioner tras error:', resource.id)
              delete resource.recorder
              delete resource.requester
              await putToNode(resource)
              sent++
            } catch (retryErr) {
              throw retryErr
            }
          } else {
            throw e
          }
        }
      }
    }

    
    // 7.8) Guardar la versión del Encounter procesado
    logStep('🎉 Done', uuid)
    res.json({ status:'ok', uuid, sent })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_MEDIATOR_PORT || 8003
app.listen(PORT, () => logStep(`FHIR Forwarder on port ${PORT}`))
