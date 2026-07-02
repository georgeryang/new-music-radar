#!/usr/bin/env node
// Fetch new kpop + pop releases and write docs/data/{kpop,pop}.json.
// Zero deps — just node's fetch. Run daily by scripts/update.sh via launchd.
//
// Entry sources (per the 2026-07-02 spike: Deezer editorial alone misses
// major kpop comebacks, MusicBrainz is worse — Hangul names + release-day lag):
//   kpop: Deezer Asian editorial (16)  — spine, lags 0-2 days
//         + Deezer Asian albums chart  — streaming-heavy comebacks, recency-filtered
//         + label-channel MV uploads   — the same-day catcher: in kpop the MV *is*
//           the song-release announcement. Parsed into SONG entries (no video
//           cards); the MV is just the entry's fallback link.
//   pop:  Deezer Pop editorial (132), then curated: keep only releases with an
//         iTunes US match or a chart position (drops the international firehose).
// Enrichment: iTunes Search (Apple Music link + K-Pop genre check), Apple
// most-played charts (badge). Canonical-key dedup collapses cross-source
// duplicates; the key includes type, so a song titled like its album keeps both.
//
// Exit codes: 0 = all scenes ok, 2 = at least one scene failed entirely
// (update.sh publishes partial data either way — v1 pattern).

import { readFileSync, writeFileSync } from 'node:fs'

// Display target is "today or yesterday", but Deezer's editorial lags releases
// by 1-2 days (verified 2026-07-02: newest entry was 2 days old) — a 2-day
// window made the editorial contribute nothing. 3 days keeps it in play.
const WINDOW_DAYS = 3
const UA = 'new-music-radar/1.0'
const OUT = (scene) => new URL(`../docs/data/${scene}.json`, import.meta.url)

// Feed IDs verified 2026-07-02. 1theK is Kakao's aggregator and covers most
// mid-size labels. Add channels freely — an unreachable feed logs and is skipped.
const KPOP_CHANNELS = {
  SMTOWN: 'UCEf_Bc-KVd7onSeifS3py9g',
  'HYBE LABELS': 'UC3IZKseVpdzPSBaWxBxundA',
  'JYP Entertainment': 'UCaO6TYtlC8U5ttz62hTrZgg',
  '1theK': 'UCweOkPb1wVVH0Q0Tlj4a5Pw',
  BLACKPINK: 'UCOmHUn--16B90oW2L6FRR3A',
}

// Preferred artists (config/artists.json): fetched directly from Deezer so
// their releases are never missed, and pinned first in each section.
const PREFERRED = JSON.parse(
  readFileSync(new URL('../config/artists.json', import.meta.url), 'utf8')
)

const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Sequential requests with jitter — burst patterns are what got RSS throttled in v1.
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
  let t = raw.toLowerCase()
  let prev
  do {
    prev = t
    t = t.replace(EDITION_RE, '')
  } while (t !== prev && t.length > 2)
  return t.replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()
}

const normArtist = (raw) =>
  raw.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()

const keyOf = (r) => `${normArtist(r.artist)}|${normTitle(r.title)}|${r.type}`

const TYPE_MAP = { album: 'album', ep: 'ep', single: 'song' }

function inWindow(releaseDate) {
  const days = (Date.now() - Date.parse(releaseDate)) / 86400e3
  // lower bound: artist discographies include pre-orders (future dates) —
  // released-only scope. -1 day of slack tolerates storefront timezone skew.
  return days <= WINDOW_DAYS + 0.5 && days >= -1
}

// ---------- Deezer (spine + kpop chart supplement) ----------

async function fetchSpine(genreId) {
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

async function fetchChartAlbums(genreId) {
  const data = await getJSON(`https://api.deezer.com/chart/${genreId}/albums?limit=25`)
  return data.data ?? []
}

// Direct discography check for a preferred artist — the never-miss path.
// artist/{id}/albums already carries record_type/release_date/cover, so no
// per-album detail call is needed.
async function preferredArtistReleases(name) {
  const search = await getJSON(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=3`)
  const want = normArtist(name)
  const artist = (search.data ?? []).find((a) => normArtist(a.name) === want)
  if (!artist) return []
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

// ---------- iTunes Search (Apple link + genre) ----------

// Loose-but-anchored matching (the spike's exact-equality left 54% unlinked):
// artist must contain or be contained by the wanted artist, ditto title.
const contains = (a, b) => a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a))

async function itunesLookup(release, country) {
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
  // Kpop fallback: iTunes KR indexes many Korean artists under Hangul names
  // (최유정, not CHOI YOOJUNG), so the romanized artist match fails. Accept an
  // exact TITLE match instead, but only when iTunes confirms the genre is
  // Korean — the genre gate keeps same-titled Western songs out.
  if (country === 'kr' && wantTitle.length >= 3) {
    for (const r of data.results ?? []) {
      const name = normTitle(r.collectionName ?? r.trackName ?? '')
      if (name === wantTitle && /k-?pop|korean/i.test(r.primaryGenreName ?? '')) {
        return { apple_url: r.collectionViewUrl ?? r.trackViewUrl ?? null, genre: r.primaryGenreName }
      }
    }
  }
  return { apple_url: null, genre: null }
}

// ---------- Apple most-played chart (badge) ----------

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
  // NFKC: labels stylize titles with math-bold Unicode (𝗩𝟴 → V8)
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

// ---------- per-scene pipeline ----------

async function buildScene(scene, videos) {
  const releases = []

  // PRIMARY 1: preferred-artist discographies — the same-day, never-miss path.
  // Runs first so a later source failure can never cost us these.
  let preferredCount = 0
  for (const name of PREFERRED[scene.id] ?? []) {
    try {
      const found = await preferredArtistReleases(name)
      preferredCount += found.length
      releases.push(...found)
    } catch (e) {
      log(`${scene.id}: preferred lookup failed for "${name}": ${e.message}`)
    }
    await pause()
  }
  if (preferredCount) log(`${scene.id}: ${preferredCount} releases via preferred artists`)

  // PRIMARY 2 (kpop): songs derived from fresh label-channel MV uploads — also same-day
  if (scene.id === 'kpop') {
    const derived = mvDerivedSongs(videos)
    log(`kpop: ${derived.length} MV-derived songs`)
    releases.push(...derived)
  }

  // BACKUP: Deezer editorial (+ kpop chart) fills in the rest of the scene.
  // Lags 1-2 days; wrapped so its failure publishes primary results anyway.
  let backupFailed = false
  try {
    const spine = await fetchSpine(scene.deezerGenre)
    let fresh = spine.filter((r) => r.release_date && inWindow(r.release_date))
    log(`${scene.id}: ${spine.length} editorial releases, ${fresh.length} in window`)

    if (scene.id === 'kpop') {
      try {
        const chartAlbums = await fetchChartAlbums(scene.deezerGenre)
        const known = new Set(fresh.map((r) => r.id))
        fresh = fresh.concat(chartAlbums.filter((a) => !known.has(a.id)))
        await pause()
      } catch (e) {
        log(`kpop: chart supplement failed: ${e.message}`)
      }
    }

    for (const item of fresh) {
      try {
        const r = await albumDetail(item.id)
        if (!r.release_date || !inWindow(r.release_date)) continue // stale chart albums
        if (NOISE_RE.test(r.title)) {
          log(`${scene.id}: dropped noise "${r.artist} — ${r.title}"`)
        } else {
          releases.push(r)
        }
      } catch (e) {
        log(`${scene.id}: album detail failed for ${item.id}: ${e.message}`)
      }
      await pause()
    }
  } catch (e) {
    backupFailed = true
    log(`${scene.id}: editorial backup failed (publishing primary sources only): ${e.message}`)
  }

  // preferred flag (whole-word match so "IVE" can't match inside "RIIZE");
  // set before dedup/filters so pinning and filter bypass see it everywhere
  const preferredRes = (PREFERRED[scene.id] ?? []).map(
    (n) => new RegExp(`\\b${normArtist(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  )
  for (const r of releases) {
    if (preferredRes.some((re) => re.test(normArtist(r.artist)))) r.preferred = true
  }

  // canonical-key dedup (type is in the key: same-titled song + album both survive)
  const byKey = new Map()
  for (const r of releases) {
    const k = keyOf(r)
    const prev = byKey.get(k)
    if (prev) {
      log(`${scene.id}: deduped "${r.title}" (${r._src ?? 'deezer'}) into existing entry`)
      if (r.release_date < prev.release_date) prev.release_date = r.release_date
      if (!prev.artwork && r.artwork) prev.artwork = r.artwork
      if (!prev.link && r.link) prev.link = r.link
    } else {
      byKey.set(k, r)
    }
  }
  let out = [...byKey.values()]

  // iTunes: Apple Music link (top of the priority chain) + genre
  for (const r of out) {
    try {
      const { apple_url, genre } = await itunesLookup(r, scene.storefront)
      if (apple_url) r.link = { service: 'apple', url: apple_url }
      r._genre = genre
    } catch (e) {
      log(`${scene.id}: itunes lookup failed for "${r.title}": ${e.message}`)
    }
    await pause()
  }

  // kpop = Asian editorial minus releases iTunes says are NOT Korean.
  // MV-derived entries are definitionally kpop (they came from kpop label channels).
  if (scene.id === 'kpop') {
    const before = out.length
    out = out.filter((r) => r._src === 'mv' || !r._genre || /k-?pop|korean/i.test(r._genre))
    if (before !== out.length) log(`kpop: filtered out ${before - out.length} non-K-Pop releases`)
  }

  // chart badge
  try {
    const chart = await fetchAppleChart(scene.storefront)
    for (const r of out) {
      const a = normArtist(r.artist)
      const t = normTitle(r.title)
      const hit = chart.find(
        (c) => c.artist === a && (c.title === t || c.title.startsWith(t) || t.startsWith(c.title))
      )
      if (hit) r.charting = { storefront: scene.chart, rank: hit.rank }
    }
  } catch (e) {
    log(`${scene.id}: chart fetch failed (badges skipped): ${e.message}`)
  }

  // pop curation: the Pop editorial is a global firehose (Maghreb Rai, Afro-Pop,
  // regional releases r/popheads would never surface). Keep a release when it
  // charts, or when its iTunes US genre is in the mainstream-pop family. No
  // iTunes match at all → drop (verified: US catalog carries the regional
  // releases too, so "has a match" alone isn't selective).
  if (scene.id === 'pop') {
    const GENRE_OK = /^(pop|dance|electronic|r&b\/soul|hip-hop\/rap|alternative|rock|country|singer\/songwriter|soundtrack|indie)/i
    const keep = (r) => r.preferred || r.charting || (r._genre && GENRE_OK.test(r._genre))
    const dropped = out.filter((r) => !keep(r))
    out = out.filter(keep)
    if (dropped.length)
      log(`pop: dropped ${dropped.length} non-mainstream releases: ${dropped.map((r) => `${r.artist} — ${r.title} [${r._genre ?? 'no match'}]`).join('; ')}`)
  }

  // YouTube link fallback for anything still unlinked (kpop channels only for now)
  if (scene.id === 'kpop' && videos.length) {
    for (const r of out) {
      if (!r.link) {
        const url = matchVideo(r, videos)
        if (url) r.link = { service: 'youtube', url }
      }
    }
  }

  for (const r of out) {
    delete r._genre
    delete r._src
  }
  // preferred artists first, then release date desc, then artist name
  out.sort(
    (a, b) =>
      (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0) ||
      b.release_date.localeCompare(a.release_date) ||
      a.artist.localeCompare(b.artist)
  )
  return { releases: out, backupFailed }
}

// ---------- main ----------

const SCENES = [
  { id: 'kpop', deezerGenre: 16, storefront: 'kr', chart: 'KR' },
  { id: 'pop', deezerGenre: 132, storefront: 'us', chart: 'US' },
]

let videos = []
for (const [name, id] of Object.entries(KPOP_CHANNELS)) {
  try {
    videos.push(...(await fetchChannelVideos(id)))
  } catch (e) {
    log(`channel feed ${name} failed (MV-derived entries reduced): ${e.message}`)
  }
  await pause()
}

let anyFailed = false
for (const scene of SCENES) {
  try {
    const { releases, backupFailed } = await buildScene(scene, videos)
    if (backupFailed) anyFailed = true // primary data still publishes below

    // Empty-success guard (v1 lesson: an empty success can be a failure in
    // disguise). If we got nothing but the previous file still has in-window
    // releases, keep those instead of stamping an empty file fresh.
    if (releases.length === 0) {
      let prev = []
      try {
        prev = JSON.parse(readFileSync(OUT(scene.id), 'utf8')).releases ?? []
      } catch {}
      const carried = prev.filter((r) => inWindow(r.release_date))
      if (carried.length) {
        log(`${scene.id}: 0 fetched but ${carried.length} previous in-window releases — carrying over`)
        writeFileSync(OUT(scene.id), JSON.stringify({ fetched_at: Date.now(), releases: carried }, null, 2))
        continue
      }
    }

    writeFileSync(OUT(scene.id), JSON.stringify({ fetched_at: Date.now(), releases }, null, 2))
    log(`${scene.id}: wrote ${releases.length} releases`)
  } catch (e) {
    // Scene failed entirely: leave the previous file untouched (stale beats empty)
    anyFailed = true
    log(`${scene.id}: FAILED, keeping existing file: ${e.message}`)
  }
}

process.exit(anyFailed ? 2 : 0)
