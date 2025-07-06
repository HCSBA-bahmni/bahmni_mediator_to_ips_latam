import 'dotenv/config'
import express from 'express'
import axios from 'axios'

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

app.listen(process.env.FHIRPROXY_PORT || 7000, () => 
  console.log('FHIR Proxy listening on', process.env.FHIRPROXY_PORT || 7000)
)
