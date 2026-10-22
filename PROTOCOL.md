# Wire Protocol — v0.4

> **v0.4 (additive, nothing breaks):** an optional third link carries a live
> 360 camera feed to the headset for remote operation (`?mode=vr`). It is a
> one-way video path with no robot data on it, so v0.3 clients keep working
> unchanged — a host without the camera running simply answers 404 and the
> page falls back to reporting the camera offline.
>
> **v0.3 breaking change:** the `pen` field is renamed `grip` everywhere (`p`
> and `tm` messages, and the serial frame) now that a smart-motor gripper is
> fitted as the end effector. `1` = closed, `0` = open. The stale-pose rule
> changed with it — see *Reliability rules*.

Three links, two of them carrying compact line/frame-oriented messages:

1. **Quest ↔ host** — WebSocket over TLS (`wss://<host-ip>:8765`), one compact
   JSON object per text frame. Keys are short; every message has `"t"` (type).
   The *host* is whatever machine runs `server/run.py` (the Windows PC
   normally; a Raspberry Pi works identically).
2. **Host ↔ V5 brain** — USB serial, 115200 baud, one ASCII line per frame.
   The IK runs **on the V5** (`v5/main.py`); the host only forwards.
3. **Host → Quest video** — WebRTC, signalled over HTTPS (*optional*, only in
   `?mode=vr`). See *360 camera link* below.

Numbers: positions in **meters** (raw Quest space) or unitless `[0,1]`
(calibrated), angles in **degrees**, lengths in **cm**, timestamps in ms
(`performance.now()` on Quest, `time.monotonic()*1000` on host — only compared
to themselves, never across machines).

## Quest → host (WebSocket)

### `p` — controller pose

Sent at ~25 Hz while an AR session is active and the right controller is tracked.

```json
{"t":"p","s":1042,"x":0.132,"z":-0.410,"grip":1,"u":0.62,"v":0.31,"ts":81234.5}
```

| key | type  | meaning |
|-----|-------|---------|
| s   | int   | per-connection monotonically increasing sequence number. Host drops any frame with `s` ≤ last seen on that connection. |
| x,z | float | raw right-controller position in Quest reference space, meters (EMA-smoothed on the Quest before sending) |
| grip | 0/1  | trigger state (1 = pressed = gripper closed). Sent raw even while paused — a paused frame carries no `u,v`, so the host ignores it for actuation and holds the last grip rather than opening the jaws. |
| u,v | float | position inside the fixed drawing panel, [0,1]. **Absent while paused** — the host actuates only when present. `u` = depth axis (near edge 0 → far edge 1), `v` = lateral axis (left 0 → right 1). The panel has the workspace's proportions (scaled) and is placed with the A button; no calibration. |
| ts  | float | quest-local ms timestamp |

The host applies `SWAP_UV` / `FLIP_U` / `FLIP_V` (constants in
`server/run.py`) to each incoming `(u,v)` before forwarding, to match the
robot's physical orientation.

> The `cal` message from protocol v0.2 (2-corner calibration) was removed —
> the panel is now fixed-proportion and needs no calibration.

## Host → Quest (WebSocket)

### `cfg` — arm geometry (sent once on connect)

Lets the twin match the real arm without hardcoding. `ws` is the reachable
workspace rectangle in arm cm: `[lat_min, lat_max, fwd_min, fwd_max]`.
`swap` mirrors the server's `SWAP_UV` constant; when 1 the client builds the
drawing panel transposed so its proportions stay true to what each hand axis
drives.

```json
{"t":"cfg","l1":20.5,"l2":30.5,"ws":[-10.5,10.5,18,48],"swap":1}
```

### `tm` — telemetry

Relayed from the V5 at its telemetry rate (20 Hz) while connected.

```json
{"t":"tm","q":[34.2,-71.9],"qc":[35.0,-70.5],"grip":1,"ts":91234.5}
```

| key | meaning |
|-----|---------|
| q   | `[q1,q2]` actual encoder angles (arm frame, degrees, gear ratio already divided out) |
| qc  | `[q1,q2]` last commanded (IK output) angles, degrees — drives the ghost |
| grip | gripper state as last commanded by the host (1 = closed) |

The twin renders `qc` as the translucent ghost and `q` as the solid arm, both
via scene-graph FK with L1/L2 from `cfg`. The carry trail is appended from the
**solid** tip position whenever `grip == 1`.

Gripper *joint* angle is deliberately not telemetered — the twin has no jaw
geometry, and the host already knows the commanded state. If the twin ever
grows jaws, add a sixth field to the serial frame rather than overloading `q`.

### `st` — status / error

Sent on connect and whenever the serial link state changes.

```json
{"t":"st","ok":1,"msg":"V5 connected"}
{"t":"st","ok":0,"msg":"V5 not connected — retrying"}
```

## Host ↔ V5 (USB serial, 115200)

### Host → V5 — target frame (≤ 25 Hz)

```
<u>,<v>,<grip>\n       e.g.  0.512300,0.480010,1
```

`u,v ∈ [0,1]` forwarded verbatim from the Quest's calibrated coords. The V5's
`normalized_to_workspace()` maps them to arm-frame cm (field 1 → the 18–48 cm
depth band, field 2 → the ±10.5 cm lateral band) and its Jacobian IK + P-loop
do the rest. `grip` drives the gripper motor: `1` closes it at
`GRIP_TORQUE_PCT` until it stalls on the object and then holds at the lower
`GRIP_HOLD_TORQUE_PCT`, `0` returns it to `GRIP_OPEN_DEG`. All of those
constants are at the top of `v5/main.py`.

### V5 → host — telemetry (20 Hz)

```
E,<q1>,<q2>,<c1>,<c2>\n     e.g.  E,34.20,-71.90,35.00,-70.50
```

`q*` = measured motor position ÷ gear ratio (arm-frame degrees), `c*` = current
commanded target ÷ gear ratio. Any serial line not starting with `E,` is
treated as V5 debug output and logged, never parsed.

## 360 camera link (optional, `?mode=vr` only)

A one-way video path so the operator can work from another room. It carries
**no robot data** and is completely independent of the two links above: with
the camera half stopped, `?mode=ar` is unaffected and `?mode=vr` just reports
the camera offline.

```
Insta360 X5 ──USB──▶ ffmpeg ──RTSP/loopback──▶ MediaMTX ──WHEP──▶ run.py ──WebRTC──▶ Quest
            equirect         NVENC H.264                        (signalling)   (UDP :8189)
            2880x1440p30     no transcode
```

### Signalling — `POST /whep` on the **page's own port** (8443)

Body is an SDP offer (`Content-Type: application/sdp`); the reply is `201`
with the SDP answer and a `Location` header naming the session, which the
client `DELETE`s on teardown. `run.py` reverse-proxies this to MediaMTX on
`127.0.0.1:8889`.

That proxy is not decoration. If MediaMTX terminated its own TLS, the page
(:8443) and the WHEP endpoint (:8889) would be separate origins with separate
self-signed certs — and a cross-origin `fetch()` to an untrusted cert fails
outright, with no interstitial to click. Inside a headset there is no way to
accept that second cert. Proxying collapses it to one cert on one port.

| endpoint | method | meaning |
|---|---|---|
| `/whep` | POST | SDP offer in, SDP answer out, `Location: /whep/<id>` |
| `/whep/<id>` | DELETE | end the session (best effort; DTLS teardown also reaps it) |

### Media

Only *signalling* goes through `run.py`. The video itself is UDP straight from
MediaMTX **:8189** to the headset, so the proxy costs nothing in latency — but
that port must be open in the firewall or the page loads and the world stays
black. `start_camera.ps1 -AddFirewallRules` opens it.

Stream: H.264, 2880×1440 @ 30 fps, equirectangular 2:1, limited-range bt709,
no B-frames, 1 keyframe/s. Constrained Baseline by default because MediaMTX
echoes the browser's offered `profile-level-id` without checking it against
what is actually being sent.

## Reliability rules

- Latest-wins everywhere: both sides keep only the newest message of each
  type; no queues, no acks. The host forwards to serial at most every 40 ms,
  always the latest pose.
- If the socket drops, the Quest auto-reconnects with backoff (1 s → 5 s) and
  resets `s` to 0; the host treats each connection as a fresh sequence space.
- If the host sees no fresh `p` for `POSE_STALE_S` (1 s — raised from 500 ms
  because Quest casting makes the stream bursty), it keeps commanding the last
  position and **freezes `grip` at its last value**. This is the opposite of
  the old pen rule, which forced `pen=0`: a pen is safe to raise on a dropout,
  but opening a gripper would drop whatever it is carrying. Nothing in the
  stack ever opens the jaws on its own — only a released trigger does.
- If the V5 serial link drops, the host retries every 2 s and reports via `st`.
- The 360 feed is best-effort and never gates control: if WHEP fails or the
  stream stalls, the client retries every 2 s and the HUD's `CAM` chip shows
  the state. Losing video does **not** stop or alter pose streaming — the arm
  keeps obeying the controller exactly as in `?mode=ar`.
