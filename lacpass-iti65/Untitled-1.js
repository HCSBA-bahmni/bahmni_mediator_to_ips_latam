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

// Load mediator configuration
const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

// Read environment variables
const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  FHIR_NODE_URL,
  SUMMARY_PROFILE,
  FHIR_NODO_NACIONAL_SERVER,
  PDQM_MEDIATOR_URL,
  TERMINO_MEDIATOR_URL,
  NODE_ENV,
  DEBUG_DIR  // optional override for debug folder
} = process.env;

// Determine debug directory (container‑writable)
const debugDir = DEBUG_DIR
  ? path.resolve(DEBUG_DIR)
  : '/tmp';
try {
  fs.mkdirSync(debugDir, { recursive: true });
} catch (err) {
  console.error(`❌ Could not create debug directory at ${debugDir}:`, err.message);
}

// OpenHIM connection setup
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

app.get('/lacpass/_health', (_req, res) => res.status(200).send('OK'));

app.post('/lacpass/_iti65', async (req, res) => {
  let summaryBundle;

  // === 0) Si recibieron identifier en vez de uuid, hago PDQm lookup ===
  if (!req.body.uuid && req.body.identifier) {
    try {
      const pdqRes = await axios.post(
        `${PDQM_MEDIATOR_URL}/pdqm/_lookup`,
        { identifier: req.body.identifier },
        { httpsAgent: axios.defaults.httpsAgent }
      );
      const pat = pdqRes.data.entry?.[0]?.resource;
      if (!pat?.id) {
        return res.status(404).json({ error: 'Patient not found via PDQm' });
      }
      req.body.uuid = pat.id;
    } catch (e) {
      console.error('❌ ERROR PDQm lookup:', e.response?.data || e.message);
      return res.status(502).json({ error: 'PDQm lookup failed', details: e.message });
    }
  }

  // === 1) Obtener summaryBundle por UUID o tomar el Bundle entrante ===
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
    return res.status(400).json({ error: 'Invalid Bundle or missing uuid/identifier' });
  }

  // === 2) Validación terminológica en todos los codings ===
  for (const entry of summaryBundle.entry || []) {
    const resrc = entry.resource;
    const codings = [];
    // reúne arrays de coding según tipo de recurso
    if (resrc.code?.coding) codings.push(...resrc.code.coding);
    if (resrc.medicationCodeableConcept?.coding) codings.push(...resrc.medicationCodeableConcept.coding);
    if (resrc.vaccineCode?.coding) codings.push(...resrc.vaccineCode.coding);
    if (resrc.category?.coding) codings.push(...resrc.category.coding);
    // y cualquier otro campo que quieras validar...
    for (const c of codings) {
      try {
        await axios.post(
          `${TERMINO_MEDIATOR_URL}/termino/_validate`,
          { system: c.system, code: c.code, display: c.display }
        );
      } catch (e) {
        console.warn(`⚠️ Warning: terminology validation failed for ${c.system}|${c.code}`, e.response?.data || e.message);
        // no abortamos, solo lo registramos
      }
    }
  }

  try {
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    // Asegura un ID en el summaryBundle
    let originalBundleId = summaryBundle.id || uuidv4();
    summaryBundle.id = originalBundleId;
    const bundleUrn = `urn:uuid:${originalBundleId}`;

    // Tamaño y hash
    const bundleString = JSON.stringify(summaryBundle);
    const bundleSize = Buffer.byteLength(bundleString, 'utf8');
    const bundleHash = crypto.createHash('sha256').update(bundleString).digest('base64');

    // Inyecciones y saneamientos (como antes)...
    summaryBundle.meta = summaryBundle.meta || {};
    summaryBundle.meta.profile = ['http://hl7.org/fhir/StructureDefinition/Bundle'];
    summaryBundle.entry.forEach(entry => {
      const r = entry.resource;
      if (r.meta) {
        delete r.meta.profile;
        if (Object.keys(r.meta).length === 0) delete r.meta;
      }
      if (r.medicationCodeableConcept?.coding) r.medicationCodeableConcept.coding.forEach(c => delete c.system);
      if (r.vaccineCode?.coding) r.vaccineCode.coding.forEach(c => delete c.system);
    });

    // Construye mapa de URLs para referencias internas
    const urlMap = new Map();
    summaryBundle.entry.forEach(entry => {
      const { resource } = entry;
      const url = entry.fullUrl || `urn:uuid:${resource.id}`;
      urlMap.set(`${resource.resourceType}/${resource.id}`, url);
    });

    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');

    // Normaliza referencias
    if (compositionEntry) {
      compositionEntry.resource.subject.reference = urlMap.get(`Patient/${patientEntry.resource.id}`);
      compositionEntry.resource.section?.forEach(sec =>
        sec.entry?.forEach(itm =>
          itm.reference = urlMap.get(itm.reference) || itm.reference
        )
      );
    }
    summaryBundle.entry.forEach(entry => {
      const r = entry.resource;
      if (r.subject?.reference) r.subject.reference = urlMap.get(r.subject.reference) || r.subject.reference;
      if (r.patient?.reference) r.patient.reference = urlMap.get(r.patient.reference) || r.patient.reference;
    });

    // Construye SubmissionSet (List) y DocumentReference...
    const submissionSet = { /* igual que antes */ };
    const documentReference = { /* igual que antes */ };

    // Arma ProvideBundle
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
    const debugFile = path.join(debugDir, `provideBundle_${Date.now()}.json`);
    fs.writeFileSync(debugFile, JSON.stringify(provideBundle, null, 2));
    console.log(`DEBUG: saved → ${debugFile}`);
    const resp = await axios.post(
      FHIR_NODO_NACIONAL_SERVER,
      provideBundle,
      { headers: { 'Content-Type': 'application/fhir+json' }, validateStatus: false }
    );
    console.log(`⇒ ITI‑65 sent, status ${resp.status}`);
    return res.json({ status: 'sent', code: resp.status });

  } catch (e) {
    console.error('❌ ERROR ITI‑65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.LACPASS_ITI65_PORT || 8005;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
