#!/bin/bash
# Production launcher for samwise-2 on the Mac Mini.
# Builds the frontend if needed, then runs the server which serves the built
# bundle + API + WebSocket on a single port.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Build the frontend if dist/ is missing or stale.
if [ ! -d "dist" ] || [ "$(find src -newer dist -type f 2>/dev/null | head -n 1)" ]; then
  echo "[samwise-2] building frontend…"
  /opt/homebrew/bin/npm run build
fi

cd "$ROOT/server"

# Install server deps if missing.
if [ ! -d "node_modules" ]; then
  echo "[samwise-2] installing server deps…"
  /opt/homebrew/bin/npm install
fi

echo "[samwise-2] starting server on :8090…"
exec ./node_modules/.bin/tsx src/index.ts
