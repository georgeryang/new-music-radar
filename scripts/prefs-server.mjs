#!/usr/bin/env node
// Local preferences editor for config/preferences.json (the file that drives
// the nightly fetch). Zero deps; launched by prefs.command.
//
// Binds 127.0.0.1 only and rejects requests whose Host/Origin isn't this
// server (defeats cross-site POSTs + DNS rebinding; /api/ping is the one
// deliberate cross-origin endpoint). Writes exactly one hardcoded path,
// preserving keys the UI doesn't manage (_comment). The Apple Music artist
// search is proxied so the browser never talks to a third party. Also serves
// the built site from docs/ at /new-music-radar/ ("Open radar").

import http from 'node:http'
import { closeSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, normalize } from 'node:path'
import { GENRE_OPTIONS } from './genre-options.mjs'
import { STOREFRONTS } from './storefronts.mjs'

const PORT = 4747
const PREFS_PATH = new URL('../config/preferences.json', import.meta.url)
const DATA_PATH = new URL('../docs/data/releases.json', import.meta.url)
const REPO_DIR = fileURLToPath(new URL('..', import.meta.url))
// "Open radar" serves docs/ from this server, so the local copy shows fresh
// data the moment a refresh writes it, without waiting for the Pages deploy.
const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url))
// Symlink-resolved prefix (trailing / so a sibling like docs-evil/ can't pass
// a startsWith check); the static handler re-checks realpaths against this.
const DOCS_REAL = realpathSync(DOCS_DIR) + '/'
const SITE_PATH = '/new-music-radar/'
const SITE_URL = `http://localhost:${PORT}${SITE_PATH}`

// The editor shares the app's built stylesheet (@source in src/index.css
// folds this file's classes into that build). The hash changes per build, so
// resolve it per request — a mid-session rebuild must not leave a stale
// <link>. The build keeps at most one .css in docs/assets.
const ASSETS_DIR = fileURLToPath(new URL('../docs/assets/', import.meta.url))
function cssHref() {
  try {
    // strict filename shape: the one filesystem-derived string that reaches
    // raw HTML (the <link> below), so no quotes or angle brackets
    const f = readdirSync(ASSETS_DIR).find((n) => /^[\w.-]+\.css$/.test(n))
    return f ? `${SITE_PATH}assets/${f}` : null
  } catch {
    return null
  }
}

const readPrefs = () => JSON.parse(readFileSync(PREFS_PATH, 'utf8'))

// Newest US release date per artist id, written by the nightly fetch —
// drives the dormancy hints on followed-artist chips.
const ACTIVITY_PATH = new URL('../config/artist-activity.json', import.meta.url)
const readActivity = () => {
  try {
    return JSON.parse(readFileSync(ACTIVITY_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const isName = (s) => typeof s === 'string' && s.trim().length > 0 && s.length < 200
// Artist entries are {name, id} in both lists — the fetcher sweeps/blocks by
// ID only. Genres are plain strings.
const isPinnedArtistList = (v) =>
  Array.isArray(v) && v.every((e) => e && isName(e.name) && Number.isInteger(e.id))
const isStringList = (v) => Array.isArray(v) && v.every(isName)
// Playlists are {name, url}; the fetch scrapes exactly these pages, so enforce it.
const isPlaylistList = (v) =>
  Array.isArray(v) &&
  v.every(
    (e) =>
      e && isName(e.name) && typeof e.url === 'string' &&
      /^https:\/\/music\.apple\.com\/[a-z]{2}\/playlist\/[^/]+\/pl\./.test(e.url)
  )
// Countries are bare storefront codes; only verified-map codes accepted (the
// fetcher builds chart URLs from these). hasOwn so "constructor" can't validate.
const isCountryList = (v) =>
  Array.isArray(v) && v.every((c) => typeof c === 'string' && Object.hasOwn(STOREFRONTS, c))

// "Save & Refresh" spawns update.sh DETACHED (into launchd's log, with a
// pidfile), so quitting this server can't kill a running refresh.
const REFRESH_LOG = `${process.env.HOME}/Library/Logs/new-music-radar.log`
// Not /tmp (world-writable — another user could plant a pidfile and block refreshes).
const PIDFILE = `${process.env.HOME}/Library/Logs/new-music-radar-refresh.pid`

function refreshPid() {
  try {
    const pid = parseInt(readFileSync(PIDFILE, 'utf8'), 10)
    process.kill(pid, 0) // liveness probe, no signal sent
    return pid
  } catch {
    return null
  }
}

function startRefresh() {
  if (refreshPid()) return false
  const fd = openSync(REFRESH_LOG, 'a')
  const child = spawn('bash', ['scripts/update.sh'], {
    cwd: REPO_DIR,
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  writeFileSync(PIDFILE, String(child.pid))
  child.unref()
  closeSync(fd)
  return true
}

function logTail(lines) {
  try {
    const text = readFileSync(REFRESH_LOG, 'utf8')
    return text.split('\n').filter(Boolean).slice(-lines)
  } catch {
    return []
  }
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      // The deployed site pings this to decide whether to show its ⚙ link —
      // the only cross-origin endpoint; exposes nothing.
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
      return res.end()
    }
    // Everything else is same-origin only: Host must be this server (defeats
    // DNS rebinding) and any Origin must be ours — else a foreign page's
    // no-preflight POST could rewrite the lists or trigger refresh/git-push.
    if (!HOSTS.has(req.headers.host) || (req.headers.origin && !ORIGINS.has(req.headers.origin))) {
      return json(res, 403, { error: 'forbidden' })
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      // No built CSS = unstyled but fully functional (every control is
      // semantic HTML); only happens in a broken clone.
      const href = cssHref()
      res.end(PAGE.replace('<!--CSS-->', href ? `<link rel="stylesheet" href="${href}">` : ''))
    } else if (req.method === 'GET' && url.pathname === '/api/prefs') {
      const p = readPrefs()
      // Per-genre and per-source yield of the latest fetch, for the chip
      // markers. Only non-followed releases count: followed artists bypass
      // filters, so their releases say nothing about whether a chip earns its
      // keep. sourceCounts is keyed by the fetcher's sources tags
      // (country:<code>, playlist:<name>): t = releases the source surfaced,
      // u = those it was the sole tagged source for.
      const genreCounts = {}
      const sourceCounts = {}
      try {
        for (const r of JSON.parse(readFileSync(DATA_PATH, 'utf8')).releases ?? []) {
          if (r.followed) continue
          if (r.genre) {
            const k = r.genre.toLowerCase()
            genreCounts[k] = (genreCounts[k] ?? 0) + 1
          }
          for (const tag of r.sources ?? []) {
            const c = (sourceCounts[tag] ??= { u: 0, t: 0 })
            c.t++
            if (r.sources.length === 1) c.u++
          }
        }
      } catch {}
      json(res, 200, {
        artists: {
          followed: p.artists?.followed ?? [],
          blocked: p.artists?.blocked ?? [],
        },
        genres: { followed: p.genres?.followed ?? [] },
        playlists: p.discovery?.playlists ?? [],
        countries: p.discovery?.countries ?? [],
        activity: readActivity(),
        // localeCompare: accented names ("Música Mexicana") sort after "z" in
        // code-point order
        genreOptions: [...GENRE_OPTIONS].sort((a, b) => a.localeCompare(b)),
        genreCounts,
        sourceCounts,
        countryNames: STOREFRONTS,
        siteUrl: SITE_URL,
      })
    } else if (req.method === 'POST' && url.pathname === '/api/prefs') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1_000_000) return json(res, 413, { error: 'body too large' })
      }
      let incoming
      try {
        incoming = JSON.parse(body)
      } catch {
        return json(res, 400, { error: 'invalid JSON' })
      }
      if (
        !isPinnedArtistList(incoming?.artists?.followed) || !isPinnedArtistList(incoming?.artists?.blocked) ||
        !isStringList(incoming?.genres?.followed) ||
        !isPlaylistList(incoming?.discovery?.playlists) ||
        !isCountryList(incoming?.discovery?.countries)
      ) return json(res, 400, { error: 'invalid list shape' })
      const p = readPrefs() // preserve _comment, anything else
      p.artists = { followed: incoming.artists.followed, blocked: incoming.artists.blocked }
      p.genres = { ...p.genres, followed: incoming.genres.followed }
      p.discovery = { ...p.discovery, countries: incoming.discovery.countries, playlists: incoming.discovery.playlists }
      writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2) + '\n')
      json(res, 200, { ok: true })
    } else if (req.method === 'GET' && url.pathname === '/api/artist-search') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 100).trim()
      if (q.length < 2) return json(res, 200, { results: [] })
      // Same catalog the fetcher queries, so the picked ID is what the nightly
      // lookup uses. An all-digits query or pasted artist URL resolves by ID
      // (search?term= would read either as a name and find nothing).
      const urlId = q.match(/^https:\/\/music\.apple\.com\/[a-z]{2}\/artist\/[^/]+\/(\d+)/)?.[1]
      const id = urlId ?? (/^\d+$/.test(q) ? q : null)
      const upstream = await fetch(
        id
          ? `https://itunes.apple.com/lookup?id=${id}&country=US`
          : `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=musicArtist&country=US&limit=6`,
        { headers: { 'User-Agent': 'new-music-radar/1.0' } }
      )
      const data = await upstream.json()
      json(res, 200, {
        // wrapperType filter: a lookup id for a song/album would otherwise
        // return as a picker entry credited to its artist
        results: (data.results ?? []).filter((a) => a.wrapperType === 'artist').map((a) => ({
          id: a.artistId,
          name: a.artistName,
          genre: a.primaryGenreName ?? '',
          url: a.artistLinkUrl ?? '',
        })),
      })
    } else if (req.method === 'POST' && url.pathname === '/api/refresh') {
      json(res, startRefresh() ? 200 : 409, { running: true })
    } else if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, { running: !!refreshPid(), log: logTail(10) })
    } else if (req.method === 'POST' && url.pathname === '/api/quit') {
      json(res, 200, { ok: true })
      setTimeout(() => process.exit(0), 100)
    } else if (req.method === 'GET' && url.pathname === SITE_PATH.slice(0, -1)) {
      res.writeHead(302, { Location: SITE_PATH })
      res.end()
    } else if (req.method === 'GET' && url.pathname.startsWith(SITE_PATH)) {
      const rel = url.pathname.slice(SITE_PATH.length) || 'index.html'
      const file = join(DOCS_DIR, normalize(rel))
      if (!file.startsWith(DOCS_DIR)) return json(res, 403, { error: 'forbidden' })
      const TYPES = {
        html: 'text/html; charset=utf-8',
        js: 'text/javascript',
        css: 'text/css',
        json: 'application/json',
        woff2: 'font/woff2',
      }
      try {
        // realpath re-check: the lexical check above can't see a symlink
        // inside docs/ pointing elsewhere
        if (!realpathSync(file).startsWith(DOCS_REAL)) {
          return json(res, 403, { error: 'forbidden' })
        }
        const body = readFileSync(file)
        res.writeHead(200, {
          'Content-Type': TYPES[file.split('.').pop()] ?? 'application/octet-stream',
          // Always revalidate: docs/data changes underneath after every fetch.
          'Cache-Control': 'no-cache',
        })
        res.end(body)
      } catch {
        json(res, 404, { error: 'not found' })
      }
    } else {
      json(res, 404, { error: 'not found' })
    }
  } catch (e) {
    json(res, 500, { error: e.message })
  }
})

// ---------- the page ----------

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>New Music Radar preferences</title>
<!--CSS-->
</head>
<body class="mx-auto max-w-[680px] px-4 pt-6 pb-24">
<header class="mb-1 flex items-baseline justify-between"><h1 class="text-lg font-bold">Preferences</h1><a href="" id="site-link" target="_blank" rel="noopener noreferrer" class="text-[13px] text-muted-foreground hover:text-foreground">Open radar →</a></header>
<p class="mb-[18px] text-[12.5px] text-muted-foreground">Edits config/preferences.json. Save keeps changes for tonight's automatic update; Save &amp; Refresh applies them right away (about two minutes). Chip counts span 3 days; New only shows 24 hours, so counts often run higher than the page.</p>
<div id="sections"></div>
<div id="log-wrap" hidden class="fixed bottom-[92px] left-1/2 z-10 w-[min(640px,calc(100%-32px))] -translate-x-1/2">
  <button id="log-hide" class="absolute top-1.5 right-2.5 cursor-pointer p-0 text-[15px] leading-none text-muted-foreground hover:text-foreground" title="Hide the progress log (the refresh keeps running)" aria-label="Hide progress log">×</button>
  <pre id="log" class="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-muted px-3 py-2.5 pr-8 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap wrap-break-word"></pre>
</div>
<div id="banner" hidden role="status"></div>
<footer class="fixed inset-x-0 bottom-0 flex items-center justify-center gap-2 border-t border-border bg-background px-4 py-2.5">
  <span id="status" role="status" class="mr-auto max-w-[40%] truncate text-xs text-muted-foreground"></span>
  <button id="quit" class="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-[7px] text-[13px] disabled:cursor-default disabled:opacity-45">Quit</button>
  <button id="save" disabled class="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-[7px] text-[13px] disabled:cursor-default disabled:opacity-45">Save</button>
  <button id="refresh" class="cursor-pointer rounded-lg border border-primary bg-primary px-4 py-[7px] text-[13px] text-primary-foreground disabled:cursor-default disabled:opacity-45">Save &amp; Refresh</button>
</footer>
<script>
let prefs, activity = {}, genreOptions = [], genreCounts = {}, sourceCounts = {}, countryNames = {}, dirty = false
// display-only sort for the followed section: false = A-Z, true = oldest
// release first (dormant prune candidates cluster at the top)
let dormancySort = false
const $ = (id) => document.getElementById(id)
// artist entries are {name, id} (picker-pinned; the server rejects anything
// else); genres are plain strings; playlists are {name, url}
const nameOf = (e) => (typeof e === 'string' ? e : e.name)
const SECTIONS = [
  { key: 'artists.followed', label: 'Followed artists', sub: 'pinned first ★, fetched by Apple ID, bypass filters', artist: true, requireId: true },
  { key: 'artists.blocked', label: 'Blocked artists', sub: 'never shown (matched by Apple ID)', artist: true, requireId: true },
  { key: 'genres.followed', label: 'Followed genres', sub: 'discovery only surfaces these (followed artists always show)', artist: false },
  { key: 'discovery.countries', label: 'Additional countries', sub: 'always-scanned US charts (mostly English) plus these countries\\' Top 100 and purchase charts', country: true },
  { key: 'discovery.playlists', label: 'Discovery playlists', sub: 'Apple Music playlists scanned nightly for day-of releases', playlist: true },
]
const getList = (key) => key.split('.').reduce((o, k) => o[k], prefs)
// country entries are bare codes; the display name comes from the server's
// verified code→name map. hasOwn so an inherited key ("constructor") doesn't
// resolve to junk.
const displayOf = (s, e) => (s.country && Object.hasOwn(countryNames, e) ? countryNames[e] : nameOf(e))

// https://music.apple.com/us/playlist/<slug>/pl.<id> — display name from slug
function parsePlaylist(u) {
  const parts = u.split('/')
  if (!(u.startsWith('https://music.apple.com/') && parts[4] === 'playlist' && (parts[6] ?? '').startsWith('pl.'))) return null
  return { name: parts[5].replace(/-/g, ' ').replace(/\\b\\w/g, (c) => c.toUpperCase()), url: u }
}

// one dropdown row, same shape for artists, playlists, and genres
function resultRow(results, label, note, onPick) {
  const b = document.createElement('button')
  const nm = document.createElement('span')
  nm.textContent = label
  b.appendChild(nm)
  b.className = 'flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-[7px] text-left text-[13px] hover:bg-muted focus-visible:bg-muted'
  if (note) {
    const n = document.createElement('span')
    n.className = 'ml-auto whitespace-nowrap text-[11.5px] text-muted-foreground'
    n.textContent = note
    b.appendChild(n)
  }
  b.onclick = onPick
  results.appendChild(b)
  return b
}

function markDirty() { dirty = true; $('save').disabled = false }

function renderAll() {
  const root = $('sections')
  root.replaceChildren()
  for (const s of SECTIONS) {
    // Alphabetical, in-place (so Save writes this order). Safe: the fetcher
    // only does membership checks, never depends on list order.
    getList(s.key).sort((a, b) =>
      displayOf(s, a).toLowerCase().localeCompare(displayOf(s, b).toLowerCase())
    )
    const h = document.createElement('h2')
    h.className = 'mt-[18px] mb-2 text-[13px] font-bold'
    h.textContent = s.label + ' '
    const small = document.createElement('small')
    small.className = 'font-normal text-muted-foreground'
    small.textContent = '· ' + getList(s.key).length + ' · ' + s.sub
    h.appendChild(small)
    if (s.key === 'artists.followed') {
      const sort = document.createElement('button')
      sort.className = 'ml-2 cursor-pointer p-0 text-[11px] text-muted-foreground underline hover:text-foreground'
      sort.textContent = dormancySort ? 'sort: oldest release' : 'sort: A-Z'
      sort.title = 'Toggle display order (the saved file stays alphabetical)'
      sort.onclick = () => { dormancySort = !dormancySort; renderAll() }
      h.appendChild(sort)
    }
    // dormancy sort works on a copy, so the toggle never changes file order
    let entries = getList(s.key)
    if (s.key === 'artists.followed' && dormancySort) {
      entries = [...entries].sort((a, b) => {
        const da = (a.id && activity[a.id]) || '9999' // no data -> sort last
        const db = (b.id && activity[b.id]) || '9999'
        return da.localeCompare(db) || nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase())
      })
    }
    const chips = document.createElement('div')
    chips.className = 'mb-2 flex flex-wrap gap-1.5'
    // Source yield marker (countries + playlists): unique/duplicate/total
    // releases from this source. Unique = only this source surfaced it (what
    // pruning would lose); duplicate = shared with another source. Amber 0 =
    // prune candidate. A source added after the last fetch reads 0 until the next.
    const sourceCount = (tag) => {
      const { u, t } = sourceCounts[tag] ?? { u: 0, t: 0 }
      const span = document.createElement('span')
      span.className = t === 0 ? 'text-[11px] text-amber-800 dark:text-amber-400' : 'text-[11px] text-muted-foreground'
      span.textContent = '· ' + (t === 0 ? '0' : u + '/' + (t - u) + '/' + t)
      span.title = t === 0
        ? 'nothing found by the latest update via this source'
        : u + ' only here / ' + (t - u) + ' shared with other sources / ' + t + ' total, latest update'
      return span
    }
    for (const entry of entries) {
      const chip = document.createElement('span')
      chip.className = 'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-[3px] text-[13px]'
      chip.appendChild(document.createTextNode(displayOf(s, entry)))
      if (s.country) {
        const code = document.createElement('span')
        code.className = 'text-[11px] text-muted-foreground'
        code.textContent = '· ' + entry
        chip.appendChild(code)
        chip.appendChild(sourceCount('country:' + entry))
      }
      if (s.playlist) chip.appendChild(sourceCount('playlist:' + nameOf(entry)))
      // Genre yield marker: releases admitted via this genre (followed artists
      // excluded). Amber 0 = prune candidate.
      if (s.key === 'genres.followed') {
        const n = genreCounts[nameOf(entry).toLowerCase()] ?? 0
        const count = document.createElement('span')
        count.className = n === 0 ? 'text-[11px] text-amber-800 dark:text-amber-400' : 'text-[11px] text-muted-foreground'
        count.textContent = '· ' + n
        count.title = 'found by the latest update via this genre'
        chip.appendChild(count)
      }
      if (typeof entry !== 'string') chip.title = entry.url ?? 'Apple Music artist #' + entry.id
      // Dormancy hint: an artist with no release in 18+ months is a prune
      // candidate (curation, not performance — fetch time is list-size independent).
      const last = s.key === 'artists.followed' && entry.id ? activity[entry.id] : null
      if (last && Date.now() - Date.parse(last) > 18 * 2629746000) {
        const months = Math.round((Date.now() - Date.parse(last)) / 2629746000)
        const ago = document.createElement('span')
        // amber 18mo+, red 3y+. Full literals — Tailwind scans this file as
        // text. These shades clear AA at 11px on bg-muted where amber-700 and
        // the red primary fall just short.
        ago.className = months >= 36 ? 'text-[11px] text-accent-foreground' : 'text-[11px] text-amber-800 dark:text-amber-400'
        // round, not floor — floor showed a 3.9y gap as "3y"
        ago.textContent = '· ' + (months >= 24 ? Math.round(months / 12) + 'y' : months + 'mo')
        ago.title = 'Last release ' + last
        chip.appendChild(ago)
      }
      const x = document.createElement('button')
      x.className = 'cursor-pointer p-0 text-[13px] leading-none text-muted-foreground hover:text-destructive'
      x.textContent = '×'
      x.title = 'Remove'
      x.setAttribute('aria-label', 'Remove ' + nameOf(entry))
      x.onclick = () => { const l = getList(s.key); l.splice(l.indexOf(entry), 1); markDirty(); renderAll() }
      chip.appendChild(x)
      chips.appendChild(chip)
    }
    root.append(h, chips, makeAdder(s))
  }
}

function addTo(key, item) {
  const list = getList(key)
  const name = nameOf(item).trim()
  if (!name) return
  if (list.some((e) => nameOf(e).toLowerCase() === name.toLowerCase())) return
  list.push(typeof item === 'string' ? name : { ...item, name })
  markDirty(); renderAll()
}

function makeAdder(s) {
  const wrap = document.createElement('div')
  wrap.className = 'relative flex gap-1.5'
  const input = document.createElement('input')
  input.className = 'flex-1 rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-[13px]'
  // placeholders disappear on typing — give the field a persistent name
  input.setAttribute('aria-label', 'Add to ' + s.label)
  input.placeholder = s.artist
    ? 'Add artist (name, Apple ID, or artist page URL, then pick from the list)…'
    : s.playlist
      ? 'Add playlist (paste an Apple Music playlist URL, then pick from the list)…'
      : s.country
        ? 'Add country (pick from the list)…'
        : 'Add genre (pick from the list, or press Enter for exact text)…'
  const results = document.createElement('div')
  results.className = 'absolute inset-x-0 top-[34px] z-10 max-h-60 overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-background shadow-[0_8px_24px_rgba(0,0,0,.12)]'
  results.hidden = true
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    if (s.requireId) {
      // free-text entries have no Apple ID — the fetcher can't sweep them
      $('status').textContent = 'Pick an artist from the search list (entries are pinned by Apple ID).'
      return
    }
    if (s.playlist) {
      const pl = parsePlaylist(input.value.trim())
      if (!pl) {
        $('status').textContent = 'Not an Apple Music playlist URL.'
        return
      }
      if (getList(s.key).some((e) => e.url === pl.url)) {
        $('status').textContent = 'That playlist is already in the list.'
        input.value = ''
        return
      }
      addTo(s.key, pl)
    } else if (s.country) {
      // free text must resolve to a known storefront code (server rejects others)
      const q = input.value.trim().toLowerCase()
      const code = Object.hasOwn(countryNames, q) ? q : Object.keys(countryNames).find((c) => countryNames[c].toLowerCase() === q)
      if (!code) {
        $('status').textContent = 'Pick a country from the list.'
        return
      }
      addTo(s.key, code)
    } else {
      addTo(s.key, input.value)
    }
    input.value = ''
    results.hidden = true
  }
  if (s.artist) {
    let timer
    input.oninput = () => {
      clearTimeout(timer)
      const q = input.value
      if (q.trim().length < 2) { results.hidden = true; return }
      timer = setTimeout(async () => { // 500ms: iTunes Search is ~20 req/min
        const r = await fetch('/api/artist-search?q=' + encodeURIComponent(q)).then((r) => r.json())
        results.replaceChildren()
        for (const a of r.results) {
          const b = document.createElement('button')
          b.className = 'flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-[7px] text-left text-[13px] hover:bg-muted focus-visible:bg-muted'
          const nm = document.createElement('span')
          nm.textContent = a.name
          const genre = document.createElement('span')
          genre.className = 'ml-auto whitespace-nowrap text-[11.5px] text-muted-foreground'
          genre.textContent = a.genre
          b.append(nm, genre)
          if (a.url) {
            // verify the identity on its Apple Music page before adding
            const verify = document.createElement('a')
            verify.className = 'px-1.5 text-sm text-muted-foreground no-underline hover:text-foreground'
            verify.textContent = '↗'
            verify.href = a.url
            verify.target = '_blank'
            verify.rel = 'noopener noreferrer'
            verify.title = 'Open on Apple Music to verify'
            verify.onclick = (ev) => ev.stopPropagation()
            b.appendChild(verify)
          }
          b.onclick = () => { addTo(s.key, { name: a.name, id: a.id }); input.value = ''; results.hidden = true }
          results.appendChild(b)
        }
        results.hidden = r.results.length === 0
      }, 500)
    }
    input.onblur = () => setTimeout(() => { results.hidden = true }, 200)
  } else if (s.playlist) {
    // a valid URL shows one result row with the derived name, so the chip text
    // is visible before adding. No raw-text onchange fallback: the mid-edit
    // re-render would fire it with the URL still in the box and add a second,
    // URL-named chip.
    input.oninput = () => {
      results.replaceChildren()
      const pl = parsePlaylist(input.value.trim())
      if (!pl) { results.hidden = true; return }
      const taken = getList(s.key).some((e) => e.url === pl.url)
      resultRow(results, pl.name, taken ? 'already in the list' : 'playlist', () => {
        if (!taken) addTo(s.key, pl)
        input.value = ''
        results.hidden = true
      })
      results.hidden = false
    }
    input.onblur = () => setTimeout(() => { results.hidden = true }, 200)
  } else if (s.country) {
    // countries: focus lists every storefront not yet followed, typing
    // filters by name or code; add only from the list (codes are verified).
    const show = () => {
      results.replaceChildren()
      const typed = input.value.trim().toLowerCase()
      const have = new Set(getList(s.key))
      const opts = Object.entries(countryNames)
        .filter(([code, name]) => !have.has(code) && (name.toLowerCase().includes(typed) || code.includes(typed)))
        .sort((a, b) => a[1].localeCompare(b[1]))
      for (const [code, name] of opts) {
        resultRow(results, name, code, () => {
          addTo(s.key, code)
          input.value = ''
          results.hidden = true
        })
      }
      results.hidden = opts.length === 0
    }
    input.oninput = show
    input.onfocus = show
    input.onblur = () => setTimeout(() => { results.hidden = true }, 200)
  } else {
    // genres: focus lists the curated options, typing filters, Enter takes
    // exact free text (any Apple genre name is followable).
    const show = () => {
      results.replaceChildren()
      const typed = input.value.trim().toLowerCase()
      const have = new Set(getList(s.key).map((g) => nameOf(g).toLowerCase()))
      const opts = genreOptions.filter((g) => !have.has(g.toLowerCase()) && g.toLowerCase().includes(typed))
      for (const g of opts) {
        resultRow(results, g, '', () => {
          addTo(s.key, g)
          input.value = ''
          results.hidden = true
        })
      }
      // nothing matches: offer the exact text explicitly (what Enter does)
      if (!opts.length && typed && !have.has(typed)) {
        resultRow(results, 'Follow exact text "' + input.value.trim() + '"', 'exact Apple genre match', () => {
          addTo(s.key, input.value)
          input.value = ''
          results.hidden = true
        })
        results.hidden = false
        return
      }
      results.hidden = opts.length === 0
    }
    input.oninput = show
    input.onfocus = show
    input.onblur = () => setTimeout(() => { results.hidden = true }, 200)
  }
  wrap.append(input, results)
  return wrap
}

let wasRunning = false
let pollTimer
// The floating progress log covers the lower chips while a refresh runs; the
// × hides it for THIS refresh only (flag resets when the next one starts).
let logDismissed = false
$('log-hide').onclick = () => {
  logDismissed = true
  $('log-wrap').hidden = true
}
// Semantic status colors; only the error state uses brand red. Full literals
// per state — Tailwind scans this file as text.
const BANNER_BASE = 'fixed inset-x-0 bottom-14 px-4 py-[9px] text-center text-[13px]'
const BANNER = {
  running: 'bg-amber-100 text-amber-900',
  ok: 'bg-green-100 text-green-900',
  warn: 'bg-orange-100 text-orange-900',
  // primary, not accent: the dark accent is 28%-alpha and this strip floats
  // over the chips, so an error banner must be opaque
  bad: 'bg-primary text-primary-foreground',
}
function setBanner(cls, text) {
  const b = $('banner')
  b.hidden = !cls
  b.className = cls ? BANNER_BASE + ' ' + BANNER[cls] : ''
  b.replaceChildren()
  if (cls === 'running') {
    const dot = document.createElement('span')
    dot.className = 'inline-block motion-safe:animate-pulse'
    dot.textContent = '●\\u2009'
    b.appendChild(dot)
  }
  b.appendChild(document.createTextNode(text ?? ''))
}

async function poll() {
  const st = await fetch('/api/status').then((r) => r.json()).catch(() => null)
  if (st) {
    $('refresh').disabled = st.running
    $('refresh').textContent = st.running ? 'Refreshing…' : 'Save & Refresh'
    $('status').textContent = st.running ? '' : (st.log.at(-1) ?? '')
    if (st.running && !wasRunning) logDismissed = false // new refresh, show again
    $('log-wrap').hidden = !st.running || logDismissed
    if (st.running) {
      $('log').textContent = st.log.join('\\n')
      $('log').scrollTop = $('log').scrollHeight
      setBanner('running', 'Refreshing, about two minutes. Live progress above; safe to close this page, the refresh continues in the background.')
    } else if (wasRunning) {
      // update.sh publishes partial data on a source failure (logging ERROR) —
      // that outcome is amber, not green.
      const published = st.log.some((l) => /Published|No changes/.test(l))
      const failed = st.log.some((l) => /ERROR:/.test(l))
      if (published && !failed) {
        setBanner('ok', 'Refresh complete. The site shows the new data within a minute.')
      } else if (published) {
        setBanner('warn', 'Refresh finished, but a source failed. Everything else was published; check ~/Library/Logs/new-music-radar.log.')
      } else {
        setBanner('bad', 'Refresh finished with errors. Check ~/Library/Logs/new-music-radar.log.')
      }
    }
    wasRunning = st.running
  }
  pollTimer = setTimeout(poll, st?.running ? 2000 : 10000)
}

async function save() {
  const r = await fetch('/api/prefs', { method: 'POST', body: JSON.stringify(prefs) })
  if (r.ok) { dirty = false; $('save').disabled = true; $('status').textContent = 'Saved.' }
  else $('status').textContent = 'Save failed: ' + (await r.json()).error
  return r.ok
}
$('save').onclick = save
// Primary action: saves any pending edits, then fetches with them.
$('refresh').onclick = async () => {
  if (dirty && !(await save())) return
  setBanner('running', 'Starting refresh…')
  await fetch('/api/refresh', { method: 'POST' })
  wasRunning = true
  logDismissed = false // this click preempts poll's false→true transition
  clearTimeout(pollTimer) // restart the single poll chain, don't fork a second one
  poll()
}
$('quit').onclick = async () => { await fetch('/api/quit', { method: 'POST' }); document.body.innerHTML = '<p class="p-10 text-center">Server stopped. You can close this tab.</p>' }
window.onbeforeunload = () => (dirty ? true : undefined)

fetch('/api/prefs').then((r) => r.json()).then((p) => {
  prefs = { artists: p.artists, genres: p.genres, discovery: { countries: p.countries ?? [], playlists: p.playlists ?? [] } }
  activity = p.activity ?? {}
  genreOptions = p.genreOptions ?? []
  genreCounts = p.genreCounts ?? {}
  sourceCounts = p.sourceCounts ?? {}
  countryNames = p.countryNames ?? {}
  $('site-link').href = p.siteUrl
  renderAll()
  poll()
})
</script>
</body>
</html>`

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Preferences editor: http://localhost:${PORT}`)
})
