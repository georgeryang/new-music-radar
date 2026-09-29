---
name: audit-radar-sources
description: Audit configured music discovery sources and recommend additions, replacements, or removals based on live yield and measured history.
---

# Audit Radar Sources

For configured-source reviews, run `npm run audit-sources -- --no-discover`. Use the full `npm run audit-sources` when asked to find new sources or replacements. Both read live Apple sources and local history. Present recommendations; do not change preferences unless asked. `--json` returns structured output; pass flags after npm's `--`. The shared operation lock excludes scheduled/editor refreshes and direct fetches.

## Read the Report

Live columns work immediately:

- `14d`: recent collection IDs found by this source.
- `uniq`: IDs no other configured source found. This is the removal metric; zero with nonzero `14d` means redundancy.
- `most shared with`: source covering the largest share, with a checkable percentage.
- `liveness`: distinguish an empty feed from one carrying older releases.
- `cost`: estimated paced-lookup seconds. Compare with unique contribution, not total volume.

Historical columns require measured history:

- `7d`, `30d`, `u30`: published yields and sole-source contributions; blank/collecting until sufficient history.
- `fail`: failed fetch days. Read before `zero`; unmeasured sources are not proven unproductive. Days before configuration do not count as failures.
- `zero`: consecutive measured days with no yield.

`sourceWindow` in `scripts/shared.mjs` owns the missing-is-not-zero rule. A failure records `null`; do not treat it as successful observation. Recheck newly empty sources before recommending removal. A chart with older entries is still healthy; purchase feeds in streaming-only storefronts may truly be empty.

## Interpretation Constraints

- Candidate additions need freshness AND unique contribution. A fresh but redundant playlist adds nothing.
- Discovery samples at most 12 playlists round-robin across followed genres; it is not a complete survey. Report skipped candidates.
- `REPLACE` measures low freshness density over 30 days. An intentionally broad A-List chart may score low; this is a judgment call. `REMOVE` with zero `uniq` is stronger evidence.
- Storefront picker pruning requires a successful probe with entries and zero additive contribution.
- Sole-source counts before 2026-07-30 understate sharing: US chart and genre feeds were not tagged then.
- Never guess Apple genre IDs. The audit checks the live tree; `genre-tree.mjs` records the known mismatch.

## Apply Authorized Changes

Artists, genres, countries, and playlists live in `config/preferences.json`. Prefer the editor for ID validation; direct playlist edits are supported. Fixed genre feeds live in `GENRE_FEEDS` in `scripts/shared.mjs`: use Apple's exact name and `feeds: ['topsongs']` when only that feed works. Storefront definitions and streaming-only flags live in `scripts/storefronts.mjs`.

After a genre change run `npm run check-genres`. Verify feed/storefront changes with the isolated workflow in `skills/verify-radar/SKILL.md`; do not run the live updater as a test.
