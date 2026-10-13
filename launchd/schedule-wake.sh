#!/bin/bash
# Not pmset repeat: it takes local time, which drifts from KST with DST and travel.
# One-off pmset schedule events are absolute instants.
set -u

WAKE_UTC_SECONDS=$(( (9 * 60 + 30) * 60 ))  # 09:30 UTC = 18:30 KST, after the 18:15 KST slot
DAYS_AHEAD=3

now=$(/bin/date +%s)
midnight_utc=$(( now - now % 86400 ))
scheduled=$(/usr/bin/pmset -g sched)

for i in $(/usr/bin/seq 0 "$DAYS_AHEAD"); do
  t=$(( midnight_utc + i * 86400 + WAKE_UTC_SECONDS ))
  [ "$t" -gt $(( now + 60 )) ] || continue
  /usr/bin/grep -qF "wakeorpoweron at $(/bin/date -r "$t" '+%m/%d/%Y %H:%M:%S') by 'pmset'" <<< "$scheduled" && continue
  if /usr/bin/pmset schedule wakeorpoweron "$(/bin/date -r "$t" '+%m/%d/%y %H:%M:%S')"; then
    echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] scheduled wake $(/bin/date -r "$t" '+%Y-%m-%d %H:%M %Z')"
  else
    echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] FAILED to schedule wake $(/bin/date -r "$t" '+%Y-%m-%d %H:%M %Z')"
  fi
done
