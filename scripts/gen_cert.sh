#!/usr/bin/env bash
# Generate a self-signed TLS cert for the Pi's LAN IP.
# Usage: ./scripts/gen_cert.sh 192.168.1.42
set -euo pipefail

IP="${1:-}"
if [ -z "$IP" ]; then
  echo "usage: $0 <pi-lan-ip>   (find it with: hostname -I)" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)/pi/certs"
mkdir -p "$DIR"

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/CN=$IP" \
  -addext "subjectAltName=IP:$IP"

echo "wrote $DIR/{cert.pem,key.pem} for https://$IP"
echo "re-run this script if the Pi's IP changes (or reserve the IP in your router)"
