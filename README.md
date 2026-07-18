# New Music Radar

A personal website that shows new songs and albums from artists and genres you
care about (K-pop, C-pop, J-pop, Latin, R&B, and more), updated every evening.
Tap anything to open it in Apple Music.

**The site:** https://georgeryang.github.io/new-music-radar/
(works on any phone, tablet, or computer, so bookmark it)

## Everyday use

Just open the site. What you'll see:

- One grid of cover art, every new release together, four per row on a
  computer and two on a phone.
- Under each cover: a small **♪** means it's a song (single), a **disc** icon
  means an album or EP.
- **★** next to an artist means you follow them.
- A small tag like **K-pop** or **Latin** shows each release's genre.
- An **Upcoming** tab appears whenever artists you follow have pre-orders on
  the way; each card shows the release date ("Tomorrow", "In 5 days", or the
  calendar date when it's further out). A pre-order moves from Upcoming to
  the main grid with the daily evening update, once its release date arrives.
- **Tap or click any card** to open that release in Apple Music.

The site shows your followed artists first, then everything else
alphabetically by artist. A followed artist's release stays on the page for
3 days; chart and playlist finds stay for 1 day. Cards come from
your followed artists plus a daily scan of Apple's US charts and new-music
playlists, filtered to your followed genres. It refreshes itself every
evening (see setup below).

## Adding and removing artists, genres, and playlists

1. Open the project folder and **double-click `prefs.command`**.
   A Terminal window opens (leave it alone) and the editor appears in your browser.
2. To add an artist: type their name (or paste an Apple artist ID or their
   Apple Music page address) in the "Add artist" box. A list of matching
   artists from Apple Music appears, each with its genre. If two artists share
   a name, click the **↗** to peek at their Apple Music page and make sure
   it's the right one, then click the one you want. Artists must be picked
   from this list, in both the followed and blocked sections. The pick pins
   the exact artist by its Apple ID; typed names alone can't be used.
3. To remove anything, click the **×** on its chip.
4. Blocked artists never appear on the site. Followed genres are the only
   genres discovery will surface (your followed artists always show, whatever
   their genre).
5. The **Discovery playlists** section lists the Apple Music playlists the
   nightly update scans for brand-new releases (New Music Daily and a few
   others ship by default). To add one, open the playlist on music.apple.com,
   copy the address, paste it into the box, and pick the row that appears
   (Enter works too).
6. Finish with one of two buttons:
   - **Save** keeps your changes; the site picks them up at tonight's update.
   - **Save & Refresh** applies them right now. A progress panel shows what's
     happening; it takes about two minutes, and it's safe to close the page
     since the update keeps running and the site refreshes on its own. When
     it finishes, the banner is green if everything worked, amber if a source
     failed but the rest was published, red if nothing was published.

A small age tag next to a followed artist (`· 18mo`, `· 2y`) means their
newest release is that old, in case you want to trim the list — amber past
18 months, red past 3 years. The "sort: A-Z" control on the heading flips the
list to oldest release first so those cluster at the top. Nothing is removed
automatically.

When you're done, press the **Quit** button (or close the Terminal window).

## One-time setup: make it update itself every evening

Run these two commands once in Terminal (copy-paste both lines together):

```
cp ~/dev/new-music-radar/launchd/com.georgeryang.new-music-radar.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.georgeryang.new-music-radar.plist
```

After that, the Mac quietly updates the site once a day around 6:15 PM Korea
time (or the next time it wakes from sleep). Nothing else to do.

To turn it off: `launchctl bootout gui/$(id -u)/com.georgeryang.new-music-radar`

## If something looks wrong

- **Site looks out of date?** The Mac that updates it may have been asleep or
  offline at update time; it catches up on its own when it wakes. To force an
  update now, open `prefs.command` and press **Save & Refresh**.
- **Want to see what happened?** The update log is at
  `~/Library/Logs/new-music-radar.log`. The last lines say what was fetched or
  what failed, in plain words.
- **An artist's releases look wrong?** You may have picked a different artist
  with the same name. Remove them in the editor and re-add them via the search
  list (the **↗** link shows exactly whose page you're pinning).

## Moving to a new Mac

The website itself works from anywhere; this is only for the computer that
performs the daily update.

1. Install `node` and `git`, and make sure `git push` to GitHub works.
2. `git clone git@github.com:georgeryang/new-music-radar.git ~/dev/new-music-radar`
   (this exact location, the schedule file expects it).
3. Test once: `bash ~/dev/new-music-radar/scripts/update.sh`
   (about two minutes; ends with "Published").
4. Do the one-time setup above.

## For developers

- **Data flow:** `config/preferences.json` (followed/blocked artists,
  followed genres, discovery playlists) -> `scripts/fetch-releases.mjs`
  (zero-dep node, four sources: batched iTunes lookups for the follow list —
  which also collect announced pre-orders into `upcoming[]` for the site's
  Upcoming tab — the Apple US most-played chart for discovery, US iTunes
  genre purchase charts for day-of drops in a core set of your followed
  genres (song-chart tracks resolve to their parent single/album, so every
  card is one Apple collection), and Apple Music editorial playlists scraped
  from the web player page; everything native Apple Music: links, genres,
  artwork) ->
  `docs/data/releases.json` ->
  committed + pushed by `scripts/update.sh` -> GitHub Pages serves `docs/`.
  Every source queries the US storefront only; other storefronts localize
  artist names, which duplicates cards.
- **Frontend:** Vite + React + TS + Tailwind in `src/`; build output goes into
  `docs/` next to the data (never wiped, see vite.config.ts). The UI uses
  self-hosted Plus Jakarta Sans from `public/fonts/` (copied to `docs/fonts/`
  on build; the build script wipes and recopies `docs/fonts` the same way it
  does `docs/assets`, so renamed files can't go stale).
- **Scheduling:** launchd ticks every 10 min; `update.sh --if-stale` turns
  that into exactly one fetch/day anchored to 18:15 KST, timezone-proof.
- **Preferences editor:** `scripts/prefs-server.mjs`, zero-dep local server on
  127.0.0.1:4747, same-origin only (Host/Origin checks on everything but the
  site's ping). Artist entries in both lists are always `{name, id}`: the
  Apple catalog picker is the only way to add one, the fetcher sweeps
  followed artists by ID, and blocked artists are dropped by ID (note: a
  blocked artist's collabs are credited to a joint entity with its own ID, so
  those aren't blocked). Playlist chips take a pasted Apple Music playlist
  URL; refresh runs detached (pidfile + shared log) so quitting the editor
  can't stop it. The server also serves the built site from `docs/` at
  `/new-music-radar/`, which is where "Open radar" points: the local copy
  shows freshly fetched data right away, without waiting for the Pages
  deploy. The editor has no CSS of its own — it links the app's built
  stylesheet from `docs/assets/` (an `@source` directive in `src/index.css`
  scans the editor's markup, so both UIs share one set of Tailwind tokens
  and the same font; still zero-dep — it's a `<link>`, not a package). The
  hashed filename is resolved on every request, so a rebuild never strands
  a stale link; after editing the editor's markup, run `npm run build` and
  restart the server to see it. If `docs/assets/` were ever empty the page
  falls back to unstyled-but-working HTML.
- **Canonical genre tags:** `scripts/genre-map.mjs`, shared by the fetcher
  (tags releases) and the editor (offers the tags in the genre picker).
- **Config side file:** `config/artist-activity.json` records each artist's
  newest release date every night and drives the dormancy hints on
  followed-artist chips.
- **Reliability patterns:** non-zero exit when any source fails (including a
  single failed artist-sweep batch), empty-success carryover instead of
  stamping an empty file fresh, paced requests with jitter to the iTunes
  lookup API (other Apple hosts fetch concurrently), partial results still
  publish, and the nightly push verifies its own Pages deploy and requests
  one rebuild if it flaked (correlated to the fresh build, so a stale failed
  status can't fool it).
