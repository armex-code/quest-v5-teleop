#!/usr/bin/env bash
# Generate a self-signed TLS cert for the host machine's LAN IP.
# Run from Git Bash on Windows (openssl ships with Git) or any shell on a Pi.
# Usage: ./scripts/gen_cert.sh 192.168.137.1
set -euo pipefail

IP="${1:-}"
if [ -z "$IP" ]; then
  echo "usage: $0 <host-lan-ip>" >&2
  echo "  Windows hotspot host is usually 192.168.137.1 (check: ipconfig)" >&2
  echo "  Pi: find it with hostname -I" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)/server/certs"
mkdir -p "$DIR"

# Git Bash: hand the Windows openssl a Windows-style path, because
# MSYS_NO_PATHCONV below turns off the automatic conversion.
command -v cygpath >/dev/null && DIR="$(cygpath -m "$DIR")"

# MSYS_NO_PATHCONV stops Git Bash from rewriting "/CN=..." as a Windows path.
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/CN=$IP" \
  -addext "subjectAltName=IP:$IP"

echo "wrote $DIR/{cert.pem,key.pem} for https://$IP"
echo "re-run this script if the host's IP changes"
