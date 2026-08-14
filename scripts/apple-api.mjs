// Apple's rate limits and wire formats, in one place. The fetcher and the source
// audit hit the same hosts and parse the same feeds, and a second hand-rolled copy
// is how you get 503s, or an audit that grades a feed the pipeline never reads.
//
// State is module-level, so pacing does not coordinate across processes; not
// running an audit during a refresh is a convention, not a lock.

import { UA } from './shared.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MARKETING_HOST = 'rss.marketingtools.apple.com'

// Apple returns an artist-albums lookup GROUPED: one `artist` record per requested
// id, then that artist's collections. Walking in order is what attributes a
// joint-entity collab to the member who was followed; filtering to collections
// first would discard the separators that carry it. The grouping is undocumented,
// so orphans are counted rather than dropped and each caller picks its own
// reaction.
export function groupArtistLookup(results) {
  const groups = new Map()
  let via = null
  let orphans = 0
  for (const r of results ?? []) {
    if (r.wrapperType === 'artist') {
      via = r.artistId
      if (!groups.has(via)) groups.set(via, { name: r.artistName, albums: [] })
    } else if (r.wrapperType !== 'collection') continue
    else if (via == null) orphans++
    else groups.get(via).albums.push(r)
  }
  return { groups, orphans }
}

let throttleHits = 0
export const throttleCount = () => throttleHits

function checkOk(res, url) {
  if (res.ok) return
  // 503 is throttling only on marketingtools, where a burst returns them (see
  // marketingToolsJSON); elsewhere it is an ordinary outage.
  const throttled =
    res.status === 429 || res.status === 403 || (res.status === 503 && url.startsWith(`https://${MARKETING_HOST}/`))
  if (throttled) throttleHits++
  throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { throttled })
}

// timeouts surface as TimeoutError, undici network errors carry a cause code — both
// matter when diagnosing a failure from the log alone, so every source's failure path
// reports through this.
export const errDetail = (e) => {
  const tag = e.throttled ? 'throttled' : e.cause?.code || (e.name === 'TimeoutError' ? 'timeout' : null)
  return tag ? `${e.message} [${tag}]` : e.message
}

// 30s abort: stalled connections have hung batches for 17–78 min; fail fast
// and let the caller's retry pass handle it.
export async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
  checkOk(res, url)
  return res.json()
}

// iTunes Search/Lookup is unofficially rate-limited (~20/min). Every Search or
// Lookup call waits out the gap since the previous one (with jitter) rather than
// sleeping a fixed pause after, so processing time counts toward the gap and a
// loop's last call leaves no dangling sleep. The legacy RSS paths share this host
// but are not limited, so they use getJSON and their callers stagger them.
let lastItunesCall = 0
export async function itunesJSON(url) {
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
export function marketingToolsJSON(url) {
  const myTurn = chartGate.then(async () => {
    const wait = lastChartCall + 1000 + Math.random() * 300 - Date.now()
    if (wait > 0) await sleep(wait)
    lastChartCall = Date.now()
  })
  chartGate = myTurn
  return myTurn.then(() => getJSON(url))
}

// ---------- endpoints ----------

// Every URL the pipeline reads, so the audit grades the same feeds production
// fetches: a changed limit or path can't diverge between the two.
export const US_CHART_URL = `https://${MARKETING_HOST}/api/v2/us/music/most-played/50/albums.json`
export const countryMostPlayedUrl = (sf) =>
  `https://${MARKETING_HOST}/api/v2/${sf}/music/most-played/100/songs.json`
export const genreFeedUrl = (feedType, genreId) =>
  `https://itunes.apple.com/us/rss/${feedType}/genre=${genreId}/limit=100/json`
export const countryPurchaseUrl = (sf, feedType) =>
  `https://itunes.apple.com/${sf}/rss/${feedType}/limit=100/json`
export const lookupUrl = (ids) => `https://itunes.apple.com/lookup?id=${ids.join(',')}&country=us`
export const artistAlbumsUrl = (ids, limit) =>
  `https://itunes.apple.com/lookup?id=${ids.join(',')}&entity=album&country=us&limit=${limit}&sort=recent`

// ---------- feed wire formats ----------

// Normalize any storefront path to /us/ — defense in depth (sources already
// query the US catalog) and the pin that keeps a scrape on the US page.
export const usLink = (u) => (u ? u.replace(/(music|itunes)\.apple\.com\/[a-z]{2}\//, '$1.apple.com/us/') : '')
// legacy RSS serializes a single-entry feed as an OBJECT, not a one-element
// array — the near-empty kr/cn feeds hit this where the US ones never do
export const asList = (x) => (Array.isArray(x) ? x : x ? [x] : [])
// Track URLs look like .../album/<slug>/<collectionId>?i=<trackId> — feeds
// that expose only tracks yield their parent album id from the URL.
export const albumIdFromTrackUrl = (u) => u?.match(/\/album\/[^/]+\/(\d+)/)?.[1]
// Legacy RSS entry → parent album id. topalbums entries carry it directly;
// topsongs entries are tracks, so it comes out of the track URL.
export const rssAlbumId = (e, feedType) =>
  feedType === 'topalbums' ? e.id?.attributes?.['im:id'] : albumIdFromTrackUrl(e.id?.label)
// marketingtools serializes ids as strings, lookups return numbers — normalize
// to one canonical string (null when not numeric) before any set membership
// (the known type trap).
export const normId = (raw) => {
  const s = String(Number(raw))
  return s === 'NaN' ? null : s
}

// ---------- scraped web player pages ----------

// full browser UA: the web player only embeds the JSON for browsers
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'

export const scrapeHTML = async (url) => {
  const target = usLink(url)
  const res = await fetch(target, {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(30_000),
  })
  checkOk(res, target)
  return res.text()
}

// Playlists are the only day-of, all-genre surface Apple exposes without an API
// token. The web player page embeds the track list as JSON; this parses it to
// parent-album ids. Scraping is the pipeline's most fragile contract, so it lives
// here rather than in two callers that would diverge the day the layout changes.
export async function scrapePlaylistAlbumIds(url) {
  const html = await scrapeHTML(url)
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
  return { tracks, albumIds: [...albumIds] }
}
