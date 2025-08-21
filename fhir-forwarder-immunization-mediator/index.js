// index.js (FHIR Event Forwarder Mediator) — Vacunación -> Immunization
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
  console.log('⚠️  DEV MODE: self-signed certs accepted')
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
  if (!fs.existsSync(SEEN_FILE)) fs.writeFileSync(SEEN_FILE, '{}', 'utf8')
  const raw = fs.readFileSync(SEEN_FILE, 'utf8').trim()
  seenVersions = raw ? JSON.parse(raw) : {}
} catch (e) {
  console.warn('⚠️ Could not parse seen.json, re-initializing:', e.message)
  seenVersions = {}
  try { fs.writeFileSync(SEEN_FILE, '{}', 'utf8') } catch (err) { console.error('❌ Could not overwrite seen.json:', err) }
}
function saveSeen() { try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seenVersions), 'utf8') } catch (err) { console.error('❌ Could not write seen.json:', err) } }

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
function logStep(msg, ...d) { console.log(new Date().toISOString(), msg, ...d) }

// 4) FHIR proxy calls
// FHIR_PROXY_URL must include the full prefix, e.g.
//   FHIR_PROXY_URL=https://10.68.174.206:5000/proxy/fhir
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')
async function getFromProxy(path) {
  const url = `${baseProxy}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    validateStatus: false,
    auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS },
    httpsAgent: axios.defaults.httpsAgent
  })
  logStep('DEBUG proxy status:', resp.status)
  if (resp.status >= 400) throw new Error(`${path} returned ${resp.status}`)
  return resp.data
}

// 5) PUT al FHIR Node
async function putToNode(resource) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  try {
    logStep('PUT (node)', url)
    const r = await axios.put(url, resource, {
      headers:{ 'Content-Type':'application/fhir+json' },
      validateStatus: false,
      httpsAgent: axios.defaults.httpsAgent
    })
    if (r.status >= 400) {
      logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2))
      throw new Error(`PUT failed ${r.status}`)
    }
    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
    return r.status
  } catch (e) {
    if (e.response?.data) logStep('❌ Axios error body:', JSON.stringify(e.response.data, null, 2))
    throw e
  }
}

// --- caches de subida para evitar duplicados ---
const uploadedLocations     = new Set()
const uploadedEncounters    = new Set()
const uploadedObservations  = new Set()
const uploadedPractitioners = new Set()
const uploadedOrganizations = new Set()

// recursion para Location.partOf
async function uploadLocationWithParents(locId) {
  if (uploadedLocations.has(locId)) return;
  const loc = await getFromProxy(`/Location/${locId}`)
  const parentRef = loc.partOf?.reference
  if (parentRef?.startsWith('Location/')) {
    const parentId = parentRef.split('/')[1]
    await uploadLocationWithParents(parentId)
  }
  await putToNode(loc)
  uploadedLocations.add(locId)
}

// recursion para Encounter.partOf
async function uploadEncounterWithParents(encId) {
  if (uploadedEncounters.has(encId)) return
  const encRes = await getFromProxy(`/Encounter/${encId}`)
  const parentRef = encRes.partOf?.reference
  if (parentRef?.startsWith('Encounter/')) {
    const parentId = parentRef.split('/')[1]
    await uploadEncounterWithParents(parentId)
  }
  await putToNode(encRes)
  uploadedEncounters.add(encId)
}

// recursion para Observation.hasMember
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
  await putToNode(obs)
  return count
}

async function uploadPractitioner(pracRef) {
  const pracId = pracRef.split('/')[1]
  if (uploadedPractitioners.has(pracId)) return 0
  const prac = await getFromProxy(`/Practitioner/${pracId}`)
  await putToNode(prac)
  uploadedPractitioners.add(pracId)
  return 1
}

// --- helpers de vacunación ---
const OMRS_IMM_PROFILE = 'http://fhir.openmrs.org/core/StructureDefinition/omrs-immunization' // :contentReference[oaicite:2]{index=2}
const IMM_SET_CODE = '1421AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' // Immunization history (grupo)
const IMM_CODES = {
  VACCINE:       '984AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Vacunación -> valueCodeableConcept
  VAX_DATE:      '1410AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Vaccination date -> valueDateTime
  LOT:           '1420AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Vaccine lot number -> valueString
  LOT_EXP:       '165907AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Vaccine lot expiration date -> valueDateTime
  MANUFACTURER:  '1419AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Vaccine manufacturer -> valueString
  DOSE_NUM:      '1418AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Immunization sequence number -> valueQuantity.value | string
  NON_CODED:     '166011AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Immunization, non-coded -> valueString
  RECEIVED:      '163100AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Procedure received by patient -> valueCodeableConcept (Sí/No)
  YES:           '1065AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Sí
  NO:            '1066AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'  // No
}
const IMM_ALL_CODES = new Set(Object.values(IMM_CODES).concat([IMM_SET_CODE]))

const toDate = (dt) => (typeof dt === 'string' ? dt.substring(0,10) : undefined)
const slug = (s) => ('org-' + String(s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''))

function indexByIdFromBundle(bundle) {
  const map = {}
  for (const e of (bundle.entry || [])) {
    const r = e.resource
    if (r?.id) map[r.id] = r
  }
  return map
}
function codeList(r) {
  return (r?.code?.coding || []).map(c => c.code).filter(Boolean)
}
function pickMemberByCode(ids, byId, code) {
  for (const id of ids) {
    const r = byId[id]
    if (!r) continue
    if (codeList(r).includes(code)) return r
  }
  return undefined
}
function getEncounterFirstPractitioner(enc) {
  const x = (enc.participant || []).find(p => p.individual?.reference?.startsWith('Practitioner/'))
  return x?.individual?.reference
}
function getEncounterFirstLocation(enc) {
  const x = (enc.location || []).find(l => l.location?.reference?.startsWith('Location/'))
  return x?.location?.reference
}
async function ensureOrganizationByName(name) {
  if (!name) return undefined
  const id = slug(name)
  if (uploadedOrganizations.has(id)) return { reference: `Organization/${id}` }
  const org = { resourceType:'Organization', id, name:String(name) }
  await putToNode(org)
  uploadedOrganizations.add(id)
  return { reference: `Organization/${id}` }
}

/**
 * Construye un Immunization (perfil OpenMRS) desde el grupo 1421 y sus hijas.
 * https://fhir.openmrs.org/StructureDefinition-omrs-immunization.html  (status, vaccineCode, patient, occurrence[x] 1..1, etc.)
 */
async function buildImmunizationFromGroup(groupObs, obsById, patientRef, enc, patientId) {
  const idList = (groupObs.hasMember || [])
    .map(m => m.reference?.replace(/^Observation\//,''))
    .filter(Boolean)

  // Elementos mapeados
  const vaxObs   = pickMemberByCode(idList, obsById, IMM_CODES.VACCINE)
  const freeObs  = pickMemberByCode(idList, obsById, IMM_CODES.NON_CODED)
  const dateObs  = pickMemberByCode(idList, obsById, IMM_CODES.VAX_DATE)
  const lotObs   = pickMemberByCode(idList, obsById, IMM_CODES.LOT)
  const expObs   = pickMemberByCode(idList, obsById, IMM_CODES.LOT_EXP)
  const mfgObs   = pickMemberByCode(idList, obsById, IMM_CODES.MANUFACTURER)
  const doseObs  = pickMemberByCode(idList, obsById, IMM_CODES.DOSE_NUM)
  const recvObs  = pickMemberByCode(idList, obsById, IMM_CODES.RECEIVED)

  // status (required)
  let status = 'completed'
  const recvCoding = recvObs?.valueCodeableConcept?.coding || []
  if (recvCoding.find(c => c.code === IMM_CODES.NO)) status = 'not-done'
  if (recvCoding.find(c => c.code === IMM_CODES.YES)) status = 'completed'

  // vaccineCode (required)
  let vaccineCode
  if (vaxObs?.valueCodeableConcept) {
    vaccineCode = vaxObs.valueCodeableConcept
  } else if (freeObs?.valueString) {
    vaccineCode = { text: freeObs.valueString }
  } else {
    // Fallback muy defensivo
    vaccineCode = { text: groupObs?.valueString || 'Unknown vaccine' }
  }

  // occurrenceDateTime (required en el perfil, slice occurrence[x])
  const occurrenceDateTime = dateObs?.valueDateTime || groupObs?.effectiveDateTime

  // encounter + location (opcionales)
  const encounterRef = groupObs?.encounter?.reference || (enc?.id ? `Encounter/${enc.id}` : undefined)
  const locationRef = getEncounterFirstLocation(enc)

  // manufacturer -> crear Organization mínima si viene
  const manufacturerRef = await ensureOrganizationByName(mfgObs?.valueString)

  // performer -> tomar 1er Practitioner del Encounter (si existe)
  const practitionerRef = getEncounterFirstPractitioner(enc)
  const performer = practitionerRef ? [{ actor: { reference: practitionerRef } }] : undefined

  // protocolApplied (solo si hay dosis)
  let protocolApplied
  if (doseObs?.valueQuantity?.value != null || typeof doseObs?.valueString === 'string') {
    const dn = doseObs?.valueQuantity?.value
    protocolApplied = [{ doseNumberPositiveInt: Number.isFinite(dn) ? Math.trunc(dn) : undefined,
                         doseNumberString: (Number.isFinite(dn) ? undefined : (doseObs?.valueString ?? String(dn))) }]

    // limpiar la variante no usada
    if (protocolApplied[0].doseNumberPositiveInt == null) delete protocolApplied[0].doseNumberPositiveInt
    if (!protocolApplied[0].doseNumberString) delete protocolApplied[0].doseNumberString
  }

  // lotNumber / expirationDate (opcionales)
  const lotNumber = lotObs?.valueString
  const expirationDate = toDate(expObs?.valueDateTime)

  // Construir el Immunization conforme al perfil OMRS
  const imm = {
    resourceType: 'Immunization',
    id: groupObs.id, // usamos el id del grupo para trazabilidad
    meta: { profile: [OMRS_IMM_PROFILE] }, // perfila al omrs-immunization  :contentReference[oaicite:3]{index=3}
    status,
    vaccineCode,
    patient: { reference: patientRef }, // 1..1
    ...(encounterRef ? { encounter: { reference: encounterRef } } : {}),
    occurrenceDateTime,
    ...(locationRef ? { location: { reference: locationRef } } : {}),
    ...(manufacturerRef ? { manufacturer: manufacturerRef } : {}),
    ...(lotNumber ? { lotNumber } : {}),
    ...(expirationDate ? { expirationDate } : {}),
    ...(performer ? { performer } : {}),
    ...(protocolApplied ? { protocolApplied } : {})
  }

  // Quitar explícitamente campos prohibidos por el perfil (cardinalidad 0..0)
  // recorded, primarySource, statusReason, route, site, doseQuantity, etc. — no los agregamos.

  return imm
}

/**
 * Pipeline de vacunación:
 * - Busca solo grupos 1421 por paciente (include has-member)
 * - Mapea a Immunization (perfil OMRS)
 * - Sube Organization (manufacturer) si aplica y luego el Immunization
 */
async function processImmunizationsByPatient(patientId, enc) {
  let sent = 0
  const url = `/Observation?patient=${encodeURIComponent(patientId)}&code=${IMM_SET_CODE}&_include=Observation:has-member&_count=200&_format=application/fhir+json`
  const bundle = await getFromProxy(url)

  if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry) || !bundle.entry.length) {
    logStep('ⓘ No hay grupos de vacunación (1421) para', patientId)
    return 0
  }

  const byId = indexByIdFromBundle(bundle)
  const patientRef = `Patient/${patientId}`
  const groups = bundle.entry
    .map(e => e.resource)
    .filter(r => r?.resourceType === 'Observation' && codeList(r).includes(IMM_SET_CODE))

  // asegurar Practitioner/Location del Encounter ya fueron subidos (el handler general lo hace)
  for (const g of groups) {
    const imm = await buildImmunizationFromGroup(g, byId, patientRef, enc, patientId)
    await putToNode(imm)
    sent++
  }
  return sent
}

// 6) Health endpoint del forwarder
app.get('/forwarderimmunization/_health', (_req, res) => res.send('OK'))

// 7) Event endpoint
app.post('/forwarderimmunization/_event', async (req, res) => {
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
    const [, patientId ] = enc.subject.reference.split('/')
    logStep('📤 Subiendo Patient…', patientId)
    const patient = await getFromProxy(`/Patient/${patientId}`)
    await putToNode(patient)
    sent++

    // 7.4.2) Notificar al ITI-65 Mediator (best-effort)
    try {
      logStep('🔔 Notificando ITI-65 Mediator para', patientId)
      await axios.post(
        `${process.env.OPENHIM_SUMMARY_ENDPOINT}`,
        { uuid: patientId },
        { auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS }, httpsAgent: axios.defaults.httpsAgent }
      )
      logStep('✅ Mediator ITI-65 notificado')
    } catch (e) {
      console.error('❌ Error notificando ITI-65 Mediator:', e.response?.data || e.message)
    }

    // 7.5) Practitioners del Encounter
    if (Array.isArray(enc.participant)) {
      for (const p of enc.participant) {
        const indyRef = p.individual?.reference
        if (indyRef?.startsWith('Practitioner/')) {
          sent += await uploadPractitioner(indyRef)
        }
      }
    }

    // 7.5b) Locations del Encounter
    if (Array.isArray(enc.location)) {
      for (const locEntry of enc.location) {
        const locRef = locEntry.location?.reference
        if (locRef?.startsWith('Location/')) {
          const locId = locRef.split('/')[1]
          await uploadLocationWithParents(locId)
          sent++
        }
      }
    }

    // 7.6) Subir Encounter (y padres)
    await uploadEncounterWithParents(uuid)
    sent++

    // 7.7) Recursos generales (EXCEPTO obs de vacunación)
    const types = ['Observation']
    for (const t of types) {
      let bundle
      try {
        bundle = await getFromProxy(`/${t}?patient=${encodeURIComponent(pid)}`)
        if (!bundle?.entry?.length) { logStep(`ⓘ ${t}: 0 resultados para patient=${pid}`); continue }
        logStep(`✓ ${t} by patient`)
      } catch (err) {
        logStep(`⚠️ Skip ${t} by patient: ${err?.message ?? err}`); continue
      }
      if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) continue

      for (const { resource } of bundle.entry) {
        // Saltar Observations de vacunación (grupo o hijas) — serán convertidas a Immunization
        if (resource.resourceType === 'Observation') {
          const codes = codeList(resource)
          if (codes.some(c => IMM_ALL_CODES.has(c))) {
            logStep('↷ Skip Obs vacunación (convertida a Immunization):', resource.id)
            continue
          }
        }

        // Pre-subir Practitioners referenciados
        const pracRefs = [
          resource.recorder?.reference,
          resource.requester?.reference,
          ...(resource.performer||[]).map(p => p.actor?.reference)
        ].filter(r => r?.startsWith('Practitioner/'))
        for (const r of pracRefs) { sent += await uploadPractitioner(r) }

        // Limpiar ref a Practitioner no subido
        for (const field of ['recorder','requester']) {
          const ref = resource[field]?.reference
          if (ref?.startsWith('Practitioner/')) {
            const id = ref.split('/')[1]
            if (!uploadedPractitioners.has(id)) { logStep(`⚠️ Omitiendo ${field} no subido:`, id); delete resource[field] }
          }
        }
        if (Array.isArray(resource.performer)) {
          resource.performer = resource.performer.filter(p => {
            const ref = p.actor?.reference
            if (ref?.startsWith('Practitioner/')) {
              const perfId = ref.split('/')[1]
              if (!uploadedPractitioners.has(perfId)) { logStep('⚠️ Omitiendo performer no subido:', perfId); return false }
            }
            return true
          })
          if (resource.performer.length === 0) delete resource.performer
        }

        try {
          if (resource.resourceType === 'Observation') {
            // Subir otras obs no-vacunación (con recursividad hasMember)
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
            } catch (retryErr) { throw retryErr }
          } else { throw e }
        }
      }
    }

    // 7.7-bis) *** Vacunación -> Immunization ***
    sent += await processImmunizationsByPatient(pid, enc)

    // 7.8) Done
    logStep('🎉 Done', uuid)
    res.json({ status:'ok', uuid, sent })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_IMMUNIZATION_PORT || 8009
app.listen(PORT, () => logStep(`FHIR Forwarder on port ${PORT}`))
