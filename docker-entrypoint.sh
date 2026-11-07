#!/bin/sh
# Pastikan folder upload (volume) bisa ditulis, lalu jalankan app sebagai user non-root.
set -e
UPLOAD_DIR="${UPLOAD_DIR:-/data/uploads}"
mkdir -p "$UPLOAD_DIR"
chown -R node:node "$UPLOAD_DIR" 2>/dev/null || true
exec su-exec node node server.js
