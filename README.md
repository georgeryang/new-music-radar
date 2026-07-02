# New Music Radar

Glanceable tracker for new K-pop and pop releases (songs + albums). Successor to
r-music-radar with **no Reddit dependency** — built on Deezer editorial releases,
iTunes Search (Apple Music links + K-pop genre filter), Apple most-played charts
(charting badges), and YouTube label-channel feeds (link fallback).

- Frontend: Vite + React + TS + Tailwind + shadcn, published from `docs/` on GitHub Pages.
- Data: `scripts/fetch-releases.mjs` (zero deps) writes `docs/data/{kpop,pop}.json`,
  run once daily at 18:15 KST by launchd via `scripts/update.sh --if-stale`.
- Manual refresh: double-click `refresh.command`.
- Install the schedule: `cp launchd/com.georgeryang.new-music-radar.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist`
- Logs: `~/Library/Logs/new-music-radar.log`

Design decisions, source fallback history, and reliability patterns are documented
in the knowledge base (`~/Dev/knowledge/projects/r-music-radar.md` and successor notes).
