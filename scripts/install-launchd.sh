#!/bin/bash
# One-time installer: copies the launchd plist into ~/Library/LaunchAgents,
# loads it, and verifies it started.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/scripts/com.matt.samwise-2.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.matt.samwise-2.plist"
LOG_DIR="$HOME/Library/Logs"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

if [ -f "$PLIST_DST" ]; then
  echo "[samwise-2] unloading existing launchd job…"
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

cp "$PLIST_SRC" "$PLIST_DST"
echo "[samwise-2] installed plist at $PLIST_DST"

launchctl load "$PLIST_DST"
echo "[samwise-2] launchd job loaded"

sleep 2
if launchctl list | grep -q com.matt.samwise-2; then
  echo "[samwise-2] running. log: $LOG_DIR/samwise-2.log"
  echo "[samwise-2] reach it from this Mac: http://localhost:8090"
  echo "[samwise-2] reach it over Tailscale: http://<this-mac-tailscale-name>:8090"
else
  echo "[samwise-2] job did not start — check $LOG_DIR/samwise-2.err.log"
  exit 1
fi
