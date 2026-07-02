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
  The nightly commit also sweeps up `config/` changes, so preference edits are
  backed up automatically.
- Manual refresh: double-click `refresh.command`.
- Edit preferences (preferred/blocked artists + genres): double-click `prefs.command` → local editor at http://localhost:4747 with a Deezer artist picker.
- Logs: `~/Library/Logs/new-music-radar.log`

## Set up on a new device (macOS)

The site itself works from any device via GitHub Pages — this setup is only for
the machine that fetches (must be a Mac on a residential connection, with
push access to this repo).

1. Install node (any recent version; nvm is fine) and git, and make sure
   `git push` works without prompts (SSH key or credential helper).
2. `git clone git@github.com:georgeryang/new-music-radar.git ~/Dev/new-music-radar`
   — the launchd plist and update.sh hardcode this path; adjust both if you
   clone elsewhere.
3. Test one fetch: `bash scripts/update.sh` (takes ~15 min; ends with "Published").
4. Install the daily 18:15 KST schedule:
   ```
   cp launchd/com.georgeryang.new-music-radar.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist
   ```
   launchd ticks every 10 minutes and `--if-stale` turns that into exactly one
   fetch per day in the 18:15–18:30 KST window (or first wake after). To
   uninstall: `launchctl unload` the same path, then delete the file.
5. Frontend development only: `npm install`, then `npm run dev` / `npm run build`.
   The fetch pipeline needs no node_modules.

Design decisions, source fallback history, and reliability patterns are documented
in the knowledge base (`~/Dev/knowledge/projects/r-music-radar.md` and successor notes).
