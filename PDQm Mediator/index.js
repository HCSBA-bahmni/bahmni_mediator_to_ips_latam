// PDQm Mediator (pdqm-mediator/index.js)
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');
const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  PDQM_FHIR_URL,
  NODE_ENV
} = process.env;

const openhimConfig = {
  username: OPENHIM_USER,
  password: OPENHIM_PASS,
  apiURL: OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
};

if (NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('⚠️ DEV MODE: self‑signed certs accepted');
}

registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err);
    process.exit(1);
  }
  activateHeartbeat(openhimConfig);
});

const app = express();
app.use(express.json());

// ITI‑78 PDQm lookup
app.post('/pdqm/_lookup', async (req, res) => {
  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Missing identifier' });
  try {
    const resp = await axios.get(
      `${PDQM_FHIR_URL}/Patient`,
      { params: { identifier }, httpsAgent: axios.defaults.httpsAgent }
    );
    return res.json(resp.data);
  } catch (e) {
    console.error('❌ ERROR PDQm lookup:', e.message);
    return res.status(502).json({ error: e.message });
  }
});

const PORT_PDQM = process.env.PDQM_PORT || 8001;
app.listen(PORT_PDQM, () => console.log(`PDQm Mediator listening on port ${PORT_PDQM}`));
