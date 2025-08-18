// termino-proxy/index.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

// --- ENV & OpenHIM ---
const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  NODE_ENV,

  // Terminology target server
  TERMINO_SERVER_URL,           // p.ej. https://<snowstorm>/fhir
  TERMINO_TIMEOUT,              // opcional (ms)
  TERMINO_BEARER_TOKEN,         // opcional
  TERMINO_BASIC_USER,           // opcional
  TERMINO_BASIC_PASS,           // opcional

  // CORS
  CORS_ORIGIN
} = process.env;

const PORT =
  process.env.TERMINO_PORT ||
  process.env.PORT_TERMINO || // compatibilidad con tu .env existente
  8010;

if (!TERMINO_SERVER_URL) {
  console.error('❌ Falta TERMINO_SERVER_URL en .env');
  process.exit(1);
}

const openhimConfig = {
  username: OPENHIM_USER,
  password: OPENHIM_PASS,
  apiURL: OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
};

// SSL dev (self-signed)
const httpsAgent =
  NODE_ENV === 'development'
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

// Axios instance apuntando al Terminology Server
const ax = axios.create({
  baseURL: TERMINO_SERVER_URL.replace(/\/+$/, ''),
  timeout: Number(TERMINO_TIMEOUT) || 20000,
  httpsAgent
});

// Autenticación opcional (Bearer o Basic)
ax.interceptors.request.use((config) => {
  // Prioridad: encabezado entrante Authorization > env Bearer > env Basic
  if (!config.headers) config.headers = {};

  if (!config.headers.Authorization && TERMINO_BEARER_TOKEN) {
    config.headers.Authorization = `Bearer ${TERMINO_BEARER_TOKEN}`;
  } else if (!config.headers.Authorization && TERMINO_BASIC_USER) {
    // Axios usa "auth" para Basic, evita poner Authorization manual
    config.auth = { username: TERMINO_BASIC_USER, password: TERMINO_BASIC_PASS || '' };
  }
  return config;
});

// --- App ---
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS opcional
if (CORS_ORIGIN) {
  const allow = new Set(
    CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  );
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// Healthbeat para OpenHIM
app.get('/termino/_health', (_req, res) => res.status(200).send('OK'));

// Backward-compatible: validador simple -> CodeSystem/$validate-code
app.post('/termino/_validate', async (req, res) => {
  try {
    const { system, code, display } = req.body || {};
    if (!system || !code) {
      return res.status(400).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'required', diagnostics: 'Faltan system y/o code' }] });
    }
    const r = await ax.get('/CodeSystem/$validate-code', {
      params: { system, code, display }
    });
    return res.status(r.status).json(r.data);
  } catch (e) {
    const status = e.response?.status || 502;
    const data = e.response?.data || { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: e.message }] };
    return res.status(status).json(data);
  }
});

// ---- PROXY GENÉRICO ----
// Todo lo que llegue a /termino/fhir/** se reenvía tal cual al Terminology Server.
// Ejemplos que esto cubre:
//  - GET  /termino/fhir/ValueSet/$expand
//  - POST /termino/fhir/ValueSet/$expand
//  - GET  /termino/fhir/CodeSystem/$lookup
//  - GET  /termino/fhir/CodeSystem/$subsumes
//  - GET|POST /termino/fhir/CodeSystem/$validate-code
//  - POST /termino/fhir/ConceptMap/$translate
//  - + cualquier read/search en esos recursos
app.use('/termino/fhir', async (req, res) => {
  const tail = req.originalUrl.replace(/^\/termino\/fhir/, '') || '/';
  const headers = {
    Accept: req.get('accept') || 'application/fhir+json',
    'Content-Type': req.get('content-type') || 'application/fhir+json'
  };

  try {
    const r = await ax.request({
      method: req.method,
      url: tail,
      params: req.query,
      data: ['GET', 'DELETE', 'HEAD'].includes(req.method) ? undefined : req.body,
      headers
    });

    // Propaga content-type si viene del TS
    if (r.headers?.['content-type']) {
      res.setHeader('content-type', r.headers['content-type']);
    }
    return res.status(r.status).send(r.data);
  } catch (e) {
    const status = e.response?.status || 502;
    const data = e.response?.data || {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'exception', diagnostics: e.message }]
    };
    return res.status(status).send(data);
  }
});

// --- Registro OpenHIM y heartbeat ---
registerMediator(openhimConfig, mediatorConfig, (err) => {
  if (err) {
    console.error('❌ Error registrando mediador en OpenHIM:', err);
    process.exit(1);
  }
  console.log('✅ Mediador registrado en OpenHIM');
  activateHeartbeat(openhimConfig);
});

app.listen(PORT, () => {
  console.log(`FHIR Terminology Proxy escuchando en puerto ${PORT}`);
  console.log(`↪ Reenviando a: ${TERMINO_SERVER_URL.replace(/\/+$/, '')}`);
});
