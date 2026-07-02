#!/bin/bash
# New Music Radar — double-click this file to update the website right now.

cd "$(dirname "$0")"

echo "Updating New Music Radar..."
echo "(when it says \"Published\", the website has the new data about a minute later)"
echo ""

bash scripts/update.sh

echo ""
read -p "Press Enter to close..."
