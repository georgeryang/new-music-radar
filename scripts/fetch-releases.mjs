#!/usr/bin/env node
// Fetch new releases and write docs/data/releases.json. Zero deps.
// Run daily by scripts/update.sh via launchd.
//
// Apple-only follow-list architecture. Every source queries the US storefront
// exclusively — other storefronts localize artist names (KR lists CHUU as 츄),
// which splits the dedup key and duplicates cards. A release that exists only
// in a foreign catalog appears once it propagates to the US one (usually
// within hours; the 3-day window means it still makes the next fetch).
//   1. Preferred artists (config/preferences.json) — batched iTunes lookups,
//      newest releases first. The guaranteed layer; everything is native
//      Apple Music: link, genre, artwork, release date.
//   2. Apple US most-played chart — "US #2" badges, plus chart entries
//      released within the window become entries themselves.
//   3. US iTunes genre purchase charts (GENRE_FEEDS) — purchases spike on
//      release day, so new drops in core preferred genres appear within hours
//      (most-played lags by days).
//   4. Editorial playlists (config discovery.playlists, e.g. New Music Daily)
//      — scraped from the web player page; curated day-of, all-genre.
// Releases with no Apple match don't exist here by construction.
//
// Filter precedence per release:
//   artist blocked → drop | artist preferred → keep | genre blocked → drop |
//   genre preferred → keep | else drop (chart discovery sticks to preferred genres).
//
// Exit codes: 0 = clean run, 2 = a source failed (partial data published).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { GENRE_MAP, canonGenre } from './genre-map.mjs'

// Display target is ~36h; the file holds a wider window and the frontend trims.
const WINDOW_DAYS = 3
const UA = 'new-music-radar/1.0'
const OUT = new URL('../docs/data/releases.json', import.meta.url)

const PREFS = JSON.parse(readFileSync(new URL('../config/preferences.json', import.meta.url), 'utf8'))

const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

// iTunes Search/Lookup is unofficially rate-limited (~20/min). Every call to
// that host goes through here: it waits out the gap since the previous call
// (with jitter) instead of sleeping a fixed pause afterwards, so time spent
// processing between calls counts toward the gap and the last call of a loop
// doesn't leave a dangling sleep. Other Apple hosts (marketingtools, legacy
// RSS, the web player) are not similarly limited and use getJSON directly.
let lastItunesCall = 0
async function itunesJSON(url) {
  const wait = lastItunesCall + 2500 + Math.random() * 1500 - Date.now()
  if (wait > 0) await sleep(wait)
  lastItunesCall = Date.now()
  return getJSON(url)
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

// Two types only: song (a single) vs album (EPs, mini albums, and larger).
// Hybrid rule: Apple's "- Single" designation wins (kpop singles often carry
// an instrumental B-side, so track count alone would misread them); EP/mini
// album wording → album; otherwise 1 track → song, more → album.
function classify(name, trackCount) {
  if (/-\s*single\s*$/i.test(name)) return 'song'
  if (/-\s*ep\s*$|mini album|\bEP\b/i.test(name)) return 'album'
  if (trackCount === 1) return 'song'
  return 'album'
}
const displayTitle = (name) =>
  name.replace(/\s*-\s*(Single|EP)\s*$/i, '').replace(/\s*\(alternate cover[^)]*\)\s*$/i, '').trim()
// Artwork URLs embed their size (100x100bb from lookups, 170x170bb from the
// legacy feeds) — 400x400 covers the 4-up grid on retina screens.
const artUrl = (u) => (u ? u.replace(/\d+x\d+bb/, '400x400bb') : '')
// Normalize any storefront path to /us/ — every source queries the US catalog
// already, so this is defense in depth for whatever URL a feed hands back.
const usLink = (u) => (u ? u.replace(/(music|itunes)\.apple\.com\/[a-z]{2}\//, '$1.apple.com/us/') : '')
// Only Apple catalog URLs make it onto cards — one source is scraped, so
// link fields are untrusted until they match this shape.
const appleLink = (u) =>
  u && /^https:\/\/(music|itunes)\.apple\.com\//.test(u) ? usLink(u) : undefined

// One iTunes lookup result (wrapperType "collection") → release card shape.
// Every lookup-backed source (artist sweep, playlists, chart enrichment)
// funnels through this so the shapes can't drift apart. artist_id is
// match-time plumbing for ID-based blocking; it's stripped before writing.
const fromCollection = (a) => ({
  title: displayTitle(a.collectionName),
  artist: a.artistName,
  artist_id: a.artistId,
  type: classify(a.collectionName, a.trackCount),
  release_date: a.releaseDate.slice(0, 10),
  artwork: artUrl(a.artworkUrl100),
  genre: canonGenre(a.primaryGenreName),
  link: appleLink(a.collectionViewUrl),
})

const lower = (list) => (list ?? []).map((s) => s.toLowerCase())
const GENRES_PREFERRED = lower(PREFS.genres?.preferred)
const GENRES_BLOCKED = lower(PREFS.genres?.blocked)

// Both artist lists are {name, id} — the prefs editor's Apple picker pins the
// exact artist by ID, and both fetching (preferred) and blocking (blocked)
// key on the ID.
const asEntry = (e) => (typeof e === 'string' ? { name: e } : e)
const PREFERRED_ENTRIES = (PREFS.artists?.preferred ?? []).map(asEntry)
// Blocking matches by Apple ID — precise, no name collisions ("Drake" can't
// catch "Drake Milligan"). Caveat: a blocked artist's collabs are credited to
// a joint entity with its own ID, so those aren't blocked.
const BLOCKED_IDS = new Set()
for (const e of (PREFS.artists?.blocked ?? []).map(asEntry)) {
  if (e.id) BLOCKED_IDS.add(e.id)
  else log(`blocked artist "${e.name}" has no Apple ID — re-add via the prefs picker; not blocking`)
}
// Preferred *marking* (the ★ + filter bypass for releases arriving via other
// sources) stays name-based on purpose: collab releases are credited to joint
// artist entities whose IDs aren't in the config, but the member's name is in
// the credit string.
const PREFERRED_ARTIST_RES = PREFERRED_ENTRIES.map(
  // Whole-word match so "IVE" can't match inside "RIIZE". Unicode lookarounds
  // instead of \b — \b is ASCII-only and never matches at CJK name boundaries
  // (鄧紫棋 would silently lose its preferred status).
  (e) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}])${normArtist(e.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
      'u'
    )
)

const isGenrePreferred = (g) => !!g && GENRES_PREFERRED.includes(g.toLowerCase())
const isGenreBlocked = (g) => !!g && GENRES_BLOCKED.includes(g.toLowerCase())
const isArtistBlocked = (r) => !!r.artist_id && BLOCKED_IDS.has(r.artist_id)

// ---------- preferred artists via iTunes ----------

// Batched sweep: lookup accepts comma-joined ids and returns each artist's
// newest `limit` albums, grouped per artist, with no global cap (verified
// live: 10 ids × limit=50 → 342 results). 9 paced calls for the whole list
// instead of the old ~165 per-artist ones. US storefront only — foreign
// storefronts localize artist names (KR lists CHUU as 츄), which split the
// dedup key and duplicated cards.
const BATCH_SIZE = 10

// Newest US release date per artist id — feeds the dormancy hints in the
// prefs editor (collabs credited to joint artist entities don't attribute,
// which is fine for spotting artists with no releases in years).
const ACTIVITY_PATH = new URL('../config/artist-activity.json', import.meta.url)
let artistActivity = {}
try {
  artistActivity = JSON.parse(readFileSync(ACTIVITY_PATH, 'utf8'))
} catch {}

async function batchReleases(ids) {
  const data = await itunesJSON(
    `https://itunes.apple.com/lookup?id=${ids.join(',')}&entity=album&country=us&limit=50&sort=recent`
  )
  const collections = (data.results ?? []).filter((r) => r.wrapperType === 'collection')
  for (const a of collections) {
    const d = a.releaseDate?.slice(0, 10)
    if (d && (!artistActivity[a.artistId] || d > artistActivity[a.artistId])) artistActivity[a.artistId] = d
  }
  return collections.filter((a) => a.releaseDate && inWindow(a.releaseDate)).map(fromCollection)
}

// ---------- Apple most-played charts (badge + chart discovery) ----------

async function fetchChart() {
  const data = await getJSON(
    'https://rss.marketingtools.apple.com/api/v2/us/music/most-played/50/albums.json'
  )
  return (data.feed?.results ?? []).map((e, i) => ({ rank: i + 1, entry: e }))
}

// ---------- genre charts (iTunes purchase charts — day-of discovery) ----------

// Core preferred genres get a dedicated new-release watch. These legacy feeds
// are iTunes Store *purchase* charts: fandom buying spikes on release day, so
// a new drop appears within hours — unlike most-played, which lags by days.
// The list controls where we look, not what we keep: the full preferred-genres
// list still filters every source. Extend with one line per genre — probe the
// feed title to find a genre id. US storefront only, like every other source.
const GENRE_FEEDS = [
  { genreId: 51, tag: 'K-pop' },
  { genreId: 12, tag: 'Latin' },
  { genreId: 14, tag: 'Pop' },
  { genreId: 15, tag: 'R&B' },
]

async function genreFeedReleases(feedType, genreId) {
  const data = await getJSON(
    `https://itunes.apple.com/us/rss/${feedType}/genre=${genreId}/limit=100/json`
  )
  return (data.feed?.entry ?? [])
    .filter((e) => e['im:releaseDate']?.label && inWindow(e['im:releaseDate'].label))
    .map((e) => ({
      title: displayTitle(e['im:name'].label),
      artist: e['im:artist'].label,
      // the feed has no artistId field, but the artist URL ends in one
      artist_id: Number(e['im:artist']?.attributes?.href?.match(/\/(\d+)(?:\?|$)/)?.[1]) || undefined,
      type: feedType === 'topsongs' ? 'song' : classify(e['im:name'].label, Number(e['im:itemCount']?.label)),
      release_date: e['im:releaseDate'].label.slice(0, 10),
      artwork: artUrl(e['im:image']?.at(-1)?.label),
      genre: canonGenre(e.category?.attributes?.label),
      link: appleLink(e.id?.label),
      // no charting badge — rank badges stay exclusive to most-played charts.
      // TODO(designer): should genre-chart finds get their own subtle source
      // indicator, or stay badge-less?
    }))
}

// ---------- editorial playlists (scraped web player pages) ----------

// New Music Daily & friends are the only day-of, all-genre new-release surface
// Apple exposes without an Apple Music API token. The web player page embeds
// the track list as JSON; this parses it down to the parent-album ids. The
// paced batched lookups that resolve those ids to releases happen later in
// the pipeline — the page fetch itself is unthrottled and runs concurrently
// with the artist sweep. Scraping is the fragile source — failures must be
// loud (exit 2), never silent.
async function playlistAlbumIds(pl) {
  const res = await fetch(pl.url, {
    // full browser UA: the web player only embeds the JSON for browsers
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pl.url}`)
  const html = await res.text()
  const m = html.match(/<script type="application\/json" id="serialized-server-data">(.*?)<\/script>/s)
  if (!m) throw new Error('no serialized-server-data block (page layout changed?)')
  const albumIds = new Set()
  let tracks = 0
  ;(function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk)
    if (!o || typeof o !== 'object') return
    if (o.artistName) {
      tracks++
      // the track's parent album rides in a tertiary link of kind "album";
      // fall back to the item's own descriptor (also an album id in practice)
      const fromLinks = (o.tertiaryLinks ?? [])
        .map((l) => l.segue?.destination?.contentDescriptor)
        .find((d) => d?.kind === 'album')?.identifiers?.storeAdamID
      const id = fromLinks ?? o.contentDescriptor?.identifiers?.storeAdamID
      if (id) albumIds.add(String(id))
      return
    }
    Object.values(o).forEach(walk)
  })(JSON.parse(m[1]))
  return { pl, tracks, albumIds: [...albumIds] }
}

// ---------- pipeline ----------

let anyFailed = false
const releases = []

// Unthrottled fetches (marketingtools chart, legacy RSS genre feeds, web
// player playlist pages) start now and resolve while the paced artist sweep
// runs — their wall time disappears behind it. The genre feeds share the
// itunes.apple.com hostname with the throttled Search/Lookup API, so they get
// a small stagger as insurance. Results are consumed in pipeline order below.
const chartP = fetchChart()
const genreFeedsP = Promise.allSettled(
  GENRE_FEEDS.flatMap(({ genreId, tag }, gi) =>
    ['topalbums', 'topsongs'].map((feedType, fi) =>
      sleep((gi * 2 + fi) * 250)
        .then(() => genreFeedReleases(feedType, genreId))
        .then(
          (found) => ({ tag, feedType, found }),
          (e) => {
            throw new Error(`${tag} ${feedType}: ${e.message}`)
          }
        )
    )
  )
)
const playlistPagesP = Promise.allSettled(
  (PREFS.discovery?.playlists ?? []).map((pl) =>
    playlistAlbumIds(pl).catch((e) => {
      throw new Error(`${pl.name}: ${e.message}`)
    })
  )
)

// 1. Preferred artists — the guaranteed layer, swept in batched lookups.
// Every entry must carry an Apple artist ID (the prefs editor's picker adds
// one) — name-only entries are ambiguous (three distinct "Sabrina"s exist)
// and are skipped loudly rather than guessed at.
const sweepArtists = PREFERRED_ENTRIES.filter((e) => {
  if (e.id) return true
  log(`"${e.name}" has no Apple artist ID — re-add it via the prefs editor picker; skipped`)
  return false
})

const batches = []
for (let i = 0; i < sweepArtists.length; i += BATCH_SIZE) batches.push(sweepArtists.slice(i, i + BATCH_SIZE))
let preferredCount = 0
let batchFailures = 0
let n = 0
for (const batch of batches) {
  n++
  try {
    const found = await batchReleases(batch.map((a) => a.id))
    preferredCount += found.length
    releases.push(...found)
    log(
      `batch ${n}/${batches.length} (${batch.length} artists)` +
        (found.length ? ` — ${found.length} new: ${[...new Set(found.map((f) => f.artist))].join(', ')}` : '')
    )
  } catch (e) {
    batchFailures++
    log(`batch ${n}/${batches.length} failed: ${e.message}`)
  }
}
writeFileSync(ACTIVITY_PATH, JSON.stringify(artistActivity, null, 2) + '\n')
log(`${preferredCount} releases (pre-dedup) via ${sweepArtists.length} preferred artists in ${batches.length} batches`)
if (batches.length > 0 && batchFailures === batches.length) anyFailed = true

// 2. Chart — badges for the above, plus in-window chart entries as discovery
let chart = []
try {
  chart = await chartP
} catch (e) {
  anyFailed = true
  log(`US chart fetch failed: ${e.message}`)
}

// Collect in-window candidates first (prefiltering entries whose feed genre
// already maps to a non-preferred tag — they'd be dropped at the filter, so
// don't spend a lookup; unmapped labels still get looked up for a real
// genre). Then enrich all candidates with one batched lookup instead of one
// paced call each: classify() needs trackCount, which the chart feed lacks.
const candidates = []
for (const { rank, entry: e } of chart) {
  if (!e.releaseDate || !inWindow(e.releaseDate)) continue
  const feedGenre = (e.genres ?? []).map((g) => g.name).find((n) => n && n !== 'Music') ?? null
  const mapped = feedGenre && GENRE_MAP.some(([re]) => re.test(feedGenre))
  if (
    mapped &&
    !isGenrePreferred(canonGenre(feedGenre)) &&
    !PREFERRED_ARTIST_RES.some((re) => re.test(normArtist(e.artistName)))
  ) {
    log(`skipped chart lookup: ${e.artistName} — ${e.name} [${canonGenre(feedGenre)}]`)
    continue
  }
  candidates.push({ rank, e, feedGenre })
}

const chartInfo = new Map() // collection id → lookup hit
const wanted = [...new Set(candidates.map((x) => String(x.e.id)))]
if (wanted.length) {
  try {
    const d = await itunesJSON(`https://itunes.apple.com/lookup?id=${wanted.join(',')}&country=us`)
    for (const r of d.results ?? []) chartInfo.set(String(r.collectionId), r)
  } catch (e) {
    log(`chart enrichment lookup failed — falling back to feed data: ${e.message}`)
  }
}

for (const { rank, e, feedGenre } of candidates) {
  const hit = chartInfo.get(String(e.id))
  releases.push({
    title: displayTitle(e.name),
    artist: e.artistName,
    artist_id: hit?.artistId ?? e.artistId,
    type: classify(e.name, hit?.trackCount),
    release_date: e.releaseDate,
    artwork: artUrl(e.artworkUrl100),
    genre: canonGenre(hit?.primaryGenreName ?? feedGenre),
    link: appleLink(hit?.collectionViewUrl ?? e.url),
    charting: { storefront: 'US', rank },
  })
}

// 3. Genre purchase charts — day-of new releases in core preferred genres
for (const settled of await genreFeedsP) {
  if (settled.status === 'rejected') {
    anyFailed = true
    log(`genre feed failed: ${settled.reason.message}`)
    continue
  }
  const { tag, feedType, found } = settled.value
  if (found.length) log(`${tag} ${feedType}: ${found.length} in-window`)
  releases.push(...found)
}

// 4. Editorial playlists — curated day-of releases across all genres
for (const settled of await playlistPagesP) {
  if (settled.status === 'rejected') {
    anyFailed = true
    log(`playlist scrape failed: ${settled.reason.message}`)
    continue
  }
  const { pl, tracks, albumIds } = settled.value
  log(`${pl.name}: ${tracks} tracks → ${albumIds.length} unique albums`)
  try {
    let found = 0
    for (let i = 0; i < albumIds.length; i += 100) {
      const d = await itunesJSON(
        `https://itunes.apple.com/lookup?id=${albumIds.slice(i, i + 100).join(',')}&country=us`
      )
      const fresh = (d.results ?? [])
        .filter((a) => a.wrapperType === 'collection' && a.releaseDate && inWindow(a.releaseDate))
        .map(fromCollection)
      found += fresh.length
      releases.push(...fresh)
    }
    log(`${pl.name}: ${found} in-window releases`)
  } catch (e) {
    anyFailed = true
    log(`${pl.name} lookup failed: ${e.message}`)
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
    if (!prev.artist_id && r.artist_id) prev.artist_id = r.artist_id
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
  const hit = chart.find(({ entry: e }) => {
    const ca = normArtist(e.artistName)
    const ct = normTitle(e.name)
    return ca === a && (ct === t || ct.startsWith(t) || t.startsWith(ct))
  })
  if (hit) r.charting = { storefront: 'US', rank: hit.rank }
}

// filter precedence: artist block > artist prefer > genre block > genre prefer
// > drop. Chart discovery only surfaces preferred genres; a preferred artist
// bypasses genre rules entirely.
const before = out.length
out = out.filter((r) => {
  if (isArtistBlocked(r)) return logDrop(r, 'artist blocked')
  if (r.preferred) return true
  if (isGenreBlocked(r.genre)) return logDrop(r, `genre blocked [${r.genre}]`)
  if (isGenrePreferred(r.genre)) return true
  return logDrop(r, `genre not preferred [${r.genre ?? 'none'}]`)
})
function logDrop(r, why) {
  log(`dropped: ${r.artist} — ${r.title} (${why})`)
  return false
}
if (before !== out.length) log(`${before - out.length} releases filtered out`)

// artist_id was match-time plumbing for ID-based blocking — not display data
for (const r of out) delete r.artist_id

// sort: preferred artists first, then alphabetical by artist; newest first
// within one artist's releases
out.sort(
  (a, b) =>
    (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0) ||
    a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) ||
    b.release_date.localeCompare(a.release_date) ||
    a.title.localeCompare(b.title)
)

// Empty-success guard (v1 lesson: an empty success can be a failure in
// disguise). If we got nothing but the previous file still has in-window
// releases, keep those instead of stamping an empty file fresh.
if (out.length === 0) {
  let prev = []
  try {
    prev = JSON.parse(readFileSync(OUT, 'utf8')).releases ?? []
  } catch {}
  const carried = prev
    .filter((r) => inWindow(r.release_date))
    // pre-simplification files stored link as {service, url}
    .map((r) => ({ ...r, link: r.link && typeof r.link === 'object' ? r.link.url : r.link }))
  if (carried.length) {
    log(`0 fetched but ${carried.length} previous in-window releases — carrying over`)
    out = carried
  }
}

mkdirSync(new URL('../docs/data/', import.meta.url), { recursive: true })
writeFileSync(OUT, JSON.stringify({ fetched_at: Date.now(), releases: out }, null, 2))
log(`wrote ${out.length} releases`)
process.exit(anyFailed ? 2 : 0)
