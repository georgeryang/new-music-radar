#!/usr/bin/env node
// Fetch new releases across genres and write docs/data/releases.json.
// Zero deps — just node's fetch. Run daily by scripts/update.sh via launchd.
//
// One unified feed, genre-tagged. Source priority (same-day first):
//   PRIMARY 1: preferred-artist discography checks (config/preferences.json)
//   PRIMARY 2: kpop label-channel MV uploads → SONG entries (in kpop the MV is
//              the release announcement; cards are songs, never videos)
//   BACKUP:    Deezer editorials (config: Pop/Asian/African/R&B/Dance/Latin…),
//              which lag releases by 1-2 days. Their failure never blocks
//              publishing the primary layers.
// Enrichment: iTunes Search (Apple Music link + genre tag), Apple KR+US
// most-played charts (badge). Canonical-key dedup collapses cross-source
// duplicates; the key includes type, so a song titled like its album keeps both.
//
// Filter precedence per release:
//   artist blocked → drop | artist preferred → keep | genre blocked → drop |
//   genre preferred → keep | neutral → keep if charting or genre is known.
//
// Exit codes: 0 = clean run, 2 = some source failed (partial data published).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// Display target is ~36h, but Deezer's editorial lags 1-2 days — the file
// holds a wider window and the frontend trims.
const WINDOW_DAYS = 3
const UA = 'new-music-radar/1.0'
const OUT = new URL('../docs/data/releases.json', import.meta.url)

const PREFS = JSON.parse(readFileSync(new URL('../config/preferences.json', import.meta.url), 'utf8'))

// Feed IDs verified 2026-07-02. 1theK is Kakao's aggregator and covers most
// mid-size labels. Add channels freely — an unreachable feed logs and is skipped.
const KPOP_CHANNELS = {
  SMTOWN: 'UCEf_Bc-KVd7onSeifS3py9g',
  'HYBE LABELS': 'UC3IZKseVpdzPSBaWxBxundA',
  'JYP Entertainment': 'UCaO6TYtlC8U5ttz62hTrZgg',
  '1theK': 'UCweOkPb1wVVH0Q0Tlj4a5Pw',
  BLACKPINK: 'UCOmHUn--16B90oW2L6FRR3A',
}

const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Sequential requests with jitter — burst patterns are what got v1 throttled.
const pause = () => sleep(800 + Math.random() * 1900)

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.text()
}

// ---------- normalization / canonical key ----------

const EDITION_RE =
  /\s*[-–(\[]\s*(the\s+\d+\w*\s+(mini\s+)?album|ep|single|deluxe( edition| version)?|standard( edition)?|explicit|extended|remaster(ed)?( \d{4})?)\s*[)\]]?\s*$/i
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

const TYPE_MAP = { album: 'album', ep: 'ep', single: 'song' }

function inWindow(releaseDate) {
  const days = (Date.now() - Date.parse(releaseDate)) / 86400e3
  // lower bound: artist discographies include pre-orders (future dates) —
  // released-only scope. -1 day of slack tolerates storefront timezone skew.
  return days <= WINDOW_DAYS + 0.5 && days >= -1
}

// ---------- genre canonicalization ----------

// iTunes primaryGenreName → the canonical tag shown on cards and matched by
// config genres.preferred / genres.blocked. First hit wins; unmapped names
// pass through as-is so new iTunes genres are still visible/blockable.
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
const ARTISTS_BLOCKED = lower(PREFS.artists?.blocked).map(normArtist)
const PREFERRED_ARTIST_RES = (PREFS.artists?.preferred ?? []).map(
  // whole-word match so "IVE" can't match inside "RIIZE"
  (n) => new RegExp(`\\b${normArtist(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
)

const isGenrePreferred = (g) => !!g && GENRES_PREFERRED.includes(g.toLowerCase())
const isGenreBlocked = (g) => !!g && GENRES_BLOCKED.includes(g.toLowerCase())
const isArtistBlocked = (a) => ARTISTS_BLOCKED.some((b) => b && normArtist(a).includes(b))

// ---------- Deezer ----------

async function fetchEditorial(genreId) {
  const out = []
  let url = `https://api.deezer.com/editorial/${genreId}/releases?limit=50`
  while (url) {
    const page = await getJSON(url)
    out.push(...(page.data ?? []))
    url = page.next ?? null
    await pause()
  }
  return out
}

async function albumDetail(id) {
  const d = await getJSON(`https://api.deezer.com/album/${id}`)
  return {
    title: d.title,
    artist: d.artist?.name ?? '?',
    type: TYPE_MAP[d.record_type] ?? 'album',
    release_date: d.release_date,
    artwork: d.cover_medium ?? '',
  }
}

// Direct discography check for a preferred artist — the never-miss path.
async function preferredArtistReleases(name) {
  const search = await getJSON(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`)
  const want = normArtist(name)
  // Generic names ("Nina", "Effie") exact-match multiple Deezer artists —
  // take the most-followed one, and skip no-audience matches entirely.
  const artist = (search.data ?? [])
    .filter((a) => normArtist(a.name) === want)
    .sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0]
  if (!artist || (artist.nb_fan ?? 0) < 100) return []
  await pause()
  const albums = await getJSON(`https://api.deezer.com/artist/${artist.id}/albums?limit=30`)
  return (albums.data ?? [])
    .filter((a) => a.release_date && inWindow(a.release_date))
    .map((a) => ({
      title: a.title,
      artist: artist.name,
      type: TYPE_MAP[a.record_type] ?? 'album',
      release_date: a.release_date,
      artwork: a.cover_medium ?? '',
    }))
}

// ---------- iTunes Search (Apple link + genre) ----------

const contains = (a, b) => a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a))

async function itunesLookupOnce(release, country) {
  const term = encodeURIComponent(`${release.artist} ${normTitle(release.title)}`)
  const entity = release.type === 'song' ? 'album,song' : 'album'
  const data = await getJSON(
    `https://itunes.apple.com/search?term=${term}&entity=${entity}&country=${country}&limit=8`
  )
  const wantArtist = normArtist(release.artist)
  const wantTitle = normTitle(release.title)
  for (const r of data.results ?? []) {
    const name = normTitle(r.collectionName ?? r.trackName ?? '')
    if (contains(normArtist(r.artistName ?? ''), wantArtist) && contains(name, wantTitle)) {
      return { apple_url: r.collectionViewUrl ?? r.trackViewUrl ?? null, genre: r.primaryGenreName ?? null }
    }
  }
  // Hangul fallback (KR storefront indexes Korean artists under Hangul names,
  // so the romanized artist match fails): accept an exact title match when
  // iTunes confirms the genre is Korean.
  if (country === 'kr' && wantTitle.length >= 3) {
    for (const r of data.results ?? []) {
      const name = normTitle(r.collectionName ?? r.trackName ?? '')
      if (name === wantTitle && /k-?pop|korean/i.test(r.primaryGenreName ?? '')) {
        return { apple_url: r.collectionViewUrl ?? r.trackViewUrl ?? null, genre: r.primaryGenreName }
      }
    }
  }
  return null
}

// Try the release's home storefront first, then the other one.
async function itunesLookup(release) {
  const home = release._kr ? 'kr' : 'us'
  const hit = await itunesLookupOnce(release, home)
  if (hit) return hit
  await pause()
  return (await itunesLookupOnce(release, home === 'kr' ? 'us' : 'kr')) ?? { apple_url: null, genre: null }
}

// ---------- Apple most-played charts (badge) ----------

async function fetchAppleChart(storefront) {
  const data = await getJSON(
    `https://rss.marketingtools.apple.com/api/v2/${storefront}/music/most-played/50/albums.json`
  )
  return (data.feed?.results ?? []).map((e, i) => ({
    rank: i + 1,
    artist: normArtist(e.artistName),
    title: normTitle(e.name),
  }))
}

function chartHit(release, chart) {
  const a = normArtist(release.artist)
  const t = normTitle(release.title)
  return chart.find(
    (c) => c.artist === a && (c.title === t || c.title.startsWith(t) || t.startsWith(c.title))
  )
}

// ---------- YouTube label channels (MV-derived songs + link fallback) ----------

async function fetchChannelVideos(channelId) {
  const xml = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const title = ((m[1].match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '')
      .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    const id = (m[1].match(/<yt:videoId>(.*?)<\/yt:videoId>/) ?? [])[1] ?? ''
    const published = (m[1].match(/<published>(.*?)<\/published>/) ?? [])[1] ?? ''
    const thumb = (m[1].match(/<media:thumbnail url="([^"]+)"/) ?? [])[1] ?? ''
    return { title, url: `https://www.youtube.com/watch?v=${id}`, published, thumb }
  })
}

const MV_RE = /\b(MV|M\/V|Official (Music )?Video)\b/i
const NOT_A_RELEASE_RE = /teaser|trailer|performance|practice|behind|live clip|lyric|visualizer|sped up|special (video|clip)|dance|recap|cam\b/i

// "RYEOWOOK 려욱 'Runaway' MV" / "Stray Kids "Chk Chk Boom" M/V" / "[MV] MAMAMOO(마마무) _ HIP"
function parseMvTitle(raw) {
  const t = raw.normalize('NFKC').replace(/^\[MV\]\s*/i, '')
  const quoted = t.match(/['‘"“]([^'’"”]{1,60})['’"”]/)
  if (quoted) {
    const artist = t
      .slice(0, quoted.index)
      .replace(/[([][^)\]]*[)\]]/g, '') // parenthesized Hangul names
      .replace(/[ᄀ-ᇿ㄰-㆏가-힯]+/g, '') // bare Hangul
      .replace(/\s+/g, ' ')
      .trim()
    if (artist) return { artist, title: quoted[1].trim() }
  }
  const underscore = t.match(/^(.*?)\s+_\s+(.{1,60}?)(\s*\(.*\))?$/) // 1theK style
  if (underscore) {
    const artist = underscore[1].replace(/[([][^)\]]*[)\]]/g, '').trim()
    if (artist) return { artist, title: underscore[2].trim() }
  }
  return null
}

function mvDerivedSongs(videos) {
  const out = []
  for (const v of videos) {
    if (!MV_RE.test(v.title) || NOT_A_RELEASE_RE.test(v.title)) continue
    if (!v.published || !inWindow(v.published)) continue
    const parsed = parseMvTitle(v.title)
    if (!parsed) {
      log(`mv parse failed, skipping: "${v.title}"`)
      continue
    }
    out.push({
      title: parsed.title,
      artist: parsed.artist,
      type: 'song',
      release_date: v.published.slice(0, 10),
      artwork: v.thumb,
      link: { service: 'youtube', url: v.url }, // upgraded to Apple Music if iTunes matches
      _src: 'mv',
      _kr: true,
    })
  }
  return out
}

function matchVideo(release, videos) {
  const t = normTitle(release.title)
  if (t.length < 3) return null
  const candidates = videos.filter((v) => normTitle(v.title).includes(t))
  if (release.type === 'song') {
    const mv = candidates.find((v) => MV_RE.test(v.title))
    if (mv) return mv.url
  }
  const a = normArtist(release.artist)
  const byArtist = candidates.find((v) => normTitle(v.title).includes(a))
  return (byArtist ?? (t.length > 6 ? candidates[0] : null))?.url ?? null
}

// ---------- pipeline ----------

let anyFailed = false
const releases = []

// PRIMARY 1: preferred-artist discographies — runs first so a later source
// failure can never cost us these.
let preferredCount = 0
for (const name of PREFS.artists?.preferred ?? []) {
  try {
    const found = await preferredArtistReleases(name)
    preferredCount += found.length
    releases.push(...found)
  } catch (e) {
    log(`preferred lookup failed for "${name}": ${e.message}`)
  }
  await pause()
}
log(`${preferredCount} releases via preferred artists`)

// PRIMARY 2: kpop label-channel MV uploads (same-day)
let videos = []
for (const [name, id] of Object.entries(KPOP_CHANNELS)) {
  try {
    videos.push(...(await fetchChannelVideos(id)))
  } catch (e) {
    anyFailed = true
    log(`channel feed ${name} failed (MV-derived entries reduced): ${e.message}`)
  }
  await pause()
}
const derived = mvDerivedSongs(videos)
log(`${derived.length} MV-derived songs`)
releases.push(...derived)

// BACKUP: Deezer editorials fill in the rest. Each is independently fallible.
for (const [name, genreId] of Object.entries(PREFS.editorials ?? {})) {
  try {
    const listing = await fetchEditorial(genreId)
    const fresh = listing.filter((r) => r.release_date && inWindow(r.release_date))
    log(`editorial ${name}: ${listing.length} releases, ${fresh.length} in window`)
    for (const item of fresh) {
      try {
        const r = await albumDetail(item.id)
        if (!r.release_date || !inWindow(r.release_date)) continue
        if (NOISE_RE.test(r.title)) {
          log(`dropped noise "${r.artist} — ${r.title}"`)
        } else {
          r._src = `editorial:${name}`
          if (name === 'Asian') r._kr = true
          releases.push(r)
        }
      } catch (e) {
        log(`album detail failed for ${item.id}: ${e.message}`)
      }
      await pause()
    }
  } catch (e) {
    anyFailed = true
    log(`editorial ${name} failed (continuing with other sources): ${e.message}`)
  }
}

// mark preferred artists everywhere (before dedup so merges keep the flag)
for (const r of releases) {
  if (PREFERRED_ARTIST_RES.some((re) => re.test(normArtist(r.artist)))) r.preferred = true
}

// canonical-key dedup — BEFORE the per-release iTunes loop (each collision
// collapsed here saves 1-2 network calls). Type is part of the key, so a
// song titled like its album keeps both entries.
const byKey = new Map()
for (const r of releases) {
  const k = keyOf(r)
  const prev = byKey.get(k)
  if (prev) {
    log(`deduped "${r.title}" (${r._src ?? 'preferred'}) into existing entry`)
    if (r.release_date < prev.release_date) prev.release_date = r.release_date
    if (!prev.artwork && r.artwork) prev.artwork = r.artwork
    if (!prev.link && r.link) prev.link = r.link
    prev._kr = prev._kr || r._kr
  } else {
    byKey.set(k, r)
  }
}
let out = [...byKey.values()]
log(`${out.length} releases after dedup`)

// enrichment: Apple Music link + genre tag
for (const r of out) {
  try {
    const { apple_url, genre } = await itunesLookup(r)
    if (apple_url) r.link = { service: 'apple', url: apple_url }
    r.genre = canonGenre(genre)
  } catch (e) {
    log(`itunes lookup failed for "${r.title}": ${e.message}`)
    r.genre = null
  }
  // fallback tags when iTunes has no match
  if (!r.genre) {
    if (r._src === 'mv') r.genre = 'K-pop'
    else if (r._src === 'editorial:Asian') r.genre = 'Asian'
    else r.genre = null
  }
  await pause()
}

// charting badge (one KR + one US fetch total)
try {
  const charts = [
    { storefront: 'KR', list: await fetchAppleChart('kr') },
    { storefront: 'US', list: await fetchAppleChart('us') },
  ]
  for (const r of out) {
    let best = null
    for (const c of charts) {
      const hit = chartHit(r, c.list)
      if (hit && (!best || hit.rank < best.rank)) best = { storefront: c.storefront, rank: hit.rank }
    }
    if (best) r.charting = best
  }
} catch (e) {
  anyFailed = true
  log(`chart fetch failed (badges skipped): ${e.message}`)
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
  return logDrop(r, 'no genre match, not charting')
})
function logDrop(r, why) {
  log(`dropped: ${r.artist} — ${r.title} (${why})`)
  return false
}
if (before !== out.length) log(`${before - out.length} releases filtered out`)

// YouTube link fallback for anything still unlinked
for (const r of out) {
  if (!r.link && videos.length) {
    const url = matchVideo(r, videos)
    if (url) r.link = { service: 'youtube', url }
  }
}

for (const r of out) {
  delete r._src
  delete r._kr
}

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
