import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import { registerMediator } from 'openhim-mediator-utils'
import { createRequire } from 'module'
import fs from 'fs'    // <-- Cambio aquí: importación moderna de fs/ lo dejare solo en debug.

const require = createRequire(import.meta.url)
const mediatorConfig = require('./itiConfig.json')

// --- Setup global HTTPS agent solo en development ---
let httpsAgent = undefined
if (process.env.NODE_ENV === 'development') {
  httpsAgent = new https.Agent({ rejectUnauthorized: false })
  axios.defaults.httpsAgent = httpsAgent
  console.log('⚠️  MODO DEVELOPMENT: Se aceptan certificados self-signed (NO USAR en producción)')
} else {
  console.log('🟢 MODO PRODUCTION: Solo se aceptan certificados SSL válidos')
}

const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL: process.env.OPENHIM_API,
  trustSelfSigned: true
}

console.log('Intentando registrar mediador en OpenHIM:', openhimConfig)

registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('Failed to register mediator:', err)
    process.exit(1)
  }
  console.log('Mediator registered successfully!')
})

const app = express()
app.use(express.json({ limit: '15mb' }))

const FHIR_PROXY = process.env.FHIR_PROXY_URL || 'http://proxy-mediator:7000'

// ================== FLUJO PRINCIPAL =====================
app.post('/event', async (req, res) => {
  try {
    const { uuid } = req.body
    // 1. Obtener Encounter
    const encounter = await getEncounterFHIR(uuid)
    console.log('🔎 [LOG] Respuesta Encounter:', JSON.stringify(encounter, null, 2))
    if (!encounter) {
      console.error('❌ [ERROR] Encounter recibido es null o undefined')
      return res.status(404).json({ error: 'No se encontró Encounter (null)' })
    }
    if (!encounter.subject) {
      console.error('❌ [ERROR] Encounter encontrado pero falta subject')
      return res.status(404).json({ error: 'No se encontró subject en Encounter' })
    }
    const patientId = encounter.subject.reference.split('/')[1]


    // 2. Obtener recursos IPS (por paciente)
    const [patient, observations, conditions, allergies, medications, immunizations, procedures, documents] =
      await Promise.all([
        getPatientFHIR(patientId),
        getObservationsFHIR(patientId),
        getConditionsFHIR(patientId),
        getAllergiesFHIR(patientId),
        getMedicationsFHIR(patientId),
        getImmunizationsFHIR(patientId),
        getProceduresFHIR(patientId),
        getDocumentReferencesFHIR(patientId)
      ])
    // 3. Filtrar los recursos vacíos (entry solo con datos)
    const entries = [
      patient ? toEntry(patient, 'Patient') : null,
      encounter ? toEntry(encounter, 'Encounter') : null,
      ...observations.map(r => toEntry(r, 'Observation')),
      ...conditions.map(r => toEntry(r, 'Condition')),
      ...allergies.map(r => toEntry(r, 'AllergyIntolerance')),
      ...medications.map(r => toEntry(r, 'MedicationStatement')),
      ...immunizations.map(r => toEntry(r, 'Immunization')),
      ...procedures.map(r => toEntry(r, 'Procedure')),
      ...documents.map(r => toEntry(r, 'DocumentReference'))
    ].filter(Boolean)
    // 4. Construir el Bundle IPS
    const ipsBundle = {
      resourceType: 'Bundle',
      type: 'document',
      entry: entries
    }

    // 5. Guardar JSON en archivo para debug (asegura carpeta), sacar este bloque en producción
    const debugDir = 'debug'
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true })
    }
    fs.writeFileSync(`${debugDir}/ipsBundle.json`, JSON.stringify(ipsBundle, null, 2))

    // 6. Validar y enviar
    //const validation = await validateWithGazelle(ipsBundle)
    //if (!validation.isValid) return res.status(400).json({ error: 'IPS no válido en Gazelle', validation })
    console.log('--- Bundle IPS generado ---\n', JSON.stringify(ipsBundle, null, 2));
    const iti65Result = await sendITI65(ipsBundle)
    res.status(201).json({ result: 'ITI-65 enviado', iti65Result })
  } catch (e) {
    console.error('❌ [EXCEPTION] Error en /event:', e)
    res.status(500).json({ error: e.message })
  }
})

// ================= FUNCIONES FHIR VIA PROXY ===================
async function getPatientFHIR(patientId) {
  if (!patientId) return null
  try {
    const res = await axios.get(`${FHIR_PROXY}/fhir/Patient/${patientId}`)
    return isResourceValid(res.data, 'Patient') ? res.data : null
  } catch (err) {
    console.error('[ERROR] getPatientFHIR:', err.message)
    return null
  }
}

// AGREGADO DEBUG INTENSIVO AQUÍ:
async function getEncounterFHIR(encounterId) {
  if (!encounterId) return null
  try {
    const url = `${FHIR_PROXY}/fhir/Encounter/${encounterId}`
    console.log('🔎 [DEBUG] GET', url)
    const res = await axios.get(url)
    console.log('🔎 [DEBUG] STATUS', res.status)
    console.log('🔎 [DEBUG] HEADERS', JSON.stringify(res.headers))
    console.log('🔎 [DEBUG] DATA', JSON.stringify(res.data, null, 2))
    return isResourceValid(res.data, 'Encounter') ? res.data : null
  } catch (err) {
    console.error('❌ [ERROR] getEncounterFHIR:', err.message)
    return null
  }
}

async function getObservationsFHIR(patientId) {
  return await getListResources(`${FHIR_PROXY}/fhir/Observation?patient=${patientId}`, 'Observation')
}
async function getConditionsFHIR(patientId) {
  return await getListResources(`${FHIR_PROXY}/fhir/Condition?patient=${patientId}`, 'Condition')
}
async function getAllergiesFHIR(patientId) {
  return await getListResources(`${FHIR_PROXY}/fhir/AllergyIntolerance?patient=${patientId}`, 'AllergyIntolerance')
}
async function getMedicationsFHIR(patientId) {
  return await getListResources(`${FHIR_PROXY}/fhir/MedicationStatement?patient=${patientId}`, 'MedicationStatement')
}
async function getImmunizationsFHIR(patientId) {
  return await getListResources(`${FHIR_PROXY}/fhir/Immunization?patient=${patientId}`, 'Immunization')
}
async function getProceduresFHIR(patientId) {
  return await getListResources(`${FHIR_PROXY}/fhir/Procedure?patient=${patientId}`, 'Procedure')
}
async function getDocumentReferencesFHIR(patientId) {
  return await getListResources(`${FHIR_PROXY}/fhir/DocumentReference?patient=${patientId}`, 'DocumentReference')
}

async function getListResources(url, resourceType) {
  try {
    const res = await axios.get(url)
    return (res.data.entry || [])
      .map(e => e.resource)
      .filter(r => isResourceValid(r, resourceType))
  } catch {
    return []
  }
}

// ==== Helper para evitar recursos vacíos (personaliza según tu modelo) ====
function isResourceValid(resource, type) {
  if (!resource || resource.resourceType !== type) return false
  if (type === 'Patient' && !resource.id) return false
  if (type === 'Encounter' && !resource.id) return false
  if (type === 'Observation' && !(resource.valueQuantity || resource.valueCodeableConcept || resource.valueString)) return false
  if (type === 'Condition' && !resource.code) return false
  if (type === 'AllergyIntolerance' && !resource.code) return false
  if (type === 'MedicationStatement' && !resource.medicationCodeableConcept && !resource.medicationReference) return false
  if (type === 'Immunization' && !resource.vaccineCode) return false
  if (type === 'Procedure' && !resource.code) return false
  if (type === 'DocumentReference' && !resource.content) return false
  return true
}

function toEntry(resource, type) {
  return {
    fullUrl: `urn:uuid:${resource.id}`,
    resource,
    request: { method: 'POST', url: type }
  }
}

// =================== OTROS ENDPOINTS (ejemplo original) ===============
app.get('/iti67', async (req, res) => {
  try {
    const { patientIdentifier } = req.query
    const url = `${process.env.FHIR_NODE_URL}/fhir/DocumentReference?patient.identifier=${encodeURIComponent(patientIdentifier)}`
    const response = await axios.get(url)
    res.json(response.data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/iti68', async (req, res) => {
  try {
    const { bundleId } = req.query
    const url = `${process.env.FHIR_NODE_URL}/fhir/Bundle/${encodeURIComponent(bundleId)}`
    const response = await axios.get(url)
    res.json(response.data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// =============== FUNCIONES DE ENVÍO ======================
async function validateWithGazelle(bundle) {
  const res = await axios.post(process.env.GAZELLE_URL, bundle)
  return res.data
}

async function sendITI65(bundle) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/Bundle`
  const res = await axios.post(url, bundle, { headers: { 'Content-Type': 'application/fhir+json' } })
  return res.data
}

app.listen(process.env.ITI_PORT || 5000, () => {
  console.log('ITI Mediator listening on port', process.env.ITI_PORT || 5000)
})
