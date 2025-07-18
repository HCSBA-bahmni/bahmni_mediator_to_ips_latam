import os
import re
import time
import json
import requests
import feedparser
import urllib3
from dotenv import load_dotenv

# Cargar .env
load_dotenv()

# --- Configuración de entorno ---
NODE_ENV                = os.getenv("NODE_ENV", "development").lower()  # development o production
VERIFY_SSL              = False if NODE_ENV == "development" else True

# Atom Feed (OpenMRS)
ATOM_FEED_URL           = os.getenv("ATOM_FEED_URL")
FEED_POLL_INTERVAL      = int(os.getenv("FEED_POLL_INTERVAL", "15"))
OPENMRS_USER            = os.getenv("OPENMRS_USER")
OPENMRS_PASS            = os.getenv("OPENMRS_PASS")

# OpenHIM / Forwarder
OPENHIM_USER            = os.getenv("OPENHIM_USER")
OPENHIM_PASS            = os.getenv("OPENHIM_PASS")
OPENHIM_EVENT_ENDPOINT  = os.getenv("OPENHIM_EVENT_ENDPOINT")   # forwarder ITI‑X
OPENHIM_SUMMARY_ENDPOINT= os.getenv("OPENHIM_SUMMARY_ENDPOINT") # mediador ITI‑65

# FHIR Proxy para summary
FHIR_PROXY_URL          = os.getenv("FHIR_PROXY_URL")
SUMMARY_PROFILE         = os.getenv("SUMMARY_PROFILE")

# Persistencia de entries ya procesadas
SEEN_FILE = "seen_entries.json"
try:
    with open(SEEN_FILE, "r") as f:
        seen_entries = set(json.load(f))
except Exception:
    seen_entries = set()

# Desactivar warnings de certificados self‑signed si es dev
if not VERIFY_SSL:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def save_seen_entries():
    try:
        with open(SEEN_FILE, "w") as f:
            json.dump(list(seen_entries), f)
    except Exception as e:
        print(f"[ERROR] Guardando seen_entries: {e}")

def extract_encounter_uuid_from_content(entry):
    content = entry.get('content')
    if not content:
        return None
    # Regex original para tu feed (bahmniencounter)
    m = re.search(r'/bahmniencounter/([0-9a-fA-F\-]{36})', content[0].value)
    return m.group(1) if m else None

def get_patient_id(enc_uuid):
    try:
        r = requests.get(
            f"{FHIR_PROXY_URL}/Encounter/{enc_uuid}",
            auth=(OPENHIM_USER, OPENHIM_PASS),
            verify=VERIFY_SSL, timeout=10
        )
        if r.status_code == 200:
            return r.json()['subject']['reference'].split('/')[-1]
        else:
            print(f"[WARN] Encounter {enc_uuid} no encontrado (status {r.status_code})")
    except Exception as e:
        print(f"[ERROR] get_patient_id: {e}")
    return None

def process_feed(feed):
    print(f"[INFO] Procesando {len(feed.entries)} entries...")
    for entry in feed.entries:
        entry_id = entry.get('id') or entry.get('tag')
        if entry_id in seen_entries:
            continue
        seen_entries.add(entry_id)
        save_seen_entries()

        uuid = extract_encounter_uuid_from_content(entry)
        if not uuid:
            print(f"[WARN] No pude extraer UUID de entry {entry_id}")
            continue

        # 1) Notificar al forwarder ITI‑X
        try:
            resp = requests.post(
                OPENHIM_EVENT_ENDPOINT,
                json={"uuid": uuid},
                auth=(OPENHIM_USER, OPENHIM_PASS),
                verify=VERIFY_SSL, timeout=10
            )
            print(f"🔔 Forwarder notified: {uuid} (status {resp.status_code})")
        except Exception as e:
            print(f"[ERROR] Al notificar forwarder: {e}")
            continue

        # 2) Polling summary con back‑off exponencial
        patient_id = get_patient_id(uuid)
        if not patient_id:
            continue

        for attempt in range(5):
            wait = 2 ** attempt
            print(f"⏱ Esperando {wait}s para summary (intento {attempt+1}/5)")
            time.sleep(wait)
            try:
                r2 = requests.get(
                    f"{FHIR_PROXY_URL}/Patient/{patient_id}/$summary?profile={SUMMARY_PROFILE}",
                    auth=(OPENHIM_USER, OPENHIM_PASS),
                    verify=VERIFY_SSL, timeout=10
                )
                if r2.status_code == 200:
                    summary_bundle = r2.json()
                    # 3) Notificar al mediador ITI‑65
                    r3 = requests.post(
                        OPENHIM_SUMMARY_ENDPOINT,
                        json=summary_bundle,
                        auth=(OPENHIM_USER, OPENHIM_PASS),
                        verify=VERIFY_SSL, timeout=10
                    )
                    print(f"🔔 ITI65 mediator notified (status {r3.status_code})")
                    break
                else:
                    print(f"[WARN] Summary no listo (status {r2.status_code})")
            except Exception as e:
                print(f"[ERROR] Polling summary: {e}")

def get_feed():
    try:
        resp = requests.get(
            ATOM_FEED_URL,
            auth=(OPENMRS_USER, OPENMRS_PASS) if OPENMRS_USER else None,
            verify=VERIFY_SSL, timeout=10
        )
        if resp.status_code == 200:
            return feedparser.parse(resp.text)
        else:
            print(f"[ERROR] Feed status: {resp.status_code}")
    except Exception as e:
        print(f"[ERROR] Al leer feed: {e}")
    return None

if __name__ == '__main__':
    print("🚀 Feed watcher iniciado en modo", NODE_ENV.upper())
    while True:
        feed = get_feed()
        if feed and getattr(feed, 'entries', None):
            process_feed(feed)
        else:
            print("[WARN] No entries o error al leer feed.")
        time.sleep(FEED_POLL_INTERVAL)
