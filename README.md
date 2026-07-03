# Quest → VEX V5 Teleoperation with Digital Twin

Draw with a 2-link planar VEX V5 arm by moving a Meta Quest 3S controller in
passthrough AR. A Three.js digital twin in the headset mirrors the real arm
from encoder telemetry (translucent ghost = commanded, solid = actual).

```
Quest (WebXR, AR) ──wss──▶ Raspberry Pi (Python) ──IK──serial──▶ VEX V5 ──▶ motors
        ▲                                                            │
        └────────────── encoder telemetry ◀──────────────────────────┘
```

- `CLAUDE.md` — project state, milestone tracker, conventions (start here)
- `PROTOCOL.md` — WebSocket message formats
- `docs/HTTPS_SETUP.md` — self-signed cert flow for the Quest
- `HANDOFF.md` — continuation prompt if switching to a smaller Claude model

## Milestones

1. **WebXR readout** — AR page shows controller X/Z + trigger *(current)*
2. WebSocket streaming to a Pi script that prints poses
3. Pi IK + serial to the V5
4. Calibration, workspace clamp, smoothing, pen control
5. Digital twin with telemetry return path

## Milestone 1 — test procedure

On the Pi (needs Python 3 and openssl, both preinstalled on Raspberry Pi OS):

```bash
hostname -I                        # get the Pi's LAN IP
./scripts/gen_cert.sh <PI_IP>      # one-time self-signed cert
python3 pi/serve_https.py          # serves the page on :8443
```

On the Quest 3S (same Wi-Fi):

1. Quest Browser → `https://<PI_IP>:8443` → accept the cert warning
   (Advanced → Proceed). Details in `docs/HTTPS_SETUP.md`.
2. Tap **Enter AR**.

**Pass criteria:** passthrough view with a floating dark HUD panel showing
`R x +0.123 z -0.456` style readouts for each tracked controller, trigger
state/value updating live, and a small sphere glued to each controller that
turns red while its trigger is held. Numbers are meters in headset space
(x = right, z = toward you); they'll be mapped to the arm workspace in M4.

No internet on the LAN? The page pulls Three.js from a CDN — if the Quest has
no internet, download `three.module.js` (v0.160.0) into `quest/js/vendor/` and
point the import map in `quest/index.html` at `./js/vendor/three.module.js`.
