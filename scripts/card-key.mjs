// Canonical card identity + ordering, shared by the fetcher (node) and the
// app (Vite imports this file from outside src/). The fetcher dedups both
// lists with keyOf; the app keys its React cards with the SAME key — a
// weaker key there (raw strings) let one release render twice when Apple
// tweaked its title between fetches.

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

export const normArtist = (raw) =>
  raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()

export const keyOf = (r) => `${normArtist(r.artist)}|${normTitle(r.title)}|${r.type}`

// Card-level identity: keyOf alone over-collapses across the two lists (a
// deluxe/edition pre-order of an already-released album strips to the same
// keyOf), so the date qualifies it. Used for the fetcher's cross-list
// disjointness filter and the app's React card keys — one definition so the
// two sides can never key differently.
export const cardKeyOf = (r) => `${keyOf(r)}|${r.release_date}`

// sort: followed artists first, then alphabetical by artist; newest first
// within one artist's releases
export const releaseOrder = (a, b) =>
  (b.followed ? 1 : 0) - (a.followed ? 1 : 0) ||
  a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) ||
  b.release_date.localeCompare(a.release_date) ||
  a.title.localeCompare(b.title)

// upcoming: soonest first, then artist
export const upcomingOrder = (a, b) =>
  a.release_date.localeCompare(b.release_date) ||
  a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
