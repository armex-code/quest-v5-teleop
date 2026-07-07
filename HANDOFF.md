# Handoff prompt — paste into a new session on a smaller model

> Keep this file current: it must be regenerated whenever a milestone's status
> changes. Usage: start a new Claude Code session in this directory, run
> `/model sonnet` (or `haiku`), and paste everything below the line.

---

Continue an in-progress project. First read `CLAUDE.md` in this directory —
it has the architecture, all hardware facts, and the milestone tracker that is
the source of truth. Also skim `PROTOCOL.md`.

Quick context: a Meta Quest 3S (WebXR immersive-ar, Quest Browser) teleoperates
a VEX V5 2-link planar drawing arm. Host is my **Windows PC** (no Raspberry Pi):
`server/run.py` serves the WebXR page over HTTPS (:8443), bridges a WSS socket
(:8765) to USB serial, and relays telemetry back. **The IK runs on the V5
brain** (`v5/main.py`, my proven Jacobian IK — never rewrite it). The Quest
page (`quest/js/app.js`) does 2-corner calibration (A/B buttons), streams
smoothed `u,v,pen` at 25 Hz, and renders a digital twin (solid arm = encoder
telemetry, ghost = commanded, green trail = pen path). Trigger = pen down.
Network = the PC's Windows Mobile Hotspot (campus Wi-Fi isolates clients);
cert flow in `docs/HTTPS_SETUP.md` — the Quest must accept the self-signed
cert on BOTH ports 8443 and 8765.

Current state (2026-07-07): **everything is built, NOTHING is
hardware-confirmed yet.** My next step is the first end-to-end test, in this
order: (1) page loads + AR session on the Quest, (2) WS connects
(`python server/run.py --no-serial`), (3) V5 attached with the arm free to
move safely, (4) calibrated control, (5) twin matches reality.

Your job: help me debug whatever the tests turn up. Rules:
- Fix reported bugs in the existing files; don't restructure or add features
  unprompted.
- Any message-format change must be mirrored in `PROTOCOL.md` in the same edit.
- When I confirm a milestone works on hardware, tick it in `CLAUDE.md`'s
  tracker and regenerate this `HANDOFF.md`.
- Link lengths L1=20.5, L2=30.5 cm came from my V5 code; if the twin geometry
  looks off, ask me to re-measure instead of guessing.
