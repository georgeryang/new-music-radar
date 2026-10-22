# New Music Radar

A personal website that shows new songs and albums from artists, genres, and
countries you care about (K-Pop, Latin, Thailand's Top 100, and more),
updated every evening. Tap anything to open it in Apple Music.

**The Site:** https://georgeryang.github.io/new-music-radar/
(works on any phone, tablet, or computer). On an iPhone, use Share › Add to
Home Screen to open it full screen as **Radar**.

## Everyday Use

Open the site and browse the grid. Switch between **New** and **Upcoming**
with the menu: a floating bar at the bottom on narrow screens (phones held
upright, including the iPhone Duo's outer display), and a sidebar on wider
screens. The menu appears when something is upcoming. When New mixes
followed and discovered releases, **Following** and **Discovered** narrow the
grid. After one visit the site opens offline with the last saved update. As a
Home Screen app, pull down to refresh. What the icons mean:

- **♪** = song (single), disc icon = album or EP.
- **★** means the release came from an artist you follow, collabs included, so
  the credited name can be one you never added.
- The genre tag is Apple's verbatim genre name for the release.
- **Upcoming** holds followed pre-orders, moving to the grid on release
  evening.

Followed artists show first, then everyone else alphabetically. Followed
releases stay for a few days; chart and playlist finds keep 1. Cards come
from your followed artists plus a daily scan of Apple's charts, new-music
playlists, and your followed countries, filtered to your genres.

## The Preferences Editor

Double-click `prefs.command` to open the editor in your browser.

- **Artists:** type a name, ID, or page address, then pick from the matching
  list Apple returns; that pins the pick by Apple ID, for follows and blocks
  alike, so a typed name alone won't match.
- **Genres:** pick from the curated list, or type any exact Apple genre name.
- **Additional Countries:** extra storefronts scanned on top of the US ones.
  Each adds that country's Top 100 and, where Apple runs a purchase store,
  its purchase charts too. A few storefronts have no purchase store, and
  their chips say "streaming only".
- **Discovery Playlists:** paste a music.apple.com playlist address to scan it.
- **Save** applies at tonight's update; **Save & refresh** runs now and
  publishes to the public site (about two minutes). Green means it finished
  cleanly, new releases or not; amber means it finished with something to
  look at (a source failed, the deploy did not confirm, or held-back local
  commits stopped the publish); red means nothing published.

Removing a chip offers **Undo** for a few seconds, and Cmd+S (Ctrl+S) saves.

Age tags flag followed artists with no recent releases (amber past 18
months, red past 3 years). Nothing is removed automatically.

## Setting Up on a New Computer

This is only for the computer that runs the nightly update; the site itself
works from any device.

1. Install `node`, `git`, and `gh`.
2. Clone the repo anywhere, to a path without spaces or special characters:
   `git clone git@github.com:georgeryang/new-music-radar.git`, then
   `npm install`. If you edit the project with Codex or Claude Code, also run
   `npm run setup-skills` (see below).
3. Run `gh auth login`, which lets the update verify its Pages deploy (skip
   `gh` and it skips that check, so a deploy flake goes unnoticed). Then make
   sure `git push` works (SSH key for the SSH URL; `gh auth setup-git` if you
   cloned over HTTPS).
4. Test once from the repo root: `bash scripts/update.sh` (about two minutes,
   ends with "Published", or "No changes" if the cloned data is already
   current).
5. Schedule it, pasting all six lines together from the repo root (two of
   them record the folder they run from; the last three need your password):

```
sed -e "s|/Users/georgeyang/dev/gry/new-music-radar|$PWD|g" -e "s|/Users/georgeyang|$HOME|g" launchd/com.georgeryang.new-music-radar.plist > ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist
( crontab -l 2>/dev/null | grep -v 'new-music-radar/.*watchdog.sh'; echo "*/5 * * * * $PWD/launchd/watchdog.sh" ) | crontab -
sudo install -d -o root -g wheel "/Library/Application Support/new-music-radar"
sudo install -o root -g wheel -m 755 launchd/schedule-wake.sh "/Library/Application Support/new-music-radar/"
sudo install -o root -g wheel -m 644 launchd/com.georgeryang.new-music-radar.wake.plist /Library/LaunchDaemons/ && sudo launchctl bootstrap system /Library/LaunchDaemons/com.georgeryang.new-music-radar.wake.plist
```

The first command fills in this computer's folder locations, since the
scheduler needs full paths, not `~`. The Mac updates the site once a day
around 6:15 PM Korea time, or at the next wake. The 5-minute check reloads
the scheduler if a reboot drops it, but never fetches. The last three lines wake
the Mac at 6:30 PM Korea time every day (5:30 AM US Eastern in summer, 4:30 AM
in winter), so the update runs before you're up when plugged in; on battery
it waits for the next lid-open. After editing `launchd/schedule-wake.sh`,
rerun only the fifth line; the wake job picks up the new copy within the hour.
After editing its plist, run
`sudo launchctl bootout system/com.georgeryang.new-music-radar.wake` before
rerunning the sixth line.
If an older setup used `pmset repeat`, also run `sudo pmset repeat cancel`.

To turn it off:
```
launchctl bootout gui/$(id -u)/com.georgeryang.new-music-radar
crontab -l 2>/dev/null | grep -v 'new-music-radar/.*watchdog.sh' | crontab -
sudo launchctl bootout system/com.georgeryang.new-music-radar.wake
sudo rm -rf /Library/LaunchDaemons/com.georgeryang.new-music-radar.wake.plist "/Library/Application Support/new-music-radar" /var/log/new-music-radar-wake.log
```

Wakes already scheduled for the next few days still happen; `pmset -g sched`
lists them.

## If Something Looks Wrong

- **Site Looks Out of Date?** The updating Mac was probably asleep or offline;
  it catches up when it wakes. To force it now, open `prefs.command` and press
  **Save & refresh**.
- **Want to See What Happened?** The log at `~/Library/Logs/new-music-radar.log`
  says what was fetched or failed, in plain words. If it has no recent entries,
  the scheduler itself never ran: check
  `~/Library/Logs/new-music-radar-watchdog.log`.
- **An Artist's Releases Look Wrong?** You may have picked a same-named artist.
  Remove and re-add them via the search list (the **↗** link shows whose page
  you're pinning).

## Privacy

The site sets no cookies and runs no analytics. For offline use it keeps the
last update, the site files, and recent cover art in your browser's cache.
It is static files, so the only logs are the ones any host keeps: GitHub Pages
sees the IP address of whoever opens the page, and Apple's CDN sees it too
because the cover art loads from there. The page also pings `127.0.0.1:4747` on
load, only to learn whether the preferences editor is running on your own
machine so it can show the gear button. That ping returns an empty response; every
other request to the editor is refused unless it comes from your machine.

## For Developers

- **Data Flow:** `config/preferences.json` -> `scripts/fetch-releases.mjs` ->
  `docs/data/releases.json` -> pushed by `scripts/update.sh` -> GitHub Pages
  serves `docs/`. Every discovery card records which source
  found it, and the editor lists all the sources, the fixed ones included, with
  what each has returned over 30 days.
- **Frontend:** Vite + React + TS + Tailwind in `src/`, built into `docs/`
  (never wiped). Self-hosted Plus Jakarta Sans is recopied from
  `public/fonts/` on every build.
- **Scheduling:** launchd ticks every 10 min; `update.sh --if-stale` turns
  that into one fetch a day, anchored to 18:15 KST. `launchd/watchdog.sh`
  (cron, every 5 min) re-bootstraps the agent if macOS drops it after a
  reboot. A root LaunchDaemon schedules one-off `pmset` wakes at 18:30 KST
  for the next few days. An hourly `StartCalendarInterval` at :25 is always
  already missed when that wake comes, so it fires then. Both trigger the run
  but aren't the anchor. `caffeinate -sim` only holds the Mac awake on AC
  power, so on battery the run finishes across later wakes.
- **Preferences Editor:** `scripts/prefs-server.mjs`, local-only on
  127.0.0.1:4747. Follow, block, and the star all key on Apple ID, never name.
  Also serves the built site at `/new-music-radar/`, for a refresh without a
  Pages deploy. Save again after background work finishes; unsaved changes stay in the editor.
- **Genres and Chip Counts:** no genre mapping; cards carry Apple's name
  verbatim, matched exactly ignoring case. Curated list is `scripts/genre-options.mjs`;
  storefront codes are in `scripts/storefronts.mjs`. `npm run check-genres`
  catches Apple renaming a genre out from under the list, and reports which
  unfollowed genres discovery has been dropping (tallied into
  `config/genre-activity.json` by each fetch) so a subgenre worth following
  surfaces instead of staying invisible. The three chip windows are spelled out
  on the editor page itself, and are deliberately different, so chip counts
  routinely exceed what's on the page.
- **Agent Skills:** `skills/` is version controlled with the code it
  describes; `npm run setup-skills` links it into `.agents/skills/` for Codex
  and `.claude/skills/` for Claude Code. Run setup after cloning; links are
  local and gitignored. Setup preserves unrelated entries and rejects
  collisions or missing sources. Restart Codex if skills do not appear.
  **audit-radar-sources** covers source reviews; **verify-radar** covers
  isolated checks for the pipeline, site, editor, and skills.
- **Source Audit:** `npm run audit-sources` reviews configured sources using
  live Apple probes and `config/source-activity.json`. Failed days are
  unmeasured, not zero; the report shows measured days and failed probes.
  Add `-- --discover` to find additions or replacements. Discovery includes
  purchase and streaming charts; removal advice preserves retained coverage.
  Audits refuse to run while a refresh, fetch, build, or audit is active.
- **Artist Tooling:** `npm run artists` lists, cross-references, follows,
  and blocks artists by Apple ID for external tooling. Run it with `--help`
  for its commands. Reload any open preferences editor after it changes the
  lists, because an editor save replaces both lists with what the tab loaded.
- **Reliability:** any source failing exits non-zero but still publishes
  partial results; an empty result never overwrites good data. The nightly
  push also verifies its Pages deploy and retries once if it flaked.

## Checking Changes

Use [verify-radar](skills/verify-radar/SKILL.md) to choose checks for the change.
`npm test` runs isolated regressions; `npm run check-editor` parses server and
client scripts; `npm run check-types` checks TypeScript. `npm run test:browser`
builds a temporary site and checks interactions with mocked requests. These
checks leave tracked assets untouched and do not publish. The skill lists
installation steps only when tools are missing.

`npm run build` updates the production site in `docs/`, preparing replacements
before removing old assets and preserving release data.

Automatic updates keep results locally if unrelated commits are waiting to be
pushed or upstream history cannot be checked. The editor explains when publishing
stops. Resolve the local Git state before trying another update.
