#!/bin/bash
# New Music Radar — double-click to edit followed/blocked artists and genres.
# Starts a local editor at http://localhost:4747 (this window keeps it running;
# use the Quit button on the page or close this window to stop).

cd "$(dirname "$0")"

# launchd-style node fallback (nvm PATH may be missing in some shells)
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$NODE" ]; then
  echo "ERROR: node not found"
  read -p "Press Enter to close..."
  exit 1
fi

(sleep 1 && open "http://localhost:4747") &
exec "$NODE" scripts/prefs-server.mjs
