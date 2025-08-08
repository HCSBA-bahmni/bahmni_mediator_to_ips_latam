// Terminology Validation Mediator (termino-mediator/index.js)
import express from 'express';
import axios from 'axios';
import 'dotenv/config';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';
import https from 'https';

const require2 = createRequire(import.meta.url);
const mediatorConfig2 = require2('./mediatorConfig.json');
const {
  OPENHIM_USER: T_USER,
  OPENHIM_PASS: T_PASS,
  OPENHIM_API: T_API,
  TERMINO_SERVER_URL,
  NODE_ENV: T_ENV
} = process.env;

const openhimConfig2 = {
  username: T_USER,
  password: T_PASS,
  apiURL: T_API,
  trustSelfSigned: true,
  urn: mediatorConfig2.urn
};
if (T_ENV === 'development') axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
registerMediator(openhimConfig2, mediatorConfig2, err => { if (err) { console.error(err); process.exit(1); } activateHeartbeat(openhimConfig2); });

const appT = express();
appT.use(express.json());

// Health endpoint for OpenHIM heartbeat
appT.get('/termino/_health', (_req, res) => res.status(200).send('OK'));

// Terminology $validate-code
appT.post('/termino/_validate', async (req, res) => {
  const { system, code, display } = req.body;
  if (!system || !code) return res.status(400).json({ error: 'Missing coding.system or coding.code' });
  if (!TERMINO_SERVER_URL) return res.status(500).json({ error: 'TERMINO_SERVER_URL not configured' });
  try {
    const base = (TERMINO_SERVER_URL || '').replace(/\/+$/, '');
    const resp = await axios.get(
      `${base}/CodeSystem/$validate-code`,
      { params: { system, code, display }, httpsAgent: axios.defaults.httpsAgent, timeout: 15000 }
    );
    return res.status(resp.status).json(resp.data);
  } catch (e) {
    console.error('❌ ERROR terminology validation:', e.response?.data || e.message);
    const status = e.response?.status || 502;
    const body = e.response?.data || { error: e.message };
    return res.status(status).json(body);
  }
});

const PORT_TERMINO = process.env.TERMINO_PORT || 8002;
appT.listen(PORT_TERMINO, () => console.log(`Terminology Mediator listening on port ${PORT_TERMINO}`));
