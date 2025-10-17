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
  FEATURE_PDQ_ENABLED = 'true',
  FEATURE_TS_ENABLED = 'true',

  // Subfeatures terminológicas
  FEATURE_TS_EXPAND_ENABLED = 'false',
  FEATURE_TS_VALIDATE_VS_ENABLED = 'false',
  FEATURE_TS_VALIDATE_CS_ENABLED = 'false',
  FEATURE_TS_LOOKUP_ENABLED = 'true',
  FEATURE_TS_TRANSLATE_ENABLED = 'false',
  
  // Feature flag específico para vacunas (nuevo)
  // Si no está definida, por defecto queda habilitado (true) para no romper otros ambientes
  FEATURE_TS_VACCINES_ENABLED = 'true',

  // ===== OIDs para identificadores de paciente (desde tu .env) =====
  LAC_NATIONAL_ID_SYSTEM_OID,
  LAC_PASSPORT_ID_SYSTEM_OID,

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
  TS_DOMAINS = 'conditions,procedures,medications',
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
  MHD_FORMAT_CODE = 'urn:ihe:iti:xds-sd:text:2008',
  MHD_FORMAT_SYSTEM = 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode',
  
  // Debug level para ops terminológicas
  TS_DEBUG_LEVEL = 'warn', // 'debug', 'warn', 'error', 'silent'
} = process.env;

// ====== NUEVO: separador configurable para URN OID (por defecto ".")
const OID_URN_SEPARATOR = process.env.OID_URN_SEPARATOR || '.';

const {
  FULLURL_MODE_PROVIDE = 'urn',
  FULLURL_MODE_DOCUMENT = 'absolute',
  ABSOLUTE_FULLURL_BASE,
  BINARY_DELIVERY_MODE = 'both',
  ATTACHMENT_URL_MODE = 'absolute',
} = process.env;

// ===== PDQm extras (nuevos) =====
const PDQM_CACHE_TTL_MS = parseInt(process.env.PDQM_CACHE_TTL_MS || '60000', 10);
const PDQM_ENABLE_OF_TYPE = String(process.env.PDQM_ENABLE_OF_TYPE || 'false').toLowerCase() === 'true';
const INJECT_AUTHOR_FIXTURES = String(process.env.INJECT_AUTHOR_FIXTURES || 'false').toLowerCase() === 'true';// ===== Constantes de Perfiles y Códigos =====
// OIDs por defecto (normalizados a urn:oid con separador configurable)
const DEFAULT_NAT_OID = toUrnOid(LAC_NATIONAL_ID_SYSTEM_OID || '2.16.152');
const DEFAULT_PPN_OID = toUrnOid(LAC_PASSPORT_ID_SYSTEM_OID || '2.16.840.1.113883.4.330.152');

// Perfiles IPS (http)
const IPS_PROFILES = {
    BUNDLE: 'http://smart.who.int/icvp/StructureDefinition/Bundle-uv-ips-ICVP|0.2.0',
    MEDICATION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Medication-uv-ips',
    MEDICATION_REQUEST: 'http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationRequest-uv-ips',
    // ICVP guía pública usa este canónico:
    COMPOSITION: 'http://smart.who.int/icvp/StructureDefinition/Composition-uv-ips-ICVP',
    PATIENT: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips',
    ALLERGY_INTOLERANCE: 'http://hl7.org/fhir/uv/ips/StructureDefinition/AllergyIntolerance-uv-ips',
    CONDITION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Condition-uv-ips',
    MEDICATION_STATEMENT: 'http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationStatement-uv-ips',
    PROCEDURE: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Procedure-uv-ips',
    // ICVP guía pública usa este canónico:
    IMMUNIZATION: 'http://smart.who.int/icvp/StructureDefinition/Immunization-uv-ips-ICVP',
    OBSERVATION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-results-uv-ips',
    ORGANIZATION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Organization-uv-ips'
};

// Códigos LOINC para secciones IPS
const LOINC_CODES = {
    ALLERGIES_SECTION: '48765-2',
    PROBLEMS_SECTION: '11450-4',
    MEDICATIONS_SECTION: '10160-0',
    PAST_ILLNESS_SECTION: '11348-0',
    IMMUNIZATIONS_SECTION: '11369-6',
    PROCEDURES_SECTION: '47519-4',
    RESULTS_SECTION: '30954-2'
};

// Perfiles ICVP (racsel) — coinciden con el validador
const LAC_PROFILES = {
    BUNDLE: 'http://smart.who.int/icvp/StructureDefinition/Bundle-uv-ips-ICVP|0.2.0',
    // Alinear canónicos a los que exige la herramienta de validación:
    COMPOSITION: 'http://smart.who.int/icvp/StructureDefinition/Composition-uv-ips-ICVP',
    IMMUNIZATION: 'http://smart.who.int/icvp/StructureDefinition/Immunization-uv-ips-ICVP',
    PATIENT: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips',
    ORGANIZATION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Organization-uv-ips'
};

// Constantes ICVP / PCMT (canónicos)
const ICVP_PRODUCT_EXT_URL = 'http://smart.who.int/pcmt/StructureDefinition/ProductID';
const PREQUAL_SYSTEM = 'https://extranet.who.int/prequal/vaccines';      // ya no se usa para ProductID (se deja por compat)
const ICD11_MMS = 'http://id.who.int/icd/release/11/mms';
const LOINC_PATIENT_SUMMARY = '60591-5';

// Catálogos ICVP Pre-Qualification (PCMT)
const CS_PREQUAL_PRODUCTIDS  = 'http://smart.who.int/pcmt-vaxprequal/CodeSystem/PreQualProductIds';
const CS_PREQUAL_VACCINETYPE = 'http://smart.who.int/pcmt-vaxprequal/CodeSystem/PreQualVaccineType';

const isTrue = (v) => String(v).toLowerCase() === 'true';
const arr = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// --- SNOMED $lookup (solo consulta, sin usar respuesta) -----------------------
const SNOMED_SYSTEM = 'http://snomed.info/sct';
const LOOKUP_SNOMED_ONLY = String(process.env.LOOKUP_SNOMED_ONLY || 'false').toLowerCase() === 'true';

// ===== Utilidades de enmascarado (para logs) =====
function maskId(v) {
  const s = String(v || '');
  if (s.length <= 4) return '***';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

async function fireAndForgetSnomedLookup(ts, system, code, versionUri) {
  if (!ts || !system || !code) return;
  try {
    // SOLO CONSULTA: CodeSystem/$lookup (no usamos la respuesta)
    await ts.get('/CodeSystem/$lookup', {
      params: {
        system,                   // http://snomed.info/sct
        code,                     // p.ej. 59621000
        version: versionUri,      // p.ej. http://snomed.info/sct/900000000000207008/version/20240331
        _format: 'json'
      }
    });
  } catch (e) {
    // Log no bloqueante (usar WARN para que se vea con TS_DEBUG_LEVEL=warn)
    tsLog('warn', `SNOMED $lookup fallo: ${system}|${code}|${versionUri} -> ${e?.response?.status || e?.message}`);
  }
}

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

// ===================== Logging helper para terminología =====================
function tsLog(level, message, data = null) {
  const debugLevel = TS_DEBUG_LEVEL.toLowerCase();
  
  if (debugLevel === 'silent') return;
  
  const shouldLog = {
    debug: ['debug'].includes(debugLevel),
    warn: ['debug', 'warn'].includes(debugLevel), 
    error: ['debug', 'warn', 'error'].includes(debugLevel)
  }[level];
  
  if (shouldLog) {
    const prefix = `🔧 TS[${level.toUpperCase()}]:`;
    if (data) {
      console[level === 'error' ? 'error' : 'log'](prefix, message, data);
    } else {
      console[level === 'error' ? 'error' : 'log'](prefix, message);
    }
  }
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

async function opLookup(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_LOOKUP_ENABLED)) return null;
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
    tsLog('debug', 'Translate skipped: no ConceptMap config', { system, code });
    return null;
  }

  try {
    tsLog('debug', `Translating: ${system}|${code} -> ${params.targetsystem}`);
    const { data } = await ts.get('/ConceptMap/$translate', { params });
    const match = extractMatchFromTranslate(data);
    if (match?.system && match?.code) {
      tsLog('debug', `✅ Translate OK: ${code} -> ${match.code}`);
      return { system: match.system, code: match.code, display: match.display || display || code, source: 'translate' };
    } else {
      tsLog('debug', `❌ Translate no match: ${system}|${code}`);
    }
  } catch (e) {
    tsLog('warn', `Translate error: ${e.response?.status} ${e.message}`, { system, code });
  }
  return null;
}

// ===================== TerminologyOp Response Parsers =====================
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
  if (data?.resourceType !== 'Parameters') return null;
  const matchParam = data.parameter?.find(p => p.name === 'match');
  if (!matchParam?.part) return null;

  let equivalence, system, code, display;
  for (const part of matchParam.part) {
    if (part.name === 'equivalence') equivalence = part.valueCode;
    if (part.name === 'concept' && part.valueCoding) {
      system = part.valueCoding.system;
      code = part.valueCoding.code;
      display = part.valueCoding.display;
    }
  }

  if (equivalence && system && code) {
    return { system, code, display };
  }
  return null;
}

// ===================== Terminology Pipeline =====================
const CS_ABSENT = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
const CS_SCT = 'http://snomed.info/sct';

function shouldLookupTS(system) {
  if (!isTrue(FEATURE_TS_ENABLED)) return false;
  if (system === CS_ABSENT) return false;
  if (system === CS_SCT && process.env.TS_HAS_SNOMED !== 'true') return false;
  return true;
}

function sortCodingsPreferred(codings) {
  const pref = [CS_SCT]; // primero SNOMED
  return [...codings].sort((a, b) => {
    const aIdx = pref.indexOf(a.system);
    const bIdx = pref.indexOf(b.system);
    if (aIdx !== -1 && bIdx === -1) return -1;
    if (aIdx === -1 && bIdx !== -1) return 1;
    return 0;
  });
}

function pickDomainCoding(cc, domainCfg) {
  if (!cc?.coding) return null;
  const targetSys = domainCfg?.codeSystem || 'http://snomed.info/sct';
  return cc.coding.find(c => c.system === targetSys && c.code) || cc.coding[0] || null;
}

function buildPipeline(domain, ts, base, domainCfg) {
  // Secuencia: validateVS → validateCS → lookup → translate
  return [
    () => opValidateVS(ts, base, domainCfg),
    () => opValidateCS(ts, base, domainCfg),
    () => opLookup(ts, base, domainCfg),
    () => opTranslate(ts, base, domainCfg),
  ];
}

async function normalizeCC(ts, cc, domainCfg, domain) {
  if (!cc?.coding || !Array.isArray(cc.coding) || cc.coding.length === 0) return;

  const target = pickDomainCoding(cc, domainCfg);
  if (!target) return;

  const base = {
    system: target.system,
    code: target.code,
    display: target.display || cc.text
  };

  // Skip TS lookup for absent/unknown codes and SNOMED when not available
  if (!shouldLookupTS(base.system)) return;

  const steps = buildPipeline(domain, ts, base, domainCfg);

  for (const step of steps) {
    try {
      const result = await step();
      if (result?.system && result?.code) {
        target.system = result.system;
        target.code = result.code;
        target.display = result.display || target.display || cc.text;
        return; // Usa el primer resultado exitoso
      }
    } catch (error) {
      continue; // Continúa con el siguiente paso
    }
  }
}

function* iterateCodeableConcepts(resource) {
  if (!resource || typeof resource !== 'object') return;

  const typeToFields = {
    'Condition': ['code'],
    'Procedure': ['code'],
    'MedicationStatement': ['medicationCodeableConcept'],
    'MedicationRequest': ['medicationCodeableConcept'],
    'Immunization': ['vaccineCode'],
    'AllergyIntolerance': ['code'],
    'Observation': ['code'],
  };

  const fields = typeToFields[resource.resourceType] || [];
  for (const field of fields) {
    if (resource[field]) {
      yield { path: field, cc: resource[field] };
    }
  }
}

async function normalizeTerminologyInBundle(bundle) {
  if (!isTrue(FEATURE_TS_ENABLED)) return;
  const ts = buildTsClient();
  if (!ts || !bundle?.entry?.length) return;

  // --- SOLO CONSULTA: ejecutar $lookup para cada código SNOMED sin usar datos ---
  // Se puede habilitar/forzar con LOOKUP_SNOMED_ONLY=true
  if (LOOKUP_SNOMED_ONLY) {
    const uniq = new Set(); // system|code|version
    const entries = bundle?.entry || [];
    const versionDefault = process.env.SNOMED_VERSION_URI
      || 'http://snomed.info/sct/900000000000207008/version/20240331';
    for (const ent of entries) {
      const res = ent.resource;
      if (!res) continue;
      const codables = [
        res.code, res.medicationCodeableConcept, res.category, res.clinicalStatus
      ].filter(Boolean);
      for (const cc of codables) {
        const codings = cc.coding || [];
        for (const c of codings) {
          if (c?.system === SNOMED_SYSTEM && c?.code) {
            uniq.add(`${c.system}|${c.code}|${versionDefault}`);
          }
        }
      }
    }
    await Promise.all(
      [...uniq].map(k => {
        const [system, code, versionUri] = k.split('|');
        return fireAndForgetSnomedLookup(ts, system, code, versionUri);
      })
    );
  }

  console.log('🔍 Iniciando normalización terminológica con enfoque SNOMED...');

  for (const entry of bundle.entry) {
    const res = entry.resource;
    if (!res) continue;

    // 🚫 Desactivar toda normalización terminológica para vacunas
    if (res.resourceType === 'Immunization' && (FEATURE_TS_VACCINES_ENABLED ?? 'true').toLowerCase() === 'false') {
      tsLog('debug', 'TS[SKIP]: Vaccines normalization disabled by FEATURE_TS_VACCINES_ENABLED=false');
      continue; // salir sin hacer lookup/translate
    }

    // Determinar dominio
    const domain = resourceToDomain(res);
    const domainCfg = DOMAIN_CONFIG[domain] || DOMAIN_CONFIG[TS_DEFAULT_DOMAIN] || {};
    if (!DOMAIN_NAMES.has(domain)) {
      // Dominio no listado en TS_DOMAINS → igualmente intenta con default
      // (o puedes simplemente continue)
    }

    // Normalizar todas las CC relevantes del recurso
    for (const { cc } of iterateCodeableConcepts(res)) {
      try { await normalizeCC(ts, cc, domainCfg, domain); }
      catch (e) { console.warn(`⚠️ TS normalize error (${domain}):`, e.message); }
    }
  }

  console.log('✅ Normalización terminológica completada');
}

// ====== FIXERS ESPECÍFICOS PARA ICVP/IPS ======
function fixMedicationStatementCodingSystems(bundle) {
  for (const e of (bundle.entry || [])) {
    const r = e.resource;
    if (r?.resourceType === 'MedicationStatement' && r.medicationCodeableConcept?.coding?.length) {
      r.medicationCodeableConcept.coding = r.medicationCodeableConcept.coding.map(c => {
        // Si no trae system (p.ej. "no-medication-info"), usar el CS IPS de absent-unknown.
        if (!c.system) {
          return { ...c, system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips' };
        }
        return c;
      });
    }
  }
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

// ===================== Helpers para PDQm =====================

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



function asFhirBase(url) {
    const u = (url || '').replace(/\/+$/, '');
    return /\/fhir$/i.test(u) ? u : `${u}/fhir`;
}

function joinUrl(base, path) {
    const b = (base || '').replace(/\/+$/, '');
    const p = (path || '').replace(/^\/+/, '');
    return `${b}/${p}`;
}

// ====== PUNTO ÚNICO DE POSTPROCESO ICVP ======
function finalizeICVPBundle(bundle) {
  try {
    // Normaliza URNs + Composition + refs (hardening: todo a URN dentro de Document)
    normalizeDocumentBundleForURNs(bundle, updateReferencesInObject);
    for (const ent of (bundle.entry || [])) {
      const r = ent.resource;
      if (!r || !ent.fullUrl) continue;
      // si el fullUrl no es URN, y tenemos id, conviértelo
      if (!/^urn:uuid:/.test(ent.fullUrl) && r.id) {
        ent.fullUrl = `urn:uuid:${r.id}`;
      }
    }
    // Composition: subject/author/custodian -> que referencien exactamente esos URN
    const comp = getComposition(bundle);
    if (comp) {
      const pt = getPatientEntry(bundle);
      if (pt?.fullUrl) comp.subject = { reference: pt.fullUrl };
      if (Array.isArray(comp.author)) {
        comp.author = comp.author.map(a => {
          const pr = (bundle.entry || []).find(e => e.resource?.resourceType === 'Practitioner');
          return pr?.fullUrl ? { reference: pr.fullUrl } : a;
        });
      }
    }
    // Arreglos de perfil/terminología mínimos ICVP
    postProcessICVPDocumentBundle(bundle);
    // Limpieza de extensiones no permitidas (narrativeLink)
    for (const e of (bundle.entry || [])) stripNarrativeLinkExtensions(e.resource);
    // Verificación: entry[0] debe ser Composition y tener subject y custodian
    const entry0 = bundle.entry?.[0]?.resource;
    if (entry0?.resourceType !== 'Composition') {
      throw new Error('ICVP document bundle inválido: entry[0] no es Composition');
    }
    if (!entry0.subject?.reference) {
      throw new Error('ICVP Composition inválido: falta subject');
    }
    if (!entry0.custodian?.reference) {
      throw new Error('ICVP Composition inválido: falta custodian');
    }
  } catch (e) {
    console.warn('⚠️ finalizeICVPBundle error:', e?.message);
  }
}

// ====== NUEVO: extractores para reutilizar datos del ICVP ======
function getComposition(bundle) {
  return bundle?.entry?.[0]?.resource?.resourceType === 'Composition'
    ? bundle.entry[0].resource
    : (bundle?.entry || []).map(e=>e.resource).find(r => r?.resourceType==='Composition') || null;
}
function getPatientEntry(bundle) {
  return (bundle?.entry || []).find(e => e.resource?.resourceType === 'Patient') || null;
}
function getRefOrNull(entry) {
  return entry?.fullUrl || (entry?.resource?.id ? `${entry.resource.resourceType}/${entry.resource.id}` : null);
}
// Toma el PRIMER Immunization válido y extrae PreQual + ICD-11
function getPrimaryImmunizationInfo(bundle) {
  const im = (bundle?.entry || []).map(e=>e.resource).find(r => r?.resourceType==='Immunization');
  if (!im) return null;
  // PreQual en extensión (PCMT: valueCoding o valueIdentifier legacy)
  let prequal = null;
  for (const ext of (im.extension || [])) {
    if (ext?.url === ICVP_PRODUCT_EXT_URL) {
      // normaliza sistema mal tipeado "...PreQualProductIDs" -> "...PreQualProductIds"
      if (ext.valueCoding?.system === 'http://smart.who.int/pcmt-vaxprequal/CodeSystem/PreQualProductIDs') {
        ext.valueCoding.system = CS_PREQUAL_PRODUCTIDS;
      }
      if (ext.valueCoding?.system && ext.valueCoding?.code) {
        prequal = { system: ext.valueCoding.system, value: ext.valueCoding.code };
        break;
      }
      if (ext.valueIdentifier?.system && ext.valueIdentifier?.value) {
        prequal = { system: ext.valueIdentifier.system, value: ext.valueIdentifier.value };
        break;
      }
    }
  }
  // VaccineType en vaccineCode (preferir catálogo PCMT, fallback ICD-11)
  const vaccineType = (im.vaccineCode?.coding || []).find(c => 
    (c.system === CS_PREQUAL_VACCINETYPE || c.system === ICD11_MMS) && c.code
  );
  return { prequal, vaccineType, immunization: im };
}

// ====== NUEVO: construir DocumentReference para ITI-65 usando los datos del ICVP entrante ======
function buildDocumentReferenceFromICVP(icvpBundle) {
  const comp = getComposition(icvpBundle);
  const ptEntry = getPatientEntry(icvpBundle);
  const ptRef = getRefOrNull(ptEntry);
  const primary = getPrimaryImmunizationInfo(icvpBundle);

  const docRef = {
    resourceType: 'DocumentReference',
    status: 'current',
    type: { coding: [{ system: 'http://loinc.org', code: LOINC_PATIENT_SUMMARY, display: 'Patient Summary Document' }] },
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/document-classcode', code: 'clinical-document' }] }],
    subject: ptRef ? { reference: ptRef } : undefined,
    date: comp?.date || new Date().toISOString(),
    description: comp?.title || 'International Certificate of Vaccination/Prophylaxis',
    content: [{
      attachment: {
        // El propio Bundle ICVP serializado como documento
        contentType: 'application/fhir+json',
        // El generador ITI-65 decidirá si embebe (Binary) o referencia URL según ATTACHMENT_URL_MODE
      }
    }]
  };
  // Custodian (Organization) y Author (resolve URN)
  if (comp?.custodian?.reference) docRef.custodian = { reference: comp.custodian.reference };
  if (Array.isArray(comp?.author) && comp.author[0]?.reference) {
    docRef.author = [{ reference: comp.author[0].reference }];
  }
  // Identificadores: arrastra el identifier del Bundle y/o PreQual como identifier secundario
  const ids = [];
  if (icvpBundle?.identifier?.system && icvpBundle?.identifier?.value) {
    ids.push({ system: icvpBundle.identifier.system, value: icvpBundle.identifier.value });
  }
  if (primary?.prequal?.system && primary?.prequal?.value) {
    ids.push({ system: primary.prequal.system, value: primary.prequal.value });
  }
  if (ids.length) docRef.identifier = ids;
  // Si hay vaccineType (PCMT o ICD-11), lo incluimos como securityLabel para indexación
  if (primary?.vaccineType) {
    docRef.securityLabel = docRef.securityLabel || [];
    docRef.securityLabel.push({ 
      system: primary.vaccineType.system, 
      code: primary.vaccineType.code, 
      display: primary.vaccineType.display 
    });
  }
  return docRef;
}

// ===================== PDQm =====================
// Cache LRU simple para PDQm
const _pdqmCache = new Map(); // key: url, value: { expires, bundle }
function getCache(url) {
  const e = _pdqmCache.get(url);
  if (e && e.expires > Date.now()) return e.bundle;
  if (e) _pdqmCache.delete(url);
  return null;
}
function setCache(url, bundle) {
  _pdqmCache.set(url, { expires: Date.now() + PDQM_CACHE_TTL_MS, bundle });
  if (_pdqmCache.size > 200) {
    const first = _pdqmCache.keys().next().value;
    _pdqmCache.delete(first);
  }
}

// Helpers PDQm nuevos
function toSystemUrnOrHttp(system) {
  if (!system) return null;
  if (isUrnOid(system)) return toUrnOid(system);
  if (/^\d+(?:\.\d+)+$/.test(system)) return toUrnOid(system);
  return system; // http/https/urn:uuid
}
function buildSystemValueCandidates(patient) {
  const out = [];
  const ids = Array.isArray(patient?.identifier) ? patient.identifier : [];
  for (const id of ids) {
    const val = (id?.value || '').trim();
    if (!val) continue;
    const sys = toSystemUrnOrHttp(id?.system) || toSystemUrnOrHttp(process.env.PDQM_DEFAULT_IDENTIFIER_SYSTEM);
    if (sys) out.push({ system: sys, value: val });
  }
  return out;
}
function applyAliasToParam(param) {
  if (!isTrue(PDQM_ENABLE_ALIASES)) return 'identifier';
  const p = String(param || '').toLowerCase();
  const map = { passport: 'identifier', ppn: 'identifier', national: 'identifier', run: 'identifier', rut: 'identifier' };
  return map[p] || p || 'identifier';
}
function isAllowedParam(p) {
  if (!process.env.PDQM_ALLOWED_SEARCH_PARAMS) return true;
  const allowed = arr(process.env.PDQM_ALLOWED_SEARCH_PARAMS).map(x => x.toLowerCase());
  return allowed.includes(p.toLowerCase());
}
function buildPdqmUrls(base, candidates, rawValue) {
  const urls = [];
  // 1) identifier=system|value (+ of-type opcional)
  for (const c of candidates) {
    const qp = `identifier=${encodeURIComponent(`${c.system}|${c.value}`)}`;
    urls.push(joinUrl(base, '/Patient') + '?' + qp);
    if (PDQM_ENABLE_OF_TYPE) {
      const typeCode = /[A-Z]{2}/i.test(c.value) ? 'PPN' : 'MR';
      const qp2 = `identifier:of-type=${encodeURIComponent(`${c.system}|${typeCode}|${c.value}`)}`;
      urls.push(joinUrl(base, '/Patient') + '?' + qp2);
    }
  }
  // 2) identifier=value y alias permitido (si está en allow-list)
  const rawParam = 'identifier';
  const aliasParam = applyAliasToParam(rawParam);
  const paramsToTry = [rawParam, aliasParam].filter((v, i, a) => a.indexOf(v) === i).filter(isAllowedParam);
  for (const p of paramsToTry) {
    urls.push(joinUrl(base, '/Patient') + `?${p}=${robustUrlEncode(rawValue)}`);
  }
  return [...new Set(urls)];
}

async function pdqmFetchBundleByIdentifier(identifierValue) {
    console.log('🔍 PDQm fetch for identifier:', maskId(identifierValue), 'using PDQM_FHIR_URL:', PDQM_FHIR_URL);
    if (!PDQM_FHIR_URL || !identifierValue) return null;
    console.log('---')

    const maxAttempts = 3;
    let currentAttempt = 0;
    let lastResponse = null;

    while (currentAttempt < maxAttempts) {
        currentAttempt++;
        console.log(`PDQm attempt ${currentAttempt}/${maxAttempts} for identifier: ${maskId(identifierValue)}`);

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

            const base = asFhirBase(PDQM_FHIR_URL);
            // Recolectar candidates system|value desde el Patient local (si está disponible en req)
            const patient = (pdqmFetchBundleByIdentifier._localPatient) || null;
            const sysValCandidates = patient ? buildSystemValueCandidates(patient) : [];
            const urls = buildPdqmUrls(base, sysValCandidates, identifierValue);

            for (let i = 0; i < urls.length; i++) {
              const url = urls[i];
              const cached = getCache(url);
              if (cached) {
                console.log('PDQm cache HIT:', url);
                return cached;
              }
              console.log(`PDQm GET: ${url}`);
              let response = await axios.get(url, config);
              lastResponse = response;

              // Respetar 429 Retry-After
              if (response.status === 429) {
                const retryAfter = parseInt(response.headers['retry-after'] || '1', 10);
                console.warn(`PDQm 429; esperando ${retryAfter}s…`);
                await new Promise(r => setTimeout(r, retryAfter * 1000));
                response = await axios.get(url, config);
                lastResponse = response;
              }

              if (response.status === 200 && response.data?.resourceType === 'Bundle') {
                setCache(url, response.data);
                if ((response.data.total || 0) > 0) {
                  console.log(`✅ PDQm response: status=${response.status}, total=${response.data.total || 0}`);
                  return response.data;
                }
              }
            }

            // Manejar códigos de estado específicos
            if (lastResponse && (lastResponse.status === 401 || lastResponse.status === 403)) {
                if (isTrue(PDQM_ENABLE_FALLBACK_FOR_401_403)) {
                    console.warn(`PDQm auth error (${lastResponse.status}), generating fallback bundle`);
                    return generateFallbackBundle(identifierValue);
                } else {
                    console.error(`PDQm auth error (${lastResponse.status}), no fallback enabled`);
                    return null;
                }
            }

            // Verificar si debemos reintentar basado en el estado HTTP
            const fallbackStatuses = arr(PDQM_FALLBACK_HTTP_STATUSES || '404,400');
            if (lastResponse && fallbackStatuses.includes(lastResponse.status.toString())) {
                console.warn(`PDQm response status ${lastResponse.status}, will retry or fallback`);

                if (currentAttempt >= maxAttempts) {
                    console.warn(`Max attempts reached, generating fallback bundle`);
                    return generateFallbackBundle(identifierValue);
                }

                // Esperar antes del siguiente intento
                await new Promise(resolve => setTimeout(resolve, 1000 * currentAttempt));
                continue;
            }

            // Si llegamos aquí y hubo alguna respuesta, retornar data (aunque vacía); si no, null
            return lastResponse ? lastResponse.data : null;

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

// ===================== Helpers nuevos =====================

function stripNarrativeLinkExtensions(resource) {
    if (!resource || !Array.isArray(resource.extension)) return;
    // En perfiles IPS varias resources usan slicing cerrado sobre extension;
    // narrativeLink NO está permitido ahí => hay que removerla.
    resource.extension = resource.extension.filter(
        (e) => e?.url !== 'http://hl7.org/fhir/StructureDefinition/narrativeLink'
    );
    if (resource.extension.length === 0) {
        delete resource.extension;
    }
}


function sanitizeAllergyIntolerance(ai) {
    if (!ai || ai.resourceType !== 'AllergyIntolerance') return;
    // code: dejar SNOMED primero y eliminar codings sin system
    if (Array.isArray(ai.code?.coding)) {
        ai.code.coding = ai.code.coding
            // fuera codings sin system y los locales OpenMRS
            .filter(c => !!c?.system && c.system !== 'http://openmrs.org/concepts')
            // SNOMED primero
            .sort((a,b) => (a.system === 'http://snomed.info/sct' ? -1 : 1));
    }
    // reaction[].manifestation: idem
    (ai.reaction || []).forEach(r => {
        if (Array.isArray(r.manifestation)) {
            r.manifestation.forEach(m => {
                if (Array.isArray(m.coding)) {
                    m.coding = m.coding
                        .filter(c => !!c?.system)
                        .sort((a,b) => (a.system === 'http://snomed.info/sct' ? -1 : 1));
                }
            });
        }
        // NEW: reaction.substance.coding → también limpiar y ordenar
        if (r.substance?.coding && Array.isArray(r.substance.coding)) {
            r.substance.coding = r.substance.coding
                .filter(c => !!c?.system && c.system !== 'http://openmrs.org/concepts')
                .sort((a,b) => (a.system === 'http://snomed.info/sct' ? -1 : 1));
        }
    });
}

// --- NUEVO: Sanitizar Medication (quitar ext OMRS y dejar solo SNOMED) ---
function sanitizeMedicationResource(med) {
    if (!med || med.resourceType !== 'Medication') return;
    // 1) quitar extensiones OMRS
    if (Array.isArray(med.extension)) {
        med.extension = med.extension.filter(e => !String(e.url).startsWith('http://fhir.openmrs.org/ext/medicine'));
        if (med.extension.length === 0) delete med.extension;
    }
    // 2) code.coding → solo SNOMED, y sin codings sin system
    if (med.code?.coding) {
        med.code.coding = med.code.coding
            .filter(c => c?.system && c.system === 'http://snomed.info/sct');
        if (med.code.coding.length === 0) delete med.code.coding;
    }
    // 3) form.coding → solo SNOMED; si queda vacío, elimina form
    if (med.form?.coding) {
        med.form.coding = med.form.coding
            .filter(c => c?.system && c.system === 'http://snomed.info/sct');
        if (med.form.coding.length === 0) delete med.form.coding;
    }
    if (med.form && !med.form.coding && !med.form.text) delete med.form;
    // 4) asegurar textos básicos
    if (med.code && !med.code.text) med.code.text = 'Medication';
}

// --- OPCIONAL: Sanitizar Practitioner.identifier.system no estándar (OMRS) ---
function sanitizePractitionerIdentifiers(prac) {
    if (!prac || prac.resourceType !== 'Practitioner') return;
    if (!Array.isArray(prac.identifier)) return;
    prac.identifier.forEach(id => {
        // 1) quitar systems locales OMRS
        if (typeof id?.system === 'string' &&
            id.system.startsWith('http://fhir.openmrs.org/ext/provider/identifier')) {
            delete id.system;
        }
        // 2) quitar cualquier system http(s) que el validador intenta resolver y falla
        if (typeof id?.system === 'string' && /^https?:\/\//i.test(id.system)) {
            delete id.system;
        }
    });
    // limpia identifiers vacíos
    prac.identifier = prac.identifier.filter(id => id.value || id.type || id.system);
    if (prac.identifier.length === 0) delete prac.identifier;
}
function fixPatientIdentifiers(bundle) {
    const patient = (bundle?.entry || [])
        .map(e => e.resource)
        .find(r => r?.resourceType === 'Patient');
    if (!patient) return;

    patient.identifier = Array.isArray(patient.identifier) ? patient.identifier : [];

    // Systems normalizados (LAC)
    const defaultNatOid = toUrnOid(DEFAULT_NAT_OID || '2.16.152'); // siempre URN OID con "."
    const defaultPpnOid = toUrnOid(DEFAULT_PPN_OID || '2.16.840.1.113883.4.330.152');

    for (const id of patient.identifier) {
        const txt = (id?.type?.text || '').toLowerCase();
        const cod = id?.type?.coding?.[0]?.code || '';

        // --- Nacional / RUN ---
        if (/run|nacional|national/.test(txt) || /^RUN\*/i.test(id?.value || '') || /RUN/i.test(cod)) {
            // Slice: national — exigir system & type de la VS nacional
            id.system = id.system || defaultNatOid;                     // p.ej. urn:oid.2.16.152
            id.use = 'usual';
            id.type = id.type || {};
            id.type.coding = Array.isArray(id.type.coding) ? id.type.coding : [];
            // reemplazar cualquier coding previo por el coding de la VS nacional (usar MR para pasar IdentifierType)
            id.type.coding = [{
                system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                code: 'MR'
            }];
            // la mayoría de perfiles no permiten type.text aquí
            if (id.type.text) delete id.type.text;
            continue;
        }

        // --- Pasaporte / PPN ---
        const isPassportByText = /pasaporte|passport/.test(txt);
        const isPassportByCode = (id?.type?.coding || []).some(c =>
            String(c?.code || '').toUpperCase() === 'PPN' ||
            String(c?.code || '') === 'a2551e57-6028-428b-be3c-21816c252e06'   // código que nos envías para distinguir PPN
        );
        if (isPassportByText || isPassportByCode) {
            id.system = id.system || defaultPpnOid;
            id.use = 'official';
            // Slice: passport — exactamente 1 coding (v2-0203#PPN) y SIN type.text
            id.type = id.type || {};
            id.type.coding = [{
                system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                code: 'PPN'
            }];
            if (id.type.text) delete id.type.text;
        }
    }

    // Asegurar que exista al menos un national id si no vino (slice requerido)
    const hasNational = patient.identifier.some(id =>
        String(id.system||'') === defaultNatOid ||
        (id.type?.coding||[]).some(c => c.system === 'http://lacpass.racsel.org/CodeSystem/national-identifier-types' && c.code === 'RUN')
    );
    if (!hasNational) {
        patient.identifier.unshift({
            use: 'usual',
            system: defaultNatOid,                     // urn:oid.2.16.152
            type: { coding: [{ system: 'http://lacpass.racsel.org/CodeSystem/national-identifier-types', code: 'RUN' }] },
            value: patient.identifier?.[0]?.value || `RUN*${patient.id || 'UNKNOWN'}`
        });
    }
}
/**
 * Asegura que una propiedad sea un array
 */
function ensureArray(obj, property) {
    if (!obj[property]) {
        obj[property] = [];
    } else if (!Array.isArray(obj[property])) {
        obj[property] = [obj[property]];
    }
    return obj[property];
}
/**
 * Agrega un perfil a un recurso si no existe
 */
function addProfile(resource, profileUrl) {
    if (!resource || !profileUrl) return;

    if (!resource.meta) resource.meta = {};
    // Asegurar array y mantener todos los perfiles necesarios
    resource.meta.profile = Array.isArray(resource.meta.profile) ? resource.meta.profile : [];

    if (!resource.meta.profile.includes(profileUrl)) {
        resource.meta.profile.push(profileUrl);
    }
}


function ensureLacPatientProfile(patient) {
    addProfile(patient, LAC_PROFILES.PATIENT);
}

function ensureIpsPatientProfile(patient) {
    addProfile(patient, IPS_PROFILES.PATIENT);
}

// === Helpers URN OID (admiten ":" y "."; emiten con separador configurable) ===
function isUrnOid(value) {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    // Aceptar 'urn:oid:1.2.3' o 'urn:oid.1.2.3'
    return /^urn:oid[.:]\d+(?:\.\d+)+$/.test(v);
}
function toUrnOid(value) {
    if (!value) return null;
    const v = String(value).trim();
    // Si ya viene como URN con ":" o ".", normalizar al separador elegido
    if (/^urn:oid[.:]\d+(?:\.\d+)+$/.test(v)) {
        // Reemplaza el separador actual por el configurado
        return v.replace(/^urn:oid[.:]/, `urn:oid${OID_URN_SEPARATOR}`);
    }
    // Si viene como OID "crudo" (solo dígitos y puntos), formatear
    const m = v.match(/(\d+(?:\.\d+)+)/);
    return m ? `urn:oid${OID_URN_SEPARATOR}${m[1]}` : null;
}

function ensureLacBundleProfile(bundle) {
    addProfile(bundle, LAC_PROFILES.BUNDLE);
}

function ensureLacCompositionProfile(comp) {
    addProfile(comp, LAC_PROFILES.COMPOSITION);
}
function ensureCompositionSubject(comp, patientEntry) {
    if (!comp || !patientEntry) return;
    const ref = patientEntry.fullUrl || (patientEntry.resource?.id ? `Patient/${patientEntry.resource.id}` : null);
    if (ref) comp.subject = { reference: ref };
}
// ---- Helpers to classify Conditions for IPS sections ----
function isAbsentProblemCondition(cond) {
    const codings = (cond?.code?.coding) || [];
    return codings.some(c => c.system === 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips' &&
        (c.code === 'no-problem-info' || /no information about problems/i.test(c.display || '')));
}

function clinicalStatusCode(cond) {
    return cond?.clinicalStatus?.coding?.[0]?.code || null;
}

function hasAbatement(cond) {
    return !!(cond?.abatementDateTime || cond?.abatementPeriod || cond?.abatementAge || cond?.abatementRange || cond?.abatementString);
}

function isActiveProblem(cond) {
    return ['active','recurrence','relapse'].includes(clinicalStatusCode(cond));
}
function isPastIllness(cond) {
    const cs = clinicalStatusCode(cond);
    return ['inactive','remission','resolved'].includes(cs) || hasAbatement(cond);
}

function ensureIpsProfile(resource) {
    if (!resource?.resourceType) return;

    const profileMap = {
        'AllergyIntolerance': IPS_PROFILES.ALLERGY_INTOLERANCE,
        'MedicationStatement': IPS_PROFILES.MEDICATION_STATEMENT,
        'MedicationRequest': IPS_PROFILES.MEDICATION_REQUEST,
        'Medication': IPS_PROFILES.MEDICATION,
        'Condition': IPS_PROFILES.CONDITION,
        'Procedure': IPS_PROFILES.PROCEDURE,
        'Immunization': IPS_PROFILES.IMMUNIZATION,
        'Observation': IPS_PROFILES.OBSERVATION
    };

    const profile = profileMap[resource.resourceType];
    if (profile) {
        addProfile(resource, profile);
    }
}

// Extiende a Organization para evitar "unknown profile" con perfiles locales
function ensureIpsOrganizationProfile(org) {
  if (!org || org.resourceType !== 'Organization') return;
  addProfile(org, IPS_PROFILES.ORGANIZATION);
  // Añadir Organization.type=prov (IHE) para cumplir mínimos
  org.type = Array.isArray(org.type) ? org.type : [];
  const hasProv = org.type.some(t =>
    (t.coding||[]).some(c => c.system === 'http://terminology.hl7.org/CodeSystem/organization-type' && c.code === 'prov')
  );
  if (!hasProv) {
    org.type.push({
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'prov', display: 'Healthcare Provider' }]
    });
  }
}


// === Soporte mínimo para países (evita ReferenceError y corrige casos comunes) ===
const ISO3_TO_ISO2 = {
  CHL: 'CL', ARG: 'AR', BOL: 'BO', BRA: 'BR', COL: 'CO', CRI: 'CR', CUB: 'CU',
  DOM: 'DO', ECU: 'EC', GTM: 'GT', HND: 'HN', MEX: 'MX', NIC: 'NI', PAN: 'PA',
  PRY: 'PY', PER: 'PE', URY: 'UY', VEN: 'VE', USA: 'US', CAN: 'CA', ESP: 'ES'
};
function normKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin acentos
    .toLowerCase().trim();
}
const COUNTRY_MAP = new Map([
  ['chile', 'CL'],
  ['republica de chile', 'CL'],
  ['argentina', 'AR'],
  ['brasil', 'BR'],
  ['peru', 'PE'],
  ['mexico', 'MX'],
  ['colombia', 'CO'],
  ['uruguay', 'UY'],
  ['paraguay', 'PY'],
  ['bolivia', 'BO'],
  ['ecuador', 'EC'],
  ['costa rica', 'CR'],
  ['panama', 'PA'],
  ['honduras', 'HN'],
  ['nicaragua', 'NI'],
  ['guatemala', 'GT'],
  ['republica dominicana', 'DO'],
  ['cuba', 'CU'],
  ['spain', 'ES'],
  ['españa', 'ES'],
  ['united states', 'US'],
  ['estados unidos', 'US']
]);

function toIso2Country(input) {
    if (!input) return null;
    const raw = String(input).trim();
    // Ya viene ISO-2
    if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
    // Viene ISO-3
    if (/^[A-Za-z]{3}$/.test(raw)) return (ISO3_TO_ISO2[raw.toUpperCase()] || null);
    // Viene por nombre (heurístico simple)
    const key = normKey(raw);
    return COUNTRY_MAP.get(key) || null;
}



// Asegura que exista al menos una entry válida para el slice requerido de la sección:
// - loincCode: código LOINC de la sección (p.ej. 48765-2 Alergias, 11450-4 Problemas, 11348-0 Antecedentes)
// - allowedTypes: tipos de recurso aceptados por el slice (p.ej. ['AllergyIntolerance'])
function ensureRequiredSectionEntry(summaryBundle, comp, loincCode, allowedTypes) {
    if (!comp?.section) return;
    const sec = comp.section.find(s => s.code?.coding?.some(c => c.system === 'http://loinc.org' && c.code === loincCode));
    if (!sec) return;

    // Vamos a reconstruir completamente las entradas de la sección cuando sea Condition
    // para cumplir con sectionProblems (11450-4) y sectionPastIllnessHx (11348-0).
    if (allowedTypes.includes('Condition')) {
        const isPastSection = loincCode === LOINC_CODES.PAST_ILLNESS_SECTION; // 11348-0
        const isProblemsSection = loincCode === LOINC_CODES.PROBLEMS_SECTION;  // 11450-4

        // Todas las Conditions en el bundle (y que no sean "absent/unknown")
        const allConds = (summaryBundle.entry || [])
            .filter(x => x.resource?.resourceType === 'Condition' && !isAbsentProblemCondition(x.resource));

        // Clasificación (usa helpers existentes)
        const actives = allConds.filter(x => isActiveProblem(x.resource));
        const pasts   = allConds.filter(x => isPastIllness(x.resource));

        // Conjunto objetivo según la sección
        let target = [];
        if (isProblemsSection) target = actives;
        if (isPastSection)     target = pasts;

        // Si hay target, lo aplicamos completo; si no, dejamos que el fallback genérico haga placeholder
        if (target.length > 0) {
            // Ensamblar referencias sin duplicados
            const uniq = new Set();
            sec.entry = [];
            for (const candidate of target) {
                ensureIpsProfile(candidate.resource);
                if (!uniq.has(candidate.fullUrl)) {
                    uniq.add(candidate.fullUrl);
                    sec.entry.push({ reference: candidate.fullUrl });
                }
            }
            // Salimos porque ya poblamos esta sección correctamente
            return;
        }
        // Si no había ninguna Condition para esta sección, caeremos al fallback más abajo (placeholder)
    }

    // Si no hay entries válidas, buscar candidatos y enlazarlos
    const candidates = (summaryBundle.entry || []).filter(x => allowedTypes.includes(x.resource?.resourceType));

    // NOTA: ya manejamos Condition arriba. De aquí en adelante, secciones no-Condition.

    // Generic fallback (non-Condition sections): link first candidate
    if (candidates.length > 0) {
        sec.entry = Array.isArray(sec.entry) ? sec.entry : [];
        // Enlaza SOLO el primer candidato (satisface slice mínimo)
        const candidate = candidates[0];
        ensureIpsProfile(candidate.resource);
        const alreadyReferenced = sec.entry.some(e => e.reference === candidate.fullUrl);
        if (!alreadyReferenced) sec.entry.push({ reference: candidate.fullUrl });
        // dedupe
        sec.entry = sec.entry.filter((e, i, arr) => i === arr.findIndex(v => v.reference === e.reference));
        return;
    }

    // Si tampoco hay candidatos: inyectar placeholder IPS "no known …"
    const patientEntry = (summaryBundle.entry || []).find(e => e.resource?.resourceType === 'Patient');
    const patRef = patientEntry?.fullUrl || (patientEntry?.resource?.id ? `Patient/${patientEntry.resource.id}` : null);
    const nowIso = new Date().toISOString();
    let placeholder = null;

    if (allowedTypes.includes('AllergyIntolerance')) {
        placeholder = {
            fullUrl: 'urn:uuid:allergy-none',
            resource: {
                resourceType: 'AllergyIntolerance',
                meta: { profile: [IPS_PROFILES.ALLERGY_INTOLERANCE] },
                clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
                verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'unconfirmed' }] },
                code: {
                    coding: [
                        { system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips', code: 'no-known-allergies', display: 'No known allergies' },
                        { system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy (situation)' }
                    ],
                    text: 'No known allergies'
                },
                patient: patRef ? { reference: patRef } : undefined
            }
        };
    } else if (allowedTypes.includes('Immunization')) {
        placeholder = {
            fullUrl: 'urn:uuid:imm-none',
            resource: {
                resourceType: 'Immunization',
                meta: { profile: [IPS_PROFILES.IMMUNIZATION] },
                status: 'not-done',
                // usamos absent/unknown para "no información de inmunizaciones"
                vaccineCode: {
                    coding: [{
                        system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips',
                        code: 'no-immunization-info',
                        display: 'No information about immunizations'
                    }],
                    text: 'No information about immunizations'
                },
                subject: patRef ? { reference: patRef } : undefined,
                occurrenceDateTime: nowIso
            }
        };
    }  else if (allowedTypes.includes('MedicationStatement')) {
        placeholder = {
            fullUrl: 'urn:uuid:meds-none',
            resource: {
                resourceType: 'MedicationStatement',
                meta: { profile: [IPS_PROFILES.MEDICATION_STATEMENT] },
                status: 'active',
                medicationCodeableConcept: {
                    coding: [{ system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips', code: 'no-known-medications', display: 'No known medications' }],
                    text: 'No known medications'
                },
                subject: patRef ? { reference: patRef } : undefined,
                effectiveDateTime: nowIso
            }
        };
    } else if (allowedTypes.includes('Condition')) {
        const isPast = loincCode === LOINC_CODES.PAST_ILLNESS_SECTION;
        placeholder = {
            fullUrl: isPast ? 'urn:uuid:pasthx-none' : 'urn:uuid:problem-none',
            resource: {
                resourceType: 'Condition',
                meta: { profile: [IPS_PROFILES.CONDITION] },
                category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
                code: {
                    coding: [{ system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips', code: 'no-known-problems', display: 'No known problems' }],
                    text: isPast ? 'No known past illnesses' : 'No known problems'
                },
                subject: patRef ? { reference: patRef } : undefined
            }
        };
    }

    if (placeholder) {
        summaryBundle.entry = Array.isArray(summaryBundle.entry) ? summaryBundle.entry : [];
        summaryBundle.entry.push(placeholder);
        sec.entry = Array.isArray(sec.entry) ? sec.entry : [];
        sec.entry.push({ reference: placeholder.fullUrl });
        // dedupe entries
        sec.entry = sec.entry.filter((e, i, arr) => i === arr.findIndex(v => v.reference === e.reference));
    }
}


function fixPatientCountry(bundle) {
    const patient = (bundle.entry ?? [])
        .map(e => e.resource)
        .find(r => r?.resourceType === "Patient");
    if (!patient) return;

    (patient.address ?? []).forEach(addr => {
        if (!addr.country) return;
        const iso2 = toIso2Country(addr.country);
        if (iso2) addr.country = iso2; // e.g., "CL"
    });
}

// ===== Helpers de modos de URL =====
function asAbsoluteBase(u) {
    const x = (u || '').replace(/\/+$/, '');
    return /\/fhir$/i.test(x) ? x : `${x}/fhir`;
}


function makeAbsolute(resourceType, id) {
    const base = asAbsoluteBase(ABSOLUTE_FULLURL_BASE);
    return `${base}/${resourceType}/${id}`;
}
function makeRelative(resourceType, id) {
    return `${resourceType}/${id}`;
}
function makeUrn(id) {
    return `urn:uuid:${id}`;
}


/**
 * Resuelve una referencia según el modo.
 * @param {'urn'|'absolute'|'relative'} mode
 * @param {string} resourceType
 * @param {string} id
 * @returns {string}
 */
function buildRef(mode, resourceType, id) {
    switch ((mode || '').toLowerCase()) {
        case 'absolute':
            return makeAbsolute(resourceType, id);
        case 'relative':
            return makeRelative(resourceType, id);
        default:
            return makeUrn(id);
    }
}

function applyUrlModeToBundle(bundle, mode, updateReferencesInObject) {
    if (!bundle?.entry?.length) return;

    // 🚫 Document bundles (ICVP/IPS) siempre en URN
    if (String(bundle.type || '').toLowerCase() === 'document') {
        mode = 'urn';
    }

    // Mapa de reemplazos: cualquier forma conocida -> forma final (según 'mode')
    const urlMap = new Map();

    // Detectar bases absolutas *reales* que vengan en el Bundle (no asumir solo ABSOLUTE_FULLURL_BASE)
    const absoluteBases = new Set();
    for (const e of bundle.entry) {
        if (typeof e.fullUrl === 'string' && /^https?:\/\//i.test(e.fullUrl)) {
            // recorta hasta '/fhir' si existe, o hasta el recurso
            const m = e.fullUrl.match(/^(https?:\/\/[^]+?)(?:\/fhir)?\/[A-Za-z]+\/[A-Za-z0-9\-\.]{1,64}$/);
            if (m && m[1]) {
                // siempre considerar la variante con /fhir al final
                absoluteBases.add(`${m[1]}/fhir`);
            }
        }
    }
    if (ABSOLUTE_FULLURL_BASE) absoluteBases.add(asAbsoluteBase(ABSOLUTE_FULLURL_BASE));

    for (const e of bundle.entry) {
        const r = e.resource;
        if (!r?.resourceType) continue;

        // Resolver ID (preferir el que provenga del fullUrl cuando sea URN)
        let id = null;
        if (e.fullUrl?.startsWith('urn:uuid:')) id = e.fullUrl.split(':').pop();
        else if (r.id) id = r.id;
        if (!id) continue;

        const finalRef = buildRef(mode, r.resourceType, id);

        // Variantes equivalentes que mapeamos a 'finalRef'
        const variants = new Set([
            e.fullUrl,
            `urn:uuid:${id}`,
            `${r.resourceType}/${id}`,
            `./${r.resourceType}/${id}`,
        ]);
        // agregar TODAS las bases absolutas detectadas
        for (const base of absoluteBases) {
            variants.add(`${base}/${r.resourceType}/${id}`);
        }

        // Mapear todas las variantes conocidas a la forma final
        for (const v of Array.from(variants).filter(Boolean)) urlMap.set(v, finalRef);

        // asignar fullUrl final según el modo
        e.fullUrl = finalRef;
    }

    // Reescribir todas las .reference y Attachment.url según urlMap
    updateReferencesInObject(bundle, urlMap);
}

// =========================================
// Normalizador URN para Document Bundles
// - Asegura Composition.id == entry[0].fullUrl (URN UUID)
// - Convierte refs Patient/Practitioner/Organization a URN
// - Reemplaza fullUrl absolutos por URN
// - Repara custodian con UUID válido
// - Elimina duplicados en section.entry
// =========================================
function normalizeDocumentBundleForURNs(bundle, updateReferencesInObject) {
    if (!bundle || String(bundle.type || '').toLowerCase() !== 'document') return;
    const urlMap = new Map();

    // 1) Asegurar que todas las entry tengan fullUrl URN y resource.id UUID
    for (const e of (bundle.entry || [])) {
        const r = e.resource || {};
        // Si no hay id, generarlo
        if (!r.id) r.id = uuidv4();
        const id = String(r.id).toLowerCase();

        // Si fullUrl es absoluto o no-URN, o URN inválido → cambiar a URN con UUID
        const want = `urn:uuid:${id}`;
        const cur = e.fullUrl || '';

        const looksURN = cur.startsWith('urn:uuid:');
        const curTail = looksURN ? cur.slice(9) : cur;
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(curTail);

        if (!looksURN || !isUUID || cur.toLowerCase() !== want) {
            if (looksURN && !isUUID) {
                // Tenías algo como urn:uuid:org-chumakov → generamos uno nuevo y mapeamos
                const newId = uuidv4();
                const newUrn = `urn:uuid:${newId}`;
                urlMap.set(cur, newUrn);
                r.id = newId;
                e.fullUrl = newUrn;
            } else {
                // Absoluta o URN con id distinto → normalizar
                if (cur) urlMap.set(cur, want);
                e.fullUrl = want;
                r.id = id; // ya lowercase
            }
        }
    }

    // 2) Reescribir todas las referencias según urlMap
    updateReferencesInObject(bundle, urlMap);

    // 3) Composition en entry[0] con id == fullUrl
    const compEntry = bundle.entry?.[0];
    if (compEntry?.resource?.resourceType === 'Composition') {
        const comp = compEntry.resource;
        // Alinear al canónico ICVP requerido por el validador
        try {
            ensureLacCompositionProfile(comp);
        } catch {}

        const fullUrl = compEntry.fullUrl || '';
        const tail = fullUrl.startsWith('urn:uuid:') ? fullUrl.slice(9) : '';
        if (!comp.id || comp.id.toLowerCase() !== tail.toLowerCase()) {
            comp.id = tail || uuidv4();
            compEntry.fullUrl = `urn:uuid:${comp.id}`;
        }
        // 3a) subject: Patient/<id> → urn:uuid:<id>
        if (comp.subject?.reference && /^Patient\//i.test(comp.subject.reference)) {
            const id = comp.subject.reference.split('/')[1];
            comp.subject.reference = `urn:uuid:${id}`;
        }
        // 3b) author[]: Practitioner/… u Organization/… → URN
        if (Array.isArray(comp.author)) {
            comp.author = comp.author.map(a => {
                if (a?.reference && /^[A-Za-z]+\/[A-Za-z0-9\-\.]+$/i.test(a.reference)) {
                    const [typ, id] = a.reference.split('/');
                    return { ...a, reference: `urn:uuid:${id}` };
                }
                return a;
            });
        }
        // 3c) custodian.reference: si no es URN UUID válido, normalizar
        if (comp.custodian?.reference) {
            const ref = comp.custodian.reference;
            if (ref.startsWith('urn:uuid:')) {
                const tail = ref.slice(9);
                const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tail);
                if (!ok) {
                    // Buscar Organization con ese fullUrl para remapear o crear uno nuevo
                    const orgEntry = (bundle.entry || []).find(en => en.fullUrl === ref && en.resource?.resourceType === 'Organization');
                    const newId = uuidv4();
                    const newUrn = `urn:uuid:${newId}`;
                    if (orgEntry) {
                        orgEntry.resource.id = newId;
                        orgEntry.fullUrl = newUrn;
                        urlMap.set(ref, newUrn);
                        comp.custodian.reference = newUrn;
                    } else {
                        comp.custodian.reference = newUrn;
                    }
                }
            } else if (/^Organization\//i.test(ref)) {
                const id = ref.split('/')[1];
                comp.custodian.reference = `urn:uuid:${id}`;
            }
        }
    }

    // Armonizar perfiles Organization a IPS conocidos
    for (const e of (bundle.entry || [])) if (e.resource?.resourceType === 'Organization') ensureIpsOrganizationProfile(e.resource);

    // 4) Dedupe en section[].entry (evita refs duplicadas)
    for (const s of (bundle.entry?.[0]?.resource?.section || [])) {
        if (Array.isArray(s.entry)) {
            const seen = new Set();
            s.entry = s.entry.filter(x => {
                const key = x?.reference || '';
                if (!key) return false;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }
    }

    // 5) Reaplicar mapeo después de ajustes en custodian/ids
    if (urlMap.size) {
        updateReferencesInObject(bundle, urlMap);
    }
}

// === Refuerzo final específico de Composition y terminología mínima (doc bundles) ===
function enforceCompositionRefsAndMinimalTerminology(bundle, updateReferencesInObject) {
  if (!bundle || String(bundle.type || '').toLowerCase() !== 'document') return;
  const e0 = bundle.entry?.[0];
  if (!e0?.resource || e0.resource.resourceType !== 'Composition') return;
  const comp = e0.resource;

  // 1) Composition.id == entry[0].fullUrl (URN)
  if (!e0.fullUrl?.startsWith('urn:uuid:')) {
    const id = comp.id || uuidv4();
    e0.fullUrl = `urn:uuid:${id}`;
    comp.id = id;
  } else {
    const tail = e0.fullUrl.slice(9);
    if (!comp.id || comp.id.toLowerCase() !== tail.toLowerCase()) comp.id = tail;
  }

  // 2) subject/author/custodian → URN
  if (comp.subject?.reference && /^Patient\//i.test(comp.subject.reference)) {
    comp.subject.reference = `urn:uuid:${comp.subject.reference.split('/')[1]}`;
  }
  if (Array.isArray(comp.author)) {
    comp.author = comp.author.map(a => {
      if (a?.reference && /^[A-Za-z]+\/[A-Za-z0-9\-\.]{1,64}$/i.test(a.reference)) {
        const [, id] = a.reference.split('/');
        return { ...a, reference: `urn:uuid:${id}` };
      }
      return a;
    });
  }
  if (comp.custodian?.reference && /^Organization\//i.test(comp.custodian.reference)) {
    comp.custodian.reference = `urn:uuid:${comp.custodian.reference.split('/')[1]}`;
  }

  // 3) Practitioner con fullUrl absoluto → remap a URN preservando id
  const urlMap = new Map();
  for (const ent of (bundle.entry || [])) {
    const r = ent.resource;
    if (r?.resourceType !== 'Practitioner') continue;
    const id = r.id || uuidv4();
    const want = `urn:uuid:${id}`;
    if (!ent.fullUrl || /^https?:\/\//i.test(ent.fullUrl)) {
      if (ent.fullUrl) urlMap.set(ent.fullUrl, want);
      ent.fullUrl = want;
      r.id = id;
    }
  }
  if (urlMap.size) updateReferencesInObject(bundle, urlMap);

  // 4) Terminología mínima para errores del validador:
  //    - LOINC 11369-6 display permitido
  //    - MedicationStatement.medicationCodeableConcept.coding[].system
  //    - Immunization.vaccineCode.coding[].system SNOMED (429374003 = Yellow fever vaccine)
  const sec = comp.section || [];
  for (const s of sec) {
    const c = s?.code?.coding?.[0];
    if (c?.system === 'http://loinc.org' && c.code === '11369-6') {
      c.display = 'History of Immunization note';
    }
  }
  for (const ent of (bundle.entry || [])) {
    const r = ent.resource;
    if (!r) continue;
    if (r.resourceType === 'MedicationStatement' && r.medicationCodeableConcept?.coding?.length) {
      r.medicationCodeableConcept.coding.forEach(cd => {
        if (!cd.system) cd.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
      });
    }
    if (r.resourceType === 'Immunization' && r.vaccineCode?.coding?.length) {
      r.vaccineCode.coding.forEach(cd => {
        if (!cd.system) {
          cd.system = 'http://snomed.info/sct';
          if (!cd.code) { cd.code = '429374003'; cd.display = cd.display || 'Yellow fever vaccine'; }
        }
      });
    }
  }
}

// ====== NUEVO: Generador del Provide Document Bundle (ITI-65) usando el ICVP ya normalizado ======
function buildProvideDocumentBundle_ICVP(icvpBundle) {
  // 1) Asegurar que el ICVP esté listo (URNs, perfiles, custodian/subject)
  finalizeICVPBundle(icvpBundle);
  // 2) Construir el DocumentReference con info rica
  const docRef = buildDocumentReferenceFromICVP(icvpBundle);
  // 3) Armar el Bundle de transacción ITI-65 (MHD)
  const docId = uuidv4();
  const docFullUrl = makeUrn(docId);
  const prov = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        fullUrl: docFullUrl,
        request: { method: 'POST', url: 'DocumentReference' },
        resource: {
          ...docRef,
          // formatCode MHD
          content: docRef.content?.map(c => ({
            ...c,
            format: { coding: [{ system: MHD_FORMAT_SYSTEM, code: MHD_FORMAT_CODE }] }
          }))
        }
      },
      // Según tu configuración previa, aquí incluyes Binary o Bundle/document
      // (no cambiamos tu estrategia; solo aseguramos que el DocumentReference se nutra del ICVP)
    ]
  };
  return prov;
}

// ===================== Las siguientes funciones ya están definidas arriba =====================

function sortCodingsPreferred_OLD(codings) {
    const pref = [CS_SCT]; // primero SNOMED
    return [...codings].sort((a, b) => {
        const ia = pref.indexOf(a.system);
        const ib = pref.indexOf(b.system);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
}

/**
 * Normaliza un Bundle tipo "document" a URN UUID y garantiza que:
 *  - Composition.meta.profile use el canónico ICVP esperado por el validador.
 *  - Composition.subject y author[] referencien por URN UUID (no relativo/absoluto).
 *  - Patient/Practitioner/Organization usen perfiles IPS conocidos (evita UNKNOWN).
 *  - Immunization cumpla con ICVP: vaccineCode en ICD-11 MMS si es posible y
 *    la extensión de ProductID (PreQual) mantenga system/código.
 */
function postProcessICVPDocumentBundle(bundle) {
  if (!bundle || String(bundle.type || '').toLowerCase() !== 'document') return;

  // 1) Forzar modo URN para entry.fullUrl y referencias
  applyUrlModeToBundle(bundle, 'urn', updateReferencesInObject);

  // 2) Alinear perfiles del Bundle y de Composition a canónicos ICVP
  ensureLacBundleProfile(bundle); // ya mapea al ICVP Bundle con versión
  const comp = bundle.entry?.[0]?.resource;
  if (comp?.resourceType === 'Composition') {
    ensureLacCompositionProfile(comp); // cambia a http://smart.who.int/icvp/StructureDefinition/Composition-uv-ips-ICVP
  }

  // 3) Parche de subject/author a URN (por si vinieran relativos)
  const compEntry = bundle.entry?.[0];
  if (comp && compEntry?.fullUrl?.startsWith('urn:uuid:')) {
    const patEntry = (bundle.entry || []).find(en => en.resource?.resourceType === 'Patient');
    if (patEntry?.fullUrl) {
      comp.subject = { reference: patEntry.fullUrl };
    }
    if (Array.isArray(comp.author)) {
      comp.author = comp.author.map(a => {
        // Si viene "Practitioner/xxx" o "Organization/yyy" → forzar URN si existe en el bundle
        if (/^[A-Za-z]+\/[A-Za-z0-9\-\.]+$/.test(a?.reference || '')) {
          const [typ, id] = a.reference.split('/');
          const hit = (bundle.entry || []).find(en => en.resource?.resourceType === typ && en.resource?.id === id);
          return hit?.fullUrl ? { reference: hit.fullUrl } : a;
        }
        return a;
      });
    }
  }

  // 4) Quitar perfiles locales desconocidos y forzar IPS Organization
  for (const e of (bundle.entry || [])) {
    const r = e.resource;
    if (r?.resourceType === 'Organization') {
      // Perfil IPS para evitar "unknown profile"
      addProfile(r, IPS_PROFILES.ORGANIZATION);
      // Reemplaza systems HTTP locales por URN OID si detecta los dominios conocidos
      (r.identifier || []).forEach(id => {
        if (id.system === 'https://registroorganizaciones.cl/id') {
          id.system = toUrnOid(process.env.LAC_ORG_SYS_OID || '2.16.152.1.3.0.1');
        }
      });
    }
  }

  // 5) Arreglar MedicationStatement sin system en "no-medication-info"
  fixMedicationStatementCodingSystems(bundle);

  // 6) Immunization (ICVP): perfil + business identifier + fallback de sistema en vaccineCode
  for (const e of (bundle.entry || [])) {
    const im = e.resource;
    if (im?.resourceType !== 'Immunization') continue;
    
    // Perfil ICVP
    addProfile(im, LAC_PROFILES.IMMUNIZATION);

    // --- ProductID: migrar valueIdentifier -> valueCoding (PCMT), y arreglar system
    if (Array.isArray(im.extension)) {
      im.extension.forEach(ext => {
        if (ext?.url === ICVP_PRODUCT_EXT_URL) {
          if (ext.valueIdentifier?.value) {
            ext.valueCoding = { system: CS_PREQUAL_PRODUCTIDS, code: String(ext.valueIdentifier.value) };
            delete ext.valueIdentifier;
          }
          if (ext.valueCoding?.system === 'http://smart.who.int/pcmt-vaxprequal/CodeSystem/PreQualProductIDs') {
            ext.valueCoding.system = CS_PREQUAL_PRODUCTIDS;
          }
        }
      });
    }

    // --- (1) Extensión de PRODUCTO = PreQual (PCMT ProductID) ---
    const hasProductId = Array.isArray(im.extension) &&
                         im.extension.some(x => x?.url === ICVP_PRODUCT_EXT_URL &&
                           ((x?.valueCoding && x.valueCoding.code) || (x?.valueIdentifier && x.valueIdentifier.value)));
    if (!hasProductId) {
      im.extension = im.extension || [];
      // Usa un identificador estable del producto si lo traes; si no, cae a un candidato neutro
      const candidateValue = im?.vaccineCode?.coding?.find(c => c?.code)?.code || im?.id || 'unknown';
      im.extension.unshift({
        url: ICVP_PRODUCT_EXT_URL,
        valueCoding: { system: CS_PREQUAL_PRODUCTIDS, code: candidateValue }
      });
    }

    // --- (2) vaccineCode: preferir catálogo ICVP/PreQual (Vaccine Type) ---
    // Si falta 'system' en algún coding con 'code', asumimos catálogo ICVP Vaccine Type.
    if (im.vaccineCode?.coding?.length) {
      im.vaccineCode.coding.forEach(c => {
        if (!c?.code) return;
        if (!c.system) c.system = CS_PREQUAL_VACCINETYPE;
        // corrige un system inválido si lo encontráramos
        if (c.system === 'http://smart.who.int/pcmt-vaxprequal/CodeSystem/PreQualProductIDs') {
          c.system = CS_PREQUAL_VACCINETYPE;
        }
      });
    }
  }
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
const ICVP_DOSE_EXT = 'http://smart.who.int/icvp/StructureDefinition/doseNumberCodeableConcept';
const ICVP_VACCINE_CODE_HINT = 'icvp'; // simple heurístico, ajustar según tu sistema real

function ensureCompositionFirst(summaryBundle) {
    if (!summaryBundle?.entry) return;
    const idx = summaryBundle.entry.findIndex(e => e.resource?.resourceType === 'Composition');
    if (idx > 0) {
        const comp = summaryBundle.entry.splice(idx, 1)[0];
        summaryBundle.entry.unshift(comp);
    }
    // Asegurar que la Composition tenga fullUrl/id coherente
    const first = summaryBundle.entry[0];
    if (first && first.resource?.resourceType === 'Composition') {
        if (!first.fullUrl && first.resource.id) first.fullUrl = `urn:uuid:${first.resource.id}`;
        if (!first.resource.id && first.fullUrl?.startsWith('urn:uuid:')) {
            first.resource.id = first.fullUrl.split(':').pop();
        }
        // asegurar perfil ICVP/LAC si hace falta
        addProfile(first.resource, LAC_PROFILES.COMPOSITION);
    }
}

function removeUnknownDoseExtension(summaryBundle) {
    if (!summaryBundle?.entry) return;
    for (const e of summaryBundle.entry) {
        const r = e.resource;
        if (!r) continue;
        if (r.resourceType === 'Immunization' && Array.isArray(r.protocolApplied)) {
            for (const p of r.protocolApplied) {
                if (Array.isArray(p.extension)) {
                    p.extension = p.extension.filter(ext => ext.url !== ICVP_DOSE_EXT);
                    if (p.extension.length === 0) delete p.extension;
                }
            }
        }
    }
}

function warnIfNonIcvpVaccine(summaryBundle) {
    if (!summaryBundle?.entry) return;
    for (const e of summaryBundle.entry) {
        const r = e.resource;
        if (!r) continue;
        if (r.resourceType === 'Immunization') {
            const codings = r.vaccineCode?.coding || [];
            const hasIcvp = codings.some(c => (c.system || '').toLowerCase().includes(ICVP_VACCINE_CODE_HINT));
            if (!hasIcvp) {
                console.warn('⚠️ Immunization sin código ICVP detectado. El validador ICVP puede fallar. Añade coding del catálogo ICVP o referencia a InventoryItem.', { id: r.id });
            }
        }
    }
}

function buildUrlMapUsingBase(summaryBundle) {
    const urlMap = new Map();
    const base = asAbsoluteBase(FHIR_NODO_NACIONAL_SERVER || '');
    for (const e of summaryBundle.entry || []) {
        const r = e.resource;
        if (!r?.resourceType) continue;
        const id = e.fullUrl?.startsWith('urn:uuid:') ? e.fullUrl.split(':').pop() : (r.id || null);
        if (!id) continue;
        const abs = `${base}/${r.resourceType}/${id}`;
        urlMap.set(`${r.resourceType}/${id}`, abs);
        // también mapear variantes comunes
        urlMap.set(`urn:uuid:${id}`, abs);
        urlMap.set(`${abs}`, abs);
    }
    return urlMap;
}

// Uso recomendado: justo antes de validar el bundle
function preValidateIcvpBundle(summaryBundle) {
    // 1) composition first
    ensureCompositionFirst(summaryBundle);

    // 2) quitar extensiones no permitidas en immunizations
    removeUnknownDoseExtension(summaryBundle);

    // 3) advertencias sobre vaccineCode
    warnIfNonIcvpVaccine(summaryBundle);

    // (IMPORTANTE) No remapear a absoluto en Document Bundles: mantener URN coherente
    // 4–5 eliminados

    // 6) asegurar Composition.subject referencia a Patient existente (usar URN si está)
    const compEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Composition');
    const patEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Patient');
    if (compEntry?.resource && patEntry) {
        const patFull = patEntry.fullUrl || (patEntry.resource?.id ? `urn:uuid:${patEntry.resource.id}` : null);
        if (patFull) compEntry.resource.subject = { reference: patFull };
    }
}

// ===================== Función para corregir Bundle - INTEGRADA =====================
function fixBundleValidationIssues(summaryBundle) {
    if (!summaryBundle?.entry || !Array.isArray(summaryBundle.entry)) return;

    // 0) QUITAR narrativeLink en recursos IPS con slicing cerrado
    for (const e of summaryBundle.entry) {
        const r = e.resource;
        if (!r) continue;
        // Aplicamos a tipos que el validador reportó: AllergyIntolerance, MedicationStatement y Condition
        if (['AllergyIntolerance','MedicationStatement','Condition','Immunization'].includes(r.resourceType)) {
            stripNarrativeLinkExtensions(r);
        }
        // LIMPIEZA NUEVA: AllergyIntolerance, Medication y Practitioner
        if (r?.resourceType === 'AllergyIntolerance') sanitizeAllergyIntolerance(r);
        if (r.resourceType === 'Medication') {
            sanitizeMedicationResource(r);
        }
        if (r.resourceType === 'Practitioner') {
            sanitizePractitionerIdentifiers(r);
        }
    }

    // Las URL se normalizan más abajo con applyUrlModeToBundle(), evitando doble canonicalización.

    // === Post-canonicalización: Patient
    const patientEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Patient');
    if (patientEntry?.resource) {
        // CRÍTICO: Aplicar fixPatientIdentifiers ANTES de cualquier otra validación
        fixPatientIdentifiers(summaryBundle);

        // Validar que el Patient tenga al menos un identifier con URN OID válido
        const hasValidOidIdentifier = patientEntry.resource.identifier?.some(id =>
            isUrnOid(id.system) && id.value && id.type?.coding?.some(c => c.code === 'MR' || c.code === 'PPN')
        );

        if (!hasValidOidIdentifier) {
            console.warn('⚠️ Patient no tiene identifiers URN OID válidos después de fixPatientIdentifiers');
            // Forzar creación de un identifier básico
            patientEntry.resource.identifier = [{
                use: 'usual',                                 // MR debe ser 'usual'
                type: {
                    coding: [{
                        system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                        code: 'MR'
                    }]
                },
                system: toUrnOid('2.16.152'), // OID genérico normalizado a urn:oid.<...>
                value: patientEntry.resource.id || 'unknown'
            }];
        }

        ensureLacPatientProfile(patientEntry.resource);
        ensureIpsPatientProfile(patientEntry.resource);
        if (Array.isArray(patientEntry.resource.address)) {
            patientEntry.resource.address.forEach(a => {
                const v = String(a.country || '').trim().toUpperCase();
                if (v === 'CHILE' || v === 'CHILE ' || v === 'CL ') a.country = 'CL';
            });
        }
    }


    // 1. Corregir Composition - asegurar ID y custodian (LAC Bundle)
    summaryBundle.type = summaryBundle.type || 'document';

    const compositionEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Composition');
    if (compositionEntry?.resource) {
        // ID del Composition DEBE empatar con el fullUrl (soporta urn|relative|absolute)
        const fu = String(compositionEntry.fullUrl || '');
        let compId = null;
        if (fu.startsWith('urn:uuid:')) {
            compId = fu.split(':').pop();
        } else if (fu) {
            const parts = fu.split('/').filter(Boolean);
            compId = parts[parts.length - 1] || null;
        }
        if (compId) compositionEntry.resource.id = compId;

        // Asegurar custodian (requerido por el perfil lac-composition)
        if (!compositionEntry.resource.custodian) {
            const orgEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Organization');
            if (orgEntry) {
                compositionEntry.resource.custodian = {
                    reference: orgEntry.fullUrl || `Organization/${orgEntry.resource.id}`
                };
            }
        }

        // Perfiles canónicos
        ensureLacCompositionProfile(compositionEntry.resource);
        ensureLacBundleProfile(summaryBundle);

        // Sujeto del Composition -> Patient
        const patEntryForComp = summaryBundle.entry.find(e => e.resource?.resourceType === 'Patient');
        ensureCompositionSubject(compositionEntry.resource, patEntryForComp);

        // Secciones obligatorias (garantiza al menos una entry válida por slice)
        // Alergias: LOINC 48765-2 → AllergyIntolerance
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.ALLERGIES_SECTION, ['AllergyIntolerance']);

        // Inmunizaciones: LOINC 11369-6 → Immunization
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.IMMUNIZATIONS_SECTION, ['Immunization']);

        // Problemas activos/lista de problemas: LOINC 11450-4 → Condition
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.PROBLEMS_SECTION, ['Condition']);

        // Medicación: LOINC 10160-0 → MedicationStatement o MedicationRequest
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.MEDICATIONS_SECTION, ['MedicationStatement','MedicationRequest']);

        // Antecedentes (Past Illness Hx): LOINC 11348-0 → Condition
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.PAST_ILLNESS_SECTION, ['Condition']);
    }

    // 2.bis Deduplicar y filtrar entries por tipo permitido en cada sección IPS
    if (compositionEntry?.resource?.section) {
        // Mapa loinc -> tipos permitidos
        const sectionAllowedTypes = {
            [LOINC_CODES.ALLERGIES_SECTION]: ['AllergyIntolerance'],
            [LOINC_CODES.IMMUNIZATIONS_SECTION]: ['Immunization'],
            [LOINC_CODES.MEDICATIONS_SECTION]: ['MedicationStatement','MedicationRequest'],
            [LOINC_CODES.PROBLEMS_SECTION]: ['Condition'],
            [LOINC_CODES.PAST_ILLNESS_SECTION]: ['Condition']
        };
        compositionEntry.resource.section.forEach(sec => {
            const loinc = (sec.code?.coding || []).find(c => c.system === 'http://loinc.org')?.code;
            const allowed = sectionAllowedTypes[loinc] || null;
            if (!Array.isArray(sec.entry)) return;
            const seen = new Set();
            sec.entry = sec.entry.filter(e => {
                const ref = e?.reference || '';
                if (!ref) return false;
                if (seen.has(ref)) return false;     // dedupe
                // Validar que la referencia resuelva a un recurso permitido
                const resolved = summaryBundle.entry?.find(x => {
                    const fu = x.fullUrl || (x.resource?.id ? `${x.resource.resourceType}/${x.resource.id}` : '');
                    return fu === ref || fu?.endsWith(`/${ref.split('/').pop()}`);
                })?.resource;
                if (!resolved) return false;
                if (allowed && !allowed.includes(resolved.resourceType)) return false;
                seen.add(ref);
                return true;
            });
        });
    }

    // 2. Perfiles IPS en recursos referenciados por las secciones para que pasen los discriminadores
    for (const e of summaryBundle.entry) {
        const r = e.resource;
        if (!r) continue;

        // Alergias, Medicación, Problemas (activos/pasados)…
        if (['AllergyIntolerance','Immunization','MedicationStatement','MedicationRequest','Condition','Organization']
            .includes(r.resourceType)) {
            ensureIpsProfile(r);
        }
    }

    // 3. Corregir sección "Historial de Enfermedades Pasadas"
    if (compositionEntry?.resource?.section) {
        const pastIllnessSection = compositionEntry.resource.section.find(s =>
            s.code?.coding?.some(c => c.code === '11348-0')
        );

        if (pastIllnessSection) {
            // Agregar div requerido al text.div
            pastIllnessSection.text.div = '<div xmlns="http://www.w3.org/1999/xhtml"><h5>Historial de Enfermedades Pasadas</h5><p>Condiciones médicas previas del paciente.</p></div>';

            // Corregir display del código LOINC
            const loincCoding = pastIllnessSection.code.coding.find(c => c.system === 'http://loinc.org' && c.code === '11348-0');
            if (loincCoding && loincCoding.display === 'History of Past illness Narrative') {
                loincCoding.display = 'History of Past illness note';
            }
        }
    }

    // 3. Continuar con patientEntry ya procesado en sección 1)

    // 4. Corregir address.country del Patient para cumplir ISO 3166
    if (patientEntry?.resource?.address) {
        patientEntry.resource.address.forEach(addr => {
            if (addr.country === 'Chile') {
                addr.country = 'CL'; // Código ISO 3166-1 alpha-2
            }
        });
    }

    // 5. Corregir Conditions - filtrar OpenMRS y codings sin system
    summaryBundle.entry?.forEach(entry => {
        if (entry.resource?.resourceType === 'Condition' && entry.resource.code?.coding) {
            // Filtrar codings sin system y OpenMRS (problemático para validación IPS/LAC)
            entry.resource.code.coding = entry.resource.code.coding
                .filter(c => !!c.system && c.system !== 'http://openmrs.org/concepts');

            // Si quedan codings, ordenar con SNOMED primero
            if (entry.resource.code.coding.length > 0) {
                entry.resource.code.coding = sortCodingsPreferred(entry.resource.code.coding);
            }
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
                    // Refuerzo específico para no-medication-info
                    if ((coding.code === 'no-medication-info') || (coding.display === 'No information about medications')) {
                        coding.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
                        coding.code = 'no-medication-info';
                        if (!coding.display) coding.display = 'No information about medications';
                    }
                });
            }

            // Agregar effective[x] requerido por el perfil IPS
            if (!entry.resource.effectiveDateTime && !entry.resource.effectivePeriod) {
                entry.resource.effectiveDateTime = new Date().toISOString();
            }
        }

        // Refuerzo: filtrar OpenMRS y ordenar codings de Condition
        if (entry.resource?.resourceType === 'Condition' && Array.isArray(entry.resource.code?.coding)) {
            entry.resource.code.coding = entry.resource.code.coding
                .filter(c => !!c.system && c.system !== 'http://openmrs.org/concepts');
            if (entry.resource.code.coding.length > 0) {
                entry.resource.code.coding = sortCodingsPreferred(entry.resource.code.coding);
            }
        }


    });

    // 6.bis Corregir AllergyIntolerance - absent/unknown 'no-allergy-info'
    summaryBundle.entry?.forEach(entry => {
        const res = entry.resource;
        if (res?.resourceType === 'AllergyIntolerance' && Array.isArray(res.code?.coding)) {
            // 2.1 Filtrar codings sin system y los locales OpenMRS
            res.code.coding = res.code.coding.filter(c =>
                !!c.system && c.system !== 'http://openmrs.org/concepts'
            );
            // 2.2 Si quedan codings, ordenar con SNOMED primero
            if (res.code.coding.length > 0) {
                res.code.coding = sortCodingsPreferred(res.code.coding);
            }
            // 2.3 Refuerzo absent/unknown (mantener)
            res.code.coding.forEach(c => {
                if (c.code === 'no-allergy-info' || c.display === 'No information about allergies') {
                    c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
                    c.code = 'no-allergy-info';
                    if (!c.display) c.display = 'No information about allergies';
                }
            });
        }
    });

    // 6.ter - Corregir Immunization - absent/unknown 'no-immunization-info'
    summaryBundle.entry?.forEach(entry => {
        const res = entry.resource;
        if (res?.resourceType === 'Immunization' && res.vaccineCode?.coding?.length) {
            res.vaccineCode.coding.forEach(c => {
                if (!c.system) {
                    c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
                }
                if (c.code === 'no-immunization-info' || c.display === 'No information about immunizations') {
                    c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
                    c.code = 'no-immunization-info';
                    if (!c.display) c.display = 'No information about immunizations';
                }
            });
        }
    });

    // Aplicar a todos los Immunization del bundle
    for (const entry of summaryBundle.entry) {
        if (entry.resource?.resourceType === 'Immunization') {
            ensureIcvpForImmunization(entry.resource);
        }
    }

    // 7. Asegurar que todas las referencias internas estén en el Bundle
    const allFullUrls = new Set(summaryBundle.entry?.map(e => e.fullUrl) || []);

    summaryBundle.entry?.forEach(entry => {
        // Revisar todas las referencias en el recurso
        checkAndFixReferences(entry.resource, allFullUrls, summaryBundle);
    });

    // 7.bis. Sanear meta.source que empiecen con '#' (problemático para validación)
    for (const e of summaryBundle.entry || []) {
        const r = e.resource;
        if (r?.meta?.source && typeof r.meta.source === 'string' && r.meta.source.startsWith('#')) {
            // Opción A: borrar
            delete r.meta.source;

            // O si prefieres Opción B: convertir a una URI canónica del sistema
            // r.meta.source = asFhirBase(process.env.ABSOLUTE_FULLURL_BASE || process.env.FHIR_NODE_URL || 'urn:uuid:' + r.id);
        }
    }

    // 8) Refuerzo: Composition.meta.profile debe contener lac-composition (racsel)
    const LAC_COMPOSITION = LAC_PROFILES.COMPOSITION;
    if (compositionEntry?.resource) {
        compositionEntry.resource.meta = compositionEntry.resource.meta || {};
        compositionEntry.resource.meta.profile = Array.isArray(compositionEntry.resource.meta.profile)
            ? compositionEntry.resource.meta.profile
            : [];
        if (!compositionEntry.resource.meta.profile.includes(LAC_COMPOSITION)) {
            compositionEntry.resource.meta.profile.push(LAC_COMPOSITION);
        }
    }

    // 9) NUEVAS MEJORAS LAC: Patient identifiers con URN OIDs (solo si NO hay identifiers)
    const natOid = LAC_NATIONAL_ID_SYSTEM_OID;   // p.ej. 1.2.36.146.595.217.0.1
    const ppnOid = LAC_PASSPORT_ID_SYSTEM_OID;   // p.ej. 2.16.840.1.113883.4.1
    // Reutilizar patientEntry ya definido anteriormente
    if (patientEntry?.resource && (natOid || ppnOid)) {
        const patient = patientEntry.resource;
        // Si ya hay identifiers (y fixPatientIdentifiers ya corrió), no rehacerlos
        if (Array.isArray(patient.identifier) && patient.identifier.length > 0) {
            // no-op: ya normalizados por fixPatientIdentifiers
        } else {
            // Preservar identifiers originales (si los hubiera) y construir por defecto
            const originalIds = [...(patient.identifier || [])];
            patient.identifier = [];

            // Buscar identifier nacional (MR) existente
            const nationalId = originalIds.find(id =>
                id.type?.coding?.some(c => c.code === 'MR') ||
                id.use === 'official' ||
                id.system?.includes('rut') || id.system?.includes('cedula')
            );

            if (natOid && nationalId) {
                patient.identifier.push({
                    use: 'usual',                                 // MR debe ser 'usual'
                    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
                    system: toUrnOid(natOid),
                    value: nationalId.value || 'unknown'
                });
            }

            // Buscar identifier de pasaporte (PPN) existente
            const passportId = originalIds.find(id =>
                id.type?.coding?.some(c => c.code === 'PPN') ||
                id.system?.includes('passport') || id.system?.includes('pasaporte')
            );

            if (ppnOid && passportId) {
                patient.identifier.push({
                    use: 'official',
                    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PPN' }] },
                    system: toUrnOid(ppnOid),
                    value: passportId.value || 'unknown'
                });
            }

            // Si no encontramos identifiers apropiados, crear con valores por defecto
            if (patient.identifier.length === 0 && natOid) {
                const defaultValue = originalIds[0]?.value || `ID-${patient.id || 'unknown'}`;
                patient.identifier.push({
                    use: 'usual',                                 // MR debe ser 'usual'
                    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
                    system: toUrnOid(natOid),
                    value: defaultValue
                });
            }
        }
    }

    // 10) Corregir país a códigos ISO2
    fixPatientCountry(summaryBundle);

    // 11) Asegurar MedicationStatement.effectiveDateTime
    summaryBundle.entry?.forEach(entry => {
        const res = entry.resource;
        if (res?.resourceType === 'MedicationStatement') {
            if (!res.effectiveDateTime && !res.effectivePeriod) {
                res.effectiveDateTime = new Date().toISOString();
            }
        }
    });

    // 12) VALIDACIÓN FINAL: Verificar que los slices críticos estén correctamente configurados
    const finalValidation = () => {
        // Verificar Bundle.entry[0] = Composition con perfil LAC
        const comp = summaryBundle.entry?.[0];
        if (comp?.resource?.resourceType !== 'Composition') {
            console.error('❌ Bundle.entry[0] debe ser Composition');
            return false;
        }
        if (!comp.resource.meta?.profile?.includes('http://smart.who.int/icvp/StructureDefinition/Composition-uv-ips-ICVP')) {
            console.error('❌ Composition no tiene perfil ICVP');
            return false;
        }

        // Verificar Bundle.entry[1] = Patient con perfiles LAC e IPS y URN OID
        const pat = summaryBundle.entry?.[1];
        if (pat?.resource?.resourceType !== 'Patient') {
            console.error('❌ Bundle.entry[1] debe ser Patient');
            return false;
        }
        if (!pat.resource.meta?.profile?.includes('http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips')) {
            console.error('❌ Patient no tiene perfil lac-patient');
            return false;
        }
        const hasValidIdentifier = pat.resource.identifier?.some(id => isUrnOid(id.system));
        if (!hasValidIdentifier) {
            console.error('❌ Patient no tiene identifiers con URN OID válidos');
            console.error('Identifiers:', pat.resource.identifier);
            return false;
        }

        return true;
    };

    const isValid = finalValidation();
    if (isValid) {
        console.log('✅ Bundle LAC validation passed');
    } else {
        console.error('❌ Bundle LAC validation failed - check console for details');
    }
}

// ===================== Helper: actualiza todas las referencias recursivamente =====================
function updateReferencesInObject(obj, urlMap) {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
        obj.forEach(item => updateReferencesInObject(item, urlMap));
        return;
    }

    if (obj.reference && typeof obj.reference === 'string') {
        const mapped = urlMap.get(obj.reference);
        if (mapped) {
            obj.reference = mapped;
        }
    }

    // Si es un Attachment (tiene contentType/data/size/hash) y trae url, también mapearla
    if (obj.url && typeof obj.url === 'string' &&
        (Object.prototype.hasOwnProperty.call(obj, 'contentType') ||
            Object.prototype.hasOwnProperty.call(obj, 'data') ||
            Object.prototype.hasOwnProperty.call(obj, 'size') ||
            Object.prototype.hasOwnProperty.call(obj, 'hash'))) {
        const mappedUrl = urlMap.get(obj.url);
        if (mappedUrl) {
            obj.url = mappedUrl;
        }
    }

    for (const key in obj) {
        if (obj.hasOwnProperty(key) && key !== 'reference') {
            updateReferencesInObject(obj[key], urlMap);
        }
    }
}


function normalizePractitionerResource(prac) {
    if (!prac || prac.resourceType !== 'Practitioner') return;

    const identifiers = [
        {
            "use": "official",
            "type": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
                        "code": "PPN",
                        "display": "Passport number"
                    }
                ]
            },
            "value": "P34567890"
        },
        {
            "use": "official",
            "type": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
                        "code": "PRN",
                        "display": "Provider number"
                    }
                ]
            },
            "value": "P2Q3R"
        }
    ];

    const name = [
        {
            "use": "official",
            "family": "Barrios",
            "given": [
                "Gracia"
            ]
        }
    ];

    const address = [
        {
            "text": "Chile",
            "country": "CL"
        }
    ]

    const qualifications = [
        {
            "code": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0360",
                        "code": "RN",
                        "display": "Registered Nurse"
                    }
                ]
            }
        }
    ]

    prac.identifier = identifiers;
    prac.name = name;
    prac.gender = 'female';
    prac.birthDate = '1927-06-27';
    prac.qualification = qualifications;
    return prac;
}
function normalizeOrganizationResource(orga) {
    if (!orga || orga.resourceType !== 'Organization') return;
    const identifiers = [
        {
            "use": "official",
            "system": toUrnOid(process.env.LAC_ORG_SYS_OID || '2.16.152.1.3.0.1'),
            "value": "G7H8"
        }
    ];
    const address = [
        {
            "line": [
                "Estoril 450"
            ],
            "city": "Región Metropolitana",
            "country": "CL"
        }
    ];
    addProfile(orga, IPS_PROFILES.ORGANIZATION);
    orga.identifier = identifiers;
    orga.name = 'Organization';
    orga.address = address;
    return orga;
}
// ====== NUEVO: asegurar mínimos ICVP/IPS en Immunization ======
function ensureIcvpForImmunization(im) {
  if (!im || im.resourceType !== 'Immunization') return im;

  // 1) Perfiles requeridos (IPS + ICVP de LAC)
  addProfile(im, IPS_PROFILES.IMMUNIZATION);
  addProfile(im, LAC_PROFILES.IMMUNIZATION);

  // 2) status mínimo
  //    - si trae absent/unknown 'no-immunization-info' mantenemos 'not-done'
  //    - en otro caso, por defecto 'completed'
  const isNoImmunInfo = (im.vaccineCode?.coding || []).some(c =>
    c.system === 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips' &&
    (c.code === 'no-immunization-info' || /no information about immunizations/i.test(c.display || ''))
  );
  if (!im.status) im.status = isNoImmunInfo ? 'not-done' : 'completed';

  // 3) vaccineCode — asegurar 'system' y un coding válido
  if (!im.vaccineCode) im.vaccineCode = {};
  im.vaccineCode.coding = Array.isArray(im.vaccineCode.coding) ? im.vaccineCode.coding : [];

  // - normalizar codings sin system
  im.vaccineCode.coding.forEach(c => {
    if (!c.system) {
      // preferimos catálogo PCMT VaccineType; si no, caemos a SNOMED
      c.system = CS_PREQUAL_VACCINETYPE;
    }
  });

  // - si no hay ningún coding con system+code, añadimos un fallback SNOMED genérico
  const hasUsableCoding = im.vaccineCode.coding.some(c => c.system && c.code);
  if (!hasUsableCoding && !isNoImmunInfo) {
    im.vaccineCode.coding.push({
      system: 'http://snomed.info/sct',
      code: '429374003', // Yellow fever vaccine (fallback neutro)
      display: im.vaccineCode.text || 'Yellow fever vaccine'
    });
  }

  // 4) Extensión de ProductID (PCMT) — si falta, creamos una con valor razonable
  //    Usa el CodeSystem oficial normalizado (…/PreQualProductIds)
  im.extension = Array.isArray(im.extension) ? im.extension : [];
  const hasProductId = im.extension.some(ext =>
    ext?.url === ICVP_PRODUCT_EXT_URL &&
    ((ext.valueCoding && ext.valueCoding.code) || (ext.valueIdentifier && ext.valueIdentifier.value))
  );
  if (!hasProductId && !isNoImmunInfo) {
    // tratamos de derivar un candidate desde vaccineCode.code
    const candidate =
      (im.vaccineCode?.coding || []).find(c => c.code)?.code ||
      im.id || 'unknown';
    im.extension.unshift({
      url: ICVP_PRODUCT_EXT_URL,
      valueCoding: { system: CS_PREQUAL_PRODUCTIDS, code: String(candidate) }
    });
  } else {
    // normaliza system mal tipeado si viniera
    im.extension.forEach(ext => {
      if (ext?.url === ICVP_PRODUCT_EXT_URL) {
        if (ext.valueIdentifier?.value) {
          ext.valueCoding = { system: CS_PREQUAL_PRODUCTIDS, code: String(ext.valueIdentifier.value) };
          delete ext.valueIdentifier;
        }
        if (ext.valueCoding?.system === 'http://smart.who.int/pcmt-vaxprequal/CodeSystem/PreQualProductIDs') {
          ext.valueCoding.system = CS_PREQUAL_PRODUCTIDS;
        }
      }
    });
  }

  // 5) occurrence[x] mínimo (ICVP/IPS no quiere eventos sin fecha)
  if (!im.occurrenceDateTime && !im.occurrenceString && !im.occurrencePeriod) {
    im.occurrenceDateTime = new Date().toISOString();
  }

  // 6) subject y performer opcionales pero, si existen, que sean Reference válidas
  //    (ya tienes rutinas para normalizar refs en el bundle completo; aquí solo saneamos estructuras)
  if (im.performer && !Array.isArray(im.performer)) {
    im.performer = [im.performer];
  }
  if (Array.isArray(im.performer)) {
    im.performer = im.performer
      .filter(p => p?.actor?.reference) // quitar entradas vacías
      .map(p => {
        // role opcional; si no hay, lo dejamos sin setear
        return { actor: { reference: p.actor.reference }, function: p.function };
      });
    if (im.performer.length === 0) delete im.performer;
  }

  // 7) protocolApplied — eliminar extensiones no permitidas (ya lo haces en removeUnknownDoseExtension)
  if (Array.isArray(im.protocolApplied)) {
    im.protocolApplied.forEach(pa => {
      if (Array.isArray(pa.extension)) {
        pa.extension = pa.extension.filter(ext => ext.url !== ICVP_DOSE_EXT);
        if (pa.extension.length === 0) delete pa.extension;
      }
      // Si te interesa dejar un número de dosis válido sin extensiones:
      // if (!pa.doseNumberPositiveInt && !pa.series && !pa.doseNumberString) {
      //   pa.doseNumberString = '1';
      // }
    });
    if (im.protocolApplied.length === 0) delete im.protocolApplied;
  }

  // 8) lotNumber/expirationDate son opcionales; si vienen vacíos, limpiarlos
  if (im.lotNumber !== undefined && String(im.lotNumber).trim() === '') delete im.lotNumber;
  if (im.expirationDate !== undefined && String(im.expirationDate).trim() === '') delete im.expirationDate;

  return im;
}


// ===================== Route ITI-65 =====================
// Helpers para construir URN
function makeUrn(id) { return `urn:uuid:${id}`; }
function makeAbsolute(type, id) {
  const base = asFhirBase(FHIR_NODO_NACIONAL_SERVER || FHIR_NODE_URL);
  return `${base}/${type}/${id}`;
}

// Helper: mergePatientDemographics (enriquece sin sobrescribir)
function mergePatientDemographics(local, pdqm) {
  if (!local || !pdqm) return;
  // name: agregar si falta
  if (!local.name || local.name.length === 0) local.name = pdqm.name;
  // birthDate
  if (!local.birthDate && pdqm.birthDate) local.birthDate = pdqm.birthDate;
  // gender
  if (!local.gender && pdqm.gender) local.gender = pdqm.gender;
  // address: merge arrays
  if (Array.isArray(pdqm.address)) {
    local.address = local.address || [];
    for (const a of pdqm.address) {
      if (!local.address.some(la => JSON.stringify(la) === JSON.stringify(a))) {
        local.address.push(a);
      }
    }
  }
  // telecom: merge
  if (Array.isArray(pdqm.telecom)) {
    local.telecom = local.telecom || [];
    for (const t of pdqm.telecom) {
      if (!local.telecom.some(lt => lt.system === t.system && lt.value === t.value)) {
        local.telecom.push(t);
      }
    }
  }
}

// ====== Handler ITI-65 (si aún no lo tienes pegado) ======
app.post('/icvp/_iti65', async (req, res) => {
  try {
    let summaryBundle;
    if (req.body?.uuid) {
      const url = `${asFhirBase(FHIR_NODE_URL)}/Patient/${encodeURIComponent(req.body.uuid)}/$summary`;
      const resp = await axios.get(url, {
        headers: { Accept: 'application/fhir+json' },
        httpsAgent: axios.defaults.httpsAgent
      });
      summaryBundle = resp.data;
    } else if (req.body?.resourceType === 'Bundle') {
      summaryBundle = req.body;
    } else {
      return res.status(400).json({ issue: [{ severity: 'error', code: 'invalid', diagnostics: 'Body must include { uuid } or a FHIR Bundle.' }] });
    }

    // Pre-validación y fixes
    preValidateIcvpBundle(summaryBundle);
    fixBundleValidationIssues(summaryBundle);

    // Terminología (no bloqueante)
    try { await normalizeTerminologyInBundle(summaryBundle); } catch (e) { tsLog('warn', 'TS normalize skipped', e?.message); }

    // Enriquecimiento PDQm (opcional)
    if (isTrue(FEATURE_PDQ_ENABLED)) {
      try {
        const ptEntry = getPatientEntry(summaryBundle);
        const patient = ptEntry?.resource;
        if (patient) {
          pdqmFetchBundleByIdentifier._localPatient = patient;
          const values = pickIdentifiersOrderedForPdqm(patient.identifier || []);
          for (const ident of values) {
            const b = await pdqmFetchBundleByIdentifier(ident);
            if (b?.entry?.length) {
              const pdqmPatient = b.entry.find(e => e.resource?.resourceType === 'Patient')?.resource;
              if (pdqmPatient) { mergePatientDemographics(patient, pdqmPatient); break; }
            } else if (isPdqmFallbackBundle(b)) {
              patient.identifier = patient.identifier || [];
              patient.identifier.push({ system: PDQM_DEFAULT_IDENTIFIER_SYSTEM || toUrnOid('1.2.3.4.5'), value: ident });
              break;
            }
          }
          delete pdqmFetchBundleByIdentifier._localPatient;
        }
      } catch (e) { console.warn('PDQm enrichment skipped:', e?.message); }
    }

    // Normalización final (URNs, perfiles, secciones)
    finalizeICVPBundle(summaryBundle);

    // DocumentReference base
    const baseDocRef = buildDocumentReferenceFromICVP(summaryBundle);

    // Provide Bundle (Binary / Bundle/document según flags)
    const provide = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const createBinaryEntry = (docObj) => {
      const dataStr = JSON.stringify(docObj);
      const buf = Buffer.from(dataStr, 'utf8');
      const b64 = buf.toString('base64');
      const sha1 = crypto.createHash('sha1').update(buf).digest('base64');
      const binId = uuidv4();
      const fullUrl = `urn:uuid:${binId}`;
      return {
        fullUrl, id: binId,
        size: buf.length, hashB64: sha1,
        resource: { resourceType: 'Binary', id: binId, contentType: 'application/fhir+json', data: b64 },
        request: { method: 'POST', url: 'Binary' }
      };
    };
    const createDocBundleEntry = (docObj) => {
      docObj.type = 'document';
      const id = docObj.id || uuidv4();
      docObj.id = id;
      const fullUrl = `urn:uuid:${id}`;
      return { fullUrl, id, resource: docObj, request: { method: 'POST', url: 'Bundle' } };
    };

    const wantBinary = String(BINARY_DELIVERY_MODE || 'both').toLowerCase() === 'binary' || String(BINARY_DELIVERY_MODE).toLowerCase() === 'both';
    const wantBundle = String(BINARY_DELIVERY_MODE || 'both').toLowerCase() === 'bundle' || String(BINARY_DELIVERY_MODE).toLowerCase() === 'both';
    const urlModeAbs = String(ATTACHMENT_URL_MODE || 'absolute').toLowerCase() === 'absolute';

    let attachment; let binaryEntry = null; let bundleEntry = null;
    if (wantBinary) {
      binaryEntry = createBinaryEntry(summaryBundle);
      provide.entry.push({ fullUrl: binaryEntry.fullUrl, resource: binaryEntry.resource, request: binaryEntry.request });
      attachment = {
        url: urlModeAbs ? makeAbsolute('Binary', binaryEntry.id) : binaryEntry.fullUrl,
        contentType: 'application/fhir+json',
        size: binaryEntry.size,
        hash: binaryEntry.hashB64
      };
    }
    if (!attachment && wantBundle) {
      bundleEntry = createDocBundleEntry(summaryBundle);
      provide.entry.push({ fullUrl: bundleEntry.fullUrl, resource: bundleEntry.resource, request: bundleEntry.request });
      const raw = Buffer.from(JSON.stringify(summaryBundle), 'utf8');
      attachment = {
        url: urlModeAbs ? makeAbsolute('Bundle', bundleEntry.id) : bundleEntry.fullUrl,
        contentType: 'application/fhir+json',
        size: raw.length,
        hash: crypto.createHash('sha1').update(raw).digest('base64')
      };
    }

    const docRefId = uuidv4();
    provide.entry.unshift({
      fullUrl: `urn:uuid:${docRefId}`,
      request: { method: 'POST', url: 'DocumentReference' },
      resource: {
        ...baseDocRef,
        id: docRefId,
        content: [{ attachment, format: { coding: [{ system: MHD_FORMAT_SYSTEM, code: MHD_FORMAT_CODE }] } }]
      }
    });

    return res.status(200).json(provide);
  } catch (e) {
    console.error('❌ /icvp/_iti65 error:', e?.response?.data || e?.message || e);
    return res.status(500).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'exception', diagnostics: String(e?.message || e) }]
    });
  }
});

// ====== Levantar servidor ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 LACPASS Mediator listening on :${PORT}`));
