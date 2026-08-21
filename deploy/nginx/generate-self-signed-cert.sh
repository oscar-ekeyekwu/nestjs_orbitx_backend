#!/usr/bin/env bash
# Generates a self-signed TLS cert for api.orbitxng.com so nginx can
# terminate HTTPS on the VPS before a real cert is issued.
#
# Run this ON THE VPS as root — the private key is written straight to
# disk there and never touches this repo or git history:
#   sudo ./generate-self-signed-cert.sh
#
# Re-running overwrites the existing self-signed pair (safe). Once
# `sudo certbot --nginx -d api.orbitxng.com` succeeds, certbot points
# nginx at its own /etc/letsencrypt paths instead — the files this
# script writes become unused and can be left in place or removed.

set -euo pipefail

DOMAIN="${1:-api.orbitxng.com}"
DAYS="${2:-825}" # ~2.25y; some browsers cap trust at 398d but this is a stopgap, not a public-facing leaf cert
OUT_DIR="/etc/ssl/orbitx/${DOMAIN}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo) — writing to ${OUT_DIR}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

openssl req -x509 -nodes -newkey rsa:2048 \
  -days "${DAYS}" \
  -keyout "${OUT_DIR}/privkey.pem" \
  -out "${OUT_DIR}/fullchain.pem" \
  -subj "/CN=${DOMAIN}" \
  -addext "subjectAltName=DNS:${DOMAIN}"

chmod 600 "${OUT_DIR}/privkey.pem"
chmod 644 "${OUT_DIR}/fullchain.pem"

echo "Self-signed cert written to ${OUT_DIR} (valid ${DAYS} days)."
echo "Reload nginx to pick it up: sudo systemctl reload nginx"
