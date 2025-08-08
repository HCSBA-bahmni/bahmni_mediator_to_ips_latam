# LAC‑PASS ITI‑65 ProvideBundle Mediator

Mediador que construye y envía un Provide Bundle (ITI‑65, IHE MHD) hacia el Nodo Nacional a partir de:
- un UUID de Patient (obtiene el resumen con `$summary`), o
- un Bundle FHIR de resumen clínico ya provisto en el cuerpo.

Se registra en OpenHIM, publica un endpoint de salud y expone un endpoint POST para disparar el envío. Genera también archivos de depuración con el ProvideBundle enviado.

- Punto de entrada: `index.js`
- Configuración del mediador/canales: `mediatorConfig.json`
- Puerto por defecto: `8005`

## Flujo

1) `POST /lacpass/_iti65`
   - Si el cuerpo trae `{ "uuid": "<patient-id>" }` → llama a `${FHIR_NODE_URL}/fhir/Patient/{uuid}/$summary?profile=${SUMMARY_PROFILE}` para obtener el Bundle resumen.
   - Si el cuerpo trae un Bundle completo → usa ese Bundle directamente.
2) Normaliza y sanea el Bundle (perfiles genéricos, referencias internas tipo `urn:uuid:*`, eliminación de ciertos `meta.profile`, remoción de `coding.system` en MedicationStatement/Immunization, etc.).
3) Construye:
   - SubmissionSet (List) con perfil IHE MHD Minimal.
   - DocumentReference con `attachment.url = urn:uuid:<bundleId>`, `size` y `hash (sha256 b64)` del Bundle.
   - ProvideBundle de tipo `transaction` con: List, DocumentReference, Bundle original y `PUT Patient`.
4) Envía el ProvideBundle a `FHIR_NODO_NACIONAL_SERVER` (`Content-Type: application/fhir+json`).
5) Guarda una copia JSON del ProvideBundle en `DEBUG_DIR` (por defecto `/tmp`).

Endpoints:
- `GET /lacpass/_health` → 200 OK
- `POST /lacpass/_iti65` → genera y envía ITI‑65

## Variables de entorno

- `OPENHIM_USER`, `OPENHIM_PASS`, `OPENHIM_API` → registro y heartbeat en OpenHIM.
- `FHIR_NODE_URL` → base del nodo FHIR con el recurso `Patient/$summary`.
- `SUMMARY_PROFILE` → perfil a solicitar en `$summary` (p.ej. IPS/UV).
- `FHIR_NODO_NACIONAL_SERVER` → URL destino del ProvideBundle ITI‑65.
- `LACPASS_ITI65_PORT` → puerto del servidor HTTP (default `8005`).
- `NODE_ENV` → `development` acepta TLS autofirmado.
- `DEBUG_DIR` → carpeta para guardar `provideBundle_*.json` (default `/tmp`).

Ejemplo `.env`:

```
OPENHIM_USER=admin
OPENHIM_PASS=secret
OPENHIM_API=https://openhim-core:8080

FHIR_NODE_URL=https://fhir-node.example.org
SUMMARY_PROFILE=http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips

FHIR_NODO_NACIONAL_SERVER=https://nodo-nacional.example.org/fhir

LACPASS_ITI65_PORT=8005
NODE_ENV=development
DEBUG_DIR=/tmp
```

## Uso local (Node)

1) Instala dependencias:
```
npm ci
```
2) Arranca:
```
npm start
```
3) Pruebas rápidas:
```
# Salud
curl http://localhost:8005/lacpass/_health

# Disparo por UUID (ajusta UUID y perfil)
curl -X POST "http://localhost:8005/lacpass/_iti65" ^
  -H "Content-Type: application/json" ^
  -d "{\"uuid\":\"12345678-1234-1234-1234-1234567890ab\"}"

# Disparo por Bundle (archivo local)
curl -X POST "http://localhost:8005/lacpass/_iti65" ^
  -H "Content-Type: application/fhir+json" ^
  --data-binary @summary-bundle.json
```

## Docker

Construcción y ejecución:
```
# Construir imagen
docker build -t lacpass-iti65-mediator:latest .

# Ejecutar con variables del entorno (PowerShell)
docker run --rm -p 8005:8005 ^
  -e OPENHIM_USER=$env:OPENHIM_USER ^
  -e OPENHIM_PASS=$env:OPENHIM_PASS ^
  -e OPENHIM_API=$env:OPENHIM_API ^
  -e FHIR_NODE_URL=$env:FHIR_NODE_URL ^
  -e SUMMARY_PROFILE=$env:SUMMARY_PROFILE ^
  -e FHIR_NODO_NACIONAL_SERVER=$env:FHIR_NODO_NACIONAL_SERVER ^
  -e LACPASS_ITI65_PORT=8005 ^
  -e NODE_ENV=development ^
  -e DEBUG_DIR=/tmp ^
  lacpass-iti65-mediator:latest
```

Notas:
- El `Dockerfile` expone `8005`. El healthcheck del ejemplo debería consultar `http://localhost:8005/lacpass/_health`.
- Usa `--env-file .env` si prefieres cargar variables desde archivo.

## Canales en OpenHIM (resumen)

Definidos en `mediatorConfig.json` y creados al iniciar:
- Canal `ITI‑65 Provide Event Channel`
  - `urlPattern`: `^/lacpass/_iti65$`
  - Ruta hacia este mediador (host/puerto configurados) y método `POST`.
- Canal `ITI‑65 Health Channel`
  - `urlPattern`: `^/lacpass/_health$`
  - Método `GET`.

## Solución de problemas

- 400 Invalid Bundle o falta de `uuid` → el cuerpo debe ser un Bundle FHIR válido o incluir `uuid`.
- 502 al obtener `$summary` → revisa `FHIR_NODE_URL`, `SUMMARY_PROFILE` y certificados TLS (usar `NODE_ENV=development` en pruebas con TLS autofirmado).
- 401/403 desde el Nodo Nacional → verifica autenticación requerida por `FHIR_NODO_NACIONAL_SERVER` (si aplica).
- Archivos de depuración no creados → asegúrate de que `DEBUG_DIR` exista y sea escribible dentro del contenedor/host.

## Desarrollo

- Proyecto ESM (`type: module`).
- Librerías: `express`, `axios`, `openhim-mediator-utils`, `uuid`, `dotenv`.
- El mediador normaliza referencias internas a `urn:uuid:*` y calcula `size`/`hash` del Bundle para `DocumentReference.content[0].attachment`.

## Licencia

Indica aquí la licencia correspondiente del proyecto.
