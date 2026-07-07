# Quest → VEX V5 Teleoperation with Digital Twin

Draw with a 2-link planar VEX V5 arm by moving a Meta Quest 3S controller in
passthrough AR. A Three.js digital twin floats in the headset and mirrors the
real arm from encoder telemetry — translucent ghost = commanded pose, solid
arm = what the encoders actually report, green trail = the pen path.

```
Quest controller ──WebXR page──wss:8765──▶ PC  server/run.py ──"u,v,pen"──USB serial──▶ V5 brain (IK + control) ──▶ motors
Quest digital twin ◀───wss "tm" msgs────── PC ◀──────"E,q1,q2,c1,c2"──────USB serial◀── V5 encoders
```

There is **no Raspberry Pi and no build step**: your Windows PC hosts a static
HTTPS page and a WebSocket↔serial bridge; the inverse kinematics runs on the
V5 brain itself (`v5/main.py`, deployed once from VEXcode).

## Documentation map

| file | what's in it |
|------|--------------|
| `README.md` (this) | setup, usage, how it works |
| `docs/HTTPS_SETUP.md` | network + certificate walkthrough, troubleshooting |
| `PROTOCOL.md` | every message format: WebSocket JSON and serial framing |
| `CLAUDE.md` | project state / milestone tracker (source of truth), conventions |
| `HANDOFF.md` | continuation prompt for resuming with a smaller Claude model |

## Hardware

- Meta Quest 3S (Meta Quest Browser — WebXR `immersive-ar`)
- Windows PC (the host) with a USB cable to the V5
- VEX V5 brain: shoulder motor PORT1 (36:1, reversed), elbow motor PORT4
  (18:1), external gear ratio 84:12, links L1 = 20.5 cm, L2 = 30.5 cm,
  kill switch on 3-wire port A, reset switch on port B
- Workspace: lateral ±10.5 cm × depth 18–48 cm rectangle (set in `v5/main.py`)

## One-time setup

1. **Network.** Campus/enterprise Wi-Fi blocks device-to-device traffic, so:
   Windows Settings → **Mobile hotspot** → On, and connect the **Quest** to
   that hotspot. The PC's hotspot IP is normally `192.168.137.1` (`ipconfig`).
2. **Certificate** (WebXR requires HTTPS). In Git Bash:
   `./scripts/gen_cert.sh 192.168.137.1`
3. **Python deps:** `pip install -r server/requirements.txt`
4. **V5 program:** open `v5/main.py` in VEXcode V5, download it to the brain.
5. **Quest, once per cert:** in the Quest Browser visit
   `https://192.168.137.1:8443` → Advanced → Proceed, **and**
   `https://192.168.137.1:8765` → Advanced → Proceed (the WebSocket port needs
   its own acceptance — you should see "WS bridge OK").

## Every session

```powershell
python server/run.py        # on the PC: web page + WebSocket bridge + serial
```
(Options: `--serial COM5` to pin the port, `--no-serial` to test without the
V5, `-v` to log every pose.)

Then: plug in the V5 and start its program → on the Quest open
`https://192.168.137.1:8443` → **Enter AR**.

### In the headset

| action | effect |
|--------|--------|
| Hold **right controller** at the **near-left** corner of where you want the drawing area, press **A** | set corner A |
| Hold it at the **far-right** corner, press **B** | set corner B — arm is now live |
| Move the right controller inside that rectangle | arm follows (25 Hz) |
| **Right trigger** | pen down (flag is transported; no pen actuator fitted yet) |
| **Left grip** (hold) | grab/reposition the digital twin |
| **Right thumbstick click** | clear the pen trail on the twin |

**Controller-free (bare hands):** hand tracking works too — the right **index
fingertip** is the cursor and a right **thumb–index pinch** = pen down.
Left-hand pinches replace the buttons: **index** = corner A, **middle** =
corner B, **ring** (hold) = move the twin, **pinky** = clear the trail.
(Quest Settings → Movement tracking → Hand tracking must be on; put the
controllers down or let them sleep and your hands appear automatically.)

The HUD shows WebSocket/V5 connection state, calibration status, live `u,v`,
and the twin's current encoder angles. The physical kill switch (bumper A) and
reset switch (bumper B) on the robot still work exactly as in the old project.

## How it works

1. `quest/js/app.js` reads the right controller pose every frame, smooths X/Z
   with an EMA, converts it to `u,v ∈ [0,1]` inside your calibrated rectangle,
   and sends compact JSON over `wss://` at 25 Hz (latest-wins, sequence
   numbered).
2. `server/run.py` forwards the newest `u,v,pen` to the V5 over USB serial as
   a `"u,v,pen\n"` line (same wire format as the original khatt-bot pygame
   project) and raises the pen if the stream goes stale for 500 ms. It
   auto-detects the V5's COM port by USB vendor ID and reconnects forever.
3. On the brain, `v5/main.py` maps `u,v` into the workspace rectangle, solves
   IK (Jacobian iteration), and drives both motors with a proportional
   velocity loop — plus it prints `E,q1,q2,c1,c2` telemetry at 20 Hz.
4. The bridge relays telemetry to the Quest as `tm` messages; the twin applies
   the angles through a scene-graph FK chain (same L1/L2, sent in a `cfg`
   message so the page never hardcodes geometry).

Full formats and reliability rules: `PROTOCOL.md`.

## Status / testing

Everything is built; nothing has been confirmed on real hardware yet. See the
milestone tracker in `CLAUDE.md` and test in this order: page alone → WS
(`--no-serial`) → V5 with the arm free to move safely → calibrated control →
twin accuracy.

No internet on the hotspot? The page pulls Three.js from a CDN — download
`three.module.js` (v0.160.0) into `quest/js/vendor/` and point the import map
in `quest/index.html` at it.
