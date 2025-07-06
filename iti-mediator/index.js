import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import { registerMediator } from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./itiConfig.json')

// --- Setup global HTTPS agent solo en development ---
let httpsAgent = undefined
if (process.env.NODE_ENV === 'development') {
  httpsAgent = new https.Agent({ rejectUnauthorized: false })
  axios.defaults.httpsAgent = httpsAgent
  console.log('⚠️  MODO DEVELOPMENT: Se aceptan certificados self-signed (NO USAR en producción)')
} else {
  // En producción, NO parchea el agente: Axios usará validación SSL normal.
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

// ITI-65: Recibe evento y construye/transmite IPS
app.post('/event', async (req, res) => {
  try {
    const { uuid } = req.body
    const encounter = await getEncounter(uuid)
    const patient = await getPatientPDQm(encounter.patient.uuid)
    const translatedResources = await translateConcepts(encounter)
    const ipsBundle = buildIPSBundle({ encounter, patient, translatedResources })
    const validation = await validateWithGazelle(ipsBundle)
    if (!validation.isValid) return res.status(400).json({ error: 'IPS no válido en Gazelle', validation })
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
  // Aquí, NO necesitas el agent, ya se define global si corresponde
  const res = await axios.get(url)
  return res.data
}

async function getPatientPDQm(patientUuid) {
  const url = `${process.env.PDQM_URL}/fhir/Patient/$pdqm?identifier=${patientUuid}`
  const res = await axios.get(url)
  return res.data.entry?.[0]?.resource || {}
}

async function translateConcepts(encounter) {
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

function buildIPSBundle({ encounter, patient, translatedResources }) {
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
