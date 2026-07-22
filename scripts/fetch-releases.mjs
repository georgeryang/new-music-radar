#!/usr/bin/env node
// Fetch new releases and write docs/data/releases.json. Zero deps; run daily
// by scripts/update.sh via launchd. Exit 0 = clean, 2 = a source failed
// (partial data still published).
//
// Apple-only, US storefront only: other storefronts localize artist names
// (KR lists CHUU as 츄), splitting the dedup key. Foreign-only releases appear
// once they propagate to the US catalog (usually within hours). Five sources:
//   1. Followed artists (preferences.json) — batched iTunes lookups; the
//      guaranteed layer. Same sweep collects pre-orders → the Upcoming tab.
//   2. US most-played chart.
//   3. US iTunes genre purchase charts (GENRE_FEEDS) — purchases spike on
//      release day, so drops appear within hours (most-played lags by days).
//   4. Editorial playlists (discovery.playlists) — scraped, curated day-of.
//   5. Country charts (discovery.countries) — each country's most-played +
//      purchase charts. Foreign feeds contribute collection IDS ONLY; every
//      card is built from a US lookup, and US-catalog misses are dropped.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { STOREFRONTS } from './storefronts.mjs'
import { cardKeyOf, keyOf, releaseOrder, upcomingOrder } from './card-key.mjs'

// The file holds WINDOW_DAYS of releases. The app shows followed artists for
// the full window, discovery finds for 24h, both anchored to fetched_at. The
// New/Upcoming split is decided here (inWindow/isUpcoming); the app renders
// releases[] and upcoming[] as written.
const WINDOW_DAYS = 3
const UA = 'new-music-radar/1.0'
const OUT = new URL('../docs/data/releases.json', import.meta.url)

const PREFS = JSON.parse(readFileSync(new URL('../config/preferences.json', import.meta.url), 'utf8'))

// local time, matching update.sh's log() — the two interleave in one file.
const log = (...a) => console.log(`[${new Date().toLocaleString('sv-SE')}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 30s abort: stalled connections have hung batches for 17–78 min; fail fast
// and let the retry pass / carryover handle it.
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

// iTunes Search/Lookup is unofficially rate-limited (~20/min). Every call to
// that host waits out the gap since the previous call (with jitter) rather
// than sleeping a fixed pause after, so processing time counts toward the gap
// and a loop's last call leaves no dangling sleep. Other Apple hosts (legacy
// RSS, web player) aren't limited and use getJSON directly.
let lastItunesCall = 0
async function itunesJSON(url) {
  const wait = lastItunesCall + 2500 + Math.random() * 1500 - Date.now()
  if (wait > 0) await sleep(wait)
  lastItunesCall = Date.now()
  return getJSON(url)
}

// marketingtools (most-played feeds) throttles faster: a burst of ~20 gets
// 503s after the first handful (seen 2026-07-19); ~1 req/s passes. These
// callers all start at once (unlike itunesJSON's sequential awaits), so a
// bare gap check wouldn't hold them — the gate chain hands out start slots
// 1s apart while the fetches overlap.
let lastChartCall = 0
let chartGate = Promise.resolve()
function marketingToolsJSON(url) {
  const myTurn = chartGate.then(async () => {
    const wait = lastChartCall + 1000 + Math.random() * 300 - Date.now()
    if (wait > 0) await sleep(wait)
    lastChartCall = Date.now()
  })
  chartGate = myTurn
  return myTurn.then(() => getJSON(url))
}

// ---------- normalization / canonical key ----------
// keyOf/cardKeyOf live in card-key.mjs, shared with the app so
// the fetcher's dedup and the app's card keys can never differ.

const NOISE_RE = /\b(instrumental|sped[ -]?up|slowed( \+ reverb)?|inst\.)\b/i

// Every window rule below is phrased in days since the release date —
// one definition so the tolerances can't drift apart.
const daysSince = (releaseDate) => (Date.now() - Date.parse(releaseDate)) / 86400e3

function inWindow(releaseDate) {
  const days = daysSince(releaseDate)
  // lower bound: catalogs list pre-orders (future dates) — released-only scope.
  return days <= WINDOW_DAYS + 0.5 && days >= 0
}

// Announced pre-orders: anything still future-dated at fetch time, the exact
// complement of inWindow's lower bound so the two sets stay disjoint. This
// boundary is the ONLY New/Upcoming split — the app renders both lists as
// written; a pre-order moves to releases[] when a fetch finds its date passed,
// never client-side.
const isUpcoming = (releaseDate) => daysSince(releaseDate) < 0

// song (a single) vs album (EPs, mini albums, larger). Apple's "- Single"
// wins over track count (kpop singles often carry an instrumental B-side);
// EP/mini-album wording → album; else 1 track → song, more → album.
function classify(name, trackCount) {
  if (/-\s*single\s*$/i.test(name)) return 'song'
  if (/-\s*ep\s*$|mini album|\bEP\b/i.test(name)) return 'album'
  if (trackCount === 1) return 'song'
  return 'album'
}
const displayTitle = (name) =>
  name.replace(/\s*-\s*(Single|EP)\s*$/i, '').replace(/\s*\(alternate cover[^)]*\)\s*$/i, '').trim()
// Artwork embeds its size in the URL; 400x400 covers the 4-up retina grid.
// Allowlisted to Apple's CDN (one source is scraped) — anything else falls
// back to the placeholder rather than loading a third-party image.
const artUrl = (u) =>
  u && /^https:\/\/[^/]+\.mzstatic\.com\//.test(u) ? u.replace(/\d+x\d+bb/, '400x400bb') : ''
// Normalize any storefront path to /us/ — defense in depth (sources already
// query the US catalog).
const usLink = (u) => (u ? u.replace(/(music|itunes)\.apple\.com\/[a-z]{2}\//, '$1.apple.com/us/') : '')
// Only Apple catalog URLs reach cards — link fields are untrusted (one source
// is scraped) until they match this shape.
const appleLink = (u) =>
  u && /^https:\/\/(music|itunes)\.apple\.com\//.test(u) ? usLink(u) : undefined

// One iTunes lookup result (wrapperType "collection") → release card shape.
// Every lookup-backed source funnels through this so the shapes can't drift.
// artist_id drives ID-based blocking and cross-run carryover matching; the
// app ignores it.
const fromCollection = (a) => ({
  title: displayTitle(a.collectionName),
  artist: a.artistName,
  artist_id: a.artistId,
  type: classify(a.collectionName, a.trackCount),
  release_date: a.releaseDate.slice(0, 10),
  artwork: artUrl(a.artworkUrl100),
  // verbatim Apple genre name — cards show it and the follow filter matches it exactly
  genre: a.primaryGenreName ?? null,
  link: appleLink(a.collectionViewUrl),
})

const GENRES_FOLLOWED = (PREFS.genres?.followed ?? []).map((s) => s.toLowerCase())

// Both artist lists are {name, id}; fetching and blocking key on the ID.
const FOLLOWED_ENTRIES = PREFS.artists?.followed ?? []
// Blocking is by Apple ID — precise ("Drake" can't catch "Drake Milligan").
// Caveat: a blocked artist's collabs carry a joint entity's ID, not theirs,
// so those aren't blocked.
const BLOCKED_IDS = new Set()
for (const e of PREFS.artists?.blocked ?? []) {
  if (e?.id) BLOCKED_IDS.add(e.id)
  else log(`blocked artist "${e?.name ?? e}" has no Apple ID — re-add via the prefs picker; not blocking`)
}

// genres.followed holds exact Apple genre names — a release passes when its
// verbatim genre matches one, case-insensitively. No umbrella mapping.
const isGenreFollowed = (g) => !!g && GENRES_FOLLOWED.includes(g.toLowerCase())
const isArtistBlocked = (r) => !!r.artist_id && BLOCKED_IDS.has(r.artist_id)

// ---------- followed artists via iTunes ----------

// Batched sweep: one paced lookup per BATCH_SIZE artists (comma-joined ids),
// each returning its most recent albums. Response order is Apple's recency
// ranking, interleaved across artists; nothing here depends on it.
const BATCH_SIZE = 20

// Newest US release date per swept artist id — feeds the editor's dormancy
// hints. Only current-sweep ids are recorded (batch responses also carry
// collab partners' ids, which would plant stale dates); future dates skipped,
// file pruned to the followed list on write.
const ACTIVITY_PATH = new URL('../config/artist-activity.json', import.meta.url)
let artistActivity = {}
try {
  artistActivity = JSON.parse(readFileSync(ACTIVITY_PATH, 'utf8'))
} catch {}

// Sweep-found pre-orders, collected across batches → the Upcoming tab (its
// own mini-pipeline at the end).
const upcomingRaw = []

async function batchReleases(ids) {
  const data = await itunesJSON(
    `https://itunes.apple.com/lookup?id=${ids.join(',')}&entity=album&country=us&limit=100&sort=recent`
  )
  const collections = (data.results ?? []).filter((r) => r.wrapperType === 'collection')
  const swept = new Set(ids)
  const today = new Date().toISOString().slice(0, 10)
  for (const a of collections) {
    const d = a.releaseDate?.slice(0, 10)
    if (!swept.has(a.artistId) || !d || d > today) continue
    if (!artistActivity[a.artistId] || d > artistActivity[a.artistId]) artistActivity[a.artistId] = d
  }
  upcomingRaw.push(
    ...collections.filter((a) => a.releaseDate && isUpcoming(a.releaseDate)).map(fromCollection)
  )
  return collections.filter((a) => a.releaseDate && inWindow(a.releaseDate)).map(fromCollection)
}

// Batched collection-id lookup (chunks of 100), shared by chart enrichment,
// song-chart resolution, and playlist albums. Run-scoped cache serves repeats
// (a hot release charts in several sources) for free. Keys stringified — a
// number/string mismatch would silently miss.
const collectionCache = new Map()
async function lookupCollections(ids) {
  // digits only: ids come from feeds, chart JSON, and SCRAPED playlist pages
  // and get comma-joined into a lookup URL — one guard against smuggled query
  // syntax
  const wanted = [...new Set(ids.map(String))].filter((id) => /^\d+$/.test(id))
  const hits = wanted.map((id) => collectionCache.get(id)).filter(Boolean)
  const misses = wanted.filter((id) => !collectionCache.has(id))
  for (let i = 0; i < misses.length; i += 100) {
    const d = await itunesJSON(`https://itunes.apple.com/lookup?id=${misses.slice(i, i + 100).join(',')}&country=us`)
    for (const r of (d.results ?? []).filter((r) => r.wrapperType === 'collection')) {
      collectionCache.set(String(r.collectionId), r)
      // keep every collection Apple sends, not just exact id matches: a
      // stale/scraped id can resolve to a replacement under a different id,
      // and dropping it would silently lose the card
      hits.push(r)
    }
  }
  return hits
}

// ---------- Apple most-played chart (discovery) ----------

async function fetchChart() {
  const data = await marketingToolsJSON(
    'https://rss.marketingtools.apple.com/api/v2/us/music/most-played/50/albums.json'
  )
  return data.feed?.results ?? []
}

// ---------- genre charts (iTunes purchase charts — day-of discovery) ----------

// iTunes Store *purchase* charts per core genre: buying spikes on release day,
// so drops appear within hours (most-played lags by days). This list controls
// where we look, not what we keep — the followed-genres filter still applies.
// Each tag is the feed's Apple genre name, used verbatim only as the fallback
// when an entry has no lookup-backed genre. The umbrella tags Chinese/African
// aren't in genres.followed, so their fallback cards drop unless the bare name
// is followed (accepted).
const GENRE_FEEDS = [
  { genreId: 51, tag: 'K-Pop' },
  { genreId: 12, tag: 'Latin' },
  { genreId: 14, tag: 'Pop' },
  { genreId: 15, tag: 'R&B/Soul' },
  { genreId: 27, tag: 'J-Pop' },
  { genreId: 1232, tag: 'Chinese' },
  { genreId: 1203, tag: 'African' },
]

// A feed's in-window raw entries. topalbums entries are collections; topsongs
// entries are TRACKS, so emitting them directly would put one card per track
// of the same single. Song entries contribute only their parent collection id
// (resolved later), so every card is exactly one Apple collection.
async function genreFeed(feedType, genreId) {
  const data = await getJSON(
    `https://itunes.apple.com/us/rss/${feedType}/genre=${genreId}/limit=100/json`
  )
  return (data.feed?.entry ?? []).filter(
    (e) => e['im:releaseDate']?.label && inWindow(e['im:releaseDate'].label)
  )
}

// Fallback card from feed data alone — only when the shared lookup fails, so
// an outage doesn't cost the day-of finds. genre is the feed's own Apple name,
// the best stand-in when the catalog label is unreachable.
const albumEntryToRelease = (e, tag) => ({
  title: displayTitle(e['im:name'].label),
  artist: e['im:artist'].label,
  // the feed has no artistId field, but the artist URL ends in one
  artist_id: Number(e['im:artist']?.attributes?.href?.match(/\/(\d+)(?:\?|$)/)?.[1]) || undefined,
  type: classify(e['im:name'].label, Number(e['im:itemCount']?.label)),
  release_date: e['im:releaseDate'].label.slice(0, 10),
  artwork: artUrl(e['im:image']?.at(-1)?.label),
  genre: tag,
  link: appleLink(e.id?.label),
})

// ---------- country charts (per-storefront discovery) ----------

// Each followed country adds its most-played Top 100 (marketingtools) and
// purchase charts (legacy RSS) to the scan. Codes outside STOREFRONTS (the
// editor's verified set) are skipped loudly, not fetched blind.
const COUNTRY_CODES = [...new Set((PREFS.discovery?.countries ?? []).map((c) => String(c).toLowerCase()))].filter((c) => {
  // hasOwn, not truthiness: an inherited key ("constructor") is unknown too
  if (Object.hasOwn(STOREFRONTS, c)) return true
  log(`unknown storefront code "${c}" in discovery.countries — skipped`)
  return false
})

// A country entry contributes only its parent collection id (names/links are
// localized). All three feed kinds carry a release date, so entries are
// date-filtered IN-FEED before any id is pooled — that bound keeps the paced
// lookup at 1–2 chunks no matter how many countries are followed.
async function countryMostPlayed(sf) {
  const data = await marketingToolsJSON(
    `https://rss.marketingtools.apple.com/api/v2/${sf}/music/most-played/100/songs.json`
  )
  return (data.feed?.results ?? [])
    .filter((e) => e.releaseDate && inWindow(e.releaseDate))
    // song entries: url is /{sf}/album/<slug>/<collectionId>?i=<trackId>
    .map((e) => e.url?.match(/\/album\/[^/]+\/(\d+)/)?.[1])
    .filter(Boolean)
}

// legacy RSS serializes a single-entry feed as an OBJECT, not a one-element
// array — the near-empty kr/cn feeds hit this where the US ones never do
const asList = (x) => (Array.isArray(x) ? x : x ? [x] : [])

async function countryPurchaseFeed(sf, feedType) {
  const data = await getJSON(`https://itunes.apple.com/${sf}/rss/${feedType}/limit=100/json`)
  const entries = asList(data.feed?.entry).filter(
    (e) => e['im:releaseDate']?.label && inWindow(e['im:releaseDate'].label)
  )
  return feedType === 'topalbums'
    ? entries.map((e) => e.id?.attributes?.['im:id']).filter(Boolean)
    : entries.map((e) => e.id?.label?.match(/\/album\/[^/]+\/(\d+)/)?.[1]).filter(Boolean)
}

// ---------- editorial playlists (scraped web player pages) ----------

// Playlists are the only day-of, all-genre surface Apple exposes without an
// API token. The web player page embeds the track list as JSON; this parses
// it to parent-album ids (resolved to releases by the paced lookups later).
// The page fetch is unthrottled and overlaps the artist sweep. Scraping is
// the fragile source — failures must be loud (exit 2).
async function playlistAlbumIds(pl) {
  // usLink: pin the scrape to /us/ even if a pasted URL carries another code
  const res = await fetch(usLink(pl.url), {
    // full browser UA: the web player only embeds the JSON for browsers
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    },
    signal: AbortSignal.timeout(30_000),
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
      // parent album is in a tertiary link of kind "album"; fall back to the
      // item's own descriptor (also an album id in practice)
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

// Discovery fetches start now and resolve behind the paced artist sweep, so
// their wall time disappears. Genre feeds and playlist pages are unthrottled
// (genre feeds share the itunes host with Search/Lookup, so a small stagger
// as insurance); the US chart takes the marketingtools lane's first slot.
const chartP = fetchChart()
// chartP is consumed after the sweep — without this handler, a chart failure
// mid-sweep is an unhandled rejection that kills the run before anything is
// written. (The other two starters are allSettled and can't reject.)
chartP.catch(() => {})
const genreFeedsP = Promise.allSettled(
  GENRE_FEEDS.flatMap(({ genreId, tag }, gi) =>
    ['topalbums', 'topsongs'].map((feedType, fi) =>
      sleep((gi * 2 + fi) * 250)
        .then(() => genreFeed(feedType, genreId))
        .then(
          (entries) => ({ tag, feedType, entries }),
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
// Tasks (not bare promises) so failures can be retried by re-calling run().
// most-played takes the marketingtools lane; legacy feeds continue the genre
// feeds' stagger on the shared itunes host. All overlap the sweep.
const COUNTRY_TASKS = COUNTRY_CODES.flatMap((sf, ci) => [
  { sf, kind: 'most-played', stagger: 0, run: () => countryMostPlayed(sf) },
  ...['topalbums', 'topsongs'].map((feedType, fi) => ({
    sf,
    kind: feedType,
    stagger: (GENRE_FEEDS.length * 2 + ci * 2 + fi) * 250,
    run: () => countryPurchaseFeed(sf, feedType),
  })),
])
const countryFeedsP = Promise.allSettled(COUNTRY_TASKS.map((t) => sleep(t.stagger).then(t.run)))

// 1. Followed artists — the guaranteed layer. Every entry needs an Apple ID
// (the picker adds one); name-only entries are ambiguous (three "Sabrina"s
// exist) and skipped loudly.
const sweepArtists = FOLLOWED_ENTRIES.filter((e) => {
  if (e?.id) return true
  log(`"${e?.name ?? e}" has no Apple artist ID — re-add it via the prefs editor picker; skipped`)
  return false
})

const batches = []
for (let i = 0; i < sweepArtists.length; i += BATCH_SIZE) batches.push(sweepArtists.slice(i, i + BATCH_SIZE))
let followedCount = 0
let failedBatches = []
// timeouts surface as TimeoutError, undici network errors carry a cause code —
// both matter when diagnosing why a batch failed from the log alone
const errDetail = (e) => `${e.message}${e.cause?.code ? ` [${e.cause.code}]` : e.name === 'TimeoutError' ? ' [timeout]' : ''}`
// batchReleases throws only at its lookup await (before pushing anything), so
// a failed batch can be re-run without double-counting releases or pre-orders.
async function sweepBatch(n, batch) {
  const found = await batchReleases(batch.map((a) => a.id))
  followedCount += found.length
  releases.push(...found)
  log(
    `batch ${n}/${batches.length} (${batch.length} artists)` +
      (found.length ? ` — ${found.length} new: ${[...new Set(found.map((f) => f.artist))].join(', ')}` : '')
  )
}
let n = 0
for (const batch of batches) {
  n++
  try {
    await sweepBatch(n, batch)
  } catch (e) {
    failedBatches.push({ n, batch })
    log(`batch ${n}/${batches.length} failed: ${errDetail(e)}`)
  }
}
// One retry pass: the failures are intermittent connection stalls, so a
// second paced attempt after a backoff usually lands. Runs before the
// artistActivity write so rescued batches' updates are included.
if (failedBatches.length) {
  log(`retrying ${failedBatches.length} failed batches in 15s`)
  await sleep(15_000)
  const stillFailed = []
  for (const { n, batch } of failedBatches) {
    try {
      await sweepBatch(n, batch)
    } catch (e) {
      stillFailed.push({ n, batch })
      log(`batch ${n}/${batches.length} failed again: ${errDetail(e)}`)
    }
  }
  failedBatches = stillFailed
}
const batchFailures = failedBatches.length
// Which artists' data is missing this run, for the Upcoming carryover —
// matched by swept id (the follow list is id-only).
const failedSweepIds = new Set(failedBatches.flatMap(({ batch }) => batch.map((a) => a.id)))
// prune to the followed list: unfollowed artists' entries are frozen (never
// re-swept) and would resurface stale if re-followed. Future dates dropped too
// — the only-newer update rule means a real date could never displace one.
const sweepIds = new Set(sweepArtists.map((a) => a.id))
const todayStr = new Date().toISOString().slice(0, 10)
artistActivity = Object.fromEntries(
  Object.entries(artistActivity).filter(([id, d]) => sweepIds.has(Number(id)) && d <= todayStr)
)
writeFileSync(ACTIVITY_PATH, JSON.stringify(artistActivity, null, 2) + '\n')
log(`${followedCount} releases (pre-dedup) via ${sweepArtists.length} followed artists in ${batches.length} batches`)
// a failed batch is ~10 artists silently skipped — flag the run (exit 2)
if (batchFailures > 0) anyFailed = true

// 2. Chart — in-window entries from the US most-played chart as discovery
let chart = []
try {
  chart = await chartP
} catch (e) {
  anyFailed = true
  log(`US chart fetch failed: ${e.message}`)
}

// Collect in-window candidates, prefiltering entries whose feed genre isn't
// followed (they'd be dropped anyway — save the lookup; accepts the rare case
// where the catalog genre differs from the feed's). Then one batched lookup
// enriches all of them: classify() needs trackCount, which the feed lacks.
const candidates = []
const skippedChart = []
for (const e of chart) {
  if (!e.releaseDate || !inWindow(e.releaseDate)) continue
  const feedGenre = (e.genres ?? []).map((g) => g.name).find((n) => n && n !== 'Music') ?? null
  // keep a followed artist's chart hit for lookup even when its feed genre
  // isn't followed — matched by id (the feed serializes artistId as a string)
  if (
    feedGenre &&
    !isGenreFollowed(feedGenre) &&
    !sweepIds.has(Number(e.artistId))
  ) {
    skippedChart.push(`${e.artistName} — ${e.name}`)
    continue
  }
  candidates.push({ e, feedGenre })
}
if (skippedChart.length)
  log(
    `${skippedChart.length} chart lookups skipped (unfollowed genre): ${skippedChart.slice(0, 3).join('; ')}${skippedChart.length > 3 ? '; …' : ''}`
  )

const chartInfo = new Map() // collection id → lookup hit
const wanted = [...new Set(candidates.map((x) => String(x.e.id)))]
if (wanted.length) {
  try {
    for (const r of await lookupCollections(wanted)) chartInfo.set(String(r.collectionId), r)
  } catch (e) {
    // degraded publish (feed-only genre/type) still counts as a failed source
    anyFailed = true
    log(`chart enrichment lookup failed — falling back to feed data: ${e.message}`)
  }
}

for (const { e, feedGenre } of candidates) {
  const hit = chartInfo.get(String(e.id))
  releases.push({
    title: displayTitle(e.name),
    artist: e.artistName,
    // the feed serializes artistId as a string; BLOCKED_IDS holds numbers
    artist_id: Number(hit?.artistId ?? e.artistId) || undefined,
    type: classify(e.name, hit?.trackCount),
    release_date: e.releaseDate.slice(0, 10),
    artwork: artUrl(e.artworkUrl100),
    genre: hit?.primaryGenreName ?? feedGenre,
    link: appleLink(hit?.collectionViewUrl ?? e.url),
  })
}

// 3. Genre purchase charts — day-of releases in followed genres. Both feed
// types reduce to collection ids resolved through the shared lookup, so cards
// carry Apple's verbatim genre (feed membership picks where we look, not the
// genre). Album entries keep raw feed data as a lookup-failure fallback.
const genreFeedIds = new Map() // collection id → feed name (first feed wins)
const feedAlbumFallback = new Map() // collection id → raw topalbums entry
for (const settled of await genreFeedsP) {
  if (settled.status === 'rejected') {
    anyFailed = true
    log(`genre feed failed: ${settled.reason.message}`)
    continue
  }
  const { tag, feedType, entries } = settled.value
  if (!entries.length) continue
  if (feedType === 'topalbums') {
    for (const e of entries) {
      const id = e.id?.attributes?.['im:id']
      if (!id || !/^\d+$/.test(id)) continue
      if (!genreFeedIds.has(id)) genreFeedIds.set(id, tag)
      if (!feedAlbumFallback.has(id)) feedAlbumFallback.set(id, e)
    }
    log(`${tag} topalbums: ${entries.length} in-window`)
  } else {
    // track URLs look like /album/<slug>/<collectionId>?i=<trackId>
    const ids = entries
      .map((e) => e.id?.label?.match(/\/album\/[^/]+\/(\d+)/)?.[1])
      .filter(Boolean)
    ids.forEach((id) => genreFeedIds.set(id, genreFeedIds.get(id) ?? tag))
    log(`${tag} topsongs: ${entries.length} in-window tracks → ${ids.length} parent albums`)
  }
}
if (genreFeedIds.size) {
  try {
    const hits = await lookupCollections([...genreFeedIds.keys()])
    const returned = new Set(hits.map((a) => String(a.collectionId)))
    const fresh = hits.filter((a) => a.releaseDate && inWindow(a.releaseDate)).map(fromCollection)
    for (const [id, e] of feedAlbumFallback) {
      if (!returned.has(id)) fresh.push(albumEntryToRelease(e, genreFeedIds.get(id)))
    }
    log(`genre charts: ${fresh.length} releases via ${genreFeedIds.size} ids`)
    releases.push(...fresh)
  } catch (e) {
    anyFailed = true
    log(`genre chart lookup failed — album entries fall back to feed data: ${e.message}`)
    releases.push(...[...feedAlbumFallback.entries()].map(([id, e]) => albumEntryToRelease(e, genreFeedIds.get(id))))
  }
}

// 3b. Country charts — date-filtered collection ids from the country feeds.
// Ids already on the US most-played chart are skipped (covered there; keeps
// global hits off every country's chart); the rest resolve through one shared
// US lookup. Ids Apple doesn't return aren't in the US catalog yet — dropped
// with a per-storefront count, they make a later fetch once they propagate.
const usChartIds = new Set(chart.map((e) => String(Number(e.id))).filter((s) => s !== 'NaN'))
const countryIdSources = new Map() // collection id → Set of storefronts that surfaced it
let usChartSubtracted = 0
const ingestCountryFeed = ({ sf, kind }, ids) => {
  if (!ids.length) return
  let fresh = 0
  for (const raw of ids) {
    // marketingtools serializes ids as strings, lookups return numbers —
    // normalize before any set membership (the known type trap)
    const id = String(Number(raw))
    if (id === 'NaN') continue
    if (usChartIds.has(id)) {
      usChartSubtracted++
      continue
    }
    const sfs = countryIdSources.get(id)
    if (sfs) {
      // every surfacing storefront gets credit — first-wins would undercount
      // later-listed countries in the editor's audit
      sfs.add(sf)
    } else {
      countryIdSources.set(id, new Set([sf]))
      fresh++
    }
  }
  log(`${sf} ${kind}: ${ids.length} in-window → ${fresh} new ids`)
}
// One retry pass, like the sweep's: most-played 503s are transient throttling.
const failedCountryFeeds = []
;(await countryFeedsP).forEach((settled, i) => {
  if (settled.status === 'rejected') {
    const t = COUNTRY_TASKS[i]
    failedCountryFeeds.push(t)
    log(`country chart failed (will retry): ${t.sf} ${t.kind}: ${errDetail(settled.reason)}`)
  } else {
    ingestCountryFeed(COUNTRY_TASKS[i], settled.value)
  }
})
if (failedCountryFeeds.length) {
  log(`retrying ${failedCountryFeeds.length} failed country feeds in 15s`)
  await sleep(15_000)
  const retried = await Promise.allSettled(
    failedCountryFeeds.map((t, i) => sleep(i * 250).then(t.run))
  )
  retried.forEach((settled, i) => {
    const t = failedCountryFeeds[i]
    if (settled.status === 'rejected') {
      anyFailed = true
      log(`country chart failed again: ${t.sf} ${t.kind}: ${errDetail(settled.reason)}`)
    } else {
      ingestCountryFeed(t, settled.value)
    }
  })
}
if (usChartSubtracted) log(`country charts: ${usChartSubtracted} ids already on the US chart — skipped`)
if (countryIdSources.size) {
  try {
    const hits = await lookupCollections([...countryIdSources.keys()])
    const returned = new Set(hits.map((a) => String(a.collectionId)))
    const droppedBySf = new Map()
    for (const [id, sfs] of countryIdSources) {
      // attribute drops to the first surfacer only — one log line per miss
      const sf = sfs.values().next().value
      if (!returned.has(id)) droppedBySf.set(sf, (droppedBySf.get(sf) ?? 0) + 1)
    }
    for (const [sf, count] of droppedBySf) log(`sf=${sf} dropped ${count} not in US catalog`)
    // sources tags feed the editor's per-source audit chips; the app ignores them
    const found = hits
      .filter((a) => a.releaseDate && inWindow(a.releaseDate))
      .map((a) => {
        const r = fromCollection(a)
        const sfs = countryIdSources.get(String(a.collectionId))
        if (sfs) r.sources = [...sfs].map((sf) => `country:${sf}`)
        return r
      })
    log(`country charts: ${found.length} releases via ${countryIdSources.size} ids`)
    releases.push(...found)
  } catch (e) {
    anyFailed = true
    log(`country chart lookup failed: ${e.message}`)
  }
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
    const fresh = (await lookupCollections(albumIds))
      .filter((a) => a.releaseDate && inWindow(a.releaseDate))
      .map((a) => ({ ...fromCollection(a), sources: [`playlist:${pl.name}`] }))
    log(`${pl.name}: ${fresh.length} in-window releases`)
    releases.push(...fresh)
  } catch (e) {
    anyFailed = true
    log(`${pl.name} lookup failed: ${e.message}`)
  }
}

// mark followed artists (before dedup so merges keep the flag) — ★ + filter
// bypass for a followed artist's own releases, matched by Apple artist_id (the
// follow list is id-only, same as the block list). A collab credited to a
// separate joint-entity id won't match — accepted.
for (const r of releases) {
  if (r.artist_id && sweepIds.has(r.artist_id)) r.followed = true
}

// noise + canonical-key dedup (type is in the key: same-titled song + album
// both survive; duplicates across sources collapse into one card)
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
    if (!prev.artist_id && r.artist_id) prev.artist_id = r.artist_id
    // a null-genre copy landing first mustn't cost the release its genre (the
    // filter would drop it as "genre not followed")
    if (!prev.genre && r.genre) prev.genre = r.genre
    // union so an album on two sources credits both in the editor's audit
    if (r.sources?.length) prev.sources = [...new Set([...(prev.sources ?? []), ...r.sources])]
    prev.followed = prev.followed || r.followed
  } else {
    byKey.set(k, r)
  }
}
let out = [...byKey.values()]

// filter precedence: artist block > artist follow > genre follow > drop.
// Discovery only surfaces followed genres; a followed artist bypasses
// genre rules entirely.
const before = out.length
// genre drops are the bulk (dozens per run) — one summary line; blocked-artist
// drops stay individual (rare, worth seeing what the block list caught)
const genreDrops = new Map()
out = out.filter((r) => {
  if (isArtistBlocked(r)) return logDrop(r, 'artist blocked')
  if (r.followed) return true
  if (isGenreFollowed(r.genre)) return true
  const g = r.genre ?? 'none'
  genreDrops.set(g, (genreDrops.get(g) ?? 0) + 1)
  return false
})
function logDrop(r, why) {
  log(`dropped: ${r.artist} — ${r.title} (${why})`)
  return false
}
if (before !== out.length)
  log(
    `${before - out.length} releases filtered out` +
      (genreDrops.size
        ? ` — unfollowed genres: ${[...genreDrops.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(', ')}`
        : '')
  )

// Previous file — read once, three consumers below (empty-success guard +
// the two per-entry carryovers).
let prevFile = {}
try {
  prevFile = JSON.parse(readFileSync(OUT, 'utf8'))
} catch {}

// Empty-success guard (an empty success can be a failure in disguise): if we
// fetched nothing but the previous file has in-window releases, keep those
// rather than stamp an empty file. Must run before the per-entry carryover
// (it keys on the result being empty) and is the only path that also
// preserves discovery entries.
if (out.length === 0) {
  const carried = (prevFile.releases ?? []).filter((r) => inWindow(r.release_date))
  if (carried.length) {
    log(`0 fetched but ${carried.length} previous in-window releases — carrying over`)
    out = carried
  }
}

// Upcoming (pre-orders) — followed artists only: keep entries whose artist id
// was swept; a collab pre-order under a joint entity id drops here. Same
// noise/dedup/block rules as the main list, soonest first. An empty list from
// a clean sweep is normal; entries whose batch failed carry over below so a
// tracked pre-order never vanishes on a bad night.
const upcomingByKey = new Map()
for (const r of upcomingRaw) {
  if (NOISE_RE.test(r.title) || isArtistBlocked(r)) continue
  if (!sweepIds.has(r.artist_id)) continue
  r.followed = true
  const prev = upcomingByKey.get(keyOf(r))
  if (!prev) {
    upcomingByKey.set(keyOf(r), r)
  } else {
    // same back-fill as the main dedup — first-seen may be the sparse copy
    // (a joint-credit listing without artwork/link)
    if (r.release_date < prev.release_date) prev.release_date = r.release_date
    if (!prev.artwork && r.artwork) prev.artwork = r.artwork
    if (!prev.link && r.link) prev.link = r.link
    if (!prev.genre && r.genre) prev.genre = r.genre
  }
}
// Per-entry carryover (both lists): a failed batch means that artist's data is
// missing this run, so their previous in-window releases and pre-orders carry
// over rather than vanish. Entries whose artist swept SUCCESSFULLY but no
// longer returned drop (canceled/pulled); a date change re-lands under the
// same key so the fresh copy wins. Followed artists only (carried discovery
// would be hidden by the client's 24h window anyway). A carried pre-order
// whose date has since passed routes to releases[], completing the lifecycle
// even if release day itself fails.
if (batchFailures > 0) {
  // attribution by swept id; entries with NO artist_id can't be verified —
  // keep them (unknown-means-keep) until a clean sweep rewrites them with ids
  const missingThisRun = (r) =>
    r.artist_id == null ||
    failedSweepIds.has(r.artist_id)
  // block list / noise rules may have changed since the entry was written
  const stillEligible = (r) => !NOISE_RE.test(r.title) && !isArtistBlocked(r)
  const outKeys = new Set(out.map(keyOf))
  for (const r of prevFile.releases ?? []) {
    if (!r.followed || !inWindow(r.release_date) || outKeys.has(keyOf(r))) continue
    if (!missingThisRun(r) || !stillEligible(r)) continue
    outKeys.add(keyOf(r))
    out.push(r)
    log(`carried over (batch failed): ${r.artist} — ${r.title}`)
  }
  // outKeys now includes carried releases, keeping the two lists disjoint
  for (const r of prevFile.upcoming ?? []) {
    if (daysSince(r.release_date) > WINDOW_DAYS + 0.5) continue
    if (upcomingByKey.has(keyOf(r))) continue
    if (!missingThisRun(r) || !stillEligible(r)) continue
    r.followed = true
    if (isUpcoming(r.release_date)) {
      // still future — no out check: it may share keyOf with a released
      // edition (deluxe pre-order) but dates differ; the card-level
      // disjointness filter below is the backstop
      upcomingByKey.set(keyOf(r), r)
    } else {
      // date passed while the artist's batch was failing — belongs on New
      // now, unless a discovery source already fetched it fresh
      if (outKeys.has(keyOf(r))) continue
      outKeys.add(keyOf(r))
      out.push(r)
    }
    log(`carried over (batch failed): ${r.artist} — ${r.title}`)
  }
}
// Lists must be disjoint by card (cardKeyOf): a run straddling UTC midnight
// could land the same card in both. Same keyOf with a different date is
// legitimate (deluxe pre-order of a released album) and stays.
const outCards = new Set(out.map(cardKeyOf))
const upcoming = [...upcomingByKey.values()]
  .filter((r) => !outCards.has(cardKeyOf(r)))
  .sort(upcomingOrder)
log(`${upcoming.length} upcoming pre-orders`)

out.sort(releaseOrder)

mkdirSync(new URL('../docs/data/', import.meta.url), { recursive: true })
writeFileSync(OUT, JSON.stringify({ fetched_at: Date.now(), releases: out, upcoming }, null, 2))
log(`wrote ${out.length} releases + ${upcoming.length} upcoming`)
process.exit(anyFailed ? 2 : 0)
