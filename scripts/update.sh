#!/bin/bash
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || exit 1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

. "$REPO_DIR/scripts/find-node.sh"
if [ -z "$NODE" ]; then
  log "ERROR: node not found on PATH or under ~/.nvm/versions/node/*/bin — install node, or point scripts/find-node.sh at it"
  exit 1
fi

if ! "$NODE" scripts/run-lock.mjs --owns-refresh; then
  exec "$NODE" scripts/run-lock.mjs refresh bash "$0" "$@"
fi

# --if-stale (from launchd): one fetch per day, anchored to 18:15 KST (see
# is-stale.mjs). launchd ticks every 10 min while awake, so the fetch lands in the 18:15–18:30
# window (or at first wake after).
if [ "${1:-}" = "--if-stale" ]; then
  # One writer: the scheduled path stands down once Cloud Refresh owns the job.
  if "$NODE" --input-type=module -e 'const m = await import("./scripts/cloud-config.mjs"); process.exit(m.CLOUD_REFRESH ? 0 : 1)' 2>/dev/null; then
    exit 0
  fi
  STALE="$("$NODE" scripts/is-stale.mjs 2>&1)"
  if [ "$STALE" != "0" ] && [ "$STALE" != "1" ]; then
    # Fail open (a missed night costs more than an extra fetch), but name the real
    # cause: the "predates the slot" line below would otherwise repeat every tick
    # while the probe stayed broken. First line only, or a stack trace floods the log.
    log "NOTE: staleness probe failed, refreshing anyway ($(printf '%s' "${STALE:-no output}" | head -1))"
    STALE=1
  fi
  if [ "$STALE" != "1" ]; then
    exit 0  # silent: ticks run every 10 min, logging each skip would flood the log
  fi
  # No jitter here: a sleep only advances during wakes, and the lid-closed scheduled
  # dark wake has a 30-45s budget.
  log "Last fetch predates the 18:15 KST slot — refreshing"
elif [ -n "${1:-}" ]; then
  # Every path below this point commits and pushes to the live site, so a typo
  # ("--if-state") must not fall through into an unscheduled publish.
  log "ERROR: unknown argument '$1' (usage: update.sh [--if-stale])"
  exit 1
fi

# Cap the shared log (launchd appends forever, nothing rotates it). `cat >`
# truncates in place so the inode survives and every O_APPEND fd (launchd's
# redirect, a prefs-server tail) keeps working; `mv` would strand them.
LOG_FILE="$HOME/Library/Logs/new-music-radar.log"
if [ -f "$LOG_FILE" ] && [ "$(stat -f %z "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -c 262144 "$LOG_FILE" > "$LOG_FILE.trim" && cat "$LOG_FILE.trim" > "$LOG_FILE" && rm -f "$LOG_FILE.trim"
  log "log capped to last 256KB"
fi

. "$REPO_DIR/scripts/verify-deploy.sh"

"$NODE" scripts/run-lock.mjs --reset-log-start || { log "ERROR: refresh ownership lost"; exit 1; }
log "Fetching new releases..."
"$NODE" scripts/fetch-releases.mjs
FETCH_STATUS=$?
if [ "$FETCH_STATUS" -eq 2 ]; then
  # Don't bail: one source failing shouldn't hold the others' data hostage.
  log "ERROR: fetch failed for at least one source (publishing partial data)"
elif [ "$FETCH_STATUS" -ne 0 ]; then
  # Not 2 = the fetcher died before writing releases.json, so there is no new
  # data to publish. An unreadable config/preferences.json lands here. Bail
  # rather than fall through: the fetcher writes artist-activity.json early, so
  # a mid-run crash would otherwise commit and push an "Update data" that
  # carries no updated data.
  log "ERROR: fetch did not run (exit $FETCH_STATUS) — check config/preferences.json and the trace above"
  exit "$FETCH_STATUS"
fi

# Inspect each commit, not only the endpoint diff: reverted code is still history.
UNPUSHED="$(git rev-list --count @{u}..HEAD 2>/dev/null)" || {
  log "UNPUBLISHED: could not inspect upstream history; fetched data stays local"
  exit 1
}
OUTSIDE="$(git log --full-history --diff-merges=separate --name-only --pretty=format: @{u}..HEAD -- . ':!docs/data' ':!config')" || {
  log "UNPUBLISHED: could not inspect unpushed files; fetched data stays local"
  exit 1
}
CHANGED=1
if git diff --quiet HEAD -- docs/data config && [ -z "$(git ls-files --others --exclude-standard docs/data config)" ]; then
  CHANGED=0
fi
if [ -n "$OUTSIDE" ]; then
  if [ "$CHANGED" -eq 0 ]; then
    log "HELD: no new data, and unpushed commits touch files outside docs/data and config"
  else
    log "UNPUBLISHED: unpushed commits touch other files; fetched data stays local"
  fi
  exit "$FETCH_STATUS"
fi
if [ "$CHANGED" -eq 0 ]; then
  if [ "$UNPUSHED" -gt 0 ]; then
    git push || { log "ERROR: push failed"; exit 1; }
    log "Published"
    verify_deploy
  else
    log "No changes — nothing to publish"
  fi
  exit "$FETCH_STATUS"
fi

log "Publishing..."
git add docs/data config
# Pathspec on the commit, not just the add: this runs unattended, and a bare
# commit would sweep any unrelated staged work into the public push.
git commit -m "Update data $(date '+%Y-%m-%d %H:%M')" -- docs/data config \
  || { log "ERROR: commit failed"; exit 1; }
git push || { log "ERROR: push failed"; exit 1; }
log "Published"

verify_deploy

exit "$FETCH_STATUS"
