# HTTPS for WebXR — self-signed cert flow

WebXR only works in a secure context, so the Quest must load the page over
HTTPS even on your LAN. We use a self-signed cert for the Pi's IP address and
accept it once in the Quest browser.

## 1. On the Pi — generate the cert

```bash
hostname -I                      # note the Pi's LAN IP, e.g. 192.168.1.42
./scripts/gen_cert.sh 192.168.1.42
```

This writes `pi/certs/cert.pem` and `pi/certs/key.pem` with the IP baked in as
a subjectAltName. **Regenerate whenever the Pi's IP changes** — better: give
the Pi a DHCP reservation / static IP in your router so it never changes.

## 2. On the Pi — serve the page

```bash
python3 pi/serve_https.py        # https on port 8443
```

## 3. On the Quest — accept the cert (one-time per cert)

1. Open the **Meta Quest Browser** and go to `https://<PI_IP>:8443`.
2. You'll get a privacy warning ("Your connection is not private",
   `NET::ERR_CERT_AUTHORITY_INVALID`). Tap **Advanced**, then
   **Proceed to <PI_IP> (unsafe)**. This is expected for a self-signed cert.
3. The page loads. The acceptance is remembered per host:port until the cert
   changes or browser data is cleared.

## 4. WebSocket port needs its own acceptance (matters from Milestone 2)

The `wss://` server runs on a **different port** (8765) with the same cert,
and the browser will silently refuse the socket until that port's cert has
been accepted too. One-time fix, per cert:

- In the Quest Browser, visit `https://<PI_IP>:8765` directly.
- You'll get the same warning → Advanced → Proceed. (The page itself will look
  broken or empty — that's fine, only the cert acceptance matters.)
- Now `wss://<PI_IP>:8765` connections from the WebXR page will work.

## Troubleshooting

- **"Enter AR" button stays disabled / "not a secure context"** — you loaded
  the page over `http://` or via a hostname the cert doesn't cover. Use
  `https://<the exact IP you generated the cert for>:8443`.
- **Worked yesterday, broken today** — the Pi probably got a new IP from DHCP.
  Check `hostname -I`, regenerate the cert, re-accept on the Quest.
- **WebSocket never connects but the page loads (M2+)** — you skipped step 4.
