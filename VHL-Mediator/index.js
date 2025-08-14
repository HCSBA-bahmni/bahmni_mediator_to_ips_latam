// VHL Generator Mediator
import express from 'express';
import axios from 'axios';
import 'dotenv/config';
import https from 'https';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';

const requireJson = createRequire(import.meta.url);
const mediatorConfig = requireJson('./mediatorConfig.json');

// ======== ENV ========
const {
    OPENHIM_USER,
    OPENHIM_PASS,
    OPENHIM_API,
    NODE_ENV,
    VHL_ISSUANCE_URL,
    VHL_PASSCODE = '1234',
    VHL_EXPIRES_DAYS = '30',
    VHL_BASIC_USER,
    VHL_BASIC_PASS
} = process.env;

// ======== OpenHIM mediator registration ========
const openhimConfig = {
    username: OPENHIM_USER,
    password: OPENHIM_PASS,
    apiURL: OPENHIM_API,
    trustSelfSigned: true,
    urn: mediatorConfig.urn
};

// Permitir self-signed en dev
if (NODE_ENV === 'development') {
    axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
}

// Registrar y latido
registerMediator(openhimConfig, mediatorConfig, (err) => {
    if (err) {
        console.error('Error registrando mediator en OpenHIM:', err);
        process.exit(1);
    }
    console.log('Mediator registrado en OpenHIM.');
    activateHeartbeat(openhimConfig);
});

// ======== App ========
const app = express();
app.use(express.json({ limit: '20mb' }));

// CORS simple (ajusta origen según tu front)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Salud
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Helper: fecha de expiración ISO (ahora + días)
const isoPlusDays = (days = 30) =>
    new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString();

// POST /vhl/_generate
// Body: (Bundle FHIR) - objeto o string
app.post('/vhl/_generate', async (req, res) => {
    try {
        let bundle = req.body;
        if (!bundle) {
            return res.status(400).json({ error: 'Missing IPS bundle' });
        }

        // Si vino como string, intenta parsear
        if (typeof bundle === 'string') {
            try { bundle = JSON.parse(bundle); }
            catch { /* lo dejamos como venía */ }
        }

        // Validación mínima
        if (typeof bundle !== 'object' || bundle.resourceType !== 'Bundle') {
            return res.status(400).json({ error: 'Body must be a FHIR Bundle object' });
        }

        // Armar payload para el servicio de emisión
        const payload = {
            expiresOn: isoPlusDays(VHL_EXPIRES_DAYS),
            jsonContent: JSON.stringify(bundle),
            passCode: VHL_PASSCODE
        };

        // Headers (con basic opcional)
        const headers = { 'Content-Type': 'application/json' };
        if (VHL_BASIC_USER && VHL_BASIC_PASS) {
            const basic = Buffer.from(`${VHL_BASIC_USER}:${VHL_BASIC_PASS}`).toString('base64');
            headers.Authorization = `Basic ${basic}`;
        }

        // Llamada al emisor (retorna texto tipo "HC1: ...")
        const resp = await axios.post(VHL_ISSUANCE_URL, payload, {
            headers,
            responseType: 'text',
            timeout: 30000
        });

        const hc1 = (resp.data || '').toString().trim();
        if (!hc1.startsWith('HC1:')) {
            console.warn('Respuesta del emisor no parece HC1:', hc1.slice(0, 20));
        }

        // Devuelve JSON limpio
        return res.json({ hc1 });
    } catch (e) {
        console.error('❌ ERROR /vhl/_generate:', e?.message || e);
        const status = e?.response?.status || 502;
        const detail = e?.response?.data || e?.message || 'Bad Gateway';
        return res.status(status).json({ error: 'VHL issuance failed', detail });
    }
});

// Arrancar server
const PORT = process.env.VHL_PORT || 8003;
app.listen(PORT, () => {
    console.log(`VHL Mediator listening on http://localhost:${PORT}`);
});
