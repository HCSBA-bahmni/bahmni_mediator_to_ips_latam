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

// Debug
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} query=`, req.query);
  next();
});
process.on('uncaughtException', e => console.error('Uncaught exception:', e));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));

// Health
app.get('/lacpass/_health', (_req, res) => res.status(200).send('OK'));

/**
 * ITI-67 simplified as GET:
 * /lacpass/_iti67?identifier=RUN*19547137-1
 */
app.get('/lacpass/_iti67', async (req, res) => {
  const identifier = req.query.identifier;
  if (!identifier) return res.status(400).json({ error: 'Missing identifier query param' });

  try {
    const params = {
      'patient.identifier': identifier,
      status: 'current',
      _format: 'json'
    };
    // if (SUMMARY_PROFILE_INT) params.profile = SUMMARY_PROFILE_INT; // opcional

    const summary = await axios.get(
      `${FHIR_NODO_REGIONAL_SERVER}/fhir/DocumentReference`,
      {
        params,
        httpsAgent: axios.defaults.httpsAgent,
        timeout: 15000
      }
    );
    return res.json(summary.data);
  } catch (e) {
    console.error('❌ ERROR ITI-67 proxy GET:', e.response?.data || e.message);
    return res.status(500).json({ error: e.response?.data || e.message });
  }
});

/**
 * ITI-68 simplified as GET to bundle URL.
 * /lacpass/_iti68?bundleUrl=http://.../fhir/Bundle/XYZ
 */
app.get('/lacpass/_iti68', async (req, res) => {
  let bundleUrl = req.query.bundleUrl;
  if (!bundleUrl) return res.status(400).json({ error: 'Missing bundleUrl query param' });

  // Si viene sin formato completo, podrías permitir que sea relativo al nodo:
  if (!bundleUrl.startsWith('http')) {
    bundleUrl = `${FHIR_NODO_REGIONAL_SERVER}/${bundleUrl.replace(/^\/+/, '')}`;
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
    return res.status(500).json({ error: e.response?.data || e.message });
  }
});

// Start
const PORT = process.env.LACPASS_MEDIATOR_PORT || 8006;
app.listen(PORT, () => console.log(`LACPASS Mediator listening on port ${PORT}`));
