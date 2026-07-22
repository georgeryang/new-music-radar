# new-music-radar — agent steering

Apple-only follow-list release tracker. Local pipeline builds `docs/`, GitHub Pages serves it.

## Copy conventions

- README and UI copy follow /draft-text mechanics: no em dashes, no buzzwords.
- Code comments are exempt from /draft-text but keep them concise. Protect the load-bearing "why"; cut restatement of what the code shows.

## Pipeline invariants

- Local-only, single-writer, push-only pipeline: `fetch-releases.mjs` → `docs/` → Pages, driven by launchd + `update.sh --if-stale`. Do not add a second writer or a server-side build.
- foreign feeds contribute catalog ids ONLY; every card built from a US lookup. US catalog only.
- Genres have NO mapping layer. Cards show Apple's verbatim primaryGenreName; the follow filter is an exact case-insensitive match; the picker offers a curated 19-name list. Do not reintroduce a genre map.
- Filter precedence is fixed: block > follow > genre > drop.
- Follow and block both match by Apple `artist_id` only (no name matching); both lists are id-required and the prefs picker enforces it. A collab credited to a separate joint-entity id won't match a followed member.
- The pipeline fails loudly (exit 2 + partial publish), never silently. Preserve this; never swallow errors.
- One clock: windows, labels, and the New/Upcoming split all anchor to `fetched_at`. The viewer clock is only for "Updated Xh ago". Do not anchor filtering to the viewer clock.
- Two count windows are intentional: editor chips tally the fetcher's `WINDOW_DAYS`; the site's New tab trims to 24h. Chip counts exceeding the page is expected, not a bug.

## Control panel

- `config/preferences.json` is the whole control panel (follow/block by Apple ID, exact-name genres, storefront-code countries, playlists).
- Local editor is `prefs-server.mjs` at `127.0.0.1:4747`.

## Stack

React 19 + Vite + Tailwind v4, ReleaseCard grid.
