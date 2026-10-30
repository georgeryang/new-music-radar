#!/bin/bash
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"
REPO="${RADAR_REPO:-georgeryang/new-music-radar}"
BRANCH="${RADAR_BRANCH:-main}"
export GH_REPO="$REPO"

git config --global user.name "New Music Radar Bot"
git config --global user.email "radar-bot@users.noreply.github.com"
# A credential helper keeps the token out of the remote URL, logs and error text.
git config --global credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'

git clone -q --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" /work
cd /work
exec bash scripts/cloud-refresh.sh "$@"
