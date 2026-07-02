#!/bin/bash
# Daily fetch + publish, run by launchd (see launchd/com.georgeryang.new-music-radar.plist).
# Needs no node_modules — just node, curl, and git.
set -uo pipefail

REPO_DIR="/Users/gyang/Dev/new-music-radar"
cd "$REPO_DIR" || exit 1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# launchd's PATH doesn't include nvm; fall back to the newest installed node.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$NODE" ]; then
  log "ERROR: node not found"
  exit 1
fi

# --if-stale (passed by launchd): one fetch per day, anchored to 18:15 KST
# (Korean evening release time). Stale = the last fetch predates the most
# recent 18:15 KST. KST is UTC+9 with no DST, so this is pure UTC arithmetic —
# independent of the Mac's local timezone. launchd ticks every 10 min while
# awake (and once on wake), so the fetch lands in the 18:15–18:30 KST window
# when the Mac is awake, or at first wake after it.
if [ "${1:-}" = "--if-stale" ]; then
  STALE="$("$NODE" -e '
    const KST = 9 * 3600e3, DAY = 86400e3, SLOT = (18 * 60 + 15) * 60e3;
    const kstNow = Date.now() + KST;
    let slot = Math.floor(kstNow / DAY) * DAY + SLOT;
    if (slot > kstNow) slot -= DAY;
    let fetchedAt = 0;
    try { fetchedAt = JSON.parse(require("fs").readFileSync("docs/data/releases.json", "utf8")).fetched_at } catch {}
    process.stdout.write(fetchedAt < slot - KST ? "1" : "0");
  ' 2>/dev/null || echo 1)"
  if [ "$STALE" != "1" ]; then
    exit 0  # silent: ticks run every 10 min, logging each skip would flood the log
  fi
  # Jitter 0-7 min so the fetch never lands at a machine-regular moment.
  # Manual runs (refresh.command) skip this branch entirely.
  JITTER=$((RANDOM % 420))
  log "Last fetch predates the 18:15 KST slot — refreshing in ${JITTER}s"
  sleep "$JITTER"
fi

log "Fetching new releases..."
FETCH_FAILED=0
if ! "$NODE" scripts/fetch-releases.mjs; then
  # Don't bail: one scene failing shouldn't hold the other's data hostage.
  # Publish whatever was written, then exit non-zero so the failure is logged.
  log "ERROR: fetch failed for at least one scene (publishing partial data)"
  FETCH_FAILED=1
fi

# config/ rides along: preference edits (prefs.command) apply from disk at
# fetch time and get backed up with the nightly data commit — no manual git.
if git diff --quiet docs/data config && [ -z "$(git ls-files --others --exclude-standard docs/data config)" ]; then
  log "No changes — nothing to publish"
  exit "$FETCH_FAILED"
fi

log "Publishing..."
git add docs/data config
git commit -m "Update data $(date '+%Y-%m-%d %H:%M')" || { log "ERROR: commit failed"; exit 1; }
git push || { log "ERROR: push failed"; exit 1; }
log "Published"
exit "$FETCH_FAILED"
