# bahmni_mediator_to_ips_latam

configuracion de channel y routes

A. Canal para ITI Mediator (iti-mediator)
1. Ve a “Channels” en OpenHIM Console
Haz clic en el botón verde “+ Channel”.

2. Completa los datos:
Channel Name:
ITI Event Channel

Channel URL Pattern:
^/event$

Allow:
admin (deja solo este grupo para control total)

Methods:
POST
(marca solo POST)

Type:
http

Routes (Add Route):

Route Name:
ITI Event Route

Host:
Si usas Docker Compose:

iti-mediator (nombre del servicio en docker-compose)
Si accedes directo desde host (no Docker):

localhost o la IP del host donde corre el mediador

Port:
5000

Path:
/

Primary:
Sí (marcado)

Type:
http

Endpoints:

Puedes dejarlo en blanco (solo para monitoreo avanzado).

Save/Crear

B. Canal para FHIR Proxy Mediator (proxy-mediator)
1. Ve a “Channels” en OpenHIM Console
Haz clic en “+ Channel” de nuevo.

2. Completa los datos:
Channel Name:
FHIR Proxy Channel

Channel URL Pattern:
^/fhir/.*$
(esto permite proxy universal de todo /fhir/*)

Allow:
admin

Methods:
Marca todos los necesarios:

GET, POST, PUT, PATCH, DELETE

Type:
http

Routes (Add Route):

Route Name:
FHIR Proxy Route

Host:
Si usas Docker Compose:

proxy-mediator
Si es fuera de Docker:

localhost o la IP del host

Port:
7000

Path:
/

Primary:
Sí

Type:
http

Endpoints:

Deja vacío (opcional).

Save/Crear