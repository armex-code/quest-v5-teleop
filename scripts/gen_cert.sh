#!/usr/bin/env bash
# Generate a self-signed TLS cert for this machine's LAN address(es).
# Run from Git Bash on Windows (openssl ships with Git).
#
# Usage: ./scripts/gen_cert.sh <ip> [more ips...]
#   e.g. ./scripts/gen_cert.sh 192.168.137.1 10.126.73.140
#
# Pass every address you might serve from and the one cert covers them all --
# so switching between the Mobile Hotspot and normal Wi-Fi needs no regenerate,
# and no re-accepting the warning on the headset. localhost and 127.0.0.1 are
# always included for desktop testing.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <host-lan-ip> [more ips...]" >&2
  echo "  Windows hotspot host is usually 192.168.137.1 (check: ipconfig)" >&2
  echo "  listing several is fine and saves regenerating later" >&2
  exit 1
fi

# Build the SAN list. The first address becomes the CN, purely cosmetic.
IP="$1"
SAN="IP:127.0.0.1,DNS:localhost"
for a in "$@"; do
  case "$a" in
    127.0.0.1|localhost) continue ;;
  esac
  SAN="$SAN,IP:$a"
done

DIR="$(cd "$(dirname "$0")/.." && pwd)/server/certs"
mkdir -p "$DIR"

# Git Bash: hand the Windows openssl a Windows-style path, because
# MSYS_NO_PATHCONV below turns off the automatic conversion.
command -v cygpath >/dev/null && DIR="$(cygpath -m "$DIR")"

# MSYS_NO_PATHCONV stops Git Bash from rewriting "/CN=..." as a Windows path.
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/CN=$IP" \
  -addext "subjectAltName=$SAN"

echo
echo "wrote $DIR/{cert.pem,key.pem}"
echo "valid for: $SAN"
echo "re-run this script if the host gets an address not listed above"
