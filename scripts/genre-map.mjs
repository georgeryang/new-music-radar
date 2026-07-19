// Curated genre options, shared by prefs-server.mjs (the picker's list) and
// check-genre-coverage.mjs (asserts these names still exist in Apple's genre
// tree). A shared module — not a copy in each script — because fetch-releases
// runs its whole pipeline at import time, so importing it just to read the
// list isn't an option.
//
// Cards show Apple's primaryGenreName VERBATIM, and the follow filter is an
// exact case-insensitive match of that name against config genres.followed.
// This list only curates what the picker OFFERS; any other exact Apple genre
// name is still followable by typing it in the editor. Curation basis:
// current mainstream genres George listens to, trimmed to labels OBSERVED on
// real releases (regional pop labels like Thai Pop exist in Apple's tree but
// their countries' charts label everything plain Pop, so they're out).
//
// Every name is Apple's exact genre-tree spelling (verified 2026-07-19;
// re-verify after edits with `node scripts/check-genre-coverage.mjs` —
// Apple renames genres, e.g. Regional Mexicano became Música Mexicana).
export const GENRE_OPTIONS = [
  'Afrobeats',
  'Amapiano',
  'Alternative',
  'Anime',
  'Cantopop/HK-Pop',
  'Chinese Hip-Hop',
  'Dance',
  'Electronic',
  'Hip-Hop/Rap',
  'J-Pop',
  'K-Pop',
  'Korean Hip-Hop',
  'Latin',
  'Mandopop',
  'Música Mexicana',
  'Pop',
  'Pop Latino',
  'R&B/Soul',
  'Rock',
  'Singer/Songwriter',
  'Urbano latino',
]
