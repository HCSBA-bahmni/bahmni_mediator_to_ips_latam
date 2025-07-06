import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import { registerMediator } from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./itiConfig.json')  // O el nombre de tu config

const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL: process.env.OPENHIM_API,
  trustSelfSigned: true
}

// Agrega este log:
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

// ITI-65: Recibe evento y construye/transmite IPS
app.post('/event', async (req, res) => {
  try {
    const { uuid } = req.body
    // 1. Consulta Encounter en OpenMRS
    const encounter = await getEncounter(uuid)
    // 2. Consulta paciente vía PDQm (ITI-78)
    const patient = await getPatientPDQm(encounter.patient.uuid)
    // 3. Traduce conceptos (diagnóstico, vacunas, etc.) usando Snowstorm (ITI-101)
    const translatedResources = await translateConcepts(encounter)
    // 4. Construye el IPS-LACPASS
    const ipsBundle = buildIPSBundle({ encounter, patient, translatedResources })
    // 5. (Opcional) Valida con Gazelle
    const validation = await validateWithGazelle(ipsBundle)
    if (!validation.isValid) return res.status(400).json({ error: 'IPS no válido en Gazelle', validation })
    // 6. Envia IPS via ITI-65 a FHIR nacional
    const iti65Result = await sendITI65(ipsBundle)
    res.status(201).json({ result: 'ITI-65 enviado', iti65Result })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// ITI-67: GET /iti67?patientIdentifier=...
app.get('/iti67', async (req, res) => {
  try {
    const { patientIdentifier } = req.query
    // Consulta a Broadcast/DocumentReference según guía
    const url = `${process.env.FHIR_NODE_URL}/fhir/DocumentReference?patient.identifier=${encodeURIComponent(patientIdentifier)}`
    const response = await axios.get(url)
    res.json(response.data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ITI-68: GET /iti68?bundleId=...
app.get('/iti68', async (req, res) => {
  try {
    const { bundleId } = req.query
    // Consulta a nodo nacional u otro nodo registrado
    const url = `${process.env.FHIR_NODE_URL}/fhir/Bundle/${encodeURIComponent(bundleId)}`
    const response = await axios.get(url)
    res.json(response.data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// --- Funciones auxiliares modulares ---

async function getEncounter(uuid) {
  const url = `${process.env.OPENMRS_URL}/openmrs/ws/rest/v1/bahmnicore/bahmniencounter/${uuid}?includeAll=true`
  const res = await axios.get(url)
  return res.data
}

async function getPatientPDQm(patientUuid) {
  const url = `${process.env.PDQM_URL}/fhir/Patient/$pdqm?identifier=${patientUuid}`
  const res = await axios.get(url)
  return res.data.entry?.[0]?.resource || {}
}

async function translateConcepts(encounter) {
  // Puedes expandir a vacunas, diagnósticos, etc. según encounterData.obs
  const result = []
  for (const obs of (encounter.obs || [])) {
    const translateUrl = `${process.env.SNOWSTORM_URL}/fhir/ConceptMap/$translate?code=${obs.concept}&system=http://snomed.info/sct`
    try {
      const translation = await axios.get(translateUrl)
      result.push(translation.data)
    } catch (e) {
      console.error('Error traduciendo concepto', obs.concept, e.message)
    }
  }
  return result
}

// Construcción de bundle IPS-LACPASS (transaccional ITI-65)
function buildIPSBundle({ encounter, patient, translatedResources }) {
  // Debes modelar el Bundle según la [guía LACPASS y los ejemplos de IPS](https://github.com/RACSEL/IPS-national-backend/blob/master/examples/ips-sample5.json)
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      // Ejemplo: List, DocumentReference, Bundle (type document), Patient, etc.
      // Debes armar cada uno con request { method, url } como especifica ITI-65
    ]
  }
}

async function validateWithGazelle(bundle) {
  // Gazelle normalmente es manual, aquí se asume un endpoint de validación automática para simplificar
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
