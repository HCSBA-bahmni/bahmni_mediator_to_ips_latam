# openhimtoFhirproxy

[feed-watcher.py]
         |
     (POST con UUID)
         |
         v
[nuevo mediador /event]
         |
(usa fhir-proxy para obtener recursos)
         |
    para cada recurso:
         |
         v
(PUT al FHIR_NODE_URL:8080/fhir/Patient/{id}, Encounter/{id}, etc.)


POST /event { uuid }
   └─> usa proxy: GET /fhir/Encounter/{uuid}
   └─> extrae patientId de Encounter
   └─> GET /fhir/Patient/{patientId}
   └─> GET /fhir/Observation?patient={patientId}
   └─> GET /fhir/Condition?patient={patientId}
   ... etc

Por cada recurso obtenido:
    PUT {FHIR_NODE_URL}/fhir/{resourceType}/{id}
    Guardar resultado

Retornar resumen del batch (éxito/error por recurso)


OpenMRS AtomFeed
    ↓ feed-watcher.py
OpenHIM → /forwarder/_event → FHIR Event Forwarder Mediator (carga Encounter+recursos)
    ↓ feed-watcher notifica
OpenHIM → /lacpass/_iti65 → LAC‑PASS ITI‑65 Mediator
    ↓ construye ProvideBundle
    └─POST→ 10.68.174.221:8080/fhir (transaction Bundle)
