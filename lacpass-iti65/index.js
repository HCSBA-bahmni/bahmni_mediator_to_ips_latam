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
  SUMMARY_PROFILE,
  FHIR_NODO_NACIONAL_SERVER,

  NODE_ENV,
  DEBUG_DIR_icvp,

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

  // Nuevo: configuración para formatCode
  MHD_FORMAT_CODE = 'urn:ihe:iti:xds-sd:text:2008', // Default IHE para FHIR JSON
  
  // Debug level para ops terminológicas
  TS_DEBUG_LEVEL = 'warn', // 'debug', 'warn', 'error', 'silent'
} = process.env;

const isTrue = (v) => String(v).toLowerCase() === 'true';
const arr = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// ===================== Debug dir =====================
const debugDir = DEBUG_DIR_icvp ? path.resolve(DEBUG_DIR_icvp) : '/tmp';
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

app.get('/lacpass/_health', (_req, res) => res.status(200).send('OK'));


// Middleware simple de correlación
app.use((req, _res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || uuidv4();
  console.log(`[${req.correlationId}] ${req.method} ${req.originalUrl}`);
  next();
});

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

// ITI-65: nueva función que trae el BUNDLE PDQm completo
async function pdqmFetchBundleByIdentifier(identifierValue) {
  if (!identifierValue || !PDQM_FHIR_URL) return null;
  //if (PDQM_DEFAULT_IDENTIFIER_SYSTEM && !String(identifierValue).includes('|')) {
  //  identifierValue = `${PDQM_DEFAULT_IDENTIFIER_SYSTEM}|${identifierValue}`;
  //}
  if (PDQM_DEFAULT_IDENTIFIER_SYSTEM) {
   const s = String(identifierValue);
   const normalized = s.includes('|') ? s : `${PDQM_DEFAULT_IDENTIFIER_SYSTEM}|${s}`;
   identifierValue = normalized;
 }
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
    return resp.data || null; // Bundle
  } catch {
    return null;
  }
}

// Helper: reemplaza el Patient del summaryBundle por el del Bundle PDQm
function replacePatientFromPdqmBundle(summaryBundle, pdqmBundle) {
  if (!summaryBundle?.entry || !pdqmBundle?.entry) return false;
  const pdqmPatient = pdqmBundle.entry.find(e => e.resource?.resourceType === 'Patient')?.resource;
  if (!pdqmPatient) return false;
  const idx = summaryBundle.entry.findIndex(e => e.resource?.resourceType === 'Patient');
  if (idx < 0) return false;
  summaryBundle.entry[idx].resource = pdqmPatient; // ← reemplazo 1:1
  return true;
}


function pickSnomedCoding(cc, domainCfg) {
  if (!cc?.coding || !Array.isArray(cc.coding)) return null;
  // 1) Prioriza exactamente SNOMED
  const snomed = cc.coding.find(c => c.system === 'http://snomed.info/sct' && c.code);
  if (snomed) return snomed;
  // 2) (opcional) si definiste otro codeSystem por dominio, úsalo
  const alt = domainCfg?.codeSystem
    ? cc.coding.find(c => c.system === domainCfg.codeSystem && c.code)
    : null;
  if (alt) return alt;
  // 3) No hay system → no haces validate/lookup
  return null;
}




function buildPipeline(domain, ts, base, domainCfg) {
  if (domain === 'vaccines') {
    // Solo translate para vacunas
    return [ () => opTranslate(ts, base, domainCfg) ];
  }
  // Para conditions/procedures/allergies/medications → validate VS, validate CS, lookup
  return [
    () => opValidateVS(ts, base, domainCfg),
    () => opValidateCS(ts, base, domainCfg),
    () => opLookup(ts, base),
    // opcional: () => opExpand(ts, base, domainCfg),
  ];
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

function pickIdentifierValueForPdqm(identifiers = []) {
  const wantText = (process.env.PDQM_IDENTIFIER_TYPE_TEXT_PASSPORT || 'Pasaporte').toLowerCase();
  const wantCode = process.env.PDQM_IDENTIFIER_TYPE_CODE_PASSPORT;

  const byText = identifiers.find(i => (i.type?.text || '').toLowerCase() === wantText);
  if (byText?.value) return byText.value;

  if (wantCode) {
    const byCode = identifiers.find(i =>
      Array.isArray(i.type?.coding) && i.type.coding.some(c => c.code === wantCode)
    );
    if (byCode?.value) return byCode.value;
  }

  if (PDQM_DEFAULT_IDENTIFIER_SYSTEM) {
    const bySystem = identifiers.find(i => i.system === PDQM_DEFAULT_IDENTIFIER_SYSTEM);
    if (bySystem?.value) return bySystem.value;
  }

  return identifiers[0]?.value || null; // último fallback
}

// ===================== Terminology Ops (funciones) =====================
async function opValidateVS(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_VALIDATE_VS_ENABLED)) return null;
  if (!domainCfg?.vsValidate) return null;
  
  try {
    const params = { url: domainCfg.vsValidate, code };
    if (system) params.system = system;
    if (display) params.display = display;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;
    
    tsLog('debug', `Validating VS: ${domainCfg.vsValidate} | ${system}|${code}`);
    
    const { data } = await ts.get('/ValueSet/$validate-code', { params });
    const ok = extractResultFromParameters(data);
    
    if (ok.result) {
      tsLog('debug', `✅ VS validation OK: ${code} -> ${ok.display || display}`);
      return { system: system, code, display: ok.display || display, source: 'validate-vs' };
    } else {
      tsLog('debug', `❌ VS validation failed: ${system}|${code}`);
    }
  } catch (e) {
    tsLog('warn', `VS validation error: ${e.response?.status} ${e.message}`, { system, code });
  }
  return null;
}

async function opValidateCS(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_VALIDATE_CS_ENABLED)) return null;
  const url = domainCfg?.codeSystem || system;
  if (!url || !code) return null;

  try {
    const params = { url, code };
    const version = domainCfg?.codeSystemVersion || process.env.TS_SNOMED_VERSION;

    if (version) params.version = version;
    if (display) params.display = display;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

    tsLog('debug', `Validating CS: ${url} | ${code}`);

    const { data } = await ts.get('/CodeSystem/$validate-code', { params });
    const ok = extractResultFromParameters(data);
    
    if (ok.result) {
      tsLog('debug', `✅ CS validation OK: ${code} -> ${ok.display || display}`);
      return { system: url, code, display: ok.display || display, source: 'validate-cs' };
    } else {
      tsLog('debug', `❌ CS validation failed: ${url}|${code}`);
    }
  } catch (e) {
    tsLog('warn', `CS validation error: ${e.response?.status} ${e.message}`, { system: url, code });
  }
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
async function opLookup(ts, { code, system, display }, domainCfg) {
  if (!system || !code) return null;

  try {
    const params = { system, code };
    const version = domainCfg?.codeSystemVersion || process.env.TS_SNOMED_VERSION;

    if (version) params.version = version;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

    tsLog('debug', `Looking up: ${system}|${code}`);

    const { data } = await ts.get('/CodeSystem/$lookup', { params });
    const disp = extractDisplayFromLookup(data);
    
    if (disp) {
      tsLog('debug', `✅ Lookup OK: ${code} -> ${disp}`);
      return { system, code, display: disp, source: 'lookup' };
    } else {
      tsLog('debug', `❌ Lookup no display: ${system}|${code}`);
    }
  } catch (e) {
    tsLog('warn', `Lookup error: ${e.response?.status} ${e.message}`, { system, code });
  }
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

  const hasConfig = params.url || params.source || params.target || params.targetsystem;
  if (!hasConfig) {
    tsLog('debug', `Translate skipped - no config: ${system}|${code}`);
    return null;
  }

  try {
    tsLog('debug', `Translating: ${system}|${code} -> ${params.targetsystem}`);
    
    const { data } = await ts.get('/ConceptMap/$translate', { params });
    const match = extractMatchFromTranslate(data);
    
    if (match?.system && match?.code) {
      tsLog('debug', `✅ Translate OK: ${code} -> ${match.system}|${match.code}`);
      return { system: match.system, code: match.code, display: match.display || display || code, source: 'translate' };
    } else {
      tsLog('debug', `❌ Translate no match: ${system}|${code}`);
    }
  } catch (e) {
    tsLog('warn', `Translate error: ${e.response?.status} ${e.message}`, { system, code });
  }
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

// Helper util
function isPdqmFallbackBundle(bundle) {
  const tags = bundle?.meta?.tag || [];
  return Array.isArray(tags) && tags.some(t =>
    t.system === 'urn:pdqm:fallback' && t.code === 'synthetic'
  );
}

// Helper: actualiza todas las referencias en un objeto recursivamente
function updateReferencesInObject(obj, urlMap) {
  if (!obj || typeof obj !== 'object') return;

  // Si es un array, procesar cada elemento
  if (Array.isArray(obj)) {
    obj.forEach(item => updateReferencesInObject(item, urlMap));
    return;
  }

  // Si tiene propiedad 'reference', actualizarla
  if (obj.reference && typeof obj.reference === 'string') {
    const mapped = urlMap.get(obj.reference);
    if (mapped) {
      obj.reference = mapped;
    }
  }

  // Recursivamente procesar todas las propiedades
  for (const key in obj) {
    if (obj.hasOwnProperty(key) && key !== 'reference') {
      updateReferencesInObject(obj[key], urlMap);
    }
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
async function normalizeCC(ts, cc, domainCfg, domain) {
  if (!cc?.coding || !Array.isArray(cc.coding) || cc.coding.length === 0) return;

  const target = pickSnomedCoding(cc, domainCfg);
  if (!target) {
    // No hay coding con system SNOMED (u otro codeSystem del dominio) → no validar/lookup
    // Para vaccines igual haremos translate (si procede) usando el texto/código que haya.
  }

  // Base para las operaciones
  const base = target
    ? { system: target.system, code: target.code, display: target.display || cc.text }
    : { system: undefined, code: undefined, display: cc.text };

  const steps = buildPipeline(domain, ts, base, domainCfg);

  for (const step of steps) {
    const out = await step();
    if (out && out.code) {
      // Solo actualiza el coding que seleccionaste (SNOMED), no “el primero”
      if (target) {
        target.system = out.system || target.system;
        target.code = out.code;
        target.display = out.display || target.display || cc.text;
      } else {
        // Si no había coding seleccionado (p. ej. vaccines con solo texto) y el paso devuelve algo
        // agrega un nuevo coding con lo resuelto (útil para $translate en vaccines)
        cc.coding.unshift({
          system: out.system,
          code: out.code,
          display: out.display || cc.text
        });
      }
      return;
    }
  }
}

async function normalizeTerminologyInBundle(bundle) {
  if (!isTrue(FEATURE_TS_ENABLED)) return;
  const ts = buildTsClient();
  if (!ts || !bundle?.entry?.length) return;

  console.log('🔍 Iniciando normalización terminológica con enfoque SNOMED...');

  for (const entry of bundle.entry) {
    const res = entry.resource;
    if (!res) continue;

    // Saltar inmunizaciones del proceso de conversión a SNOMED
    if (res.resourceType === 'Immunization') {
      console.log(`⏭️ Saltando ${res.resourceType} - mantiene códigos originales`);
      continue;
    }

    // Determinar dominio
    const domain = resourceToDomain(res);
    const domainCfg = DOMAIN_CONFIG[domain] || DOMAIN_CONFIG[TS_DEFAULT_DOMAIN] || {};

    console.log(`🔄 Procesando ${res.resourceType} (dominio: ${domain})`);

    // Normalizar todas las CC relevantes del recurso
    for (const { path, cc } of iterateCodeableConcepts(res)) {
      try {
        console.log(`  └─ Normalizando ${path}:`, cc.coding?.map(c => `${c.system}|${c.code}`) || ['sin códigos']);
        await normalizeCC(ts, cc, domainCfg, domain, res.resourceType);
      } catch (e) {
        console.warn(`⚠️ TS normalize error (${domain}.${path}):`, e.message);
      }
    }
  }

  console.log('✅ Normalización terminológica completada');
}

// Función para corregir el Bundle antes del envío
function fixBundleValidationIssues(summaryBundle) {
  // 1. Asegurar que el Composition tenga custodian (requerido por el perfil lac-composition)
  const compositionEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Composition');
  if (compositionEntry?.resource && !compositionEntry.resource.custodian) {
    // Buscar Organization para usar como custodian
    const orgEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Organization');
    if (orgEntry) {
      compositionEntry.resource.custodian = {
        reference: orgEntry.fullUrl || `Organization/${orgEntry.resource.id}`
      };
    }
  }

  // 2. Corregir sección "Historial de Enfermedades Pasadas" 
  if (compositionEntry?.resource?.section) {
    const pastIllnessSection = compositionEntry.resource.section.find(s => 
      s.code?.coding?.some(c => c.code === '11348-0')
    );
    
    if (pastIllnessSection) {
      // Agregar div requerido al text.div
      if (pastIllnessSection.text && !pastIllnessSection.text.div) {
        pastIllnessSection.text.div = '<div xmlns="http://www.w3.org/1999/xhtml"><h5>Historial de Enfermedades Pasadas</h5><p>Condiciones médicas previas del paciente.</p></div>';
      }
      
      // Corregir display del código LOINC
      const loincCoding = pastIllnessSection.code.coding.find(c => c.system === 'http://loinc.org' && c.code === '11348-0');
      if (loincCoding && loincCoding.display === 'History of Past illness Narrative') {
        loincCoding.display = 'History of Past illness note';
      }
    }
  }

  // 3. Corregir identifiers del Patient - agregar system a los coding sin system
  const patientEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Patient');
  if (patientEntry?.resource?.identifier) {
    patientEntry.resource.identifier.forEach(identifier => {
      if (identifier.type?.coding) {
        identifier.type.coding.forEach(coding => {
          if (!coding.system) {
            // Asignar system por defecto para identifier types
            coding.system = 'http://terminology.hl7.org/CodeSystem/v2-0203';
            
            // Mapear códigos conocidos
            const codeMap = {
              'd3153eb0-5e07-11ef-8f7c-0242ac120002': 'MR', // Medical Record Number
              'a2551e57-6028-428b-be3c-21816c252e06': 'PPN' // Passport Number
            };
            
            if (codeMap[coding.code]) {
              coding.code = codeMap[coding.code];
            }
          }
        });
      }
    });
  }

  // 4. Corregir address.country del Patient para cumplir ISO 3166
  if (patientEntry?.resource?.address) {
    patientEntry.resource.address.forEach(addr => {
      if (addr.country === 'Chile') {
        addr.country = 'CL'; // Código ISO 3166-1 alpha-2
      }
    });
  }

  // 5. Corregir Conditions - agregar system a los coding que no lo tienen
  summaryBundle.entry?.forEach(entry => {
    if (entry.resource?.resourceType === 'Condition' && entry.resource.code?.coding) {
      entry.resource.code.coding.forEach(coding => {
        if (!coding.system && coding.code) {
          // Si el código parece ser de OpenMRS (termina en AAAAAA...), usar sistema local
          if (coding.code.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')) {
            coding.system = 'http://openmrs.org/concepts';
          }
        }
      });
    }
  });

  // 6. Corregir MedicationStatement - agregar system y effective[x]
  summaryBundle.entry?.forEach(entry => {
    if (entry.resource?.resourceType === 'MedicationStatement') {
      // Agregar system a medicationCodeableConcept.coding
      if (entry.resource.medicationCodeableConcept?.coding) {
        entry.resource.medicationCodeableConcept.coding.forEach(coding => {
          if (!coding.system) {
            coding.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
          }
        });
      }
      
      // Agregar effective[x] requerido por el perfil IPS
      if (!entry.resource.effectiveDateTime && !entry.resource.effectivePeriod) {
        entry.resource.effectiveDateTime = new Date().toISOString();
      }
    }
  });

  // 7. Asegurar que todas las referencias internas estén en el Bundle
  const allFullUrls = new Set(summaryBundle.entry?.map(e => e.fullUrl) || []);
  
  summaryBundle.entry?.forEach(entry => {
    // Revisar todas las referencias en el recurso
    checkAndFixReferences(entry.resource, allFullUrls, summaryBundle);
  });
}

// Función auxiliar para verificar y corregir referencias
function checkAndFixReferences(obj, availableUrls, bundle) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach(item => checkAndFixReferences(item, availableUrls, bundle));
    return;
  }

  // Si tiene propiedad 'reference', verificar que existe
  if (obj.reference && typeof obj.reference === 'string') {
    if (!availableUrls.has(obj.reference)) {
      // Si la referencia no existe, intentar encontrar el recurso por ID
      const parts = obj.reference.split('/');
      const resourceType = parts[parts.length - 2];
      const resourceId = parts[parts.length - 1];
      
      const foundEntry = bundle.entry?.find(e => 
        e.resource?.resourceType === resourceType && 
        e.resource?.id === resourceId
      );
      
      if (foundEntry) {
        obj.reference = foundEntry.fullUrl;
      }
    }
  }

  // Recursivamente procesar todas las propiedades
  for (const key in obj) {
    if (obj.hasOwnProperty(key) && key !== 'reference') {
      checkAndFixReferences(obj[key], availableUrls, bundle);
    }
  }
}

// En la ruta ITI-65, después de obtener el summaryBundle y antes de la terminología:
app.post('/lacpass/_iti65', async (req, res) => {
  let summaryBundle;

  // 1) Obtener $summary si viene uuid; si no, usar el Bundle entregado
  if (req.body.uuid) {
    try {
      const resp = await axios.get(
        `${FHIR_NODE_URL}/Patient/${req.body.uuid}/$summary`,
        { params: { profile: SUMMARY_PROFILE }, httpsAgent: axios.defaults.httpsAgent }
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

  try {
    // ========= NUEVO: Corregir problemas de validación ANTES de PDQm =========
    fixBundleValidationIssues(summaryBundle);

    // ========= Paso opcional 1: PDQm =========
    if (isTrue(FEATURE_PDQ_ENABLED)) {
      const patientEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Patient');
      const localPatient = patientEntry?.resource;

      if (localPatient) {
        const ids = Array.isArray(localPatient.identifier) ? localPatient.identifier : [];
        const idValue = pickIdentifierValueForPdqm(ids);

        // Trae el BUNDLE PDQm completo (no reemplaza Patient local)
        const pdqmBundle = await pdqmFetchBundleByIdentifier(idValue);

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
          console.warn('ℹ️ PDQm: sin resultados para el identificador:', idValue);
        }
      } else {
        console.warn('ℹ️ PDQm: no se encontró recurso Patient en el summaryBundle');
      }
    }
  } catch (e) {
    console.warn('⚠️ Error no crítico en paso PDQm (se continúa sin bloquear ITI-65):', e.message);
  }

  try {
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
        console.log(`⚠️ Removing system from MedicationStatement.medicationCodeableConcept (IPS requirement)`);
        res.medicationCodeableConcept.coding.forEach(c => delete c.system);
      }
      if (res?.resourceType === 'Immunization' && res.vaccineCode?.coding) {
        console.log(`⚠️ Removing system from Immunization.vaccineCode (IPS requirement) - verify repository validation`);
        res.vaccineCode.coding.forEach(c => delete c.system);
      }
    });

    // URN map para referencias internas
    const urlMap = new Map();
    summaryBundle.entry.forEach(entry => {
      const { resource } = entry;
      const fullUrl = `${FHIR_NODO_NACIONAL_SERVER}/${resource.resourceType}/${resource.id}`;
      urlMap.set(`${resource.resourceType}/${resource.id}`, fullUrl);
    });

    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');

    // Actualizar TODAS las referencias en el summaryBundle recursivamente
    summaryBundle.entry.forEach(entry => {
      updateReferencesInObject(entry.resource, urlMap);
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
          code: MHD_FORMAT_CODE, // ← Configurable
          display: MHD_FORMAT_CODE === 'urn:ihe:iti:xds-sd:text:2008' ? 'FHIR JSON Document' : undefined
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
      //headers: { 'Content-Type': 'application/fhir+json' },
      headers: {
        'Content-Type': 'application/fhir+json',
        'X-Correlation-ID': req.correlationId
      },

      validateStatus: false
    });
    //console.log(`⇒ ITI-65 sent, status ${resp.status}`);
    console.log(`[${req.correlationId}] ⇒ ITI-65 sent, status ${resp.status}`);

    return res.json({ status: 'sent', code: resp.status });

  } catch (e) {
    console.error('❌ ERROR ITI-65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.LACPASS_ITI65_PORT || 8005;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
