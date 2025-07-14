import requests, feedparser, time, os, re
from dotenv import load_dotenv
load_dotenv()

FEED_URL = os.getenv("ATOM_FEED_URL")
ITIMED_ENDPOINT = os.getenv("OPENHIM_ITI_ENDPOINT")
FEED_POLL_INTERVAL = int(os.getenv("FEED_POLL_INTERVAL", "15"))
OPENMRS_USER = os.getenv("OPENMRS_USER")
OPENMRS_PASS = os.getenv("OPENMRS_PASS")

seen = set()

def extract_encounter_uuid_from_content(entry):
    print(f"[DEBUG] Analizando entry: {entry.get('id', 'sin id')}")
    if hasattr(entry, 'content') and entry.content:
        print(f"[DEBUG] Content de entry: {entry.content[0].value[:150]}...")  # Imprime primeros 150 chars
        m = re.search(r'/bahmniencounter/([0-9a-fA-F\-]{36})', entry.content[0].value)
        if m:
            print(f"[INFO] UUID extraído: {m.group(1)}")
            return m.group(1)
        else:
            print("[WARN] No se encontró UUID con regex")
    else:
        print("[WARN] Entry sin content")
    return None

def process_feed(feed):
    print(f"[INFO] Procesando feed con {len(feed.entries)} entradas...")
    for entry in feed.entries:
        uuid = extract_encounter_uuid_from_content(entry)
        if not uuid:
            print(f"[WARN] No se pudo extraer UUID de content para entry: {entry.get('id', 'sin id')}")
            continue
        if uuid not in seen:
            data = {"uuid": uuid}
            print(f"[INFO] Enviando UUID {uuid} a {ITIMED_ENDPOINT}")
            try:
                resp = requests.post(ITIMED_ENDPOINT, json=data)
                print("✅ Notificado a ITI:", uuid, "| Status:", resp.status_code)
                seen.add(uuid)
            except Exception as e:
                print("[ERROR] Al notificar a ITI:", e)
        else:
            print(f"[DEBUG] UUID ya procesado: {uuid}")

def get_feed():
    print(f"[INFO] Solicitando feed desde: {FEED_URL}")
    auth = (OPENMRS_USER, OPENMRS_PASS) if OPENMRS_USER else None
    try:
        r = requests.get(FEED_URL, auth=auth, verify=False)
        print(f"[INFO] Código de respuesta del feed: {r.status_code}")
        if r.status_code == 200:
            return feedparser.parse(r.text)
        else:
            print("[ERROR] Feed status:", r.status_code)
            return None
    except Exception as e:
        print("[ERROR] Al leer feed:", e)
        return None

if __name__ == '__main__':
    print("🚀 Feed watcher iniciado.")
    while True:
        print("\n🔁 Nueva iteración de polling...")
        feed = get_feed()
        if feed:
            process_feed(feed)
        else:
            print("[WARN] No se pudo procesar el feed.")
        time.sleep(FEED_POLL_INTERVAL)
