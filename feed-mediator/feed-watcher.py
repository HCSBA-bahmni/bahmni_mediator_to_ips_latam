import requests, feedparser, time, os
from dotenv import load_dotenv
load_dotenv()

FEED_URL = os.getenv("ATOM_FEED_URL")
ITIMED_ENDPOINT = os.getenv("OPENHIM_ITI_ENDPOINT")
FEED_POLL_INTERVAL = int(os.getenv("FEED_POLL_INTERVAL", "15"))
OPENMRS_USER = os.getenv("OPENMRS_USER")
OPENMRS_PASS = os.getenv("OPENMRS_PASS")

seen = set()
def process_feed(feed):
    for entry in feed.entries:
        uuid = entry.id.split(":")[-1]
        if uuid not in seen:
            data = {
                "uuid": uuid,
                "title": entry.title,
                "link": entry.link,
                "content": entry.content[0].value if hasattr(entry, 'content') else ""
            }
            try:
                requests.post(ITIMED_ENDPOINT, json=data)
                seen.add(uuid)
                print("Notificado a ITI:", uuid)
            except Exception as e:
                print("Error:", e)

def get_feed():
    auth = (OPENMRS_USER, OPENMRS_PASS) if OPENMRS_USER else None
    r = requests.get(FEED_URL, auth=auth, verify=False)
    return feedparser.parse(r.text) if r.status_code==200 else None

while True:
    feed = get_feed()
    if feed: process_feed(feed)
    time.sleep(FEED_POLL_INTERVAL)
