#!/usr/bin/env python3
"""One-command host server for Quest -> V5 teleoperation.

Runs three things in one process (host = the Windows PC, or a Pi — anything
on the same network as the Quest with a USB cable to the V5 brain):

  1. HTTPS static server for quest/           (default port 8443)
     ...which also proxies WHEP signalling for the 360 camera (?mode=vr)
  2. WSS WebSocket bridge for pose/telemetry  (default port 8765)
  3. USB serial link to the VEX V5 brain      (auto-detected, 115200 baud)

Data flow (see PROTOCOL.md):
  Quest "p" msg (u,v,grip) --> serial "u,v,grip\\n" --> V5 (IK runs ON the brain)
  V5 "E,q1,q2,c1,c2\\n"    --> WSS "tm" msg        --> Quest digital twin

The 360 camera is optional and entirely separate: start_camera.ps1 runs
MediaMTX + ffmpeg, and this server only relays the SDP handshake. Without it,
?mode=ar (the default, passthrough) is unaffected.

The server runs fine with no V5 attached (it keeps retrying every 2 s and
tells the Quest via "st" messages) so the twin/UI can be tested standalone.

Usage:
    python server/run.py                # auto-detect serial, both servers
    python server/run.py --serial COM5  # explicit serial port
    python server/run.py --no-serial    # UI/twin testing without the V5
"""
import argparse
import asyncio
import http
import json
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import serial
import serial.tools.list_ports
import websockets

# Status lines must appear immediately even when output is piped/redirected.
sys.stdout.reconfigure(line_buffering=True)

SERVER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SERVER_DIR.parent

# Arm geometry — must match v5/main.py (the V5 owns the IK; these are only
# echoed to the Quest so the digital twin matches the real arm).
L1_CM = 20.5
L2_CM = 30.5
# 48 wide x 15 deep — must match normalized_to_workspace() in v5/main.py.
# Fitted to the MEASURED joint limits (±128.6° each), not to link lengths:
# the elbow limit puts the inner boundary at r = 23.9 cm, so a near edge at
# depth 16–18 (both earlier workspaces) was never actually reachable.
WORKSPACE = [-24.0, 24.0, 26.0, 41.0]  # arm-frame cm: x_min, x_max, y_min, y_max

VEX_USB_VID = 0x2888          # VEX Robotics
# Casting/recording on the Quest steals Wi-Fi airtime and makes the pose
# stream bursty; 1 s tolerates that while the slew limiter keeps motion safe.
POSE_STALE_S = 1.0            # no fresh pose for this long -> hold (see pump)
SERIAL_TX_INTERVAL = 0.04     # 25 Hz max toward the V5

# Direction mapping, applied in this order to each incoming (u, v):
#   1. SWAP_UV: transpose the axes (panel width was driving arm depth)
#   2. FLIP_*: mirror an axis if the robot moves opposite to the hand
# u = depth (corner A -> B), v = lateral (corner A -> B) as sent by the Quest.
SWAP_UV = True
FLIP_U = False
FLIP_V = True

# Output smoothing (the "buffer"): each 40 ms tick the commanded point eases
# toward the target (EMA) and can move at most SLEW_PER_TICK of the workspace,
# so hand jitter is absorbed and top speed is bounded (~1 s across the range).
SMOOTH_ALPHA = 0.35
SLEW_PER_TICK = 0.04


class Bridge:
    def __init__(self, serial_port=None, no_serial=False, verbose=False):
        self.forced_port = serial_port
        self.no_serial = no_serial
        self.verbose = verbose
        self.clients = set()
        self.loop = None

        self.ser = None
        self.ser_lock = threading.Lock()

        # Latest pose from the Quest (latest-wins; the pump drains it).
        self.latest = None            # (u, v, grip)
        self.last_pose_time = 0.0
        self.last_sent_grip = 0
        self.stale_notified = False

    # ── WebSocket side ────────────────────────────────────────────────────

    async def ws_handler(self, ws):
        peer = ws.remote_address
        print(f"[ws] client connected: {peer}")
        self.clients.add(ws)
        last_seq = 0  # per-connection sequence space (reconnect = fresh)
        try:
            await ws.send(json.dumps({
                "t": "cfg", "l1": L1_CM, "l2": L2_CM, "ws": WORKSPACE,
                # The client needs all three to know which panel edge is the
                # robot's far reach, and so draws an orientation cue instead
                # of leaving you to guess whether the mapping is mirrored.
                "swap": int(SWAP_UV),
                "fu": int(FLIP_U), "fv": int(FLIP_V),
            }))
            await ws.send(self._status_msg())
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                mtype = msg.get("t")
                if mtype == "p":
                    s = msg.get("s", 0)
                    if s <= last_seq:
                        continue  # stale/out-of-order frame
                    last_seq = s
                    self._on_pose(msg)
                elif mtype == "cal":
                    print(f"[cal] corner {msg.get('c')} at "
                          f"x={msg.get('x'):+.3f} z={msg.get('z'):+.3f}")
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)
            print(f"[ws] client disconnected: {peer}")

    def _on_pose(self, msg):
        self.last_pose_time = time.monotonic()
        u, v = msg.get("u"), msg.get("v")
        if u is None or v is None:
            return  # paused on the Quest — HUD-only, never actuate
        grip = 1 if msg.get("grip") else 0
        u = max(0.0, min(1.0, u))
        v = max(0.0, min(1.0, v))
        if SWAP_UV:
            u, v = v, u
        if FLIP_U:
            u = 1.0 - u
        if FLIP_V:
            v = 1.0 - v
        self.latest = (u, v, grip)
        if self.verbose:
            print(f"[pose] u={u:.3f} v={v:.3f} grip={grip}")

    def _status_msg(self):
        if self.no_serial:
            return json.dumps({"t": "st", "ok": 0, "msg": "serial disabled (--no-serial)"})
        ok = 1 if self.ser else 0
        msg = "V5 connected" if ok else "V5 not connected — retrying"
        return json.dumps({"t": "st", "ok": ok, "msg": msg})

    def broadcast(self, text):
        websockets.broadcast(self.clients, text)

    def broadcast_threadsafe(self, text):
        if self.loop:
            self.loop.call_soon_threadsafe(self.broadcast, text)

    # ── Serial side ───────────────────────────────────────────────────────

    def find_vex_port(self):
        if self.forced_port:
            return self.forced_port
        vex = [p for p in serial.tools.list_ports.comports()
               if p.vid == VEX_USB_VID]
        if not vex:
            return None
        # The brain exposes two CDC ports: USB interface 0 = admin (vexcom
        # uploads), interface 2 = user (program stdio — the one we want).
        # On Windows the user port's location string ends with ".2"; on Linux
        # it's the second ttyACM. Fall back to "user" in the description,
        # then to the last sorted port.
        for p in vex:
            if (p.location or "").endswith(".2"):
                return p.device
        for p in vex:
            if "user" in (p.description or "").lower():
                return p.device
        return sorted(p.device for p in vex)[-1]

    def serial_worker(self):
        """Owns the serial connection: connects, reads telemetry, reconnects."""
        while True:
            port = self.find_vex_port()
            if not port:
                time.sleep(2.0)
                continue
            try:
                ser = serial.Serial(port, baudrate=115200, timeout=1,
                                    write_timeout=0.5)
            except Exception as e:
                print(f"[serial] open {port} failed: {e}")
                time.sleep(2.0)
                continue

            print(f"[serial] connected to V5 on {port}")
            with self.ser_lock:
                self.ser = ser
            self.broadcast_threadsafe(self._status_msg())

            try:
                while True:
                    line = ser.readline().decode("ascii", "ignore").strip()
                    if not line:
                        continue
                    if line.startswith("E,"):
                        self._on_telemetry(line)
                    elif self.verbose:
                        print(f"[v5] {line}")
            except Exception as e:
                print(f"[serial] lost connection: {e}")
            finally:
                with self.ser_lock:
                    self.ser = None
                try:
                    ser.close()
                except Exception:
                    pass
                self.broadcast_threadsafe(self._status_msg())
                time.sleep(2.0)

    def _on_telemetry(self, line):
        # "E,q1,q2,c1,c2" — measured and commanded arm-frame angles, degrees
        parts = line.split(",")
        if len(parts) != 5:
            return
        try:
            q1, q2, c1, c2 = (float(x) for x in parts[1:])
        except ValueError:
            return
        self.broadcast_threadsafe(json.dumps({
            "t": "tm",
            "q": [round(q1, 2), round(q2, 2)],
            "qc": [round(c1, 2), round(c2, 2)],
            "grip": self.last_sent_grip,
            "ts": round(time.monotonic() * 1000, 1),
        }))

    def send_frame(self, u, v, grip):
        with self.ser_lock:
            ser = self.ser
        if not ser:
            return
        try:
            ser.write(f"{u:.6f},{v:.6f},{grip}\n".encode("ascii"))
            self.last_sent_grip = grip
        except Exception as e:
            print(f"[serial] write failed: {e}")

    # ── Pump: smooth latest pose -> serial, plus stale-pose safety ───────

    async def pump(self):
        su = sv = None          # smoothed command actually sent to the arm
        lu = lv = None          # last values written to serial
        while True:
            await asyncio.sleep(SERIAL_TX_INTERVAL)
            if self.latest is None:
                continue
            u, v, grip = self.latest

            stale = time.monotonic() - self.last_pose_time > POSE_STALE_S
            if stale:
                # Freeze the grip state rather than forcing it open: a pen
                # would be safe to raise on a dropout, but releasing the
                # gripper here would drop whatever it is carrying. The arm
                # still coasts to a stop at the last commanded point.
                grip = self.last_sent_grip
                if not self.stale_notified:
                    self.stale_notified = True
                    print("[safety] pose stream stale — holding position "
                          f"and grip={grip}")
            else:
                self.stale_notified = False

            if su is None:
                su, sv = u, v
            else:
                du = max(-SLEW_PER_TICK, min(SLEW_PER_TICK, SMOOTH_ALPHA * (u - su)))
                dv = max(-SLEW_PER_TICK, min(SLEW_PER_TICK, SMOOTH_ALPHA * (v - sv)))
                su += du
                sv += dv

            moved = (lu is None or abs(su - lu) > 1e-4 or abs(sv - lv) > 1e-4)
            if moved or grip != self.last_sent_grip:
                self.send_frame(su, sv, grip)
                lu, lv = su, sv


class QuestHandler(SimpleHTTPRequestHandler):
    """Static files for quest/, plus WHEP signalling for the 360 camera.

    The WHEP proxy only matters in `?mode=vr`, where the page shows a live
    360 camera feed instead of passthrough (see PROTOCOL.md). It forwards SDP
    to MediaMTX on loopback, and exists purely so the headset deals with ONE
    certificate on ONE port: if MediaMTX terminated its own TLS, the page
    (:8443) and the WHEP endpoint would be different origins with different
    self-signed certs, and a cross-origin fetch to an untrusted cert fails
    outright with no interstitial to accept. There is no way to click through
    that inside a headset.

    Only signalling passes through here. The video itself goes as UDP straight
    from MediaMTX to the Quest, so this costs nothing in latency.
    """

    # Some Windows installs map .js to text/plain in the registry, which makes
    # the browser refuse every ES module. extensions_map wins over mimetypes.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".html": "text/html",
        ".css": "text/css",
    }

    mediamtx = "http://127.0.0.1:8889"
    stream_path = "cam"

    def _send_bytes(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _upstream(self, path, method, body, ctype):
        req = urllib.request.Request(f"{self.mediamtx}{path}", data=body,
                                     method=method)
        if ctype:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                status, payload = r.status, r.read()
                location = r.headers.get("Location")
                resp_ctype = r.headers.get("Content-Type", "application/sdp")
        except urllib.error.HTTPError as e:
            detail = (e.read() or b"").decode("utf-8", "replace").strip()
            if e.code == 404:
                detail = detail or (
                    f"nothing is publishing to '{self.stream_path}' — "
                    "is start_camera.ps1 running?")
            self._send_bytes(e.code, detail.encode(), "text/plain")
            return
        except urllib.error.URLError as e:
            self._send_bytes(502, (
                f"cannot reach MediaMTX at {self.mediamtx}: {e.reason} — "
                "is start_camera.ps1 running?").encode(), "text/plain")
            return

        extra = {}
        if location:
            # Re-point the session URL at us so teardown comes back here.
            extra["Location"] = "/whep/" + location.rsplit("/whep/", 1)[-1]
        self._send_bytes(status, payload, resp_ctype, extra)

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler naming
        if self.path.rstrip("/") != "/whep":
            self.send_error(404, "not found")
            return
        n = int(self.headers.get("Content-Length") or 0)
        offer = self.rfile.read(n) if n else b""
        self._upstream(f"/{self.stream_path}/whep", "POST", offer,
                       self.headers.get("Content-Type", "application/sdp"))

    def do_DELETE(self):  # noqa: N802
        if not self.path.startswith("/whep/"):
            self.send_error(404, "not found")
            return
        self._upstream(f"/{self.stream_path}/whep/{self.path[len('/whep/'):]}",
                       "DELETE", None, None)


def make_ssl_context(cert, key):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    return ctx


def start_static_server(port, directory, cert, key):
    handler = partial(QuestHandler, directory=directory)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), handler)
    httpd.socket = make_ssl_context(cert, key).wrap_socket(
        httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


async def health_check(path, request_headers):
    """Answer plain HTTPS GETs on the WSS port so the Quest browser can
    accept the self-signed cert for this port (docs/HTTPS_SETUP.md step 4)."""
    if "Upgrade" not in request_headers:
        return (http.HTTPStatus.OK,
                [("Content-Type", "text/plain")],
                b"WS bridge OK - cert accepted for this port. Go back to the app page.\n")
    return None


async def main_async(args):
    bridge = Bridge(serial_port=args.serial, no_serial=args.no_serial,
                    verbose=args.verbose)
    bridge.loop = asyncio.get_running_loop()

    if not args.no_serial:
        threading.Thread(target=bridge.serial_worker, daemon=True).start()

    ws_ssl = make_ssl_context(args.cert, args.key)
    async with websockets.serve(bridge.ws_handler, "0.0.0.0", args.ws_port,
                                ssl=ws_ssl, process_request=health_check):
        print(f"[ws]   wss bridge on wss://0.0.0.0:{args.ws_port}")
        await bridge.pump()  # runs forever


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--http-port", type=int, default=8443)
    ap.add_argument("--ws-port", type=int, default=8765)
    ap.add_argument("--dir", default=str(REPO_ROOT / "quest"))
    ap.add_argument("--cert", default=str(SERVER_DIR / "certs" / "cert.pem"))
    ap.add_argument("--key", default=str(SERVER_DIR / "certs" / "key.pem"))
    ap.add_argument("--serial", default=None,
                    help="serial port of the V5 user port (e.g. COM5); auto-detect if omitted")
    ap.add_argument("--no-serial", action="store_true",
                    help="run without the V5 (UI / twin testing)")
    ap.add_argument("--no-static", action="store_true",
                    help="don't serve quest/ (if another server does)")
    ap.add_argument("--mediamtx", default="http://127.0.0.1:8889",
                    help="MediaMTX HTTP base for WHEP signalling (?mode=vr)")
    ap.add_argument("--stream", default="cam",
                    help="MediaMTX path name for the 360 camera")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    QuestHandler.mediamtx = args.mediamtx.rstrip("/")
    QuestHandler.stream_path = args.stream

    for f in (args.cert, args.key):
        if not Path(f).exists():
            raise SystemExit(
                f"missing {f} — run scripts/gen_cert.sh <THIS_PCS_LAN_IP> first "
                "(Git Bash on Windows)")

    if not args.no_static:
        start_static_server(args.http_port, args.dir, args.cert, args.key)
        print(f"[http] serving {args.dir}")
        print(f"[http] open https://<THIS_PCS_LAN_IP>:{args.http_port} in the Quest Browser")

    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n[exit] bye")


if __name__ == "__main__":
    main()
