// fhir-proxy.js (OpenMRS FHIR Proxy Mediator)
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')
import practitionerRouter from './routes/practitioner-ips.js'

// --- OpenHIM config ---
const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL:   process.env.OPENHIM_API,
  trustSelfSigned: true,
  urn:      mediatorConfig.urn
}

// HTTPS agent for development (self-signed)
if (process.env.NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false })
  console.log('⚠️  DEV MODE: self-signed certs accepted')
} else {
  console.log('🟢 PROD MODE: only valid SSL certs')
}

// 1) Register mediator & channels, then start heartbeat
console.log('Registering FHIR Proxy Mediator in OpenHIM:', openhimConfig)
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Error registering mediator:', err)
    process.exit(1)
  }
  console.log('✅ Mediator registered correctly')

  const channels = mediatorConfig.defaultChannelConfig || []
  Promise.all(channels.map(ch =>
    axios.post(
      `${openhimConfig.apiURL}/channels`,
      { ...ch, mediator_urn: mediatorConfig.urn },
      { auth: { username: openhimConfig.username, password: openhimConfig.password } }
    )
    .then(() => console.log(`✅ Channel created: ${ch.name}`))
    .catch(e => console.error(`❌ Error creating channel ${ch.name}:`, e.response?.data || e.message))
  ))
  .then(() => {
    console.log('✅ All channels processed')
    activateHeartbeat(openhimConfig)
  })
})

// 2) Express setup
const app = express()
app.use(express.json({ limit: '20mb' }))

// 3) Health endpoints
const healthPaths = ['/_health', '/proxy/_health']
healthPaths.forEach(path => {
  app.get(path, (_req, res) => res.status(200).send('OK'))
})

// 3.1) IPS route: Provider → Practitioner (FHIR IPS)
app.use(practitionerRouter)

// 3.2) Override Practitioner reads to deliver IPS representation by default
app.use(['/fhir/Practitioner/:id', '/proxy/fhir/Practitioner/:id'], async (req, res, next) => {
  try {
    if (req.query.native === '1') return next()
    const id = req.params.id
    const selfBase = `http://127.0.0.1:${process.env.FHIRPROXY_PORT || 7000}`
    const upstream = await axios.get(`${selfBase}/ips/practitioner/${id}`)
    return res.status(200).json(upstream.data)
  } catch (err) {
    console.error('❌ IPS default override error:', err?.response?.data || err.message)
    return next()
  }
})

// 4) FHIR proxy: support /fhir/* and /proxy/fhir/*
const OPENMRS_FHIR = process.env.OPENMRS_FHIR_URL
const OPENMRS_USER = process.env.OPENMRS_USER
const OPENMRS_PASS = process.env.OPENMRS_PASS

app.all(['/fhir/*', '/proxy/fhir/*'], async (req, res) => {
  // If called via /proxy/fhir, rewrite to /fhir
  const cleanPath = req.originalUrl.replace(/^\/proxy\/fhir/, '/fhir')
  const fhirPath  = cleanPath.replace(/^\/fhir/, '')
  const targetUrl = `${OPENMRS_FHIR}${fhirPath}`

  console.log(`[PROXY] ${req.method} → ${targetUrl}`)
  try {
    const upstream = await axios({
      method: req.method,
      url:    targetUrl,
      data:   req.body,
      headers:{ ...req.headers, host: undefined },
      auth:   OPENMRS_USER ? { username: OPENMRS_USER, password: OPENMRS_PASS } : undefined,
      validateStatus: false
    })

    // Remove conflicting headers
    const headers = { ...upstream.headers }
    delete headers['content-length']
    delete headers['transfer-encoding']

    // Parse JSON string bodies
    let data = upstream.data
    if (typeof data === 'string' && data.trim().startsWith('{')) {
      try { data = JSON.parse(data) } catch {}
    }

    res.status(upstream.status).set(headers).send(data)
  } catch (err) {
    console.error('🔥 FHIR Proxy Error:', err.message)
    // Specific OpenMRS header conflict case
    if (err.message.includes("Content-Length can't be present with Transfer-Encoding")) {
      return res.status(502).json({
        error: 'Proxy error',
        detail: 'Header conflict from OpenMRS (Content-Length & Transfer-Encoding).',
        raw: err.message
      })
    }
    res.status(502).json({ error: 'Proxy error', detail: err.message })
  }
})

// 5) Start server
const PORT = process.env.FHIRPROXY_PORT || 7000
app.listen(PORT, () => {
  console.log(`FHIR Proxy listening on port ${PORT}`)
})
