# Wire Protocol — v0.1 (draft)

Transport: WebSocket over TLS (`wss://<pi-ip>:8765`), one compact JSON object
per text frame. Keys are deliberately short; every message has `"t"` (type).
Sections are tagged with the milestone that activates them — fields not yet
active are still reserved here so the schema never has to break.

Numbers: positions in **meters** (raw Quest space) or unitless `[0,1]`
(calibrated), angles in **degrees**, timestamps in ms (`performance.now()` on
Quest, `time.monotonic()*1000` on Pi — only compared to themselves, never
across machines).

## Quest → Pi

### `p` — controller pose (M2, extended in M4)

Sent at ~25 Hz while an AR session is active and the right controller is tracked.

```json
{"t":"p","s":1042,"x":0.132,"z":-0.410,"pen":1,"u":0.62,"v":0.31,"ts":81234.5}
```

| key | type  | since | meaning |
|-----|-------|-------|---------|
| s   | int   | M2 | monotonically increasing sequence number. Pi drops any frame with `s` ≤ last seen. |
| x,z | float | M2 | raw controller position in Quest reference space, meters |
| pen | 0/1   | M2 | trigger state (1 = pressed = pen down) |
| u,v | float | M4 | calibrated workspace coords in [0,1]; **absent until calibrated**. Pi actuates only when present (M4+); before M4 it just prints. |
| ts  | float | M2 | quest-local ms timestamp |

Smoothing (EMA) is applied on the Quest **before** sending, so `x,z,u,v` are
already smoothed values.

### `cal` — calibration event (M4)

Informational; calibration math lives on the Quest. Sent when the user marks a corner.

```json
{"t":"cal","c":"a","x":0.021,"z":-0.334}
```
`c` is `"a"` (first corner) or `"b"` (opposite corner). Pi logs it; may reset
its stale-sequence counter.

## Pi → Quest

### `tm` — telemetry (M5)

Sent at the Pi's loop rate (target 20–30 Hz) while connected.

```json
{"t":"tm","q":[34.2,-71.9],"qc":[35.0,-70.5],"pen":1,"ts":91234.5}
```

| key | meaning |
|-----|---------|
| q   | `[q1,q2]` actual encoder angles, degrees |
| qc  | `[q1,q2]` last commanded (IK output) angles, degrees — drives the ghost |
| pen | actual pen state as last commanded/confirmed |

The twin renders `qc` as the translucent ghost and `q` as the solid arm, both
via scene-graph FK with L1/L2. The pen trail is appended from the **solid**
tip position whenever `pen == 1`.

### `st` — status / error (M2)

```json
{"t":"st","ok":1,"msg":"serial connected"}
{"t":"st","ok":0,"msg":"target out of reach, clamped"}
```

## Reliability rules

- Latest-wins: both sides keep only the newest message of each type; no queues.
- No acks. If the socket drops, the Quest auto-reconnects with backoff (1s→5s)
  and resets `s` to 0; the Pi treats a new connection as a fresh sequence space.
- On disconnect or 500 ms without a fresh `p`, the Pi **holds position and
  raises the pen** (safety).
