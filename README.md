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
- VEX V5 brain: shoulder motor **PORT12** (36:1, reversed), elbow motor
  **PORT20** (18:1), gripper motor **PORT11** (36:1), external gear ratio
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
