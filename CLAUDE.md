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
- [ ] M7 — Live 360 camera world for remote operation, `?mode=vr`
      (built ✅ / **camera pipeline confirmed on hardware ✅** /
      merged page confirmed in headset ❌)

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
- **L1 = 20.5 cm, L2 = 30.5 cm**. Workspace is **lateral ±24 cm × depth
  26–41 cm** (48 wide × 15 deep), set 2026-10-22 from the **measured joint
  limits**, not from link lengths.
- **Joint limits (user-measured, trust them): ±900 MOTOR degrees on each
  joint = ±128.6° at the joint** after the 84/12 external ratio. Zero is the
  **fully extended** startup pose — `reset_position()` runs at startup, so
  **the arm must be started straight out along the depth axis**, exactly as
  the jaws must be started open. `JOINT_LIMIT_DEG` in `v5/main.py`.
- The elbow limit is what binds: `|q2| ≤ 128.6°` means the arm **cannot fold
  tighter than r = 23.9 cm**, so the inner boundary is 23.9, NOT the 10.0
  that `|L2−L1|` suggests. Both earlier workspaces put their near edge at
  depth 16–18, i.e. *inside that hole* — the solver would "reach" those
  points with ~151° of elbow and drive the motor into its stop.
- A **square is a bad shape** in this ring: largest square is 20×20 = 400 cm²
  versus 744 cm² for the 48×15 rectangle. Don't "tidy" it back to a square.
- The Jacobian solver is pure geometry and knows nothing about stops, so it
  now rejects out-of-limit solutions and keeps restarting to find the other
  elbow branch. Never remove that check.
- Telemetry is the one V5-side addition: `"E,q1,q2,c1,c2\n"` at 20 Hz
  (measured & commanded arm-frame degrees, gear ratio divided out).
- Motors, **all three ports user-confirmed 2026-10-22**: shoulder **PORT11**
  (36:1, reversed), elbow **PORT20** (18:1), gripper **PORT12** (36:1).
  Shoulder/gripper were briefly recorded swapped and corrected the same day;
  both are 36:1, so only the port numbers moved, not the gearing.
  These supersede the PORT1/PORT4 that came from the khatt-bot program — that
  code predates the current wiring, so don't "restore" it. Gear cartridges are
  still khatt-bot-derived and were *not* re-confirmed: if a joint runs at the
  wrong speed, check the cartridge colour (36:1 red, 18:1 green) before
  touching the control gains.
- Gripper travel is **user-measured**: fully open = 0 (the startup pose),
  fully closed = **-237 motor degrees**. All in `GRIP_*` at the top of
  `v5/main.py`. Still unconfirmed: the torque percentages (set conservatively
  — see below).
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

- Meta Quest 3S — Meta Quest Browser. HTTPS required. **Two world modes**,
  chosen with `?mode=` on the page URL; only one immersive session can run at
  a time, and an opaque 360 sphere covers passthrough completely, so this is a
  choice and not a combination:
  - `?mode=ar` (default) — `immersive-ar` passthrough, for when you are in the
    room with the robot. Sharper, stereo, needs no camera.
  - `?mode=vr` — `immersive-vr` with a live Insta360 X5 feed as the world, for
    operating from elsewhere. Panel/twin/HUD/controls are identical.
- **Host = the user's Windows 11 PC** (a Pi works identically, not needed).
  Runs `server/run.py`: HTTPS static server (8443, which also proxies WHEP) +
  WSS bridge (8765) + USB serial to the V5 (VEX vendor ID 0x2888, user port).
- Network: campus Wi-Fi isolates clients → use the PC's **Mobile Hotspot**
  (PC IP usually `192.168.137.1`); Quest connects to it. See docs/HTTPS_SETUP.md.
  `scripts/gen_cert.sh` takes several IPs so one cert covers hotspot + Wi-Fi.
- VEX V5 Brain over USB. 2 smart motors (shoulder q1, elbow q2 relative).
  Arm is horizontal planar.
- **Insta360 X5** on USB (optional, `?mode=vr` only). Pick *Webcam Mode* on the
  camera screen; it re-asks on every replug. DirectShow name `Insta360 X5`,
  MJPEG only, two formats: 2880×1440@30 (360 equirect — use this) and
  1920×1080@30 (Reframe, a *flat* view this client would wrongly wrap onto a
  sphere). `bin/mediamtx.exe` + ffmpeg are driven by `start_camera.ps1`.

## Architecture

```
Quest controller ──WebXR page (quest/)──wss:8765──▶ PC server/run.py ──"u,v,grip"──serial──▶ V5 (IK + P-loop) ──▶ motors + gripper
Quest twin (ghost+solid) ◀──wss "tm" ◀── PC ◀──"E,q1,q2,c1,c2"──serial ◀── V5 encoders

?mode=vr only — one-way video, carries no robot data:
Insta360 X5 ──USB──▶ ffmpeg ──rtsp──▶ mediamtx ──whep via run.py:8443──▶ Quest sphere
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
- **Twin:** links are extruded rounded beams, joints are cylinders on the
  rotation axis, and the end effector is a parallel-jaw gripper whose jaws
  slide in local Z (so they close horizontally — both joints turn about
  vertical axes, so the whole assembly is parallel to the ground by
  construction). The V5 reports only the commanded open/shut state, never a
  jaw angle, so the solid twin **eases** toward it (`jawT`) while the ghost
  snaps; a hard jump reads as a glitch. The carry trail follows `grasp` —
  where the pads meet — not the wrist the IK actually positions.
- **Rates:** Quest sends ~25 Hz (EMA-smoothed on the Quest). Host acts on the
  **latest** pose only (per-connection `s` sequence numbers). V5 telemetry 20 Hz.
- **Safe start (do not "helpfully" remove):** the client enters every session
  **paused**, so the arm cannot move until the user presses X. Paused
  withholds `u,v` entirely, so the host receives no actionable pose and emits
  no serial frame at all. Entering live meant the panel landed wherever the
  user happened to stand and the arm lunged to meet it.
- **Mode switch:** Y on the left controller ends the session and reloads with
  the other `?mode=`. A headset runs one immersive session at a time and its
  type cannot change in place, so a reload is the mechanism, not laziness.
- **Controller models** are procedural (`makeControllerModel`), with a lit dot
  per button so the floating card's labels map to something visible.
  `XRControllerModelFactory` is NOT usable here — it fetches glTF from a CDN
  and this rig runs on an offline hotspot.
- **Gripper:** trigger pressed = jaws closed = `1`. If poses go stale
  (`POSE_STALE_S`, 1 s) the host **freezes** the grip value instead of zeroing
  it — never auto-open, because that drops the payload. Same reasoning applies
  to pause (X) and the kill switch, which both hold the jaws shut.
- Messages: compact single-letter-keyed JSON, one per WebSocket text frame.
  Full schema in `PROTOCOL.md` (including the serial framing).
- Quest page is plain ES modules + Three.js vendored locally
  (`quest/js/vendor/three.module.js`, v0.160.0, wired via the import map in
  `quest/index.html`) so no internet is needed. No build step, ever.
- **360 camera (`?mode=vr`)** lives entirely in `quest/js/pano.js` +
  `quest/js/whep.js`; `app.js` only picks the session type and calls into it,
  so AR behaviour is unchanged by anything the camera does. Facts worth not
  re-deriving:
  - WHEP is reverse-proxied through run.py's **own** port so the headset
    trusts ONE cert. A cross-origin fetch to a second self-signed cert fails
    with no interstitial — unacceptable inside a headset.
  - The camera's live ceiling is 2880×1440 ≈ **8 px/degree** vs the headset's
    ~20. Measured: our H.264 at 35 Mbit is transparent (47.4 dB PSNR) and
    Wi-Fi drops zero frames, so neither is the bottleneck — the camera
    downsamples 8K→2880×1440 internally. Don't chase bitrate.
  - It is **monoscopic**: the X5's lenses are back to back and share no
    baseline, so stereo depth is impossible in principle, not just unbuilt.
  - The camera far plane must exceed the sphere radius (500) or the world is
    clipped to nothing.
  - The pano sphere **follows the head position every frame**. The session
    uses a `local-floor` reference space, so the scene origin is on the
    FLOOR — leaving the sphere at the origin puts its centre ~1.6 m below
    your eyes and the horizon visibly sinks. Following is also the honest
    choice: moving your head does not move the remote camera, so the view
    from its optical centre must not change. `?anchor=world` pins it instead,
    for the (invented) parallax experiment with a small `?radius`.
  - Stand the camera **upright**: lying flat puts the lens stitch seam
    horizontally across the middle of your view.
- `websockets` Python lib pinned `<13` (run.py uses the legacy
  `process_request` signature).

## Repo layout

```
quest/            WebXR client (static, no build step)
  index.html      entry + import map + DOM overlay + mode links
  js/app.js       XR session, HUD, WS client, panel, digital twin
  js/pano.js      360 camera world (?mode=vr only) — sphere, zoom, reconnect
  js/whep.js      ~130-line WHEP client, no dependencies
server/           everything that runs on the host PC (was pi/)
  run.py          ONE command: HTTPS static + WHEP proxy + WSS bridge + V5 serial
  mediamtx.yml    RTSP in (loopback) → WebRTC out; everything else disabled
  certs/          self-signed cert.pem/key.pem (gitignored) — scripts/gen_cert.sh
  requirements.txt
bin/mediamtx.exe  v1.21.2 (gitignored, 55 MB) — github.com/bluenviron/mediamtx
v5/main.py        VEXcode V5 Python program (user's IK + telemetry) — deploy via VEXcode
start_camera.ps1  the 360 half: mediamtx + ffmpeg (-Test / -Probe / -AddFirewallRules)
scripts/gen_cert.sh   self-signed cert; takes SEVERAL IPs (run in Git Bash)
docs/HTTPS_SETUP.md   hotspot + cert flow + Quest acceptance (both ports!)
PROTOCOL.md       wire format: WS messages, serial framing AND the WHEP link
HANDOFF.md        ready-to-paste prompt to continue on a smaller model
```

## How to run

```bash
./scripts/gen_cert.sh 192.168.137.1 10.126.73.140   # once; list every IP you may serve from
pip install -r server/requirements.txt              # once
```
Then **one command, every time** — it also does the one-time chores itself,
each a no-op once done, so there is nothing else to remember:
```powershell
.\start_all.ps1            # or double-click start_all.bat
```
It adds the firewall rules if missing (one UAC prompt, first run only),
re-flashes V5 slot 3 only when `v5/main.py`'s hash differs from
`.v5_deployed`, then starts mediamtx + ffmpeg + run.py together. Ctrl+C
stops all three.
```powershell
.\start_all.ps1 -Test        # generated pattern instead of the camera
.\start_all.ps1 -NoCamera    # robot side only (old start_server.bat behaviour)
.\start_all.ps1 -NoSerial    # UI / twin testing with no V5
.\start_all.ps1 -Force       # kill stale holders of our ports from a previous run
.\start_all.ps1 -NoDeploy    # never touch the brain
.\start_all.ps1 -NoFirewall  # never prompt for elevation
```
The V5 program is uploaded but never auto-started: it takes the jaws' startup
position as "fully open", so you must open them and press Run on the brain.
`start_camera.ps1` still exists for camera-only debugging. Both launchers
dot-source `scripts/lib_launch.ps1`, which owns the ffmpeg argument list — it
lives in one place on purpose, since every value in it was measured.
Keep those scripts **pure ASCII**: PowerShell 5.1 reads BOM-less files as
ANSI, so a stray em-dash prints as mojibake.
Deploy `v5/main.py` to the brain from VEXcode and start it **with the gripper
jaws open** (startup pose = fully open). On the Quest (connected to the PC
hotspot): accept the cert at `https://<PC_IP>:8443` AND `https://<PC_IP>:8765`,
then open the first URL → Enter AR → the panel is live immediately (no
calibration) → move your hand, squeeze the trigger to grip.
Full walkthrough in docs/HTTPS_SETUP.md.

For the 360 world, additionally (second window):

```powershell
.\start_camera.ps1 -AddFirewallRules   # once, as administrator (UDP 8189!)
.\start_camera.ps1                     # -Test for a pattern with no camera
```
then open `https://<PC_IP>:8443/?mode=vr`. The HUD's `CAM` chip reports the
feed; a black world with `CAM live` means UDP 8189 is blocked.

## Usage-limit / model handoff rule

The user wants to be able to continue on a cheaper model when nearing usage
limits. `HANDOFF.md` must always contain a current, self-contained continuation
prompt. Refresh it: (a) whenever a milestone's status changes, (b) whenever the
user asks ("update the handoff"), (c) before ending any session where
significant undocumented decisions were made. The prompt must tell the smaller
model to read this file first and must state exactly what is built, what is
hardware-confirmed, and what the immediate next step is.
