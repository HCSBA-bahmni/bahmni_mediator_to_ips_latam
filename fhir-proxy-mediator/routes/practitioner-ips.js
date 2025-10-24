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

// Mapeo simple: practitioner_type → v2-0360|2.7
const PRACT_TYPE_TO_V20360 = {
  'Doctor':           { code: 'MD', display: 'Doctor of Medicine' },
  'Registered Nurse': { code: 'RN', display: 'Registered Nurse' }
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
      meta: { profile: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Practitioner-uv-ips'] }
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
        const d = new Date(value)
        if (!isNaN(d)) prac.birthDate = d.toISOString().slice(0, 10)
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
