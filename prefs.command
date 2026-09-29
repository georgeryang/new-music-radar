#!/bin/bash

cd "$(dirname "$0")" || { echo "ERROR: cannot enter the repo folder"; read -p "Press Enter to close..."; exit 1; }

. "$(dirname "$0")/scripts/find-node.sh"
if [ -z "$NODE" ]; then
  echo "ERROR: node not found on PATH or under ~/.nvm/versions/node/*/bin — install node from nodejs.org, then try again"
  read -p "Press Enter to close..."
  exit 1
fi

(sleep 1 && open "http://127.0.0.1:4747") &
exec "$NODE" scripts/prefs-server.mjs
