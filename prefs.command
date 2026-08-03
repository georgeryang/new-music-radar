#!/bin/bash
# New Music Radar — double-click to edit followed/blocked artists, genres,
# countries, and discovery playlists.
# Starts a local editor at http://127.0.0.1:4747 (this window keeps it running;
# use the Quit button on the page or close this window to stop).

cd "$(dirname "$0")" || { echo "ERROR: cannot enter the repo folder"; read -p "Press Enter to close..."; exit 1; }

. "$(dirname "$0")/scripts/find-node.sh"
if [ -z "$NODE" ]; then
  echo "ERROR: node not found on PATH or under ~/.nvm/versions/node/*/bin — install node from nodejs.org, then try again"
  read -p "Press Enter to close..."
  exit 1
fi

(sleep 1 && open "http://127.0.0.1:4747") &
exec "$NODE" scripts/prefs-server.mjs
