import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import {
  registerMediator,
  activateHeartbeat,
  fetchConfig
} from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')

// 1) Construye tu configuración de OpenHIM antes de usarla
const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL:  process.env.OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
}

// 2) Soporte de configuración dinámica desde la UI
fetchConfig(openhimConfig).on('config', cfg => {
  console.log('🔄 Nueva configuración recibida:', cfg)
  // Aquí podrías actualizar timeouts, URLs, etc.
})

// 3) HTTPS agent para desarrollo
let httpsAgent
if (process.env.NODE_ENV === 'development') {
  httpsAgent = new https.Agent({ rejectUnauthorized: false })
  axios.defaults.httpsAgent = httpsAgent
  console.log('⚠️  MODO DEVELOPMENT: certificados self‑signed aceptados')
}

// 4) Registra el mediador y crea los canales
console.log('Intentando registrar FHIR Proxy en OpenHIM:', openhimConfig)
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Error registrando mediador:', err)
    process.exit(1)
  }
  console.log('✅ Mediador registrado correctamente')

  const channels = mediatorConfig.defaultChannelConfig || []
  Promise.all(channels.map(ch =>
    axios.post(
      `${openhimConfig.apiURL}/channels`,
      { ...ch, mediator_urn: mediatorConfig.urn },
      { auth: { username: openhimConfig.username, password: openhimConfig.password }, httpsAgent }
    )
    .then(() => console.log(`✅ Canal creado: ${ch.name}`))
    .catch(e => console.error(`❌ Error creando canal ${ch.name}:`, e.response?.data || e.message))
  ))
  .then(() => {
    console.log('✅ Todos los canales procesados')
    activateHeartbeat(openhimConfig)
  })
})

// 5) Express: health y proxy de FHIR
const app = express()
app.use(express.json({ limit: '20mb' }))

app.get('/_health', (_req, res) => res.status(200).send('OK'))

app.all('/fhir/*', async (req, res) => {
  const fhirPath  = req.originalUrl.replace(/^\/fhir/, '')
  const targetUrl = `${process.env.OPENMRS_FHIR_URL}${fhirPath}`
  console.log(`[PROXY] ${req.method} → ${targetUrl}`)

  try {
    const upstream = await axios({
      method: req.method,
      url:    targetUrl,
      data:   req.body,
      headers:{ ...req.headers, host: undefined },
      auth:   { username: process.env.OPENMRS_USER, password: process.env.OPENMRS_PASS },
      validateStatus: false
    })
    // limpia headers conflictivos
    const headers = { ...upstream.headers }
    delete headers['content-length']
    delete headers['transfer-encoding']

    res
      .status(upstream.status)
      .set(headers)
      .send(upstream.data)
  } catch (err) {
    console.error('🔥 FHIR Proxy Error:', err.message)
    res.status(502).json({ error: 'Proxy error', detail: err.message })
  }
})

const port = process.env.FHIRPROXY_PORT || 7000
app.listen(port, () => console.log(`FHIR Proxy listening on ${port}`))
