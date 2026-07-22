// Genre names the editor's picker OFFERS (shared with check-genre-coverage.mjs).
// This only curates the picker; any exact Apple genre name is followable by
// typing it. Curation: mainstream genres actually OBSERVED on real releases
// (regional pop labels like Thai Pop exist in Apple's tree but their charts
// label everything plain Pop, so they're out).
//
// Every name is Apple's exact genre-tree spelling (verified 2026-07-19;
// re-verify after edits with check-genre-coverage.mjs — Apple renames genres,
// e.g. Regional Mexicano → Música Mexicana).
export const GENRE_OPTIONS = [
  'Afrobeats',
  'Alternative',
  'Amapiano',
  'Anime',
  'Cantopop/HK-Pop',
  'Dance',
  'Electronic',
  'Hip-Hop/Rap',
  'J-Pop',
  'K-Pop',
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
