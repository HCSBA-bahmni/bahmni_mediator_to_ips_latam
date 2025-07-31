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

// Environment variables
const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  FHIR_NODE_URL,
  SUMMARY_PROFILE,
  FHIR_NODO_NACIONAL_SERVER,
  NODE_ENV
} = process.env;

// OpenHIM config
const openhimConfig = {
  username: OPENHIM_USER,
  password: OPENHIM_PASS,
  apiURL: OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
};

// Accept self-signed certs in development
if (NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('⚠️ DEV MODE: self‑signed certs accepted');
}

// Register mediator and start heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err);
    process.exit(1);
  }
  activateHeartbeat(openhimConfig);
});

// Initialize Express
const app = express();
app.use(express.json({ limit: '20mb' }));

// Health check
app.get('/lacpass/_health', (_req, res) => res.status(200).send('OK'));

// ITI-67: Provide Document Bundle acting as proxy
app.post('/lacpass/_iti67', async (req, res) => {
  const { identifier} = req.body; // aquí es RUN*19547137-1
  if (!identifier) return res.status(400).json({ error: 'Missing uuid' });

  try {
    // Consulta igual que tu curl directo
    const summary = await axios.get(
      `${FHIR_NODE_URL}/fhir/DocumentReference`,
      {
        params: {
          'patient.identifier': identifier,
          status: 'current',
          _format: 'json',
          profile: SUMMARY_PROFILE // si el servidor lo soporta; sino omitir
        },
        httpsAgent: axios.defaults.httpsAgent
      }
    );

    // Si lo que necesitas es exactamente el bundle tal cual viene del servidor FHIR,
    // lo reenvías directamente:
    return res.status(200).json(summary.data);

  } catch (e) {
    console.error('❌ ERROR ITI-67 proxy:', e.response?.data || e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ITI‑68: Retrieve Document Set
app.get('/lacpass/_iti68', async (req, res) => {
  const { patientId } = req.query;
  if (!patientId) return res.status(400).json({ error: 'Missing patientId' });
  try {
    // Search for DocumentReference by patient
    const docs = await axios.get(
      `${FHIR_NODO_REGIONAL_SERVER}/fhir/DocumentReference`,
      { params: { patient: patientId }, httpsAgent: axios.defaults.httpsAgent }
    );
    // Return the set as a Bundle
    const bundle = {
      resourceType: 'Bundle',
      id: uuidv4(),
      type: 'searchset',
      total: docs.data.total || (docs.data.entry || []).length,
      entry: docs.data.entry
    };
    return res.json(bundle);

  } catch (e) {
    console.error('❌ ERROR ITI‑68:', e.response?.data || e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Start server
const PORT = process.env.LACPASS_MEDIATOR_PORT || 8005;
app.listen(PORT, () => console.log(`LACPASS Mediator listening on port ${PORT}`));
