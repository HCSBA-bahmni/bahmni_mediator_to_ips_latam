import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import { registerMediator } from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')

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

console.log('Intentando registrar FHIR Proxy en OpenHIM:', openhimConfig)

registerMediator(
  openhimConfig,
  mediatorConfig,
  // Le indicamos que registre canales y endpoints
  { registerChannels: true, registerEndpoints: true },
  err => {
     if (err) {
       console.error('❌ Error registrando mediador y canales:', err)
       process.exit(1)
     }
     console.log('✅ Mediador, endpoints y canales registrados correctamente en OpenHIM')
   }
 )




const app = express()
app.use(express.json({ limit: '20mb' }))

const OPENMRS_FHIR = process.env.OPENMRS_FHIR_URL
const USER = process.env.OPENMRS_USER
const PASS = process.env.OPENMRS_PASS



// ––– Endpoint de healthcheck para heartbeats –––
app.get('/_health', (_req, res) => res.status(200).send('OK'))
// ––– Endpoint de healthcheck para heartbeats –––

app.all('/fhir/*', async (req, res) => {
  const fhirPath = req.originalUrl.replace('/fhir', '')
  const targetUrl = `${OPENMRS_FHIR}${fhirPath}`
  console.log(`[PROXY] ${req.method} → ${targetUrl}`)

  try {
    const openmrsRes = await axios({
      method: req.method,
      url: targetUrl,
      headers: { ...req.headers, host: undefined },
      data: req.body,
      auth: USER ? { username: USER, password: PASS } : undefined,
      validateStatus: false
    })

    // Limpia headers conflictivos (especial OpenMRS bug)
    const headers = { ...openmrsRes.headers }
    delete headers['content-length']
    delete headers['Content-Length']
    delete headers['transfer-encoding']
    delete headers['Transfer-Encoding']

    // Si el body viene como string y parece JSON, parsea
    let data = openmrsRes.data
    if (typeof data === 'string' && data.trim().startsWith('{')) {
      try { data = JSON.parse(data) } catch {}
    }

    res.status(openmrsRes.status).set(headers).send(data)
  } catch (error) {
    // Maneja errores de "Parse Error: Content-Length can't be present with Transfer-Encoding"
    if (
      error.message &&
      error.message.includes("Content-Length can't be present with Transfer-Encoding")
    ) {
      console.error('🔥 FHIR Proxy Error: Header conflict OpenMRS. Devolviendo 502.', error.message)
      return res.status(502).json({
        error: 'Proxy error',
        detail: 'OpenMRS devolvió headers HTTP conflictivos (Content-Length y Transfer-Encoding).',
        raw: error.message
      })
    }
    // Otros errores
    console.error('FHIR Proxy Error:', error.message)
    res.status(502).json({ error: 'Proxy error', detail: error.message })
  }
})

const port = process.env.FHIRPROXY_PORT || 7000
app.listen(port, () =>
  console.log('FHIR Proxy listening on', port)
)
