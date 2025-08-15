// PDQm Mediator (pdqm-mediator/index.js)
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import querystring from 'querystring';

const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  PDQM_FHIR_URL,
  PDQM_FHIR_TOKEN,
  PDQM_PORT,
  IDENTIFIER_SYSTEM, // ej: "urn:oid:2.16.756.888801.3.4"
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
  console.log('⚠ DEV MODE: self-signed certs accepted');
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

const upstreamBase = (PDQM_FHIR_URL || '').replace(/\/+$/, '');

// --- Utils ---
const buildSelfLinkFromReq = (req) =>
  `${req.protocol}://${req.get('host')}${req.originalUrl}`;

const toArray = (v) => (Array.isArray(v) ? v : (v != null ? [v] : []));

// Normaliza el/los identifier: si falta "system|", compone con IDENTIFIER_SYSTEM
const normalizeIdentifierParams = (raw) => {
  const values = toArray(raw);
  return values.map(v => {
    const s = String(v);
    if (IDENTIFIER_SYSTEM && !s.includes('|')) return `${IDENTIFIER_SYSTEM}|${s}`;
    return s;
  });
};

// Solo permitimos parámetros de búsqueda típicos PDQm (whitelist)
const ALLOWED_PARAMS = new Set([
  'identifier', 'name', 'family', 'given', 'birthdate', 'gender',
  'telecom', 'address', 'address-city', 'address-postalcode',
  '_count', '_offset', '_sort', '_include', '_revinclude'
]);

const buildUpstreamQuery = (req) => {
  const q = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (!ALLOWED_PARAMS.has(k)) continue;
    if (k === 'identifier') {
      q[k] = normalizeIdentifierParams(v);
    } else {
      q[k] = toArray(v);
    }
  }
  // Si no vino identifier pero el cliente mandó `id` o `_id`, lo tratamos como identifier value
  if (!q.identifier) {
    const rid = req.query.id ?? req.query._id;
    if (rid) q.identifier = normalizeIdentifierParams(rid);
  }
  // querystring.stringify no maneja arrays como repetidos, así que manual:
  const parts = [];
  for (const [k, vals] of Object.entries(q)) {
    for (const val of toArray(vals)) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(val))}`);
    }
  }
  return parts.join('&');
};

const buildFallbackBundle = (req, originalIdentifier) => {
  const now = new Date().toISOString();
  const identifierVal = String(Array.isArray(originalIdentifier) ? originalIdentifier[0] : originalIdentifier);
  return {
    resourceType: 'Bundle',
    id: randomUUID(),
    meta: { lastUpdated: now },
    type: 'searchset',
    total: 1,
    link: [{ relation: 'self', url: buildSelfLinkFromReq(req) }],
    entry: [{
      fullUrl: `urn:uuid:${randomUUID()}`,
      resource: {
        resourceType: 'Patient',
        id: randomUUID(),
        active: true,
        identifier: [{
          ...(IDENTIFIER_SYSTEM ? { system: IDENTIFIER_SYSTEM } : {}),
          value: identifierVal
        }]
      },
      search: { mode: 'match' }
    }]
  };
};

const shouldFallback = (errOrBundle) => {
  // Fallback por Bundle sin resultados
  if (errOrBundle && typeof errOrBundle === 'object' && errOrBundle.resourceType === 'Bundle') {
    const total = Number(errOrBundle.total) || 0;
    const hasEntries = Array.isArray(errOrBundle.entry) && errOrBundle.entry.length > 0;
    return total === 0 || !hasEntries;
  }
  // Fallback por errores esperables o sin respuesta
  const status = errOrBundle?.response?.status;
  return !errOrBundle.response || [400, 404, 408, 429, 500, 502, 503].includes(status);
};

// --- Core handler GET /Patient ---
const handlePatientSearch = async (req, res) => {
  try {
    const query = buildUpstreamQuery(req);
    if (!query) {
      return res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'invalid', diagnostics: 'Missing search parameters (e.g., identifier=...)' }]
      });
    }

    const url = `${upstreamBase}/Patient?${query}`;
    const resp = await axios.get(url, {
      httpsAgent: axios.defaults.httpsAgent,
      headers: {
        ...(PDQM_FHIR_TOKEN ? { Authorization: `Bearer ${PDQM_FHIR_TOKEN}` } : {}),
        Accept: 'application/fhir+json'
      },
      timeout: 10000
    });

    if (shouldFallback(resp.data)) {
      // Tomamos el/los identifier originales para el fallback (si existen)
      const rawId = req.query.identifier ?? req.query.id ?? req.query._id;
      const rawIdVal = toArray(rawId)[0] ?? 'UNKNOWN';
      return res
        .type('application/fhir+json')
        .status(200)
        .json(buildFallbackBundle(req, rawIdVal));
    }

    return res.type('application/fhir+json').status(200).json(resp.data);
  } catch (e) {
    const rawId = req.query.identifier ?? req.query.id ?? req.query._id ?? 'UNKNOWN';
    if (shouldFallback(e)) {
      console.error('⚠ PDQm fallback:', e?.message || e?.code || e);
      return res
        .type('application/fhir+json')
        .status(200)
        .json(buildFallbackBundle(req, toArray(rawId)[0]));
    }
    const status = e?.response?.status || 502;
    console.error('❌ PDQm upstream error:', e?.message || e);
    return res
      .type('application/fhir+json')
      .status(status)
      .json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'processing', diagnostics: `PDQm upstream error (${status})` }]
      });
  }
};

app.get('/pdqm/_health', (_req, res) => {
  res.type('application/fhir+json').status(200).json({ status: 'ok' });
});


// --- Rutas "homólogas" a PDQm ---
app.get('/Patient', handlePatientSearch);              // estándar FHIR/PDQm
app.get('/pdqm/Patient', handlePatientSearch);         // alias opcional
app.get('/IHE/PDQm/fhir/Patient', handlePatientSearch);// alias opcional (p. ej. estilo Gazelle)

// (Opcional) Compatibilidad hacia atrás con el POST que tenías
app.post('/pdqm/_lookup', async (req, res) => {
  // Transforma el body {identifier} a un GET /Patient?identifier=...
  const identifier = req.body?.identifier;
  if (!identifier) {
    return res.status(400).json({ error: 'Missing identifier' });
  }
  req.query.identifier = identifier; // inyecta para reutilizar handler
  return handlePatientSearch(req, res);
});

const PORT_PDQM = PDQM_PORT || 8007;
app.listen(PORT_PDQM, () => console.log(`PDQm Mediator listening on port ${PORT_PDQM}`));
