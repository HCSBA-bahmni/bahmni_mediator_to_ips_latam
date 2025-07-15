import requests, feedparser, time, os, re
import urllib3
from dotenv import load_dotenv

# Desactivar warnings de certificados self-signed
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Carga variables de entorno\load_dotenv()

FEED_URL = os.getenv("ATOM_FEED_URL")
ITIMED_ENDPOINT = os.getenv("OPENHIM_ITI_ENDPOINT")
FEED_POLL_INTERVAL = int(os.getenv("FEED_POLL_INTERVAL", "15"))
OPENMRS_USER = os.getenv("OPENMRS_USER")
OPENMRS_PASS = os.getenv("OPENMRS_PASS")

# Track feed entry IDs to avoid duplicate processing across a single run
seen_entries = set()


def extract_encounter_uuid_from_content(entry):
    entry_id = entry.get('id', 'sin id')
    print(f"[DEBUG] Analizando entry: {entry_id}")
    content = entry.get('content')
    if content:
        val = content[0].value
        print(f"[DEBUG] Content de entry: {val[:150]}...")
        m = re.search(r'/bahmniencounter/([0-9a-fA-F\-]{36})', val)
        if m:
            uuid = m.group(1)
            print(f"[INFO] UUID extraído: {uuid}")
            return uuid
        print("[WARN] No se encontró UUID con regex")
    else:
        print("[WARN] Entry sin content")
    return None


def process_feed(feed):
    print(f"[INFO] Procesando feed con {len(feed.entries)} entries...")
    for entry in feed.entries:
        entry_id = entry.get('id')
        if not entry_id:
            # Fallback to tag if no id field
            entry_id = entry.get('tag')
        if entry_id in seen_entries:
            print(f"[DEBUG] Entry ya procesado: {entry_id}")
            continue
        # Marcar entry como vista
        seen_entries.add(entry_id)

        # Extraer y enviar UUID
        uuid = extract_encounter_uuid_from_content(entry)
        if not uuid:
            print(f"[WARN] No se pudo extraer UUID de entry: {entry_id}")
            continue

        data = {"uuid": uuid}
        print(f"[INFO] Enviando UUID {uuid} a {ITIMED_ENDPOINT}")
        try:
            resp = requests.post(
                ITIMED_ENDPOINT,
                json=data,
                timeout=10,
                verify=False
            )
            print(f"✅ Notificado a ITI: {uuid} | Status: {resp.status_code}")
        except Exception as e:
            print(f"[ERROR] Al notificar a ITI: {e}")


def get_feed():
    print(f"[INFO] Solicitando feed desde: {FEED_URL}")
    auth = (OPENMRS_USER, OPENMRS_PASS) if OPENMRS_USER else None
    try:
        r = requests.get(
            FEED_URL,
            auth=auth,
            verify=False,
            timeout=10
        )
        print(f"[INFO] Código de respuesta del feed: {r.status_code}")
        if r.status_code == 200:
            return feedparser.parse(r.text)
        print(f"[ERROR] Feed status: {r.status_code}")
    except Exception as e:
        print(f"[ERROR] Al leer feed: {e}")
    return None


if __name__ == '__main__':
    print("🚀 Feed watcher iniciado.")
    while True:
        print("\n🔁 Nueva iteración de polling...")
        feed = get_feed()
        if feed and feed.entries:
            process_feed(feed)
        else:
            print("[WARN] No se pudo procesar el feed o no hay entries.")
        time.sleep(FEED_POLL_INTERVAL)
