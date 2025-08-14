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
NODE_ENV                 = os.getenv("NODE_ENV", "development").lower()
VERIFY_SSL               = False if NODE_ENV == "development" else True

ATOM_FEED_URL            = os.getenv("ATOM_FEED_URL")
FEED_POLL_INTERVAL       = int(os.getenv("FEED_POLL_INTERVAL", "15"))

# OpenHIM / Forwarder
OPENHIM_USER             = os.getenv("OPENHIM_USER")
OPENHIM_PASS             = os.getenv("OPENHIM_PASS")
OPENHIM_EVENT_ENDPOINT   = os.getenv("OPENHIM_EVENT_ENDPOINT")   # forwarder ITI‑X (si lo usas)
OPENHIM_SUMMARY_ENDPOINT = os.getenv("OPENHIM_SUMMARY_ENDPOINT") # mediador ITI‑65

# Persistencia de entries ya procesadas
SEEN_FILE = "seen_entries.json"
try:
    with open(SEEN_FILE, "r") as f:
        seen_entries = set(json.load(f))
except Exception:
    seen_entries = set()

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
    m = re.search(r'/bahmniencounter/([0-9a-fA-F\-]{36})', content[0].value)
    return m.group(1) if m else None

def process_feed(feed):
    print(f"[INFO] Procesando {len(feed.entries)} entradas...")
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

        # 1) Notificar al forwarder ITI‑X (opcional)
        if OPENHIM_EVENT_ENDPOINT:
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

        # 2) Notificar al ITI‑65 Mediator
        try:
            resp2 = requests.post(
                OPENHIM_SUMMARY_ENDPOINT,
                json={"uuid": uuid},
                auth=(OPENHIM_USER, OPENHIM_PASS),
                verify=VERIFY_SSL, timeout=10
            )
            print(f"🔔 ITI‑65 Mediator notified: {uuid} (status {resp2.status_code})")
        except Exception as e:
            print(f"[ERROR] Al notificar ITI‑65 Mediator: {e}")

def get_feed():
    try:
        resp = requests.get(
            ATOM_FEED_URL,
            auth=(os.getenv("OPENMRS_USER"), os.getenv("OPENMRS_PASS")) if os.getenv("OPENMRS_USER") else None,
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
