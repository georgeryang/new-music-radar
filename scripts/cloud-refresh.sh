#!/bin/bash
# The Cloud Run job's refresh (cloud/entry.sh clones the repo and runs this).
# update.sh remains the Mac's manual fallback; never run both against one branch.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || exit 1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
. "$REPO_DIR/scripts/verify-deploy.sh"

IF_STALE=0
PUSH=1
for arg in "$@"; do
  case "$arg" in
    --if-stale) IF_STALE=1 ;;
    --force) IF_STALE=0 ;;
    --no-push) PUSH=0 ;;
    *) log "ERROR: unknown argument '$arg' (usage: cloud-refresh.sh [--if-stale|--force] [--no-push])"; exit 1 ;;
  esac
done

if [ "$IF_STALE" -eq 1 ]; then
  STALE="$(node scripts/is-stale.mjs 2>&1)"
  case "$STALE" in
    0) log "No changes: the last fetch already covers the latest 18:15 KST slot"; exit 0 ;;
    1) log "Last fetch predates the 18:15 KST slot — refreshing" ;;
    *) log "NOTE: staleness probe failed, refreshing anyway ($(printf '%s' "${STALE:-no output}" | head -1))" ;;
  esac
fi

log "Fetching new releases..."
node scripts/fetch-releases.mjs
FETCH_STATUS=$?
if [ "$FETCH_STATUS" -eq 2 ]; then
  log "ERROR: fetch failed for at least one source (publishing partial data)"
elif [ "$FETCH_STATUS" -ne 0 ]; then
  log "ERROR: fetch did not run (exit $FETCH_STATUS) — check config/preferences.json and the trace above"
  exit "$FETCH_STATUS"
fi

if git diff --quiet HEAD -- docs/data config && [ -z "$(git ls-files --others --exclude-standard docs/data config)" ]; then
  log "No changes — nothing to publish"
  exit 0
fi

git add docs/data config
git commit -q -m "Update data $(date '+%Y-%m-%d %H:%M')" -- docs/data config || { log "ERROR: commit failed"; exit 1; }

if [ "$PUSH" -eq 0 ]; then
  git show --stat --format='%h %s' HEAD
  log "No changes published: --no-push"
  exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
push() { git push -q origin "HEAD:refs/heads/$BRANCH"; }
if ! push; then
  log "push failed — checking the remote"
  git fetch -q origin "$BRANCH" || { log "ERROR: push failed and the remote could not be read"; exit 1; }
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)" ]; then
    log "push reported an error but the commit landed"
  elif [ -n "$(git log --format=%h --grep '^Update data' HEAD..FETCH_HEAD)" ]; then
    log "No changes: a newer run already published"
    exit 0
  else
    git diff --quiet HEAD...FETCH_HEAD -- config/preferences.json \
      || log "NOTE: preferences changed during this run; they apply at the next refresh"
    if ! git rebase -q FETCH_HEAD; then
      git rebase --abort
      log "ERROR: push failed — the remote changed and could not be rebased onto"
      exit 1
    fi
    push || { log "ERROR: push failed"; exit 1; }
  fi
fi
log "Published"
verify_deploy
exit 0
