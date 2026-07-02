#!/usr/bin/env node
// Fetch new kpop + pop releases and write docs/data/{kpop,pop}.json.
// Zero deps — just node's fetch. Run daily by scripts/update.sh via launchd.
//
// Pipeline per scene (single-spine design — only Deezer creates entries,
// everything else enriches, so source failures can't create duplicates):
//   1. Deezer editorial releases        — spine (16 Asian Music / 132 Pop)
//   2. window filter (last WINDOW_DAYS) — BEFORE the per-release API calls
//   3. Deezer album detail              — record_type (album/ep/single)
//   4. noise blocklist + canonical-key dedup (key includes type, so a song
//      titled like its album keeps both entries)
//   5. iTunes Search                    — Apple Music link + K-Pop genre filter
//   6. Apple most-played chart          — charting badge
//   7. YouTube label-channel feeds      — link fallback (songs: MV first)
//   8. link priority chain: Apple Music → YouTube → none
//
// Exit codes: 0 = all scenes ok, 2 = at least one scene failed entirely
// (update.sh publishes partial data either way — v1 pattern).

import { readFileSync, writeFileSync } from 'node:fs'

const WINDOW_DAYS = 2 // "today or yesterday", with a little slack for timezones
const UA = 'new-music-radar/1.0'
const OUT = (scene) => new URL(`../docs/data/${scene}.json`, import.meta.url)

const SCENES = [
  { id: 'kpop', deezerGenre: 16, storefront: 'kr', chart: 'KR' },
  { id: 'pop', deezerGenre: 132, storefront: 'us', chart: 'US' },
]

// Kpop label channels for the YouTube link fallback. Feed IDs verified 2026-07-02.
// Add channels freely — an unreachable feed just logs and is skipped.
const KPOP_CHANNELS = {
  SMTOWN: 'UCEf_Bc-KVd7onSeifS3py9g',
  'HYBE LABELS': 'UC3IZKseVpdzPSBaWxBxundA',
  'JYP Entertainment': 'UCaO6TYtlC8U5ttz62hTrZgg',
  '1theK': 'UCweOkPb1wVVH0Q0Tlj4a5Pw',
}

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
  return days <= WINDOW_DAYS + 0.5 // half-day slack: sources date in local storefront time
}

// ---------- source steps ----------

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

async function albumDetail(release) {
  const d = await getJSON(`https://api.deezer.com/album/${release.id}`)
  return {
    title: d.title,
    artist: d.artist?.name ?? '?',
    type: TYPE_MAP[d.record_type] ?? 'album',
    release_date: d.release_date,
    artwork: d.cover_medium ?? '',
  }
}

async function itunesLookup(release, country) {
  const term = encodeURIComponent(`${release.artist} ${normTitle(release.title)}`)
  const entity = release.type === 'song' ? 'album,song' : 'album'
  const data = await getJSON(
    `https://itunes.apple.com/search?term=${term}&entity=${entity}&country=${country}&limit=5`
  )
  const wantArtist = normArtist(release.artist)
  const wantTitle = normTitle(release.title)
  for (const r of data.results ?? []) {
    const name = r.collectionName ?? r.trackName ?? ''
    if (
      normArtist(r.artistName ?? '') === wantArtist &&
      (normTitle(name) === wantTitle || normTitle(name).startsWith(wantTitle))
    ) {
      return { apple_url: r.collectionViewUrl ?? r.trackViewUrl ?? null, genre: r.primaryGenreName ?? null }
    }
  }
  return { apple_url: null, genre: null }
}

async function fetchChart(storefront) {
  const data = await getJSON(
    `https://rss.marketingtools.apple.com/api/v2/${storefront}/music/most-played/50/albums.json`
  )
  return (data.feed?.results ?? []).map((e, i) => ({
    rank: i + 1,
    artist: normArtist(e.artistName),
    title: normTitle(e.name),
  }))
}

async function fetchChannelVideos(channelId) {
  const xml = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? ''
    const id = (m[1].match(/<yt:videoId>(.*?)<\/yt:videoId>/) ?? [])[1] ?? ''
    return { title, url: `https://www.youtube.com/watch?v=${id}` }
  })
}

function matchVideo(release, videos) {
  const t = normTitle(release.title)
  if (t.length < 3) return null // too short to match safely
  const candidates = videos.filter((v) => normTitle(v.title).includes(t))
  if (release.type === 'song') {
    const mv = candidates.find((v) => /\bmv\b|music video/i.test(v.title))
    if (mv) return mv.url
  }
  const a = normArtist(release.artist)
  const byArtist = candidates.find((v) => normTitle(v.title).includes(a))
  return (byArtist ?? (t.length > 6 ? candidates[0] : null))?.url ?? null
}

// ---------- per-scene pipeline ----------

async function buildScene(scene, videos) {
  const spine = await fetchSpine(scene.deezerGenre)
  const fresh = spine.filter((r) => r.release_date && inWindow(r.release_date))
  log(`${scene.id}: ${spine.length} editorial releases, ${fresh.length} in window`)

  const releases = []
  for (const item of fresh) {
    try {
      const r = await albumDetail(item)
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

  // canonical-key dedup (type is in the key: same-titled song + album both survive)
  const byKey = new Map()
  for (const r of releases) {
    const k = keyOf(r)
    const prev = byKey.get(k)
    if (prev) {
      log(`${scene.id}: deduped "${r.title}" into "${prev.title}"`)
      if (r.release_date < prev.release_date) prev.release_date = r.release_date
    } else {
      byKey.set(k, r)
    }
  }
  let out = [...byKey.values()]

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

  // kpop = Asian Music editorial minus releases iTunes says are NOT Korean
  if (scene.id === 'kpop') {
    const before = out.length
    out = out.filter((r) => !r._genre || /k-?pop|korean/i.test(r._genre))
    if (before !== out.length) log(`kpop: filtered out ${before - out.length} non-K-Pop releases`)
  }
  for (const r of out) delete r._genre

  try {
    const chart = await fetchChart(scene.storefront)
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

  // YouTube fallback for whatever Apple didn't cover (kpop channels only for now)
  if (scene.id === 'kpop' && videos.length) {
    for (const r of out) {
      if (!r.link) {
        const url = matchVideo(r, videos)
        if (url) r.link = { service: 'youtube', url }
      }
    }
  }

  out.sort(
    (a, b) => b.release_date.localeCompare(a.release_date) || a.artist.localeCompare(b.artist)
  )
  return out
}

// ---------- main ----------

let videos = []
for (const [name, id] of Object.entries(KPOP_CHANNELS)) {
  try {
    const v = await fetchChannelVideos(id)
    videos.push(...v)
  } catch (e) {
    log(`channel feed ${name} failed (fallback links reduced): ${e.message}`)
  }
  await pause()
}

let anyFailed = false
for (const scene of SCENES) {
  try {
    const releases = await buildScene(scene, videos)

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
