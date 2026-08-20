# new-music-radar — agent steering

Apple-only follow-list release tracker. Local pipeline builds `docs/`, GitHub Pages serves it.

## Copy conventions

- README and UI copy follow /draft-text mechanics: no em dashes, no buzzwords.
- Code comments are exempt from /draft-text but keep them concise. Protect the load-bearing "why"; cut restatement of what the code shows.

## Pipeline invariants

- Local-only, single-writer, push-only pipeline: `fetch-releases.mjs` → `docs/` → Pages, driven by launchd + `update.sh --if-stale`. Do not add a second writer or a server-side build.
- foreign feeds contribute catalog ids ONLY; every card built from a US lookup. US catalog only.
- Genres have NO mapping layer. Cards show Apple's verbatim primaryGenreName; the follow filter is an exact case-insensitive match; the picker offers a curated list (`scripts/genre-options.mjs`). Do not reintroduce a genre map.
- Parent/child genre matching (following `Hip-Hop/Rap` also admitting `Rap`) was proposed and declined 2026-07-29: Apple's tree puts 78 extra names under the current follow list, including `Soft Rock` and `Adult Contemporary` under `Pop`. `npm run check-genres` reports leaf genres that cost releases so they can be followed by name instead.
- Filter precedence is fixed: block > follow > genre > drop.
- Follow and block both match by Apple id only (no name matching); both lists are id-required and the prefs picker enforces it.
- Follow matches on provenance, block on credit. The sweep response is grouped per requested id, so every card records the followed artist whose discography returned it as `via_artist_id`; that is how a collab credited to a joint entity (`george & MINNIE`) is followed. Block sees only the credited id, so a blocked artist's joint-entity collab is not blocked, and one shared with a followed artist shows starred.
- The pipeline fails loudly (exit 2 + partial publish), never silently. Preserve this; never swallow errors.
- Absence is not zero: a day a source's fetch failed records `null` in `config/source-activity.json`, never `0`, and every window skips those days. `sourceWindow` in `scripts/shared.mjs` is the definition site. A transient error read as "produced nothing" is what makes a healthy source look prunable, so this belongs here rather than restated per caller.
- Card hrefs use Apple's `music://` scheme (`appleMusicAppLink` in `src/lib/utils.ts`), not the https URL stored in `link`. The https form lands on the Apple Music web player, whose own "Open in Music" hand-off offers to install iTunes on iPadOS. The rewrite lives in the UI, so `link` stays a canonical https URL and carried-over entries need no re-fetch. Two accepted consequences: a device with no Apple Music app gets a dead card, and a link the rewrite cannot match renders unlinked rather than falling back to the web player.
- One clock: windows, labels, and the New/Upcoming split all anchor to `fetched_at`. The viewer clock is only for "Updated Xh ago". Do not anchor filtering to the viewer clock.
- Three count windows are intentional: genre chips tally the fetcher's `WINDOW_DAYS`, source chips (countries, playlists, fixed feeds) tally `SOURCE_CHIP_DAYS` measured days from `source-activity.json`, and the site's New tab trims to 24h. Chip counts exceeding the page is expected, not a bug.
- Never put a `<meta http-equiv="Content-Security-Policy">` in `index.html`: `@vitejs/plugin-react` injects its Fast Refresh preamble as an inline script, so `script-src 'self'` breaks `npm run dev` while the shipped site looks fine. Inject it build-only (`transformIndexHtml` + `apply: 'build'`) if it is ever wanted.
- Pages serves this as a *project* site, so the origin root belongs to `georgeryang.github.io` and no response header is ours. `robots.txt`, `/.well-known/*`, a root `favicon.ico`, `Cache-Control`, `nosniff`, `X-Frame-Options` and CSP `frame-ancestors` are all unreachable here; `<meta name="robots">` is the only indexing lever. Unknown paths already return a real 404 from GitHub.

## Control panel

- `config/preferences.json` is the whole control panel (follow/block by Apple ID, exact-name genres, storefront-code countries, playlists).
- Local editor is `prefs-server.mjs` at `127.0.0.1:4747`.
- `npm run build` never parses `prefs-server.mjs` as JavaScript — Vite only scans it as text for Tailwind's `@source`. A syntax error there passes the build and ships, so `node --check scripts/prefs-server.mjs` is the only gate. Its page is one big template literal: a backtick anywhere inside it, including in a comment, silently terminates the string.
- The server builds `PAGE` at import, so restart it after editing the template. A still-running instance serves the old HTML and a browser test will happily pass against it.
- `node --check` covers the server module, never the client JavaScript inside `PAGE`. To gate that, boot the server, `curl` the page, extract the inline `<script>` and pass it through `new Function()`. That catches a broken client script without a browser.
- The editor classifies a finished run by grepping `update.sh`'s log for six exact strings: `Published`, `No changes`, `HELD:`, `ERROR: fetch did not run`, `ERROR:`, `WARNING:`. Rewording any of them silently misreports the outcome banner, and nothing on the producing side says so. Each already means one specific thing — `WARNING:` is "the Pages deploy did not confirm", `HELD:` is "no new data and unpushed commits are being left alone" — so a new outcome needs its own prefix rather than reusing one of these.

