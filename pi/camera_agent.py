#!/usr/bin/env python3
"""Capture one photo per UTC hour and serve on-demand near-live frames."""

import io
import json
import logging
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from picamera2 import Picamera2
from PIL import Image


BASE_URL = os.environ["RAILWAY_URL"].rstrip("/")
TOKEN = os.environ["DEVICE_TOKEN"]
DATA_DIR = Path(os.environ.get("OFFICECAM_DATA_DIR", str(Path.home() / "officecam-data")))
QUEUE_DIR = DATA_DIR / "queue"
LAST_SLOT_FILE = DATA_DIR / "last-slot.txt"
LIVE_INTERVAL = float(os.environ.get("LIVE_INTERVAL_SECONDS", "1.5"))

if not BASE_URL.startswith("https://") and not BASE_URL.startswith("http://localhost:"):
    raise SystemExit("RAILWAY_URL must use HTTPS")


def request(method, route, payload=None, headers=None):
    auth_headers = {"Authorization": f"Bearer {TOKEN}"}
    auth_headers.update(headers or {})
    operation = urllib.request.Request(
        BASE_URL + route, data=payload, headers=auth_headers, method=method
    )
    with urllib.request.urlopen(operation, timeout=20) as response:
        return json.loads(response.read())


def jpeg(image, quality):
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=quality)
    return output.getvalue()


def capture_slot(camera, slot):
    filename = QUEUE_DIR / f"{slot.strftime('%Y-%m-%dT%H-00-00Z')}.jpg"
    if not filename.exists():
        image = camera.capture_image()
        temporary = filename.with_suffix(".tmp")
        temporary.write_bytes(jpeg(image, 85))
        temporary.replace(filename)
    LAST_SLOT_FILE.write_text(slot.isoformat(), encoding="utf-8")
    logging.info("Captured hourly photo %s", filename.name)


def upload_pending():
    for filename in sorted(QUEUE_DIR.glob("*.jpg")):
        stamp = filename.stem.replace("-00-00Z", ":00:00.000Z")
        try:
            request(
                "POST", "/api/device/photo", filename.read_bytes(),
                {"Content-Type": "image/jpeg", "X-Captured-At": stamp},
            )
            filename.unlink()
            logging.info("Uploaded %s", filename.name)
        except (OSError, urllib.error.URLError, ValueError) as error:
            logging.warning("Upload delayed: %s", error)
            break


def stream_needed():
    try:
        return bool(request("GET", "/api/device/status")["stream"])
    except (OSError, urllib.error.URLError, ValueError, KeyError) as error:
        logging.warning("Could not check live viewers: %s", error)
        return False


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    camera = Picamera2()
    configuration = camera.create_still_configuration(main={"size": (1920, 1080)})
    camera.configure(configuration)
    camera.start()
    time.sleep(2)
    logging.info("Camera ready; connecting to %s", BASE_URL)

    try:
        last_slot = LAST_SLOT_FILE.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        last_slot = ""
    next_upload = 0.0
    next_status = 0.0
    next_live = 0.0
    viewers = False

    try:
        while True:
            now = datetime.now(timezone.utc)
            slot = now.replace(minute=0, second=0, microsecond=0)
            if slot.isoformat() != last_slot:
                capture_slot(camera, slot)
                last_slot = slot.isoformat()
                next_upload = 0.0

            monotonic = time.monotonic()
            if monotonic >= next_upload:
                upload_pending()
                next_upload = monotonic + 30
            if monotonic >= next_status:
                viewers = stream_needed()
                next_status = monotonic + 4
            if viewers and monotonic >= next_live:
                try:
                    image = camera.capture_image()
                    image.thumbnail((640, 360), Image.Resampling.LANCZOS)
                    request("POST", "/api/device/live", jpeg(image, 68), {"Content-Type": "image/jpeg"})
                except (OSError, urllib.error.URLError, ValueError) as error:
                    logging.warning("Live frame delayed: %s", error)
                next_live = monotonic + LIVE_INTERVAL
            time.sleep(0.2)
    finally:
        camera.stop()


if __name__ == "__main__":
    main()
