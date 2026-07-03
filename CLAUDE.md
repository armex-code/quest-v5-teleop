# Quest → V5 Teleoperation with Digital Twin

Teleoperate a 2-link planar drawing arm (VEX V5) from a Meta Quest 3S controller,
with a Three.js digital twin mirroring real encoder state back into the headset.

## READ THIS FIRST (every new session)

1. Check **Milestone tracker** below — it is the single source of truth for
   project state. Never work on a milestone past `CURRENT` without the user
   explicitly confirming the current one **works on real hardware**.
2. When a milestone is confirmed, update the tracker here AND regenerate
   `HANDOFF.md` (a ready-to-paste continuation prompt for a smaller model).
3. Any change to message formats must be mirrored in `PROTOCOL.md` in the
   same commit/edit batch.
4. If the user's message is a *new request* unrelated to the current milestone
   (a question, a bug on already-shipped code, a design change), handle it —
   but do not silently advance the milestone tracker while doing so.

## Milestone tracker

> CURRENT: **Milestone 1 — built, awaiting hardware confirmation on Quest**

- [x] M0 — Repo structure, CLAUDE.md, PROTOCOL.md draft, HTTPS cert flow
- [ ] M1 — WebXR immersive-ar page shows controller X/Z + trigger state (built ✅ / hardware-confirmed ❌)
- [ ] M2 — WebSocket streaming Quest → Pi script that prints poses
- [ ] M3 — Pi-side IK + serial to V5 (integrate user's existing Python IK)
- [ ] M4 — Calibration (2-corner), workspace clamp, EMA smoothing, pen control
- [ ] M5 — Digital twin + telemetry return path (ghost = commanded, solid = encoders)

## Known unknowns — ASK THE USER when the milestone needs them

- `L1`, `L2` link lengths in cm (user wrote `[X]`/`[Y]` — placeholders). Needed by M3.
- The user's **working Python IK code** for this arm. Ask them to paste it or
  give a path at the start of M3. Do NOT rewrite IK from scratch; wrap theirs.
- The Pi↔V5 serial protocol from their prior pygame project (port, baud,
  message framing). Ask at M3.
- Pi's LAN IP (needed for cert generation and Quest URL).

## Hardware / network facts

- Meta Quest 3S — Meta Quest Browser, WebXR `immersive-ar` (passthrough). HTTPS required.
- Raspberry Pi on the same Wi-Fi as the Quest. Runs the HTTPS static server,
  the WebSocket server, IK, and serial to the V5.
- VEX V5 Brain over USB serial from the Pi. 2 smart motors (shoulder q1,
  elbow q2), 1 actuator for pen up/down. Arm is horizontal planar.

## Architecture

```
Quest controller pose ──WebXR page (quest/)──wss──▶ Pi server (pi/) ──IK──serial──▶ V5 ──▶ motors
Quest twin (ghost+solid) ◀──wss── telemetry ◀── Pi ◀── serial ◀── V5 encoder angles
```

## Conventions (do not drift from these)

- **Coordinates:** WebXR is y-up; the horizontal plane is X/Z. Quest sends raw
  X/Z in **meters**. After calibration (M4) the Quest also sends normalized
  workspace coords `u,v ∈ [0,1]`; the Pi maps those to arm-frame **cm** and
  clamps to the reachable annulus (|L1−L2| < r < L1+L2).
- **Angles:** degrees over the wire, floats, arm frame (q1 at shoulder, q2
  relative to link 1).
- **Rates:** Quest sends poses at ~25 Hz. Pi always acts on the **latest**
  pose only — drop anything stale (compare `s` sequence numbers).
- **Pen:** trigger pressed = pen down = `1`.
- Messages: compact single-letter-keyed JSON, one per WebSocket text frame.
  Full schema in `PROTOCOL.md`.
- Quest page is plain ES modules + Three.js from CDN (pinned version in the
  import map in `quest/index.html`). No build step, ever — the Quest loads it
  straight from the Pi.

## Repo layout

```
quest/            WebXR client (static, no build step)
  index.html      entry + import map + DOM overlay
  js/app.js       AR session, controller polling, HUD (M1); WS + twin later
pi/               everything that runs on the Raspberry Pi
  serve_https.py  static HTTPS server for quest/ (WebXR needs secure context)
  certs/          self-signed cert.pem/key.pem (gitignored) — see scripts/gen_cert.sh
  requirements.txt
scripts/gen_cert.sh   generate self-signed cert for the Pi's LAN IP
docs/HTTPS_SETUP.md   cert flow + how to accept it on the Quest browser
PROTOCOL.md       wire format (versioned draft; sections marked by milestone)
HANDOFF.md        ready-to-paste prompt to continue this project on a smaller model
```

## How to run (current milestone, M1)

On the Pi (or any machine on the same Wi-Fi):
```bash
./scripts/gen_cert.sh <PI_LAN_IP>        # once, or when the IP changes
python3 pi/serve_https.py                # serves quest/ at https://<PI_LAN_IP>:8443
```
On the Quest: open `https://<PI_LAN_IP>:8443` in the Quest Browser, accept the
cert warning (Advanced → Proceed), tap **Enter AR**. Expected: passthrough with
a floating HUD showing left/right controller X/Z and trigger state, and a small
sphere on each controller that turns red while its trigger is held.

## Usage-limit / model handoff rule

The user wants to be able to continue on a cheaper model when nearing usage
limits. `HANDOFF.md` must always contain a current, self-contained continuation
prompt. Refresh it: (a) whenever a milestone's status changes, (b) whenever the
user asks ("update the handoff"), (c) before ending any session where
significant undocumented decisions were made. The prompt must tell the smaller
model to read this file first and must state exactly what is built, what is
hardware-confirmed, and what the immediate next step is.
