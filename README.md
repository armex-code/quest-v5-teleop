# Quest → VEX V5 Teleoperation with Digital Twin

Drive a 2-link planar VEX V5 arm with a gripper end effector by moving a Meta
Quest 3S controller in passthrough AR. A Three.js digital twin floats in the
headset and mirrors the real arm from encoder telemetry — translucent ghost =
commanded pose, solid arm = what the encoders actually report, green trail =
the path travelled with the gripper closed.

```
Quest controller ──WebXR page──wss:8765──▶ PC  server/run.py ──"u,v,grip"──USB serial──▶ V5 brain (IK + control) ──▶ motors + gripper
Quest digital twin ◀───wss "tm" msgs────── PC ◀──────"E,q1,q2,c1,c2"──────USB serial◀── V5 encoders
```

There is **no Raspberry Pi and no build step**: your Windows PC hosts a static
HTTPS page and a WebSocket↔serial bridge; the inverse kinematics runs on the
V5 brain itself (`v5/main.py`, deployed once from VEXcode).

## Two world modes

The page takes a `?mode=` parameter. Panel, twin, HUD and every control are
identical in both — only what you see *around* them changes.

| mode | world | when |
|---|---|---|
| **`?mode=ar`** (default) | passthrough — the actual room | you are next to the robot. Sharper, stereo, no camera needed |
| **`?mode=vr`** | a live Insta360 X5 360° feed | operating from another room. Needs `start_camera.ps1` too |

Only one immersive session can run at a time, and an opaque 360 sphere covers
passthrough completely — so this is a choice, not a combination. If you are in
the same room as the arm, **use AR**: passthrough beats any camera on
resolution, depth and latency. The 360 feed earns its place the moment you
cannot see the robot.

```
?mode=vr only — one-way video, no robot data on this path:
Insta360 X5 ──USB──▶ ffmpeg ──rtsp──▶ mediamtx ──WHEP via run.py:8443──▶ Quest sphere
```

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
- VEX V5 brain: shoulder motor **PORT11** (36:1, reversed), elbow motor
  **PORT20** (18:1), gripper motor **PORT12** (36:1), external gear ratio
  84:12 on the arm, links L1 = 20.5 cm, L2 = 30.5 cm, kill switch on 3-wire
  port A, reset switch on port B
- Gripper travel is measured: fully open = 0, fully closed = **-237 motor
  degrees**, in the `GRIP_*` constants at the top of `v5/main.py`. Because the
  encoder is zeroed at startup, only that difference matters — always start the
  program with the jaws **open** (that pose becomes "open"). The squeeze torque
  percentages there are conservative first-run values, not measurements
- Workspace: lateral ±10.5 cm × depth 18–48 cm rectangle (set in `v5/main.py`)

## One-time setup

1. **Network.** Campus/enterprise Wi-Fi blocks device-to-device traffic, so:
   Windows Settings → **Mobile hotspot** → On, and connect the **Quest** to
   that hotspot. The PC's hotspot IP is normally `192.168.137.1` (`ipconfig`).
2. **Certificate** (WebXR requires HTTPS). In Git Bash — list every address
   you might serve from and one cert covers them all, so switching between the
   hotspot and normal Wi-Fi needs no regenerate and no re-accepting on the
   headset: `./scripts/gen_cert.sh 192.168.137.1 10.126.73.140`
3. **Python deps:** `pip install -r server/requirements.txt`
4. **V5 program:** open `v5/main.py` in VEXcode V5, download it to the brain.
5. **Quest, once per cert:** in the Quest Browser visit
   `https://192.168.137.1:8443` → Advanced → Proceed, **and**
   `https://192.168.137.1:8765` → Advanced → Proceed (the WebSocket port needs
   its own acceptance — you should see "WS bridge OK").

## Every session — one command

```powershell
.\start_all.ps1        # or double-click start_all.bat
```

That's the whole thing. It starts the web page, the WebSocket bridge, the V5
serial link, MediaMTX and ffmpeg together, and Ctrl+C stops all of them.

It also handles the setup chores itself, each a no-op once done, so there is
no separate first-run ritual:

- **Firewall rules**, if missing — one UAC prompt on the very first run.
  This matters more than it looks: **UDP 8189** carries the 360 video straight
  to the headset, bypassing the web server. Without it the page loads
  perfectly and the world stays black forever.
- **V5 upload** — re-flashes slot 3 only when `v5/main.py`'s hash differs from
  `.v5_deployed`, so editing the brain program needs no extra step and an
  unchanged one costs nothing.
- **Stale ports** — names whatever is still holding 8443/8765/8554/8889/8189
  from a previous run. `-Force` kills them.

```powershell
.\start_all.ps1 -Test        # generated pattern, no camera needed
.\start_all.ps1 -NoCamera    # robot side only
.\start_all.ps1 -NoSerial    # UI / twin testing with no V5
.\start_all.ps1 -Force       # clear leftovers from a previous run
.\start_all.ps1 -NoDeploy    # never touch the brain
.\start_all.ps1 -NoFirewall  # never prompt for elevation
```

Then: set the X5 to **Webcam Mode** on its own screen (it re-asks on every
replug), **open the gripper jaws and press Run on slot 3** on the brain, and
on the Quest open `https://192.168.137.1:8443` → **Enter**.

`start_camera.ps1` still exists for camera-only debugging (`-Probe` lists what
the camera offers), and `python server/run.py` still works on its own.

### In the headset

It starts **held** — the arm will not move until you press **X**. Place the
panel where you want it with **A** first.

**Y** swaps between passthrough and the 360 camera instantly, without leaving
the session. In the 360 world the right controller also gains **B** =
recentre the view on where you are looking, and **right stick ▲▼** = zoom.
Zoom magnifies without sharpening — WebXR does not let an app change the
field of view, so this is binoculars rather than a wider lens.

Camera placement is worth more than any setting: stand it **upright** (lying
flat puts the lens stitch seam horizontally across the middle of your view)
and **close to the arm** (at 50 cm the arm spans ~480 px; at 3 m, ~80 px).

### In the headset

No calibration: a gridded blue panel with a yellow border — the robot's
workspace rectangle, scaled ×1.5 — appears in front of you and is live
immediately.

| action | effect |
|--------|--------|
| Move the right controller over the panel | arm follows (25 Hz) |
| **Right trigger** | hold to close the gripper, release to open |
| **A** (right controller) | move the panel to the controller's position |
| **X** (left controller) | pause / resume teleop (arm *and* jaws hold as-is) |
| **Left grip** (hold) | grab/reposition the digital twin |
| **Left thumbstick ◄ ►** | rotate the twin to match the real robot on the table |
| **Right thumbstick click** | clear the carry trail on the twin |

Nothing in the stack ever opens the jaws by itself — not pause, not a Wi-Fi
dropout, not the kill switch. Only releasing the trigger opens them, so a
dropped connection can't become a dropped object.

Orientation tuning lives at the top of `server/run.py` (`SWAP_UV`, `FLIP_U`,
`FLIP_V`) and `quest/js/app.js` (`TWIN_Q_SIGN`) — one-line toggles if the arm
ever moves transposed or mirrored relative to your hand.

The in-headset HUD is a guided checklist: it shows PC/robot connection status,
then goes live. The gridded blue panel marks the reachable area with a white
cursor dot (red while the gripper is closed, grey while paused), and floating
cards above each controller label every button. The HUD footer carries the
twin's current encoder angles and live `u,v`. Input is controller-only.

The physical kill switch (bumper A) and reset switch (bumper B) on the robot
still work exactly as in the old project; kill brakes the arm and holds the
jaws where they are.

## How it works

1. `quest/js/app.js` reads the right controller pose every frame, smooths X/Z
   with an EMA, converts it to `u,v ∈ [0,1]` inside the floating panel, and
   sends compact JSON over `wss://` at 25 Hz (latest-wins, sequence numbered).
2. `server/run.py` forwards the newest `u,v,grip` to the V5 over USB serial as
   a `"u,v,grip\n"` line (same field layout as the original khatt-bot pygame
   project, where the third field was the pen) and, if the stream goes stale
   for 1 s, holds the last position and freezes the grip. It auto-detects the
   V5's COM port by USB vendor ID and reconnects forever.
3. On the brain, `v5/main.py` maps `u,v` into the workspace rectangle, solves
   IK (Jacobian iteration), and drives both arm motors with a proportional
   velocity loop. A separate thread runs the gripper: closing is a
   torque-limited move onto the object, and once motion stops the torque drops
   to a lower hold value so the motor isn't squeezing flat out for the whole
   carry. It also prints `E,q1,q2,c1,c2` telemetry at 20 Hz.
4. The bridge relays telemetry to the Quest as `tm` messages; the twin applies
   the angles through a scene-graph FK chain (same L1/L2, sent in a `cfg`
   message so the page never hardcodes geometry).

Full formats and reliability rules: `PROTOCOL.md`.

## Status / testing

Everything is built; nothing has been confirmed on real hardware yet. See the
milestone tracker in `CLAUDE.md` and test in this order: page alone → WS
(`--no-serial`) → V5 with the arm free to move safely → arm follows the hand →
twin accuracy → gripper. Bench the gripper with the arm motors unpowered
first, so a wrong `GRIP_*` constant can't swing the arm while you're watching
the jaws.

The system needs **no internet at all**: Three.js (v0.160.0) is vendored at
`quest/js/vendor/three.module.js`, so the hotspot only carries local
Quest↔PC traffic.
