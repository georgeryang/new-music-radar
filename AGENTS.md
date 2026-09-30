# New Music Radar

Apple-only release tracker. A local pipeline writes `docs/`; GitHub Pages serves it.

## Copy

README and UI copy use plain US English, without em dashes or buzzwords. Titles, headings, and README bold section names use US Title Case; buttons, labels, and body text use sentence case. Comments retain only load-bearing constraints.

## Pipeline Invariants

- One writer: `fetch-releases.mjs` → `docs/` → Pages, scheduled by launchd through `update.sh --if-stale`. No server-side build. `run-lock.mjs` shares macOS `lockf` across refreshes, fetches, audits, builds, and saves. Keep the lock inode; remove only owner metadata. Nested fetches require the refresh owner's token.
- Foreign feeds contribute catalog IDs only; cards use US lookups. Never substitute foreign catalog metadata.
- No genre mapping or parent/child matching. Display Apple's verbatim `primaryGenreName`; follow exact case-insensitive names. The picker uses `scripts/genre-options.mjs`; `npm run check-genres` finds missed names to follow explicitly.
- Precedence: block > follow > genre > drop. Follow/block require Apple IDs, never names. Follow matches `via_artist_id`, including collaborations; block matches credited `artist_id`. Blocking a member does not block a different joint-credit ID. Reapply eligibility to carryover.
- Source errors exit 2 with partial publish. Failed days are `null`, never zero; all count windows skip them through `sourceWindow` in `scripts/shared.mjs`.
- Card hrefs use `appleMusicAppLink` in `src/lib/utils.ts`: `music://`, without a web fallback. Apple's web handoff offers iTunes installation on iPadOS. No installed app means a nonworking link; unmatched URLs render unlinked.
- Filtering, labels, and New/Upcoming anchor to `fetched_at`; viewer time only controls "Updated Xh ago". Genre chips count `WINDOW_DAYS`; source chips count `SOURCE_CHIP_DAYS` measured days; New trims discovery to 24h. Larger chip totals are intentional.
- Never add CSP meta to source `index.html`: it breaks Vite's inline Fast Refresh. CSP must be build-only (`transformIndexHtml`, `apply: 'build'`).
- Project-site Pages cannot control origin-root files or response headers. Use meta robots; `frame-ancestors` cannot work in meta. Unknown paths return real 404s.
- Automatic publication inspects every unpushed commit, not just the endpoint diff. Unrelated history or inspection failure stops publication. Stage build replacements before replacing the index or pruning files; preserve `docs/data`.

## Preferences Editor

- `config/preferences.json` controls artists, exact genres, storefronts, and playlists. The editor binds `127.0.0.1:4747`. Busy saves return 409 and preserve unsaved edits.
- Vite scans `prefs-server.mjs` as Tailwind text; `npm run check-editor` parses server and inline client syntax. Embedded backticks terminate the `PAGE` template literal. Restart after edits: `PAGE` is built at import.
- Preserve outcome strings: `Published`, `No changes`, `HELD:`, `UNPUBLISHED:`, `ERROR: fetch did not run`, `ERROR:`, and `WARNING:`. `HELD:` means no new data with unrelated unpushed commits; `UNPUBLISHED:` means data held locally or unavailable upstream history; `WARNING:` means deploy verification failed. New outcomes need a prefix and client classification.

## Verification

Use `skills/verify-radar/SKILL.md` for checks by change type. Tests use disposable fixtures and mocked network/publishing. Never test with the live updater or live **Save & refresh**, inject failures into live preferences/history, or restore state with `git checkout`.
