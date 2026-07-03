# Handoff prompt — paste into a new session on a smaller model

> Keep this file current: it must be regenerated whenever a milestone's status
> changes. Usage: start a new Claude Code session in this directory, run
> `/model sonnet` (or `haiku`), and paste everything below the line.

---

Continue an in-progress project. First read `CLAUDE.md` in this directory —
it has the architecture, conventions, and the milestone tracker that is the
source of truth. Also skim `PROTOCOL.md`.

Quick context: Meta Quest 3S (WebXR immersive-ar in Quest Browser) teleoperates
a VEX V5 2-link planar drawing arm through a Raspberry Pi (WebSocket → Python →
IK → USB serial → V5). Telemetry (encoder angles) flows back to a Three.js
digital twin in the headset: translucent ghost = commanded pose, solid =
actual. Trigger = pen down. Everything is milestone-gated: NEVER start the next
milestone until I confirm the current one works on real hardware.

Current state:
- M0 (repo, docs, cert flow) and the M1 code are **built**: `quest/index.html`
  + `quest/js/app.js` (AR session, HUD showing controller X/Z + trigger,
  controller spheres), `pi/serve_https.py` (HTTPS static server),
  `scripts/gen_cert.sh`, `docs/HTTPS_SETUP.md`.
- M1 is **not yet hardware-confirmed**. If I report it works, tick it in
  CLAUDE.md, then build M2: `wss://` server on the Pi (port 8765, same cert,
  `websockets` lib) that prints incoming poses, plus WebSocket sending in the
  Quest page at ~25 Hz using the `"p"` message from PROTOCOL.md
  (latest-wins, sequence numbers). If I report a problem, debug M1 instead.
- Before M3, ask me for: L1/L2 link lengths in cm, my existing Python IK code,
  and my Pi↔V5 serial details (from an old pygame project). Do not write IK
  from scratch.
- Keep PROTOCOL.md in sync with any message changes, keep the milestone
  tracker in CLAUDE.md updated, and refresh HANDOFF.md at each milestone
  transition.
