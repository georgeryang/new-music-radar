---
name: audit-radar-sources
description: Audit every new-music-radar discovery source — followed artists, genres, countries, playlists and the always-scanned US feeds — and recommend what to remove, replace or add. Use when asked to audit sources, check what is still active, prune dead feeds, or find better playlists.
---

# Auditing new-music-radar's sources

`npm run audit-sources` grades every source the preferences editor exposes and
proposes changes. It is read-only. Present the findings and let the user decide;
never apply a recommendation without being asked.

`--no-discover` skips candidate discovery (under a minute instead of ~3). `--json`
prints the whole report as structured data instead of the table. Through npm both
need the separator: `npm run audit-sources -- --no-discover`.

## The columns, and which ones work today

The table has two halves, and mixing them is the main way to reach a wrong answer.

**Live, works on day one** — measured fresh every run, no history needed:

- **`14d`** — collection ids this source carried in the last 14 days.
- **`uniq`** — how many of those *no other configured source* carried. This is the
  removal number. Zero `uniq` with a non-zero `14d` means fully redundant.
- **`most shared with`** — the single source covering the largest share of it, e.g.
  `Cantopop/HK-Po 100%`. Names the thing that makes it redundant, so the claim is
  checkable rather than asserted.
- **`liveness`** — `no entries (dead)` means the feed is empty. `N entries, newest
  <date>` means the feed works and any problem is about content, not plumbing.
- **`cost`** — estimated paced-lookup seconds. Playlists dominate; feeds are nearly
  free. Weigh `uniq` against `cost`, never against raw volume.

**Historical, needs about two weeks** — from `config/source-activity.json`:

- **`7d` / `30d` / `u30`** — releases actually published from this source, and how
  many were sole-sourced. Blank or `collecting` until the history exists.
- **`fail`** — days the source's fetch errored. Read this *before* `zero`: a source
  with failures has not been measured, it has been missed. Days before a source was
  configured do not count as failures.
- **`zero`** — consecutive measured days with no yield.

## The two rules that make this trustworthy

**Quiet is not dead.** A feed returning zero entries is broken. A feed returning
68 entries with nothing released recently is healthy and slow. Mexico's chart went
six weeks without a new release in mid-2026 and was fine. Korea's purchase feeds
return literally nothing because Apple runs no purchase store there. Only the
second kind is a removal.

**Absence is not zero.** A day where a source's fetch failed records `null` in
`config/source-activity.json`, never `0`, and every window skips those days. This
exists because the first hand-run of this audit swallowed two transient errors and
recommended deleting nine storefronts when three deserved it. If a source looks
newly dead, re-run before believing it.

## Traps

- **A candidate playlist that is fresh but not additive is worth nothing.** The ADD
  gate is freshness *and* unique contribution, because a 90%-fresh list whose every
  release you already get changes nothing.
- **Never guess an Apple genre id.** The audit cross-checks every `GENRE_FEEDS`
  entry against Apple's live tree and flags a tag that disagrees; `genre-tree.mjs`
  carries the worked example of an id that reads as one genre and is another.
- **Sole-source counts before 2026-07-30 understate sharing.** The US chart and
  genre feeds were untagged until then, so a release they also found looked unique
  to whichever country surfaced it.
- **Candidate discovery is capped** at 12 playlists, round-robin across your
  followed genres, and the report says how many it skipped. It is a sample, not a
  survey — re-run it if you want a different slice.
- **`REPLACE` on a playlist means low freshness density**, the share of its albums
  released in the last 30 days. It separates a real new-release list (New in C-Pop,
  93%) from a stale one (Breaking Mandopop, 9%). A curated "A-List" chart will
  always score low; that alone is a judgement call, not automatically a defect. A
  `REMOVE` on the same row is different and much stronger: it means zero `uniq`.
- **Picker pruning uses the same test.** Storefronts you do not scan are also scored
  for what they would add. Zero additive means the option can never be worth picking,
  and it is recommended for removal from `STOREFRONTS` — but only when its probe
  succeeded and returned entries.
- The audit refuses to run while a Save & Refresh started from the editor is
  going, since they would fight over the same rate limit. The launchd nightly run
  writes no pidfile, so an overlap with that one is not detected: check the clock
  rather than relying on the guard.

## Applying what it recommends

- **Artists, genres, countries, playlists** live in `config/preferences.json`.
  Prefer the editor (`prefs.command`, or `node scripts/prefs-server.mjs`) so the
  Apple-ID pickers and validation apply. Direct edits are fine for playlists.
- **Genre feeds** are `GENRE_FEEDS` in `scripts/shared.mjs`. An entry takes
  `{ genreId, tag, feeds? }`; `feeds: ['topsongs']` when only half the feed is
  alive. `tag` must be Apple's exact genre name.
- **Storefronts** are `STOREFRONTS` in `scripts/storefronts.mjs`, with
  `STREAMING_ONLY` for those Apple runs no purchase store in.
- After any genre change run `npm run check-genres`; it exits 1 on a name that is
  not in Apple's tree.
- After changing `GENRE_FEEDS` or `STOREFRONTS`, run `npm run fetch` once and
  confirm exit 0 and the expected new log lines.
