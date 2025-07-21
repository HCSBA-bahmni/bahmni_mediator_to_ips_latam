// VHL Generator Mediator (vhl-mediator/index.js)
import express from 'express';
import axios from 'axios';
import 'dotenv/config';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';

const require3 = createRequire(import.meta.url);
const mediatorConfig3 = require3('./mediatorConfig.json');
const {
  OPENHIM_USER: V_USER,
  OPENHIM_PASS: V_PASS,
  OPENHIM_API: V_API,
  VHL_API_URL,
  NODE_ENV: V_ENV
} = process.env;

const openhimConfig3 = {
  username: V_USER,
  password: V_PASS,
  apiURL: V_API,
  trustSelfSigned: true,
  urn: mediatorConfig3.urn
};
if (V_ENV === 'development') axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
registerMediator(openhimConfig3, mediatorConfig3, err => { if (err) { console.error(err); process.exit(1); } activateHeartbeat(openhimConfig3); });

const appV = express();
appV.use(express.json({ limit: '20mb' }));

// Generate VHL
appV.post('/vhl/_generate', async (req, res) => {
  const bundle = req.body;
  if (!bundle) return res.status(400).json({ error: 'Missing IPS bundle' });
  try {
    const resp = await axios.post(
      `${VHL_API_URL}/generate`,
      bundle,
      { headers: { 'Content-Type': 'application/fhir+json' } }
    );
    return res.json(resp.data);
  } catch (e) {
    console.error('❌ ERROR generating VHL:', e.message);
    return res.status(502).json({ error: e.message });
  }
});

const PORT_VHL = process.env.VHL_PORT || 8003;
appV.listen(PORT_VHL, () => console.log(`VHL Mediator listening on port ${PORT_VHL}`));
