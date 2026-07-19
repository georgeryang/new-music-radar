#!/usr/bin/env node
// Fetch new releases and write docs/data/releases.json. Zero deps.
// Run daily by scripts/update.sh via launchd.
//
// Apple-only follow-list architecture. Every source queries the US storefront
// exclusively — other storefronts localize artist names (KR lists CHUU as 츄),
// which splits the dedup key and duplicates cards. A release that exists only
// in a foreign catalog appears once it propagates to the US one (usually
// within hours; the 3-day window means it still makes the next fetch).
//   1. Followed artists (config/preferences.json) — batched iTunes lookups,
//      newest releases first. The guaranteed layer; everything is native
//      Apple Music: link, genre, artwork, release date. The same sweep also
//      yields announced pre-orders (future release dates) → the Upcoming tab.
//   2. Apple US most-played chart — entries released within the window
//      become cards.
//   3. US iTunes genre purchase charts (GENRE_FEEDS) — purchases spike on
//      release day, so new drops in followed genres appear within hours
//      (most-played lags by days). Song-chart tracks resolve to their parent
//      collection: every card is exactly one Apple collection.
//   4. Editorial playlists (config discovery.playlists, e.g. New Music Daily)
//      — scraped from the web player page; curated day-of, all-genre.
//   5. Country charts (config discovery.countries) — each followed country's
//      most-played Top 100 + purchase charts, date-filtered in-feed. Foreign
//      feeds contribute collection IDS ONLY (their names/links are localized,
//      which would split the dedup key); every card is still built from the
//      US-catalog lookup, so the US-only rule above holds. Entries missing
//      from the US catalog are dropped (they appear once they propagate).
// Releases with no Apple match don't exist here by construction.
//
// Exit codes: 0 = clean run, 2 = a source failed (partial data published).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { STOREFRONTS } from './storefronts.mjs'
import { cardKeyOf, keyOf, normArtist, releaseOrder, upcomingOrder } from './card-key.mjs'

// The file holds WINDOW_DAYS of releases. The frontend (src/App.tsx) shows
// followed artists for that full window and trims discovery finds to 24h —
// both anchored to fetched_at, so nothing expires between fetches. The
// New/Upcoming split is decided here too (inWindow/isUpcoming below); the
// app renders releases[] and upcoming[] as written.
const WINDOW_DAYS = 3
const UA = 'new-music-radar/1.0'
const OUT = new URL('../docs/data/releases.json', import.meta.url)

const PREFS = JSON.parse(readFileSync(new URL('../config/preferences.json', import.meta.url), 'utf8'))

// local time, matching update.sh's log() — the two interleave in one file
// and used to jump hours mid-run (fetcher stamped UTC)
const log = (...a) => console.log(`[${new Date().toLocaleString('sv-SE')}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 30s abort: stalled connections have hung batches for 17–78 minutes —
// far better to fail fast and let the retry pass / carryover handle it.
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

// iTunes Search/Lookup is unofficially rate-limited (~20/min). Every call to
// that host goes through here: it waits out the gap since the previous call
// (with jitter) instead of sleeping a fixed pause afterwards, so time spent
// processing between calls counts toward the gap and the last call of a loop
// doesn't leave a dangling sleep. Other Apple hosts (legacy RSS, the web
// player) are not similarly limited and use getJSON directly.
let lastItunesCall = 0
async function itunesJSON(url) {
  const wait = lastItunesCall + 2500 + Math.random() * 1500 - Date.now()
  if (wait > 0) await sleep(wait)
  lastItunesCall = Date.now()
  return getJSON(url)
}

// marketingtools (most-played feeds) throttles too, just faster: a burst of
// ~20 simultaneous requests gets 503s/stalls after the first handful (seen
// live 2026-07-19); ~1 req/s passes. Unlike itunesJSON — whose callers
// await sequentially — these callers all start at once, so a bare
// gap-since-last-call check would let the whole burst through: the gate
// chain hands out start slots 1s apart while the fetches themselves overlap.
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
// normArtist/keyOf/cardKeyOf live in card-key.mjs, shared with the app so
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
// legacy feeds) — 400x400 covers the 4-up grid on retina screens. Allowlisted
// to Apple's artwork CDN like appleLink does for links: artwork is the only
// other URL field on a card, and one source is scraped, so anything else
// renders as the placeholder rather than a third-party image.
const artUrl = (u) =>
  u && /^https:\/\/[^/]+\.mzstatic\.com\//.test(u) ? u.replace(/\d+x\d+bb/, '400x400bb') : ''
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
// match-time plumbing for ID-based blocking; it stays on written entries so
// failed-batch carryover can match on it across runs (the app ignores it).
const fromCollection = (a) => ({
  title: displayTitle(a.collectionName),
  artist: a.artistName,
  artist_id: a.artistId,
  type: classify(a.collectionName, a.trackCount),
  release_date: a.releaseDate.slice(0, 10),
  artwork: artUrl(a.artworkUrl100),
  // verbatim: cards show Apple's exact genre name ("Afrobeats", "Mandopop"),
  // and the follow filter matches these names exactly
  genre: a.primaryGenreName ?? null,
  link: appleLink(a.collectionViewUrl),
})

const GENRES_FOLLOWED = (PREFS.genres?.followed ?? []).map((s) => s.toLowerCase())

// Both artist lists are {name, id} — the prefs editor's Apple picker pins the
// exact artist by ID, and both fetching (followed) and blocking (blocked)
// key on the ID.
const FOLLOWED_ENTRIES = PREFS.artists?.followed ?? []
// Blocking matches by Apple ID — precise, no name collisions ("Drake" can't
// catch "Drake Milligan"). Caveat: a blocked artist's collabs are credited to
// a joint entity with its own ID, so those aren't blocked.
const BLOCKED_IDS = new Set()
for (const e of PREFS.artists?.blocked ?? []) {
  if (e?.id) BLOCKED_IDS.add(e.id)
  else log(`blocked artist "${e?.name ?? e}" has no Apple ID — re-add via the prefs picker; not blocking`)
}
// Followed *marking* (the ★ + filter bypass for releases arriving via other
// sources) stays name-based on purpose: collab releases are credited to joint
// artist entities whose IDs aren't in the config, but the member's name is in
// the credit string.
// Marking tolerates legacy bare-string entries (pre-migration backups): they
// can't be swept (no ID) but their name still earns the star and filter
// bypass for releases arriving via other sources.
const entryName = (e) => (typeof e === 'string' ? e : e?.name)
// Whole-word match so "IVE" can't match inside "RIIZE". Unicode lookarounds
// instead of \b — \b is ASCII-only and never matches at CJK name boundaries
// (鄧紫棋 would silently lose its followed status).
const nameRe = (name) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${normArtist(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
    'u'
  )
// Names that normalize to nothing (all-symbol acts like "!!!") are excluded:
// nameRe('') is an empty-pattern regex that matches every OTHER symbol-only
// artist's normalized name, wrongly marking their releases followed. Such
// artists are still swept by ID — they just can't earn name-based credit.
const hasNormName = (name) => normArtist(name).length > 0
const FOLLOWED_ARTIST_RES = FOLLOWED_ENTRIES.map(entryName).filter(Boolean).filter(hasNormName).map(nameRe)

// genres.followed holds exact Apple genre names — a release passes when its
// verbatim genre matches one, case-insensitively. No umbrella mapping.
const isGenreFollowed = (g) => !!g && GENRES_FOLLOWED.includes(g.toLowerCase())
const isArtistBlocked = (r) => !!r.artist_id && BLOCKED_IDS.has(r.artist_id)

// ---------- followed artists via iTunes ----------

// Batched sweep: lookup accepts comma-joined ids and returns each artist's
// `limit` most recent albums (Apple's own recency ranking — not a strict
// date sort, and interleaved across artists; nothing here depends on
// response order) with no global cap — one paced call per BATCH_SIZE
// artists instead of one per artist. US storefront only (see the header for
// why).
const BATCH_SIZE = 20

// Newest US release date per swept artist id — feeds the dormancy hints in
// the prefs editor. Only ids in the current sweep are recorded (batch
// responses also carry collab partners' ids, which would plant stale dates);
// pre-order (future) dates are skipped, and the file is pruned to the
// followed list on write.
const ACTIVITY_PATH = new URL('../config/artist-activity.json', import.meta.url)
let artistActivity = {}
try {
  artistActivity = JSON.parse(readFileSync(ACTIVITY_PATH, 'utf8'))
} catch {}

// Pre-orders found by the sweep, collected across batches — becomes the
// Upcoming tab after its own mini-pipeline at the end.
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
// song-chart resolution, and playlist albums. A hot release charting in
// several sources used to be looked up once per source through the paced
// lane — the run-scoped cache serves repeats for free. Keys are stringified:
// callers pass a mix of numbers and strings and a type mismatch would
// silently miss.
const collectionCache = new Map()
async function lookupCollections(ids) {
  // digits only: ids come from feeds, chart JSON, and the SCRAPED playlist
  // pages, and are comma-joined into a lookup URL — this one guard keeps
  // every caller's ids from smuggling query syntax into that URL
  const wanted = [...new Set(ids.map(String))].filter((id) => /^\d+$/.test(id))
  const hits = wanted.map((id) => collectionCache.get(id)).filter(Boolean)
  const misses = wanted.filter((id) => !collectionCache.has(id))
  for (let i = 0; i < misses.length; i += 100) {
    const d = await itunesJSON(`https://itunes.apple.com/lookup?id=${misses.slice(i, i + 100).join(',')}&country=us`)
    for (const r of (d.results ?? []).filter((r) => r.wrapperType === 'collection')) {
      collectionCache.set(String(r.collectionId), r)
      // return every collection Apple sends, not just exact id matches — a
      // stale/scraped id can resolve to a replacement collection under a
      // DIFFERENT collectionId, and dropping it would silently lose the card
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

// Core followed genres get a dedicated new-release watch. These legacy feeds
// are iTunes Store *purchase* charts: fandom buying spikes on release day, so
// a new drop appears within hours — unlike most-played, which lags by days.
// The list controls where we look, not what we keep: the full followed-genres
// list still filters every source. Extend with one line per genre — probe the
// feed title to find a genre id. US storefront only, like every other source.
// Every tag is the feed's own Apple genre name — it lands on cards verbatim
// when an entry has no lookup-backed genre. Note the umbrella tags Chinese
// and African are not in genres.followed, so those two feeds' lookup-failure
// fallback publishes nothing unless the bare name is followed — accepted:
// the list controls where we look, never what we keep.
const GENRE_FEEDS = [
  { genreId: 51, tag: 'K-Pop' },
  { genreId: 12, tag: 'Latin' },
  { genreId: 14, tag: 'Pop' },
  { genreId: 15, tag: 'R&B/Soul' },
  { genreId: 27, tag: 'J-Pop' },
  { genreId: 1232, tag: 'Chinese' },
  { genreId: 1203, tag: 'African' },
]

// Returns a feed's in-window raw entries. topalbums entries are collections
// and map straight to cards; topsongs entries are TRACKS — emitting those
// directly puts one card per track of the same single on the page (both
// sides of a 2-track single chart separately, while the single itself
// arrives from other sources under a third title). Song entries therefore
// only contribute their parent collection id, resolved in a batched lookup
// later, so every card in the system is exactly one Apple collection.
async function genreFeed(feedType, genreId) {
  const data = await getJSON(
    `https://itunes.apple.com/us/rss/${feedType}/genre=${genreId}/limit=100/json`
  )
  return (data.feed?.entry ?? []).filter(
    (e) => e['im:releaseDate']?.label && inWindow(e['im:releaseDate'].label)
  )
}

// Fallback card built from feed data alone — used ONLY when the shared
// catalog lookup fails, so a feed outage doesn't cost the day-of finds. The
// genre is the feed's own Apple genre name (K-Pop, Latin, …), the best
// available stand-in when the catalog's verbatim label is unreachable.
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

// Followed countries from config — each code adds that storefront's
// most-played Top 100 (marketingtools) and purchase charts (legacy RSS) to
// the nightly scan. Unknown codes are skipped loudly rather than fetched
// blind: STOREFRONTS is the verified set the prefs editor offers.
const COUNTRY_CODES = [...new Set((PREFS.discovery?.countries ?? []).map((c) => String(c).toLowerCase()))].filter((c) => {
  // hasOwn, not truthiness: an inherited key ("constructor") must be
  // skipped loudly like any other unknown code, not fetched
  if (Object.hasOwn(STOREFRONTS, c)) return true
  log(`unknown storefront code "${c}" in discovery.countries — skipped`)
  return false
})

// A country chart entry only ever contributes its parent collection id (see
// header — names/links are localized). All three feed kinds carry a
// per-entry release date, so entries are date-filtered IN-FEED before any id
// is pooled: that bound is what keeps the paced lookup cost at 1–2 chunks
// regardless of how many countries are followed.
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

// New Music Daily & friends are the only day-of, all-genre new-release surface
// Apple exposes without an Apple Music API token. The web player page embeds
// the track list as JSON; this parses it down to the parent-album ids. The
// paced batched lookups that resolve those ids to releases happen later in
// the pipeline — the page fetch itself is unthrottled and runs concurrently
// with the artist sweep. Scraping is the fragile source — failures must be
// loud (exit 2), never silent.
async function playlistAlbumIds(pl) {
  // usLink: pin the scrape to the US storefront even if a pasted playlist
  // URL carries another country code — every other source is US-only.
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

// Discovery fetches start now and resolve while the paced artist sweep runs —
// their wall time disappears behind it. The legacy RSS genre feeds and the
// web-player playlist pages are unthrottled (the genre feeds share the
// itunes.apple.com hostname with the throttled Search/Lookup API, so they get
// a small stagger as insurance); the US chart rides the paced marketingtools
// lane and takes its first slot. Results are consumed in pipeline order below.
const chartP = fetchChart()
// chartP is consumed minutes later (after the sweep) — without an early
// handler, a chart failure DURING the sweep is an unhandled rejection that
// kills the whole run before anything is written, holding every other
// source's data hostage. (The other two starters are allSettled and can't
// reject.)
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
// Tasks (not bare promises) so failures can be retried by re-calling run():
// most-played serializes through the marketingtools paced lane; legacy feeds
// continue the genre feeds' stagger sequence on the shared itunes host.
// Everything overlaps the artist sweep either way.
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

// 1. Followed artists — the guaranteed layer, swept in batched lookups.
// Every entry must carry an Apple artist ID (the prefs editor's picker adds
// one) — name-only entries are ambiguous (three distinct "Sabrina"s exist)
// and are skipped loudly rather than guessed at.
const sweepArtists = FOLLOWED_ENTRIES.filter((e) => {
  if (e?.id) return true
  log(`"${entryName(e) ?? e}" has no Apple artist ID — re-add it via the prefs editor picker; skipped`)
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
// One retry pass for failed batches: the failures seen in practice are
// intermittent connection stalls, so a second paced attempt after a short
// backoff usually lands. Runs before the artistActivity write so rescued
// batches' activity updates are included.
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
// Attribution sets for the Upcoming carryover: which artists' data is missing
// this run. Ids for exact matches; name regexes for joint-credit entities
// (their collection carries the joint entity's id, not the member's) and for
// legacy file entries written before artist_id was kept.
const failedSweepIds = new Set(failedBatches.flatMap(({ batch }) => batch.map((a) => a.id)))
const failedArtistRes = failedBatches.flatMap(({ batch }) =>
  batch.map((a) => a.name).filter(Boolean).filter(hasNormName).map(nameRe)
)
// prune to the current followed list — entries for unfollowed artists are
// frozen (never swept again) and would resurface stale if re-followed.
// Future (pre-order) values are dropped too: the only-newer update rule
// means a real release date could never displace one.
const sweepIds = new Set(sweepArtists.map((a) => a.id))
const todayStr = new Date().toISOString().slice(0, 10)
artistActivity = Object.fromEntries(
  Object.entries(artistActivity).filter(([id, d]) => sweepIds.has(Number(id)) && d <= todayStr)
)
writeFileSync(ACTIVITY_PATH, JSON.stringify(artistActivity, null, 2) + '\n')
log(`${followedCount} releases (pre-dedup) via ${sweepArtists.length} followed artists in ${batches.length} batches`)
// any failed batch flags the run — one batch is ~10 followed artists silently
// skipped, which is exactly what exit 2 (partial publish, amber banner) is for
if (batchFailures > 0) anyFailed = true

// 2. Chart — in-window entries from the US most-played chart as discovery
let chart = []
try {
  chart = await chartP
} catch (e) {
  anyFailed = true
  log(`US chart fetch failed: ${e.message}`)
}

// Collect in-window candidates first (prefiltering entries whose feed genre
// is not followed — they'd be dropped at the filter, so don't spend a
// lookup; accepts the rare case where the catalog's genre differs from the
// feed's). Then enrich all candidates with one batched lookup instead of
// one paced call each: classify() needs trackCount, which the chart feed
// lacks.
const candidates = []
const skippedChart = []
for (const e of chart) {
  if (!e.releaseDate || !inWindow(e.releaseDate)) continue
  const feedGenre = (e.genres ?? []).map((g) => g.name).find((n) => n && n !== 'Music') ?? null
  if (
    feedGenre &&
    !isGenreFollowed(feedGenre) &&
    !FOLLOWED_ARTIST_RES.some((re) => re.test(normArtist(e.artistName)))
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

// 3. Genre purchase charts — day-of new releases in followed genres.
// Both feed types are reduced to collection ids and resolved through the
// shared catalog lookup, so every card carries Apple's verbatim genre —
// feed membership decides where we look, never what genre a release is.
// Album entries keep their raw feed data as a fallback: if the lookup
// fails, they still publish with the feed's own Apple genre name.
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

// 3b. Country charts — followed countries' most-played + purchase charts,
// already reduced to date-filtered collection ids. An id also on the US
// most-played chart is skipped (that source already covers it — this keeps
// global hits from riding in on every country's chart at once); the rest
// resolve through one shared US-catalog lookup. Ids Apple doesn't return
// aren't in the US catalog yet — dropped with a per-storefront count, they
// make a later fetch once they propagate.
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
      // every surfacing storefront gets source credit — first-wins would
      // arbitrarily undercount later-listed countries in the editor's audit
      sfs.add(sf)
    } else {
      countryIdSources.set(id, new Set([sf]))
      fresh++
    }
  }
  log(`${sf} ${kind}: ${ids.length} in-window → ${fresh} new ids`)
}
// One retry pass, like the sweep's: most-played 503s are transient throttle
// responses and a paced second attempt after a backoff usually lands.
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
    // sources tags are editor-audit metadata (which discovery source earns
    // its keep, shown on the prefs chips) — the app never reads them
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

// mark followed artists (before dedup so merges keep the flag)
for (const r of releases) {
  if (FOLLOWED_ARTIST_RES.some((re) => re.test(normArtist(r.artist)))) r.followed = true
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
    // a null-genre copy landing first must not cost the release its genre —
    // the filter would wrongly drop it as "genre not followed"
    if (!prev.genre && r.genre) prev.genre = r.genre
    // union, not overwrite: an album on two playlists (or a playlist and a
    // country chart) credits every source in the editor's audit counts
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
// genre drops are the bulk of playlist finds (dozens per run) — one summary
// line instead of a line per title; blocked-artist drops stay individual
// (rare, and worth seeing exactly what the block list caught)
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

// Previous file — read once, three consumers below (empty-success guard,
// per-entry release carryover, per-entry upcoming carryover).
let prevFile = {}
try {
  prevFile = JSON.parse(readFileSync(OUT, 'utf8'))
} catch {}

// Empty-success guard (v1 lesson: an empty success can be a failure in
// disguise). If we FETCHED nothing but the previous file still has in-window
// releases, keep those instead of stamping an empty file fresh. Must run
// before the per-entry carryover below: it keys on the fetched result being
// empty, and it is the only path that also preserves discovery entries.
if (out.length === 0) {
  const carried = (prevFile.releases ?? []).filter((r) => inWindow(r.release_date))
  if (carried.length) {
    log(`0 fetched but ${carried.length} previous in-window releases — carrying over`)
    out = carried
  }
}

// Upcoming (pre-orders) — followed artists only: keep entries whose artist id
// was in the sweep or whose credit string names a followed artist (joint
// "A & B" credits). Batch responses also carry collab partners' own
// pre-orders (the activity byproduct all over again) — those drop here.
// Same noise, dedup, and block rules as the main list; soonest first. An
// empty Upcoming list from a clean sweep is a normal state, not a failure —
// but entries whose artist's batch failed carry over from the previous file
// (see below): a tracked pre-order must never vanish because of a bad night.
const upcomingByKey = new Map()
for (const r of upcomingRaw) {
  if (NOISE_RE.test(r.title) || isArtistBlocked(r)) continue
  if (!sweepIds.has(r.artist_id) && !FOLLOWED_ARTIST_RES.some((re) => re.test(normArtist(r.artist)))) continue
  r.followed = true
  const prev = upcomingByKey.get(keyOf(r))
  if (!prev) {
    upcomingByKey.set(keyOf(r), r)
  } else {
    // same back-fill as the main dedup — the first-seen copy may be the
    // sparse one (a joint-credit listing without artwork/link)
    if (r.release_date < prev.release_date) prev.release_date = r.release_date
    if (!prev.artwork && r.artwork) prev.artwork = r.artwork
    if (!prev.link && r.link) prev.link = r.link
    if (!prev.genre && r.genre) prev.genre = r.genre
  }
}
// Per-entry carryover (both lists): a failed batch means that artist's data
// is simply missing this run, so their previous in-window releases and
// pre-orders carry over rather than vanish for a day. Entries whose artist
// swept SUCCESSFULLY but no longer returned the item are genuinely gone
// (canceled/pulled) and drop; a date change re-lands under the same key, so
// the fresh copy wins over the stale one. Followed artists only: carried
// discovery entries would be hidden client-side anyway (24h-of-fetch
// window), and a failed feed's day-of finds can't be resurrected. A carried
// pre-order whose date has passed since the last fetch routes to releases[]
// (the split is decided here, never client-side), completing the pre-order
// lifecycle even if release day itself fails.
if (batchFailures > 0) {
  // attribution: id match for the artist's own entries; name match for
  // joint-credit entities; entries with NO artist_id (name-matched discovery
  // finds whose feed id didn't parse) can't be verified either way — keep
  // them, matching the unknown-means-keep bias, until a clean sweep
  // re-writes them with ids
  const missingThisRun = (r) =>
    r.artist_id == null ||
    failedSweepIds.has(r.artist_id) ||
    failedArtistRes.some((re) => re.test(normArtist(r.artist)))
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
      // still future — no out check: it may legitimately share keyOf with a
      // released edition in out (deluxe pre-order), and dates always differ;
      // the card-level disjointness filter below is the backstop
      upcomingByKey.set(keyOf(r), r)
    } else {
      // date passed since the last fetch — the pre-order released while its
      // artist's batch was failing; it belongs on New now, unless a
      // discovery source already fetched it fresh
      if (outKeys.has(keyOf(r))) continue
      outKeys.add(keyOf(r))
      out.push(r)
    }
    log(`carried over (batch failed): ${r.artist} — ${r.title}`)
  }
}
// The lists must be disjoint by card (cardKeyOf): each source evaluates the
// date boundary at its own moment, so a run straddling UTC midnight could
// land the same card in both. Same keyOf with a DIFFERENT date is legitimate
// (a deluxe pre-order of an already-released album) and stays.
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
