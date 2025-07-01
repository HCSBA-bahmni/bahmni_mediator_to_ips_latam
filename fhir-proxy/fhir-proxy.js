import express from 'express'
import axios from 'axios'
import 'dotenv/config'

const app = express()
app.use(express.json({ limit: '20mb' }))

const OPENMRS_FHIR = process.env.OPENMRS_HOST + '/openmrs/ws/fhir2/R4'
const OPENMRS_USER = process.env.OPENMRS_USER
const OPENMRS_PASS = process.env.OPENMRS_PASS

app.all('/fhir/*', async (req, res) => {
  const fhirPath = req.originalUrl.replace('/fhir', '')
  try {
    const openmrsRes = await axios({
      method: req.method,
      url: `${OPENMRS_FHIR}${fhirPath}`,
      headers: { ...req.headers, host: undefined },
      data: req.body,
      validateStatus: false,
      auth: OPENMRS_USER && OPENMRS_PASS
        ? { username: OPENMRS_USER, password: OPENMRS_PASS }
        : undefined
    })
    res.status(openmrsRes.status).set(openmrsRes.headers).send(openmrsRes.data)
  } catch (error) {
    res.status(502).json({ error: 'Proxy error', detail: error.message })
  }
})

app.listen(process.env.FHIRPROXY_PORT || 5000, () =>
  console.log('FHIR Proxy listening on', process.env.FHIRPROXY_PORT || 5000)
)
