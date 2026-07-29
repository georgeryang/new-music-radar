# New Music Radar

A personal website that shows new songs and albums from artists, genres, and
countries you care about (K-Pop, Latin, Thailand's Top 100, and more),
updated every evening. Tap anything to open it in Apple Music.

**The site:** https://georgeryang.github.io/new-music-radar/
(works on any phone, tablet, or computer, so bookmark it)

## Everyday use

Open the site and browse the grid. What the icons mean:

- **♪** = song (single), disc icon = album or EP.
- **★** next to an artist means you follow them.
- The genre tag is Apple's verbatim genre name for the release.
- **Upcoming** holds followed pre-orders, moving to the grid on release
  evening.

Followed artists show first, then everyone else alphabetically. Followed
releases keep 3 days; chart and playlist finds keep 1. Cards come from your
followed artists plus a daily scan of Apple's charts, new-music playlists,
and your followed countries, filtered to your genres.

## The preferences editor

Double-click `prefs.command` to open the editor in your browser.

- **Artists:** type a name, ID, or page address, then pick from the matching
  list Apple returns; that pins the pick by Apple ID, for follows and blocks
  alike, so a typed name alone won't match.
- **Genres:** pick from the curated list, or type any exact Apple genre name.
- **Additional countries:** extra storefronts scanned on top of the US ones.
- **Discovery playlists:** paste a music.apple.com playlist address to scan it.
- **Save** applies at tonight's update; **Save & Refresh** runs now (about
  two minutes). Green means all good; amber means a source failed but the
  rest published; red means nothing published.

Age tags flag followed artists with no recent releases (amber past 18
months, red past 3 years). Nothing is removed automatically.

## Setting up on a new computer

This is only for the computer that runs the nightly update; the site itself
works from any device.

1. Install `node`, `git`, and `gh`.
2. Clone the repo anywhere, to a path without spaces or special characters:
   `git clone git@github.com:georgeryang/new-music-radar.git`
3. Run `gh auth login`, which lets the update verify its Pages deploy (skip
   `gh` and it skips that check, so a deploy flake goes unnoticed). Then make
   sure `git push` works (SSH key for the SSH URL; `gh auth setup-git` if you
   cloned over HTTPS).
4. Test once from the repo root: `bash scripts/update.sh` (about two minutes,
   ends with "Published", or "No changes" if the cloned data is already
   current).
5. Schedule it, pasting all four lines together from the repo root (two of
   them record the folder they run from; the last asks for your password):

```
sed -e "s|/Users/georgeyang/dev/new-music-radar|$PWD|g" -e "s|/Users/georgeyang|$HOME|g" launchd/com.georgeryang.new-music-radar.plist > ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist
( crontab -l 2>/dev/null | grep -v 'new-music-radar/.*watchdog.sh'; echo "*/5 * * * * $PWD/launchd/watchdog.sh" ) | crontab -
sudo pmset repeat wakeorpoweron MTWRFSU 05:30:00
```

The first command fills in this computer's folder locations, since the
scheduler needs full paths, not `~`. The Mac updates the site once a day
around 6:15 PM Korea time, or at the next wake. The 5-minute check reloads
the scheduler if a reboot drops it, but never fetches. The 5:30 wake runs
the update before you're up when plugged in; on battery it waits for the
next lid-open.

To turn it off:
```
launchctl bootout gui/$(id -u)/com.georgeryang.new-music-radar
crontab -l 2>/dev/null | grep -v 'new-music-radar/.*watchdog.sh' | crontab -
sudo pmset repeat cancel
```

## If something looks wrong

- **Site looks out of date?** The updating Mac was probably asleep or offline;
  it catches up when it wakes. To force it now, open `prefs.command` and press
  **Save & Refresh**.
- **Want to see what happened?** The log at `~/Library/Logs/new-music-radar.log`
  says what was fetched or failed, in plain words. If it has no recent entries
  at all, the scheduler itself never ran: check
  `~/Library/Logs/new-music-radar-watchdog.log`.
- **An artist's releases look wrong?** You may have picked a same-named artist.
  Remove and re-add them via the search list (the **↗** link shows whose page
  you're pinning).

## For developers

- **Data flow:** `config/preferences.json` -> `scripts/fetch-releases.mjs` ->
  `docs/data/releases.json` -> pushed by `scripts/update.sh` -> GitHub Pages
  serves `docs/`. Five sources, all resolved through US-catalog lookups: the
  follow list (also collects pre-orders into `upcoming[]`), the US
  most-played chart, US genre purchase charts, editorial playlists, and
  country charts. Foreign storefronts contribute ids only, never card data.
- **Frontend:** Vite + React + TS + Tailwind in `src/`, built into `docs/`
  (never wiped). Self-hosted Plus Jakarta Sans is recopied from
  `public/fonts/` on every build.
- **Scheduling:** launchd ticks every 10 min; `update.sh --if-stale` turns
  that into one fetch a day, anchored to 18:15 KST. `launchd/watchdog.sh`
  (cron, every 5 min) re-bootstraps the agent if macOS drops it after a
  reboot. `caffeinate -sim` holds the Mac awake mid-run; a `pmset` wake at
  05:30 and a `StartCalendarInterval` at 05:25 just trigger that run at the
  right moment; they aren't the anchor.
- **Preferences editor:** `scripts/prefs-server.mjs`, local-only on
  127.0.0.1:4747. Follow, block, and the followed star all key on Apple ID,
  never name. Also serves the built site at `/new-music-radar/`, for a
  refresh without a Pages deploy.
- **Genres and chip counts:** no genre mapping; cards carry Apple's name
  verbatim, matched exactly ignoring case. Curated list is `scripts/genre-options.mjs`;
  storefront codes are in `scripts/storefronts.mjs`; `npm run check-genres`
  catches Apple renaming a genre out from under the list. Editor chips count
  over the fetcher's full `WINDOW_DAYS`, not the site's 24h New tab, so chip
  counts routinely exceed what's on the page.
- **Reliability:** any source failing exits non-zero but still publishes
  partial results; an empty result never overwrites good data. The nightly
  push also verifies its Pages deploy and retries once if it flaked.
