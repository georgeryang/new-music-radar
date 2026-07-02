# New Music Radar

Glanceable tracker for new music releases (songs + albums) across K-pop, pop,
and international genres, on one genre-tagged page. Successor to r-music-radar
with **no Reddit dependency** — built on Deezer editorials and artist lookups,
iTunes Search (Apple Music links + genre tags), Apple most-played charts
(charting badges), and kpop label-channel feeds (same-day releases + MV links).

Curation lives in `config/preferences.json`: preferred/blocked artists and
genres, plus which Deezer editorials feed the page. `scripts/suggest-artists.mjs`
ranks your local Music.app library to help seed the preferred list.

- Frontend: Vite + React + TS + Tailwind + shadcn, published from `docs/` on GitHub Pages.
- Data: `scripts/fetch-releases.mjs` (zero deps) writes `docs/data/releases.json`,
  run once daily at 18:15 KST by launchd via `scripts/update.sh --if-stale`.
- Manual refresh: double-click `refresh.command`.
- Edit preferences (preferred/blocked artists + genres): double-click `prefs.command` → local editor at http://localhost:4747 with a Deezer artist picker.
- Install the schedule: `cp launchd/com.georgeryang.new-music-radar.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist`
- Logs: `~/Library/Logs/new-music-radar.log`

Design decisions, source fallback history, and reliability patterns are documented
in the knowledge base (`~/Dev/knowledge/projects/r-music-radar.md` and successor notes).
