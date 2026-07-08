#!/bin/bash
# Daily fetch + publish, run by launchd (see launchd/com.georgeryang.new-music-radar.plist).
# Needs no node_modules — just node and git.
set -uo pipefail

# Derive the repo root from this script's own location, so the job survives
# being moved to another machine or path without editing this line.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
  # Manual runs (prefs.command's Refresh-now) skip this branch entirely.
  JITTER=$((RANDOM % 420))
  log "Last fetch predates the 18:15 KST slot — refreshing in ${JITTER}s"
  sleep "$JITTER"
fi

log "Fetching new releases..."
FETCH_FAILED=0
if ! "$NODE" scripts/fetch-releases.mjs; then
  # Don't bail: one source failing shouldn't hold the others' data hostage.
  # Publish whatever was written, then exit non-zero so the failure is logged.
  log "ERROR: fetch failed for at least one source (publishing partial data)"
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

# GitHub's Pages deploy flakes transiently ("Deployment failed, try again
# later"). During development a follow-up push always papered over it; the
# nightly data push is the only push of the day, so a single flake leaves the
# site stale for 24h. Verify the deploy for this commit and rebuild it once.
verify_deploy() {
  command -v gh >/dev/null 2>&1 || { log "gh not found — skipping deploy check"; return 0; }
  SHA="$(git rev-parse HEAD)"
  RUN_ID=""
  for _ in $(seq 1 20); do  # up to 5 min for the run to appear and finish
    RUN_ID="$(gh run list --workflow pages-build-deployment --commit "$SHA" \
      --json databaseId,status --jq '.[0] | select(.status == "completed") | .databaseId' 2>/dev/null)"
    [ -n "$RUN_ID" ] && break
    sleep 15
  done
  if [ -z "$RUN_ID" ]; then
    log "WARNING: Pages deploy not finished after 5 min — leaving it alone"
    return 0
  fi
  CONCLUSION="$(gh run view "$RUN_ID" --json conclusion --jq .conclusion 2>/dev/null)"
  case "$CONCLUSION" in
    success)   log "Pages deploy verified"; return 0 ;;
    cancelled) log "Pages deploy cancelled (superseded by a newer push) — skipping retry"; return 0 ;;
  esac
  # Not `gh run rerun --failed`: rerunning the GitHub-managed Pages workflow
  # wedges — the run sits "queued" indefinitely while reporting completed to
  # the cancel API (observed 2026-07-04). The Pages build API is the supported
  # retrigger; it's what a follow-up push does under the hood.
  # builds/latest can still be the OLD failed build right after the POST —
  # remember its url (the unique per-build handle; the API exposes no id
  # field) and skip polls that return it, or the first poll reads the stale
  # "errored" and gives up on a build that's still running.
  PREV_BUILD="$(gh api 'repos/{owner}/{repo}/pages/builds/latest' --jq .url 2>/dev/null)"
  log "Pages deploy $CONCLUSION — requesting a fresh build (run $RUN_ID)"
  gh api -X POST 'repos/{owner}/{repo}/pages/builds' >/dev/null 2>&1 \
    || { log "WARNING: could not request a rebuild"; return 0; }
  STATUS=""
  for _ in $(seq 1 20); do
    sleep 15
    read -r STATUS BUILD_URL <<<"$(gh api 'repos/{owner}/{repo}/pages/builds/latest' --jq '[.status,.url] | @tsv' 2>/dev/null)"
    if [ -z "$BUILD_URL" ] || [ "$BUILD_URL" = "$PREV_BUILD" ]; then continue; fi
    case "$STATUS" in
      built) log "Pages deploy verified after rebuild"; return 0 ;;
      errored) break ;;
    esac
  done
  log "WARNING: Pages rebuild ended '$STATUS' — site stays stale until tomorrow's run"
}
verify_deploy

exit "$FETCH_FAILED"
