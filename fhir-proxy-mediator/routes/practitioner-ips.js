// routes/practitioner-ips.js — Provider(OpenMRS) → Practitioner(FHIR IPS)
import express from 'express'
import axios from 'axios'

const router = express.Router()

// === Sistemas de identificadores desde .env ===
// NI (RUN): urn:oid:<LAC_NATIONAL_ID_SYSTEM_OID>
const IDENT_SYS_NI =
  process.env.LAC_NATIONAL_ID_SYSTEM_OID
    ? `urn:oid:${process.env.LAC_NATIONAL_ID_SYSTEM_OID}`
    : (process.env.PDQM_DEFAULT_IDENTIFIER_SYSTEM || undefined)

// PPN (Pasaporte): urn:oid:<LAC_PASSPORT_ID_SYSTEM_OID>
const IDENT_SYS_PPN =
  process.env.LAC_PASSPORT_ID_SYSTEM_OID
    ? `urn:oid:${process.env.LAC_PASSPORT_ID_SYSTEM_OID}`
    : undefined

// PRN (Provider number): configurable; si falta, cae a LOCAL_IDENTIFIER_SYSTEM o un fallback local
const IDENT_SYS_PRN =
  process.env.PROVIDER_NUMBER_SYSTEM_URI ||
  process.env.LOCAL_IDENTIFIER_SYSTEM ||
  'urn:org:local:provider-number'

// OpenMRS REST base ya definida en tu .env
const OPENMRS_REST = (process.env.OPENMRS_REST_URL || '').replace(/\/$/, '')
const OPENMRS_USER = process.env.OPENMRS_USER
const OPENMRS_PASS = process.env.OPENMRS_PASS

// Helper: parsea "Etiqueta: Valor"
const parseAttr = (display) => {
  const idx = (display || '').indexOf(':')
  if (idx === -1) return { label: (display || '').trim(), value: null }
  return {
    label: display.slice(0, idx).trim(),
    value: display.slice(idx + 1).trim()
  }
}

// practitioner_type → v2-0360|2.7
const PRACT_TYPE_TO_V20360 = {
  'Doctor':           { code: 'MD', display: 'Doctor of Medicine' },
  'Registered Nurse': { code: 'RN', display: 'Registered Nurse' }
  // Agrega más mappings si los usas: Dentist (DMD/DDS), Midwife, etc.
}

router.get('/ips/practitioner/:providerUuid', async (req, res) => {
  try {
    const { providerUuid } = req.params
    if (!OPENMRS_REST) {
      return res.status(500).json({ error: 'OPENMRS_REST_URL no está definido en .env' })
    }

    // 1) Provider (OpenMRS REST)
    const provUrl = `${OPENMRS_REST}/provider/${providerUuid}?v=full`
    const auth = OPENMRS_USER ? { username: OPENMRS_USER, password: OPENMRS_PASS } : undefined
    const provResp = await axios.get(provUrl, { auth })
    const provider = provResp.data

    // 2) Person (para nombre, sexo, nacimiento)
    let person = provider.person
    const selfLink = person?.links?.find(l => l.rel === 'self')?.uri
    if (selfLink) {
      const personResp = await axios.get(selfLink, { auth })
      person = personResp.data
    }

    // 3) Construcción de Practitioner IPS
    const prac = {
      resourceType: 'Practitioner',
      meta: { profile: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Practitioner-uv-ips'] },
      identifier: [],
      name: [],
      address: []
    }

    // 3.a) PRN institucional de OpenMRS (provider.identifier)
    if (provider.identifier) {
      prac.identifier.push({
        use: 'official',
        system: IDENT_SYS_PRN,
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PRN', display: 'Provider number' }] },
        value: String(provider.identifier).trim()
      })
    }

    // 3.b) Attributes → identifiers, address, birthDate, gender, qualification
    for (const a of (provider.attributes || [])) {
      const { label, value } = parseAttr(a.display || '')
      if (!value) continue
      const L = label.toLowerCase()

      if (L.startsWith('ppn') || L.includes('pasaporte')) {
        prac.identifier.push({
          use: 'official',
          system: IDENT_SYS_PPN,
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PPN', display: 'Passport number' }] },
          value
        })
      } else if (L.startsWith('prn') || L.includes('colegiomedico')) {
        prac.identifier.push({
          use: 'official',
          system: IDENT_SYS_PRN,
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PRN', display: 'Provider number' }] },
          value
        })
      } else if (L.startsWith('ni') || L.includes('run') || L.includes('rut')) {
        prac.identifier.push({
          use: 'official',
          system: IDENT_SYS_NI,
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NI', display: 'National unique individual identifier' }] },
          value
        })
      } else if (L.startsWith('address.country')) {
        const isChile = value.toLowerCase().includes('chile')
        const country = isChile ? 'CL' : value
        prac.address = [{ text: value, country }]
      } else if (L.startsWith('person.birthdate')) {
        const d = new Date(value)
        if (!isNaN(d)) {
          prac.birthDate = d.toISOString().slice(0, 10)
        }
      } else if (L.startsWith('person.gender')) {
        const g = value.toLowerCase()
        prac.gender = ['male','female','other','unknown'].includes(g) ? g : 'unknown'
      } else if (L.startsWith('practitioner_type')) {
        const t = value.trim()
        const map = PRACT_TYPE_TO_V20360[t]
        if (map) {
          prac.qualification = [{
            code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0360|2.7', code: map.code, display: map.display }] }
          }]
        }
      }
    }

    // 3.c) Nombre desde Person; si no hay, usar provider.person.display
    if (person?.personName) {
      const family = person.personName.familyName || person.personName.familyName2 || undefined
      const given = [person.personName.givenName, person.personName.middleName].filter(Boolean)
      prac.name = [{ use: 'official', family, given }]
    } else if (provider.person?.display) {
      const parts = provider.person.display.trim().split(/\s+/)
      const family = parts.pop()
      const given = parts
      prac.name = [{ use: 'official', family, given }]
    }

    return res.json(prac)
  } catch (err) {
    console.error('❌ Practitioner build error:', err?.response?.data || err.message)
    return res.status(500).json({ error: 'Failed to build Practitioner', detail: err?.response?.data || err.message })
  }
})

export default router
