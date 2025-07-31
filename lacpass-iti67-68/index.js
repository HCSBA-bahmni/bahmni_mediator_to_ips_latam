import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';

// Load mediator configuration
const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  FHIR_NODO_REGIONAL_SERVER,
  SUMMARY_PROFILE_INT, // opcional, no se fuerza si da error
  NODE_ENV,
  LACPASS_MEDIATOR_PORT
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
  console.log('⚠️ DEV MODE: self-signed certs accepted');
}

registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err);
    process.exit(1);
  }
  activateHeartbeat(openhimConfig);
});

const app = express();
app.use(express.json({ limit: '20mb' }));

// Helper to build FHIR URL safely (avoid double /fhir)
function buildFHIRPath(suffix) {
  let base = FHIR_NODO_REGIONAL_SERVER || '';
  base = base.replace(/\/+$/, ''); // strip trailing slash(es)
  if (!base.toLowerCase().includes('/fhir')) {
    base = `${base}/fhir`;
  }
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

// Debug incoming
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} query=`, req.query, 'body=', req.body);
  next();
});
process.on('uncaughtException', e => console.error('Uncaught exception:', e));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));

// Health
app.get('/lacpass/_health', (_req, res) => res.status(200).send('OK'));

/**
 * ITI-67: Provide Document Bundle (proxy de DocumentReference search)
 * POST /lacpass/_iti67  with JSON body { identifier: "...", uuid: "..." }
 */
app.post('/lacpass/_iti67', async (req, res) => {
  const { identifier, uuid } = req.body;
  const patientId = identifier || uuid;
  if (!patientId) return res.status(400).json({ error: 'Missing identifier or uuid' });

  try {
    const params = {
      'patient.identifier': patientId,
      status: 'current',
      _format: 'json'
    };
    // opcional: si el servidor soporta profile habilítalo
    // if (SUMMARY_PROFILE_INT) params.profile = SUMMARY_PROFILE_INT;

    const url = buildFHIRPath('DocumentReference');
    const summary = await axios.get(url, {
      params,
      httpsAgent: axios.defaults.httpsAgent,
      timeout: 15000
    });
    return res.json(summary.data);
  } catch (e) {
    console.error('❌ ERROR ITI-67 proxy POST:', e.response?.data || e.message);
    const errBody = e.response?.data || { message: e.message };
    return res.status(500).json({ error: errBody });
  }
});

/**
 * ITI-68: Retrieve Document Set por bundle URL
 * GET /lacpass/_iti68?bundleUrl=...
 */
app.get('/lacpass/_iti68', async (req, res) => {
  let bundleUrl = req.query.bundleUrl;
  if (!bundleUrl) return res.status(400).json({ error: 'Missing bundleUrl query param' });

  if (!bundleUrl.startsWith('http')) {
    // relativo al nodo
    bundleUrl = `${FHIR_NODO_REGIONAL_SERVER.replace(/\/+$/, '')}/${bundleUrl.replace(/^\/+/, '')}`;
  }

  try {
    const bundle = await axios.get(bundleUrl, {
      params: { _format: 'json' },
      httpsAgent: axios.defaults.httpsAgent,
      timeout: 15000
    });
    return res.json(bundle.data);
  } catch (e) {
    console.error('❌ ERROR ITI-68 proxy GET:', e.response?.data || e.message);
    const errBody = e.response?.data || { message: e.message };
    return res.status(500).json({ error: errBody });
  }
});

// Start
const PORT = process.env.LACPASS_MEDIATOR_PORT || 8006;
app.listen(PORT, () => console.log(`LACPASS Mediator listening on port ${PORT}`));
