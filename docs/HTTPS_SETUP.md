# HTTPS + network setup (Windows PC host)

WebXR only works in a secure context, so the Quest must load the page over
HTTPS even on a private network. We use a self-signed cert for the host PC's
IP and accept it once in the Quest browser.

## 0. Network: use the PC's Mobile Hotspot

Campus/enterprise Wi-Fi (e.g. AUI) isolates clients, so the Quest can't reach
the PC over it. Skip the fight entirely:

1. Windows Settings → **Network & internet → Mobile hotspot** → On.
   (Band 5 GHz if offered — better tracking-free latency.)
2. Connect the **Quest** to that hotspot.
3. The PC's IP on the hotspot is normally **192.168.137.1** — confirm with
   `ipconfig` (look for the "Local Area Connection\* (Hotspot)" adapter).

## 1. On the PC — generate the cert (once per IP)

In **Git Bash** (openssl ships with Git for Windows):

```bash
./scripts/gen_cert.sh 192.168.137.1
```

This writes `server/certs/cert.pem` and `key.pem` with the IP baked in as a
subjectAltName. The hotspot IP is stable across reboots, so this is usually a
one-time step.

## 2. On the PC — run everything

```powershell
pip install -r server/requirements.txt   # once
python server/run.py                     # static https :8443 + wss :8765 + serial
```

Plug the V5 brain into USB; the server auto-detects it (VEX vendor ID) and
keeps retrying if it's unplugged. First run: allow Python through the Windows
Firewall prompt (or it will silently block the Quest).

## 3. On the Quest — accept the cert (one-time per cert)

1. Open the **Meta Quest Browser** and go to `https://192.168.137.1:8443`.
2. You'll get a privacy warning ("Your connection is not private",
   `NET::ERR_CERT_AUTHORITY_INVALID`). Tap **Advanced**, then
   **Proceed (unsafe)**. Expected for a self-signed cert.
3. The page loads. The acceptance is remembered per host:port until the cert
   changes or browser data is cleared.

## 4. On the Quest — accept the cert for the WebSocket port too

The `wss://` bridge runs on a **different port** (8765) with the same cert,
and the browser silently refuses the socket until that port has been accepted:

- Visit `https://192.168.137.1:8765` directly. You should see
  "WS bridge OK — cert accepted for this port." after the same
  Advanced → Proceed dance.
- Reload the app page; the HUD should show `WS connected`.

## Troubleshooting

- **"Enter AR" stays disabled / "not a secure context"** — you loaded the page
  over `http://` or via an IP the cert doesn't cover. Use
  `https://<the exact IP you generated the cert for>:8443`.
- **Page never loads at all** — Windows Firewall is blocking Python, or the
  Quest is on the campus Wi-Fi instead of the hotspot.
- **Page loads, HUD says WS retrying** — you skipped step 4, or the firewall
  allows 8443 but not 8765.
- **HUD says "V5 not connected"** — USB cable/port; check Device Manager for
  two "VEX Robotics" COM ports; try `python server/run.py --serial COMx` with
  the higher-numbered one.
