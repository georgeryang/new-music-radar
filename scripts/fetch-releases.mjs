#!/usr/bin/env node
// Fetch new releases and write docs/data/releases.json. Zero deps.
// Run daily by scripts/update.sh via launchd.
//
// Apple-only follow-list architecture (decided 2026-07-02, replacing the
// Deezer/YouTube multi-source design):
//   1. Preferred artists (config/preferences.json) — iTunes artist lookup,
//      newest releases first. The guaranteed layer; everything is native
//      Apple Music: link, genre, artwork, release date.
//   2. Apple KR+US most-played charts — "KR #2" badges, plus chart entries
//      released within the window become entries themselves (the only
//      non-follow-list discovery).
// All links go to Apple Music; releases with no Apple match don't exist here
// by construction.
//
// Filter precedence per release:
//   artist blocked → drop | artist preferred → keep | genre blocked → drop |
//   genre preferred → keep | else keep if charting or genre is known.
//
// Exit codes: 0 = clean run, 2 = a source failed (partial data published).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// Display target is ~36h; the file holds a wider window and the frontend trims.
const WINDOW_DAYS = 3
const UA = 'new-music-radar/1.0'
const OUT = new URL('../docs/data/releases.json', import.meta.url)

const PREFS = JSON.parse(readFileSync(new URL('../config/preferences.json', import.meta.url), 'utf8'))

const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// iTunes Search/Lookup is unofficially rate-limited (~20/min) — pace politely.
const pauseItunes = () => sleep(2500 + Math.random() * 1500)

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

// ---------- normalization / canonical key ----------

const EDITION_RE =
  /\s*[-–(\[]\s*(the\s+\d+\w*\s+(mini\s+)?album|ep|single|deluxe( edition| version)?|standard( edition)?|explicit|extended|remaster(ed)?( \d{4})?|alternate cover[^)\]]*)\s*[)\]]?\s*$/i
const NOISE_RE = /\b(instrumental|sped[ -]?up|slowed( \+ reverb)?|inst\.)\b/i

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

const keyOf = (r) => `${normArtist(r.artist)}|${normTitle(r.title)}|${r.type}`

function inWindow(releaseDate) {
  const days = (Date.now() - Date.parse(releaseDate)) / 86400e3
  // lower bound: catalogs list pre-orders (future dates) — released-only scope.
  return days <= WINDOW_DAYS + 0.5 && days >= -1
}

// iTunes encodes type in the collection name; strip it for display.
const typeOfName = (name) => (/- single\s*$/i.test(name) ? 'song' : /- ep\s*$/i.test(name) ? 'ep' : 'album')
const displayTitle = (name) =>
  name.replace(/\s*-\s*(Single|EP)\s*$/i, '').replace(/\s*\(alternate cover[^)]*\)\s*$/i, '').trim()
// artworkUrl100 URLs embed their size — request a card-sized variant instead.
const artUrl = (u) => (u ? u.replace('100x100', '300x300') : '')

// ---------- genre canonicalization ----------

// iTunes primaryGenreName → the canonical tag shown on cards and matched by
// config genres.preferred / genres.blocked. Unmapped names pass through as-is
// so new iTunes genres are still visible/blockable.
const GENRE_MAP = [
  [/k-?pop|korean/i, 'K-pop'],
  [/mandopop|cantopop|c-?pop|chinese/i, 'C-pop'],
  [/j-?pop|japan|anime/i, 'J-pop'],
  [/opm|pinoy|philippin/i, 'OPM'],
  [/vietnam/i, 'V-pop'],
  [/thai/i, 'Thai pop'],
  [/afro/i, 'Afrobeats'],
  [/r&b|soul/i, 'R&B'],
  [/latin|reggaeton|urbano|banda|regional mexicano|salsa|cumbia/i, 'Latin'],
  [/dance|electronic|house|techno/i, 'Dance'],
  [/hip-?hop|rap/i, 'Hip-Hop'],
  [/alternative|indie/i, 'Alternative'],
  [/rock|metal|punk/i, 'Rock'],
  [/country/i, 'Country'],
  [/soundtrack|tv|film/i, 'OST'],
  [/^pop$|worldwide|singer/i, 'Pop'],
]

function canonGenre(itunesGenre) {
  if (!itunesGenre) return null
  const hit = GENRE_MAP.find(([re]) => re.test(itunesGenre))
  return hit ? hit[1] : itunesGenre
}

const lower = (list) => (list ?? []).map((s) => s.toLowerCase())
const GENRES_PREFERRED = lower(PREFS.genres?.preferred)
const GENRES_BLOCKED = lower(PREFS.genres?.blocked)

// Artist entries: "Name" (hand-typed) or {name, id} (prefs editor's Apple
// picker — the Apple artist ID pins the exact artist among same-named ones).
const asEntry = (e) => (typeof e === 'string' ? { name: e } : e)
const PREFERRED_ENTRIES = (PREFS.artists?.preferred ?? []).map(asEntry)
const ARTISTS_BLOCKED = (PREFS.artists?.blocked ?? []).map((e) => normArtist(asEntry(e).name))
const PREFERRED_ARTIST_RES = PREFERRED_ENTRIES.map(
  // whole-word match so "IVE" can't match inside "RIIZE"
  (e) => new RegExp(`\\b${normArtist(e.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
)

const isGenrePreferred = (g) => !!g && GENRES_PREFERRED.includes(g.toLowerCase())
const isGenreBlocked = (g) => !!g && GENRES_BLOCKED.includes(g.toLowerCase())
const isArtistBlocked = (a) => ARTISTS_BLOCKED.some((b) => b && normArtist(a).includes(b))

// ---------- preferred artists via iTunes ----------

// Hand-typed names resolve once via artist search (Apple's relevance order,
// US storefront first for English genre labels) and cache the Apple artist ID
// (config/artist-cache.json). Delete a cache line to force re-resolution;
// picking in the prefs editor stores the ID directly.
const CACHE_PATH = new URL('../config/artist-cache.json', import.meta.url)
let artistCache = {}
try {
  artistCache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
} catch {}
let cacheDirty = false

async function resolveArtist(entry) {
  if (entry.id) return { id: entry.id, name: entry.name }
  const key = normArtist(entry.name)
  if (artistCache[key]) return artistCache[key]
  for (const country of ['us', 'kr']) {
    const data = await getJSON(
      `https://itunes.apple.com/search?term=${encodeURIComponent(entry.name)}&entity=musicArtist&country=${country}&limit=5`
    )
    const hit = (data.results ?? []).find((a) => normArtist(a.artistName) === key) ?? data.results?.[0]
    await pauseItunes()
    if (hit) {
      const resolved = { id: hit.artistId, name: hit.artistName }
      artistCache[key] = resolved
      cacheDirty = true
      return resolved
    }
  }
  return null
}

async function artistReleases(entry) {
  const artist = await resolveArtist(entry)
  if (!artist) {
    log(`could not resolve "${entry.name}" on Apple Music — skipped`)
    return []
  }
  // US first (English genre labels, links geo-redirect); KR fallback catches
  // Korea-only catalog entries.
  for (const country of ['us', 'kr']) {
    const data = await getJSON(
      `https://itunes.apple.com/lookup?id=${artist.id}&entity=album&country=${country}&limit=50&sort=recent`
    )
    const albums = (data.results ?? []).filter((r) => r.wrapperType === 'collection')
    if (!albums.length && country === 'us') {
      await pauseItunes()
      continue
    }
    return albums
      .filter((a) => a.releaseDate && inWindow(a.releaseDate))
      .map((a) => ({
        title: displayTitle(a.collectionName),
        artist: a.artistName ?? artist.name,
        type: typeOfName(a.collectionName),
        release_date: a.releaseDate.slice(0, 10),
        artwork: artUrl(a.artworkUrl100),
        genre: canonGenre(a.primaryGenreName),
        link: a.collectionViewUrl ? { service: 'apple', url: a.collectionViewUrl } : undefined,
      }))
  }
  return []
}

// ---------- Apple most-played charts (badge + chart discovery) ----------

async function fetchChart(storefront) {
  const data = await getJSON(
    `https://rss.marketingtools.apple.com/api/v2/${storefront}/music/most-played/50/albums.json`
  )
  return (data.feed?.results ?? []).map((e, i) => ({ rank: i + 1, entry: e }))
}

// ---------- pipeline ----------

let anyFailed = false
const releases = []

// 1. Preferred artists — the guaranteed layer
let preferredCount = 0
let lookupFailures = 0
let i = 0
for (const entry of PREFERRED_ENTRIES) {
  i++
  try {
    const found = await artistReleases(entry)
    preferredCount += found.length
    releases.push(...found)
    log(`(${i}/${PREFERRED_ENTRIES.length}) ${entry.name}${found.length ? ` — ${found.length} new` : ''}`)
  } catch (e) {
    lookupFailures++
    log(`(${i}/${PREFERRED_ENTRIES.length}) ${entry.name} — lookup failed: ${e.message}`)
  }
  await pauseItunes()
}
if (cacheDirty) writeFileSync(CACHE_PATH, JSON.stringify(artistCache, null, 2) + '\n')
log(`${preferredCount} releases via ${PREFERRED_ENTRIES.length} preferred artists (${lookupFailures} lookup failures)`)
if (PREFERRED_ENTRIES.length > 0 && lookupFailures === PREFERRED_ENTRIES.length) anyFailed = true

// 2. Charts — badges for the above, plus in-window chart entries as discovery
const charts = []
for (const storefront of ['kr', 'us']) {
  try {
    charts.push({ storefront: storefront.toUpperCase(), list: await fetchChart(storefront) })
  } catch (e) {
    anyFailed = true
    log(`${storefront} chart fetch failed: ${e.message}`)
  }
}

for (const c of charts) {
  for (const { rank, entry: e } of c.list) {
    if (!e.releaseDate || !inWindow(e.releaseDate)) continue
    const genreName = (e.genres ?? []).map((g) => g.name).find((n) => n && n !== 'Music') ?? null
    releases.push({
      title: displayTitle(e.name),
      artist: e.artistName,
      type: typeOfName(e.name),
      release_date: e.releaseDate,
      artwork: artUrl(e.artworkUrl100),
      genre: canonGenre(genreName),
      link: e.url ? { service: 'apple', url: e.url } : undefined,
      charting: { storefront: c.storefront, rank },
    })
  }
}

// mark preferred artists (before dedup so merges keep the flag)
for (const r of releases) {
  if (PREFERRED_ARTIST_RES.some((re) => re.test(normArtist(r.artist)))) r.preferred = true
}

// noise + canonical-key dedup (type is in the key: same-titled song + album
// both survive; chart/artist duplicates collapse, merging the badge)
const byKey = new Map()
for (const r of releases) {
  if (NOISE_RE.test(r.title)) {
    log(`dropped noise "${r.artist} — ${r.title}"`)
    continue
  }
  const k = keyOf(r)
  const prev = byKey.get(k)
  if (prev) {
    if (r.release_date < prev.release_date) prev.release_date = r.release_date
    if (!prev.artwork && r.artwork) prev.artwork = r.artwork
    if (!prev.link && r.link) prev.link = r.link
    if (!prev.charting && r.charting) prev.charting = r.charting
    prev.preferred = prev.preferred || r.preferred
  } else {
    byKey.set(k, r)
  }
}
let out = [...byKey.values()]

// badge artist-sourced entries that also chart under a slightly different name
for (const r of out) {
  if (r.charting) continue
  const a = normArtist(r.artist)
  const t = normTitle(r.title)
  for (const c of charts) {
    const hit = c.list.find(({ entry: e }) => {
      const ca = normArtist(e.artistName)
      const ct = normTitle(e.name)
      return ca === a && (ct === t || ct.startsWith(t) || t.startsWith(ct))
    })
    if (hit && (!r.charting || hit.rank < r.charting.rank)) {
      r.charting = { storefront: c.storefront, rank: hit.rank }
    }
  }
}

// filter precedence: artist block > artist prefer > genre block > genre prefer
// > neutral (needs charting or a known genre)
const before = out.length
out = out.filter((r) => {
  if (isArtistBlocked(r.artist)) return logDrop(r, 'artist blocked')
  if (r.preferred) return true
  if (isGenreBlocked(r.genre)) return logDrop(r, `genre blocked [${r.genre}]`)
  if (isGenrePreferred(r.genre)) return true
  if (r.charting || r.genre) return true
  return logDrop(r, 'no genre, not charting')
})
function logDrop(r, why) {
  log(`dropped: ${r.artist} — ${r.title} (${why})`)
  return false
}
if (before !== out.length) log(`${before - out.length} releases filtered out`)

// sort: preferred artist → preferred genre → date desc → artist name
out.sort(
  (a, b) =>
    (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0) ||
    (isGenrePreferred(b.genre) ? 1 : 0) - (isGenrePreferred(a.genre) ? 1 : 0) ||
    b.release_date.localeCompare(a.release_date) ||
    a.artist.localeCompare(b.artist)
)

// Empty-success guard (v1 lesson: an empty success can be a failure in
// disguise). If we got nothing but the previous file still has in-window
// releases, keep those instead of stamping an empty file fresh.
if (out.length === 0) {
  let prev = []
  try {
    prev = JSON.parse(readFileSync(OUT, 'utf8')).releases ?? []
  } catch {}
  const carried = prev.filter((r) => inWindow(r.release_date))
  if (carried.length) {
    log(`0 fetched but ${carried.length} previous in-window releases — carrying over`)
    out = carried
  }
}

mkdirSync(new URL('../docs/data/', import.meta.url), { recursive: true })
writeFileSync(OUT, JSON.stringify({ fetched_at: Date.now(), releases: out }, null, 2))
log(`wrote ${out.length} releases`)
process.exit(anyFailed ? 2 : 0)
