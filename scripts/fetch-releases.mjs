#!/usr/bin/env node
// Fetch new releases and write docs/data/releases.json. Zero deps; run daily
// by scripts/update.sh via launchd. Exit 0 = clean, 2 = a source failed
// (partial data still published).
//
// Apple-only, US storefront only: other storefronts localize artist names
// (KR lists CHUU as 츄), splitting the dedup key. Foreign-only releases appear
// once they propagate to the US catalog (usually within hours).
//
// Five sources, each labelled at its own section below. Every discovery card
// records which one found it, in `sources`, for the editor's audit; sweep cards
// carry `followed` and `via_artist_id` instead.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { STOREFRONTS, purchaseFeedsOf } from './storefronts.mjs'
import { cardKeyOf, keyOf, releaseOrder, upcomingOrder } from './card-key.mjs'
import {
  US_CHART_URL, albumIdFromTrackUrl, artistAlbumsUrl, asList, countryMostPlayedUrl,
  countryPurchaseUrl, errDetail, genreFeedUrl, getJSON, groupArtistLookup, itunesJSON,
  lookupUrl, marketingToolsJSON, normId, rssAlbumId, scrapePlaylistAlbumIds, sleep, usLink,
} from './apple-api.mjs'
import { ACTIVITY_PATH, BATCH_SIZE, DATA_PATH, GENRE_ACTIVITY_PATH, GENRE_FEEDS, GENRE_MEMORY_DAYS, LOOKUP_CHUNK, PREFS_PATH, SOURCE_ACTIVITY_PATH, SOURCE_MEMORY_DAYS, WINDOW_DAYS, daysSince, feedTypesOf, notOlderThan, sourceTag, withinDays } from './shared.mjs'

const PREFS = JSON.parse(readFileSync(PREFS_PATH, 'utf8'))

// local time, matching update.sh's log() — the two interleave in one file.
const log = (...a) => console.log(`[${new Date().toLocaleString('sv-SE')}]`, ...a)

const NOISE_RE = /\b(instrumental|sped[ -]?up|slowed( \+ reverb)?|inst\.)\b/i

// UTC, matching the dates Apple serializes; the app formats in local time.
const TODAY = new Date().toISOString().slice(0, 10)

const inWindow = (releaseDate) => withinDays(releaseDate, WINDOW_DAYS)

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
const artUrl = (u) => {
  // Parsed, not regex-matched on the raw string: a `[^/]+` host class also
  // swallows # and ?, so "https://evil.example#.mzstatic.com/a.jpg" passes a
  // pattern check while the browser loads it from evil.example.
  try {
    const h = new URL(u).hostname
    if (h !== 'mzstatic.com' && !h.endsWith('.mzstatic.com')) return ''
  } catch {
    return ''
  }
  // mzstatic renders the trailing size+format segment on demand, and the WebP is
  // ~40% of the JPEG's bytes. Only .jpg is swapped: an unverified format would
  // trade a working card for the placeholder.
  const webp = u.replace(/\d+x\d+bb\.jpg$/, '400x400bb.webp')
  return webp === u ? u.replace(/\d+x\d+bb/, '400x400bb') : webp
}
// Only Apple catalog URLs reach cards — link fields are untrusted (one source
// is scraped) until they match this shape.
const appleLink = (u) =>
  u && /^https:\/\/(music|itunes)\.apple\.com\//.test(u) ? usLink(u) : undefined

// One iTunes lookup result (wrapperType "collection") → release card shape.
// EVERY lookup-backed source funnels through this so the shapes can't drift;
// the *ToRelease helpers below build from raw feed data and are only reached
// when a lookup didn't return the id. artist_id drives ID-based blocking and
// cross-run carryover matching; the app ignores it.
const fromCollection = (a) => ({
  title: displayTitle(a.collectionName),
  artist: a.artistName,
  artist_id: a.artistId,
  type: classify(a.collectionName, a.trackCount),
  release_date: a.releaseDate.slice(0, 10),
  artwork: artUrl(a.artworkUrl100),
  genre: a.primaryGenreName ?? null,
  link: appleLink(a.collectionViewUrl),
})

const GENRES_FOLLOWED = (PREFS.genres?.followed ?? []).map((s) => s.toLowerCase())

const FOLLOWED_ENTRIES = PREFS.artists?.followed ?? []
// Blocking is by Apple ID — precise ("Drake" can't catch "Drake Milligan").
const BLOCKED_IDS = new Set()
for (const e of PREFS.artists?.blocked ?? []) {
  if (e?.id) BLOCKED_IDS.add(e.id)
  else log(`blocked artist "${e?.name ?? e}" has no Apple ID — re-add via the prefs picker; not blocking`)
}

const isGenreFollowed = (g) => !!g && GENRES_FOLLOWED.includes(g.toLowerCase())
const isArtistBlocked = (r) => !!r.artist_id && BLOCKED_IDS.has(r.artist_id)

// ---------- followed artists via iTunes ----------

// Both retry passes (sweep batches, country feeds) wait this long: the
// failures they cover are intermittent connection stalls and 503 throttling.
const RETRY_BACKOFF_MS = 15_000

// Newest US release date per swept artist id — feeds the editor's dormancy
// hints. Only current-sweep ids are recorded (batch responses also carry
// collab partners' ids, which would plant stale dates); future dates skipped,
// file pruned to the followed list on write.
let artistActivity = {}
try {
  const parsed = JSON.parse(readFileSync(ACTIVITY_PATH, 'utf8'))
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) artistActivity = parsed
  else log('artist-activity.json is not an object — starting a fresh tally')
} catch (e) {
  // absent on a first run, which is normal; anything else is worth a line
  if (e.code !== 'ENOENT') log(`could not read artist-activity.json (${errDetail(e)}) — starting a fresh tally`)
}

// Sweep-found pre-orders, collected across batches → the Upcoming tab (its
// own mini-pipeline at the end).
const upcomingRaw = []

async function batchReleases(ids) {
  const data = await itunesJSON(artistAlbumsUrl(ids, 100))
  const { groups, orphans } = groupArtistLookup(data.results)
  const collections = [...groups].flatMap(([via, g]) => g.albums.map((a) => ({ ...a, via })))
  // Grouping is undocumented, so a layout change must not silently empty the
  // sweep. Exit 2 is what "loud" means; a log line alone scrolls out of the
  // editor's tail. No severity prefix: prefs-server reads those as update.sh's
  // and would report a deploy problem instead.
  if (orphans) {
    anyFailed = true
    log(`${orphans} collections arrived before any artist record — lookup grouping changed?`)
  }
  // seed the shared collection cache: a followed artist's release that also
  // charts or lands on a playlist skips a second lookup
  for (const a of collections) collectionCache.set(String(a.collectionId), a)
  const swept = new Set(ids)
  for (const a of collections) {
    const d = a.releaseDate?.slice(0, 10)
    if (!swept.has(a.artistId) || !d || d > TODAY) continue
    if (!artistActivity[a.artistId] || d > artistActivity[a.artistId]) artistActivity[a.artistId] = d
  }
  // provenance rides along for the Upcoming and carryover rules below
  const fromSweep = (a) => ({ ...fromCollection(a), followed: true, via_artist_id: a.via })
  upcomingRaw.push(
    ...collections.filter((a) => a.releaseDate && isUpcoming(a.releaseDate)).map(fromSweep)
  )
  return collections.filter((a) => a.releaseDate && inWindow(a.releaseDate)).map(fromSweep)
}

// Batched collection-id lookup, shared by chart enrichment, song-chart
// resolution, and playlist albums. Run-scoped cache serves repeats (a hot
// release charts in several sources) for free. Keys stringified — a
// number/string mismatch would silently miss.
const collectionCache = new Map()
async function lookupCollections(ids) {
  // digits only: ids come from feeds, chart JSON, and SCRAPED playlist pages
  // and get comma-joined into a lookup URL — one guard against smuggled query
  // syntax
  const wanted = [...new Set(ids.map(String))].filter((id) => /^\d+$/.test(id))
  const hits = []
  const misses = []
  for (const id of wanted) {
    const cached = collectionCache.get(id)
    if (cached) hits.push(cached)
    else misses.push(id)
  }
  for (let i = 0; i < misses.length; i += LOOKUP_CHUNK) {
    const d = await itunesJSON(lookupUrl(misses.slice(i, i + LOOKUP_CHUNK)))
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
  const data = await marketingToolsJSON(US_CHART_URL)
  return data.feed?.results ?? []
}

// Fallback card from a most-played chart entry, for the ids the shared lookup
// didn't return. No trackCount here, so classify() leans on the title alone.
const chartEntryToRelease = (e, feedGenre) => ({
  title: displayTitle(e.name),
  artist: e.artistName,
  // the feed serializes artistId as a string; BLOCKED_IDS holds numbers
  artist_id: Number(e.artistId) || undefined,
  type: classify(e.name, undefined),
  release_date: e.releaseDate.slice(0, 10),
  artwork: artUrl(e.artworkUrl100),
  genre: feedGenre,
  link: appleLink(e.url),
})

// ---------- genre charts (iTunes purchase charts — day-of discovery) ----------

// A feed's in-window raw entries. topalbums entries are collections; topsongs
// entries are TRACKS, so emitting them directly would put one card per track
// of the same single. Song entries contribute only their parent collection id
// (resolved later), so every card is exactly one Apple collection.
async function genreFeed(feedType, genreId) {
  const data = await getJSON(genreFeedUrl(feedType, genreId))
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
  const data = await marketingToolsJSON(countryMostPlayedUrl(sf))
  return (data.feed?.results ?? [])
    .filter((e) => e.releaseDate && inWindow(e.releaseDate))
    .map((e) => albumIdFromTrackUrl(e.url))
    .filter(Boolean)
}

async function countryPurchaseFeed(sf, feedType) {
  const data = await getJSON(countryPurchaseUrl(sf, feedType))
  const entries = asList(data.feed?.entry).filter(
    (e) => e['im:releaseDate']?.label && inWindow(e['im:releaseDate'].label)
  )
  return entries.map((e) => rssAlbumId(e, feedType)).filter(Boolean)
}

// ---------- editorial playlists (scraped web player pages) ----------

// The scrape itself is in apple-api.mjs (the audit reads the same pages). The page
// fetch is unthrottled and overlaps the artist sweep, and failures must be loud
// (exit 2).
const playlistAlbumIds = async (pl) => ({ pl, ...(await scrapePlaylistAlbumIds(pl.url)) })

// ---------- pipeline ----------

let anyFailed = false
// Source tags whose data is missing or degraded this run; the tally at the end
// records null for these, never 0 (see sourceWindow in shared.mjs).
const failedSources = new Set()
const CHART_SOURCE = sourceTag('chart', 'us')
const releases = []

// Discovery fetches start now and resolve behind the paced artist sweep, so
// their wall time disappears. Genre feeds and playlist pages are unthrottled;
// the US chart takes the marketingtools lane's first slot.
const chartP = fetchChart()
// chartP is consumed after the sweep — without this handler, a chart failure
// mid-sweep is an unhandled rejection that kills the run before anything is
// written. (The other starters are allSettled and can't reject.)
chartP.catch(() => {})
// Genre feeds and country purchase feeds share the itunes host, so they draw from
// one running slot counter. A per-list formula (gi * 2 + fi) would collide or gap,
// because an entry does not always contribute exactly two requests.
let itunesSlot = 0
const nextStagger = () => itunesSlot++ * 250

const genreFeedsP = Promise.allSettled(
  GENRE_FEEDS.flatMap((f) =>
    feedTypesOf(f).map((feedType) =>
      sleep(nextStagger())
        .then(() => genreFeed(feedType, f.genreId))
        .then(
          (entries) => ({ tag: f.tag, feedType, entries }),
          (e) => {
            // tag rides along on the throw so failedSources can name this source
            throw Object.assign(new Error(`${f.tag} ${feedType}: ${errDetail(e)}`), { tag: f.tag })
          }
        )
    )
  )
)
const playlistPagesP = Promise.allSettled(
  (PREFS.discovery?.playlists ?? []).map((pl) =>
    playlistAlbumIds(pl).catch((e) => {
      throw Object.assign(new Error(`${pl.name}: ${errDetail(e)}`), { playlist: pl.name })
    })
  )
)
// Tasks (not bare promises) so failures can be retried by re-calling run().
// most-played takes the marketingtools lane; legacy feeds continue the genre
// feeds' stagger. All overlap the sweep.
const COUNTRY_TASKS = COUNTRY_CODES.flatMap((sf) => [
  { sf, kind: 'most-played', stagger: 0, run: () => countryMostPlayed(sf) },
  // empty where Apple runs no purchase store, so not fetched every night for nothing
  ...purchaseFeedsOf(sf).map((feedType) => ({
    sf,
    kind: feedType,
    stagger: nextStagger(),
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
// One retry pass. Runs before the artistActivity write so rescued batches'
// updates are included.
if (failedBatches.length) {
  log(`retrying ${failedBatches.length} failed batches in ${RETRY_BACKOFF_MS / 1000}s`)
  await sleep(RETRY_BACKOFF_MS)
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
// Which artists' data is missing this run, for the Upcoming carryover —
// matched by swept id (the follow list is id-only).
const failedSweepIds = new Set(failedBatches.flatMap(({ batch }) => batch.map((a) => a.id)))
// prune to the followed list: unfollowed artists' entries are frozen (never
// re-swept) and would resurface stale if re-followed. Future dates dropped too
// — the only-newer update rule means a real date could never displace one.
const sweepIds = new Set(sweepArtists.map((a) => a.id))
artistActivity = Object.fromEntries(
  Object.entries(artistActivity).filter(([id, d]) => sweepIds.has(Number(id)) && d <= TODAY)
)
writeFileSync(ACTIVITY_PATH, JSON.stringify(artistActivity, null, 2) + '\n')
log(`${followedCount} releases (pre-dedup) via ${sweepArtists.length} followed artists in ${batches.length} batches`)
// a failed batch is up to BATCH_SIZE artists silently skipped — flag the run (exit 2)
if (failedBatches.length > 0) anyFailed = true

// 2. Chart — in-window entries from the US most-played chart as discovery
let chart = []
try {
  chart = await chartP
} catch (e) {
  anyFailed = true
  failedSources.add(CHART_SOURCE)
  log(`US chart fetch failed: ${errDetail(e)}`)
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

// lookupCollections dedups and digit-filters its own input
if (candidates.length) {
  try {
    // hits land in collectionCache; cards read them from there below
    await lookupCollections(candidates.map((x) => x.e.id))
  } catch (e) {
    // degraded publish (feed-only genre/type) still counts as a failed source
    anyFailed = true
    failedSources.add(CHART_SOURCE)
    log(`chart enrichment lookup failed — falling back to feed data: ${errDetail(e)}`)
  }
}

// Lookup-backed like every other source: the catalog record wins, and the
// window is re-checked against ITS date so a card can't show a date outside
// the window. Feed and catalog agree on title/artist/date/artwork in practice
// (0 differences across a 50-entry chart, 2026-07-29); the feed's own genre is
// still the fallback when the catalog has none.
for (const { e, feedGenre } of candidates) {
  const hit = collectionCache.get(String(e.id))
  if (hit) {
    if (!hit.releaseDate || !inWindow(hit.releaseDate)) continue
    const r = fromCollection(hit)
    if (!r.genre) r.genre = feedGenre
    if (!r.link) r.link = appleLink(e.url)
    r.sources = [CHART_SOURCE]
    releases.push(r)
  } else {
    releases.push({ ...chartEntryToRelease(e, feedGenre), sources: [CHART_SOURCE] })
  }
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
    if (settled.reason.tag) failedSources.add(sourceTag('genre', settled.reason.tag))
    log(`genre feed failed: ${settled.reason.message}`)
    continue
  }
  const { tag, feedType, entries } = settled.value
  if (!entries.length) continue
  let ids = 0
  for (const e of entries) {
    const id = rssAlbumId(e, feedType)
    if (!id || !/^\d+$/.test(id)) continue
    ids++
    // first feed to claim an id names it; the lookup usually overrides anyway
    if (!genreFeedIds.has(id)) genreFeedIds.set(id, tag)
    // album entries double as the fallback card if the lookup misses the id
    if (feedType === 'topalbums' && !feedAlbumFallback.has(id)) feedAlbumFallback.set(id, e)
  }
  log(`${tag} ${feedType}: ${entries.length} in-window → ${ids} album ids`)
}
// Tagged by the feed that surfaced the id, not by the card's catalog genre —
// the chip answers "did this feed earn its slot", which the genre chips can't.
// Guarded like the country block below: lookupCollections deliberately keeps
// collections Apple returns under a REPLACEMENT id, which no feed claimed, and
// an unguarded get() would tag those "genre:undefined".
const genreSource = (id) => {
  const tag = genreFeedIds.get(id)
  return tag ? [sourceTag('genre', tag)] : undefined
}
if (genreFeedIds.size) {
  try {
    const hits = await lookupCollections([...genreFeedIds.keys()])
    const returned = new Set(hits.map((a) => String(a.collectionId)))
    const fresh = hits
      .filter((a) => a.releaseDate && inWindow(a.releaseDate))
      .map((a) => ({ ...fromCollection(a), sources: genreSource(String(a.collectionId)) }))
    for (const [id, e] of feedAlbumFallback) {
      if (!returned.has(id)) fresh.push({ ...albumEntryToRelease(e, genreFeedIds.get(id)), sources: genreSource(id) })
    }
    log(`genre charts: ${fresh.length} releases via ${genreFeedIds.size} ids`)
    releases.push(...fresh)
  } catch (e) {
    anyFailed = true
    for (const f of GENRE_FEEDS) failedSources.add(sourceTag('genre', f.tag))
    log(`genre chart lookup failed — album entries fall back to feed data: ${errDetail(e)}`)
    releases.push(
      ...[...feedAlbumFallback.entries()].map(([id, e]) => ({
        ...albumEntryToRelease(e, genreFeedIds.get(id)),
        sources: genreSource(id),
      }))
    )
  }
}

// 3b. Country charts — date-filtered collection ids from the country feeds.
// Ids already on the US most-played chart are skipped (covered there; keeps
// global hits off every country's chart); the rest resolve through one shared
// US lookup. Ids Apple doesn't return aren't in the US catalog yet — dropped
// with a per-storefront count, they make a later fetch once they propagate.
const usChartIds = new Set(chart.map((e) => normId(e.id)).filter(Boolean))
const countryIdSources = new Map() // collection id → Set of storefronts that surfaced it
let usChartSubtracted = 0
const ingestCountryFeed = ({ sf, kind }, ids) => {
  if (!ids.length) return
  let fresh = 0
  for (const raw of ids) {
    const id = normId(raw)
    if (!id) continue
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
// One retry pass, like the sweep's.
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
  log(`retrying ${failedCountryFeeds.length} failed country feeds in ${RETRY_BACKOFF_MS / 1000}s`)
  await sleep(RETRY_BACKOFF_MS)
  const retried = await Promise.allSettled(
    failedCountryFeeds.map((t, i) => sleep(i * 250).then(t.run))
  )
  retried.forEach((settled, i) => {
    const t = failedCountryFeeds[i]
    if (settled.status === 'rejected') {
      anyFailed = true
      failedSources.add(sourceTag('country', t.sf))
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
        if (sfs) r.sources = [...sfs].map((sf) => sourceTag('country', sf))
        return r
      })
    log(`country charts: ${found.length} releases via ${countryIdSources.size} ids`)
    releases.push(...found)
  } catch (e) {
    anyFailed = true
    for (const sf of COUNTRY_CODES) failedSources.add(sourceTag('country', sf))
    log(`country chart lookup failed: ${errDetail(e)}`)
  }
}

// 4. Editorial playlists — curated day-of releases across all genres.
// One batched warm-up lookup covers every playlist's albums, so the
// per-playlist calls below resolve from cache while keeping their source tags
// and failure reporting. A warm-up failure is deferred, not swallowed: the
// per-playlist lookups retry the misses and mark anyFailed themselves — safe
// only while the warm-up set stays exactly the union of the per-playlist
// lists below.
const playlistPages = await playlistPagesP
const allPlaylistAlbumIds = playlistPages
  .filter((s) => s.status === 'fulfilled')
  .flatMap((s) => s.value.albumIds)
if (allPlaylistAlbumIds.length) {
  try {
    await lookupCollections(allPlaylistAlbumIds)
  } catch {}
}
for (const settled of playlistPages) {
  if (settled.status === 'rejected') {
    anyFailed = true
    if (settled.reason.playlist) failedSources.add(sourceTag('playlist', settled.reason.playlist))
    log(`playlist scrape failed: ${settled.reason.message}`)
    continue
  }
  const { pl, tracks, albumIds } = settled.value
  log(`${pl.name}: ${tracks} tracks → ${albumIds.length} unique albums`)
  try {
    const fresh = (await lookupCollections(albumIds))
      .filter((a) => a.releaseDate && inWindow(a.releaseDate))
      .map((a) => ({ ...fromCollection(a), sources: [sourceTag('playlist', pl.name)] }))
    log(`${pl.name}: ${fresh.length} in-window releases`)
    releases.push(...fresh)
  } catch (e) {
    anyFailed = true
    failedSources.add(sourceTag('playlist', pl.name))
    log(`${pl.name} lookup failed: ${errDetail(e)}`)
  }
}

// mark followed artists BEFORE dedup, so merges keep the flag — ★ + filter
// bypass for a followed artist's own releases. Sweep cards arrive already
// flagged (see batchReleases); this catches the same release reaching us
// through a chart or playlist instead.
for (const r of releases) {
  if (r.artist_id && sweepIds.has(r.artist_id)) r.followed = true
}

// Back-fill a duplicate's fields into the copy already kept. First-seen may be
// the sparse one (a joint-credit listing without artwork/link), so every field
// a later copy fills in has to survive the collapse.
function mergeInto(prev, r) {
  if (r.release_date < prev.release_date) prev.release_date = r.release_date
  if (!prev.artwork && r.artwork) prev.artwork = r.artwork
  if (!prev.link && r.link) prev.link = r.link
  // carryover matches on artist_id, so a sparse copy must not cost the entry its id
  if (!prev.artist_id && r.artist_id) prev.artist_id = r.artist_id
  // same for provenance: the chart copy of a release has none, the sweep copy does
  if (!prev.via_artist_id && r.via_artist_id) prev.via_artist_id = r.via_artist_id
  // a null-genre copy landing first mustn't cost the release its genre (the
  // filter would drop it as "genre not followed")
  if (!prev.genre && r.genre) prev.genre = r.genre
  // union so an album on two sources credits both in the editor's audit
  if (r.sources?.length) prev.sources = [...new Set([...(prev.sources ?? []), ...r.sources])]
  prev.followed = prev.followed || r.followed
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
  if (prev) mergeInto(prev, r)
  else byKey.set(k, r)
}
let out = [...byKey.values()]

// precedence per CLAUDE.md; the chain below is the whole rule
const before = out.length
// genre drops are the bulk (dozens per run) — one summary line; blocked-artist
// drops stay individual (rare, worth seeing what the block list caught)
const genreDrops = new Map()
out = out.filter((r) => {
  if (isArtistBlocked(r)) return logDrop(r, 'artist blocked')
  if (r.followed) return true
  if (isGenreFollowed(r.genre)) return true
  const g = r.genre ?? 'none'
  const d = genreDrops.get(g) ?? { n: 0, example: `${r.artist} — ${r.title}` }
  d.n++
  genreDrops.set(g, d)
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
        ? ` — unfollowed genres: ${[...genreDrops.entries()].sort((a, b) => b[1].n - a[1].n).map(([g, d]) => `${g} ${d.n}`).join(', ')}`
        : '')
  )

// Previous file — read once, three consumers below (empty-success guard +
// the two per-entry carryovers).
let prevFile = {}
try {
  prevFile = JSON.parse(readFileSync(DATA_PATH, 'utf8'))
} catch (e) {
  // absent is normal on a first run; unreadable silently disables both the
  // empty-success guard and the carryover, so it must not pass unremarked
  if (e.code !== 'ENOENT') {
    anyFailed = true
    log(`could not read releases.json (${errDetail(e)}) — carryover and the empty-success guard are unavailable this run`)
  }
}

// Empty-success guard (an empty success can be a failure in disguise): if we
// fetched nothing but the previous file has in-window releases, keep those
// rather than stamp an empty file. Must run before the per-entry carryover
// (it keys on the result being empty) and is the only path that also
// preserves discovery entries.
// carried releases keep the PREVIOUS run's source tags, so counting them would
// credit sources for work they did not do tonight
let carriedWholesale = false
if (out.length === 0) {
  const carried = (prevFile.releases ?? []).filter((r) => inWindow(r.release_date))
  if (carried.length) {
    log(`0 fetched but ${carried.length} previous in-window releases — carrying over`)
    out = carried
    carriedWholesale = true
  }
}

// Upcoming (pre-orders) — followed artists only, enforced against the id whose
// discography returned the pre-order, so a collab under a joint entity id
// qualifies. Same noise/dedup/block rules as the main list, soonest first. An
// empty list from a clean sweep is normal; entries whose batch failed carry
// over below so a tracked pre-order never vanishes on a bad night.
const upcomingByKey = new Map()
for (const r of upcomingRaw) {
  if (NOISE_RE.test(r.title) || isArtistBlocked(r)) continue
  if (!sweepIds.has(r.via_artist_id)) continue
  const k = keyOf(r)
  const prev = upcomingByKey.get(k)
  if (prev) mergeInto(prev, r)
  else upcomingByKey.set(k, r)
}
// Per-entry carryover (both lists): a failed batch means that artist's data is
// missing this run, so their previous in-window releases and pre-orders carry
// over rather than vanish. Entries whose artist swept SUCCESSFULLY but no
// longer returned drop (canceled/pulled); a date change re-lands under the
// same key so the fresh copy wins. Followed artists only.
if (failedBatches.length > 0) {
  // Attribution by the id whose sweep produced the entry — via_artist_id for a
  // collab, the credited id otherwise. An entry with no id can't be verified:
  // unknown-means-keep, until a clean sweep rewrites it.
  const missingThisRun = (r) => {
    const id = r.via_artist_id ?? r.artist_id
    return id == null || failedSweepIds.has(id)
  }
  // block list / noise rules may have changed since the entry was written
  const stillEligible = (r) => !NOISE_RE.test(r.title) && !isArtistBlocked(r)
  const outKeys = new Set(out.map(keyOf))
  for (const r of prevFile.releases ?? []) {
    const k = keyOf(r)
    if (!r.followed || !inWindow(r.release_date) || outKeys.has(k)) continue
    if (!missingThisRun(r) || !stillEligible(r)) continue
    outKeys.add(k)
    out.push(r)
    log(`carried over (batch failed): ${r.artist} — ${r.title}`)
  }
  // outKeys now includes carried releases, keeping the two lists disjoint
  for (const r of prevFile.upcoming ?? []) {
    const k = keyOf(r)
    if (!notOlderThan(r.release_date, WINDOW_DAYS)) continue
    if (upcomingByKey.has(k)) continue
    if (!missingThisRun(r) || !stillEligible(r)) continue
    r.followed = true
    if (isUpcoming(r.release_date)) {
      // still future — no out check: it may share keyOf with a released
      // edition (deluxe pre-order) but dates differ; the card-level
      // disjointness filter below is the backstop
      upcomingByKey.set(k, r)
    } else {
      // date passed while the artist's batch was failing — belongs on New
      // now, unless a discovery source already fetched it fresh
      if (outKeys.has(k)) continue
      outKeys.add(k)
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

mkdirSync(new URL('.', DATA_PATH), { recursive: true })
writeFileSync(DATA_PATH, JSON.stringify({ fetched_at: Date.now(), releases: out, upcoming }, null, 2))
log(`wrote ${out.length} releases + ${upcoming.length} upcoming`)

// Rolling tally of what the genre filter cost, for `npm run check-genres`.
//
// This block and the source tally below run LAST and never fatally: both are
// advisory side files, so a problem writing one must not cost the run its
// published data.
try {
  let tally = {}
  try {
    const parsed = JSON.parse(readFileSync(GENRE_ACTIVITY_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) tally = parsed
  } catch {} // absent on a first run; a corrupt one just restarts the tally
  for (const [g, d] of genreDrops) {
    if (g === 'none') continue // no genre at all isn't a follow candidate
    // Counts restart once a genre goes quiet for a day, so the number reads as
    // the current streak rather than a lifetime total that can only ever grow.
    // `today` is carried so a second run the same day (Save & Refresh) replaces
    // today's contribution instead of doubling it.
    const prev = tally[g]
    const recent = prev && daysSince(prev.last_seen) <= 1.5
    const before = !recent ? 0 : prev.last_seen === TODAY ? prev.dropped - (prev.today ?? prev.dropped) : prev.dropped
    tally[g] = { dropped: before + d.n, today: d.n, last_seen: TODAY, example: d.example }
  }
  tally = Object.fromEntries(
    Object.entries(tally)
      .filter(([g, d]) => !isGenreFollowed(g) && daysSince(d.last_seen) <= GENRE_MEMORY_DAYS)
      .sort((a, b) => b[1].dropped - a[1].dropped)
  )
  writeFileSync(GENRE_ACTIVITY_PATH, JSON.stringify(tally, null, 2) + '\n')
} catch (e) {
  log(`could not update genre-activity.json: ${errDetail(e)}`)
}

// Rolling per-source yield, read by `npm run audit-sources` and the editor's chips.
// Columnar (one shared date array, parallel per-source arrays) because update.sh
// commits config/ every night: a date-keyed map would repeat the date once per
// source per day, and this file is meant to stay small enough to push daily.
try {
  let hist = { days: [], sources: {} }
  try {
    const parsed = JSON.parse(readFileSync(SOURCE_ACTIVITY_PATH, 'utf8'))
    if (Array.isArray(parsed?.days) && parsed.sources && typeof parsed.sources === 'object') hist = parsed
  } catch {} // absent on a first run; a corrupt one restarts the history

  // a second run the same day (Save & Refresh) replaces today rather than appending
  if (hist.days.at(-1) === TODAY) {
    hist.days.pop()
    for (const col of Object.values(hist.sources)) col.pop()
  }

  // followed artists bypass every filter, so their releases say nothing about
  // whether a source earns its keep — same rule the editor's chips already use
  const tally = new Map()
  for (const r of out) {
    if (r.followed) continue
    for (const tag of r.sources ?? []) {
      const t = tally.get(tag) ?? [0, 0]
      t[0]++
      if (r.sources.length === 1) t[1]++
      tally.set(tag, t)
    }
  }

  const configured = new Set([
    CHART_SOURCE,
    ...GENRE_FEEDS.map((f) => sourceTag('genre', f.tag)),
    ...COUNTRY_CODES.map((sf) => sourceTag('country', sf)),
    ...(PREFS.discovery?.playlists ?? []).map((pl) => sourceTag('playlist', pl.name)),
  ])
  hist.days.push(TODAY)
  const len = hist.days.length
  for (const tag of new Set([...configured, ...Object.keys(hist.sources)])) {
    const col = (hist.sources[tag] ??= [])
    while (col.length < len - 1) col.push(null) // a source added later starts blank
    const unmeasured = !configured.has(tag) || carriedWholesale || failedSources.has(tag)
    col.push(unmeasured ? null : (tally.get(tag) ?? [0, 0]))
  }

  const drop = len - SOURCE_MEMORY_DAYS
  if (drop > 0) {
    hist.days = hist.days.slice(drop)
    for (const k of Object.keys(hist.sources)) hist.sources[k] = hist.sources[k].slice(drop)
  }
  // A source dropped from the config keeps its history until it ages out entirely,
  // then goes. A CONFIGURED source always keeps its column even when every day is
  // null: "configured but never once measured" is exactly the signal the audit
  // needs, and deleting it would hide a feed that has been failing since day one.
  for (const [k, col] of Object.entries(hist.sources)) {
    if (!configured.has(k) && col.every((d) => d == null)) delete hist.sources[k]
  }

  // one line per source: this file changes every night in a tracked directory, and
  // a single-line blob would make every commit an unreadable whole-file diff
  const rows = Object.keys(hist.sources)
    .sort()
    .map((k) => ` ${JSON.stringify(k)}: ${JSON.stringify(hist.sources[k])}`)
    .join(',\n')
  writeFileSync(SOURCE_ACTIVITY_PATH, `{\n"days": ${JSON.stringify(hist.days)},\n"sources": {\n${rows}\n}\n}\n`)
} catch (e) {
  log(`could not update source-activity.json: ${errDetail(e)}`)
}

process.exit(anyFailed ? 2 : 0)
