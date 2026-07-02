#!/usr/bin/env node
// Local preferences editor for config/preferences.json — the file that drives
// the nightly fetch (preferred artists get discography checks + pinning,
// blocked artists/genres are dropped). Zero deps; launched by prefs.command.
//
// Binds 127.0.0.1 only. Writes exactly one hardcoded path (the config file),
// preserving keys the UI doesn't manage (_comment, editorials). The Deezer
// artist search is proxied so the browser never talks to a third party.

import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PORT = 4747
const PREFS_PATH = new URL('../config/preferences.json', import.meta.url)
const DATA_PATH = new URL('../docs/data/releases.json', import.meta.url)
const REPO_DIR = fileURLToPath(new URL('..', import.meta.url))
const SITE_URL = 'https://georgeryang.github.io/new-music-radar/'

// Mirrors GENRE_MAP in fetch-releases.mjs — the tags the fetcher can assign.
const CANON_TAGS = [
  'K-pop', 'C-pop', 'J-pop', 'OPM', 'V-pop', 'Thai pop', 'Afrobeats', 'R&B',
  'Latin', 'Dance', 'Hip-Hop', 'Alternative', 'Rock', 'Country', 'OST', 'Pop',
]

const readPrefs = () => JSON.parse(readFileSync(PREFS_PATH, 'utf8'))

const isName = (s) => typeof s === 'string' && s.trim().length > 0 && s.length < 200
// Artist entries: "Name" (hand-typed) or {name, id} (Deezer picker — the id
// pins the exact artist among same-named ones). Genres are plain strings.
const isArtistList = (v) =>
  Array.isArray(v) && v.every((e) => isName(e) || (e && isName(e.name) && Number.isInteger(e.id)))
const isStringList = (v) => Array.isArray(v) && v.every(isName)

// "Refresh now" — one update.sh child at a time, log tail kept in memory
let refreshProc = null
let refreshLog = []
function startRefresh() {
  if (refreshProc) return false
  refreshLog = []
  const child = spawn('bash', ['scripts/update.sh'], { cwd: REPO_DIR })
  const capture = (chunk) => {
    refreshLog.push(...chunk.toString().split('\n').filter(Boolean))
    refreshLog = refreshLog.slice(-40)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.on('close', (code) => {
    refreshLog.push(`— finished (exit ${code}) —`)
    refreshProc = null
  })
  refreshProc = child
  return true
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    } else if (req.method === 'GET' && url.pathname === '/api/ping') {
      // The deployed site pings this to decide whether to show its ⚙ link —
      // the only endpoint with CORS, and it exposes nothing.
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
      res.end()
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
        genreOptions: [...new Set([...CANON_TAGS, ...seen])],
        siteUrl: SITE_URL,
      })
    } else if (req.method === 'POST' && url.pathname === '/api/prefs') {
      let body = ''
      for await (const chunk of req) body += chunk
      const incoming = JSON.parse(body)
      if (
        !isArtistList(incoming?.artists?.preferred) || !isArtistList(incoming?.artists?.blocked) ||
        !isStringList(incoming?.genres?.preferred) || !isStringList(incoming?.genres?.blocked)
      ) return json(res, 400, { error: 'invalid list shape' })
      const p = readPrefs() // preserve _comment, editorials, anything else
      p.artists.preferred = incoming.artists.preferred
      p.artists.blocked = incoming.artists.blocked
      p.genres.preferred = incoming.genres.preferred
      p.genres.blocked = incoming.genres.blocked
      writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2) + '\n')
      json(res, 200, { ok: true })
    } else if (req.method === 'GET' && url.pathname === '/api/artist-search') {
      const q = url.searchParams.get('q') ?? ''
      if (q.trim().length < 2) return json(res, 200, { results: [] })
      const upstream = await fetch(
        `https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=5`,
        { headers: { 'User-Agent': 'new-music-radar/1.0' } }
      )
      const data = await upstream.json()
      json(res, 200, {
        results: (data.data ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          picture: a.picture_small ?? '',
          fans: a.nb_fan ?? 0,
        })),
      })
    } else if (req.method === 'POST' && url.pathname === '/api/refresh') {
      json(res, startRefresh() ? 200 : 409, { running: true })
    } else if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, { running: !!refreshProc, log: refreshLog.slice(-12) })
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
  .results img { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; background: var(--chip); }
  .results .fans { margin-left: auto; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; background: Canvas; border-top: 1px solid var(--border); padding: 10px 16px; display: flex; gap: 8px; align-items: center; justify-content: center; }
  footer .status { font-size: 12px; color: var(--muted); margin-right: auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #banner { position: fixed; bottom: 56px; left: 0; right: 0; text-align: center; font-size: 13px; padding: 9px 16px; }
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
<p class="hint">Edits config/preferences.json. Save keeps changes for tonight's fetch; Refresh now saves and fetches immediately (~5–10 min).</p>
<div id="sections"></div>
<datalist id="genre-dl"></datalist>
<div id="banner" hidden></div>
<footer>
  <span class="status" id="status"></span>
  <button class="btn" id="quit">Quit</button>
  <button class="btn" id="save" disabled>Save</button>
  <button class="btn primary" id="refresh">Save &amp; Refresh</button>
</footer>
<script>
let prefs, dirty = false
const $ = (id) => document.getElementById(id)
// artist entries are "Name" or {name, id}; genres are plain strings
const nameOf = (e) => (typeof e === 'string' ? e : e.name)
const SECTIONS = [
  { key: 'artists.preferred', label: 'Preferred artists', sub: 'pinned first ★, fetched directly, bypass filters', artist: true },
  { key: 'artists.blocked', label: 'Blocked artists', sub: 'never shown', artist: true },
  { key: 'genres.preferred', label: 'Preferred genres', sub: 'sort above neutral, bypass the noise gate', artist: false },
  { key: 'genres.blocked', label: 'Blocked genres', sub: 'never shown', artist: false },
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
    small.textContent = '— ' + s.sub
    h.appendChild(small)
    const chips = document.createElement('div')
    chips.className = 'chips'
    for (const entry of getList(s.key)) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.appendChild(document.createTextNode(nameOf(entry)))
      if (typeof entry !== 'string') chip.title = 'Deezer artist #' + entry.id
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
  list.push(typeof item === 'string' ? name : { name, id: item.id })
  markDirty(); renderAll()
}

function makeAdder(s) {
  const wrap = document.createElement('div')
  wrap.className = 'adder'
  const input = document.createElement('input')
  input.placeholder = s.artist ? 'Add artist (search Deezer or press Enter for exact text)…' : 'Add genre…'
  if (!s.artist) input.setAttribute('list', 'genre-dl')
  const results = document.createElement('div')
  results.className = 'results'
  results.hidden = true
  input.onkeydown = (e) => { if (e.key === 'Enter') { addTo(s.key, input.value); input.value = ''; results.hidden = true } }
  if (s.artist) {
    let timer
    input.oninput = () => {
      clearTimeout(timer)
      const q = input.value
      if (q.trim().length < 2) { results.hidden = true; return }
      timer = setTimeout(async () => {
        const r = await fetch('/api/artist-search?q=' + encodeURIComponent(q)).then((r) => r.json())
        results.replaceChildren()
        for (const a of r.results) {
          const b = document.createElement('button')
          const img = document.createElement('img')
          img.src = a.picture; img.alt = ''
          const nm = document.createElement('span')
          nm.textContent = a.name
          const fans = document.createElement('span')
          fans.className = 'fans'
          fans.textContent = a.fans.toLocaleString() + ' fans'
          b.append(img, nm, fans)
          b.onclick = () => { addTo(s.key, { name: a.name, id: a.id }); input.value = ''; results.hidden = true }
          results.appendChild(b)
        }
        results.hidden = r.results.length === 0
      }, 300)
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
    $('quit').disabled = st.running // refresh runs inside this server — quitting would kill it
    $('status').textContent = st.log.at(-1) ?? ''
    $('status').title = st.log.join('\\n')
    if (st.running) {
      setBanner('running', 'Refreshing — takes a few minutes. Keep this window and its Terminal open; Quit is disabled until it finishes.')
    } else if (wasRunning) {
      const ok = st.log.some((l) => l.includes('exit 0'))
      setBanner(ok ? 'ok' : 'bad', ok
        ? 'Refresh complete — the site shows the new data within a minute.'
        : 'Refresh finished with errors — hover the status text for the log.')
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
window.onbeforeunload = () => (dirty || wasRunning ? true : undefined)

fetch('/api/prefs').then((r) => r.json()).then((p) => {
  prefs = { artists: p.artists, genres: p.genres }
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
