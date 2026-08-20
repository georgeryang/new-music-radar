---
name: verify-radar
description: Verify new-music-radar changes end-to-end — run the fetcher against the live Apple API (optionally with fault injection) and drive the built site in a headless browser.
---

# Verifying new-music-radar

Three surfaces: the nightly fetcher (CLI), the static site (GUI), and the
preferences editor (GUI).

Playwright is not a project dep and `npx playwright` refuses to auto-install.
Import it from the npx cache and pass `executablePath` explicitly — each cached
playwright pins a browser revision that may not be the one installed under
`~/Library/Caches/ms-playwright/`, and the mismatch reads as "Executable doesn't
exist" rather than a version error. On this Mac (verified 2026-07-30):
`~/.npm/_npx/88950a7d37a5e205/node_modules/playwright/index.mjs` with
`~/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
Note the arm64 directory names — the intuitive `chrome-mac/headless_shell` path
does not exist and fails with the same misleading "doesn't exist" message.

**Only chromium is installed, so focus behaviour is untested by default.**
Safari and Firefox on macOS do not focus a `<button>` on mousedown; Chrome does.
Anything built on `blur`/`focusout`/`relatedTarget` can pass every assertion
here and still be dead in the browser `prefs.command` opens (that is the user's
default, usually Safari). For those, assert the *mechanism* that makes the
browser difference irrelevant — "focus never leaves the input on mousedown" —
not the outcome, which only proves it for the browser you ran.

## Fetcher (scripts/fetch-releases.mjs)

- `node scripts/fetch-releases.mjs` — full live run, ~35s healthy. Exit 0 clean, 2 = some source failed (partial publish is by design). Writes `docs/data/releases.json` + `config/artist-activity.json` + `config/genre-activity.json` + `config/source-activity.json`; restore with `git checkout -- docs/data config` if the run was only for inspection — but if fresh UNCOMMITTED data must survive (e.g. a fault-injection run after a good fetch), back the files up to the scratchpad and restore from there; git checkout restores stale HEAD data.
- Fault injection: a `--import` preload shim that wraps `globalThis.fetch` — fail/hang/doctor URLs matching an artist id (sweep URLs uniquely contain `sort=recent`). Gotchas learned live:
  - A fake "hang" promise must hold a keep-alive handle (`setInterval`) and reject on `init.signal` abort, or Node drains the loop and exits 13 before `AbortSignal.timeout` fires.
  - Total-outage mode = fail every URL matching `apple.com`.
- NEVER run `scripts/update.sh` as a test — it commits and pushes to the live site.

## Site (docs/ build)

- `npx vite preview --port <port>` serves the built `docs/` at the correct `/new-music-radar/` base. It binds IPv6 localhost, so drive it via `http://localhost:<port>/`; `127.0.0.1` gets ECONNREFUSED (dev server also works: `npm run dev`; a vite plugin maps `/data/*.json` to `docs/data/`).
- Drive with Playwright (chromium headless-shell). Useful assertions: tab labels `#tab-new` / `#tab-upcoming`, cards `#release-panel > a`, no duplicate visible card texts, links match `music://music.apple.com/us/` and carry no `target`, artwork `*.mzstatic.com`, console messages (one `ERR_CONNECTION_REFUSED` for `127.0.0.1:4747/api/ping` is expected and by design — the site pings the local editor to decide whether to show the gear link; React dup-key warnings would also land here), ArrowLeft/ArrowRight cycles tabs.
- Remember: `src/` changes need `npm run build` and the regenerated `docs/` bundle committed, or the live site keeps the old JS.
- `src/index.css` `@source`-includes `scripts/prefs-server.mjs`, so editor class changes also need a rebuild.

## Preferences editor (scripts/prefs-server.mjs)

- `node scripts/prefs-server.mjs` then drive `http://127.0.0.1:4747/`. It also serves the built site at `/new-music-radar/`, which is the easiest way to test the site against a deliberately broken `docs/data`.
- Back up `config/preferences.json`, `config/artist-activity.json`, `config/source-activity.json` and `docs/data/releases.json` to the scratchpad first and diff shasums after: Save writes preferences.json for real. NEVER click **Save & Refresh** — it spawns `update.sh`, which publishes.
- The failure paths are the ones worth asserting, because each one used to fail silently: move `docs/data/releases.json` aside (chip counts hide instead of reading 0), write invalid JSON to `preferences.json` (error block naming the file, not a blank page), and `POST /api/quit` then wait ~11s for the next poll (offline banner).
- Dropdown rows are reachable by Tab and ArrowDown; hiding keys on focus leaving the wrapper, so a test must blur before re-focusing an input or `.focus()` fires no event and the dropdown never opens.

## Source audit (scripts/audit-sources.mjs)

- Read-only and safe to run any time except during a fetch. How to run it and how
  to read it are in `skills/audit-radar-sources/SKILL.md`.
- It depends on `config/source-activity.json`, which the fetcher appends to. To
  test multi-day behaviour without waiting, hand-write a synthetic prior day into
  that file, run the fetcher, then restore — never leave invented days in place.
- Fault-inject a feed failure (same `--import` shim as above) and confirm the
  source records `null` for the day rather than `0`. That distinction is the whole
  point of the file; a regression there silently reintroduces bad advice.
