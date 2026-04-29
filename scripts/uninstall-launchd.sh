#!/bin/bash
# Stop and remove the launchd job. Doesn't touch any code or data.

set -euo pipefail

PLIST_DST="$HOME/Library/LaunchAgents/com.matt.samwise-2.plist"

if [ -f "$PLIST_DST" ]; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm "$PLIST_DST"
  echo "[samwise-2] launchd job removed."
else
  echo "[samwise-2] no plist found at $PLIST_DST — nothing to do."
fi
