// index.js (FHIR Event Forwarder Mediator) — Vacunación -> Immunization (ICVP & LAC modes)
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
  apiURL: (process.env.OPENHIM_API || '').replace(/\/$/, ''),
  trustSelfSigned: true
}

// HTTPS agent (allow self-signed)
axios.defaults.httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  cert: process.env.CLIENT_CERT && fs.existsSync(process.env.CLIENT_CERT) ? fs.readFileSync(process.env.CLIENT_CERT) : undefined,
  key: process.env.CLIENT_KEY && fs.existsSync(process.env.CLIENT_KEY) ? fs.readFileSync(process.env.CLIENT_KEY) : undefined
})

// =============================
// Helpers: logging & utils
// =============================
function logStep (...args) { console.log(new Date().toISOString(), '-', ...args) }
function codeList(obs) { return (obs?.code?.coding || []).map(c => c.code).filter(Boolean) }
function indexByIdFromBundle(bundle) { const byId = new Map(); for (const e of (bundle.entry||[])) if (e.resource?.id) byId.set(e.resource.id, e.resource); return byId }
function pickMemberByCode(idList, byId, code) { return idList.map(id => byId.get(id)).find(r => codeList(r).includes(code)) }
function toDate(dt) { return (typeof dt === 'string' ? dt.substring(0,10) : undefined) }

// =============================
// FHIR Proxy / Node helpers
// =============================
async function getFromProxy (path) {
  const url = `${(process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')}${path}`
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
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
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

// Cache for uploaded resources
const uploadedPractitioners = new Set()
const uploadedOrganizations = new Set()
const uploadedLocations = new Set()

async function uploadPractitioner (pracRef) {
  const pracId = pracRef.split('/')[1]
  if (uploadedPractitioners.has(pracId)) return 0
  const prac = await getFromProxy(`/Practitioner/${pracId}`)
  // If ICVP mode, ensure mCSD Practitioner profile is present
  if (IMM_MODE === 'ICVP') {
    prac.meta = prac.meta || {}
    const profiles = new Set(prac.meta.profile || [])
    profiles.add(IHE_MCSD_PRACTITIONER)
    prac.meta.profile = Array.from(profiles)
  }
  await putToNode(prac)
  uploadedPractitioners.add(pracId)
  return 1
}

async function uploadLocationWithParents (locId) {
  if (uploadedLocations.has(locId)) return 0
  const loc = await getFromProxy(`/Location/${locId}`)
  await putToNode(loc)
  uploadedLocations.add(locId)
  // Upload managing organization if present
  const orgRef = loc.managingOrganization?.reference
  if (orgRef?.startsWith('Organization/')) {
    const orgId = orgRef.split('/')[1]
    if (!uploadedOrganizations.has(orgId)) {
      const org = await getFromProxy(`/Organization/${orgId}`)
      // In ICVP mode, normalize profile to mCSD Jurisdiction Organization
      if (IMM_MODE === 'ICVP') {
        org.meta = org.meta || {}
        org.meta.profile = [IHE_MCSD_JURISDICTION_ORG]
      }
      await putToNode(org)
      uploadedOrganizations.add(orgId)
    }
  }
  return 1
}

function getEncounterFirstPractitioner (enc) {
  const x = (enc?.participant || []).find(p => p.individual?.reference?.startsWith('Practitioner/'))
  return x?.individual?.reference
}
function getEncounterFirstLocation (enc) {
  const x = (enc?.location || []).find(l => l.location?.reference?.startsWith('Location/'))
  return x?.location?.reference
}

// =============================
// ICVP constants & feature flags
// =============================
const IMM_MODE = (process.env.IMM_MODE || 'ICVP').toUpperCase() // 'ICVP' | 'LAC'

const ICVP_IMM_PROFILE = 'http://smart.who.int/icvp/StructureDefinition/DVC-ImmunizationUvIps'
const ICVP_DVC_VACCINES_VS = 'http://smart.who.int/icvp/ValueSet/DVCVaccines'
const ICVP_DOSE_NUM_CC_EXT = 'http://smart.who.int/icvp/StructureDefinition/doseNumberCodeableConcept'

// IHE mCSD profiles required by ICVP for actor/authority references
const IHE_MCSD_PRACTITIONER = 'https://profiles.ihe.net/ITI/mCSD/StructureDefinition/IHE.mCSD.Practitioner'
const IHE_MCSD_JURISDICTION_ORG = 'https://profiles.ihe.net/ITI/mCSD/StructureDefinition/IHE.mCSD.JurisdictionOrganization'

// Strictness for ICVP validation: require vaccineCode to be in DVCVaccines and authority present in protocolApplied
const ICVP_STRICT = /^true$/i.test(process.env.ICVP_STRICT || 'true')

// =============================
// LAC PASS constants & helpers
// =============================
const LAC_IMM_PROFILE = 'http://lacpass.racsel.org/StructureDefinition/lac-immunization'
const LAC_ORG_PROFILE = 'http://lacpass.racsel.org/StructureDefinition/lac-organization'

const EXT_LAC_BRAND      = 'http://lacpass.racsel.org/StructureDefinition/DDCCEventBrand'
const EXT_LAC_MA         = 'http://lacpass.racsel.org/StructureDefinition/DDCCVaccineMarketAuthorization'
const EXT_LAC_COUNTRY    = 'http://lacpass.racsel.org/StructureDefinition/DDCCCountryOfEvent'
const EXT_LAC_VALID_FROM = 'http://lacpass.racsel.org/StructureDefinition/DDCCVaccineValidFrom'

const USE_TERMINOLOGY = /^true$/i.test(process.env.USE_TERMINOLOGY || 'false')
const TERMINOLOGY_BASE = (process.env.TERMINOLOGY_BASE || '').replace(/\/$/, '')

function isoCountry () { return (process.env.LAC_COUNTRY_CODE || 'CL').toUpperCase() }
const slug = (s) => ('org-' + String(s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''))

async function terminologyValidateOrFallback (coding) {
  if (!USE_TERMINOLOGY || !TERMINOLOGY_BASE || !coding?.system || !coding?.code) return coding
  try {
    // $validate-code on CodeSystem
    const url = `${TERMINOLOGY_BASE}/CodeSystem/$validate-code`
    const { data } = await axios.get(url, { params: { system: coding.system, code: coding.code }, httpsAgent: axios.defaults.httpsAgent })
    if (data?.result === true) return coding
    // try $lookup for display
    try {
      const lu = `${TERMINOLOGY_BASE}/CodeSystem/$lookup`
      const { data: d2 } = await axios.get(lu, { params: { system: coding.system, code: coding.code }, httpsAgent: axios.defaults.httpsAgent })
      const disp = (d2?.parameter || []).find(p => p.name === 'display')?.valueString
      return { ...coding, ...(disp ? { display: disp } : {}) }
    } catch { return coding }
  } catch { return coding }
}

// ICVP: Validate vaccineCode against DVCVaccines ValueSet
async function validateVaccineCodeICVP (coding) {
  // Validate that coding is a member of the DVCVaccines ValueSet
  if (!coding?.system || !coding?.code) throw new Error('ICVP requires vaccineCode with system+code')
  if (!USE_TERMINOLOGY || !TERMINOLOGY_BASE) {
    if (ICVP_STRICT) throw new Error('ICVP_STRICT enabled but terminology server not configured (TERMINOLOGY_BASE)')
    return coding // non-strict: assume ok
  }
  try {
    const params = { url: ICVP_DVC_VACCINES_VS, system: coding.system, code: coding.code }
    const vsUrl = `${TERMINOLOGY_BASE}/ValueSet/$validate-code`
    const { data } = await axios.get(vsUrl, { params, httpsAgent: axios.defaults.httpsAgent })
    if (data?.result === true) return coding
  } catch (e) {
    // try POST as some servers require POST
    try {
      const vsUrl = `${TERMINOLOGY_BASE}/ValueSet/$validate-code`
      const body = { resourceType: 'Parameters', parameter: [
        { name: 'url', valueUri: ICVP_DVC_VACCINES_VS },
        { name: 'system', valueUri: coding.system },
        { name: 'code', valueCode: coding.code }
      ] }
      const { data } = await axios.post(vsUrl, body, { httpsAgent: axios.defaults.httpsAgent })
      if (data?.result === true) return coding
    } catch {}
  }
  // Try fallback coding if provided (and validate it)
  if (process.env.ICVP_VACCINE_FALLBACK_SYSTEM && process.env.ICVP_VACCINE_FALLBACK_CODE) {
    const fb = { system: process.env.ICVP_VACCINE_FALLBACK_SYSTEM, code: process.env.ICVP_VACCINE_FALLBACK_CODE }
    return await validateVaccineCodeICVP(fb)
  }
  throw new Error('vaccineCode does not belong to DVCVaccines ValueSet and no valid fallback provided')
}

async function ensureOrganizationByName (name) {
  if (!name) return undefined
  const id = slug(name)
  if (uploadedOrganizations.has(id)) return { reference: `Organization/${id}`, display: name }
  const org = {
    resourceType: 'Organization',
    id,
    meta: { profile: [IMM_MODE === 'ICVP' ? IHE_MCSD_JURISDICTION_ORG : LAC_ORG_PROFILE] },
    name: String(name),
    address: [{ use: 'work', country: isoCountry() }]
  }
  await putToNode(org)
  uploadedOrganizations.add(id)
  return { reference: `Organization/${id}`, display: org.name }
}

function buildLacImmunizationExtensions () {
  const ext = []
  if (!process.env.LAC_BRAND_SYSTEM || !process.env.LAC_BRAND_CODE) {
    throw new Error('Faltan LAC_BRAND_SYSTEM o LAC_BRAND_CODE para DDCCEventBrand')
  }
  ext.push({ url: EXT_LAC_BRAND, valueCoding: { system: process.env.LAC_BRAND_SYSTEM, code: process.env.LAC_BRAND_CODE } })

  ext.push({ url: EXT_LAC_COUNTRY, valueCode: isoCountry() })

  if (process.env.LAC_MA_SYSTEM && process.env.LAC_MA_CODE) {
    ext.push({ url: EXT_LAC_MA, valueCoding: { system: process.env.LAC_MA_SYSTEM, code: process.env.LAC_MA_CODE } })
  }
  if (process.env.LAC_VALID_FROM) {
    ext.push({ url: EXT_LAC_VALID_FROM, valueDate: process.env.LAC_VALID_FROM })
  }
  return ext
}

// =============================
// Source codes (OpenMRS concept UUIDs)
// =============================
const IMM_SET_CODE = '1421AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' // Set: Vaccination Event
const IMM_CODES = {
  VACCINE:       '984AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Vaccination -> valueCodeableConcept
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

// =============================
// Bundle scanning helpers
// =============================
function isRelevantVaccinationObservation (r) {
  return r?.resourceType === 'Observation' && codeList(r).some(c => IMM_ALL_CODES.has(c))
}
function indexByIdAndFilter (bundle) {
  const byId = new Map()
  const out = []
  for (const e of (bundle.entry || [])) {
    const r = e.resource
    if (!r?.id) continue
    byId.set(r.id, r)
    if (isRelevantVaccinationObservation(r)) out.push(r)
  }
  return { byId, out }
}

// =============================
// Builder: Immunization from group
// =============================
async function buildImmunizationFromGroup (groupObs, obsById, patientRef, enc, patientId) {
  const idList = (groupObs.hasMember || [])
    .map(m => m.reference?.replace(/^Observation\//, ''))
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

  // status (perfil LAC/ICVP: completed | entered-in-error | not-done)
  let status = 'completed'
  const recvCoding = recvObs?.valueCodeableConcept?.coding || []
  if (recvCoding.find(c => c.code === IMM_CODES.NO)) status = 'not-done'
  if (recvCoding.find(c => c.code === IMM_CODES.YES)) status = 'completed'

  // vaccineCode (1..1) -> asegurar coding con system+code
  let coding = vaxObs?.valueCodeableConcept?.coding?.find(c => c.system && c.code) || null
  if (!coding && process.env.LAC_VACCINE_FALLBACK_SYSTEM && process.env.LAC_VACCINE_FALLBACK_CODE) {
    // Solo se usa en modo LAC; en ICVP se valida contra el ValueSet DVCVaccines
    coding = {
      system: process.env.LAC_VACCINE_FALLBACK_SYSTEM,
      code: process.env.LAC_VACCINE_FALLBACK_CODE,
      ...(process.env.LAC_VACCINE_FALLBACK_DISPLAY ? { display: process.env.LAC_VACCINE_FALLBACK_DISPLAY } : {})
    }
  }
  if (!coding && freeObs?.valueString) {
    // ¡Ojo! Esto NO cumple ICVP (binding REQUIRED a DVCVaccines); en modo ICVP, terminará fallando más abajo.
    coding = { system: 'http://terminology.hl7.org/CodeSystem/v3-NullFlavor', code: 'UNK', display: freeObs.valueString }
  }
  if (!coding) throw new Error('No se pudo determinar vaccineCode (system+code)')
  const vaccineCodeCoding = (IMM_MODE === 'ICVP') ? await validateVaccineCodeICVP(coding) : await terminologyValidateOrFallback(coding)

  // occurrenceDateTime (1..1 requerido)
  const occurrenceDateTime = dateObs?.valueDateTime || groupObs?.effectiveDateTime
  if (!occurrenceDateTime) throw new Error('Falta occurrenceDateTime para Immunization')

  // encounter + location (location.display por compatibilidad LAC; permitido por ICVP)
  const encounterRef = groupObs?.encounter?.reference || (enc?.id ? `Encounter/${enc.id}` : undefined)
  const locationRef = getEncounterFirstLocation(enc)
  const locDisplay = (process.env.LAC_DEFAULT_LOCATION_DISPLAY || process.env.ICVP_DEFAULT_LOCATION_DISPLAY || 'Administration center')
  const location = locationRef ? { reference: locationRef, display: locDisplay } : { display: locDisplay }

  // manufacturer -> Organization con perfil LAC o mCSD (según modo)
  const manufacturerRef = await ensureOrganizationByName(mfgObs?.valueString)

  // performer -> 1er Practitioner del Encounter; si no hay y estamos en ICVP, usar Organization
  const practitionerRef = getEncounterFirstPractitioner(enc)
  let performer = practitionerRef ? [{ actor: { reference: practitionerRef } }] : []
  if (IMM_MODE === 'ICVP' && performer.length === 0) {
    const perfOrg = await ensureOrganizationByName(process.env.ICVP_PERFORMER_ORG_NAME || process.env.ICVP_AUTHORITY_ORG_NAME)
    if (perfOrg) performer.push({ actor: perfOrg })
  }
  if (performer.length === 0) performer = undefined

  // protocolApplied
  let doseNumber
  const dn = doseObs?.valueQuantity?.value
  if (Number.isFinite(dn)) doseNumber = Math.trunc(dn)
  else if (doseObs?.valueString && /^\d+$/.test(doseObs.valueString)) doseNumber = parseInt(doseObs.valueString, 10)
  else if (process.env.LAC_DEFAULT_DOSE_NUMBER) doseNumber = parseInt(process.env.LAC_DEFAULT_DOSE_NUMBER, 10)
  if (!doseNumber) throw new Error('Falta doseNumberPositiveInt en protocolApplied')

  let protocolApplied
  if (IMM_MODE === 'ICVP') {
    const pae = {
      doseNumberPositiveInt: doseNumber,
      extension: [{
        url: ICVP_DOSE_NUM_CC_EXT,
        valueCodeableConcept: { text: `Dose ${doseNumber}` }
      }]
    }
    const authRef = await ensureOrganizationByName(process.env.ICVP_AUTHORITY_ORG_NAME || process.env.LAC_AUTHORITY_ORG_NAME)
    if (!authRef) {
      if (ICVP_STRICT) throw new Error('ICVP requiere protocolApplied.authority (configura ICVP_AUTHORITY_ORG_NAME)')
    } else {
      pae.authority = authRef
    }
    if (process.env.ICVP_TD_SYSTEM && process.env.ICVP_TD_CODE) {
      pae.targetDisease = [{ coding: [{ system: process.env.ICVP_TD_SYSTEM, code: process.env.ICVP_TD_CODE }] }]
    }
    protocolApplied = [pae]
  } else {
    const pae = { doseNumberPositiveInt: doseNumber }
    if (process.env.LAC_AUTHORITY_ORG_NAME) pae.authority = await ensureOrganizationByName(process.env.LAC_AUTHORITY_ORG_NAME)
    if (process.env.LAC_TD_SYSTEM && process.env.LAC_TD_CODE) {
      pae.targetDisease = [{ coding: [{ system: process.env.LAC_TD_SYSTEM, code: process.env.LAC_TD_CODE }] }]
    }
    protocolApplied = [pae]
  }

  // lotNumber / expirationDate (opcionales)
  const lotNumber = lotObs?.valueString
  const expirationDate = toDate(expObs?.valueDateTime)

  // Construir Immunization conforme al modo
  const profile = (IMM_MODE === 'ICVP') ? ICVP_IMM_PROFILE : LAC_IMM_PROFILE
  const imm = {
    resourceType: 'Immunization',
    id: groupObs.id, // trazabilidad
    meta: { profile: [profile] },
    ...(IMM_MODE === 'LAC' ? { extension: buildLacImmunizationExtensions() } : {}),
    status,
    vaccineCode: { coding: [vaccineCodeCoding] },
    patient: { reference: patientRef },
    ...(encounterRef ? { encounter: { reference: encounterRef } } : {}),
    occurrenceDateTime,
    ...(location ? { location } : {}),
    ...(manufacturerRef ? { manufacturer: manufacturerRef } : {}),
    ...(lotNumber ? { lotNumber } : {}),
    ...(expirationDate ? { expirationDate } : {}),
    ...(performer ? { performer } : {}),
    protocolApplied
  }

  return imm
}

// =============================
// Pipeline handler
// =============================
async function processImmunizationsByPatient (patientId, enc) {
  let sent = 0
  const url = `/Observation?patient=${encodeURIComponent(patientId)}&category=procedure&code=${IMM_SET_CODE}&_include=Observation:has-member&_count=200&_format=application/fhir+json`
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

// =============================
// Express app
// =============================
const app = express()
app.use(express.json({ limit: '2mb' }))

app.get('/forwarderimmunization/_health', (_req, res) => res.send('OK'))

app.post('/forwarderimmunization/_event', async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  try {
    // 1) Bundle principal (encounter)
    const bun = await getFromProxy(`/Bundle/${uuid}`)
    if (bun.resourceType !== 'Bundle') throw new Error('Bundle not found')

    // 2) Buscar Encounter
    const enc = (bun.entry || []).map(e => e.resource).find(r => r?.resourceType === 'Encounter')
    if (!enc?.id) throw new Error('Encounter not found in bundle')

    // 3) Subir Practitioner(s) del Encounter (si hay)
    if (Array.isArray(enc.participant)) {
      for (const p of enc.participant) {
        const indyRef = p.individual?.reference
        if (indyRef?.startsWith('Practitioner/')) {
          await uploadPractitioner(indyRef)
        }
      }
    }

    // 4) Subir Location(es) del Encounter (y sus Organization)
    if (Array.isArray(enc.location)) {
      for (const locEntry of enc.location) {
        const locRef = locEntry.location?.reference
        if (locRef?.startsWith('Location/')) {
          const locId = locRef.split('/')[1]
          await uploadLocationWithParents(locId)
        }
      }
    }

    // 5) Subir Organization manufacturer (si aparece durante mapping)
    //    -> se maneja dentro de buildImmunizationFromGroup -> ensureOrganizationByName

    // 6) Vacunación -> Immunization (ICVP/LAC)
    const pid = enc?.subject?.reference?.split('/')[1]
    if (!pid) throw new Error('Encounter.subject missing patient reference')
    const sent = await processImmunizationsByPatient(pid, enc)

    logStep('🎉 Done', uuid)
    res.json({ status: 'ok', uuid, sent })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// --- Mediator registration
const openhimOptions = { apiURL: openhimConfig.apiURL, username: openhimConfig.username, password: openhimConfig.password, trustSelfSigned: openhimConfig.trustSelfSigned }
const me = mediatorConfig

function onRegister (err) {
  if (err) return logStep('❌ Registration failed', err)
  logStep('✅ Registered mediator', me.urn)
  activateHeartbeat(openhimOptions, me)
}

registerMediator(openhimOptions, me, onRegister)

const PORT = process.env.FORWARDER_IMMUNIZATION_PORT || 8009
const appServer = app.listen(PORT, () => logStep(`FHIR Forwarder on port ${PORT}`))

export default appServer
