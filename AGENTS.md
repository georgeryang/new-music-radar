# New Music Radar

Apple-only release tracker. A local pipeline writes `docs/`; GitHub Pages serves it.

## Copy

Use `/draft-text` mechanics for README and UI copy: plain US English, no em dashes or buzzwords. Titles, headings, and README bold section names use US Title Case; buttons, labels, and body text use sentence case. Comments retain only load-bearing constraints.

## Pipeline Invariants

- One local writer: `fetch-releases.mjs` → `docs/` → Pages, scheduled by launchd through `update.sh --if-stale`. No server-side build or second writer. `run-lock.mjs` coordinates refreshes, direct fetches, audits, builds, and preference saves with macOS `lockf`. Keep the lock inode; only its owner metadata is removed. Nested fetches require the refresh owner's token.
- Foreign feeds contribute catalog IDs only; cards use US lookups. Never substitute foreign catalog metadata.
- No genre mapping. Display Apple's verbatim `primaryGenreName`; follow by exact case-insensitive name. The picker uses `scripts/genre-options.mjs`. Parent/child matching was rejected: following Pop would admit Soft Rock and Adult Contemporary. `npm run check-genres` identifies missed names to follow explicitly.
- Precedence: block > follow > genre > drop. Follow/block require Apple IDs, never names. Follow uses `via_artist_id` (discography provenance); block uses credited `artist_id`. Thus a followed member's joint-entity collaboration is starred, and blocking the member does not block a different joint-credit ID. Reapply current eligibility to carryover too.
- Fail loudly: source errors exit 2 with partial publish. Failed source days are `null`, never zero. Every count window skips them; `sourceWindow` in `scripts/shared.mjs` owns this rule.
- Card hrefs use `appleMusicAppLink` in `src/lib/utils.ts`: `music://`, not the stored canonical https link. Apple's web-player handoff offers iTunes installation on iPadOS. Accepted: no installed app means a nonworking link; an unmatched URL renders unlinked, with no web fallback.
- Filtering, labels, and New/Upcoming anchor to `fetched_at`; viewer time is only for “Updated Xh ago”. Genre chips count `WINDOW_DAYS`; source chips count `SOURCE_CHIP_DAYS` measured days; New trims discovery to 24h. Chip totals exceeding the page are intentional.
- Never add CSP meta to source `index.html`: it breaks Vite's inline Fast Refresh preamble. Any future CSP must be build-only (`transformIndexHtml`, `apply: 'build'`).
- Pages is a project site. Origin-root files (`robots.txt`, `/.well-known/*`, root favicon) and response headers are outside our control. Use meta robots for indexing. CSP `frame-ancestors` cannot work in meta; unknown paths already return real 404s.
- Automatic publication must inspect every unpushed commit, not just the endpoint diff. Unrelated history or inspection failure stops publication. Never use the live updater as a test. Build replacements in staging before replacing the index or pruning generated files; preserve `docs/data`.

## Preferences Editor

- `config/preferences.json` is the control panel: ID-pinned follow/block lists, exact genres, storefront codes, and playlists. The editor binds `127.0.0.1:4747`. Saves during background operations return 409; unsaved edits stay visible.
- Vite scans `prefs-server.mjs` only as Tailwind text. `npm run check-editor` checks the server and the inline client script; a normal build cannot detect their syntax errors. `PAGE` is a template literal: embedded backticks terminate it. Restart the server after edits because `PAGE` is built at import.
- Outcome strings are an interface: `Published`, `No changes`, `HELD:`, `ERROR: fetch did not run`, `ERROR:`, and `WARNING:`. Preserve them. `HELD:` means no new data with unrelated unpushed commits; `WARNING:` means deploy verification failed. `UNPUBLISHED:` covers new data held locally or unavailable upstream history. A new outcome needs its own prefix and client classification.

## Verification

`npm test` uses disposable repositories and mocked network/publishing. `npm run test:browser` exercises the editor and built site with intercepted requests. See `skills/verify-radar/SKILL.md` for browser setup and fixture constraints. Never restore test state with `git checkout`, or overwrite live preferences/history to inject failures.
