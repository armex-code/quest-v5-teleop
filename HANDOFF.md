# Handoff prompt — paste into a new session on a smaller model

> Keep this file current: it must be regenerated whenever a milestone's status
> changes. Usage: start a new Claude Code session in this directory, run
> `/model sonnet` (or `haiku`), and paste everything below the line.
>
> Last regenerated 2026-10-22 (gripper end effector added, M6).

---

Continue an in-progress project. First read `CLAUDE.md` in this directory —
it has the architecture, all hardware facts, and the milestone tracker that is
the source of truth. Also skim `PROTOCOL.md`.

Quick context: a Meta Quest 3S (WebXR immersive-ar, Quest Browser) teleoperates
a VEX V5 2-link planar arm with a **gripper end effector**. Host is my
**Windows PC** (no Raspberry Pi): `server/run.py` serves the WebXR page over
HTTPS (:8443), bridges a WSS socket (:8765) to USB serial, and relays
telemetry back. **The IK runs on the V5 brain** (`v5/main.py`, my proven
Jacobian IK — never rewrite it). The Quest page (`quest/js/app.js`) shows a
fixed-proportion drawing panel (no calibration — the A button re-places it),
streams smoothed `u,v,grip` at 25 Hz, and renders a digital twin (solid arm =
encoder telemetry, ghost = commanded, green trail = path travelled with the
gripper closed). Right trigger held = jaws closed. Network = the PC's Windows
Mobile Hotspot (campus Wi-Fi isolates clients); cert flow in
`docs/HTTPS_SETUP.md` — the Quest must accept the self-signed cert on BOTH
ports 8443 and 8765.

Gripper specifics (added 2026-10-22, protocol v0.3 renamed `pen` → `grip`
everywhere; there is no pen actuator and no pen flag any more):
- Smart motor, all constants in `GRIP_*` at the top of `v5/main.py`. Travel is
  **measured, trust it**: 36:1 cartridge, fully open = 0, fully closed =
  `GRIP_CLOSED_DEG = -237` motor degrees. Still *unconfirmed*: only the torque
  percentages, which are deliberately gentle first-run values. If objects
  slip, raise `GRIP_HOLD_TORQUE_PCT` first (symptom: grips cleanly then drops
  the object ~0.3 s later); if the gripper strains, lower `GRIP_TORQUE_PCT`.
  Don't invent new travel numbers — ask me to re-measure.
- **Motor ports are shoulder PORT12, elbow PORT20, gripper PORT11**, all
  confirmed against the real robot 2026-10-22. The khatt-bot program this was
  derived from used PORT1/PORT4; that is stale wiring, do not restore it. The
  gear cartridges are still khatt-bot values and were not re-confirmed — if a
  joint moves at the wrong speed, suspect the cartridge before the gains.
- Closing direction is the SIGN of `GRIP_CLOSED_DEG`, not `GRIP_REVERSED`.
  Flipping both cancels out.
- The startup pose is taken as "fully open" (`reset_position()`), so the V5
  program must be started with the jaws open.
- Closing is torque-limited onto the object; after `GRIP_STALL_TICKS` of no
  motion the torque drops to `GRIP_HOLD_TORQUE_PCT` so the motor isn't
  squeezing flat out for the whole carry.
- **Safety invariant, do not "simplify" this away:** nothing auto-opens the
  jaws. A stale pose stream freezes `grip` (it does *not* zero it), pause
  withholds `u,v` so the last grip is held, and the kill switch uses
  `stop(HOLD)`. A dropped connection must never become a dropped object.

Current state (2026-10-22): **everything is built, NOTHING is
hardware-confirmed yet.** My next step is the first end-to-end test, in this
order: (1) page loads + AR session on the Quest, (2) WS connects
(`python server/run.py --no-serial`), (3) V5 attached with the arm free to
move safely, (4) arm follows my hand, (5) twin matches reality, (6) gripper —
benched with the arm motors unpowered first.

Your job: help me debug whatever the tests turn up. Rules:
- Fix reported bugs in the existing files; don't restructure or add features
  unprompted.
- Any message-format change must be mirrored in `PROTOCOL.md` in the same edit.
- When I confirm a milestone works on hardware, tick it in `CLAUDE.md`'s
  tracker and regenerate this `HANDOFF.md`.
- Link lengths L1=20.5, L2=30.5 cm came from my V5 code; if the twin geometry
  looks off, ask me to re-measure instead of guessing.
- A second workstream (not in this repo) is streaming an Insta360 camera feed
  into the Quest. If it lands, the heavy video must not share the hotspot with
  the pose stream, and it has to render inside the existing Three.js scene —
  the headset can only run one immersive-ar session at a time.
