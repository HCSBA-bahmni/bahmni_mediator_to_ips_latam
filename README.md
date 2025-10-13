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




decisiones para diagnosticos

los diasnosticos del encuentro se comparte mediante el recurso Fhir observation
la idea es tomas las observaciones mediante el mediador forwarder encouncer condition y transformarlo a condition de tipo encounter condition

las condiciones activas ya se envian como condiciones mediante el proxy, esta se interpretan bien en el ips fina

las condiciones inactivas o puestas como historia de, quedan como condiciones inactivas
como viene directamente en el recurso fhir condition, no puede ser interpretada correctamente por el recurso. por lo tanto se le deben agregar algunos elementos adicionales ( modificando el recuros proxy), agreando esos elementos desde el inicio:
en openmrs:
{
  "resourceType": "Observation",
  "code": { "text": "Diagnosis" },
  "valueCodeableConcept": { "coding": [{ "system": "http://snomed.info/sct", "code": "444814009", "display": "Acute tonsillitis" }] },
  "encounter": { "reference": "Encounter/123" },
  "subject": { "reference": "Patient/456" }
}

en fhir ips correcto:
1) “Past illness” (enfermedad pasada / resuelta)

Usa Condition con:

clinicalStatus = inactive o resolved

abatementDateTime (o abatementAge/Period) presente → indica cuándo terminó

verificationStatus = confirmed (si aplica)

category = problem-list-item (puedes mantenerlo así aunque esté resuelta; lo que marca que es “pasada” es el clinicalStatus+abatement)

(Opcional) onsetDateTime, severity, recorder, asserter

Ejemplo (past illness):

{
  "resourceType": "Condition",
  "meta": { "profile": ["http://hl7.org/fhir/uv/ips/StructureDefinition/Condition-uv-ips"] },
  "clinicalStatus": { "coding": [{ "system":"http://terminology.hl7.org/CodeSystem/condition-clinical", "code":"resolved" }] },
  "verificationStatus": { "coding": [{ "system":"http://terminology.hl7.org/CodeSystem/condition-ver-status", "code":"confirmed" }] },
  "category": [{ "coding": [{ "system":"http://terminology.hl7.org/CodeSystem/condition-category", "code":"problem-list-item" }] }],
  "code": { "coding": [{ "system":"http://snomed.info/sct", "code":"444814009", "display":"Acute tonsillitis" }] },
  "subject": { "reference": "Patient/123" },
  "onsetDateTime": "2024-06-10",
  "abatementDateTime": "2024-06-20"
}


Para que aparezca en “Historial de Enfermedades Pasadas” del IPS: además de lo anterior, colócala en la sección de la Composition con código LOINC 11348-0 (History of past illness). El recurso sigue siendo Condition; la “sección” es lo que la agrupa en el documento.

“Problem list item” (problema activo en lista de problemas)

Usa Condition con:

clinicalStatus = active

sin abatement[x]

verificationStatus = confirmed (si aplica)

category = problem-list-item

(Opcional) onsetDateTime, severity, recorder, asserter

Ejemplo (problem-list-item activo):

{
  "resourceType": "Condition",
  "meta": { "profile": ["http://hl7.org/fhir/uv/ips/StructureDefinition/Condition-uv-ips"] },
  "clinicalStatus": { "coding": [{ "system":"http://terminology.hl7.org/CodeSystem/condition-clinical", "code":"active" }] },
  "verificationStatus": { "coding": [{ "system":"http://terminology.hl7.org/CodeSystem/condition-ver-status", "code":"confirmed" }] },
  "category": [{ "coding": [{ "system":"http://terminology.hl7.org/CodeSystem/condition-category", "code":"problem-list-item" }] }],
  "code": { "coding": [{ "system":"http://snomed.info/sct", "code":"444814009", "display":"Acute tonsillitis" }] },
  "subject": { "reference": "Patient/123" },
  "onsetDateTime": "2025-10-12"
}


Para que aparezca en “Lista de problemas” del IPS: incluye este Condition en la sección de la Composition con LOINC 11450-4 (Problem list).