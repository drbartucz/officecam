# Officecam

A private camera website for a Raspberry Pi and Railway. The Pi saves one JPEG per UTC hour, retries uploads after outages, and sends a small near-live image only while the website is being viewed. Railway keeps the originals in a private Storage Bucket and prepares 24 fps MP4 time-lapses on demand. Every stored photo is one video frame.

The current website is at [officecam-web-production.up.railway.app](https://officecam-web-production.up.railway.app/). Its password and Pi device token are stored as Railway service variables and are not part of this repository.

## What you need

- Raspberry Pi 4 (the existing Pi is a good starting point), power supply, and microSD card
- A compatible Raspberry Pi camera module and cable
- Raspberry Pi OS Lite (64-bit) with internet access on the work Wi-Fi
- A Railway project with one web service and one Storage Bucket

The site uses a single shared password. Keep the Railway bucket private; no public bucket or inbound access to the Pi is needed. Confirm that the camera placement and recording are approved at work.

## 1. Test the camera

In Raspberry Pi Imager, choose **Raspberry Pi OS Lite (64-bit)** for the Pi 4. Use Imager's customisation screen to set your username, Wi-Fi, time zone, and SSH access before writing the microSD card. On the newly booted Pi, test the camera:

```sh
rpicam-hello --list-cameras
rpicam-still -o test.jpg
```

If the first command finds no camera, power off the Pi and check the ribbon cable at both ends. The camera must be attached to the CSI port. On older Raspberry Pi OS releases the tools may be named `libcamera-hello` and `libcamera-still`; a current OS is recommended.

## 2. Deploy the website on Railway

1. Create a Railway project and deploy this repository as a service. Railway will use the included `Dockerfile`.
2. Add a **Storage Bucket** to the project. Copy its endpoint, bucket name, access key, and secret key into the service variables below. Railway's bucket variable references can keep these in sync.
3. Set these variables on the web service:

   | Variable | Value |
   | --- | --- |
   | `SITE_PASSWORD` | A long, unique password for the website |
   | `SESSION_SECRET` | A separate random string of at least 32 bytes |
   | `DEVICE_TOKEN` | A third random string of at least 32 bytes, shared with the Pi |
   | `BUCKET_ENDPOINT` | Bucket S3 endpoint |
   | `BUCKET_NAME` | Bucket name |
   | `BUCKET_ACCESS_KEY_ID` | Bucket access key ID |
   | `BUCKET_SECRET_ACCESS_KEY` | Bucket secret access key |
   | `BUCKET_REGION` | Bucket region, or `auto` if Railway supplies no region |
   | `BUCKET_URL_STYLE` | `virtual` for new buckets; use `path` only if the bucket's Credentials tab says path style |

4. Generate a Railway public domain for the service and set its health-check path to `/health`.
5. Open the domain over HTTPS and sign in with `SITE_PASSWORD`.

Generate each secret independently. On a computer with Node.js, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` prints one suitable value. Never commit real secrets to Git.

Railway service storage is temporary between deployments. Set all bucket variables so the archive persists. The `data/` folder is for local development only.

## 3. Install the Pi agent

Copy this repository to `/home/YOUR_PI_USERNAME/officecam` on the Pi, replacing the placeholder with your real username. Then:

```sh
sudo apt update
sudo apt install -y python3-picamera2 python3-pil
sudo nano /etc/officecam.env
```

Put these lines in `/etc/officecam.env`:

```text
RAILWAY_URL=https://officecam-web-production.up.railway.app
DEVICE_TOKEN=THE-SAME-DEVICE-TOKEN-AS-RAILWAY
```

Protect the file and install the service:

```sh
sudo chmod 600 /etc/officecam.env
sed "s/YOUR_PI_USERNAME/$USER/g" pi/officecam.service.example | sudo tee /etc/systemd/system/officecam.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now officecam
sudo systemctl status officecam
```

Check `journalctl -u officecam -f` if the camera does not appear. The Pi stores photos in `~/officecam-data/queue` until Railway confirms each upload, then removes the queued copy. A capture made while Wi-Fi is down will upload when the connection returns. A powered-off Pi cannot take the missed hourly photos.

## Using the website

- **Live view:** the browser requests a new image about every 1.5 seconds. The Pi sends frames only when a viewer is active. Allow a few seconds after opening the page for the first frame.
- **Hourly photos:** captures use UTC hour slots so daylight-saving changes cannot create duplicate names. The dashboard shows the latest eight photos for the selected period; click one to open the original.
- **Time-lapse:** choose a month or **All time**, then click **Prepare video**. The first preparation can take a few minutes. The prepared MP4 is cached in the bucket. A new hourly photo makes a new version available on the next request. Each JPEG is exactly one frame at 24 fps.

An all-time export can become slow and expensive after many years. Monthly videos remain a practical way to watch an indefinitely growing archive. Set a Railway usage alert and back up the bucket regularly if the photos must survive account loss or accidental deletion.

## Local development

Set `SITE_PASSWORD`, `SESSION_SECRET`, and `DEVICE_TOKEN`, then run `node server.js`. Without `BUCKET_NAME`, files go into `data/`. The Pi can only use an HTTPS Railway URL, or `http://localhost:PORT` for local testing. The live capture code requires a Pi camera and is not run on a desktop.
