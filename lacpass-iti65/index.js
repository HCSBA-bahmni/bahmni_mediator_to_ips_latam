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
  DEBUG_DIR
} = process.env;

// Determine debug directory: use DEBUG_DIR or default to '/tmp'
const debugDir = DEBUG_DIR
  ? path.resolve(DEBUG_DIR)
  : '/tmp';

// Ensure debug directory exists
try {
  fs.mkdirSync(debugDir, { recursive: true });
} catch (err) {
  console.error(`❌ Could not create debug directory at ${debugDir}:`, err.message);
}

// Configure OpenHIM connection
const openhimConfig = {
  username: OPENHIM_USER,
  password: OPENHIM_PASS,
  apiURL: OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
};

// Accept self-signed certs in development
if (NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('⚠️ DEV MODE: self-signed certs accepted');
}

// Register mediator and start heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err);
    process.exit(1);
  }
  activateHeartbeat(openhimConfig);
});

// Initialize Express server
const app = express();
app.use(express.json({ limit: '20mb' }));

// Health check endpoint
app.get('/lacpass/_health', (_req, res) => res.status(200).send('OK'));

// Main ITI-65 processing endpoint
app.post('/lacpass/_iti65', async (req, res) => {
  let summaryBundle;

  // 1) Fetch summary if only UUID is provided
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
    // 2) Otherwise, use the full Bundle sent by OpenHIM
    summaryBundle = req.body;
  }

  // 3) Validate Bundle
  if (!summaryBundle || summaryBundle.resourceType !== 'Bundle') {
    console.error('❌ Invalid summaryBundle:', JSON.stringify(summaryBundle).slice(0,200));
    return res.status(400).json({ error: 'Invalid Bundle or missing uuid' });
  }

  try {
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    // Ensure original Bundle has an ID
    let originalBundleId = summaryBundle.id;
    if (!originalBundleId) {
      originalBundleId = uuidv4();
      summaryBundle.id = originalBundleId;
    }
    
    // 4) Añadir perfil FHIR genérico para slice FhirDocuments
    summaryBundle.meta = summaryBundle.meta || {};
    summaryBundle.meta.profile = [
      'http://hl7.org/fhir/StructureDefinition/Bundle',
      ...(summaryBundle.meta.profile || [])
    ];

    const bundleUrn = `urn:uuid:${originalBundleId}`;
    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const patientPlaceholder = uuidv4();
    const patientResource = { ...patientEntry.resource, id: patientPlaceholder };
    const patientRef = `urn:uuid:${patientPlaceholder}`;
    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');

    // Build SubmissionSet (List)
    const submissionSet = {
      resourceType: 'List',
      id: ssId,
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.SubmissionSet'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      extension: [
        { url: 'https://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-sourceId', valueIdentifier: { value: bundleUrn } }
      ],
      identifier: [
        // Identificador con urn:oid: para cumplir mhd-startswithoid
        { use: 'usual', system: 'urn:ietf:rfc:3986', value: `urn:oid:${ssId}` }
      ],
      status: 'current',
      mode: 'working',
      code: {
        coding: [{ system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }]
      },
      subject: { reference: patientRef },
      date: summaryBundle.timestamp,
      entry: [{ item: { reference: `urn:uuid:${drId}` } }]
    };

    // Build DocumentReference
    const documentReference = {
      resourceType: 'DocumentReference',
      id: drId,
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.DocumentReference'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      masterIdentifier: { system: 'urn:ietf:rfc:3986', value: bundleUrn },
      status: 'current',
      type: compositionEntry.resource.type,
      subject: { reference: patientRef },
      date: summaryBundle.timestamp,
      content: [
        // Solo content.attachment, eliminamos el format para evitar errores de código desconocido
        { attachment: { contentType: 'application/fhir+json', url: bundleUrn } }
      ]
    };

    // Build ProvideBundle (transaction)
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
        { fullUrl: patientRef, resource: patientResource, request: { method: 'PUT', url: `Patient/${patientPlaceholder}` } }
      ]
    };

    // DEBUG: save and send
    console.log('DEBUG: Sending ProvideBundle to', FHIR_NODO_NACIONAL_SERVER);
    const debugPath = path.join(debugDir, `provideBundle_debug_${Date.now()}.json`);
    fs.writeFileSync(debugPath, JSON.stringify(provideBundle, null, 2));
    console.log('DEBUG: saved →', debugPath);

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

// Start server
const PORT = process.env.LACPASS_ITI65_PORT || 8006;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
