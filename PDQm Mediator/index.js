// PDQm Mediator (pdqm-mediator/index.js)
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

const {
    OPENHIM_USER,
    OPENHIM_PASS,
    OPENHIM_API,
    PDQM_FHIR_URL,
    PDQM_FHIR_TOKEN,
    PDQM_PORT,
    IDENTIFIER_SYSTEM,   // opcional: ej. "urn:oid:2.16.756.888801.3.4"
    NODE_ENV
} = process.env;

const openhimConfig = {
    username: OPENHIM_USER,
    password: OPENHIM_PASS,
    apiURL: OPENHIM_API,
    trustSelfSigned: true,
    urn: mediatorConfig.urn
};

if (NODE_ENV === 'development') {
    axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    console.log('⚠ DEV MODE: self-signed certs accepted');
}

registerMediator(openhimConfig, mediatorConfig, err => {
    if (err) {
        console.error('❌ Registration error:', err);
        process.exit(1);
    }
    activateHeartbeat(openhimConfig);
});

const app = express();
app.use(express.json());

// ---------- Helpers ----------
const buildFallbackBundle = (identifier) => {
    // Bundle ITI-78 válido con Patient mínimo que conserva el identificador recibido
    const now = new Date().toISOString();
    return {
        resourceType: 'Bundle',
        id: cryptoRandomId(),
        meta: { lastUpdated: now },
        type: 'searchset',
        total: 1,
        link: [{
            relation: 'self',
            url: `${PDQM_FHIR_URL?.replace(/\/+$/,'') || 'http://local/pdqm'}/Patient?identifier=${encodeURIComponent(identifier)}`
        }],
        entry: [{
            fullUrl: `urn:uuid:${cryptoRandomId()}`,
            resource: {
                resourceType: 'Patient',
                id: cryptoRandomId(),
                active: true,
                identifier: [{
                    ...(IDENTIFIER_SYSTEM ? { system: IDENTIFIER_SYSTEM } : {}),
                    value: identifier
                }]
            },
            search: { mode: 'match' }
        }]
    };
};

const cryptoRandomId = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });

const fallBackCall = async (identifier) => {
    // Si quieres, aquí podrías consultar un servidor local antes de construir el Bundle.
    // Por ahora, devolvemos el Bundle de fallback con el identificador recibido.
    return buildFallbackBundle(identifier);
};

// ---------- ITI-78 PDQm (Patient Demographics Query Mobile) ----------
app.post('/pdqm/_lookup', async (req, res) => {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: 'Missing identifier' });

    try {
        const baseUrl = (PDQM_FHIR_URL || '').replace(/\/+$/, '');
        // Puedes usar ?identifier= si tu servidor PDQm lo requiere; aquí dejo ?_id= porque así lo tenías.
        const url = `${baseUrl}/Patient?_id=${encodeURIComponent(identifier)}`;

        const resp = await axios.get(url, {
            httpsAgent: axios.defaults.httpsAgent, // respeta modo DEV
            headers: {
                Authorization: `Bearer ${PDQM_FHIR_TOKEN || ''}`,
                Accept: 'application/fhir+json'
            },
            timeout: 10000 // 10s
        });

        // Si el servidor responde pero no hay resultados, usar fallback:
        if (resp?.data?.resourceType === 'Bundle' && Number(resp.data.total) === 0) {
            const fallback = await fallBackCall(identifier);
            return res.json(fallback);
        }

        return res.json(resp.data);
    } catch (e) {
        const status = e?.response?.status;

        // Errores esperables (p.ej. 400/404) o sin respuesta (timeout, DNS, ECONNREFUSED)
        if (status === 400 || status === 404 || !e.response) {
            console.error('⚠ PDQm lookup fallback path:', e.message || e.code || e);
            const fallback = await fallBackCall(identifier);
            return res.json(fallback);
        }

        console.error('❌ ERROR PDQm lookup:', e.message || e);
        return res.status(502).json({ error: e.message || 'Bad gateway' });
    }
});

const PORT_PDQM = PDQM_PORT || 8007;
app.listen(PORT_PDQM, () => console.log(`PDQm Mediator listening on port ${PORT_PDQM}`));
