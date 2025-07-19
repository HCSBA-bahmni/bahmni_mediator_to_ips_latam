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

// Carga la config del mediador
const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

// Variables de entorno
const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  FHIR_NODE_URL,              // ej: http://10.68.174.222
  SUMMARY_PROFILE,            // ej: http://lacpass.racsel.org/StructureDefinition/lac-composition-ddcc
  FHIR_NODO_NACIONAL_SERVER,  // ej: http://10.68.174.221:8080/fhir
  NODE_ENV
} = process.env;

// Configuración de OpenHIM
const openhimConfig = {
  username: OPENHIM_USER,
  password: OPENHIM_PASS,
  apiURL: OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
};

// Aceptar certs autofirmados en dev
if (NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('⚠️ DEV MODE: self‑signed certs accepted');
}

// Registrar canales y heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err);
    process.exit(1);
  }
  activateHeartbeat(openhimConfig);
});

// Montar servidor
const app = express();
app.use(express.json({ limit: '20mb' }));

// Health check
app.get('/lacpass/_health', (_req, res) => res.status(200).send('OK'));

// Endpoint principal
app.post('/lacpass/_iti65', async (req, res) => {
  let summaryBundle;

  // 1) Si llega sólo { uuid }, traigo el IPS‑Bundle
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
    // 2) Si ya viene el Bundle completo
    summaryBundle = req.body;
  }

  // 3) Validar
  if (!summaryBundle || summaryBundle.resourceType !== 'Bundle') {
    console.error('❌ Invalid summaryBundle:', JSON.stringify(summaryBundle).slice(0,200));
    return res.status(400).json({ error: 'Invalid Bundle or missing uuid' });
  }

  try {
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    // 4) Construir SubmissionSet (List)
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

    // 5) Construir DocumentReference
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

    // 6) Construir ProvideBundle (transaction)
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

    // DEBUG: muestra cwd y parte del Bundle
    console.log('DEBUG: cwd=', process.cwd());
    console.log('DEBUG: Sending ProvideBundle to', FHIR_NODO_NACIONAL_SERVER);
    console.log('DEBUG: bundle[:500]=', JSON.stringify(provideBundle).slice(0,500));

    // DEBUG: guarda en /tmp
    const debugPath = path.join(os.tmpdir(), `provideBundle_debug_${Date.now()}.json`);
    fs.writeFileSync(debugPath, JSON.stringify(provideBundle, null,2));
    console.log('DEBUG: saved →', debugPath);

    // 7) Enviar al nodo nacional
    const resp = await axios.post(
      FHIR_NODO_NACIONAL_SERVER,
      provideBundle,
      { headers: { 'Content-Type':'application/fhir+json' }, validateStatus: false }
    );
    console.log('DEBUG: resp.data[:500]=', JSON.stringify(resp.data).slice(0,500));
    console.log(`⇒ ITI‑65 sent, status ${resp.status}`);
    return res.json({ status:'sent', code: resp.status });
  }
  catch (e) {
    console.error('❌ ERROR ITI‑65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Start server
const PORT = process.env.LACPASS_ITI65_PORT || 8005;
app.listen(PORT,
  () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
