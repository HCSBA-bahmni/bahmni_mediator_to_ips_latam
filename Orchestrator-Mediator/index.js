// Orchestrator Mediator (orchestrator-mediator/index.js)
import express from 'express';
import axios from 'axios';
import 'dotenv/config';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';

const require4 = createRequire(import.meta.url);
const mediatorConfig4 = require4('./mediatorConfig.json');
const {
  OPENHIM_USER: O_USER,
  OPENHIM_PASS: O_PASS,
  OPENHIM_API: O_API,
  PDQM_BASE_URL,
  TERMINO_BASE_URL,
  ITI65_BASE_URL,
  NODE_ENV: O_ENV
} = process.env;

const openhimConfig4 = { username: O_USER, password: O_PASS, apiURL: O_API, trustSelfSigned: true, urn: mediatorConfig4.urn };
if (O_ENV === 'development') axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
registerMediator(openhimConfig4, mediatorConfig4, err => { if (err) { console.error(err); process.exit(1);} activateHeartbeat(openhimConfig4); });

const appO = express();
appO.use(express.json({ limit: '20mb' }));

// Orchestrate PDQm → Terminology → ITI‑65
appO.post('/lacpass/_orchestrate', async (req, res) => {
  const { identifier } = req.body;
  try {
    // 1) Lookup patient via PDQm
    const pdqm = await axios.post(`${PDQM_BASE_URL}/pdqm/_lookup`, { identifier });
    const patientId = pdqm.data.entry?.[0]?.resource?.id;
    // 2) Fetch summary inside ITI65 mediator
    const summary = await axios.post(`${ITI65_BASE_URL}/lacpass/_iti65`, { uuid: patientId });
    const summaryBundle = summary.data;
    // 3) Validate terminologies
    // TODO: iterate over summaryBundle codings and call TERMINO_BASE_URL/termino/_validate
    // 4) Finally send ProvideBundle
    const iti65 = await axios.post(`${ITI65_BASE_URL}/lacpass/_iti65`, summaryBundle);
    return res.json(iti65.data);
  } catch (e) {
    console.error('❌ ERROR orchestration:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

const PORT_ORCH = process.env.ORCH_PORT || 8004;
appO.listen(PORT_ORCH, () => console.log(`Orchestrator Mediator listening on port ${PORT_ORCH}`));
