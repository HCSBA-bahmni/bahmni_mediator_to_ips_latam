# PDQm Mediator (ITI-78) — README

Mediador **PDQm (Patient Demographics Query for Mobile – ITI-78)** que expone un endpoint para buscar pacientes por identificador. Consulta un servidor PDQm/FHIR upstream y, si falla o no hay resultados, **puede** responder con un **fallback** (solo para pruebas) que retorna un `Bundle` FHIR con un `Patient` mínimo usando el identificador solicitado.

> ⚠️ **Importante (Producción):** El **fallback es solo para ambientes de prueba/desarrollo**. **Debes deshabilitarlo en producción** (ver sección *Deshabilitar fallback en producción*).

---

## Tabla de contenido
- [Arquitectura y flujo](#arquitectura-y-flujo)
- [Requisitos](#requisitos)
- [Variables de entorno](#variables-de-entorno)
- [Instalación y ejecución](#instalación-y-ejecución)
- [Endpoints](#endpoints)
- [Cabeceras FHIR](#cabeceras-fhir)
- [Comportamiento del fallback (solo pruebas)](#comportamiento-del-fallback-solo-pruebas)
- [Deshabilitar fallback en producción](#deshabilitar-fallback-en-producción)
- [Manejo de errores](#manejo-de-errores)
- [Logs](#logs)
- [Configuración OpenHIM](#configuración-openhim)
- [Ejemplos con cURL](#ejemplos-con-curl)
- [Notas de seguridad](#notas-de-seguridad)

---

## Arquitectura y flujo

1. El cliente invoca `POST /pdqm/_lookup` con `{"identifier": "<ID>"}`.
2. El mediador llama al servidor PDQm/FHIR:  
   `GET {PDQM_FHIR_URL}/Patient?_id=<ID>` (o `?identifier=<ID>` si así se configura).
3. Respuestas posibles:
   - **200 con resultados** → se retorna tal cual el `Bundle` FHIR del servidor.
   - **200 sin resultados (`total = 0`)** → *en pruebas* se activa **fallback** (Bundle con Patient mínimo).
   - **Errores 400/404** o **errores de red/timeout** → *en pruebas* se activa **fallback**.
   - Otros errores → `502 Bad Gateway`.

---

## Requisitos

- Node.js 18+
- Acceso de red al servidor PDQm/FHIR remoto (si aplica)
- (Opcional) OpenHIM si se orquesta desde el mediador

---

## Variables de entorno

Crea un `.env` en la raíz:

```bash
# OpenHIM (si corresponde)
OPENHIM_USER=admin
OPENHIM_PASS=pass
OPENHIM_API=https://openhim-host:8080

# PDQm Mediator
PDQM_PORT=8001
PDQM_FHIR_URL=https://pdqm-fhir.example.org/fhir
PDQM_FHIR_TOKEN=eyJhbGci...

# Opcional: asigna un system al identificador de fallback (solo pruebas)
IDENTIFIER_SYSTEM=urn:oid:2.16.756.888801.3.4

# development | production
NODE_ENV=development
```

> En `NODE_ENV=development` se aceptan certificados self-signed.

---

## Instalación y ejecución

```bash
npm install
npm run start
# o
node index.js
```

El servidor queda escuchando en `http://localhost:${PDQM_PORT}`.

---

## Endpoints

### `POST /pdqm/_lookup`
- **Body**: `{"identifier": "12345"}`
- **Respuesta**: `Bundle` FHIR (tipo `searchset`) con 0+ `entry` de `Patient`.

### `GET /pdqm/_health`
- Healthcheck simple (200 OK).  
  *(Si quieres, podemos devolver un Bundle FHIR mínimo para health; hoy es un 200 simple).*

---

## Cabeceras FHIR

El mediador envía al upstream:
- `Accept: application/fhir+json`
- `Authorization: Bearer ${PDQM_FHIR_TOKEN}` (si está definido)

También **pasa** desde el cliente:
- `Authorization`, `Content-Type`, `Accept` (configurable en OpenHIM)

---

## Comportamiento del fallback (solo pruebas)

Cuando se activa (pruebas), el mediador **construye y retorna** un `Bundle` FHIR con:
- `type: "searchset"`, `total: 1`
- Un `Patient` **mínimo** con:
  - `identifier.value = <identifier recibido>`
  - `identifier.system = IDENTIFIER_SYSTEM` (si está definido)
  - `active: true`

**Cuándo se activa en pruebas:**
- Upstream responde 200 con `total = 0`
- Upstream responde 400 o 404
- Errores de red / timeout / sin respuesta

> Esto permite probar integraciones aguas abajo **sin depender** del servidor PDQm.

---

## Deshabilitar fallback en producción

Tienes dos opciones (recomendado aplicar ambas):

1. **Por código (simple):**
   - En el `catch` y en el caso de `total = 0`, **no** llames a `fallBackCall(identifier)` y responde:
     - `200` con el `Bundle` vacío si el upstream retornó `total = 0`.
     - `4xx/5xx` acorde al error, por ejemplo `404` o `502` con detalle.
2. **Por entorno:**
   - Usa `NODE_ENV=production` y agrega una **bandera** (p. ej. `ENABLE_FALLBACK=false`) que se evalúe antes de invocar `fallBackCall`.  
     Ejemplo (pseudocódigo):
     ```js
     const ENABLE_FALLBACK = process.env.ENABLE_FALLBACK === 'true';
     if (ENABLE_FALLBACK) {
       const fallback = await fallBackCall(identifier);
       return res.json(fallback);
     }
     // manejar como error o responder bundle vacío
     ```

---

## Manejo de errores

- **400/404** del upstream → en pruebas: fallback; en prod: propagar o normalizar a `404` “Patient not found”.
- **Timeout/ECONNREFUSED/DNS** → en pruebas: fallback; en prod: `502 { error: "Bad gateway" }`.
- Otros → `502` con mensaje genérico.

> Timeout por defecto: **10s** (ajústalo si tu upstream es más lento).

---

## Logs

- Registra:
  - URL llamada al upstream
  - Código de respuesta / causa de error
  - Activación de fallback (en pruebas)
- En `NODE_ENV=development` se acepta TLS self-signed.

---

## Configuración OpenHIM

`mediatorConfig.json` recomendado (resumen):

- Canal `POST ^/pdqm/_lookup$` → `localhost:${PDQM_PORT}/pdqm/_lookup`
- Canal `GET ^/pdqm/_health$` → `localhost:${PDQM_PORT}/pdqm/_health`
- `passThroughHeaders`: `Authorization`, `Content-Type`, `Accept`
- `heartbeatPath`: `/pdqm/_health` (intervalo 30s)

---

## Ejemplos con cURL

### Lookup OK (upstream con resultados)
```bash
curl -X POST http://localhost:8001/pdqm/_lookup   -H "Content-Type: application/json"   -d '{"identifier":"12345"}'
```

### Lookup sin resultados (en pruebas → fallback)
```bash
curl -X POST http://localhost:8001/pdqm/_lookup   -H "Content-Type: application/json"   -d '{"identifier":"ID-QUE-NO-EXISTE"}'
```

### Health
```bash
curl -X GET http://localhost:8001/pdqm/_health
```

---

## Notas de seguridad

- No registres `PDQM_FHIR_TOKEN` en logs.
- Usa HTTPS hacia el upstream en producción.
- Controla acceso al endpoint (API Gateway / OpenHIM / IP allowlist / OAuth2).
- Deshabilita completamente el **fallback** en producción.
