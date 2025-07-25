import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import os from 'os';
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
  FHIR_NODE_URL,              // e.g. http://10.68.174.222
  SUMMARY_PROFILE,            // e.g. http://lacpass.racsel.org/StructureDefinition/lac-composition-ddcc
  FHIR_NODO_NACIONAL_SERVER,  // e.g. http://10.68.174.221:8080/fhir
  NODE_ENV
} = process.env;

// Configure OpenHIM connection
const openhimConfig = {
  username: OPENHIM_USER,
  password: OPENHIM_PASS,
  apiURL: OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
};

// Accept self‑signed certs in development
if (NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('⚠️ DEV MODE: self‑signed certs accepted');
}

// Register mediator and activate heartbeat
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

// Main ITI‑65 processing endpoint
app.post('/lacpass/_iti65', async (req, res) => {
  let summaryBundle;

  // 1) If only { uuid } is received, fetch the IPS bundle via $summary
  if (req.body.uuid) {
    try {
      const resp = await axios.get(
        `${FHIR_NODE_URL}/fhir/Patient/${req.body.uuid}/$summary`,
        {
          params: { profile: SUMMARY_PROFILE },
          httpsAgent: axios.defaults.httpsAgent
        }
      );
      summaryBundle = resp.data;
    } catch (e) {
      console.error('❌ ERROR fetching summary:', e.response?.data || e.message);
      return res.status(502).json({ error: 'Error fetching summary', details: e.message });
    }
  } else {
    // 2) Otherwise, assume the full Bundle was sent
    summaryBundle = req.body;
  }

  // 3) Basic validation
  if (!summaryBundle || summaryBundle.resourceType !== 'Bundle') {
    console.error('❌ Invalid summaryBundle:', JSON.stringify(summaryBundle).slice(0,200));
    return res.status(400).json({ error: 'Invalid Bundle or missing uuid' });
  }

  try {
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    // OPTION 2: include Patient in the transaction
    const patientPlaceholder = uuidv4();
    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const patientResource = { ...patientEntry.resource, id: patientPlaceholder };
    const patientRef = `urn:uuid:${patientPlaceholder}`;

    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');

    // 4) Build SubmissionSet (List)
    const submissionSet = {
      resourceType: 'List',
      id: ssId,
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.SubmissionSet'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      extension: [{
        url: 'https://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-sourceId',
        valueIdentifier: { value: summaryBundle.identifier?.value }
      }],
      identifier: [{ use: 'usual', system: 'urn:ietf:rfc:3986', value: summaryBundle.identifier?.value }],
      status: 'current',
      mode: 'working',
      code: { coding: [{ system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }] },
      subject: { reference: patientRef },
      date: summaryBundle.timestamp,
      entry: [{ item: { reference: `urn:uuid:${drId}` } }]
    };

    // 5) Build DocumentReference
    const documentReference = {
      resourceType: 'DocumentReference',
      id: drId,
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.DocumentReference'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      masterIdentifier: { system: 'urn:ietf:rfc:3986', value: summaryBundle.identifier.value },
      status: 'current',
      type: compositionEntry.resource.type,
      subject: { reference: patientRef },
      date: summaryBundle.timestamp,
      content: [{
        attachment: { contentType: 'application/fhir+json', url: `urn:uuid:${summaryBundle.id}` },
        format: { system: 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode', code: 'urn:ihe:iti:xds-sd:xml:2008' }
      }]
    };

    // 6) Build ProvideBundle (transaction), including Patient first
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
        // 6.1) PUT Patient
        {
          fullUrl: patientRef,
          resource: patientResource,
          request: { method: 'PUT', url: `Patient/${patientPlaceholder}` }
        },
        // 6.2) POST List (SubmissionSet)
        {
          fullUrl: `urn:uuid:${ssId}`,
          resource: submissionSet,
          request: { method: 'POST', url: 'List' }
        },
        // 6.3) POST DocumentReference
        {
          fullUrl: `urn:uuid:${drId}`,
          resource: documentReference,
          request: { method: 'POST', url: 'DocumentReference' }
        },
        // 6.4) POST original Bundle
        {
          fullUrl: `urn:uuid:${summaryBundle.id}`,
          resource: summaryBundle,
          request: { method: 'POST', url: 'Bundle' }
        }
      ]
    };

    // DEBUG: inspect working directory and snippet of the Bundle
    console.log('DEBUG: cwd=', process.cwd());
    console.log('DEBUG: Sending ProvideBundle to', FHIR_NODO_NACIONAL_SERVER);
    console.log('DEBUG: bundle[:500]=', JSON.stringify(provideBundle).slice(0,500));

    // DEBUG: save ProvideBundle to /tmp for later inspection
    const debugPath = path.join(os.tmpdir(), `provideBundle_debug_${Date.now()}.json`);
    fs.writeFileSync(debugPath, JSON.stringify(provideBundle, null, 2));
    console.log('DEBUG: saved →', debugPath);

    // 7) Send ProvideBundle to the national node
    const resp = await axios.post(
      FHIR_NODO_NACIONAL_SERVER,
      provideBundle,
      { headers: { 'Content-Type': 'application/fhir+json' }, validateStatus: false }
    );
    console.log('DEBUG: resp.data[:500]=', JSON.stringify(resp.data).slice(0,500));
    console.log(`⇒ ITI‑65 sent, status ${resp.status}`);
    return res.json({ status:'sent', code: resp.status });

  } catch (e) {
    console.error('❌ ERROR ITI‑65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Start server
const PORT = process.env.LACPASS_ITI65_PORT || 8006;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
