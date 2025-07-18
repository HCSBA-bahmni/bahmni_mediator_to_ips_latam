import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

const {
  OPENHIM_USER, OPENHIM_PASS,
  OPENHIM_API,
  TARGET_FHIR_URL
} = process.env;

// --- Registrar mediador en OpenHIM ---
const openhimConfig = {
  username: OPENHIM_USER,
  password: OPENHIM_PASS,
  apiURL: OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
};

if (process.env.NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('⚠️ DEV MODE: self‑signed certs accepted');
}

registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err);
    process.exit(1);
  }
  //console.log('✅ LAC‑PASS ITI‑65 Mediator registered');
  //Promise.all(
  //  mediatorConfig.defaultChannelConfig.map(ch =>
  //    axios.post(
  //      `${openhimConfig.apiURL}/channels`,
  //      { ...ch, mediator_urn: mediatorConfig.urn },
  //      { auth: { username: OPENHIM_USER, password: OPENHIM_PASS } }
  //    )
  //  )
  //).then(() => activateHeartbeat(openhimConfig));
  activateHeartbeat(openhimConfig);
});

const app = express();
app.use(express.json({ limit: '20mb' }));

// Health check
app.get('/lacpass/_health', (_req, res) => res.status(200).send('OK'));

// Recibe el IPS‑Bundle LAC‑PASS
app.post('/lacpass/_iti65', async (req, res) => {
  const summaryBundle = req.body;
  if (!summaryBundle || summaryBundle.resourceType !== 'Bundle') {
    return res.status(400).json({ error: 'Invalid Bundle' });
  }

  try {
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    // 1) SubmissionSet (List)
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
      extension: [
        {
          url: 'https://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-sourceId',
          valueIdentifier: { value: summaryBundle.identifier?.value }
        }
      ],
      identifier: [
        { use: 'usual', system: 'urn:ietf:rfc:3986', value: summaryBundle.identifier?.value }
      ],
      status: 'current',
      mode: 'working',
      code: { coding: [{ system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }] },
      subject: { reference: patientRef },
      date: summaryBundle.timestamp,
      entry: [{ item: { reference: `urn:uuid:${drId}` } }]
    };

    // 2) DocumentReference
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
      content: [
        {
          attachment: { contentType: 'application/fhir+json', url: `urn:uuid:${summaryBundle.id}` },
          format: { system: 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode', code: 'urn:ihe:iti:xds-sd:xml:2008' }
        }
      ]
    };

    // 3) ProvideBundle transaction
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

    // 4) Enviar al nodo nacional
    const resp = await axios.post(
      TARGET_FHIR_URL,
      provideBundle,
      { headers: { 'Content-Type': 'application/fhir+json' }, validateStatus: false }
    );
    console.log(`⇒ ITI‑65 sent, status ${resp.status}`);
    return res.json({ status: 'sent', code: resp.status });
  } catch (e) {
    console.error('❌ ERROR ITI65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.LACPASS_ITI65_PORT || 8005;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
