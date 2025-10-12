// index.medreq-only.js
// FHIR MedicationRequest Forwarder — SOLO MedicationRequest (+ referencias mínimas)
// - Prefijo: /medreq
// - Puerto: FORWARDER_MEDICATIONREQUEST_PORT (default 8012)
// - Evita conflictos: URN y rutas propias; archivo seen independiente.
// - Flujo: FHIR /MedicationRequest?patient=... → PUT a Nodo. Fallback: REST /order → transformar a MedicationRequest.
//
// Requisitos .env principales:
// OPENHIM_API_URL, OPENHIM_USER, OPENHIM_PASS
// FHIR_PROXY_URL (FHIR R4 fuente proxificada)
// OPENMRS_FHIR_URL, OPENMRS_USER, OPENMRS_PASS (opcional fallback Encounter/Practitioner/Location)
// OPENMRS_REST_URL (p.ej. https://<host>/openmrs/ws/rest/v1) para REST /order (fallback drugorder)
// FHIR_NODE_URL (destino nacional)  (ej: https://<nodo>/)
// FORWARDER_MEDICATIONREQUEST_PORT=8012
//
// Opcional org por defecto:
// DEFAULT_ORG_ENABLED=true
// DEFAULT_ORG_ID=hcsba
// DEFAULT_ORG_NAME="Hospital Clínico San Borja Arriarán"
// DEFAULT_ORG_RUT="61.608.604-9"
// DEFAULT_ORG_URL="https://www.hcsba.cl/"
// DEFAULT_ORG_PHONE="+56 2 25749000"
// DEFAULT_ORG_ADDRESS_LINE="Avenida Santa Rosa 1234"
// DEFAULT_ORG_CITY="Santiago"
// DEFAULT_ORG_DISTRICT="Santiago Centro"
// DEFAULT_ORG_STATE="Región Metropolitana"
// DEFAULT_ORG_COUNTRY="CL"

import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// -------- Mediator config (archivo separado para no chocar con el otro) --------
const MEDIATOR_CONFIG_FILE = process.env.MEDIATOR_CONFIG_FILE || './mediatorConfig.medreq.json'
let mediatorConfig
try {
  mediatorConfig = require(MEDIATOR_CONFIG_FILE)
} catch (e) {
  console.error(`❌ No pude leer ${MEDIATOR_CONFIG_FILE}. Crea ese archivo (URN y canales propios).`)
  process.exit(1)
}

// --- OpenHIM config ---
const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL:   process.env.OPENHIM_API_URL || process.env.OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
}

// HTTPS agent para entornos con self-signed
const devAgent = new https.Agent({ rejectUnauthorized: false })
if (process.env.NODE_ENV === 'development') {
  axios.defaults.httpsAgent = devAgent
  console.log('⚠️  DEV MODE: certificados self-signed aceptados')
}

function logStep(msg, ...d) { console.log(new Date().toISOString(), msg, ...d) }

// Validaciones de configuración obligatoria
if (!process.env.FHIR_NODE_URL) { console.error('❌ FHIR_NODE_URL es obligatorio'); process.exit(1) }
if (!process.env.FHIR_PROXY_URL) { console.error('❌ FHIR_PROXY_URL es obligatorio'); process.exit(1) }

// -------- Defaults (SOLO Organization) --------
const DEF_ORG_ENABLED = (process.env.DEFAULT_ORG_ENABLED || 'true').toLowerCase() === 'true'
const DEF_ORG_ID   = process.env.DEFAULT_ORG_ID   || 'hcsba'
const DEF_ORG_NAME = process.env.DEFAULT_ORG_NAME || 'Hospital Clínico San Borja Arriarán'
const DEF_ORG_RUT  = process.env.DEFAULT_ORG_RUT  || '61.608.604-9'
const DEF_ORG_URL  = process.env.DEFAULT_ORG_URL  || 'https://www.hcsba.cl/'
const DEF_ORG_PHONE= process.env.DEFAULT_ORG_PHONE|| '+56 2 25749000'
const DEF_ADDR_LINE= process.env.DEFAULT_ORG_ADDRESS_LINE || 'Avenida Santa Rosa 1234'
const DEF_ADDR_CITY= process.env.DEFAULT_ORG_CITY || 'Santiago'
const DEF_ADDR_DIST= process.env.DEFAULT_ORG_DISTRICT || 'Santiago Centro'
const DEF_ADDR_STATE=process.env.DEFAULT_ORG_STATE || 'Región Metropolitana'
const DEF_ADDR_COUNTRY=process.env.DEFAULT_ORG_COUNTRY || 'CL'

function buildDefaultOrganization(){
  return {
    resourceType: 'Organization',
    id: DEF_ORG_ID,
    active: true,
    name: DEF_ORG_NAME,
    alias: ['HCSBA','Hospital San Borja Arriarán'],
    identifier: [{
      use: 'official',
      type: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'TAX', display: 'Tax ID number' }],
        text: 'RUT'
      },
      system: 'https://www.superdesalud.gob.cl/registro',
      value: DEF_ORG_RUT
    }],
    telecom: [
      { system: 'phone', value: DEF_ORG_PHONE },
      { system: 'url', value: DEF_ORG_URL }
    ],
    address: [{
      use: 'work',
      type: 'physical',
      line: [DEF_ADDR_LINE],
      district: DEF_ADDR_DIST,
      city: DEF_ADDR_CITY,
      state: DEF_ADDR_STATE,
      country: DEF_ADDR_COUNTRY
    }]
  }
}

// 1) Registrar mediador & canales y activar heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Error de registro en OpenHIM:', err)
    process.exit(1)
  }
  console.log('✅ Mediator MedReq registrado en OpenHIM')

  Promise.all(
    (mediatorConfig.defaultChannelConfig || []).map(ch =>
      axios.post(
        `${openhimConfig.apiURL}/channels`,
        { ...ch, mediator_urn: mediatorConfig.urn },
        { auth: { username: openhimConfig.username, password: openhimConfig.password }, httpsAgent: axios.defaults.httpsAgent || devAgent }
      )
      .then(() => console.log(`✅ Canal creado: ${ch.name}`))
      .catch(e => {
        const msg = e?.response?.data || e?.message || e.toString()
        if (String(msg).includes('duplicate key error')) {
          console.log(`ℹ️ Canal ya existe: ${ch.name}`)
        } else {
          console.error(`❌ Canal ${ch.name} error:`, msg)
        }
      })
    )
  ).then(() => {
    console.log('✅ Canales procesados')
    activateHeartbeat(openhimConfig)
  })
})

// (sin "seen": comportamiento como Immunization)

// 3) Fuentes
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')
const baseOMRS_FHIR = (process.env.OPENMRS_FHIR_URL || '').replace(/\/$/, '')
const baseOMRS_REST = (process.env.OPENMRS_REST_URL || '').replace(/\/$/, '')

const omrsAuth = (process.env.OPENMRS_USER && process.env.OPENMRS_PASS)
  ? { username: process.env.OPENMRS_USER, password: process.env.OPENMRS_PASS }
  : null

// Filtros de búsqueda de MedicationRequest (opcional)
const MR_AUTHOR_FROM = process.env.MR_AUTHOR_FROM   // ej: '2025-01-01'
const MR_AUTHOR_TO   = process.env.MR_AUTHOR_TO     // ej: '2025-12-31'

async function getFromProxy(path) {
  const url = `${baseProxy}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    validateStatus: false,
    auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS },
    httpsAgent: axios.defaults.httpsAgent || devAgent,
    headers: { Accept: 'application/fhir+json' }
  })
  logStep('DEBUG proxy status:', resp.status)
  if (resp.status >= 400) throw new Error(`${path} returned ${resp.status}`)
  return resp.data
}

async function getFromOpenMRS_FHIR(path) {
  if (!baseOMRS_FHIR || !omrsAuth) throw new Error('OpenMRS FHIR no configurado')
  const url = `${baseOMRS_FHIR}${path}`
  logStep('GET (omrs-fhir)', url)
  const resp = await axios.get(url, {
    validateStatus:false,
    auth: omrsAuth,
    httpsAgent: axios.defaults.httpsAgent || devAgent,
    headers: { Accept: 'application/fhir+json' }
  })
  logStep('DEBUG omrs-fhir status:', resp.status)
  if (resp.status >= 400) throw new Error(`${path} returned ${resp.status}`)
  return resp.data
}

async function getFromOpenMRS_REST(path) {
  if (!baseOMRS_REST || !omrsAuth) throw new Error('OpenMRS REST no configurado')
  const url = `${baseOMRS_REST}${path}`
  logStep('GET (omrs-rest)', url)
  const resp = await axios.get(url, {
    validateStatus:false,
    auth: omrsAuth,
    httpsAgent: axios.defaults.httpsAgent || devAgent,
    headers: { Accept: 'application/json' }
  })
  logStep('DEBUG omrs-rest status:', resp.status)
  if (resp.status >= 400) throw new Error(`${path} returned ${resp.status}`)
  return resp.data
}

function isGoneOrMissingError(err) {
  const m = String(err?.message || '').match(/ returned (\d{3})/)
  const code = m ? parseInt(m[1], 10) : undefined
  return code === 404 || code === 410
}

// 4) PUT a Nodo con retries de dependencias mínimas
async function putToNode(resource) {
  const base = String(process.env.FHIR_NODE_URL || '').replace(/\/$/, '')
  const url = `${base}/fhir/${resource.resourceType}/${resource.id}`
  const doPut = async () => {
    logStep('PUT (node)', url)
    const r = await axios.put(url, resource, {
      headers:{ 'Content-Type':'application/fhir+json' },
      validateStatus: false,
      httpsAgent: axios.defaults.httpsAgent || devAgent
    })
    if (r.status >= 400) {
      logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2))
      const diag = r?.data?.issue?.[0]?.diagnostics || ''
      const mEnc = typeof diag === 'string' ? diag.match(/Resource Encounter\/([A-Za-z0-9\-\.]{1,64})/) : null
      const mLoc = typeof diag === 'string' ? diag.match(/Resource Location\/([A-Za-z0-9\-\.]{1,64})/) : null
      const mOrg = typeof diag === 'string' ? diag.match(/Resource Organization\/([A-Za-z0-9\-\.]{1,64})/) : null
      const mMed = typeof diag === 'string' ? diag.match(/Resource Medication\/([A-Za-z0-9\-\.]{1,64})/) : null
      const mPrac= typeof diag === 'string' ? diag.match(/Resource Practitioner\/([A-Za-z0-9\-\.]{1,64})/) : null
      return {
        status: r.status,
        missingEncounterId: mEnc?.[1],
        missingLocationId: mLoc?.[1],
        missingOrganizationId: mOrg?.[1],
        missingMedicationId: mMed?.[1],
        missingPractitionerId: mPrac?.[1]
      }
    }
    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
    return { status: r.status }
  }

  let res = await doPut()

  if (res.missingMedicationId) { await uploadMedication(res.missingMedicationId); res = await doPut() }
  if (res.missingPractitionerId){ await uploadPractitionerById(res.missingPractitionerId); res = await doPut() }
  if (res.missingLocationId) { await uploadLocationWithParents(res.missingLocationId); res = await doPut() }
  if (res.missingOrganizationId) { await uploadOrganization(res.missingOrganizationId); res = await doPut() }
  if (res.missingEncounterId) { await uploadEncounterWithParents(res.missingEncounterId); res = await doPut() }

  if (res.status >= 400) throw new Error(`PUT failed ${res.status}`)
  return res.status
}

// 5) Caches
const uploadedLocations     = new Set()
const uploadedEncounters    = new Set()
const uploadedPractitioners = new Set()
const uploadedOrganizations = new Set()
const uploadedMedications   = new Set()

async function ensureDefaultOrganization(){
  if (!DEF_ORG_ENABLED) return
  if (!uploadedOrganizations.has(DEF_ORG_ID)) {
    const org = buildDefaultOrganization()
    logStep('🏥 Asegurando Organization por defecto…', DEF_ORG_ID)
    await putToNode(org)
    uploadedOrganizations.add(DEF_ORG_ID)
  }
}

async function uploadOrganization(orgId){
  if (uploadedOrganizations.has(orgId)) return 0
  try {
    logStep('🔍 Fetching Organization…', orgId)
    const org = await getFromProxy(`/Organization/${orgId}`)
    logStep('📤 Subiendo Organization…', orgId)
    await putToNode(org)
    uploadedOrganizations.add(orgId)
    return 1
  } catch (e) {
    if (DEF_ORG_ENABLED && (isGoneOrMissingError(e) || /Unknown resource type 'Organization'/.test(String(e)))) {
      await ensureDefaultOrganization()
      return 0
    }
    throw e
  }
}

async function uploadLocationWithParents(locId) {
  if (uploadedLocations.has(locId)) return
  let loc
  try {
    logStep('🔍 Fetching Location…', locId)
    loc = await getFromProxy(`/Location/${locId}`)
  } catch (e) {
    if (isGoneOrMissingError(e) && baseOMRS_FHIR && omrsAuth) {
      try { loc = await getFromOpenMRS_FHIR(`/Location/${locId}`) }
      catch (e2) { if (isGoneOrMissingError(e2)) { logStep('🗑️  Location no disponible, se omite:', locId); return } else throw e2 }
    } else { if (isGoneOrMissingError(e)) { logStep('🗑️  Location no disponible, se omite:', locId); return } throw e }
  }
  const parentRef = loc.partOf?.reference
  if (parentRef?.startsWith('Location/')) {
    const parentId = parentRef.split('/')[1]
    await uploadLocationWithParents(parentId)
  }
  logStep('📤 Subiendo Location…', locId)
  await putToNode(loc)
  uploadedLocations.add(locId)
}

async function uploadPractitionerByRef(ref) {
  const id = ref.split('/')[1]
  return uploadPractitionerById(id)
}
async function uploadPractitionerById(pracId) {
  if (!pracId) return 0
  if (uploadedPractitioners.has(pracId)) return 0
  // 1) Proxy FHIR
  try {
    logStep('🔍 Fetching Practitioner…', pracId)
    const prac = await getFromProxy(`/Practitioner/${pracId}`)
    logStep('📤 Subiendo Practitioner…', pracId)
    await putToNode(prac)
    uploadedPractitioners.add(pracId)
    return 1
  } catch (e) {
    // 2) OMRS FHIR
    if (isGoneOrMissingError(e) && baseOMRS_FHIR && omrsAuth) {
      try {
        const prac = await getFromOpenMRS_FHIR(`/Practitioner/${pracId}`)
        logStep('📤 Subiendo Practitioner (omrs-fhir)…', pracId)
        await putToNode(prac)
        uploadedPractitioners.add(pracId)
        return 1
      } catch (e2) {
        if (!isGoneOrMissingError(e2)) throw e2
      }
    }
    // 3) OMRS REST /provider → construir Practitioner mínimo
    if (isGoneOrMissingError(e) && baseOMRS_REST && omrsAuth) {
      try {
        const prov = await getFromOpenMRS_REST(`/provider/${encodeURIComponent(pracId)}?v=full`)
        const personUuid = prov?.person?.uuid
        const name = prov?.person?.display || prov?.identifier || 'Practitioner'
        const practitioner = {
          resourceType: 'Practitioner',
          id: pracId, // 👈 mantener el ID solicitado (coincide con la referencia faltante)
          name: [{ text: name }],
          ...(personUuid ? {
            identifier: [{
              system: 'https://openmrs.org/person-uuid',
              value: personUuid
            }]
          } : {})
        }
        logStep('🏗️ Construyendo Practitioner desde REST provider…', pracId)
        await putToNode(practitioner)
        uploadedPractitioners.add(pracId)
        return 1
      } catch (e3) {
        if (isGoneOrMissingError(e3)) { logStep('🗑️ Practitioner (provider) no disponible:', pracId); return 0 }
        throw e3
      }
    }
    if (isGoneOrMissingError(e)) { logStep('🗑️ Practitioner no disponible:', pracId); return 0 }
    throw e
  }
}

async function uploadEncounterWithParents(encId) {
  if (uploadedEncounters.has(encId)) return
  let enc
  try {
    logStep('🔍 Fetching Encounter…', encId)
    enc = await getFromProxy(`/Encounter/${encId}`)
  } catch (e) {
    if (isGoneOrMissingError(e) && baseOMRS_FHIR && omrsAuth) {
      try { enc = await getFromOpenMRS_FHIR(`/Encounter/${encId}`) }
      catch (e2) { if (isGoneOrMissingError(e2)) { logStep('🗑️  Encounter no disponible, se omite:', encId); return } else throw e2 }
    } else { throw e }
  }

  // parent encounter
  const parentRef = enc.partOf?.reference
  if (parentRef?.startsWith('Encounter/')) {
    const parentId = parentRef.split('/')[1]
    await uploadEncounterWithParents(parentId)
  }

  // serviceProvider Organization
  const orgRef = enc.serviceProvider?.reference
  if (orgRef?.startsWith('Organization/')) {
    try { await uploadOrganization(orgRef.split('/')[1]) }
    catch (e) {
      if (DEF_ORG_ENABLED && (isGoneOrMissingError(e) || /Unknown resource type 'Organization'/.test(String(e)))) {
        await ensureDefaultOrganization()
        enc.serviceProvider = { reference: `Organization/${DEF_ORG_ID}` }
      } else throw e
    }
  } else if (DEF_ORG_ENABLED) {
    await ensureDefaultOrganization()
    enc.serviceProvider = { reference: `Organization/${DEF_ORG_ID}` }
  }

  // locations (subir si existen)
  if (Array.isArray(enc.location)) {
    const filtered = []
    for (const le of enc.location) {
      const locRef = le.location?.reference
      if (!locRef?.startsWith('Location/')) { filtered.push(le); continue }
      const locId = locRef.split('/')[1]
      try {
        await uploadLocationWithParents(locId)
        if (uploadedLocations.has(locId)) filtered.push(le)
        else logStep('🧹 Quitando Location no subida:', locId)
      } catch (e) {
        if (isGoneOrMissingError(e)) { logStep('🧹 Quitando Location inexistente:', locId) }
        else throw e
      }
    }
    enc.location = filtered
    if (enc.location.length === 0) delete enc.location
  }

  // participants → subir Practitioner cuando corresponda
  if (Array.isArray(enc.participant)) {
    const filteredP = []
    for (const p of enc.participant) {
      const indyRef = p.individual?.reference
      if (!indyRef?.startsWith('Practitioner/')) { filteredP.push(p); continue }
      try { await uploadPractitionerByRef(indyRef); filteredP.push(p) }
      catch (e) { if (isGoneOrMissingError(e)) { logStep('🧹 Quitando participant inexistente:', indyRef) } else throw e }
    }
    enc.participant = filteredP
    if (enc.participant.length === 0) delete enc.participant
  }

  logStep('📤 Subiendo Encounter…', encId)
  await putToNode(enc)
  uploadedEncounters.add(encId)
}

async function buildMedicationFromOMRS(drugUuid) {
  // 1) REST /drug
  const drug = await getFromOpenMRS_REST(`/drug/${encodeURIComponent(drugUuid)}?v=full`)
  // 2) (opcional) REST /concept de respaldo
  let conceptName = drug?.concept?.display || drug?.display || 'Medication'
  try {
    if (drug?.concept?.uuid) {
      const concept = await getFromOpenMRS_REST(`/concept/${encodeURIComponent(drug.concept.uuid)}?v=full`)
      const pref = (concept?.names||[]).find(n => n?.localePreferred) || (concept?.names||[])[0]
      if (pref?.name) conceptName = pref.name
    }
  } catch { /* no crítico */ }

  // 3) Ingredientes (si hay fuerza/concentración)
  // OpenMRS drug tiene fields como strength (texto) y dosageForm, pero suelen ser libres.
  // Aquí generamos Medication mínimo; si puedes mapear a SNOMED/UCUM, mejor.
  return {
    resourceType: 'Medication',
    id: drugUuid,
    code: { text: conceptName },
    // Opcional: agregar form si la tienes:
    // form: { text: drug?.dosageForm?.display || drug?.dosageForm },
    // Opcional: ingredient desde strength "500 mg" (requiere parseo si quieres UCUM):
    // ingredient: [{ itemCodeableConcept: { text: conceptName }, strength: { numerator:{value:500, unit:'mg'} } }]
  }
}

async function uploadMedication(medId) {
  if (!medId) return 0
  if (uploadedMedications.has(medId)) return 0
  try {
    logStep('🔍 Fetching Medication…', medId)
    const med = await getFromProxy(`/Medication/${medId}`)
    logStep('📤 Subiendo Medication…', medId)
    await putToNode(med)
    uploadedMedications.add(medId)
    return 1
  } catch (e) {
    if (isGoneOrMissingError(e)) {
      // Fallback 1: OpenMRS FHIR (si existe módulo FHIR de OpenMRS)
      if (baseOMRS_FHIR && omrsAuth) {
        try {
          const med = await getFromOpenMRS_FHIR(`/Medication/${medId}`)
          logStep('📤 Subiendo Medication (omrs-fhir)…', medId)
          await putToNode(med)
          uploadedMedications.add(medId)
          return 1
        } catch (e2) {
          if (!isGoneOrMissingError(e2)) throw e2
        }
      }
      // Fallback 2: OpenMRS REST /drug → construir Medication mínimo
      if (baseOMRS_REST && omrsAuth) {
        try {
          const medBuilt = await buildMedicationFromOMRS(medId)
          logStep('🏗️ Construyendo Medication desde REST drug…', medId)
          await putToNode(medBuilt)
          uploadedMedications.add(medId)
          return 1
        } catch (e3) {
          if (isGoneOrMissingError(e3)) { logStep('🗑️ Medication no disponible en OMRS:', medId); return 0 }
          throw e3
        }
      }
      logStep('🗑️ Medication no disponible en ninguna fuente:', medId)
      return 0
    }
    throw e
  }
}

// 6) Fallback REST → MedicationRequest
function mapRestOrderToFhirMedReq(order, patientUuid) {
  // Status
  const now = new Date()
  let status = 'active'
  const stopped = order.dateStopped ? new Date(order.dateStopped) : null
  const autoExp = order.autoExpireDate ? new Date(order.autoExpireDate) : null
  if (stopped && stopped <= now) status = 'completed'
  else if (autoExp && autoExp <= now) status = 'completed'

  // authoredOn
  const authoredOn = order.dateActivated || order.dateCreated || null

  // Encounter
  const encRef = order.encounter?.uuid ? { reference: `Encounter/${order.encounter.uuid}` } : undefined

  // Requester: en REST es Provider; en FHIR debería ser Practitioner. Si no podemos garantizar el mapeo, omitimos.
  const requester = order.orderer?.uuid ? { reference: `Practitioner/${order.orderer.uuid}` } : undefined

  // Medication: si existe drug.uuid generamos MedicationReference (destino intentará levantarla)
  let medicationReference, medicationCodeableConcept
  if (order.drug?.uuid) medicationReference = { reference: `Medication/${order.drug.uuid}` }
  else {
    const text = order.concept?.display || order.display || 'Medication'
    medicationCodeableConcept = { text }
  }

  // Dosificación
  const doseQuantity = (order.dose != null) ? {
    value: order.dose,
    unit: order.doseUnits?.display || undefined
  } : undefined

  const route = order.route?.display ? { text: order.route.display } : undefined

  // timing (difícil derivar rítmica exacta desde display; guardamos texto)
  const timing = order.frequency?.display ? { code: { text: order.frequency.display } } : undefined

  // instrucciones
  let instrText
  try {
    if (order.dosingInstructions) {
      const di = typeof order.dosingInstructions === 'string'
        ? JSON.parse(order.dosingInstructions)
        : order.dosingInstructions
      instrText = [di?.instructions, di?.additionalInstructions].filter(Boolean).join(' | ') || undefined
    }
  } catch { /* ignore json parse */ }

  const di = {
    ...(instrText ? { text: instrText } : {}),
    ...(route ? { route } : {}),
    ...(timing ? { timing } : {}),
    ...(doseQuantity ? { doseAndRate: [{ type: { text: 'ordered' }, doseQuantity }] } : {})
  }
  const dosageInstruction = Object.keys(di).length ? [di] : undefined

  // dispenseRequest
  const quantity = (order.quantity != null) ? {
    value: order.quantity,
    unit: order.quantityUnits?.display || order.doseUnits?.display || undefined
  } : undefined

  const expectedSupplyDuration = (order.duration != null) ? {
    value: order.duration,
    unit: order.durationUnits?.display || 'days'
  } : undefined

  const validityPeriod = (order.dateActivated || order.autoExpireDate) ? {
    start: order.dateActivated || undefined,
    end:   order.autoExpireDate || undefined
  } : undefined

  return {
    resourceType: 'MedicationRequest',
    id: order.uuid,
    status,
    intent: 'order',
    authoredOn: authoredOn || undefined,
    subject: { reference: `Patient/${patientUuid}` },
    encounter: encRef,
    requester, // se omite si no existe Practitioner
    medicationReference,
    medicationCodeableConcept,
    dosageInstruction,
    dispenseRequest: (quantity || expectedSupplyDuration || validityPeriod) ? {
      quantity,
      expectedSupplyDuration,
      validityPeriod
    } : undefined
  }
}

async function fallbackDrugOrdersToMedReq(patientUuid) {
  if (!baseOMRS_REST) {
    logStep('⚠️ Fallback REST no disponible (OPENMRS_REST_URL no configurado)')
    return []
  }
  const rest = await getFromOpenMRS_REST(`/order?patient=${encodeURIComponent(patientUuid)}&v=full`)
  const results = Array.isArray(rest?.results) ? rest.results : []
  const medOrders = results.filter(r => r?.type === 'drugorder' && !r?.voided)
  if (!medOrders.length) return []
  logStep(`↩️  Fallback: ${medOrders.length} drugorder a transformar`)
  return medOrders.map(o => mapRestOrderToFhirMedReq(o, patientUuid))
}

// --- util: paginación FHIR
async function fhirSearchAll(getter, firstPath) {
  let out = []
  let bundle = await getter(firstPath)
  const push = b => { if (Array.isArray(b?.entry)) out.push(...b.entry.map(e => e.resource).filter(Boolean)) }
  push(bundle)
  while (true) {
    const next = (bundle.link || []).find(l => l.relation === 'next')?.url
    if (!next) break
    let path = next
    try { const u = new URL(next); path = u.pathname + (u.search || '') } catch { /* next ya era relativo */ }
    bundle = await getter(path)
    push(bundle)
  }
  return out
}

// --- util: recolectar refs Practitioner de un MedReq
function collectPractitionerRefsFromMedReq(mr) {
  const refs = []
  if (mr.requester?.reference?.startsWith('Practitioner/')) refs.push(mr.requester.reference)
  if (mr.recorder?.reference?.startsWith('Practitioner/')) refs.push(mr.recorder.reference)
  const perf = mr.performer?.reference
  if (perf?.startsWith('Practitioner/')) refs.push(perf)
  return [...new Set(refs)]
}

// 7) Server
const app = express()
app.use(express.json({ limit: '10mb' }))

// Health
app.get('/medreq/_health', (_req, res) => res.send('OK'))

// Event endpoint: { uuid: <EncounterUUID> }
app.post('/medreq/_event', async (req, res) => {
  const { uuid } = req.body || {}
  if (!uuid) return res.status(400).json({ error: 'Missing uuid (Encounter)' })

  logStep('📩 POST /medreq/_event', req.body)

  let sent = { MedicationRequest:0, Medication:0, Patient:0, Encounter:0, Practitioner:0, Organization:0, Location:0 }
  const notes = []

  try {
    // 1) Encounter (sin control de duplicados por "seen")
    const enc = await getFromProxy(`/Encounter/${uuid}`)

    // 2) Patient
    const patientId = enc.subject?.reference?.split('/').pop()
    if (!patientId) throw new Error('Encounter.subject.reference inválido')
    const patient = await getFromProxy(`/Patient/${patientId}`)
    await putToNode(patient); sent.Patient++

    // 3) Subir Encounter + padres (Org/Loc/practitioners de participant)
    await uploadEncounterWithParents(uuid); sent.Encounter++

    // 4) Buscar MedicationRequest por paciente (FHIR primero)
    let medReqs = []
    try {
      // Construir parámetros de filtro de fecha
      const dateParams = []
      if (MR_AUTHOR_FROM) dateParams.push(`authoredon=ge${encodeURIComponent(MR_AUTHOR_FROM)}`)
      if (MR_AUTHOR_TO) dateParams.push(`authoredon=le${encodeURIComponent(MR_AUTHOR_TO)}`)
      const queryTail = dateParams.length ? ('&' + dateParams.join('&')) : ''
      
      const basePath = `/MedicationRequest?patient=${encodeURIComponent(patientId)}&_include=MedicationRequest:medication&_count=200${queryTail}`
      const resources = await fhirSearchAll(getFromProxy, basePath)
      
      medReqs = resources.filter(r => r.resourceType === 'MedicationRequest')
      // precarga Medication incluidas
      for (const m of resources) {
        if (m.resourceType === 'Medication' && m.id) {
          uploadedMedications.add(m.id) // ya disponible; NO sumar al contador
        }
      }
      notes.push(`FHIR search ok (${medReqs.length} MR)`)
    } catch (e) {
      notes.push(`FHIR search error: ${e.message}`)
    }

    // 5) Fallback: REST /order → transformar (si vacío o error)
    if (!medReqs.length) {
      const transformed = await fallbackDrugOrdersToMedReq(patientId)
      medReqs.push(...transformed)
      if (transformed.length) notes.push(`fallback REST drugorder: ${transformed.length} transformado(s)`)
    }

    // 6) Por cada MedicationRequest: asegurar refs mínimas y subir
    for (const mr of medReqs) {
      if (!mr?.resourceType || !mr.id) continue

      // Encuentro de la MR (si difiere del del evento, también subirlo)
      const encRef = mr.encounter?.reference
      if (encRef?.startsWith('Encounter/')) {
        const encId = encRef.split('/')[1]
        await uploadEncounterWithParents(encId)
      }

      // Medication (si medicationReference)
      const medRef = mr.medicationReference?.reference
      if (medRef?.startsWith('Medication/')) {
        const medId = medRef.split('/')[1]
        const uploadedCount = await uploadMedication(medId)
        if (uploadedCount) sent.Medication += uploadedCount
      }

      // Practitioners
      const pracRefs = collectPractitionerRefsFromMedReq(mr)
      for (const r of pracRefs) {
        try { const n = await uploadPractitionerByRef(r); sent.Practitioner += n }
        catch (e) {
          if (isGoneOrMissingError(e)) {
            logStep('⚠️ Omitiendo practitioner faltante en MR:', r)
            // limpiar el campo correspondiente para no romper el PUT
            if (mr.requester?.reference === r) delete mr.requester
            if (mr.recorder?.reference === r) delete mr.recorder
            if (mr.performer?.reference === r) delete mr.performer
          } else { throw e }
        }
      }

      // Subir MR
      logStep('📤 Subiendo MedicationRequest…', mr.id)
      await putToNode(mr)
      sent.MedicationRequest++
    }

    logStep('🎉 MedReq done', uuid)
    res.json({ status:'ok', uuid, sent, notes })
  } catch (e) {
    logStep('❌ ERROR /medreq/_event:', e.message)
    res.status(500).json({ error: e.message, sent, notes })
  }
})

// 8) Start
const PORT = Number(process.env.FORWARDER_MEDICATIONREQUEST_PORT || 8012)
app.listen(PORT, () => logStep(`💊 MedReq Forwarder escuchando en puerto ${PORT}`))
