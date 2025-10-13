// index.js — OpenHIM Mediator: OpenMRS Diagnostic Observations → FHIR Condition (category: encounter-diagnosis)
//
// Diseño:
// - Recibe POST /forwardercondition/_event { uuid }
//   - uuid puede ser Encounter.id, Composition.id (que referencia Encounter) o Bundle.id persistido con un Encounter dentro.
// - Resuelve Encounter y Patient asociados (reutiliza lógica robusta de resolución).
// - Consulta Observations del Encounter en OpenMRS FHIR.
// - Convierte cada Observation diagnóstica a Condition con:
//     * category: encounter-diagnosis (http://terminology.hl7.org/CodeSystem/condition-category)
//     * clinicalStatus: active (http://terminology.hl7.org/CodeSystem/condition-clinical)
//     * verificationStatus: confirmed (http://terminology.hl7.org/CodeSystem/condition-ver-status)
//     * code: **solo** codings con system === 'http://snomed.info/sct' (se descartan codificaciones OpenMRS u otras)
//     * subject, encounter, onset/recordedDate, asserter si disponible
// - Publica/actualiza (PUT) cada Condition en el nodo FHIR de destino (HAPI u otro) para trazabilidad.
//
// Notas:
// - Si una Observation **no** contiene codificación SNOMED, por defecto **se omite** (no se genera Condition) para evitar problemas aguas arriba.
//   Puede activarse una ruta opcional de traducción (ConceptMap $translate) con variables de entorno si se desea, ver FLAGS abajo.
// - Inspirado y compatible con tu forwarder de Inmunizaciones (estructura de registro y utilidades compartidas).

import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import mediatorConfig from './mediatorConfig.json' assert { type: 'json' }

// =============================
// OpenHIM & HTTPS
// =============================
const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL: (process.env.OPENHIM_API || '').replace(/\/$/, ''),
  trustSelfSigned: true
}

axios.defaults.httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  cert: process.env.CLIENT_CERT && fs.existsSync(process.env.CLIENT_CERT) ? fs.readFileSync(process.env.CLIENT_CERT) : undefined,
  key: process.env.CLIENT_KEY && fs.existsSync(process.env.CLIENT_KEY) ? fs.readFileSync(process.env.CLIENT_KEY) : undefined
})

// =============================
// Flags & Consts
// =============================
function logStep (...args) { console.log(new Date().toISOString(), '-', ...args) }
const DEBUG = /^true$/i.test(process.env.DEBUG_CONDITION || 'false')
function dbg (...a) { if (DEBUG) logStep('[DEBUG_COND]', ...a) }

const FHIR_NODE_BASE = (process.env.FHIR_NODE_URL || '').replace(/\/$/, '')
const FHIR_PROXY_BASE = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')

// FHIR systems/codes
const SNOMED = 'http://snomed.info/sct'
const CC_CATEGORY = 'http://terminology.hl7.org/CodeSystem/condition-category'
const CC_CLINICAL = 'http://terminology.hl7.org/CodeSystem/condition-clinical'
const CC_VERIFY   = 'http://terminology.hl7.org/CodeSystem/condition-ver-status'

// Traducción opcional si falta SNOMED (apagado por defecto)
const USE_TRANSLATE = /^true$/i.test(process.env.USE_TRANSLATE_TO_SNOMED || 'false')
const TERMINOLOGY_BASE = (process.env.TERMINOLOGY_BASE || '').replace(/\/$/, '')
const TRANSLATE_TARGET = SNOMED

// =============================
// HTTP helpers to/from OpenMRS proxy and Node FHIR
// =============================
async function getFromProxy (path) {
  const url = `${FHIR_PROXY_BASE}${path}`
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

async function putToNode (resource) {
  const url = `${FHIR_NODE_BASE}/fhir/${resource.resourceType}/${resource.id}`
  try {
    logStep('PUT (node)', url)
    const resp = await axios.put(url, resource, { validateStatus: false, httpsAgent: axios.defaults.httpsAgent })
    logStep('DEBUG node status:', resp.status)
    if (resp.status >= 400) throw new Error(`Node returned ${resp.status}`)
  } catch (e) {
    logStep('❌ PUT error:', e.message)
    throw e
  }
}

// =============================
// Generic utils
// =============================
function codeList (res) { return (res?.code?.coding || []).map(c => ({ system: c.system, code: c.code, display: c.display })).filter(x => x.code) }
function pickFirstSNOMED (res) { return codeList(res).find(c => c.system === SNOMED) }
function toDateOnly (dt) { return (typeof dt === 'string' ? dt.substring(0, 10) : undefined) }

async function getIfExists (path) {
  try { return await getFromProxy(path) } catch (e) {
    if (String(e.message).endsWith(' returned 404')) return null
    throw e
  }
}

async function resolveEncounterAndPatient (uuid) {
  // 1) Encounter directo
  const enc1 = await getIfExists(`/Encounter/${encodeURIComponent(uuid)}`)
  if (enc1?.resourceType === 'Encounter') {
    const pid = enc1.subject?.reference?.split('/')[1]
    return { enc: enc1, pid }
  }
  // 2) Composition → Encounter
  const comp = await getIfExists(`/Composition/${encodeURIComponent(uuid)}`)
  if (comp?.resourceType === 'Composition') {
    const encRef = comp.encounter?.reference
    if (encRef?.startsWith('Encounter/')) {
      const encId = encRef.split('/')[1]
      const enc2 = await getIfExists(`/Encounter/${encodeURIComponent(encId)}`)
      if (enc2?.resourceType === 'Encounter') {
        const pid = enc2.subject?.reference?.split('/')[1]
        return { enc: enc2, pid }
      }
    }
  }
  // 3) Bundle persistido que contiene un Encounter
  const bun = await getIfExists(`/Bundle/${encodeURIComponent(uuid)}`)
  if (bun?.resourceType === 'Bundle' && Array.isArray(bun.entry)) {
    const enc3 = bun.entry.map(e => e.resource).find(r => r?.resourceType === 'Encounter')
    if (enc3?.id) {
      const pid = enc3.subject?.reference?.split('/')[1]
      return { enc: enc3, pid }
    }
  }
  return { enc: null, pid: null }
}

// =============================
// Optional: ConceptMap $translate → SNOMED (simple)
// =============================
function parseTranslate (parameters) {
  const params = parameters?.parameter || []
  const matches = params.filter(p => p.name === 'match')
  for (const m of matches) {
    const parts = m.part || []
    const concept = parts.find(p => p.name === 'concept')?.valueCoding
    const code = concept?.code || parts.find(p => p.name === 'code')?.valueCode
    const system = concept?.system || parts.find(p => p.name === 'system')?.valueUri
    const display = concept?.display || parts.find(p => p.name === 'display')?.valueString
    if (code && system === SNOMED) return { system, code, ...(display ? { display } : {}) }
  }
  return null
}

async function translateToSNOMED (sourceCoding) {
  if (!USE_TRANSLATE || !TERMINOLOGY_BASE || !sourceCoding?.code) return null
  try {
    const url = `${TERMINOLOGY_BASE}/ConceptMap/$translate`
    const { data } = await axios.get(url, {
      params: { system: sourceCoding.system, code: sourceCoding.code, targetsystem: SNOMED },
      httpsAgent: axios.defaults.httpsAgent
    })
    return parseTranslate(data)
  } catch (e) {
    dbg('translate error:', e.message)
    return null
  }
}

// =============================
// Builder: Condition from Observation
// =============================
async function buildConditionFromObservation (obs, patientRef, encounterRef, enc) {
  // 1) elegir codificación SNOMED nativa (preferida)
  let snomed = pickFirstSNOMED(obs)

  // 2) si no hay SNOMED y está activa la traducción → intentar traducir desde el primer coding disponible
  if (!snomed && USE_TRANSLATE) {
    const src = codeList(obs).find(c => !!c.system && !!c.code)
    if (src) snomed = await translateToSNOMED(src)
  }

  // 3) si sigue sin SNOMED → omitir
  if (!snomed) {
    dbg('omit observation (no SNOMED):', { id: obs.id, codes: codeList(obs) })
    return null
  }

  // category encounter-diagnosis
  const category = [{ coding: [{ system: CC_CATEGORY, code: 'encounter-diagnosis', display: 'Encounter Diagnosis' }] }]

  // clinicalStatus & verificationStatus por defecto (ajustables por ENV)
  const clinicalStatusCode = process.env.DEFAULT_COND_CLINICAL || 'active' // active | recurrence | relapse | inactive | remission | resolved
  const verificationStatusCode = process.env.DEFAULT_COND_VERIFY || 'confirmed' // unconfirmed | provisional | differential | confirmed | refuted | entered-in-error

  const condition = {
    resourceType: 'Condition',
    id: `cond-${obs.id}`, // trazabilidad contra la Observation origen
    meta: {
      profile: (process.env.CONDITION_PROFILE ? [process.env.CONDITION_PROFILE] : undefined)
    },
    category,
    clinicalStatus: { coding: [{ system: CC_CLINICAL, code: clinicalStatusCode }] },
    verificationStatus: { coding: [{ system: CC_VERIFY, code: verificationStatusCode }] },
    code: { coding: [snomed] }, // **solo SNOMED**
    subject: { reference: patientRef },
    ...(encounterRef ? { encounter: { reference: encounterRef } } : {}),
    onsetDateTime: obs.effectiveDateTime || obs.issued || undefined,
    recordedDate: obs.issued || undefined
  }

  // Asserter (si existe en Encounter: primer Practitioner)
  const prac = (enc?.participant || []).find(p => p.individual?.reference?.startsWith('Practitioner/'))?.individual?.reference
  if (prac) condition.asserter = { reference: prac }

  // Severity (opcional): mapear desde Observation.interpretation si viene codificada en SNOMED
  const interSNOMED = (obs.interpretation?.coding || []).find(c => c.system === SNOMED)
  if (interSNOMED) condition.severity = { coding: [interSNOMED] }

  return condition
}

// =============================
// Pipeline: process Conditions for an Encounter
// =============================
async function processConditionsByEncounter (enc) {
  if (!enc?.id) return 0
  const encId = enc.id
  const pid = enc.subject?.reference?.split('/')[1]
  const patientRef = pid ? `Patient/${pid}` : undefined
  const encounterRef = `Encounter/${encId}`

  // Cargar Observations del Encounter
  const encRef = encodeURIComponent(`Encounter/${encId}`)
  const bundle = await getFromProxy(`/Observation?encounter=${encRef}&_count=200&_format=application/fhir+json`)
  if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry) || !bundle.entry.length) {
    logStep('ⓘ No hay Observations para el Encounter', encId)
    return 0
  }

  let sent = 0
  for (const e of bundle.entry) {
    const obs = e.resource
    if (obs?.resourceType !== 'Observation') continue

    // Heurística mínima: solo Observations "diagnósticas" → dependerá del modelado en Bahmni/OpenMRS.
    // Aquí aceptamos cualquiera que traiga algún coding SNOMED (o traducible), lo demás se ignora.
    const cond = await buildConditionFromObservation(obs, patientRef, encounterRef, enc)
    if (!cond) continue // sin SNOMED → se omite

    await putToNode(cond)
    sent++
  }
  return sent
}

// =============================
// Express app
// =============================
const app = express()
app.use(express.json({ limit: '2mb' }))

const HEALTH_PATH = mediatorConfig.heartbeatPath || '/forwardercondition/_health'
app.get(HEALTH_PATH, (_req, res) => res.status(200).json({ status: 'ok', mediator: process.env.MEDIATOR_URN || mediatorConfig.urn }))

app.post('/forwardercondition/_event', async (req, res) => {
  logStep('📩 POST /forwardercondition/_event', req.body)
  const { uuid } = req.body || {}
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  try {
    // Resolver Encounter + Patient
    const { enc, pid } = await resolveEncounterAndPatient(uuid)
    if (!enc) return res.status(404).json({ error: `No se encontró Encounter para uuid=${uuid}` })
    if (!pid) return res.status(404).json({ error: `Encounter sin patient (uuid=${uuid})` })

    // Subir Patient (para garantizar referencias válidas en el nodo)
    try {
      logStep('📤 Subiendo Patient…', pid)
      const patient = await getFromProxy(`/Patient/${pid}`)
      await putToNode(patient)
    } catch (e) {
      logStep('⚠️ No se pudo subir Patient:', e.message)
    }

    // Procesar Conditions desde Observations del Encounter
    const sent = await processConditionsByEncounter(enc)

    logStep('🎉 Done conditions', { uuid, sent })
    return res.json({ status: 'ok', uuid, sent })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// =============================
// OpenHIM registration (respeta mediatorConfig)
// =============================
const openhimOptions = {
  apiURL: openhimConfig.apiURL,
  username: openhimConfig.username,
  password: openhimConfig.password,
  trustSelfSigned: openhimConfig.trustSelfSigned,
  urn: process.env.MEDIATOR_URN || mediatorConfig.urn
}
const me = mediatorConfig

function onRegister (err) {
  if (err) return logStep('❌ Registration failed', err)
  logStep('✅ Registered mediator', openhimOptions.urn)
  activateHeartbeat(openhimOptions, me.heartbeatInterval || 30000)
}

registerMediator(openhimOptions, me, onRegister)

const PORT = process.env.FORWARDER_CONDITION_PORT || 8014
const appServer = app.listen(PORT, () => logStep(`Condition Forwarder on port ${PORT} (health at ${HEALTH_PATH})`))

export default appServer
