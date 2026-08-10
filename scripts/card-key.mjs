// Canonical card identity + ordering, shared by the fetcher and the app so the
// two can never key differently. The fetcher dedups with keyOf; the app keys its
// React cards with the same key.

const EDITION_RE =
  /\s*[-–(\[]\s*(the\s+\d+\w*\s+(mini\s+)?album|ep|single|deluxe( edition| version)?|standard( edition)?|explicit|extended|remaster(ed)?( \d{4})?|alternate cover[^)\]]*)\s*[)\]]?\s*$/i

function normTitle(raw) {
  let t = raw.normalize('NFKC').toLowerCase()
  let prev
  do {
    prev = t
    t = t.replace(EDITION_RE, '')
  } while (t !== prev && t.length > 2)
  return t.replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()
}

const normArtist = (raw) =>
  raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()

export const keyOf = (r) => `${normArtist(r.artist)}|${normTitle(r.title)}|${r.type}`

// keyOf alone over-collapses across the two lists (a deluxe pre-order of a
// released album strips to the same keyOf), so the date qualifies it.
export const cardKeyOf = (r) => `${keyOf(r)}|${r.release_date}`

export const releaseOrder = (a, b) =>
  (b.followed ? 1 : 0) - (a.followed ? 1 : 0) ||
  a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) ||
  b.release_date.localeCompare(a.release_date) ||
  a.title.localeCompare(b.title)

export const upcomingOrder = (a, b) =>
  a.release_date.localeCompare(b.release_date) ||
  a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
