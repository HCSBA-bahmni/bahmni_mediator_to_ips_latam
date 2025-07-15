// index.js (FHIR Event Forwarder Mediator)
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import { registerMediator } from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')

// --- HTTPS agent para desarrollo con certificados self-signed ---
let httpsAgent = undefined
if (process.env.NODE_ENV === 'development') {
  httpsAgent = new https.Agent({ rejectUnauthorized: false })
  axios.defaults.httpsAgent = httpsAgent
  console.log('⚠️  MODO DEVELOPMENT: Certificados self-signed aceptados')
} else {
  console.log('🟢 MODO PRODUCTION: Solo certificados SSL válidos')
}

// — Configuración fija para apuntar a tu OpenHIM —
const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL: process.env.OPENHIM_API || 'http://10.68.174.206:8080',
  trustSelfSigned: true
}

// Registro en OpenHIM
// 1) Registro el mediador (sin canales automáticos)
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Error registrando mediador:', err)
    process.exit(1)
  }
  console.log('✅ Mediador registrado correctamente')

  // 2) Creo los canales definidos en defaultChannelConfig
  const channels = mediatorConfig.defaultChannelConfig || []
  Promise.all(channels.map(ch =>
    axios.post(
      `${openhimConfig.apiURL}/channels`,
      {
        ...ch,
        mediator_urn: mediatorConfig.urn
      },
      {
        auth: {
          username: openhimConfig.username,
          password: openhimConfig.password
        },
        httpsAgent
      }
    )
    .then(() => console.log(`✅ Canal creado: ${ch.name}`))
    .catch(e => console.error(`❌ Error creando canal ${ch.name}:`, e.response?.data || e.message))
  ))
  .then(() => console.log('✅ Todos los canales procesados'))
})

const app = express()
app.use(express.json({ limit: '20mb' }))

const FHIR_PROXY    = process.env.FHIR_PROXY_URL   // ej: http://10.68.174.206:8080/fhir-proxy-mediator
const FHIR_NODE_URL = process.env.FHIR_NODE_URL    // ej: http://10.68.174.206:8080/openmrs-fhir-channel
const MAX_RETRIES   = 3

// — Healthcheck endpoint para heartbeats —
app.get('/_health', (_req, res) => res.status(200).send('OK'))

// Persistencia de eventos ya vistos
const SEEN_FILE = './seen.json'
let seen = new Set()
try {
  if (fs.existsSync(SEEN_FILE)) {
    seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE)))
  }
} catch (e) {
  console.warn('No se pudo leer seen.json, se creará uno nuevo.')
}
function saveSeen() {
  fs.writeFile(SEEN_FILE, JSON.stringify([...seen]), err => {
    if (err) console.error('❌ Error guardando seen.json:', err)
  })
}

// Función genérica de reintento
async function retryRequest(fn, maxRetries = MAX_RETRIES) {
  let attempt = 0, lastErr
  while (attempt < maxRetries) {
    try { return await fn() }
    catch (err) {
      lastErr = err; attempt++
      const wait = 500 * attempt
      console.warn(`⏳ Retry ${attempt}/${maxRetries} tras error:`, err.message)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw lastErr
}

function logStep(msg, ...data) {
  console.log(new Date().toISOString(), msg, ...data)
}

async function getFromProxy(path) {
  const url = `${FHIR_PROXY}/fhir${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, { validateStatus: false })
  return resp.data
}

async function putToNode(resource) {
  const url = `${FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  return retryRequest(async () => {
    logStep('PUT (node)', url)
    const resp = await axios.put(url, resource, {
      headers: { 'Content-Type': 'application/fhir+json' }
    })
    logStep('✅ PUT OK', resource.resourceType, resource.id, resp.status)
    return resp.status
  })
}

// Endpoint principal: recibe { uuid } y reenvía Encounter, Patient y recursos relacionados
app.post('/event', async (req, res) => {
  const { uuid } = req.body
  logStep('📩 POST /event', req.body)

  if (!uuid) return res.status(400).json({ error: 'Falta uuid' })
  if (seen.has(uuid)) {
    logStep('🔁 Evento duplicado, ignorado', uuid)
    return res.status(200).json({ status: 'duplicado', uuid })
  }

  seen.add(uuid); saveSeen()
  logStep('🔔 Procesando nuevo evento', uuid)

  const results = []
  try {
    // 1. Encounter
    const encounter = await getFromProxy(`/Encounter/${uuid}`)
    results.push(await putToNode(encounter))

    // 2. Patient
    const patientId = encounter.subject?.reference?.split('/').pop()
    if (patientId) {
      const patient = await getFromProxy(`/Patient/${patientId}`)
      results.push(await putToNode(patient))
    }

    // 3. Recursos relacionados
    const resourceQueries = [
      'Observation','Condition','Procedure','MedicationRequest',
      'Medication','AllergyIntolerance','DiagnosticReport',
      'Immunization','CarePlan','Appointment','DocumentReference'
    ]
    for (const type of resourceQueries) {
      const bundle = await getFromProxy(`/${type}?encounter=${uuid}`)
      if (bundle.entry) {
        for (const entry of bundle.entry) {
          results.push(await putToNode(entry.resource))
        }
      }
    }

    logStep('🎉 Proceso completado', uuid)
    res.json({ status: 'ok', uuid, sent: results.length })
  } catch (err) {
    logStep('❌ ERROR en procesamiento:', err.message)
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.FORWARDER_MEDIATOR_PORT || 8003
app.listen(PORT, () => {
  logStep(`FHIR Forwarder listening on port ${PORT}`)
})
