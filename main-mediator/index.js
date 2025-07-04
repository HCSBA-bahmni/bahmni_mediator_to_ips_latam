'use strict'
import express from 'express'
import axios from 'axios'
import { registerMediator } from 'openhim-mediator-utils'
import mediatorConfig from './mediatorConfig.json'

const OPENMRS_FHIR_BASE = 'https://<openmrs_host>/openmrs/ws/fhir2/R4'
const FHIR_SERVER_DEST = 'https://<fhir_dest_host>/fhir/Bundle'

// OpenHIM registration (ajusta credenciales)
const openhimConfig = {
  username: 'root@openhim.org',
  password: '1234',
  apiURL: 'https://<openhim_api>:8080',
  trustSelfSigned: true
}
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) throw new Error(`Failed to register mediator. ${err}`)
})

const app = express()
app.use(express.json({ limit: '10mb' }))

app.post('/entryfeed', async (req, res) => {
  try {
    const { uuid } = req.body
    // 1. Cargar Encounter FHIR
    const encounterRes = await axios.get(`${OPENMRS_FHIR_BASE}/Encounter/${uuid}`, {validateStatus: false})
    if (encounterRes.status !== 200) return res.status(404).json({error: 'Encounter not found'})
    const encounter = encounterRes.data

    // 2. Cargar Patient (desde Encounter.subject)
    const patientRef = encounter.subject?.reference // "Patient/<id>"
    if (!patientRef) return res.status(400).json({error: 'No patient in encounter'})
    const patientId = patientRef.split('/')[1]
    const patientRes = await axios.get(`${OPENMRS_FHIR_BASE}/Patient/${patientId}`)
    const patient = patientRes.data

    // 3. Cargar DocumentReference relacionado (opcional, solo si usas DocumentReference en OpenMRS)
    // const docRefRes = await axios.get(`${OPENMRS_FHIR_BASE}/DocumentReference?encounter=${uuid}`)
    // const docRefs = docRefRes.data.entry?.map(e => e.resource) || []

    // 4. Cargar Observations y Conditions (relacionadas al encounter)
    const obsRes = await axios.get(`${OPENMRS_FHIR_BASE}/Observation?encounter=${uuid}`)
    const conditionsRes = await axios.get(`${OPENMRS_FHIR_BASE}/Condition?encounter=${uuid}`)
    const observations = obsRes.data.entry?.map(e => e.resource) || []
    const conditions = conditionsRes.data.entry?.map(e => e.resource) || []

    // 5. Construir bundle ITI-65
    const bundle = buildITI65({encounter, patient, observations, conditions})

    // 6. Enviar bundle al servidor FHIR de destino
    const sendRes = await axios.post(FHIR_SERVER_DEST, bundle, {
      headers: { 'Content-Type': 'application/fhir+json' }
    })

    res.status(200).json({result: 'OK', fhir_response: sendRes.data})
  } catch (error) {
    console.error(error)
    res.status(500).json({error: error.message, stack: error.stack})
  }
})

// --- Construcción de Bundle ITI-65 ---
function buildITI65({encounter, patient, observations, conditions}) {
  // Basado en tu ITI-65-IPSLAC.json, adapta los IDs y referencias según tus datos
  return {
    "resourceType": "Bundle",
    "type": "transaction",
    "entry": [
      {
        "fullUrl": `urn:uuid:${patient.id}`,
        "resource": patient,
        "request": {"method": "POST", "url": "Patient"}
      },
      {
        "fullUrl": `urn:uuid:${encounter.id}`,
        "resource": encounter,
        "request": {"method": "POST", "url": "Encounter"}
      },
      // Agrega condiciones como Condition resources (ejemplo)
      ...conditions.map(cond => ({
        "fullUrl": `urn:uuid:${cond.id}`,
        "resource": cond,
        "request": {"method": "POST", "url": "Condition"}
      })),
      // Agrega observaciones como Observation resources (opcional)
      ...observations.map(obs => ({
        "fullUrl": `urn:uuid:${obs.id}`,
        "resource": obs,
        "request": {"method": "POST", "url": "Observation"}
      })),
      // Si tienes DocumentReference, inclúyelo aquí de manera similar
    ]
  }
}

app.listen(4000, () => console.log('OpenHIM Mediator /entryfeed listening on 4000'))
