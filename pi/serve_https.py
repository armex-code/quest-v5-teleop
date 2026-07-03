#!/usr/bin/env python3
"""Serve the quest/ WebXR page over HTTPS.

WebXR only runs in a secure context, so even on the LAN the page must come
over HTTPS. Generate the self-signed cert first: scripts/gen_cert.sh <PI_IP>
"""
import argparse
import ssl
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PI_DIR = Path(__file__).resolve().parent
REPO_ROOT = PI_DIR.parent


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--dir", default=str(REPO_ROOT / "quest"))
    ap.add_argument("--cert", default=str(PI_DIR / "certs" / "cert.pem"))
    ap.add_argument("--key", default=str(PI_DIR / "certs" / "key.pem"))
    args = ap.parse_args()

    for f in (args.cert, args.key):
        if not Path(f).exists():
            raise SystemExit(
                f"missing {f} — run scripts/gen_cert.sh <PI_LAN_IP> first"
            )

    handler = partial(SimpleHTTPRequestHandler, directory=args.dir)
    httpd = ThreadingHTTPServer(("0.0.0.0", args.port), handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"serving {args.dir}")
    print(f"open   https://<PI_LAN_IP>:{args.port}  in the Quest Browser")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
