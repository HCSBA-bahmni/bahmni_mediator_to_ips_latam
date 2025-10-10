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

    // ===== Helpers GET→POST $operation =====
function paramsFromQuery(query, spec) {
  // spec = [{ q: 'system', type:'uri', name:'system' }, ...]
  const p = [];
  for (const { q, type, name } of spec) {
    const v = query[q];
    if (v == null) continue;
    const fhirName = name || q;
    const key = type === 'uri' ? 'valueUri'
             : type === 'code' ? 'valueCode'
             : /*string*/       'valueString';
    p.push({ name: fhirName, [key]: String(v) });
  }
  return { resourceType: 'Parameters', parameter: p };
}

async function forwardTsOperation(ts, path, parameters, res) {
  try {
    const { data, status } = await ts.post(path, parameters, {
      headers: { 'Content-Type': 'application/fhir+json' }
    });
    res.status(status || 200).json(data);
  } catch (e) {
    const status = e?.response?.status || 502;
    const diag = e?.response?.data || e?.message || 'TS upstream error';
    res.status(status).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'processing', diagnostics: JSON.stringify(diag) }]
    });
  }
}

// ===== Rutas GET “compatibles” =====
// 1) CodeSystem $lookup
app.get('/termino/fhir/CodeSystem/$lookup', async (req, res) => {
  const ts = buildTsClient();
  if (!ts) return res.status(500).json({ error: 'TS_BASE_URL not configured' });
  const spec = [
    { q: 'system', type: 'uri' },
    { q: 'code', type: 'code' },
    { q: 'version', type: 'uri' },
    { q: 'displayLanguage', type: 'code' } // opcional; algunos TS lo ignoran
  ];
  const params = paramsFromQuery(req.query, spec);
  return forwardTsOperation(ts, '/CodeSystem/$lookup', params, res);
});

// 2) CodeSystem $validate-code
app.get('/termino/fhir/CodeSystem/$validate-code', async (req, res) => {
  const ts = buildTsClient();
  if (!ts) return res.status(500).json({ error: 'TS_BASE_URL not configured' });
  const spec = [
    // HAPI/Snowstorm aceptan "url" (el CodeSystem) + opcional "version"
    { q: 'url', type: 'uri' },      // ej: http://snomed.info/sct
    { q: 'version', type: 'uri' },  // ej: http://snomed.info/sct/900.../version/20250501
    { q: 'code', type: 'code' },
    { q: 'display', type: 'string' },
    { q: 'displayLanguage', type: 'code' }
  ];
  // Si el cliente pasó ?system=..., lo mapeamos a url (azúcar sintáctico)
  if (req.query.system && !req.query.url) req.query.url = req.query.system;
  const params = paramsFromQuery(req.query, spec);
  return forwardTsOperation(ts, '/CodeSystem/$validate-code', params, res);
});

// 3) ValueSet $validate-code (por si validas contra VS)
app.get('/termino/fhir/ValueSet/$validate-code', async (req, res) => {
  const ts = buildTsClient();
  if (!ts) return res.status(500).json({ error: 'TS_BASE_URL not configured' });
  const spec = [
    { q: 'url', type: 'uri' },      // VS expand/validate URL (p.ej. ECL VS)
    { q: 'system', type: 'uri' },
    { q: 'code', type: 'code' },
    { q: 'display', type: 'string' },
    { q: 'displayLanguage', type: 'code' }
  ];
  const params = paramsFromQuery(req.query, spec);
  return forwardTsOperation(ts, '/ValueSet/$validate-code', params, res);
});

// 4) ConceptMap $translate (vacunas)
app.get('/termino/fhir/ConceptMap/$translate', async (req, res) => {
  const ts = buildTsClient();
  if (!ts) return res.status(500).json({ error: 'TS_BASE_URL not configured' });
  const spec = [
    { q: 'url', type: 'uri' },        // ConceptMap directo (opcional)
    { q: 'system', type: 'uri' },     // source system
    { q: 'code', type: 'code' },
    { q: 'source', type: 'uri' },     // source VS (opcional)
    { q: 'target', type: 'uri' },     // target VS (opcional)
    { q: 'targetsystem', type: 'uri' },
    { q: 'displayLanguage', type: 'code' }
  ];
  const params = paramsFromQuery(req.query, spec);
  return forwardTsOperation(ts, '/ConceptMap/$translate', params, res);
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
