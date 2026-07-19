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
- An **Upcoming** tab appears when followed artists have pre-orders on the way,
  each with its release date ("Tomorrow", "In 5 days", or a calendar date). A
  pre-order moves to the main grid on the evening its date arrives.
- **Tap or click any card** to open that release in Apple Music.

Followed artists show first, then everyone else alphabetically. A followed
artist's release stays 3 days; chart and playlist finds stay 1 day. Cards come
from your followed artists plus a daily scan of Apple's US charts, new-music
playlists, and every followed country's Top 100 and purchase charts, all
filtered to your followed genres.

## Adding and removing artists, genres, countries, and playlists

1. Open the project folder and **double-click `prefs.command`**.
   A Terminal window opens (leave it alone) and the editor appears in your browser.
2. To add an artist: type their name (or paste an Apple artist ID or their
   Apple Music page address) in the "Add artist" box, then pick from the
   matching artists Apple Music returns (each shown with its genre; use the
   **↗** to check an Apple Music page if two share a name). Picking from this
   list is required in both sections; it pins the exact artist by Apple ID,
   so a typed name alone won't match.
3. To remove anything, click the **×** on its chip.
4. Blocked artists never appear. Followed genres are the only genres discovery
   shows (followed artists always appear, whatever their genre). A genre
   matches releases Apple labels with exactly that name, so **Afrobeats** and
   **Amapiano** are separate picks; the picker offers a curated list, and any
   other Apple genre is followable by typing its exact name and pressing Enter.
   Each genre chip shows how many releases the last update found (amber `· 0`
   means none), so rarely-hitting genres are easy to spot.
5. **Additional countries** are the storefronts scanned on top of the US ones.
   Pick one from the list to follow, click its **×** to stop. Finds pass the
   same genre filter as everything else.
6. **Discovery playlists** are the Apple Music playlists scanned for brand-new
   releases (New Music Daily and a few others ship by default). To add one,
   copy its music.apple.com address, paste it into the box, and pick the row
   that appears.
7. Finish with one of two buttons:
   - **Save** keeps your changes; the site picks them up at tonight's update.
   - **Save & Refresh** applies them right now (about two minutes); a
     progress panel shows what's happening (its **×** hides it, the refresh
     keeps running). It's safe to close the page: the update keeps running
     and the site refreshes on its own. The banner is green when everything
     worked, amber if a source failed but the rest published, red if nothing
     published.

An age tag next to a followed artist (`· 18mo`, `· 2y`) means their newest
release is that old (amber past 18 months, red past 3 years), in case you want
to trim the list. The "sort: A-Z" control flips it to oldest-release-first so
those cluster at the top. Nothing is removed automatically.

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

- **Site looks out of date?** The updating Mac was probably asleep or offline;
  it catches up when it wakes. To force it now, open `prefs.command` and press
  **Save & Refresh**.
- **Want to see what happened?** The log at `~/Library/Logs/new-music-radar.log`
  says what was fetched or failed, in plain words.
- **An artist's releases look wrong?** You may have picked a same-named artist.
  Remove and re-add them via the search list (the **↗** link shows whose page
  you're pinning).

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
  `scripts/update.sh` -> GitHub Pages serves `docs/`. Five sources, all native
  Apple Music (links, genres, artwork):
  - Batched iTunes lookups for the follow list (also collects pre-orders into
    `upcoming[]`).
  - The US most-played chart.
  - US iTunes genre purchase charts (day-of drops in followed genres).
  - Editorial playlists (e.g. New Music Daily).
  - Country charts (`discovery.countries`): each country's most-played Top 100
    plus purchase charts, date-filtered in-feed.

  Every card is built from a US-catalog lookup; other storefronts localize
  artist names (which would duplicate cards), so country feeds contribute
  collection ids only and US-catalog misses are dropped until they propagate.
- **Frontend:** Vite + React + TS + Tailwind in `src/`; build output goes into
  `docs/` next to the data (never wiped, see vite.config.ts). Self-hosted Plus
  Jakarta Sans from `public/fonts/`; the build wipes and recopies `docs/fonts`
  like `docs/assets`, so renamed font files can't go stale.
- **Scheduling:** launchd ticks every 10 min; `update.sh --if-stale` makes that
  exactly one fetch/day anchored to 18:15 KST, timezone-proof.
- **Preferences editor:** `scripts/prefs-server.mjs`, zero-dep local server on
  127.0.0.1:4747, same-origin only (Host/Origin checks on all but the site's
  ping). Artist entries are always `{name, id}` (the picker is the only way to
  add one; fetching and blocking key on the ID). Refresh runs detached so
  quitting the editor can't stop it. The server also serves the built site at
  `/new-music-radar/` ("Open radar") for fresh data without the Pages deploy.
  The editor has no CSS of its own: it links the app's built stylesheet (an
  `@source` directive in `src/index.css` scans the editor markup) by a hash
  resolved per request, so a rebuild never strands a stale link. After editing
  the markup, run `npm run build` and restart the server.
- **Genre options:** `scripts/genre-options.mjs` is the curated picker list. The
  fetcher never maps genres: cards carry Apple's name verbatim, the follow
  filter is an exact case-insensitive match against `genres.followed`. After
  editing, run `node scripts/check-genre-coverage.mjs` to confirm every name
  still exists in Apple's tree (a rename means followed releases stop matching).
  Storefront codes for `discovery.countries` live in `scripts/storefronts.mjs`.
- **Source yield counts:** country and playlist chips carry a unique/duplicate/
  total marker from the latest update (e.g. "2/4/6": 2 only that source found,
  4 shared, 6 total), driven by `sources` tags the fetcher writes on discovery
  releases. Genre chips carry a single-count version. All count over the
  fetcher's full `WINDOW_DAYS` (3 days), not the 24h the New tab trims
  discovery to, so a chip's count routinely exceeds what's on the page.
- **Config side file:** `config/artist-activity.json` records each artist's
  newest release date nightly, driving the dormancy hints.
- **Reliability patterns:**
  - Non-zero exit when any source fails (including one sweep batch); partial
    results still publish.
  - Empty-success carryover: never stamp an empty file fresh.
  - Paced, jittered iTunes lookups, plus a second paced lane for the
    marketingtools feeds (a burst of ~20 gets 503s); legacy RSS and the web
    player fetch concurrently. Failed country feeds get one retry pass.
  - The nightly push verifies its own Pages deploy and requests one rebuild if
    it flaked (correlated to the fresh build, so a stale status can't fool it).
