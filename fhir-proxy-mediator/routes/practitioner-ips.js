// routes/practitioner-ips.js — Provider(OpenMRS) → Practitioner(FHIR IPS)
import express from 'express'
import axios from 'axios'

const router = express.Router()

// Base REST de OpenMRS (coherente con tu proxy)
const OPENMRS_REST = (process.env.OPENMRS_REST_URL || '').replace(/\/$/, '')
const OPENMRS_USER = process.env.OPENMRS_USER
const OPENMRS_PASS = process.env.OPENMRS_PASS

// Helper para parsear "Etiqueta: Valor"
const parseAttr = (display) => {
  const idx = (display || '').indexOf(':')
  if (idx === -1) return { label: (display || '').trim(), value: null }
  return {
    label: display.slice(0, idx).trim(),
    value: display.slice(idx + 1).trim()
  }
}

// Parser robusto de fechas → YYYY-MM-DD con tolerancia básica EN/ES
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  ene: 1, enero: 1, febr: 2, febrero: 2, marz: 3, marzo: 3,
  abr: 4, abril: 4, mayo: 5, junio: 6, jul: 7, julio: 7,
  ago: 8, agosto: 8, set: 9, septiem: 9, septiembre: 9,
  octubre: 10, noviem: 11, noviembre: 11, dic: 12, diciembre: 12
}

function toIsoDateYYYYMMDD(raw) {
  if (!raw) return undefined
  let v = String(raw).trim()

  // 1) ISO directo: 1974-12-24
  const iso = v.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  // 2) dd/mm/yyyy o dd-mm-yyyy
  const dmy = v.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/)
  if (dmy) {
    let d = dmy[1].padStart(2, '0')
    let m = dmy[2].padStart(2, '0')
    let y = dmy[3]
    if (y.length === 2) y = (Number(y) > 30 ? '19' : '20') + y
    if (Number(m) > 12) {
      const tmp = m
      m = d
      d = tmp
    }
    return `${y}-${m}-${d}`
  }

  // 3) “Dec 24 1974”, “Tue Dec 24 00:00:00 CLST 1974”, etc.
  const cleaned = v
    .replace(/CLST|CLT|UTC|GMT/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  const mmm = cleaned.match(/\b([A-Za-zÁÉÍÓÚÑ]{3,})\s+(\d{1,2}),?\s+(\d{4})\b/)
  if (mmm) {
    const tokenBase = mmm[1]
      .toLowerCase()
      .normalize('NFD')
      .replace(/[^a-z]/g, '')
    const candidates = [tokenBase, tokenBase.slice(0, 4), tokenBase.slice(0, 3)]
    const M = candidates.map(c => MONTHS[c]).find(Boolean)
    if (M) {
      const d = String(mmm[2]).padStart(2, '0')
      const m = String(M).padStart(2, '0')
      const y = mmm[3]
      return `${y}-${m}-${d}`
    }
  }

  // 4) Fallback a Date.parse
  const t = Date.parse(raw)
  if (!Number.isNaN(t)) {
    const d = new Date(t)
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10)
    }
  }

  return undefined
}

// Mapeo simple: practitioner_type → v2-0360|2.7
const PRACT_TYPE_TO_V20360 = {
  'Doctor':           { code: 'MD', display: 'Medical license number' },
  'Registered Nurse': { code: 'RN', display: 'Registered Nurse Number' }
}

router.get('/ips/practitioner/:providerUuid', async (req, res) => {
  try {
    const { providerUuid } = req.params
    if (!OPENMRS_REST) {
      return res.status(500).json({ error: 'OPENMRS_REST_URL no está definido en .env' })
    }

    // 1) Obtener Provider desde OpenMRS
    const provUrl = `${OPENMRS_REST}/provider/${providerUuid}?v=full`
    const auth = OPENMRS_USER ? { username: OPENMRS_USER, password: OPENMRS_PASS } : undefined
    const provResp = await axios.get(provUrl, { auth })
    const provider = provResp.data

  // 2) Usar únicamente el display del Provider para el nombre (evita privilegios extra)

    // 3) Construcción del Practitioner FHIR (IPS)
    const prac = {
      resourceType: 'Practitioner',
      id: provider.uuid,
      meta: { profile: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Practitioner-uv-ips'] },
      active: provider.retired === false
    }

    // 3.a) Identifiers (solo si existen en atributos). NO publicamos provider.identifier (LR).
    const identifiers = []

    for (const a of (provider.attributes || [])) {
      const { label, value } = parseAttr(a.display || '')
      if (!value) continue
      const L = label.toLowerCase()

      // PPN - Passport number (sistema/código fijos)
      if (L.startsWith('ppn') || L.includes('pasaporte')) {
        identifiers.push({
          use: 'official',
          type: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                code: 'PPN',
                display: 'Passport number'
              }
            ]
          },
          value
        })
      }

      // PRN - Provider number (sistema/código fijos)
      if (L.startsWith('prn') || L.includes('colegiomedico')) {
        identifiers.push({
          use: 'official',
          type: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                code: 'PRN',
                display: 'Provider number'
              }
            ]
          },
          value
        })
      }

      // NI (RUN/RUT) - National unique individual identifier (sistema/código fijos)
      if (L.startsWith('ni') || L.includes('run') || L.includes('rut')) {
        identifiers.push({
          use: 'official',
          type: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                code: 'NI',
                display: 'National unique individual identifier'
              }
            ]
          },
          value
        })
      }

      // Género
      if (L.startsWith('person.gender')) {
        const g = value.toLowerCase()
        prac.gender = ['male', 'female', 'other', 'unknown'].includes(g) ? g : 'unknown'
      }

      // Fecha de nacimiento
      if (L.startsWith('person.birthdate')) {
        const iso = toIsoDateYYYYMMDD(value)
        if (iso) prac.birthDate = iso
      }

      // Dirección (país)
      if (L.startsWith('address.country')) {
        const isChile = value.toLowerCase().includes('chile')
        const country = isChile ? 'CL' : value
        prac.address = [{ text: value, country }]
      }

      // Título profesional (qualification)
      if (L.startsWith('practitioner_type')) {
        const t = value.trim()
        const map = PRACT_TYPE_TO_V20360[t]
        if (map) {
          prac.qualification = [
            {
              code: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/v2-0360|2.7',
                    code: map.code,
                    display: map.display
                  }
                ]
              }
            }
          ]
        }
      }
    }

    if (identifiers.length > 0) {
      prac.identifier = identifiers
    }

    // 3.b) Nombre desde provider.person.display (fallback seguro sin privilegios adicionales)
    if (provider.person?.display) {
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
