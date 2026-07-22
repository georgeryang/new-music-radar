#!/bin/bash
# Redundant loader for the new-music-radar launchd updater.
#
# Why this exists: after the 2026-07-21 reboot (the first since the LaunchAgent
# was created) macOS did NOT autoload the agent, despite an active console
# session, so no 10-min tick fired and the site went a full day stale. cron is a
# system daemon that loads at boot independent of the GUI-login autoload path
# that failed, so it can re-bootstrap the agent whenever it has fallen out.
#
# It does NOT run the fetch: the single writer is still launchd -> update.sh
# --if-stale. RunAtLoad on the re-bootstrapped agent fires the catch-up, and
# --if-stale keeps it to one fetch/day. Before login the gui domain does not
# exist and bootstrap fails (logged); the next tick retries and succeeds once
# the session is up.
set -u

LABEL=com.georgeryang.new-music-radar
DOMAIN="gui/$(/usr/bin/id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/new-music-radar-watchdog.log"
HB="$HOME/Library/Logs/new-music-radar-watchdog.heartbeat"

ts() { /bin/date '+%Y-%m-%d %H:%M:%S'; }

# cap the failure log — a persistently broken agent would otherwise append
# ~2 lines every 5 min forever
if [ -f "$LOG" ] && [ "$(/usr/bin/wc -l < "$LOG")" -gt 1000 ]; then
  /usr/bin/tail -n 500 "$LOG" > "$LOG.tmp" && /bin/mv "$LOG.tmp" "$LOG"
fi

if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  # Healthy path stays quiet so the log doesn't grow; the heartbeat is
  # overwritten each tick, proving liveness without accumulating.
  echo "[$(ts)] tick: agent loaded" > "$HB"
  exit 0
fi

echo "[$(ts)] agent NOT loaded — bootstrapping" | tee -a "$LOG" > "$HB"
if /bin/launchctl bootstrap "$DOMAIN" "$PLIST" >> "$LOG" 2>&1; then
  echo "[$(ts)] bootstrap OK" >> "$LOG"
else
  # non-zero so cron sees the failure too, not just this log
  rc=$?; echo "[$(ts)] bootstrap FAILED rc=$rc" >> "$LOG"
  exit 1
fi
