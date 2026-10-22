# Quest → V5 Teleoperation with Digital Twin

Teleoperate a 2-link planar drawing arm (VEX V5) from a Meta Quest 3S controller,
with a Three.js digital twin mirroring real encoder state back into the headset.

## READ THIS FIRST (every new session)

1. Check **Milestone tracker** below — it is the single source of truth for
   project state. Everything is *built*; nothing is *hardware-confirmed* yet.
   Do not build new features on top of unconfirmed ones without the user's
   go-ahead; debugging what exists is always fine.
2. When the user confirms something works on real hardware, update the tracker
   here AND regenerate `HANDOFF.md` (a ready-to-paste continuation prompt for
   a smaller model).
3. Any change to message formats must be mirrored in `PROTOCOL.md` in the
   same commit/edit batch.
4. If the user's message is a *new request* unrelated to the current milestone
   (a question, a bug on already-shipped code, a design change), handle it —
   but do not silently advance the milestone tracker while doing so.

## Milestone tracker

> CURRENT: **all milestones built (M6 gripper added 2026-10-22) — awaiting
> first hardware test**

- [x] M0 — Repo structure, CLAUDE.md, PROTOCOL.md, HTTPS cert flow
- [ ] M1 — WebXR immersive-ar page, controller readout (built ✅ / confirmed ❌)
- [ ] M2 — WebSocket streaming Quest → host (built ✅ / confirmed ❌)
- [ ] M3 — Host → V5 serial; IK runs ON the V5 (built ✅ / confirmed ❌)
- [ ] M4 — Fixed drawing panel, EMA smoothing, grip flag (built ✅ / confirmed ❌)
- [ ] M5 — Digital twin + telemetry return path (built ✅ / confirmed ❌)
- [ ] M6 — Gripper end effector, trigger-driven (built ✅ / confirmed ❌)

Suggested first-test order: M1 page alone → WS connect (`--no-serial`) →
serial with V5 on blocks (motors free) → arm follows the hand → twin accuracy
→ gripper last, and bench it with the arm motors unpowered first so a bad
`GRIP_*` constant can't swing the arm while you watch the jaws.

## Key design facts (learned from the user's khatt-bot code — don't re-ask)

- **The IK runs on the V5 brain**, not the host. `v5/main.py` (deploy with
  VEXcode) contains the user's proven Jacobian IK, P velocity loop, gear ratio
  (84/12), kill/reset bumper switches — copied from the user's khatt-bot
  project (original lives in their khatt-bot GitHub repo; local copy deleted
  2026-07-07 after absorbing it).
- The host just forwards normalized coords over USB serial:
  `"u,v,grip\n"` at ≤25 Hz, 115200 baud. Field-for-field the same wire format
  as the user's old pygame project (the third field was `pen` there), so the
  old V5 program also still works (minus telemetry and the gripper).
- **L1 = 20.5 cm, L2 = 30.5 cm**, workspace lateral ±10.5 cm × depth 18–48 cm
  (values from the V5 program; older files said 21.5/28 — if the twin looks
  wrong, ask the user to re-measure).
- Telemetry is the one V5-side addition: `"E,q1,q2,c1,c2\n"` at 20 Hz
  (measured & commanded arm-frame degrees, gear ratio divided out).
- Motors: shoulder PORT1 (36:1, reversed), elbow PORT4 (18:1), **gripper
  PORT2 (36:1)** — added 2026-10-22. Gripper travel is **user-measured**:
  fully open = 0 (the startup pose), fully closed = **-237 motor degrees**.
  All in `GRIP_*` at the top of `v5/main.py`. Still unconfirmed: the *port*
  (PORT2 was assumed) and the torque percentages (set conservatively — see
  below).
- Gripper squeeze torque is halved vs an 18:1 build because the 36:1 cartridge
  roughly doubles output torque per percent. Biased gentle on purpose: a weak
  grip drops the object, an overstrong one strips the gripper. Raise
  `GRIP_TORQUE_PCT` if objects slip; don't raise it speculatively.
- Closing *direction* is the sign of `GRIP_CLOSED_DEG`, not `GRIP_REVERSED` —
  flipping both cancels out. Only touch `GRIP_REVERSED` if the motor is
  mounted mirrored.
- The gripper **replaced the pen** end to end; there is no pen actuator and no
  pen flag any more (protocol v0.3 renamed `pen` → `grip`). The old project's
  pen servo was on Pi GPIO and is gone.
- The gripper program takes wherever the jaws sit at startup as "fully open"
  (it calls `reset_position()`), so **start the V5 program with the jaws open**.

## Hardware / network facts

- Meta Quest 3S — Meta Quest Browser, WebXR `immersive-ar` (passthrough). HTTPS required.
- **Host = the user's Windows 11 PC** (a Pi works identically, not needed).
  Runs `server/run.py`: HTTPS static server (8443) + WSS bridge (8765) +
  USB serial to the V5 (auto-detected by VEX vendor ID 0x2888, user port).
- Network: campus Wi-Fi isolates clients → use the PC's **Mobile Hotspot**
  (PC IP usually `192.168.137.1`); Quest connects to it. See docs/HTTPS_SETUP.md.
- VEX V5 Brain over USB. 2 smart motors (shoulder q1, elbow q2 relative).
  Arm is horizontal planar.

## Architecture

```
Quest controller ──WebXR page (quest/)──wss:8765──▶ PC server/run.py ──"u,v,grip"──serial──▶ V5 (IK + P-loop) ──▶ motors + gripper
Quest twin (ghost+solid) ◀──wss "tm" ◀── PC ◀──"E,q1,q2,c1,c2"──serial ◀── V5 encoders
```

## Conventions (do not drift from these)

- **Coordinates:** WebXR is y-up; the horizontal plane is X/Z. The Quest sends
  raw X/Z in **meters** always, plus `u,v ∈ [0,1]` = position inside the fixed
  drawing panel (workspace proportions × PANEL_SCALE, placed with A; no
  calibration; u = depth, v = lateral). The host applies SWAP_UV/FLIP_U/FLIP_V
  (top of server/run.py — physical-orientation tuning, user-verified on
  hardware) then forwards; the V5's `normalized_to_workspace()` maps to arm cm
  inside the reachable annulus — no host-side clamp needed. Twin orientation:
  TWIN_Q_SIGN / TWIN_YAW_DEG in quest/js/app.js, left stick rotates live.
- **Angles:** degrees over the wire, arm frame (q1 at shoulder, q2 relative to
  link 1), gear ratio divided out.
- **Rates:** Quest sends ~25 Hz (EMA-smoothed on the Quest). Host acts on the
  **latest** pose only (per-connection `s` sequence numbers). V5 telemetry 20 Hz.
- **Gripper:** trigger pressed = jaws closed = `1`. If poses go stale
  (`POSE_STALE_S`, 1 s) the host **freezes** the grip value instead of zeroing
  it — never auto-open, because that drops the payload. Same reasoning applies
  to pause (X) and the kill switch, which both hold the jaws shut.
- Messages: compact single-letter-keyed JSON, one per WebSocket text frame.
  Full schema in `PROTOCOL.md` (including the serial framing).
- Quest page is plain ES modules + Three.js vendored locally
  (`quest/js/vendor/three.module.js`, v0.160.0, wired via the import map in
  `quest/index.html`) so no internet is needed. No build step, ever.
- `websockets` Python lib pinned `<13` (run.py uses the legacy
  `process_request` signature).

## Repo layout

```
quest/            WebXR client (static, no build step)
  index.html      entry + import map + DOM overlay
  js/app.js       AR session, HUD, WS client, calibration, digital twin
server/           everything that runs on the host PC (was pi/)
  run.py          ONE command: HTTPS static + WSS bridge + V5 serial
  certs/          self-signed cert.pem/key.pem (gitignored) — scripts/gen_cert.sh
  requirements.txt
v5/main.py        VEXcode V5 Python program (user's IK + telemetry) — deploy via VEXcode
scripts/gen_cert.sh   self-signed cert for the host IP (run in Git Bash)
docs/HTTPS_SETUP.md   hotspot + cert flow + Quest acceptance (both ports!)
PROTOCOL.md       wire format: WS messages AND serial framing
HANDOFF.md        ready-to-paste prompt to continue on a smaller model
```

## How to run

```bash
./scripts/gen_cert.sh 192.168.137.1      # once (Git Bash); hotspot IP
pip install -r server/requirements.txt   # once
python server/run.py                     # everything (add --no-serial to test without V5)
```
Deploy `v5/main.py` to the brain from VEXcode and start it **with the gripper
jaws open** (startup pose = fully open). On the Quest (connected to the PC
hotspot): accept the cert at `https://<PC_IP>:8443` AND `https://<PC_IP>:8765`,
then open the first URL → Enter AR → the panel is live immediately (no
calibration) → move your hand, squeeze the trigger to grip.
Full walkthrough in docs/HTTPS_SETUP.md.

## Usage-limit / model handoff rule

The user wants to be able to continue on a cheaper model when nearing usage
limits. `HANDOFF.md` must always contain a current, self-contained continuation
prompt. Refresh it: (a) whenever a milestone's status changes, (b) whenever the
user asks ("update the handoff"), (c) before ending any session where
significant undocumented decisions were made. The prompt must tell the smaller
model to read this file first and must state exactly what is built, what is
hardware-confirmed, and what the immediate next step is.
