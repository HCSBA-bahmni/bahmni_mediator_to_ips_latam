import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
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

  // 1) If they gave us just a UUID, call $summary on the FHIR node
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
    // 2) Otherwise, the whole Bundle came in
    summaryBundle = req.body;
  }

  if (!summaryBundle || summaryBundle.resourceType !== 'Bundle') {
    console.error('❌ Invalid summaryBundle:', JSON.stringify(summaryBundle).slice(0, 200));
    return res.status(400).json({ error: 'Invalid Bundle or missing uuid' });
  }

  try {
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    // Ensure the summaryBundle has an ID
    let originalBundleId = summaryBundle.id;
    if (!originalBundleId) {
      originalBundleId = uuidv4();
      summaryBundle.id = originalBundleId;
    }
    const bundleUrn = `urn:uuid:${originalBundleId}`;

    // —— FIX #1 —— Inject and preserve generic FHIR Bundle profile for slicing
    summaryBundle.meta = summaryBundle.meta || {};
    const existingProfiles = summaryBundle.meta.profile || [];
    summaryBundle.meta.profile = [
      'http://hl7.org/fhir/StructureDefinition/Bundle',
      ...existingProfiles
    ];
    // —— FIX #2 —— Add security tag to summaryBundle
    summaryBundle.meta.security = summaryBundle.meta.security || [];
    summaryBundle.meta.security.push(
      { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }
    );
    // —— FIX #3 —— Remove custom meta.profile from nested resources
    summaryBundle.entry.forEach(entry => {
      if (entry.resource.meta && entry.resource.meta.profile) {
        delete entry.resource.meta.profile;
      }
    });
    // —— FIX #4 —— Sanitize UV/IPS CodeSystem references to avoid resolution errors
    summaryBundle.entry.forEach(entry => {
      const res = entry.resource;
      if (res.resourceType === 'MedicationStatement' && res.medicationCodeableConcept?.coding) {
        res.medicationCodeableConcept.coding.forEach(c => delete c.system);
      }
      if (res.resourceType === 'Immunization' && res.vaccineCode?.coding) {
        res.vaccineCode.coding.forEach(c => delete c.system);
      }
    });

    // Build a map of resourceType/id => fullUrl for internal references
    const urlMap = new Map();
    summaryBundle.entry.forEach(entry => {
      const { resource } = entry;
      const url = entry.fullUrl || `urn:uuid:${resource.id}`;
      urlMap.set(`${resource.resourceType}/${resource.id}`, url);
    });

    // Pull out the Patient & Composition entries
    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');

    // Normalize Composition.subject.reference
    if (compositionEntry) {
      compositionEntry.resource.subject.reference = urlMap.get(
        `Patient/${patientEntry.resource.id}`
      );
      // Normalize section entry references
      compositionEntry.resource.section?.forEach(section => {
        section.entry?.forEach(item => {
          const key = item.reference;
          if (urlMap.has(key)) item.reference = urlMap.get(key);
        });
      });
    }

    // Normalize all subject/patient references in summaryBundle entries
    summaryBundle.entry.forEach(entry => {
      const res = entry.resource;
      if (res.subject?.reference) {
        const orig = res.subject.reference;
        if (urlMap.has(orig)) res.subject.reference = urlMap.get(orig);
      }
      if (res.patient?.reference) {
        const orig = res.patient.reference;
        if (urlMap.has(orig)) res.patient.reference = urlMap.get(orig);
      }
    });

    // Build the SubmissionSet (List)
    const submissionSet = {
      resourceType: 'List',
      id: ssId,
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.SubmissionSet'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      extension: [{
        url: 'https://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-sourceId',
        valueIdentifier: { value: bundleUrn }
      }],
      identifier: [{ use: 'usual', system: 'urn:ietf:rfc:3986', value: `urn:oid:${ssId}` }],
      status: 'current', mode: 'working',
      code: { coding: [{ system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }] },
      subject: { reference: urlMap.get(`Patient/${patientEntry.resource.id}`) },
      date: summaryBundle.timestamp,
      entry: [{ item: { reference: `urn:uuid:${drId}` } }]
    };

    // Build the DocumentReference
    const documentReference = {
      resourceType: 'DocumentReference', id: drId,
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.DocumentReference'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      masterIdentifier: { system: 'urn:ietf:rfc:3986', value: bundleUrn },
      status: 'current', type: compositionEntry.resource.type,
      subject: { reference: urlMap.get(`Patient/${patientEntry.resource.id}`) },
      date: summaryBundle.timestamp,
      content: [{
        attachment: { contentType: 'application/fhir+json', url: bundleUrn },
        format: { system: 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode', code: 'urn:ihe:iti:xds-sd:text:2008' }
      }]
    };

    // Assemble the ProvideBundle transaction
    const provideBundle = {
      resourceType: 'Bundle', id: uuidv4(),
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.ProvideBundle'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      type: 'transaction', timestamp: now,
      entry: [
        { fullUrl: `urn:uuid:${ssId}`, resource: submissionSet, request: { method: 'POST', url: 'List' } },
        { fullUrl: `urn:uuid:${drId}`, resource: documentReference, request: { method: 'POST', url: 'DocumentReference' } },
        { fullUrl: bundleUrn, resource: summaryBundle, request: { method: 'POST', url: 'Bundle' } },
        { fullUrl: urlMap.get(`Patient/${patientEntry.resource.id}`), resource: patientEntry.resource, request: { method: 'PUT', url: `Patient/${patientEntry.resource.id}` } }
      ]
    };

    // Debug‑dump it
    console.log('DEBUG: Sending ProvideBundle to', FHIR_NODO_NACIONAL_SERVER);
    const debugPath = path.join(debugDir, `provideBundle_debug_${Date.now()}.json`);
    fs.writeFileSync(debugPath, JSON.stringify(provideBundle, null, 2));
    console.log('DEBUG: saved →', debugPath);

    // Send transaction
    const resp = await axios.post(
      FHIR_NODO_NACIONAL_SERVER,
      provideBundle,
      { headers: { 'Content-Type': 'application/fhir+json' }, validateStatus: false }
    );
    console.log(`⇒ ITI-65 sent, status ${resp.status}`);
    return res.json({ status: 'sent', code: resp.status });

  } catch (e) {
    console.error('❌ ERROR ITI-65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.LACPASS_ITI65_PORT || 8005;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
