import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import { registerMediator } from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')

const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL: process.env.OPENHIM_API,
  trustSelfSigned: true
}

console.log('Intentando registrar FHIR Proxy en OpenHIM:', openhimConfig)

registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('Failed to register FHIR proxy mediator:', err)
    process.exit(1)
  }
  console.log('FHIR proxy mediator registered successfully!')
})

const app = express()
app.use(express.json({ limit: '20mb' }))

const OPENMRS_FHIR = process.env.OPENMRS_FHIR_URL
const USER = process.env.OPENMRS_USER
const PASS = process.env.OPENMRS_PASS

app.all('/fhir/*', async (req, res) => {
  const fhirPath = req.originalUrl.replace('/fhir', '')
  try {
    const openmrsRes = await axios({
      method: req.method,
      url: `${OPENMRS_FHIR}${fhirPath}`,
      headers: { ...req.headers, host: undefined },
      data: req.body,
      auth: USER ? { username: USER, password: PASS } : undefined,
      validateStatus: false
    })
    res.status(openmrsRes.status).set(openmrsRes.headers).send(openmrsRes.data)
  } catch (error) {
    res.status(502).json({ error: 'Proxy error', detail: error.message })
  }
})

const port = process.env.FHIRPROXY_PORT || 7000
app.listen(port, () => 
  console.log('FHIR Proxy listening on', port)
)
