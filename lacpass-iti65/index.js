import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import fs from 'fs';                                        // DEBUG: import fs for saving bundles
import os from 'os';                                       // DEBUG: use temp directory for debug files
import path from 'path';                                   // DEBUG: build file paths
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
  FHIR_PROXY_URL,
  SUMMARY_PROFILE,
  TARGET_FHIR_URL,
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

// Accept self-signed certs in development
if (NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('⚠️ DEV MODE: self‑signed certs accepted');
}

// Register mediator and channels with OpenHIM
registerMediator(openhimConfig, mediatorConfig, (err) => {
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

  // If notified with only the UUID, fetch the IPS bundle via $summary
  if (req.body.uuid) {
    const uuid = req.body.uuid;
    try {
      const resp = await axios.get(
        `${FHIR_PROXY_URL}/Patient/${uuid}/$summary`,
        {
          params: { profile: SUMMARY_PROFILE },
          httpsAgent: axios.defaults.httpsAgent
        }
      );
      summaryBundle = resp.data;
    } catch (err) {
      console.error('❌ ERROR fetching summary:', err.response?.data || err.message);
      return res.status(502).json({ error: 'Error fetching summary', details: err.message });
    }
  } else {
    // Assume the full bundle was sent directly
    summaryBundle = req.body;
  }

  // Validate the bundle
  if (!summaryBundle || summaryBundle.resourceType !== 'Bundle') {
    console.error('❌ Invalid summaryBundle:', JSON.stringify(summaryBundle).slice(0,200));
    return res.status(400).json({ error: 'Invalid Bundle or missing uuid' });
  }

  try {
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    // 1) Build SubmissionSet (List)
    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');
    const patientRef = patientEntry.resource.id.startsWith('urn:')
      ? patientEntry.fullUrl
      : `urn:uuid:${patientEntry.resource.id}`;

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

    // 2) Build DocumentReference
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

    // 3) Build ProvideBundle transaction
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
        { fullUrl: `urn:uuid:${summaryBundle.id}`, resource: summaryBundle, request: { method: 'POST', url: 'Bundle' } }
      ]
    };

    // DEBUG: inspect working directory
    console.log('DEBUG: Current working directory:', process.cwd());

    // DEBUG: log what and where we send
    console.log('DEBUG: Sending ProvideBundle to', TARGET_FHIR_URL);
    console.log('DEBUG: ProvideBundle content (first 500 chars):', JSON.stringify(provideBundle).slice(0, 500));

    // DEBUG: save ProvideBundle to system temp directory
    const debugPath = path.join(os.tmpdir(), `provideBundle_debug_${Date.now()}.json`);
    fs.writeFileSync(debugPath, JSON.stringify(provideBundle, null, 2));
    console.log(`DEBUG: ProvideBundle saved to ${debugPath}`);

    // 4) Send ProvideBundle to the national node
    const resp = await axios.post(
      TARGET_FHIR_URL,
      provideBundle,
      { headers: { 'Content-Type': 'application/fhir+json' }, validateStatus: false }
    );
    console.log('DEBUG: Response data:', JSON.stringify(resp.data).slice(0,500));
    console.log(`⇒ ITI‑65 sent, status ${resp.status}`);
    return res.json({ status: 'sent', code: resp.status });

  } catch (e) {
    console.error('❌ ERROR ITI65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Start server
const PORT = process.env.LACPASS_ITI65_PORT || 8005;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
