#!/usr/bin/env node
// Local preferences editor for config/preferences.json — the file that drives
// the nightly fetch (preferred artists get discography checks + pinning,
// blocked artists are dropped by ID). Zero deps; launched by prefs.command.
//
// Binds 127.0.0.1 only, and rejects requests whose Host/Origin isn't this
// server (defeats cross-site POSTs and DNS rebinding from pages you visit
// while it runs; /api/ping is the one deliberate cross-origin endpoint).
// Writes exactly one hardcoded path (the config file), preserving keys the
// UI doesn't manage (_comment). The Apple Music artist search is proxied so
// the browser never talks to a third party.

import http from 'node:http'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CANON_TAGS } from './genre-map.mjs'

const PORT = 4747
const PREFS_PATH = new URL('../config/preferences.json', import.meta.url)
const DATA_PATH = new URL('../docs/data/releases.json', import.meta.url)
const REPO_DIR = fileURLToPath(new URL('..', import.meta.url))
const SITE_URL = 'https://georgeryang.github.io/new-music-radar/'

const readPrefs = () => JSON.parse(readFileSync(PREFS_PATH, 'utf8'))

// Newest US release date per artist id, written by the nightly fetch —
// drives the dormancy hints on preferred-artist chips.
const ACTIVITY_PATH = new URL('../config/artist-activity.json', import.meta.url)
const readActivity = () => {
  try {
    return JSON.parse(readFileSync(ACTIVITY_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const isName = (s) => typeof s === 'string' && s.trim().length > 0 && s.length < 200
// Artist entries must be {name, id} in both lists — the Apple picker pins the
// exact artist by ID; the fetcher sweeps preferred and blocks blocked by ID
// only. Genres are plain strings.
const isPinnedArtistList = (v) =>
  Array.isArray(v) && v.every((e) => e && isName(e.name) && Number.isInteger(e.id))
const isStringList = (v) => Array.isArray(v) && v.every(isName)
// Playlists are {name, url} where url is an Apple Music playlist page —
// the nightly fetch scrapes exactly these pages, so the shape is enforced.
const isPlaylistList = (v) =>
  Array.isArray(v) &&
  v.every(
    (e) =>
      e && isName(e.name) && typeof e.url === 'string' &&
      /^https:\/\/music\.apple\.com\/[a-z]{2}\/playlist\/[^/]+\/pl\./.test(e.url)
  )

// "Save & Refresh" — spawns update.sh DETACHED, appending to the same log
// launchd uses, with a pidfile for liveness. Detached means quitting this
// server (or closing its Terminal window) cannot kill a running refresh.
const REFRESH_LOG = `${process.env.HOME}/Library/Logs/new-music-radar.log`
// Not /tmp: world-writable there, so another local user could plant a pidfile
// and block refreshes.
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
      // the only cross-origin endpoint, and it exposes nothing.
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
      return res.end()
    }
    // Everything else is same-origin only: Host must be this server (a DNS-
    // rebound hostname fails this), and any Origin must be ours — a foreign
    // page can fire no-preflight POSTs at localhost, and without this check
    // it could rewrite the preference lists or trigger refresh/git-push.
    if (!HOSTS.has(req.headers.host) || (req.headers.origin && !ORIGINS.has(req.headers.origin))) {
      return json(res, 403, { error: 'forbidden' })
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    } else if (req.method === 'GET' && url.pathname === '/api/prefs') {
      const p = readPrefs()
      let seen = []
      try {
        const releases = JSON.parse(readFileSync(DATA_PATH, 'utf8')).releases ?? []
        seen = [...new Set(releases.map((r) => r.genre).filter(Boolean))]
      } catch {}
      json(res, 200, {
        artists: p.artists,
        genres: p.genres,
        playlists: p.discovery?.playlists ?? [],
        activity: readActivity(),
        genreOptions: [...new Set([...CANON_TAGS, ...seen])].sort((a, b) => a.localeCompare(b)),
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
        !isPinnedArtistList(incoming?.artists?.preferred) || !isPinnedArtistList(incoming?.artists?.blocked) ||
        !isStringList(incoming?.genres?.preferred) ||
        !isPlaylistList(incoming?.discovery?.playlists)
      ) return json(res, 400, { error: 'invalid list shape' })
      const p = readPrefs() // preserve _comment, anything else
      p.artists.preferred = incoming.artists.preferred
      p.artists.blocked = incoming.artists.blocked
      p.genres = { ...p.genres, preferred: incoming.genres.preferred }
      p.discovery = { ...p.discovery, playlists: incoming.discovery.playlists }
      writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2) + '\n')
      json(res, 200, { ok: true })
    } else if (req.method === 'GET' && url.pathname === '/api/artist-search') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 100)
      if (q.trim().length < 2) return json(res, 200, { results: [] })
      // Apple Music catalog — the same catalog the fetcher queries, so the
      // picked artist ID is exactly what the nightly lookup uses.
      const upstream = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=musicArtist&country=US&limit=6`,
        { headers: { 'User-Agent': 'new-music-radar/1.0' } }
      )
      const data = await upstream.json()
      json(res, 200, {
        results: (data.results ?? []).map((a) => ({
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
<title>New Music Radar — Preferences</title>
<style>
  :root { color-scheme: light dark; --border: #d4d4d8; --muted: #71717a; --chip: #f4f4f5; --accent: #18181b; }
  @media (prefers-color-scheme: dark) { :root { --border: #3f3f46; --muted: #a1a1aa; --chip: #27272a; --accent: #fafafa; } }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px 16px 96px; }
  header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
  h1 { font-size: 18px; }
  header a { font-size: 13px; color: var(--muted); }
  .hint { font-size: 12.5px; color: var(--muted); margin-bottom: 18px; }
  h2 { font-size: 13px; margin: 18px 0 8px; }
  h2 small { color: var(--muted); font-weight: 400; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; background: var(--chip); border: 1px solid var(--border); border-radius: 99px; padding: 3px 10px; font-size: 13px; }
  .chip button { border: 0; background: none; cursor: pointer; color: var(--muted); font-size: 13px; padding: 0; line-height: 1; }
  .chip button:hover { color: #dc2626; }
  .adder { position: relative; display: flex; gap: 6px; }
  input { flex: 1; font: inherit; font-size: 13px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; }
  .results { position: absolute; top: 34px; left: 0; right: 0; z-index: 10; background: Canvas; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,.12); }
  .results button { display: flex; width: 100%; align-items: center; gap: 10px; padding: 7px 10px; border: 0; background: none; cursor: pointer; font: inherit; font-size: 13px; text-align: left; color: inherit; }
  .results button:hover { background: var(--chip); }
  .results .genre { margin-left: auto; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
  .results a { color: var(--muted); text-decoration: none; padding: 0 6px; font-size: 14px; }
  .results a:hover { color: inherit; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; background: Canvas; border-top: 1px solid var(--border); padding: 10px 16px; display: flex; gap: 8px; align-items: center; justify-content: center; }
  footer .status { font-size: 12px; color: var(--muted); margin-right: auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #banner { position: fixed; bottom: 56px; left: 0; right: 0; text-align: center; font-size: 13px; padding: 9px 16px; }
  #log { position: fixed; bottom: 92px; left: 50%; transform: translateX(-50%); width: min(640px, calc(100% - 32px)); max-height: 180px; overflow-y: auto; background: var(--chip); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font: 11px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }
  #banner.running { background: #fef3c7; color: #78350f; }
  #banner.ok { background: #dcfce7; color: #14532d; }
  #banner.bad { background: #fee2e2; color: #7f1d1d; }
  @keyframes pulse { 50% { opacity: .55; } }
  #banner.running .dot { display: inline-block; animation: pulse 1.2s infinite; }
  button.btn { font: inherit; font-size: 13px; padding: 7px 16px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: inherit; cursor: pointer; }
  button.btn.primary { background: var(--accent); color: Canvas; border-color: var(--accent); }
  button.btn:disabled { opacity: .45; cursor: default; }
</style>
</head>
<body>
<header><h1>Preferences</h1><a href="" id="site-link" target="_blank" rel="noopener noreferrer">Open radar →</a></header>
<p class="hint">Edits config/preferences.json. Save keeps changes for tonight's automatic update; Save &amp; Refresh applies them right away (about two minutes).</p>
<div id="sections"></div>
<datalist id="genre-dl"></datalist>
<pre id="log" hidden></pre>
<div id="banner" hidden></div>
<footer>
  <span class="status" id="status"></span>
  <button class="btn" id="quit">Quit</button>
  <button class="btn" id="save" disabled>Save</button>
  <button class="btn primary" id="refresh">Save &amp; Refresh</button>
</footer>
<script>
let prefs, activity = {}, dirty = false
const $ = (id) => document.getElementById(id)
// artist entries are {name, id} (picker-pinned; the server rejects anything
// else); genres are plain strings; playlists are {name, url}
const nameOf = (e) => (typeof e === 'string' ? e : e.name)
const SECTIONS = [
  { key: 'artists.preferred', label: 'Preferred artists', sub: 'pinned first ★, fetched by Apple ID, bypass filters', artist: true, requireId: true },
  { key: 'artists.blocked', label: 'Blocked artists', sub: 'never shown (matched by Apple ID)', artist: true, requireId: true },
  { key: 'genres.preferred', label: 'Preferred genres', sub: 'discovery only surfaces these (preferred artists always show)', artist: false },
  { key: 'discovery.playlists', label: 'Discovery playlists', sub: 'Apple Music playlists scanned nightly for day-of releases', playlist: true },
]
const getList = (key) => key.split('.').reduce((o, k) => o[k], prefs)

function markDirty() { dirty = true; $('save').disabled = false }

function renderAll() {
  const root = $('sections')
  root.replaceChildren()
  for (const s of SECTIONS) {
    // Lists stay alphabetical (also in the saved file). Safe: the fetcher only
    // does membership checks — list order never affects the releases page.
    getList(s.key).sort((a, b) =>
      nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase())
    )
    const h = document.createElement('h2')
    h.textContent = s.label + ' '
    const small = document.createElement('small')
    small.textContent = '· ' + s.sub
    h.appendChild(small)
    const chips = document.createElement('div')
    chips.className = 'chips'
    for (const entry of getList(s.key)) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.appendChild(document.createTextNode(nameOf(entry)))
      if (typeof entry !== 'string') chip.title = entry.url ?? 'Apple Music artist #' + entry.id
      // Dormancy hint: an artist with no release in 18+ months is a prune
      // candidate — fetch time no longer depends on list size, so this is
      // curation, not performance.
      const last = s.key === 'artists.preferred' && entry.id ? activity[entry.id] : null
      if (last && Date.now() - Date.parse(last) > 18 * 2629746000) {
        const months = Math.round((Date.now() - Date.parse(last)) / 2629746000)
        const ago = document.createElement('span')
        ago.style.color = 'var(--muted)'
        ago.style.fontSize = '11px'
        ago.textContent = '· ' + (months >= 24 ? Math.floor(months / 12) + 'y' : months + 'mo')
        ago.title = 'Last release ' + last
        chip.appendChild(ago)
      }
      const x = document.createElement('button')
      x.textContent = '×'
      x.title = 'Remove'
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
  wrap.className = 'adder'
  const input = document.createElement('input')
  input.placeholder = s.requireId
    ? 'Add artist (search Apple Music and pick from the list)…'
    : s.artist
      ? 'Add artist (search Apple Music, or press Enter for exact text)…'
      : s.playlist ? 'Paste an Apple Music playlist URL and press Enter…' : 'Add genre…'
  if (!s.artist && !s.playlist) input.setAttribute('list', 'genre-dl')
  const results = document.createElement('div')
  results.className = 'results'
  results.hidden = true
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    if (s.requireId) {
      // free-text entries have no Apple ID — the fetcher can't sweep them
      $('status').textContent = 'Pick an artist from the search list (entries are pinned by Apple ID).'
      return
    }
    if (s.playlist) {
      // https://music.apple.com/us/playlist/<slug>/pl.<id> — name from slug
      const u = input.value.trim()
      const parts = u.split('/')
      if (!(u.startsWith('https://music.apple.com/') && parts[4] === 'playlist' && (parts[6] ?? '').startsWith('pl.'))) {
        $('status').textContent = 'Not an Apple Music playlist URL.'
        return
      }
      const name = parts[5].replace(/-/g, ' ').replace(/\\b\\w/g, (c) => c.toUpperCase())
      addTo(s.key, { name, url: u })
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
          const nm = document.createElement('span')
          nm.textContent = a.name
          const genre = document.createElement('span')
          genre.className = 'genre'
          genre.textContent = a.genre
          b.append(nm, genre)
          if (a.url) {
            // verify the identity on its Apple Music page before adding
            const verify = document.createElement('a')
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
  } else {
    input.onchange = () => { if (input.value.trim()) { addTo(s.key, input.value); input.value = '' } }
  }
  wrap.append(input, results)
  return wrap
}

let wasRunning = false
function setBanner(cls, text) {
  const b = $('banner')
  b.hidden = !cls
  b.className = cls ?? ''
  b.replaceChildren()
  if (cls === 'running') {
    const dot = document.createElement('span')
    dot.className = 'dot'
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
    $('log').hidden = !st.running
    if (st.running) {
      $('log').textContent = st.log.join('\\n')
      $('log').scrollTop = $('log').scrollHeight
      setBanner('running', 'Refreshing, about two minutes. Live progress above; safe to close this page, the refresh continues in the background.')
    } else if (wasRunning) {
      const ok = st.log.some((l) => /Published|No changes/.test(l))
      setBanner(ok ? 'ok' : 'bad', ok
        ? 'Refresh complete. The site shows the new data within a minute.'
        : 'Refresh finished with errors. Check ~/Library/Logs/new-music-radar.log.')
    }
    wasRunning = st.running
  }
  setTimeout(poll, st?.running ? 2000 : 10000)
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
  poll()
}
$('quit').onclick = async () => { await fetch('/api/quit', { method: 'POST' }); document.body.innerHTML = '<p style="padding:40px;text-align:center">Server stopped — you can close this tab.</p>' }
window.onbeforeunload = () => (dirty ? true : undefined)

fetch('/api/prefs').then((r) => r.json()).then((p) => {
  prefs = { artists: p.artists, genres: p.genres, discovery: { playlists: p.playlists ?? [] } }
  activity = p.activity ?? {}
  $('site-link').href = p.siteUrl
  for (const g of p.genreOptions) {
    const o = document.createElement('option')
    o.value = g
    document.getElementById('genre-dl').appendChild(o)
  }
  renderAll()
  poll()
})
</script>
</body>
</html>`

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Preferences editor: http://localhost:${PORT}`)
})
