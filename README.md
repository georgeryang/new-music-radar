# New Music Radar

A personal website that shows new songs and albums from artists, genres, and
countries you care about (K-Pop, Latin, Thailand's Top 100, and more),
updated every evening. Tap anything to open it in Apple Music.

**The site:** https://georgeryang.github.io/new-music-radar/
(works on any phone, tablet, or computer, so bookmark it)

## Everyday use

Just open the site. What you'll see:

- One grid of cover art, every new release together, four per row on a
  computer and two on a phone.
- Under each cover: a small **♪** means it's a song (single), a **disc** icon
  means an album or EP.
- **★** next to an artist means you follow them.
- A small tag shows each release's genre, exactly as Apple Music names it
  (**K-Pop**, **Afrobeats**, **Baladas y Boleros**).
- An **Upcoming** tab appears whenever artists you follow have pre-orders on
  the way; each card shows the release date ("Tomorrow", "In 5 days", or the
  calendar date when it's further out). A pre-order moves from Upcoming to
  the main grid with the daily evening update, once its release date arrives.
- **Tap or click any card** to open that release in Apple Music.

The site shows your followed artists first, then everything else
alphabetically by artist. A followed artist's release stays on the page for
3 days; chart and playlist finds stay for 1 day. Cards come from your
followed artists plus a daily scan of Apple's US charts, new-music playlists,
and the Top 100 and purchase charts of every country you follow, all
filtered to your followed genres.

## Adding and removing artists, genres, countries, and playlists

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
   genres discovery will show (your followed artists always appear, whatever
   their genre). Each followed genre matches releases Apple labels with
   exactly that name, so **Afrobeats** and **Amapiano** are separate picks.
   The picker offers a curated list of current mainstream genres; to follow
   any Apple genre outside the list, type its exact name and press Enter.
   Each followed genre shows how many releases the latest update found for
   it (amber `· 0` marks one that found nothing), so rarely-hitting genres
   are easy to spot and remove.
5. The **Additional countries** section lists the countries whose Apple Music
   charts the nightly update scans on top of the US ones. Pick a country from
   the list to follow it, click its chip's **×** to stop. Finds from these
   charts pass the same genre filter as everything else.
6. The **Discovery playlists** section lists the Apple Music playlists the
   nightly update scans for brand-new releases (New Music Daily and a few
   others ship by default). To add one, open the playlist on music.apple.com,
   copy the address, paste it into the box, and pick the row that appears
   (Enter works too).
7. Finish with one of two buttons:
   - **Save** keeps your changes; the site picks them up at tonight's update.
   - **Save & Refresh** applies them right now. A progress panel shows what's
     happening (its **×** hides it; the refresh keeps running); the whole
     thing takes about two minutes, and it's safe to close the page since
     the update keeps running and the site refreshes on its own. When
     it finishes, the banner is green if everything worked, amber if a source
     failed but the rest was published, red if nothing was published.

A small age tag next to a followed artist (`· 18mo`, `· 2y`) means their
newest release is that old, in case you want to trim the list (amber past
18 months, red past 3 years). The "sort: A-Z" control on the heading flips the
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

- **Data flow:** `config/preferences.json` -> `scripts/fetch-releases.mjs`
  (zero-dep node) -> `docs/data/releases.json` -> committed + pushed by
  `scripts/update.sh` -> GitHub Pages serves `docs/`. Five sources, all
  native Apple Music (links, genres, artwork):
  - Batched iTunes lookups for the follow list (also collects announced
    pre-orders into `upcoming[]` for the Upcoming tab).
  - The Apple US most-played chart.
  - US iTunes genre purchase charts (day-of drops in followed genres).
  - Apple Music editorial playlists (e.g. New Music Daily).
  - Country charts (`discovery.countries`): each followed country's
    most-played Top 100 plus purchase charts, date-filtered in-feed.

  Every card is built from a US-catalog lookup; other storefronts localize
  artist names, which would duplicate cards, so country feeds contribute
  collection ids only and entries missing from the US catalog are dropped
  until they propagate.
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
  Apple catalog picker is the only way to add one, and both fetching and
  blocking key on the ID (a blocked artist's collabs are credited to a joint
  entity with its own ID, so those aren't blocked). Refresh runs detached
  (pidfile + shared log) so quitting the editor can't stop it. The server
  also serves the built site from `docs/` at `/new-music-radar/` ("Open
  radar"), showing freshly fetched data without waiting for the Pages
  deploy. The editor has no CSS of its own; it links the app's built
  stylesheet from `docs/assets/` (an `@source` directive in `src/index.css`
  scans the editor's markup); the hashed filename is resolved on every
  request, so a rebuild never strands a stale link. After editing the
  editor's markup, run `npm run build` and restart the server.
- **Genre options:** `scripts/genre-map.mjs` exports the curated list the
  editor's picker offers (exact Apple genre names). The fetcher never maps
  genres: cards carry Apple's genre name verbatim, and the follow filter is
  an exact case-insensitive match against `genres.followed`. After editing
  the list, run
  `node scripts/check-genre-coverage.mjs` to confirm every curated name
  still exists in Apple's genre tree (Apple renames genres; a rename means
  followed releases silently stop matching). Storefront codes for
  `discovery.countries` live in `scripts/storefronts.mjs`.
- **Config side file:** `config/artist-activity.json` records each artist's
  newest release date every night and drives the dormancy hints on
  followed-artist chips.
- **Reliability patterns:**
  - Non-zero exit when any source fails (including one failed sweep batch);
    partial results still publish.
  - Empty-success carryover: never stamp an empty file fresh.
  - Paced, jittered requests to the iTunes lookup API, and a second paced
    lane for the marketingtools chart feeds (a burst of ~20 gets 503s);
    legacy RSS and the web player fetch concurrently. Failed country feeds
    get one retry pass, like sweep batches.
  - The nightly push verifies its own Pages deploy and requests one rebuild
    if it flaked (correlated to the fresh build, so a stale failed status
    can't fool it).
