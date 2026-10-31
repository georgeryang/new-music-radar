# Sourced by update.sh and cloud-refresh.sh; expects the caller's log().

# GitHub's Pages deploy flakes transiently. The nightly push is the only one
# of the day, so a single flake leaves the site stale for 24h — verify this
# commit's deploy and rebuild it once if it failed.
verify_deploy() {
  command -v gh >/dev/null 2>&1 || { log "gh not found; skipping deploy check"; return 0; }
  SHA="$(git rev-parse HEAD)"
  RUN_ID=""
  for _ in $(seq 1 20); do  # up to 5 min for the run to appear and finish
    RUN_ID="$(gh run list --workflow pages-build-deployment --commit "$SHA" \
      --json databaseId,status --jq '.[0] | select(.status == "completed") | .databaseId' 2>/dev/null)"
    [ -n "$RUN_ID" ] && break
    sleep 15
  done
  if [ -z "$RUN_ID" ]; then
    log "WARNING: Pages deploy not finished after 5 min; leaving it alone"
    return 0
  fi
  CONCLUSION="$(gh run view "$RUN_ID" --json conclusion --jq .conclusion 2>/dev/null)"
  case "$CONCLUSION" in
    success)   log "Pages deploy verified"; return 0 ;;
    cancelled) log "Pages deploy cancelled (superseded by a newer push); skipping retry"; return 0 ;;
  esac
  # Not `gh run rerun --failed`: rerunning the managed Pages workflow wedges
  # (sits "queued" forever while reporting completed, observed 2026-07-04). The
  # Pages build API is the supported retrigger, as a follow-up push uses.
  # builds/latest can still be the OLD failed build right after the POST, so
  # remember its url (the per-build handle; no id field) and skip polls that
  # return it, or the first poll reads the stale "errored" and gives up early.
  PREV_BUILD="$(gh api 'repos/{owner}/{repo}/pages/builds/latest' --jq .url 2>/dev/null)"
  log "Pages deploy $CONCLUSION; requesting a fresh build (run $RUN_ID)"
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
  log "WARNING: Pages rebuild ended '$STATUS'; the site stays stale until tomorrow's run"
}
