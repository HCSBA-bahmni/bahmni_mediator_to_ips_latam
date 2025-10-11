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
  
  // LAC Patient identifiers OIDs
  LAC_NATIONAL_ID_SYSTEM_OID,
  LAC_PASSPORT_ID_SYSTEM_OID,
  
  // Debug level para ops terminológicas
  TS_DEBUG_LEVEL = 'warn', // 'debug', 'warn', 'error', 'silent'
} = process.env;

const isTrue = (v) => String(v).toLowerCase() === 'true';
const arr = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// ===================== Helper functions para LAC compliance =====================
// Quita acentos, espacios extra, pone minúsculas (para claves de mapa)
function normKey(s) {
  return (s ?? "")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
}

// Alias (nombres) -> ISO2
const COUNTRY_MAP = new Map(Object.entries({
  "argentina": "AR",
  "bahamas": "BS",
  "barbados": "BB",
  "belice": "BZ",
  "brasil": "BR",
  "brazil": "BR",
  "chile": "CL",
  "costa rica": "CR",
  "ecuador": "EC",
  "el salvador": "SV",
  "guatemala": "GT",
  "honduras": "HN",
  "panama": "PA",
  "panamá": "PA",
  "paraguay": "PY",
  "peru": "PE", "perú": "PE",
  "republica dominicana": "DO", "rep dominicana": "DO", "republica dom": "DO",
  "rep. dominicana": "DO", "republica do": "DO",
  "suriname": "SR",
  "uruguay": "UY",
}));

// ISO3 -> ISO2 para países LAC que manejas
const ISO3_TO_ISO2 = {
  ARG:"AR", BHS:"BS", BRB:"BB", BLZ:"BZ", BRA:"BR", CHL:"CL",
  CRI:"CR", ECU:"EC", SLV:"SV", GTM:"GT", HND:"HN", PAN:"PA",
  PRY:"PY", PER:"PE", DOM:"DO", SUR:"SR", URY:"UY"
};

function toIso2Country(input) {
  if (!input) return null;
  const raw = String(input).trim();
  // Ya viene ISO-2
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  // Viene ISO-3
  if (/^[A-Za-z]{3}$/.test(raw)) return ISO3_TO_ISO2[raw.toUpperCase()] ?? null;
  // Viene por nombre
  const key = normKey(raw);
  return COUNTRY_MAP.get(key) ?? null;
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

// ===================== Debug dir =====================
const debugDir = DEBUG_DIR_icvp ? path.resolve(DEBUG_DIR_icvp) : '/tmp';
try { fs.mkdirSync(debugDir, { recursive: true }); }
catch (e) { console.warn('⚠️ No se pudo crear debugDir:', e.message); }

// ===================== OpenHIM =====================
console.log(`Starting LACPASS→ITI-65 Mediator...`);
if (NODE_ENV === 'development') {
    axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    console.log('DEV MODE: https self-signed certificates accepted.');
}

// ===================== Logging de configuración =====================
console.log(`🔧 Terminology debug level: ${TS_DEBUG_LEVEL}`);
console.log(`📋 MHD formatCode: ${MHD_FORMAT_CODE}`);
if (NODE_ENV === 'production' && axios.defaults.httpsAgent?.rejectUnauthorized === false) {
  console.warn('⚠️ WARNING: Self-signed certificates accepted in PRODUCTION mode');
}

// ===================== OpenHIM =====================
const TERMINO_BASE = TERMINOLOGY_BASE_URL || TERMINO_SERVER_URL;

// Mediator registration
const openHimOptions = {
    username: OPENHIM_USER,
    password: OPENHIM_PASS,
    apiURL: OPENHIM_API,
    trustSelfSigned: true,
    urn: mediatorConfig.urn,
};

if (openHimOptions.apiURL && openHimOptions.username && openHimOptions.password) {
    registerMediator(openHimOptions, mediatorConfig, (err) => {
        if (err) {
            console.error('❌ OpenHIM registration failed:', err);
            process.exit(1);
        }
        console.log('✅ Mediator registered with OpenHIM');

        activateHeartbeat(openHimOptions);
    });
} else {
    console.warn('⚠️ OpenHIM credentials not provided. Skipping mediator registration.');
}

// ===================== CORS =====================
const app = express();
app.use(express.json({ limit: '10mb' }));

const corsOrigin = CORS_ORIGIN || '*';
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', corsOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ===================== Correlation ID =====================
app.use((req, res, next) => {
    req.correlationId = req.headers['x-correlation-id'] || uuidv4();
    res.header('X-Correlation-ID', req.correlationId);
    next();
});

// ===================== Helper terminología =====================
const DOMAIN_LIST = arr(TS_DOMAINS);

// Mapa de configuración de dominio
const DOMAIN_CONFIG = {};
for (const domain of DOMAIN_LIST) {
    const domainUpper = domain.toUpperCase();
    DOMAIN_CONFIG[domain] = {
        vsExpand: process.env[`${domainUpper}_VS_EXPAND_URI`] || '',
        vsValidate: process.env[`${domainUpper}_VS_VALIDATE_URI`] || '',
        codeSystem: process.env[`${domainUpper}_CS_URI`] || 'http://snomed.info/sct',
        translate: {
            conceptMapUrl: process.env[`${domainUpper}_TRANSLATE_CONCEPTMAP_URL`] || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
            sourceVS: process.env[`${domainUpper}_TRANSLATE_SOURCE_VS`] || TS_TRANSLATE_DEFAULT_SOURCE_VS,
            targetVS: process.env[`${domainUpper}_TRANSLATE_TARGET_VS`] || TS_TRANSLATE_DEFAULT_TARGET_VS,
            sourceSystem: process.env[`${domainUpper}_TRANSLATE_SOURCE_SYSTEM`] || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
            targetSystem: process.env[`${domainUpper}_TRANSLATE_TARGET_SYSTEM`] || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
        }
    };
}

function resourceToDomain(resource) {
    const type = resource?.resourceType;
    if (type === 'Condition') return 'conditions';
    if (type === 'Procedure') return 'procedures';
    if (type === 'MedicationStatement' || type === 'MedicationRequest') return 'medications';
    if (type === 'Immunization') return 'vaccines';
    return TS_DEFAULT_DOMAIN;
}

function buildTsClient() {
    if (!TERMINO_BASE) return null;
    const client = axios.create({
        baseURL: TERMINO_BASE,
        timeout: parseInt(TS_TIMEOUT_MS, 10),
        httpsAgent: axios.defaults.httpsAgent,
        headers: { Accept: 'application/fhir+json' }
    });

    if (TERMINO_BEARER_TOKEN) {
        client.defaults.headers.common['Authorization'] = `Bearer ${TERMINO_BEARER_TOKEN}`;
    } else if (TERMINO_BASIC_USER && TERMINO_BASIC_PASS) {
        const auth = Buffer.from(`${TERMINO_BASIC_USER}:${TERMINO_BASIC_PASS}`).toString('base64');
        client.defaults.headers.common['Authorization'] = `Basic ${auth}`;
    }

    return client;
}

// ===================== PDQm Utils =====================
function pickIdentifierValueForPdqm(identifiers) {
    if (!Array.isArray(identifiers) || identifiers.length === 0) return null;

    const fallbackParamNames = arr(PDQM_IDENTIFIER_FALLBACK_PARAM_NAMES || 'RUN,RUNP,identifier');
    const defaultSystem = PDQM_DEFAULT_IDENTIFIER_SYSTEM || '';

    // 1. Buscar por sistema por defecto
    if (defaultSystem) {
        const idWithDefaultSystem = identifiers.find(id => id.system === defaultSystem);
        if (idWithDefaultSystem?.value) return idWithDefaultSystem.value;
    }

    // 2. Buscar por type.text que contenga algún paramName de fallback
    for (const paramName of fallbackParamNames) {
        const match = identifiers.find(id => id.type?.text?.toLowerCase().includes(paramName.toLowerCase()));
        if (match?.value) return match.value;
    }

    // 3. Buscar por value que contenga algún paramName de fallback
    for (const paramName of fallbackParamNames) {
        const match = identifiers.find(id => {
            if (!id.value) return false;
            const value = id.value.toLowerCase();
            const param = paramName.toLowerCase();
            return value.includes(param);
        });
        if (match?.value) return match.value;
    }

    // 4. Retornar el primer identifier con valor
    return identifiers[0]?.value || null; // último fallback
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

// ===================== TerminologyOp Response Parsers =====================
function extractResultFromParameters(data) {
    const out = { result: false, display: null };
    if (data?.resourceType === 'Parameters' && Array.isArray(data.parameter)) {
        for (const p of data.parameter) {
            if (p.name === 'result') {
                out.result = (p.valueBoolean === true) || (p.valueString === 'true');
            }
            if (p.name === 'display' && p.valueString) out.display = p.valueString;
        }
    }
    return out;
}

function extractDisplayFromLookup(data) {
    if (data?.resourceType !== 'Parameters') return null;
    const displayParam = data.parameter?.find(p => p.name === 'display');
    return displayParam?.valueString || null;
}

function extractMatchFromTranslate(data) {
    if (data?.resourceType !== 'Parameters') return null;
    const matchParam = data.parameter?.find(p => p.name === 'match');
    if (!matchParam?.part) return null;

    let equivalence, system, code, display;
    for (const part of matchParam.part) {
        if (part.name === 'equivalence') equivalence = part.valueCode;
        if (part.name === 'concept') {
            const concept = part.valueCoding;
            system = concept?.system;
            code = concept?.code;
            display = concept?.display;
        }
    }

    if (equivalence && system && code) {
        return { system, code, display, equivalence };
    }
    return null;
}

// ===================== Terminology Pipeline =====================
const CS_ABSENT = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
const CS_SCT = 'http://snomed.info/sct';

function asFhirBase(url) {
  const u = (url || '').replace(/\/+$/, '');
  return /\/fhir$/i.test(u) ? u : `${u}/fhir`;
}

function joinUrl(base, path) {
  const b = (base || '').replace(/\/+$/, '');
  const p = (path || '').replace(/^\/+/, '');
  return `${b}/${p}`;
}

function shouldLookupTS(system) {
  if (!isTrue(FEATURE_TS_ENABLED)) return false;
  if (system === CS_ABSENT) return false;
  if (system === CS_SCT && process.env.TS_HAS_SNOMED !== 'true') return false;
  return true;
}

function sortCodingsPreferred(codings) {
  const pref = [CS_SCT]; // primero SNOMED
  return [...codings].sort((a, b) => {
    const ia = pref.indexOf(a.system);
    const ib = pref.indexOf(b.system);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
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
        const cc = resource[field];
        if (cc?.coding && Array.isArray(cc.coding)) {
            yield { path: field, cc };
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
        await normalizeCC(ts, cc, domainCfg, domain);
      } catch (e) {
        console.warn(`⚠️ TS normalize error (${domain}.${path}):`, e.message);
      }
    }
  }

  console.log('✅ Normalización terminológica completada');
}

// ===================== Helpers nuevos =====================
function isUrnOid(value) {
  return typeof value === 'string' && /^urn:oid:\d+(\.\d+)+$/.test(value.trim());
}

function toUrnOid(value) {
  if (!value) return value;
  const v = value.trim();
  // Corrige casos como "urn:oid:urn:oid:1.2.3" o espacios
  const cleaned = v.replace(/^urn:oid:/i, '');
  return `urn:oid:${cleaned}`;
}

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

function fixPatientIdentifiers(patient) {
  if (!patient?.identifier) return;

  const OID_NAT = String(process.env.LAC_NATIONAL_ID_SYSTEM_OID || '').trim(); // MR
  const OID_INT = String(process.env.LAC_PASSPORT_ID_SYSTEM_OID || '').trim(); // PPN

  patient.identifier.forEach(identifier => {
    // Normalizar system a URN OID válido
    if (identifier.system) {
      identifier.system = toUrnOid(identifier.system);
    }

    // Si hay type.coding, asegurar system y mapear codes
    if (identifier.type?.coding) {
      identifier.type.coding.forEach(coding => {
        if (!coding.system) {
          coding.system = 'http://terminology.hl7.org/CodeSystem/v2-0203';
        }
        // Refuerzo por si vinieran GUIDs
        const codeMap = {
          'd3153eb0-5e07-11ef-8f7c-0242ac120002': 'MR',
          'a2551e57-6028-428b-be3c-21816c252e06': 'PPN'
        };
        if (codeMap[coding.code]) coding.code = codeMap[coding.code];
      });
    }

    // Forzar slices LAC: MR (nacional) y PPN (pasaporte)
    const codes = (identifier.type?.coding || []).map(c => c.code);
    if (codes.includes('MR')) {
      identifier.use = 'official';
      if (identifier.type?.text) delete identifier.type.text;

      // ⚠️ aquí forzamos a tu OID configurado, incluso si venía otro
      if (OID_NAT) identifier.system = toUrnOid(OID_NAT);
      else if (identifier.system && /^\d+(\.\d+)+$/.test(identifier.system)) {
        identifier.system = toUrnOid(identifier.system);
      }
    }
    if (codes.includes('PPN')) {
      identifier.use = 'official';
      if (identifier.type?.text) delete identifier.type.text;

      if (OID_INT) identifier.system = toUrnOid(OID_INT);
      else if (identifier.system && /^\d+(\.\d+)+$/.test(identifier.system)) {
        identifier.system = toUrnOid(identifier.system);
      }
    }
  });

  // Ordenar: primero MR, luego PPN
  patient.identifier.sort((a, b) => {
    const ra = (a.type?.coding || []).some(c => c.code === 'MR') ? 0 : 1;
    const rb = (b.type?.coding || []).some(c => c.code === 'MR') ? 0 : 1;
    return ra - rb;
  });
}

function ensureLacPatientProfile(patient) {
  const LAC_PATIENT_PROFILE = 'http://lacpass.racsel.org/StructureDefinition/lac-patient';
  patient.meta = patient.meta || {};
  patient.meta.profile = Array.isArray(patient.meta.profile) ? patient.meta.profile : [];
  if (!patient.meta.profile.includes(LAC_PATIENT_PROFILE)) {
    patient.meta.profile.push(LAC_PATIENT_PROFILE);
  }
}

function ensureIpsPatientProfile(patient) {
  const IPS_PATIENT = 'http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips';
  patient.meta = patient.meta || {};
  patient.meta.profile = Array.isArray(patient.meta.profile) ? patient.meta.profile : [];
  if (!patient.meta.profile.includes(IPS_PATIENT)) {
    patient.meta.profile.push(IPS_PATIENT);
  }
}

function ensureIpsProfile(resource) {
  if (!resource?.resourceType) return;
  const map = {
    'AllergyIntolerance': 'http://hl7.org/fhir/uv/ips/StructureDefinition/AllergyIntolerance-uv-ips',
    'MedicationStatement': 'http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationStatement-uv-ips',
    'MedicationRequest': 'http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationRequest-uv-ips',
    'Condition': 'http://hl7.org/fhir/uv/ips/StructureDefinition/Condition-uv-ips',
    'Organization': 'http://hl7.org/fhir/uv/ips/StructureDefinition/Organization-uv-ips'
  };
  const prof = map[resource.resourceType];
  if (!prof) return;
  resource.meta = resource.meta || {};
  resource.meta.profile = Array.isArray(resource.meta.profile) ? resource.meta.profile : [];
  if (!resource.meta.profile.includes(prof)) {
    resource.meta.profile.push(prof);
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
  }

  // 1) Lógica de Patient movida después de canonicalización
  // === NUEVO: Canonicalizar fullUrl y referencias internas a urn:uuid:<id> ===
  // (Esto soluciona BUNDLE_BUNDLE_ENTRY_NOTFOUND_APPARENT y BUNDLE_BUNDLE_POSSIBLE_MATCH_WRONG_FU)

  function makeUrn(id) { return `urn:uuid:${id}`; }

  function extractIdFromFullUrl(entry) {
    if (!entry) return null;
    if ((entry.fullUrl || '').startsWith('urn:uuid:')) {
      return entry.fullUrl.split(':').pop();
    }
    // Preferir resource.id si existe
    if (entry.resource?.id) return entry.resource.id;
    // Fallback: último segmento del fullUrl
    if (entry.fullUrl) {
      const parts = entry.fullUrl.split('/').filter(Boolean);
      return parts[parts.length - 1] || null;
    }
    return null;
  }

  function canonicalizeBundleToUrn(bundle) {
    if (!bundle?.entry) return;
    const urlMap = new Map(); // referencia original -> URN

    for (const e of bundle.entry) {
      if (!e.resource) continue;
      let id = extractIdFromFullUrl(e);
      if (!id) {
        // Generar uno si falta
        id = uuidv4();
        e.resource.id = id;
      }
      const urn = makeUrn(id);

      // Mapear variantes conocidas a URN
      if (e.fullUrl && e.fullUrl !== urn) urlMap.set(e.fullUrl, urn);
      if (e.resource.resourceType) {
        urlMap.set(`${e.resource.resourceType}/${id}`, urn);
        // También mapear posibles relative with leading './'
        urlMap.set(`./${e.resource.resourceType}/${id}`, urn);
      }

      // Reescribir fullUrl a URN
      e.fullUrl = urn;

      // Limpiar meta.source interno (#...)
      if (e.resource.meta?.source && String(e.resource.meta.source).startsWith('#')) {
        delete e.resource.meta.source;
      }
    }

    // Reescribir todas las referencias usando el urlMap
    updateReferencesInObject(bundle, urlMap);
  }

  // Ejecutar canonicalización al inicio
  canonicalizeBundleToUrn(summaryBundle);

  // === Post-canonicalización: Patient
  const patientEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Patient');
  if (patientEntry?.resource) {
    fixPatientIdentifiers(patientEntry.resource);
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
  const compositionEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Composition');
  if (compositionEntry?.resource) {
    // ID del Composition DEBE empatar con el fullUrl (slice LAC exige esto)
    const compUuid = (compositionEntry.fullUrl || '').replace('urn:uuid:', '');
    if (compUuid) compositionEntry.resource.id = compUuid;

    // Asegurar custodian (requerido por el perfil lac-composition)
    if (!compositionEntry.resource.custodian) {
      const orgEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Organization');
      if (orgEntry) {
        compositionEntry.resource.custodian = {
          reference: orgEntry.fullUrl || `Organization/${orgEntry.resource.id}`
        };
      }
    }
  }

  // 2. Perfiles IPS en recursos referenciados por las secciones para que pasen los discriminadores
  for (const e of summaryBundle.entry) {
    const r = e.resource;
    if (!r) continue;

    // Alergias, Medicación, Problemas (activos/pasados)…
    if (['AllergyIntolerance','MedicationStatement','MedicationRequest','Condition','Organization']
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
    if (res?.resourceType === 'AllergyIntolerance' && res.code?.coding?.length) {
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

  // 7. Asegurar que todas las referencias internas estén en el Bundle
  const allFullUrls = new Set(summaryBundle.entry?.map(e => e.fullUrl) || []);
  
  summaryBundle.entry?.forEach(entry => {
    // Revisar todas las referencias en el recurso
    checkAndFixReferences(entry.resource, allFullUrls, summaryBundle);
  });

  // 8) Refuerzo: Composition.meta.profile debe contener lac-composition
  const LAC_COMPOSITION = 'http://lacpass.racsel.org/StructureDefinition/lac-composition';
  if (compositionEntry?.resource) {
    compositionEntry.resource.meta = compositionEntry.resource.meta || {};
    compositionEntry.resource.meta.profile = Array.isArray(compositionEntry.resource.meta.profile)
      ? compositionEntry.resource.meta.profile
      : [];
    if (!compositionEntry.resource.meta.profile.includes(LAC_COMPOSITION)) {
      compositionEntry.resource.meta.profile.push(LAC_COMPOSITION);
    }
  }

  // 9) NUEVAS MEJORAS LAC: Patient identifiers con URN OIDs
  const natOid = process.env.LAC_NATIONAL_ID_SYSTEM_OID;   // p.ej. 1.2.36.146.595.217.0.1
  const ppnOid = process.env.LAC_PASSPORT_ID_SYSTEM_OID;   // p.ej. 2.16.840.1.113883.4.1
  
  // Reutilizar patientEntry ya definido anteriormente
  if (patientEntry?.resource && (natOid || ppnOid)) {
    const patient = patientEntry.resource;
    
    // Preservar identifiers originales y transformar sistemas a URN OIDs
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
        use: 'official',
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
    if (patient.identifier.length === 0) {
      if (natOid) {
        const defaultValue = originalIds[0]?.value || `ID-${patient.id || 'unknown'}`;
        patient.identifier.push({
          use: 'official',
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

  for (const key in obj) {
    if (obj.hasOwnProperty(key) && key !== 'reference') {
      updateReferencesInObject(obj[key], urlMap);
    }
  }
}

// ===================== PDQm =====================
async function pdqmFetchBundleByIdentifier(identifierValue) {
    if (!PDQM_FHIR_URL || !identifierValue) return null;

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
            let url = joinUrl(base, '/Patient') + `?identifier=${encodeURIComponent(identifierValue)}`;
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
                    url = joinUrl(base, '/Patient') + `?${param}=${encodeURIComponent(identifierValue)}`;
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
                    system: PDQM_DEFAULT_IDENTIFIER_SYSTEM || 'urn:oid:1.2.3.4.5',
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

function isPdqmFallbackBundle(bundle) {
    return bundle?.entry?.[0]?.resource?.meta?.tag?.some(tag => 
        tag.code === 'pdqm-fallback'
    ) === true;
}

// ===================== Routes =====================
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ===================== ROUTE ITI-65 - VERSIÓN INTEGRADA =====================
app.post('/lacpass/_iti65', async (req, res) => {
  let summaryBundle;

  // 1) Obtener $summary si viene uuid; si no, usar el Bundle entregado
  if (req.body.uuid) {
    try {
      const resp = await axios.get(
        joinUrl(asFhirBase(FHIR_NODE_URL), `/Patient/${req.body.uuid}/$summary`),
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

    // ===== Algunos nodos piden sí o sí Composition primero y Bundle.type = "document" =====
    summaryBundle.type = "document";
    if (summaryBundle.entry && summaryBundle.entry.length > 0) {
      // Buscar el Composition
      const compositionIndex = summaryBundle.entry.findIndex(e => e.resource && e.resource.resourceType === 'Composition');
      if (compositionIndex !== -1 && compositionIndex !== 0) {
        // Mover Composition al primer lugar
        const compositionEntry = summaryBundle.entry.splice(compositionIndex, 1)[0];
        summaryBundle.entry.unshift(compositionEntry);
      }
      
      // Asegurar que la referencia del Composition al paciente esté correcta
      const firstEntry = summaryBundle.entry[0];
      if (firstEntry && firstEntry.resource && firstEntry.resource.resourceType === 'Composition') {
        // Verificar que el Composition.id coincida con fullUrl
        if (firstEntry.fullUrl && firstEntry.fullUrl.startsWith('urn:uuid:')) {
          const expectedId = firstEntry.fullUrl.split(':').pop();
          if (firstEntry.resource.id !== expectedId) {
            firstEntry.resource.id = expectedId;
          }
        }
        
        // Asegurar referencia correcta al Patient
        const patientEntry = summaryBundle.entry.find(e => e.resource && e.resource.resourceType === 'Patient');
        if (patientEntry && patientEntry.fullUrl) {
          firstEntry.resource.subject = { reference: patientEntry.fullUrl };
        }
      }
    }

    // ===== Guard rails: asegurar recursos clave presentes =====
    const hasPatient = Array.isArray(summaryBundle.entry) && summaryBundle.entry.some(e => e.resource?.resourceType === 'Patient');
    const hasComposition = Array.isArray(summaryBundle.entry) && summaryBundle.entry.some(e => e.resource?.resourceType === 'Composition');
    if (!hasPatient || !hasComposition) {
      return res.status(400).json({
        error: 'Bundle must include Patient and Composition resources',
        details: {
          hasPatient, hasComposition
        }
      });
    }

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
    const bundleDate = summaryBundle.timestamp || now;
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

    // Crear Binary con el Bundle IPS en base64
    const binaryId = uuidv4();
    const binaryUrn = `urn:uuid:${binaryId}`;
    const binaryResource = {
      resourceType: 'Binary',
      id: binaryId,
      contentType: 'application/fhir+json',
      data: Buffer.from(bundleString, 'utf8').toString('base64')
    };

    // FIX #3 — Refuerzos quick-wins para los slices de secciones
    summaryBundle.entry?.forEach(entry => {
      const res = entry.resource;

      if (res?.resourceType === 'MedicationStatement') {
        // Absent-unknown 'no-medication-info'
        if (res.medicationCodeableConcept?.coding?.length) {
          res.medicationCodeableConcept.coding.forEach(c => {
            if ((c.code === 'no-medication-info') || (c.display === 'No information about medications')) {
              c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
              c.code = 'no-medication-info';
              if (!c.display) c.display = 'No information about medications';
            }
          });
        }
        // effective[x] requerido por IPS
        if (!res.effectiveDateTime && !res.effectivePeriod) {
          res.effectiveDateTime = new Date().toISOString();
        }
      }
    });

    // Mantener el summaryBundle con sus referencias internas (URN/relativas)
    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');
    const patientRef = patientEntry.fullUrl; // ya canonicalizado a urn:uuid:...
    const docType = compositionEntry?.resource?.type ?? {
      coding: [{ system: 'http://loinc.org', code: '60591-5', display: 'Patient summary Document' }]
    };
    const patientDisplay = patientEntry.resource.name?.[0]?.text || `Patient ${patientEntry.resource.id}`;

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
      identifier: [{ use: 'usual', system: 'urn:ietf:rfc:3986', value: `urn:uuid:${ssId}` }],
      status: 'current',
      mode: 'working',
      code: { coding: [{ system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }] },
      subject: { reference: patientRef, display: patientDisplay },
      date: bundleDate,
      entry: [{ item: { reference: `urn:uuid:${drId}` } }]
    };

    // DocumentReference con formatCode configurable
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
      masterIdentifier: { system: 'urn:ietf:rfc:3986', value: binaryUrn }, // en lugar de bundleUrn
      status: 'current',
      type: docType,
      subject: { reference: patientRef, display: patientDisplay },
      date: bundleDate,
      content: [{
        attachment: {
          contentType: 'application/fhir+json',
          url: binaryUrn,      // ← antes: bundleUrn
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

    // <<< NUEVO: incluir Patient como entrada del transaction >>>
    const patientTxEntry = {
      fullUrl: patientRef,
      resource: patientEntry.resource,
      request: { method: 'POST', url: 'Patient' }
    };
    // Opcional y recomendado: evitar duplicados con ifNoneExist si tienes un identifier
    const pid = patientEntry.resource.identifier?.[0];
    if (pid?.system && pid?.value) {
      patientTxEntry.request.ifNoneExist =
        `identifier=${encodeURIComponent(pid.system)}|${encodeURIComponent(pid.value)}`;
    }

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
        // NUEVO: Patient a nivel superior (resuelve List.subject y DocumentReference.subject)
        patientTxEntry,

        { fullUrl: `urn:uuid:${ssId}`, resource: submissionSet, request: { method: 'POST', url: 'List' } },
        { fullUrl: `urn:uuid:${drId}`, resource: documentReference, request: { method: 'POST', url: 'DocumentReference' } },

        // NUEVO: Binary contiene el documento IPS en base64
        { fullUrl: binaryUrn, resource: binaryResource, request: { method: 'POST', url: 'Binary' } }

        // COMENTADO: El Bundle como documento - ahora solo se envía como Binary
        // { fullUrl: bundleUrn, resource: summaryBundle, request: { method: 'POST', url: 'Bundle' } }
      ]
    };

    // Debug + envío
    console.log('DEBUG: Sending ProvideBundle to', FHIR_NODO_NACIONAL_SERVER);
    const debugFile = path.join(debugDir, `provideBundle_${Date.now()}.json`);
    fs.writeFileSync(debugFile, JSON.stringify(provideBundle, null, 2));
    console.log('DEBUG: saved →', debugFile);

    const resp = await axios.post(FHIR_NODO_NACIONAL_SERVER, provideBundle, {
      headers: {
        'Content-Type': 'application/fhir+json',
        'X-Correlation-ID': req.correlationId
      },
      validateStatus: false
    });
    console.log(`[${req.correlationId}] ⇒ ITI-65 sent, status ${resp.status}`);
    if (resp.status >= 400) {
      const ooFile = path.join(debugDir, `operationOutcome_${Date.now()}.json`);
      try { fs.writeFileSync(ooFile, JSON.stringify(resp.data, null, 2)); } catch {}
      console.error('❌ OperationOutcome guardado en:', ooFile);
    }

    return res.json({ status: 'sent', code: resp.status });

  } catch (e) {
    console.error('❌ ERROR ITI-65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.LACPASS_ITI65_PORT || 8005;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));