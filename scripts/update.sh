#!/bin/bash
# Daily fetch + publish, run by launchd (see launchd/com.georgeryang.new-music-radar.plist).
# Needs no node_modules — just node and git.
set -uo pipefail

# Repo root from this script's own location, so a machine/path move needs no edit.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || exit 1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

. "$REPO_DIR/scripts/find-node.sh"
if [ -z "$NODE" ]; then
  log "ERROR: node not found on PATH or under ~/.nvm/versions/node/*/bin — install node, or point scripts/find-node.sh at it"
  exit 1
fi

# --if-stale (from launchd): one fetch per day, anchored to 18:15 KST (Korean
# evening release time). Stale = last fetch predates the most recent 18:15 KST.
# KST is UTC+9 no-DST, so this is pure UTC arithmetic, timezone-independent.
# launchd ticks every 10 min while awake, so the fetch lands in the 18:15–18:30
# window (or at first wake after).
if [ "${1:-}" = "--if-stale" ]; then
  STALE="$("$NODE" --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { DATA_PATH } from "./scripts/shared.mjs";
    const KST = 9 * 3600e3, DAY = 86400e3, SLOT = (18 * 60 + 15) * 60e3;
    const kstNow = Date.now() + KST;
    let slot = Math.floor(kstNow / DAY) * DAY + SLOT;
    if (slot > kstNow) slot -= DAY;
    let fetchedAt = 0;
    try { fetchedAt = JSON.parse(readFileSync(DATA_PATH, "utf8")).fetched_at } catch {}
    process.stdout.write(fetchedAt < slot - KST ? "1" : "0");
  ' 2>&1)"
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
  # No jitter here: a sleep only advances during wakes, and the lid-closed 05:30 dark
  # wake has a 30-45s budget — a 414s jitter left the 05:30 fire waiting at 07:57.
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

# GitHub's Pages deploy flakes transiently. The nightly push is the only one
# of the day, so a single flake leaves the site stale for 24h — verify this
# commit's deploy and rebuild it once if it failed.
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
  # Not `gh run rerun --failed`: rerunning the managed Pages workflow wedges
  # (sits "queued" forever while reporting completed, observed 2026-07-04). The
  # Pages build API is the supported retrigger, as a follow-up push uses.
  # builds/latest can still be the OLD failed build right after the POST, so
  # remember its url (the per-build handle; no id field) and skip polls that
  # return it, or the first poll reads the stale "errored" and gives up early.
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

# config/ rides along: preference edits apply from disk at fetch time and get
# backed up with the nightly data commit — no manual git.
if git diff --quiet docs/data config && [ -z "$(git ls-files --others --exclude-standard docs/data config)" ]; then
  # An earlier run may have committed and then failed to push; nothing else
  # retries that, and later runs see a clean tree and report success while the
  # live site stays stale.
  #
  # Only retry when every unpushed commit is data. Local commits that touch
  # anything else are someone's work-in-progress held back on purpose, and this
  # runs unattended at 18:15 with no one to notice it publishing them.
  # `git log --name-only`, not `git diff`: a diff compares the two endpoints, so a
  # file added in one unpushed commit and deleted in a later one cancels out and
  # the whole range gets published.
  UNPUSHED="$(git rev-list --count @{u}..HEAD 2>/dev/null || echo 0)"
  if [ "$UNPUSHED" -gt 0 ] && [ -z "$(git log --name-only --pretty=format: @{u}..HEAD -- . ':!docs/data' ':!config')" ]; then
    log "Unpushed data commits from an earlier run — pushing"
    git push || { log "ERROR: push failed"; exit 1; }
    log "Published"
    verify_deploy
  elif [ "$UNPUSHED" -gt 0 ]; then
    log "HELD: no new data, and $UNPUSHED unpushed commit(s) touch files outside docs/data and config, so they are left alone — push them yourself if they are meant to go live"
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
