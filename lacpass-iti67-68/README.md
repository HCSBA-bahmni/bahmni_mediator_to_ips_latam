# LAC‑PASS ITI‑67/68 Regional FHIR Proxy Mediator

Proxy transparente hacia el Nodo Regional FHIR que expone:
- ITI‑67 (búsqueda de DocumentReference)
- ITI‑68 (obtención de Bundle por id)

Se registra/latea en OpenHIM y normaliza la URL base del servidor FHIR remoto añadiendo el sufijo `/fhir` si falta.

- Punto de entrada: `index.js`
- Configuración de mediador y canales: `mediatorConfig.json`
- Puerto por defecto: `8006`

## Endpoints

- `GET /regional/_health` → 200 OK
- `GET /regional/DocumentReference` → reenvía a `${FHIR_NODO_REGIONAL_SERVER}/fhir/DocumentReference` pasando todos los query params tal cual (ITI‑67)
- `GET /regional/Bundle/{id}` → reenvía a `${FHIR_NODO_REGIONAL_SERVER}/fhir/Bundle/{id}` con `_format=json` y los query params recibidos (ITI‑68)

Notas:
- Se aceptan certificados autofirmados en `NODE_ENV=development`.
- Timeout de upstream por defecto: 15s.

## Variables de entorno

- `OPENHIM_USER`, `OPENHIM_PASS`, `OPENHIM_API` → registro/heartbeat en OpenHIM
- `FHIR_NODO_REGIONAL_SERVER` → base del servidor regional (con o sin `/fhir`, el mediador lo añade si falta). Ej: `https://regional.example.org` o `https://regional.example.org/fhir`
- `LACPASS_MEDIATOR_PORT` → puerto de escucha (default `8006`)
- `NODE_ENV` → usa `development` para permitir TLS autofirmado

Ejemplo `.env`:
```
OPENHIM_USER=admin
OPENHIM_PASS=secret
OPENHIM_API=https://openhim-core:8080

FHIR_NODO_REGIONAL_SERVER=https://regional.example.org
LACPASS_MEDIATOR_PORT=8006
NODE_ENV=development
```

## Uso local

1) Instalar dependencias
```
npm ci
```
2) Arrancar
```
npm start
```
3) Probar
```
# Salud
curl http://localhost:8006/regional/_health

# ITI‑67: DocumentReference (ajusta parámetros ITI‑67)
curl "http://localhost:8006/regional/DocumentReference?patient=123&_count=10"

# ITI‑68: Bundle por id
curl "http://localhost:8006/regional/Bundle/abcd-1234"
```

PowerShell (Windows) con headers de ejemplo:
```
curl -Method GET "http://localhost:8006/regional/DocumentReference?patient=123&_count=10" ^
  -Headers @{ Accept = 'application/fhir+json' }
```

## Docker

Construcción y ejecución (PowerShell):
```
# Construir
docker build -t lacpass-iti67-68:latest .

# Ejecutar
docker run --rm -p 8006:8006 ^
  -e OPENHIM_USER=$env:OPENHIM_USER ^
  -e OPENHIM_PASS=$env:OPENHIM_PASS ^
  -e OPENHIM_API=$env:OPENHIM_API ^
  -e FHIR_NODO_REGIONAL_SERVER=$env:FHIR_NODO_REGIONAL_SERVER ^
  -e LACPASS_MEDIATOR_PORT=8006 ^
  -e NODE_ENV=development ^
  lacpass-iti67-68:latest
```

Nota: el endpoint de salud es `/regional/_health`. Si usas el `Dockerfile` incluido, ajusta el HEALTHCHECK para que apunte a `http://localhost:8006/regional/_health`.

## Canales en OpenHIM (resumen)

Definidos en `mediatorConfig.json` y creados/actualizados al iniciar:
- `ITI-67 DocumentReference Search Channel` → `^/regional/DocumentReference$` (GET)
- `ITI-68 Bundle Retrieve Channel` → `^/regional/Bundle/.*$` (GET)
- `Health Channel` → `^/regional/_health$` (GET)

## Solución de problemas

- 502/timeout → revisa conectividad y valor de `FHIR_NODO_REGIONAL_SERVER`.
- Certificados TLS → usa `NODE_ENV=development` en ambientes con CA propia/autofirmada.
- Prefijo `/fhir` → el mediador lo añade automáticamente si falta en la base remota.
- El mediador reenvía el status y el cuerpo de error del upstream para facilitar el diagnóstico.
