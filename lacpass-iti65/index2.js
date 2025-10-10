// index.js — LACPASS → ITI-65 Mediator con PDQm + Normalización IPS/MHD (versión completa)
// -----------------------------------------------------------------------------
// Objetivo: Recibir un Bundle IPS (lac-bundle), normalizarlo para conformar
//            los perfiles LAC/IPS y MHD, y enviarlo por ITI-65 (transaction)
//            a un nodo FHIR (HAPI u otro) expuesto por OPENHIM.
//            Esta versión corrige específicamente los errores de validación
//            reportados por el usuario: slices de Composition, custodian,
//            narrativas, referencias internas (URN), Identifier.type, country,
//            MedicationStatement.effective[x], codings sin system, etc.
// -----------------------------------------------------------------------------

import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')

// ===================== ENV =====================
const {
  // OpenHIM / FHIR Destino
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API, // p.ej.: https://openhim-core:8080
  FHIR_NODE_URL, // p.ej.: http://hapi:8080/fhir

  // CORS
  CORS_ORIGIN,

  // Features (activar/desactivar)
  FEATURE_PDQ_ENABLED = 'false',
  FEATURE_TS_ENABLED = 'false',

  // Logs
  DEBUG_DIR_icvp,

  // Timeouts
  OUTBOUND_TIMEOUT_MS = '60000',
} = process.env

// ===================== Axios & HTTPS =====================
axios.defaults.timeout = Number(OUTBOUND_TIMEOUT_MS) || 60000
axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false })

// ===================== Express =====================
const app = express()
app.use(express.json({ limit: '10mb' }))

if (CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN)
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    next()
  })
}

// ===================== OpenHIM register =====================
try {
  if (OPENHIM_API && OPENHIM_USER && OPENHIM_PASS) {
    registerMediator(OPENHIM_API, mediatorConfig, {
      username: OPENHIM_USER,
      password: OPENHIM_PASS,
      apiURL: OPENHIM_API,
      trustSelfSigned: true
    }, () => activateHeartbeat(OPENHIM_API, mediatorConfig, {
      username: OPENHIM_USER,
      password: OPENHIM_PASS,
      apiURL: OPENHIM_API,
      trustSelfSigned: true
    }))
    console.log('✓ Mediator registrado en OpenHIM')
  } else {
    console.warn('⚠ OpenHIM no configurado; ejecutando en modo standalone')
  }
} catch (e) {
  console.error('Error registrando en OpenHIM:', e)
}

// ===================== Utilidades =====================
const LOINC = 'http://loinc.org'
const V2_0203 = 'http://terminology.hl7.org/CodeSystem/v2-0203'
const IPS_ABSENT = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips'
const SCT = 'http://snomed.info/sct'

function isUrn(u) {
  return typeof u === 'string' && u.startsWith('urn:uuid:')
}

function ensureUrnFullUrl(entry) {
  if (!entry.fullUrl) entry.fullUrl = `urn:uuid:${uuidv4()}`
  const m = entry.fullUrl.match(/^urn:uuid:([0-9a-fA-F-]+)$/)
  if (m) {
    entry.resource = entry.resource || {}
    if (!entry.resource.id) entry.resource.id = m[1]
  }
}

function buildLocalUrlMap(bundle) {
  // Mapea ResourceType/id → fullUrl (URN)
  const urlMap = new Map()
  for (const e of bundle.entry || []) {
    const r = e.resource
    if (r?.resourceType && r.id && e.fullUrl) {
      urlMap.set(`${r.resourceType}/${r.id}`, e.fullUrl)
    }
  }
  return urlMap
}

function toLocalRef(ref, urlMap) {
  if (!ref) return ref
  if (isUrn(ref)) return ref
  // extrae ResourceType/id de ref absoluta o relativa
  const m = ref.match(/(?:^|\/)(Patient|Condition|AllergyIntolerance|MedicationStatement|MedicationRequest|Immunization|Organization|Practitioner|PractitionerRole|Procedure|Observation|Device|Specimen)\/([A-Za-z0-9\-\.]{1,64})(?:$|[\/#])/)
  if (m) {
    const key = `${m[1]}/${m[2]}`
    return urlMap.get(key) || ref
  }
  return ref
}

function fixLoincDisplays(section) {
  const coding = section?.code?.coding
  if (Array.isArray(coding)) {
    for (const c of coding) {
      if (c.system === LOINC && c.code === '11348-0') {
        c.display = 'History of Past illness note'
      }
    }
  }
}

function ensureNarrative(section) {
  section.text = section.text || { status: 'generated' }
  if (!section.text.div) {
    section.text.div = '<div xmlns="http://www.w3.org/1999/xhtml"><p>Sin antecedentes relevantes reportados.</p></div>'
  }
}

function normalizeIdentifiers(resource) {
  if (!resource.identifier) return
  for (const id of resource.identifier) {
    if (Array.isArray(id.type?.coding)) {
      for (const c of id.type.coding) {
        if (!c.system) c.system = V2_0203
        if (!c.code && (id.type.text || '').toLowerCase() === 'pasaporte') c.code = 'PPN'
        if (!c.code && (id.type.text || '').toLowerCase().includes('patient identifier')) c.code = 'NI'
      }
    }
  }
}

function normalizeCountry(resource) {
  if (resource.resourceType !== 'Patient' || !Array.isArray(resource.address)) return
  for (const a of resource.address) {
    if (!a.country) continue
    const v = (a.country + '').trim()
    if (/^chile$/i.test(v)) a.country = 'CL' // ISO2
  }
}

function normalizeMedicationStatement(r, bundleTimestamp) {
  if (r.resourceType !== 'MedicationStatement') return
  // completar system/código para "no-medication-info"
  if (Array.isArray(r.medicationCodeableConcept?.coding)) {
    for (const c of r.medicationCodeableConcept.coding) {
      if (c.display === 'No information about medications') {
        if (!c.system) c.system = IPS_ABSENT
        if (!c.code) c.code = 'no-medication-info'
      }
    }
  }
  if (!r.effectiveDateTime && bundleTimestamp) {
    r.effectiveDateTime = bundleTimestamp
  }
}

function normalizeConditions(r) {
  if (r.resourceType !== 'Condition') return
  if (Array.isArray(r.code?.coding)) {
    // eliminar codings sin system que truenan la validación
    r.code.coding = r.code.coding.filter(c => c.system || c.code === 'no-problem-info')
  }
}

function stripInvalidMetaSource(r) {
  if (r?.meta?.source && typeof r.meta.source === 'string' && r.meta.source.startsWith('#')) {
    delete r.meta.source
  }
}

function ensureCompositionSlices(comp, bundle) {
  // custodian → Organization incluida
  if (!comp.custodian) {
    const orgEntry = (bundle.entry || []).find(e => e.resource?.resourceType === 'Organization')
    if (orgEntry?.fullUrl) comp.custodian = { reference: orgEntry.fullUrl }
  }
  // Sección Past Illness (11348-0) → narrativa y display válido
  if (Array.isArray(comp.section)) {
    for (const s of comp.section) {
      fixLoincDisplays(s)
      if (Array.isArray(s.code?.coding) && s.code.coding.some(x => x.system === LOINC && x.code === '11348-0')) {
        ensureNarrative(s)
      }
    }
  }
}

function rewriteAllReferences(bundle, urlMap) {
  const refFields = [
    ['subject'], ['patient'], ['recorder'], ['requester'], ['custodian'],
  ]
  for (const e of bundle.entry || []) {
    const r = e.resource
    if (!r) continue

    // Campos directos
    for (const f of refFields) {
      const k = f[0]
      if (r[k]?.reference) r[k].reference = toLocalRef(r[k].reference, urlMap)
    }

    // Composition.section[].entry[].reference
    if (r.resourceType === 'Composition' && Array.isArray(r.section)) {
      for (const sec of r.section) {
        if (Array.isArray(sec.entry)) {
          for (const it of sec.entry) {
            if (it.reference) it.reference = toLocalRef(it.reference, urlMap)
          }
        }
      }
    }
  }
}

function ensureBundleProfile(bundle) {
  bundle.meta = bundle.meta || {}
  bundle.meta.profile = Array.isArray(bundle.meta.profile) ? bundle.meta.profile : []
  if (!bundle.meta.profile.includes('http://lacpass.racsel.org/StructureDefinition/lac-bundle')) {
    bundle.meta.profile.push('http://lacpass.racsel.org/StructureDefinition/lac-bundle')
  }
}

// ===================== Normalización principal =====================
function normalizeSummaryBundle(bundle) {
  if (!bundle || bundle.resourceType !== 'Bundle') throw new Error('summaryBundle inválido')

  ensureBundleProfile(bundle)

  // 1) URNs y resource.id
  for (const e of (bundle.entry || [])) ensureUrnFullUrl(e)

  // 2) Mapa local URN
  const urlMap = buildLocalUrlMap(bundle)

  // 3) Limpieza por recurso
  for (const e of bundle.entry || []) {
    const r = e.resource
    if (!r) continue

    stripInvalidMetaSource(r)
    normalizeIdentifiers(r)
    normalizeCountry(r)
    normalizeMedicationStatement(r, bundle.timestamp)
    normalizeConditions(r)
  }

  // 4) Composition: custodian + narrativas + displays
  const compEntry = (bundle.entry || []).find(e => e.resource?.resourceType === 'Composition')
  if (!compEntry) throw new Error('Bundle IPS sin Composition')
  const comp = compEntry.resource
  ensureCompositionSlices(comp, bundle)

  // 5) Reescribir TODAS las referencias a URN locales
  //    (incluye subject/patient/recorder/requester/custodian y section[].entry[])
  //    además reescribe Composition.subject si apuntaba fuera
  rewriteAllReferences(bundle, urlMap)

  return bundle
}

// ===================== ITI-65 (MHD Provide Document Bundle) =====================
function buildProvideBundle({ summaryBundle, authorRef, sourceId }) {
  const now = new Date().toISOString()
  const submissionSetId = uuidv4()
  const documentReferenceId = uuidv4()

  // DocumentReference → referencia al Bundle (document)
  const docRef = {
    resourceType: 'DocumentReference',
    id: documentReferenceId,
    meta: {
      profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.DocumentReference']
    },
    status: 'current',
    type: { coding: [{ system: LOINC, code: '60591-5', display: 'Patient Summary Document' }] },
    subject: extractPatientRef(summaryBundle) || undefined,
    date: now,
    author: authorRef ? [{ reference: authorRef }] : undefined,
    content: [{
      attachment: {
        contentType: 'application/fhir+json',
        url: 'urn:uuid:bundle',
        title: 'IPS LAC Bundle',
        creation: summaryBundle.timestamp || now
      }
    }]
  }

  // List (SubmissionSet)
  const submissionSet = {
    resourceType: 'List',
    id: submissionSetId,
    meta: {
      profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.SubmissionSet']
    },
    status: 'current',
    mode: 'working',
    title: 'Provide Document Bundle',
    date: now,
    entry: [{ item: { reference: `DocumentReference/${documentReferenceId}` } }],
    source: sourceId || undefined
  }

  const bundleUrn = 'urn:uuid:bundle'
  return {
    resourceType: 'Bundle',
    id: uuidv4(),
    meta: {
      profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.ProvideBundle'],
      security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
    },
    type: 'transaction',
    timestamp: now,
    entry: [
      { fullUrl: `urn:uuid:${submissionSetId}`, resource: submissionSet, request: { method: 'POST', url: 'List' } },
      { fullUrl: `urn:uuid:${documentReferenceId}`, resource: docRef, request: { method: 'POST', url: 'DocumentReference' } },
      { fullUrl: bundleUrn, resource: summaryBundle, request: { method: 'POST', url: 'Bundle' } }
    ]
  }
}

function extractPatientRef(bundle) {
  // Busca Patient en el bundle y devuelve su fullUrl (URN)
  const e = (bundle.entry || []).find(x => x.resource?.resourceType === 'Patient')
  return e?.fullUrl ? { reference: e.fullUrl } : null
}

// ===================== Rutas =====================
// Entrada principal: "/lacpass/_iti65"
// body: { bundle: <Bundle IPS>, provider: { organization: {name, address...} } }
app.post('/lacpass/_iti65', async (req, res) => {
  try {
    const correlationId = uuidv4()
    req.correlationId = correlationId
    console.log(`[${correlationId}] ⇢ Recibido Bundle IPS`)

    const inputBundle = req.body?.bundle || req.body
    if (!inputBundle || inputBundle.resourceType !== 'Bundle') {
      return res.status(400).json({ error: 'Se esperaba body.bundle (FHIR Bundle)' })
    }

    // 1) Normalizar IPS (corrige los errores de validación reportados)
    const summaryBundle = normalizeSummaryBundle(structuredClone(inputBundle))

    // 2) Asegurar que haya Organization (custodian/autor)
    let orgEntry = (summaryBundle.entry || []).find(e => e.resource?.resourceType === 'Organization')
    if (!orgEntry) {
      const orgId = uuidv4()
      orgEntry = {
        fullUrl: `urn:uuid:${orgId}`,
        resource: {
          resourceType: 'Organization',
          id: orgId,
          meta: { profile: ['http://lacpass.racsel.org/StructureDefinition/lac-organization'] },
          name: 'Ministerio de Salud de Chile',
          address: [{ line: ['Enrique Mac Iver 541'], city: 'Santiago', postalCode: '8320064', country: 'CL' }]
        }
      }
      summaryBundle.entry.push(orgEntry)
    }

    // 3) Construir Provide Bundle (ITI-65)
    const provideBundle = buildProvideBundle({
      summaryBundle,
      authorRef: orgEntry.fullUrl,
      sourceId: orgEntry.fullUrl
    })

    // 4) Enviar a FHIR destino
    if (!FHIR_NODE_URL) throw new Error('FHIR_NODE_URL no configurado')
    const targetUrl = `${FHIR_NODE_URL.replace(/\/$/, '')}`

    const resp = await axios.post(targetUrl, provideBundle, {
      headers: { 'Content-Type': 'application/fhir+json' }
    })

    console.log(`[${correlationId}] ⇒ ITI-65 enviado OK → ${resp.status}`)
    return res.json({ ok: true, status: resp.status, outcome: resp.data })
  } catch (e) {
    console.error('❌ ERROR /lacpass/_iti65:', e?.response?.data || e)
    return res.status(500).json({ error: e.message, details: e?.response?.data })
  }
})

// Ping simple
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// ===================== Server =====================
const PORT = process.env.LACPASS_ITI65_PORT || 8005
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator escuchando en puerto ${PORT}`))
