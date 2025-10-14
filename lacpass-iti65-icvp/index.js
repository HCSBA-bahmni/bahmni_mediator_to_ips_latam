// index.js — LACPASS → ITI-65 Mediator con PDQm + Terminología por dominio
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

// ===================== ENV =====================
const {
  // OpenHIM / FHIR Destino
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  FHIR_NODE_URL,
  SUMMARY_ICVP_PROFILE,
  FHIR_NODO_NACIONAL_SERVER,

  NODE_ENV,
  DEBUG_DIR,

  // CORS
  CORS_ORIGIN,

  // ===== Features =====
  FEATURE_PDQ_ENABLED = 'false',
  FEATURE_TS_ENABLED = 'false',

  // Subfeatures terminológicas
  FEATURE_TS_EXPAND_ENABLED = 'true',
  FEATURE_TS_VALIDATE_VS_ENABLED = 'true',
  FEATURE_TS_VALIDATE_CS_ENABLED = 'true',
  FEATURE_TS_TRANSLATE_ENABLED = 'true',

  // ===== PDQm =====
  PDQM_PORT,
  PDQM_FHIR_URL,
  PDQM_FHIR_TOKEN,
  PDQM_TIMEOUT_MS = '10000',
  PDQM_ALLOWED_SEARCH_PARAMS,
  PDQM_IDENTIFIER_FALLBACK_PARAM_NAMES,
  PDQM_DEFAULT_IDENTIFIER_SYSTEM,
  PDQM_FALLBACK_HTTP_STATUSES,
  PDQM_ENABLE_FALLBACK_FOR_401_403 = 'false',
  PDQM_ENABLE_ALIASES = 'true',

  // ===== Terminology =====
  // Acepta alias TERMINOLOGY_BASE_URL o TERMINO_SERVER_URL
  TERMINOLOGY_BASE_URL,
  TERMINO_SERVER_URL,
  TS_TIMEOUT_MS = '15000',
  TS_DISPLAY_LANGUAGE,
  TS_ACTIVE_ONLY = 'true',

  // Dominios
  TS_DOMAINS = 'conditions,procedures,medications,vaccines',
  TS_DEFAULT_DOMAIN = 'conditions',

  // Defaults para $translate (si el dominio no define)
  TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL = '',
  TS_TRANSLATE_DEFAULT_SOURCE_VS = '',
  TS_TRANSLATE_DEFAULT_TARGET_VS = '',
  TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM = 'http://snomed.info/sct',
  TS_TRANSLATE_DEFAULT_TARGET_SYSTEM = 'http://hl7.org/fhir/sid/icd-10',

  // Auth Terminology
  TERMINO_BEARER_TOKEN,
  TERMINO_BASIC_USER,
  TERMINO_BASIC_PASS,

  // ============ CONDITIONS ============
  CONDITIONS_VS_EXPAND_URI = '',
  CONDITIONS_VS_VALIDATE_URI = '',
  CONDITIONS_CS_URI = 'http://snomed.info/sct',
  CONDITIONS_TRANSLATE_CONCEPTMAP_URL = '',
  CONDITIONS_TRANSLATE_SOURCE_VS = '',
  CONDITIONS_TRANSLATE_TARGET_VS = '',
  CONDITIONS_TRANSLATE_SOURCE_SYSTEM = 'http://snomed.info/sct',
  CONDITIONS_TRANSLATE_TARGET_SYSTEM = 'http://hl7.org/fhir/sid/icd-10',

  // ============ PROCEDURES ============
  PROCEDURES_VS_EXPAND_URI = '',
  PROCEDURES_VS_VALIDATE_URI = '',
  PROCEDURES_CS_URI = 'http://snomed.info/sct',
  PROCEDURES_TRANSLATE_CONCEPTMAP_URL = '',
  PROCEDURES_TRANSLATE_SOURCE_VS = '',
  PROCEDURES_TRANSLATE_TARGET_VS = '',
  PROCEDURES_TRANSLATE_SOURCE_SYSTEM = 'http://snomed.info/sct',
  PROCEDURES_TRANSLATE_TARGET_SYSTEM = 'http://hl7.org/fhir/sid/icd-10-pcs',

  // ============ MEDICATIONS ============
  MEDICATIONS_VS_EXPAND_URI = '',
  MEDICATIONS_VS_VALIDATE_URI = '',
  MEDICATIONS_CS_URI = 'http://snomed.info/sct',
  MEDICATIONS_TRANSLATE_CONCEPTMAP_URL = '',
  MEDICATIONS_TRANSLATE_SOURCE_VS = '',
  MEDICATIONS_TRANSLATE_TARGET_VS = '',
  MEDICATIONS_TRANSLATE_SOURCE_SYSTEM = 'http://snomed.info/sct',
  MEDICATIONS_TRANSLATE_TARGET_SYSTEM = 'http://www.whocc.no/atc',

  // ============ VACCINES ============
  VACCINES_VS_EXPAND_URI = '',
  VACCINES_VS_VALIDATE_URI = '',
  VACCINES_CS_URI = 'http://snomed.info/sct',
  VACCINES_TRANSLATE_CONCEPTMAP_URL = '',
  VACCINES_TRANSLATE_SOURCE_VS = '',
  VACCINES_TRANSLATE_TARGET_VS = '',
  VACCINES_TRANSLATE_SOURCE_SYSTEM = 'http://snomed.info/sct',
  VACCINES_TRANSLATE_TARGET_SYSTEM = 'http://hl7.org/fhir/sid/icd-10',

} = process.env;

const isTrue = (v) => String(v).toLowerCase() === 'true';
const arr = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// ===================== Debug dir =====================
const debugDir = DEBUG_DIR ? path.resolve(DEBUG_DIR) : '/tmp';
try { fs.mkdirSync(debugDir, { recursive: true }); }
catch (err) { console.error(`❌ Could not create debug directory at ${debugDir}:`, err.message); }

// ===================== OpenHIM =====================
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
registerMediator(openhimConfig, mediatorConfig, (err) => {
  if (err) { console.error('❌ Registration error:', err); process.exit(1); }
  activateHeartbeat(openhimConfig);
});

// ===================== Express =====================
const app = express();
app.use(express.json({ limit: '20mb' }));

// CORS opcional
if (CORS_ORIGIN) {
  const allowList = arr(CORS_ORIGIN);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowList.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.get('/icvp/_health', (_req, res) => res.status(200).send('OK'));

// ===================== PDQm helpers =====================
async function pdqmFetchPatientByIdentifier(identifierValue) {
  if (!identifierValue || !PDQM_FHIR_URL) return null;
  try {
    const url = `${PDQM_FHIR_URL.replace(/\/+$/, '')}/Patient`;
    const headers = { Accept: 'application/fhir+json' };
    if (PDQM_FHIR_TOKEN) headers.Authorization = `Bearer ${PDQM_FHIR_TOKEN}`;
    const resp = await axios.get(url, {
      params: { identifier: identifierValue, _count: 1 },
      headers,
      timeout: parseInt(PDQM_TIMEOUT_MS, 10) || 10000,
      httpsAgent: axios.defaults.httpsAgent
    });
    const b = resp.data;
    const pt = b?.entry?.find(e => e.resource?.resourceType === 'Patient')?.resource;
    return pt || null;
  } catch (e) {
    const statuses = new Set(arr(PDQM_FALLBACK_HTTP_STATUSES));
    const status = e.response?.status;
    const canIgnoreAuth = isTrue(PDQM_ENABLE_FALLBACK_FOR_401_403);
    const ignorable = statuses.has(String(status)) || (!canIgnoreAuth && (status === 401 || status === 403));
    console.warn('⚠️ PDQm fetch error:', status, e.response?.data || e.message, 'ignorable=', ignorable);
    return null; // No detiene el flujo
  }
}
function mergePatientDemographics(localPt, pdqmPt) {
  if (!localPt || !pdqmPt) return;
  if (pdqmPt.name) localPt.name = pdqmPt.name;
  if (pdqmPt.gender) localPt.gender = pdqmPt.gender;
  if (pdqmPt.birthDate) localPt.birthDate = pdqmPt.birthDate;
  if (pdqmPt.address) localPt.address = pdqmPt.address;
  if (Array.isArray(pdqmPt.identifier) && pdqmPt.identifier.length > 0) {
    localPt.identifier = pdqmPt.identifier;
  }
}

// ===================== Terminology client =====================
const TS_BASE_URL = (TERMINOLOGY_BASE_URL || TERMINO_SERVER_URL || '').replace(/\/+$/, '');
function buildTsClient() {
  if (!TS_BASE_URL) return null;
  const headers = { Accept: 'application/fhir+json' };
  if (TERMINO_BEARER_TOKEN) headers.Authorization = `Bearer ${TERMINO_BEARER_TOKEN}`;
  const auth = (TERMINO_BASIC_USER && TERMINO_BASIC_PASS)
    ? { username: TERMINO_BASIC_USER, password: TERMINO_BASIC_PASS }
    : undefined;

  return axios.create({
    baseURL: TS_BASE_URL,
    timeout: parseInt(TS_TIMEOUT_MS, 10) || 15000,
    headers,
    auth,
    httpsAgent: axios.defaults.httpsAgent
  });
}

// ===================== Domain config =====================
const DOMAIN_CONFIG = {
  conditions: {
    vsExpand: CONDITIONS_VS_EXPAND_URI,
    vsValidate: CONDITIONS_VS_VALIDATE_URI,
    codeSystem: CONDITIONS_CS_URI,
    translate: {
      conceptMapUrl: CONDITIONS_TRANSLATE_CONCEPTMAP_URL || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
      sourceVS: CONDITIONS_TRANSLATE_SOURCE_VS || TS_TRANSLATE_DEFAULT_SOURCE_VS,
      targetVS: CONDITIONS_TRANSLATE_TARGET_VS || TS_TRANSLATE_DEFAULT_TARGET_VS,
      sourceSystem: CONDITIONS_TRANSLATE_SOURCE_SYSTEM || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
      targetSystem: CONDITIONS_TRANSLATE_TARGET_SYSTEM || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
    }
  },
  procedures: {
    vsExpand: PROCEDURES_VS_EXPAND_URI,
    vsValidate: PROCEDURES_VS_VALIDATE_URI,
    codeSystem: PROCEDURES_CS_URI,
    translate: {
      conceptMapUrl: PROCEDURES_TRANSLATE_CONCEPTMAP_URL || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
      sourceVS: PROCEDURES_TRANSLATE_SOURCE_VS || TS_TRANSLATE_DEFAULT_SOURCE_VS,
      targetVS: PROCEDURES_TRANSLATE_TARGET_VS || TS_TRANSLATE_DEFAULT_TARGET_VS,
      sourceSystem: PROCEDURES_TRANSLATE_SOURCE_SYSTEM || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
      targetSystem: PROCEDURES_TRANSLATE_TARGET_SYSTEM || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
    }
  },
  medications: {
    vsExpand: MEDICATIONS_VS_EXPAND_URI,
    vsValidate: MEDICATIONS_VS_VALIDATE_URI,
    codeSystem: MEDICATIONS_CS_URI,
    translate: {
      conceptMapUrl: MEDICATIONS_TRANSLATE_CONCEPTMAP_URL || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
      sourceVS: MEDICATIONS_TRANSLATE_SOURCE_VS || TS_TRANSLATE_DEFAULT_SOURCE_VS,
      targetVS: MEDICATIONS_TRANSLATE_TARGET_VS || TS_TRANSLATE_DEFAULT_TARGET_VS,
      sourceSystem: MEDICATIONS_TRANSLATE_SOURCE_SYSTEM || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
      targetSystem: MEDICATIONS_TRANSLATE_TARGET_SYSTEM || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
    }
  },
  vaccines: {
    vsExpand: VACCINES_VS_EXPAND_URI,
    vsValidate: VACCINES_VS_VALIDATE_URI,
    codeSystem: VACCINES_CS_URI,
    translate: {
      conceptMapUrl: VACCINES_TRANSLATE_CONCEPTMAP_URL || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
      sourceVS: VACCINES_TRANSLATE_SOURCE_VS || TS_TRANSLATE_DEFAULT_SOURCE_VS,
      targetVS: VACCINES_TRANSLATE_TARGET_VS || TS_TRANSLATE_DEFAULT_TARGET_VS,
      sourceSystem: VACCINES_TRANSLATE_SOURCE_SYSTEM || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
      targetSystem: VACCINES_TRANSLATE_TARGET_SYSTEM || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
    }
  }
};
const DOMAIN_NAMES = new Set(arr(TS_DOMAINS));

// ===================== Terminology Ops (funciones) =====================
async function opValidateVS(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_VALIDATE_VS_ENABLED)) return null;
  if (!domainCfg?.vsValidate) return null;
  try {
    const params = { url: domainCfg.vsValidate, code };
    if (system) params.system = system;
    if (display) params.display = display;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;
    const { data } = await ts.get('/ValueSet/$validate-code', { params });
    const ok = extractResultFromParameters(data);
    if (ok.result) {
      return { system: system, code, display: ok.display || display, source: 'validate-vs' };
    }
  } catch { /* noop */ }
  return null;
}
async function opValidateCS(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_VALIDATE_CS_ENABLED)) return null;
  if (!domainCfg?.codeSystem || !system) return null;
  try {
    const params = { system, code };
    if (display) params.display = display;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;
    const { data } = await ts.get('/CodeSystem/$validate-code', { params });
    const ok = extractResultFromParameters(data);
    if (ok.result) {
      return { system, code, display: ok.display || display, source: 'validate-cs' };
    }
  } catch { /* noop */ }
  return null;
}
async function opExpand(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_EXPAND_ENABLED)) return null;
  if (!domainCfg?.vsExpand) return null;
  try {
    const params = { url: domainCfg.vsExpand };
    // Usamos display o code como filtro
    const filter = display || code;
    if (filter) params.filter = filter;
    if (TS_ACTIVE_ONLY) params.activeOnly = isTrue(TS_ACTIVE_ONLY);
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

    const { data } = await ts.get('/ValueSet/$expand', { params });
    const c = data?.expansion?.contains?.[0];
    if (c?.code) {
      return { system: c.system || system, code: c.code, display: c.display || display || c.code, source: 'expand' };
    }
  } catch { /* noop */ }
  return null;
}
async function opLookup(ts, { code, system, display }) {
  if (!system || !code) return null; // lookup requiere ambos
  try {
    const params = { system, code };
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;
    const { data } = await ts.get('/CodeSystem/$lookup', { params });
    const disp = extractDisplayFromLookup(data);
    if (disp) return { system, code, display: disp, source: 'lookup' };
  } catch { /* noop */ }
  return null;
}
async function opTranslate(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_TRANSLATE_ENABLED)) return null;

  const cm = domainCfg?.translate || {};
  const params = {};
  if (cm.conceptMapUrl) params.url = cm.conceptMapUrl;
  if (cm.sourceVS) params.source = cm.sourceVS;
  if (cm.targetVS) params.target = cm.targetVS;
  if (cm.sourceSystem || system) params.system = cm.sourceSystem || system;
  if (cm.targetSystem) params.targetsystem = cm.targetSystem;
  if (code) params.code = code;
  if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

  // Si no hay url/source/target ni targetsystem, no intentamos translate
  const hasConfig = params.url || params.source || params.target || params.targetsystem;
  if (!hasConfig) return null;

  try {
    const { data } = await ts.get('/ConceptMap/$translate', { params });
    const match = extractMatchFromTranslate(data);
    if (match?.system && match?.code) {
      return { system: match.system, code: match.code, display: match.display || display || code, source: 'translate' };
    }
  } catch { /* noop */ }
  return null;
}

// ---- Parsers auxiliares ----
function extractResultFromParameters(data) {
  // Parameters.parameter[name=result|message|display]
  const out = { result: false, display: undefined };
  if (data?.resourceType === 'Parameters' && Array.isArray(data.parameter)) {
    for (const p of data.parameter) {
      if (p.name === 'result') out.result = (p.valueBoolean === true || p.valueString === 'true');
      if (p.name === 'display' && p.valueString) out.display = p.valueString;
    }
  } else if (data?.resourceType === 'OperationOutcome') {
    // heurística
    out.result = Array.isArray(data.issue) && data.issue.some(i => (i.severity === 'information' || i.severity === 'success'));
  }
  return out;
}
function extractDisplayFromLookup(data) {
  if (data?.resourceType !== 'Parameters' || !Array.isArray(data.parameter)) return undefined;
  const p = data.parameter.find(x => x.name === 'display');
  return p?.valueString;
}
function extractMatchFromTranslate(data) {
  // Parameters.parameter[name=match].part[name=concept].valueCoding{system,code,display}
  if (data?.resourceType !== 'Parameters' || !Array.isArray(data.parameter)) return null;
  const matchParam = data.parameter.find(p => p.name === 'match');
  const parts = matchParam?.part || [];
  const concept = parts.find(x => x.name === 'concept')?.valueCoding;
  if (concept?.code) return { system: concept.system, code: concept.code, display: concept.display };
  // fallback: algunos servidores devuelven primer 'match' en array
  for (const p of data.parameter) {
    if (p.name === 'match' && Array.isArray(p.part)) {
      const c = p.part.find(x => x.name === 'concept')?.valueCoding;
      if (c?.code) return { system: c.system, code: c.code, display: c.display };
    }
  }
  return null;
}

// ===================== Mapeo recurso → dominio =====================
function resourceToDomain(resource) {
  switch (resource.resourceType) {
    case 'Condition': return 'conditions';
    case 'Procedure': return 'procedures';
    case 'MedicationRequest':
    case 'MedicationStatement': return 'medications';
    case 'Immunization': return 'vaccines';
    case 'AllergyIntolerance': return 'conditions'; // si más adelante agregas "allergies", cámbialo aquí
    default: return TS_DEFAULT_DOMAIN || 'conditions';
  }
}

// ===================== Iterador de CodeableConcepts =====================
function* iterateCodeableConcepts(resource) {
  switch (resource.resourceType) {
    case 'Condition':
      if (resource.code) yield { path: 'code', cc: resource.code };
      break;
    case 'AllergyIntolerance':
      if (resource.code) yield { path: 'code', cc: resource.code };
      break;
    case 'Procedure':
      if (resource.code) yield { path: 'code', cc: resource.code };
      break;
    case 'MedicationRequest':
      if (resource.medicationCodeableConcept) yield { path: 'medicationCodeableConcept', cc: resource.medicationCodeableConcept };
      break;
    case 'MedicationStatement':
      if (resource.medicationCodeableConcept) yield { path: 'medicationCodeableConcept', cc: resource.medicationCodeableConcept };
      break;
    case 'Immunization':
      if (resource.vaccineCode) yield { path: 'vaccineCode', cc: resource.vaccineCode };
      break;
    default:
      break;
  }
}

// ===================== Pipeline por dominio =====================
async function normalizeCC(ts, cc, domainCfg) {
  if (!cc?.coding || !Array.isArray(cc.coding) || cc.coding.length === 0) return;
  // trabajamos sobre el PRIMER coding (puedes extender a todos si lo prefieres)
  const coding = cc.coding[0];
  const base = { system: coding.system, code: coding.code, display: coding.display || cc.text };

  // Orden sugerido: Validate VS → Validate CS → Expand → Lookup → Translate
  const steps = [
    () => opValidateVS(ts, base, domainCfg),
    () => opValidateCS(ts, base, domainCfg),
    () => opExpand(ts, base, domainCfg),
    () => opLookup(ts, base),
    () => opTranslate(ts, base, domainCfg),
  ];

  for (const step of steps) {
    // si la sub-función está deshabilitada o no aplica, retornará null
    const out = await step();
    if (out && out.code) {
      cc.coding[0] = { system: out.system || base.system, code: out.code, display: out.display || base.display };
      return;
    }
  }
  // Si nada aplicó, dejamos el coding original
}

async function normalizeTerminologyInBundle(bundle) {
  if (!isTrue(FEATURE_TS_ENABLED)) return;
  const ts = buildTsClient();
  if (!ts || !bundle?.entry?.length) return;

  for (const entry of bundle.entry) {
    const res = entry.resource;
    if (!res) continue;

    // Determinar dominio
    const domain = resourceToDomain(res);
    const domainCfg = DOMAIN_CONFIG[domain] || DOMAIN_CONFIG[TS_DEFAULT_DOMAIN] || {};
    if (!DOMAIN_NAMES.has(domain)) {
      // Dominio no listado en TS_DOMAINS → igualmente intenta con default
      // (o puedes simplemente continue)
    }

    // Normalizar todas las CC relevantes del recurso
    for (const { cc } of iterateCodeableConcepts(res)) {
      try { await normalizeCC(ts, cc, domainCfg); }
      catch (e) { console.warn(`⚠️ TS normalize error (${domain}):`, e.message); }
    }
  }
}

// ===================== Route ITI-65 =====================
app.post('/icvp/_iti65', async (req, res) => {
  let summaryBundle;

  // 1) Obtener $summary si viene uuid; si no, usar el Bundle entregado
  if (req.body.uuid) {
    try {
      const resp = await axios.get(
        `${FHIR_NODE_URL}/fhir/Patient/${req.body.uuid}/$summary`,
        { params: { profile: SUMMARY_ICVP_PROFILE }, httpsAgent: axios.defaults.httpsAgent }
      );
      summaryBundle = resp.data;
    } catch (e) {
      console.error('❌ ERROR fetching summary:', e.response?.data || e.message);
      return res.status(502).json({ error: 'Error fetching summary', details: e.message });
    }
  } else {
    summaryBundle = req.body;
  }

  if (!summaryBundle || summaryBundle.resourceType !== 'Bundle') {
    console.error('❌ Invalid summaryBundle:', JSON.stringify(summaryBundle).slice(0, 200));
    return res.status(400).json({ error: 'Invalid Bundle or missing uuid' });
  }

    function pickIdentifiersOrderedForPdqm(identifiers) {
        if (!Array.isArray(identifiers) || identifiers.length === 0) return [];

        const norm = (s) => String(s || '').trim();
        // IMPORTANTE: para "Pasaporte" por texto NO exigimos formato ni system
        const anyPassportByText = (id) =>
            /passport|pasaporte/i.test(norm(id?.type?.text)) && !!norm(id?.value);

        // Mantengo un detector opcional de "valor con pinta de pasaporte" para el resto de casos
        const looksLikePassportValue = (v) => {
            if (!v) return false;
            if (/\*/.test(v)) return false;
            if (/^RUN\*/i.test(v)) return false;
            return /^[A-Z]{2}[A-Z0-9]{5,}$/i.test(v);
        };
        const preferCL = (arr) =>
            arr.sort((a, b) => (/^CL/i.test(norm(b.value)) ? 1 : 0) - (/^CL/i.test(norm(a.value)) ? 1 : 0));

        const passportTypeCode = (process.env.PDQM_IDENTIFIER_TYPE_CODE_PASSPORT || 'PPN').trim();
        const passportTypeText = (process.env.PDQM_IDENTIFIER_TYPE_TEXT_PASSPORT || 'Pasaporte').toLowerCase();
        const nationalTypeText = (process.env.PDQM_IDENTIFIER_TYPE_TEXT_NATIONAL  || 'RUN').toLowerCase();

        const isPassportId = (id) => {
            const codings = (id.type?.coding || []);
            const codeHit = codings.some(c => norm(c.code).toUpperCase() === passportTypeCode.toUpperCase());
            // soporte explícito al code que nos compartiste para "Pasaporte"
            const altCodeHit = codings.some(c => norm(c.code) === 'a2551e57-6028-428b-be3c-21816c252e06');
            const textHit = norm(id.type?.text).toLowerCase().includes(passportTypeText) ||
                /passport|pasaporte/i.test(norm(id.type?.text));
            return (codeHit || altCodeHit || textHit) && !!norm(id.value);
        };
        const isNationalId = (id) => {
            const txt = norm(id.type?.text);
            const code = norm(id.type?.coding?.[0]?.code);
            const val = norm(id.value);
            if (/^RUN\*/i.test(val)) return true;                 // RUN*...
            if (/run|nacional|national/i.test(txt)) return true;  // por texto
            if (code && /RUN/i.test(code)) return true;           // por code si existiera
            return false;
        };

        // 1) Pasaporte por TEXTO (sin exigir system/format)
        const passportByText = preferCL(
            identifiers.filter(anyPassportByText)
        ).map(i => norm(i.value));

        // 2) Pasaporte formal (por coding o texto, pero además con pinta de pasaporte)
        const passportFormal = preferCL(
            identifiers.filter(isPassportId).filter(i => looksLikePassportValue(i.value))
        ).map(i => norm(i.value));

        // 3) Pasaporte "por forma" (value parece pasaporte) excluyendo RUN
        const passportShape  = preferCL(
            identifiers.filter(i => !isNationalId(i) && looksLikePassportValue(i.value))
        ).map(i => norm(i.value));
        // 4) Nacional (RUN) como fallback
        const nationals      = identifiers.filter(isNationalId).map(i => norm(i.value));
        // 5) Último recurso: cualquier value sin * ni RUN*
        const lastResort     = identifiers
            .filter(i => !!norm(i.value) && !/\*/.test(norm(i.value)) && !/^RUN\*/i.test(norm(i.value)))
            .map(i => norm(i.value));

        // Unificar preservando orden y sin duplicados
        const seen = new Set();
        const ordered = [...passportByText, ...passportFormal, ...passportShape, ...nationals, ...lastResort]
            .filter(v => { if (seen.has(v)) return false; seen.add(v); return true; });
        return ordered;
    }

    function generateFallbackBundle(identifierValue) {
        const fallbackBundle = {
            resourceType: 'Bundle',
            id: `pdqm-fallback-${Date.now()}`,
            type: 'searchset',
            total: 1,
            entry: [{
                fullUrl: `Patient/pdqm-fallback-${identifierValue}`,
                resource: {
                    resourceType: 'Patient',
                    id: `pdqm-fallback-${identifierValue}`,
                    identifier: [{
                        system: PDQM_DEFAULT_IDENTIFIER_SYSTEM || toUrnOid('1.2.3.4.5'),
                        value: identifierValue
                    }],
                    name: [{
                        text: `Paciente PDQm Fallback ${identifierValue}`
                    }],
                    meta: {
                        tag: [{
                            system: 'http://example.org/tag',
                            code: 'pdqm-fallback',
                            display: 'PDQm Fallback Bundle'
                        }]
                    }
                }
            }]
        };

        return fallbackBundle;
    }

// ===================== PDQm Utils =====================
// ===================== URL Encoding Helper =====================
    function robustUrlEncode(value) {
        if (!value) return '';

        // Primero, codificación URL estándar
        let encoded = encodeURIComponent(value);

        // Luego, codificaciones adicionales para caracteres que pueden causar problemas en queries
        encoded = encoded.replace(/\*/g, '%2A');  // Asterisco
        encoded = encoded.replace(/'/g, '%27');   // Comilla simple
        encoded = encoded.replace(/"/g, '%22');   // Comilla doble
        encoded = encoded.replace(/\(/g, '%28');  // Paréntesis abierto
        encoded = encoded.replace(/\)/g, '%29');  // Paréntesis cerrado

        return encoded;
    }

    // ===================== PDQm =====================
    async function pdqmFetchBundleByIdentifier(identifierValue) {
        console.log('🔍 PDQm fetch for identifier:', identifierValue, 'using PDQM_FHIR_URL:', PDQM_FHIR_URL);
        if (!PDQM_FHIR_URL || !identifierValue) return null;
        console.log('---')

        const maxAttempts = 3;
        let currentAttempt = 0;

        while (currentAttempt < maxAttempts) {
            currentAttempt++;
            console.log(`PDQm attempt ${currentAttempt}/${maxAttempts} for identifier: ${identifierValue}`);

            try {
                // Construir configuración de solicitud
                const config = {
                    timeout: parseInt(PDQM_TIMEOUT_MS, 10),
                    httpsAgent: axios.defaults.httpsAgent,
                    validateStatus: (status) => {
                        // Considerar como válidos los estados esperados
                        return status < 500 && status !== 429; // No reintentar en errores de servidor o throttling
                    }
                };

                if (PDQM_FHIR_TOKEN) {
                    config.headers = { 'Authorization': `Bearer ${PDQM_FHIR_TOKEN}` };
                }

                // Intentar con el parámetro identifier por defecto
                const base = asFhirBase(PDQM_FHIR_URL);
                let url = joinUrl(base, '/Patient') + `?identifier=${robustUrlEncode(identifierValue)}`;
                console.log(`PDQm GET: ${url}`);

                let response = await axios.get(url, config);

                // Si la respuesta es exitosa y contiene datos, retornar
                if (response.status === 200 && response.data?.resourceType === 'Bundle') {
                    console.log(`✅ PDQm response: ${response.data.total || 0} patients found`);
                    return response.data;
                }

                // Si no hay resultados y hay parámetros de fallback configurados, intentar con ellos
                if (response.status === 200 && response.data?.total === 0 && PDQM_IDENTIFIER_FALLBACK_PARAM_NAMES) {
                    const fallbackParams = arr(PDQM_IDENTIFIER_FALLBACK_PARAM_NAMES);

                    for (const param of fallbackParams) {
                        url = joinUrl(base, '/Patient') + `?${param}=${robustUrlEncode(identifierValue)}`;
                        console.log(`PDQm fallback GET: ${url}`);

                        response = await axios.get(url, config);

                        if (response.status === 200 && response.data?.resourceType === 'Bundle' && response.data.total > 0) {
                            console.log(`✅ PDQm fallback response: ${response.data.total} patients found with param ${param}`);
                            return response.data;
                        }
                    }
                }

                // Manejar códigos de estado específicos
                if (response.status === 401 || response.status === 403) {
                    if (isTrue(PDQM_ENABLE_FALLBACK_FOR_401_403)) {
                        console.warn(`PDQm auth error (${response.status}), generating fallback bundle`);
                        return generateFallbackBundle(identifierValue);
                    } else {
                        console.error(`PDQm auth error (${response.status}), no fallback enabled`);
                        return null;
                    }
                }

                // Verificar si debemos reintentar basado en el estado HTTP
                const fallbackStatuses = arr(PDQM_FALLBACK_HTTP_STATUSES || '404,400');
                if (fallbackStatuses.includes(response.status.toString())) {
                    console.warn(`PDQm response status ${response.status}, will retry or fallback`);

                    if (currentAttempt >= maxAttempts) {
                        console.warn(`Max attempts reached, generating fallback bundle`);
                        return generateFallbackBundle(identifierValue);
                    }

                    // Esperar antes del siguiente intento
                    await new Promise(resolve => setTimeout(resolve, 1000 * currentAttempt));
                    continue;
                }

                // Si llegamos aquí, retornar los datos obtenidos (aunque sean vacíos)
                return response.data;

            } catch (error) {
                console.error(`PDQm error (attempt ${currentAttempt}):`, error.message);

                // Decidir si reintentar o generar fallback
                if (currentAttempt >= maxAttempts) {
                    console.warn('Max attempts reached, generating fallback bundle');
                    return generateFallbackBundle(identifierValue);
                }

                // Esperar antes del siguiente intento
                await new Promise(resolve => setTimeout(resolve, 1000 * currentAttempt));
            }
        }

        return null;
    }

    function isPdqmFallbackBundle(bundle) {
        return bundle?.entry?.[0]?.resource?.meta?.tag?.some(tag =>
            tag.code === 'pdqm-fallback'
        ) === true;
    }


    try {
      // ========= Paso opcional 1: PDQm =========
      if (isTrue(FEATURE_PDQ_ENABLED)) {
          const patientEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Patient');
          const localPatient = patientEntry?.resource;

          if (localPatient) {
              // Extraer identifiers y ordenarlos por preferencia
              // Solo viene el RUN, no trae más identifier
              const ids = Array.isArray(localPatient.identifier) ? localPatient.identifier : [];

              let idCandidates = pickIdentifiersOrderedForPdqm(ids);
              console.log('PDQm: candidatos ordenados =>', idCandidates.join(' , '));

              // Expandir RUN*: probar [RUN*XXXX, XXXX] y evitar duplicados
              const expandRun = (v) => (typeof v === 'string' && /^RUN\*/i.test(v))
                  ? [v, v.replace(/^RUN\*/i, '')]
                  : [v];
              idCandidates = idCandidates.flatMap(expandRun)
                  .filter((v, i, a) => a.indexOf(v) === i);

              // Empujar al final cualquier value que contenga '*'
              const starScore = (v) => (/\*/.test(String(v)) ? 1 : 0);
              idCandidates.sort((a, b) => starScore(a) - starScore(b));

              let pdqmBundle = null;

              if (idCandidates.length) {
                  for (const cand of idCandidates) {
                      try {
                          console.log(`PDQm: buscando por identifier=${cand}`);
                          const tryBundle = await pdqmFetchBundleByIdentifier(cand);
                          const hasHits = !!tryBundle && (
                              (Array.isArray(tryBundle.entry) && tryBundle.entry.length > 0) ||
                              (typeof tryBundle.total === 'number' && tryBundle.total > 0)
                          );
                          if (hasHits) {
                              pdqmBundle = tryBundle;
                              console.log(`PDQm: resultados encontrados con identifier=${cand}`);
                              break;
                          } else {
                              console.log(`PDQm: sin resultados con identifier=${cand}`);
                          }
                      } catch (e) {
                          console.log(`PDQm: error buscando identifier=${cand} → ${e?.message || e}`);
                      }
                  }
              }

              if (pdqmBundle?.resourceType === 'Bundle' && Array.isArray(pdqmBundle.entry) && pdqmBundle.entry.length > 0) {
                  // Guardar para trazabilidad/debug
                  try {
                      const pdqmFile = path.join(debugDir, `pdqmBundle_${Date.now()}.json`);
                      fs.writeFileSync(pdqmFile, JSON.stringify(pdqmBundle, null, 2));
                      console.log('DEBUG: saved PDQm bundle (no replace) →', pdqmFile);
                  } catch (err) {
                      console.warn('⚠️ No se pudo guardar PDQm bundle en disco:', err.message);
                  }

                  // Marcar si es un bundle sintético de fallback
                  if (isPdqmFallbackBundle(pdqmBundle)) {
                      console.warn('⚠️ PDQm bundle es fallback sintético; se ignora (sin reemplazo)');
                  }

                  // Dejar disponible para uso posterior (p. ej. adjuntar como Binary/DocumentReference)
                  req._pdqmBundle = pdqmBundle;
              } else {
                  console.warn('ℹ️ PDQm: sin resultados con ningún identificador de los candidatos');
              }
          } else {
              console.warn('ℹ️ PDQm: no se encontró recurso Patient en el summaryBundle');
          }
      }

    // ========= Paso opcional 2: Terminología por dominio =========
    await normalizeTerminologyInBundle(summaryBundle);

    // ========= Resto del flujo ITI-65 =========
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    // Asegurar ID de Bundle
    let originalBundleId = summaryBundle.id;
    if (!originalBundleId) {
      originalBundleId = uuidv4();
      summaryBundle.id = originalBundleId;
    }
    const bundleUrn = `urn:uuid:${originalBundleId}`;

    // Tamaño y hash del resumen
    const bundleString = JSON.stringify(summaryBundle);
    const bundleSize = Buffer.byteLength(bundleString, 'utf8');
    const bundleHash = crypto.createHash('sha256').update(bundleString).digest('base64');

    // FIX #1 — Bundle profile genérico
    // summaryBundle.meta = summaryBundle.meta || {};
    // summaryBundle.meta.profile = ['http://hl7.org/fhir/StructureDefinition/Bundle'];

    // FIX #2 — Remover profiles en entries vacíos
    // summaryBundle.entry.forEach(entry => {
    //   const res = entry.resource;
    //   if (res?.meta) {
    //     if (res.meta.profile) delete res.meta.profile;
    //     if (Object.keys(res.meta).length === 0) delete res.meta;
    //   }
    // });

    // FIX #3 — Sanitize UV/IPS en meds/vacunas
    summaryBundle.entry.forEach(entry => {
      const res = entry.resource;
      if (res?.resourceType === 'MedicationStatement' && res.medicationCodeableConcept?.coding) {
        res.medicationCodeableConcept.coding.forEach(c => delete c.system);
      }
      if (res?.resourceType === 'Immunization' && res.vaccineCode?.coding) {
        res.vaccineCode.coding.forEach(c => delete c.system);
      }
    });

    // URN map para referencias internas
    const urlMap = new Map();
      summaryBundle.entry.forEach(entry => {
      const { resource } = entry;
      const urn = `${FHIR_NODO_NACIONAL_SERVER}/fhir/${resource.resourceType}/${resource.id}`;
      urlMap.set(`${resource.resourceType}/${resource.id}`, urn);
      });


    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');

    if (compositionEntry) {
      compositionEntry.resource.subject.reference = urlMap.get(`Patient/${patientEntry.resource.id}`);
      compositionEntry.resource.section?.forEach(section => {
        section.entry?.forEach(item => {
          if (urlMap.has(item.reference)) item.reference = urlMap.get(item.reference);
        });
      });
    }
    summaryBundle.entry.forEach(entry => {
      const res = entry.resource;
      if (res.subject?.reference && urlMap.has(res.subject.reference)) {
        res.subject.reference = urlMap.get(res.subject.reference);
      }
      if (res.patient?.reference && urlMap.has(res.patient.reference)) {
        res.patient.reference = urlMap.get(res.patient.reference);
      }
    });

    // SubmissionSet
    const submissionSet = {
      resourceType: 'List',
      id: ssId,
      text: {
        status: 'extensions',
        div: `<div xmlns="http://www.w3.org/1999/xhtml">SubmissionSet para el paciente ${patientEntry.resource.id}</div>`
      },
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.SubmissionSet'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      extension: [{
        url: 'https://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-sourceId',
        valueIdentifier: { value: bundleUrn }
      }],
      identifier: [{ use: 'usual', system: 'urn:ietf:rfc:3986', value: `urn:oid:${ssId}` }],
      status: 'current',
      mode: 'working',
      code: { coding: [{ system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }] },
      subject: { reference: urlMap.get(`Patient/${patientEntry.resource.id}`) },
      date: summaryBundle.timestamp,
      entry: [{ item: { reference: `urn:uuid:${drId}` } }]
    };

    // DocumentReference
    const documentReference = {
      resourceType: 'DocumentReference',
      id: drId,
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.DocumentReference'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      text: {
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">Resumen clínico en formato DocumentReference</div>'
      },
      masterIdentifier: { system: 'urn:ietf:rfc:3986', value: bundleUrn },
      status: 'current',
      type: compositionEntry.resource.type,
      subject: { reference: urlMap.get(`Patient/${patientEntry.resource.id}`) },
      date: summaryBundle.timestamp,
      content: [{
        attachment: {
          contentType: 'application/fhir+json',
          url: bundleUrn,
          size: bundleSize,
          hash: bundleHash
        },
        format: {
          system: 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode',
          code: 'urn:ihe:iti:xds-sd:text:2008'
        }
      }]
    };

    // ProvideBundle (transaction)
    const provideBundle = {
      resourceType: 'Bundle',
      id: uuidv4(),
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.ProvideBundle'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      type: 'transaction',
      timestamp: now,
      entry: [
        { fullUrl: `urn:uuid:${ssId}`, resource: submissionSet, request: { method: 'POST', url: 'List' } },
        { fullUrl: `urn:uuid:${drId}`, resource: documentReference, request: { method: 'POST', url: 'DocumentReference' } },
        { fullUrl: bundleUrn, resource: summaryBundle, request: { method: 'POST', url: 'Bundle' } },
        { fullUrl: urlMap.get(`Patient/${patientEntry.resource.id}`), resource: patientEntry.resource, request: { method: 'PUT', url: `Patient/${patientEntry.resource.id}` } }
      ]
    };

    // Debug + envío
    console.log('DEBUG: Sending ProvideBundle to', FHIR_NODO_NACIONAL_SERVER);
    const debugFile = path.join(debugDir, `provideBundle_${Date.now()}.json`);
    fs.writeFileSync(debugFile, JSON.stringify(provideBundle, null, 2));
    console.log('DEBUG: saved →', debugFile);

    const resp = await axios.post(FHIR_NODO_NACIONAL_SERVER, provideBundle, {
      headers: { 'Content-Type': 'application/fhir+json' },
      validateStatus: false
    });
    console.log(`⇒ ITI-65 sent, status ${resp.status}`);
    return res.json({ status: 'sent', code: resp.status });

  } catch (e) {
    console.error('❌ ERROR ITI-65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.LACPASS_ITI65_PORT_ICVP || 8011;
app.listen(PORT, () => console.log(`LACPASS→ITI65 icvp Mediator listening on port ${PORT}`));
