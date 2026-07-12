// Canonical card identity + ordering, shared by the fetcher (node) and the
// app (Vite imports this file from outside src/). The fetcher dedups both
// lists with keyOf; the app collapses releases[]+upcoming[] with the SAME
// key before its clock re-split — a weaker key there (raw strings) let one
// release render twice when Apple tweaked its title between fetches.

const EDITION_RE =
  /\s*[-–(\[]\s*(the\s+\d+\w*\s+(mini\s+)?album|ep|single|deluxe( edition| version)?|standard( edition)?|explicit|extended|remaster(ed)?( \d{4})?|alternate cover[^)\]]*)\s*[)\]]?\s*$/i

export function normTitle(raw) {
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
