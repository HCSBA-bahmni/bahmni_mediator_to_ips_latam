# Terminology Validator Mediator ($validate-code)

Mediador ligero que valida códigos contra un Terminology Server FHIR utilizando la operación `$validate-code` de `CodeSystem`.
Se registra en OpenHIM y publica endpoints para salud y validación.

- Punto de entrada: `index.js`
- Configuración del mediador/canales: `mediatorConfig.json`
- Puerto por defecto: `8002`

## Endpoints

- `GET /termino/_health` → 200 OK (heartbeat para OpenHIM)
- `POST /termino/_validate` → reenvía a `${TERMINO_SERVER_URL}/CodeSystem/$validate-code`
  - Body JSON esperado: `{ "system": string, "code": string, "display"?: string }`

Ejemplo petición/respuesta típica:
```
POST /termino/_validate
{
  "system": "http://snomed.info/sct",
  "code": "22298006",
  "display": "Myocardial infarction (disorder)"
}
```
Respuesta (depende del Terminology Server):
```
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "result", "valueBoolean": true },
    { "name": "message", "valueString": "Code is valid" }
  ]
}
```

## Variables de entorno

- `OPENHIM_USER`, `OPENHIM_PASS`, `OPENHIM_API`: credenciales/URL de OpenHIM para registro y heartbeat.
- `TERMINO_SERVER_URL`: base del Terminology Server FHIR. Ej.: `https://termino.example.org/fhir` o `https://termino.example.org` (el código ya normaliza el final de la URL).
- `TERMINO_PORT` (opcional): puerto de escucha del mediador (default `8002`).
- `NODE_ENV` (opcional): use `development` para permitir certificados TLS autofirmados.

Si el Terminology Server requiere autenticación (Basic/Bearer), configúrala a nivel de red (OpenHIM, API Gateway) o extiende el mediador para incluir cabeceras/autenticación en la llamada `axios.get`.

## Uso local

1) Instalar dependencias
```
npm ci
```
2) Arrancar
```
npm start
```
3) Probar desde consola
```
# Salud
curl http://localhost:8002/termino/_health

# Validación de código
curl -X POST "http://localhost:8002/termino/_validate" \
  -H "Content-Type: application/json" \
  -d '{"system":"http://snomed.info/sct","code":"22298006"}'
```
PowerShell (Windows):
```
$body = @{ system = "http://snomed.info/sct"; code = "22298006" } | ConvertTo-Json
curl -Method POST "http://localhost:8002/termino/_validate" -ContentType "application/json" -Body $body
```

## Docker

Construcción y ejecución (PowerShell):
```
# Construir imagen
docker build -t terminology-validator-mediator:latest .

# Ejecutar
docker run --rm -p 8002:8002 ^
  -e OPENHIM_USER=$env:OPENHIM_USER ^
  -e OPENHIM_PASS=$env:OPENHIM_PASS ^
  -e OPENHIM_API=$env:OPENHIM_API ^
  -e TERMINO_SERVER_URL=$env:TERMINO_SERVER_URL ^
  -e TERMINO_PORT=8002 ^
  -e NODE_ENV=development ^
  terminology-validator-mediator:latest
```
Notas Docker:
- El `Dockerfile` expone `8002` y define un HEALTHCHECK a `/termino/_health`.
- Puedes usar `--env-file .env` para cargar variables.

## Canales en OpenHIM (resumen)

Definidos en `mediatorConfig.json` y creados/actualizados al iniciar:
- `Terminology Validate Channel` → `^/termino/_validate$` (POST)
- `Terminology Health Channel` → `^/termino/_health$` (GET)

## Manejo de errores

- `400` si faltan `system` o `code` en el body.
- `500` si `TERMINO_SERVER_URL` no está configurada.
- `502` si hay error en la comunicación con el Terminology Server (incluye el cuerpo del error si está disponible).
- Timeout de upstream: 15s (ajustable en `index.js`).

## Desarrollo

- Proyecto ESM (`type: module`).
- Librerías: `express`, `axios`, `openhim-mediator-utils`, `dotenv`.
- En `NODE_ENV=development` se aceptan certificados autofirmados para entornos de prueba.
