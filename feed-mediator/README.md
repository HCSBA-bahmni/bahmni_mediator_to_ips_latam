# Feed Mediator (Atom → ITI trigger)

Script en Python que monitorea un Atom feed (OpenMRS) y, por cada entrada nueva, extrae el UUID de `bahmniencounter` y dispara una notificación a un endpoint ITI de OpenHIM.

- Script principal: `feed-watcher.py`
- Requisitos: ver `requirements.txt`

## Variables de entorno

- `ATOM_FEED_URL` → URL del Atom feed de OpenMRS.
- `FEED_POLL_INTERVAL` → intervalo de polling en segundos (default `15`).
- `OPENMRS_USER`, `OPENMRS_PASS` → credenciales para leer el feed (opcional si el feed es público).
- `OPENHIM_ITI_ENDPOINT` → endpoint HTTP al que se notifica (ej. el mediador ITI‑65) con `{ "uuid": "..." }`.
- `OPENHIM_USER`, `OPENHIM_PASS` → credenciales Basic para notificar al endpoint ITI.

Coloca estas variables en un `.env` junto al script o configúralas en el entorno del contenedor.

Ejemplo `.env`:
```
ATOM_FEED_URL=https://openmrs.example.org/openmrs/ws/atomfeed/patient/recent
FEED_POLL_INTERVAL=15
OPENMRS_USER=admin
OPENMRS_PASS=Admin123
OPENHIM_ITI_ENDPOINT=https://openhim.example.org/lacpass/_iti65
OPENHIM_USER=mediator
OPENHIM_PASS=secret
```

## Ejecución local

1) Crear entorno y dependencias
```
pip install -r requirements.txt
```
2) Ejecutar
```
python feed-watcher.py
```

## Docker

Construcción y ejecución (PowerShell):
```
# Construir
docker build -t feed-mediator:latest .

# Ejecutar (monta .env o pasa variables)
docker run --rm ^
  --env-file .env ^
  feed-mediator:latest
```

## Detalles de funcionamiento

- Desactiva warnings TLS para certificados autofirmados (solo para entornos de prueba).
- Persiste IDs de entries ya procesadas en `seen_entries.json` para evitar reenvíos.
- Extrae el UUID con la regex `/bahmniencounter/<uuid>` desde el campo `content` del feed.
- Notifica con `POST` JSON `{ uuid: '...' }` al endpoint ITI, usando Basic Auth si se configuró.
- Timeouts: 10s tanto para lectura del feed como para notificación ITI.

## Troubleshooting

- "No se encontró UUID con regex": verifica el formato del `content` del feed; ajusta la regex si el patrón cambia.
- Errores 401/403 al leer el feed: revisa `OPENMRS_USER/PASS`.
- Errores al notificar a ITI: revisa `OPENHIM_ITI_ENDPOINT` y credenciales `OPENHIM_USER/PASS`.
- Si corres en producción con TLS propio, quita `verify=False`/deshabilitado de warnings y usa certificados válidos.
