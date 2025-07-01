import requests
import feedparser
import time
import urllib3
import os
from dotenv import load_dotenv

# Carga variables de entorno desde .env
load_dotenv()

# Deshabilita advertencias SSL
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ATOM_FEED_URL = os.getenv("ATOM_FEED_URL")
OPENMRS_USER = os.getenv("OPENMRS_USER")
OPENMRS_PASS = os.getenv("OPENMRS_PASS")
OPENHIM_ENTRYFEED = os.getenv("OPENHIM_ENTRYFEED")
OPENHIM_USER = os.getenv("OPENHIM_USER")
OPENHIM_PASS = os.getenv("OPENHIM_PASS")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", 15))

processed_events = set()

def process_feed(feed):
    for entry in feed.entries:
        event_uuid = entry.id.split(":")[-1]
        if event_uuid not in processed_events:
            data = {
                "uuid": event_uuid,
                "title": entry.title,
                "link": entry.link,
                "content": entry.content[0].value if hasattr(entry, 'content') else ""
            }
            try:
                # Autenticación básica para OpenHIM si aplica
                auth = (OPENHIM_USER, OPENHIM_PASS) if OPENHIM_USER and OPENHIM_PASS else None
                resp = requests.post(OPENHIM_ENTRYFEED, json=data, auth=auth)
                if resp.status_code == 200:
                    print(f"Evento {event_uuid} enviado correctamente.")
                    processed_events.add(event_uuid)
                else:
                    print(f"Error {resp.status_code} al enviar evento {event_uuid}: {resp.text}")
            except Exception as e:
                print(f"Error al enviar evento {event_uuid}: {e}")

def get_feed():
    try:
        # Autenticación básica si el feed lo requiere
        auth = (OPENMRS_USER, OPENMRS_PASS) if OPENMRS_USER and OPENMRS_PASS else None
        response = requests.get(ATOM_FEED_URL, verify=False, auth=auth)
        response.raise_for_status()
        return feedparser.parse(response.text)
    except Exception as e:
        print(f"Error al obtener el feed: {e}")
        return None

def monitor_feed(interval=POLL_INTERVAL):
    while True:
        print("Consultando feed...")
        feed = get_feed()
        if feed:
            process_feed(feed)
        time.sleep(interval)

if __name__ == "__main__":
    monitor_feed(POLL_INTERVAL)
