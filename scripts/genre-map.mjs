// Canonical genre tags, shared by fetch-releases.mjs (tags releases) and
// prefs-server.mjs (offers the tags in the genre pickers). A shared module —
// not a copy in each script — because fetch-releases runs its whole pipeline
// at import time, so importing it just to read the map isn't an option.
//
// iTunes primaryGenreName (US storefront, always English) → the canonical tag
// shown on cards and matched by config genres.preferred / genres.blocked.
// Unmapped names pass through as-is so new iTunes genres are still
// visible/blockable.
export const GENRE_MAP = [
  [/k-?pop|korean/i, 'K-pop'],
  [/mandopop|cantopop|c-?pop|chinese/i, 'C-pop'],
  [/j-?pop|japan|anime/i, 'J-pop'],
  [/opm|pinoy|philippin/i, 'OPM'],
  [/vietnam/i, 'V-pop'],
  [/thai/i, 'Thai pop'],
  [/afro/i, 'Afrobeats'],
  [/r&b|soul/i, 'R&B'],
  // "mexican" covers both Regional Mexicano and Apple's newer Música Mexicana
  [/latin|reggaeton|urbano|banda|mexican|salsa|cumbia/i, 'Latin'],
  [/dance|electronic|house|techno/i, 'Dance'],
  [/hip-?hop|rap/i, 'Hip-Hop'],
  [/alternative|indie/i, 'Alternative'],
  [/rock|metal|punk/i, 'Rock'],
  [/country/i, 'Country'],
  [/soundtrack|tv|film/i, 'OST'],
  [/^pop$|worldwide|singer/i, 'Pop'],
]

export const CANON_TAGS = [...new Set(GENRE_MAP.map(([, tag]) => tag))]

export function canonGenre(itunesGenre) {
  if (!itunesGenre) return null
  const hit = GENRE_MAP.find(([re]) => re.test(itunesGenre))
  return hit ? hit[1] : itunesGenre
}
