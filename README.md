# New Music Radar

A personal website that shows new songs and albums from artists and genres you
care about — K-pop, C-pop, J-pop, Latin, R&B, and more — updated every evening.
Tap anything to open it in Apple Music.

**The site:** https://georgeryang.github.io/new-music-radar/
(works on any phone, tablet, or computer — bookmark it)

## Everyday use

Just open the site. What you'll see:

- One grid of cover art — every new release together, four per row on a
  computer, two on a phone.
- Under each cover: a small **♪** means it's a song (single), a **disc** icon
  means an album or EP.
- **★** next to an artist means they're on your preferred list.
- A small tag like **K-pop** or **Latin** shows each release's genre.
- A gold badge like **US #2** means it's currently one of the most-played
  albums on Apple Music in the US.
- **Tap or click any card** to open that release in Apple Music.

The site shows releases from roughly the last day and a half: your preferred
artists first, then everything else alphabetically by artist. Cards come from
your preferred artists plus a daily scan of Apple's US charts and new-music
playlists, filtered to your preferred genres. It refreshes itself every
evening (see setup below).

## Adding and removing artists or genres

1. Open the project folder and **double-click `prefs.command`**.
   A Terminal window opens (leave it alone) and the editor appears in your browser.
2. To add an artist: type their name in the "Add artist" box. A list of matching
   artists from Apple Music appears, each with its genre — if two artists share
   a name, click the **↗** to peek at their Apple Music page and make sure it's
   the right one, then click the one you want. Artists must be picked from
   this list, in both the preferred and blocked sections — the pick pins the
   exact artist by its Apple ID, and typed names alone can't be used.
3. To remove anything, click the **×** on its chip.
4. Blocked artists and blocked genres never appear on the site.
   Preferred genres are the only ones discovery will surface.
5. The **Discovery playlists** section lists the Apple Music playlists the
   nightly update scans for brand-new releases (New Music Daily out of the
   box). To add one, open the playlist on music.apple.com, copy the address,
   paste it into the box, and press Enter.
6. Finish with one of two buttons:
   - **Save** — keeps your changes; the site picks them up at tonight's update.
   - **Save & Refresh** — applies them right now. A progress panel shows what's
     happening; it takes about two minutes, and it's safe to close the page —
     the update keeps running and the site refreshes on its own.

A gray note like `· 2y` next to a preferred artist means their newest release
is that old, in case you want to trim the list. Nothing is removed
automatically.

When you're done, press the **Quit** button (or close the Terminal window).

## One-time setup: make it update itself every evening

Run these two commands once in Terminal (copy-paste both lines together):

```
cp ~/Dev/new-music-radar/launchd/com.georgeryang.new-music-radar.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist
```

After that, the Mac quietly updates the site once a day around 6:15 PM Korea
time (or the next time it wakes from sleep). Nothing else to do — ever.

To turn it off: `launchctl unload ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist`

## If something looks wrong

- **Site looks out of date?** The Mac that updates it may have been asleep or
  offline at update time — it catches up on its own when it wakes. To force an
  update now, open `prefs.command` and press **Save & Refresh**.
- **Want to see what happened?** The update log is at
  `~/Library/Logs/new-music-radar.log` — the last lines say what was fetched
  or what failed, in plain words.
- **An artist's releases look wrong?** You may have picked a different artist
  with the same name. Remove them in the editor and re-add them via the search
  list (the **↗** link shows exactly whose page you're pinning).

## Moving to a new Mac

The website itself works from anywhere — this is only for the computer that
performs the daily update.

1. Install `node` and `git`, and make sure `git push` to GitHub works.
2. `git clone git@github.com:georgeryang/new-music-radar.git ~/Dev/new-music-radar`
   (this exact location — the schedule file expects it).
3. Test once: `bash ~/Dev/new-music-radar/scripts/update.sh`
   (about two minutes; ends with "Published").
4. Do the one-time setup above.

## For developers

- **Data flow:** `config/preferences.json` (preferred/blocked artists + genres,
  discovery playlists) -> `scripts/fetch-releases.mjs` (zero-dep node, four
  sources: batched iTunes lookups for the follow list, the Apple US most-played
  chart for badges and discovery, US iTunes genre purchase charts for day-of
  drops in core genres, and Apple Music editorial playlists scraped from the
  web player page; everything native Apple Music: links, genres, artwork) ->
  `docs/data/releases.json` -> committed + pushed by `scripts/update.sh` ->
  GitHub Pages serves `docs/`. Every source queries the US storefront only —
  other storefronts localize artist names, which duplicates cards.
- **Frontend:** Vite + React + TS + Tailwind in `src/`; build output goes into
  `docs/` next to the data (never wiped, see vite.config.ts).
- **Scheduling:** launchd ticks every 10 min; `update.sh --if-stale` turns that
  into exactly one fetch/day anchored to 18:15 KST, timezone-proof.
- **Preferences editor:** `scripts/prefs-server.mjs`, zero-dep local server on
  127.0.0.1:4747, same-origin only (Host/Origin checks on everything but the
  site's ping). Artist entries in both lists are always `{name, id}` — the
  Apple catalog picker is the only way to add one; the fetcher sweeps
  preferred artists and drops blocked ones by ID exclusively (note: a blocked
  artist's collabs are credited to a joint entity with its own ID, so those
  aren't blocked). Playlist chips take a pasted Apple Music playlist URL;
  refresh runs detached (pidfile + shared log) so quitting the editor can't
  stop it.
- **Canonical genre tags:** `scripts/genre-map.mjs`, shared by the fetcher
  (tags releases) and the editor (offers the tags in pickers).
- **Config side file:** `config/artist-activity.json` records each artist's
  newest release date every night and drives the dormancy hints on
  preferred-artist chips.
- **Reliability patterns:** non-zero exit when a source fails entirely,
  empty-success carryover instead of stamping an empty file fresh, paced
  requests with jitter to the iTunes lookup API (other Apple hosts fetch
  concurrently), partial results still publish.
