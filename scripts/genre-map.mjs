// Canonical genre tags, shared by fetch-releases.mjs (tags releases) and
// prefs-server.mjs (offers the tags in the genre picker). A shared module —
// not a copy in each script — because fetch-releases runs its whole pipeline
// at import time, so importing it just to read the map isn't an option.
//
// iTunes primaryGenreName (US storefront, always English) → the canonical tag
// shown on cards and matched by config genres.followed. Unmapped names pass
// through as-is so new iTunes genres are still visible and selectable.
// Order matters: first match wins ("Dancehall" must hit Reggae before the
// Dance rule sees its "dance" substring). No mapping for the bare "World"
// umbrella label on purpose — leaving it unmapped makes the chart prefilter
// spend a lookup, whose primaryGenreName can resolve to a real subgenre
// (Mandopop → C-pop) instead of skipping the entry.
export const GENRE_MAP = [
  [/k-?pop|korean/i, 'K-pop'],
  [/mandopop|cantopop|c-?pop|chinese/i, 'C-pop'],
  [/j-?pop|japan|anime/i, 'J-pop'],
  [/opm|pinoy|philippin/i, 'OPM'],
  [/vietnam/i, 'V-pop'],
  [/thai/i, 'Thai pop'],
  // umbrella tag for the whole continent's scenes — amapiano lacks an "afro"
  // substring, so it's matched explicitly
  [/afro|african|amapiano/i, 'African'],
  [/r&b|soul/i, 'R&B'],
  // "mexican" covers both Regional Mexicano and Apple's newer Música Mexicana
  [/latin|reggaeton|urbano|banda|mexican|salsa|cumbia/i, 'Latin'],
  [/reggae|dancehall/i, 'Reggae'],
  [/dance|electronic|house|techno/i, 'Dance'],
  [/hip-?hop|rap/i, 'Hip-Hop'],
  [/alternative|indie/i, 'Alternative'],
  [/rock|metal|punk/i, 'Rock'],
  [/country/i, 'Country'],
  [/soundtrack|tv|film/i, 'OST'],
  [/christian|gospel|worship/i, 'Christian'],
  [/jazz/i, 'Jazz'],
  [/classical|opera/i, 'Classical'],
  [/blues/i, 'Blues'],
  [/folk|americana/i, 'Folk'],
  [/funk|disco/i, 'Funk'],
  [/^pop$|worldwide|singer/i, 'Pop'],
]

export const CANON_TAGS = [...new Set(GENRE_MAP.map(([, tag]) => tag))]

export function canonGenre(itunesGenre) {
  if (!itunesGenre) return null
  const hit = GENRE_MAP.find(([re]) => re.test(itunesGenre))
  return hit ? hit[1] : itunesGenre
}
