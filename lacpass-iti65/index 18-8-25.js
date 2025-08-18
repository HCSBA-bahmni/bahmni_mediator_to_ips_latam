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

// ====== ENV ======
const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  FHIR_NODE_URL,
  SUMMARY_PROFILE,
  FHIR_NODO_NACIONAL_SERVER,
  NODE_ENV,
  DEBUG_DIR,

  // NEW: feature flags
  PDQM_ENABLED = 'false',
  TERMINO_ENABLED = 'false',

  // NEW: PDQm
  PDQM_MEDIATOR_URL,
  LOCAL_IDENTIFIER_SYSTEM,

  // NEW: Terminology
  TERMINO_SERVER_URL,
  TERMINO_TIMEOUT = '20000',
  TERMINO_VALUESET_URL,
  TERMINO_BEARER_TOKEN,
  TERMINO_BASIC_USER,
  TERMINO_BASIC_PASS
} = process.env;

// ====== DEBUG DIR ======
const debugDir = DEBUG_DIR ? path.resolve(DEBUG_DIR) : '/tmp';
try {
  fs.mkdirSync(debugDir, { recursive: true });
} catch (err) {
  console.error(`❌ Could not create debug directory at ${debugDir}:`, err.message);
}

// ====== OpenHIM ======
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

// ====== Helpers: PDQm ======
async function fetchInternationalPatient(identifierValue) {
  if (!PDQM_MEDIATOR_URL || !identifierValue) return null;
  try {
    const url = `${PDQM_MEDIATOR_URL.replace(/\/+$/, '')}/Patient`;
    const resp = await axios.get(url, {
      params: { identifier: identifierValue },
      headers: { Accept: 'application/fhir+json' },
      timeout: 15000,
      httpsAgent: axios.defaults.httpsAgent
    });
    const b = resp.data;
    if (b?.resourceType === 'Bundle' && Array.isArray(b.entry) && b.entry.length > 0) {
      const pt = b.entry.find(e => e.resource?.resourceType === 'Patient')?.resource;
      return pt || null;
    }
    return null;
  } catch (e) {
    console.warn('⚠️ PDQm fetch error:', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

function mergePatientDemographics(localPt, pdqmPt) {
  if (!localPt || !pdqmPt) return;

  // Conserva el id local para no romper URNs/ref
  // Copia campos demográficos/identificadores "más frescos"
  if (pdqmPt.name) localPt.name = pdqmPt.name;
  if (pdqmPt.gender) localPt.gender = pdqmPt.gender;
  if (pdqmPt.birthDate) localPt.birthDate = pdqmPt.birthDate;
  if (pdqmPt.address) localPt.address = pdqmPt.address;
  if (pdqmPt.identifier && Array.isArray(pdqmPt.identifier) && pdqmPt.identifier.length > 0) {
    localPt.identifier = pdqmPt.identifier;
  }
}

// ====== Helpers: Terminology ======
function buildTerminologyAxios() {
  if (!TERMINO_SERVER_URL) return null;
  const headers = { Accept: 'application/fhir+json' };
  if (TERMINO_BEARER_TOKEN) headers.Authorization = `Bearer ${TERMINO_BEARER_TOKEN}`;
  const auth = TERMINO_BASIC_USER && TERMINO_BASIC_PASS
    ? { username: TERMINO_BASIC_USER, password: TERMINO_BASIC_PASS }
    : undefined;

  return axios.create({
    baseURL: TERMINO_SERVER_URL.replace(/\/+$/, ''),
    timeout: parseInt(TERMINO_TIMEOUT, 10) || 20000,
    headers,
    auth,
    httpsAgent: axios.defaults.httpsAgent
  });
}

async function validateCoding(ts, { system, code, display }) {
  // Intenta primero con ValueSet/$validate-code si se configuró un VS
  if (TERMINO_VALUESET_URL) {
    try {
      const { data } = await ts.get('/ValueSet/$validate-code', {
        params: { url: TERMINO_VALUESET_URL, system, code, display }
      });
      const res = extractValidateResult(data);
      if (res?.result === true) return { ok: true, system, code, display: res.display || display };
    } catch (e) {
      // sigue a CodeSystem/$validate-code
    }
  }
  try {
    const { data } = await ts.get('/CodeSystem/$validate-code', {
      params: { system, code, display }
    });
    const res = extractValidateResult(data);
    if (res?.result === true) return { ok: true, system, code, display: res.display || display };
  } catch (e) {
    // no válido
  }
  return { ok: false, system, code, display };
}

function extractValidateResult(data) {
  // Esperado: Parameters con parameter[name=result] boolean
  // Algunos devuelven OperationOutcome con issue…
  try {
    if (data?.resourceType === 'Parameters' && Array.isArray(data.parameter)) {
      const resultParam = data.parameter.find(p => p.name === 'result');
      const displayParam = data.parameter.find(p => p.name === 'display');
      return {
        result: resultParam?.valueBoolean === true || resultParam?.valueString === 'true',
        display: displayParam?.valueString
      };
    }
    if (data?.resourceType === 'OperationOutcome') {
      const ok = data.issue?.some(i => (i.severity === 'information' || i.severity === 'success'));
      return { result: !!ok };
    }
  } catch {
    // noop
  }
  return { result: false };
}

async function expandByText(ts, text) {
  if (!text) return null;
  if (!TERMINO_VALUESET_URL) return null;
  try {
    const { data } = await ts.get('/ValueSet/$expand', {
      params: { url: TERMINO_VALUESET_URL, filter: text, count: 1 }
    });
    const contains = data?.expansion?.contains;
    if (Array.isArray(contains) && contains.length > 0) {
      const c = contains[0];
      return { system: c.system, code: c.code, display: c.display || text };
    }
  } catch (e) {
    // noop
  }
  return null;
}

async function lookupCoding(ts, { system, code }) {
  try {
    const { data } = await ts.get('/CodeSystem/$lookup', { params: { system, code } });
    if (data?.resourceType === 'Parameters' && Array.isArray(data.parameter)) {
      const display = data.parameter.find(p => p.name === 'display')?.valueString;
      return { system, code, display };
    }
  } catch (e) {
    // noop
  }
  return null;
}

function* iterateCodeableConcepts(resource) {
  // Recolecta las CC a validar según tipo
  switch (resource.resourceType) {
    case 'Condition':
      if (resource.code) yield resource.code;
      break;
    case 'AllergyIntolerance':
      if (resource.code) yield resource.code;
      break;
    case 'Procedure':
      if (resource.code) yield resource.code;
      break;
    case 'MedicationRequest':
      if (resource.medicationCodeableConcept) yield resource.medicationCodeableConcept;
      break;
    case 'MedicationStatement':
      if (resource.medicationCodeableConcept) yield resource.medicationCodeableConcept;
      break;
    default:
      break;
  }
}

async function normalizeTerminologyInBundle(bundle) {
  if (!bundle?.entry?.length) return;
  const ts = buildTerminologyAxios();
  if (!ts) return;

  for (const entry of bundle.entry) {
    const res = entry.resource;
    if (!res) continue;
    for (const cc of iterateCodeableConcepts(res)) {
      if (!cc?.coding || !Array.isArray(cc.coding) || cc.coding.length === 0) continue;

      // Trabajamos sobre el primer coding (ajusta si necesitas todos)
      const coding = cc.coding[0];
      const base = { system: coding.system, code: coding.code, display: coding.display || cc.text };
      // 1) validate
      const v = await validateCoding(ts, base);
      if (v.ok) {
        // asegura display actualizado si vino del validate
        cc.coding[0] = { system: v.system, code: v.code, display: v.display || base.display };
        continue;
      }

      // 2) expand por texto (si hay display/text)
      const found = await expandByText(ts, base.display || base.code);
      if (found) {
        // 3) lookup para confirmar y, si es posible, obtener display "oficial"
        const looked = await lookupCoding(ts, found) || found;
        cc.coding[0] = { system: looked.system, code: looked.code, display: looked.display || found.display };
        continue;
      }

      // 3) lookup por si el código existe pero validate falló
      const looked = await lookupCoding(ts, base);
      if (looked) {
        cc.coding[0] = { system: looked.system, code: looked.code, display: looked.display || base.display };
      }
      // Si nada resultó, dejamos el coding original
    }
  }
}

// ====== Server ======
const app = express();
app.use(express.json({ limit: '20mb' }));
app.get('/lacpass/_health', (_req, res) => res.status(200).send('OK'));

app.post('/lacpass/_iti65', async (req, res) => {
  let summaryBundle;

  // 1) $summary si viene uuid, si no, usamos el Bundle recibido
  if (req.body.uuid) {
    try {
      const resp = await axios.get(
        `${FHIR_NODE_URL}/fhir/Patient/${req.body.uuid}/$summary`,
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
    // ========= NUEVO PASO 1: PDQm (opcional) =========
    if (String(PDQM_ENABLED).toLowerCase() === 'true') {
      const patientEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Patient');
      const localPatient = patientEntry?.resource;
      if (localPatient) {
        // toma un identificador para consulta: si hay sistema preferido, úsalo
        let idValue = null;
        const ids = Array.isArray(localPatient.identifier) ? localPatient.identifier : [];
        if (LOCAL_IDENTIFIER_SYSTEM) {
          idValue = ids.find(i => i.system === LOCAL_IDENTIFIER_SYSTEM)?.value || null;
        }
        if (!idValue && ids.length > 0) idValue = ids[0].value;

        const pdqmPatient = await fetchInternationalPatient(idValue);
        if (pdqmPatient) {
          mergePatientDemographics(localPatient, pdqmPatient);
        }
      }
    }

    // ========= NUEVO PASO 2: Terminología (opcional) =========
    if (String(TERMINO_ENABLED).toLowerCase() === 'true') {
      await normalizeTerminologyInBundle(summaryBundle);
    }

    // ====== (Tu flujo original sigue igual) ======
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    let originalBundleId = summaryBundle.id;
    if (!originalBundleId) {
      originalBundleId = uuidv4();
      summaryBundle.id = originalBundleId;
    }
    const bundleUrn = `urn:uuid:${originalBundleId}`;

    const bundleString = JSON.stringify(summaryBundle);
    const bundleSize = Buffer.byteLength(bundleString, 'utf8');
    const bundleHash = crypto.createHash('sha256').update(bundleString).digest('base64');

    // —— FIX #1 —— Bundle profile genérico
    summaryBundle.meta = summaryBundle.meta || {};
    summaryBundle.meta.profile = ['http://hl7.org/fhir/StructureDefinition/Bundle'];

    // —— FIX #2 —— remover profiles en entries
    summaryBundle.entry.forEach(entry => {
      const res = entry.resource;
      if (res?.meta) {
        if (res.meta.profile) delete res.meta.profile;
        if (Object.keys(res.meta).length === 0) delete res.meta;
      }
    });

    // —— FIX #3 —— sanitize UV/IPS systems en meds/inmunización (dejado tal cual)
    summaryBundle.entry.forEach(entry => {
      const res = entry.resource;
      if (res.resourceType === 'MedicationStatement' && res.medicationCodeableConcept?.coding) {
        res.medicationCodeableConcept.coding.forEach(c => delete c.system);
      }
      if (res.resourceType === 'Immunization' && res.vaccineCode?.coding) {
        res.vaccineCode.coding.forEach(c => delete c.system);
      }
    });

    // —— URN map —— 
    const urlMap = new Map();
    summaryBundle.entry.forEach(entry => {
      const { resource } = entry;
      const urn = `urn:uuid:${resource.id}`;
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
        format: { system: 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode', code: 'urn:ihe:iti:xds-sd:text:2008' }
      }]
    };

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

const PORT = process.env.LACPASS_ITI65_PORT || 8005;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
