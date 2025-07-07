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
    # Busca un UUID dentro del campo content (típicamente en la URL)
    if hasattr(entry, 'content') and entry.content:
        m = re.search(r'/bahmniencounter/([0-9a-fA-F\-]{36})', entry.content[0].value)
        if m:
            return m.group(1)
    return None

def process_feed(feed):
    for entry in feed.entries:
        uuid = extract_encounter_uuid_from_content(entry)
        if not uuid:
            print(f"[WARN] No se pudo extraer UUID de content para entry: {entry.id}")
            continue
        if uuid not in seen:
            data = {"uuid": uuid}
            try:
                resp = requests.post(ITIMED_ENDPOINT, json=data)
                print("Notificado a ITI:", uuid, "| Status:", resp.status_code)
                seen.add(uuid)
            except Exception as e:
                print("[ERROR] Al notificar a ITI:", e)

def get_feed():
    auth = (OPENMRS_USER, OPENMRS_PASS) if OPENMRS_USER else None
    try:
        r = requests.get(FEED_URL, auth=auth, verify=False)
        if r.status_code == 200:
            return feedparser.parse(r.text)
        else:
            print("[ERROR] Feed status:", r.status_code)
            return None
    except Exception as e:
        print("[ERROR] Al leer feed:", e)
        return None

if __name__ == '__main__':
    while True:
        feed = get_feed()
        if feed: process_feed(feed)
        time.sleep(FEED_POLL_INTERVAL)

#falta agregar metodo para no repetir lo procesado. como una base de datos como estaba antes.