// Canonical genre tags, shared by fetch-releases.mjs (tags releases) and
// prefs-server.mjs (offers the tags in the genre pickers). A shared module —
// not a copy in each script — because fetch-releases runs its whole pipeline
// at import time, so importing it just to read the map isn't an option.
//
// iTunes primaryGenreName → the canonical tag shown on cards and matched by
// config genres.preferred / genres.blocked. Unmapped names pass through as-is
// so new iTunes genres are still visible/blockable.
// Korean aliases cover the KR chart feed / storefront, which localizes genre
// labels (힙합/랩) — the fallback path when a release has no US catalog entry.
export const GENRE_MAP = [
  [/k-?pop|korean|케이팝/i, 'K-pop'],
  [/mandopop|cantopop|c-?pop|chinese/i, 'C-pop'],
  [/j-?pop|japan|anime/i, 'J-pop'],
  [/opm|pinoy|philippin/i, 'OPM'],
  [/vietnam/i, 'V-pop'],
  [/thai/i, 'Thai pop'],
  [/afro/i, 'Afrobeats'],
  [/r&b|soul|알앤비|소울/i, 'R&B'],
  // "mexican" covers both Regional Mexicano and Apple's newer Música Mexicana
  [/latin|reggaeton|urbano|banda|mexican|salsa|cumbia/i, 'Latin'],
  [/dance|electronic|house|techno|댄스|일렉트로닉/i, 'Dance'],
  [/hip-?hop|rap|힙합|랩/i, 'Hip-Hop'],
  [/alternative|indie/i, 'Alternative'],
  [/rock|metal|punk|록|메탈/i, 'Rock'],
  [/country/i, 'Country'],
  [/soundtrack|tv|film|사운드트랙/i, 'OST'],
  [/^pop$|worldwide|singer|^팝$/i, 'Pop'],
]

export const CANON_TAGS = [...new Set(GENRE_MAP.map(([, tag]) => tag))]

export function canonGenre(itunesGenre) {
  if (!itunesGenre) return null
  const hit = GENRE_MAP.find(([re]) => re.test(itunesGenre))
  return hit ? hit[1] : itunesGenre
}
