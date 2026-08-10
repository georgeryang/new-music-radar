#!/usr/bin/env node
// Local preferences editor for config/preferences.json (the file that drives
// the nightly fetch). Zero deps; launched by prefs.command.
//
// Loopback-only, with the Host/Origin gate enforced at the routes below. Writes
// exactly one hardcoded path, preserving keys the UI doesn't manage (_comment).
// The Apple Music artist search is proxied so the browser never talks to a third
// party. Also serves the built site from docs/ at /new-music-radar/ ("Open radar").

import http from 'node:http'
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, normalize } from 'node:path'
import { GENRE_OPTIONS } from './genre-options.mjs'
import { STOREFRONTS, STREAMING_ONLY } from './storefronts.mjs'
import { ACTIVITY_PATH, DATA_PATH, GENRE_FEEDS, PREFS_PATH, REFRESH_LOG, REFRESH_PIDFILE, SOURCE_ACTIVITY_PATH, SOURCE_CHIP_DAYS, SOURCE_THIN_DAYS, UA, WINDOW_DAYS, feedTypesOf, sourceTag, sourceWindow, windowIndices } from './shared.mjs'

const PORT = 4747
const REPO_DIR = fileURLToPath(new URL('..', import.meta.url))
// "Open radar" serves docs/ from this server, so the local copy shows fresh
// data the moment a refresh writes it, without waiting for the Pages deploy.
const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url))
// Symlink-resolved prefix (trailing / so a sibling like docs-evil/ can't pass
// a startsWith check); the static handler re-checks realpaths against this.
const DOCS_REAL = realpathSync(DOCS_DIR) + '/'
const SITE_PATH = '/new-music-radar/'
// 127.0.0.1 everywhere the URL is handed out (prefs.command, the app's ⚙
// link, this): one spelling, and it matches the bind address exactly.
const SITE_URL = `http://127.0.0.1:${PORT}${SITE_PATH}`

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
const readActivity = () => {
  try {
    return JSON.parse(readFileSync(ACTIVITY_PATH, 'utf8'))
  } catch (e) {
    // absent before the first fetch is normal; unreadable drops every dormancy
    // hint, and a missing age reads as "recently active" — say so rather than
    // silently advising against pruning
    if (e.code !== 'ENOENT') console.error(`could not read artist-activity.json (${e.message}) — dormancy hints unavailable`)
    return {}
  }
}

const isName = (s) => typeof s === 'string' && s.trim().length > 0 && s.length < 200
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

function refreshPid() {
  let pid
  try {
    pid = parseInt(readFileSync(REFRESH_PIDFILE, 'utf8'), 10)
    process.kill(pid, 0) // liveness probe, no signal sent
    return pid
  } catch (e) {
    // Clear a pidfile whose process is gone. Without this a crashed refresh
    // leaves the button disabled with no way out of the UI; ESRCH means the
    // pid is dead, EPERM means it was recycled by another user's process.
    if (pid !== undefined && (e.code === 'ESRCH' || e.code === 'EPERM')) {
      try { unlinkSync(REFRESH_PIDFILE) } catch {}
    }
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
  writeFileSync(REFRESH_PIDFILE, String(child.pid))
  child.unref()
  closeSync(fd)
  return true
}

// Tail only. The page polls this every 2s during a refresh and every 10s while
// idle, for as long as it stays open, and update.sh lets the shared log reach
// 1MB before trimming — reading the whole file per poll scales with the log.
// 8KB comfortably holds the lines the page shows (the longest observed line is
// under 400 chars).
const TAIL_BYTES = 8192
function logTail(lines) {
  let fd
  try {
    fd = openSync(REFRESH_LOG, 'r')
    const { size } = fstatSync(fd)
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    // use the byte count actually read: update.sh truncates this log in place,
    // so a poll landing mid-truncation would otherwise render the unwritten
    // remainder of the buffer as NUL padding on the last line
    const n = readSync(fd, buf, 0, buf.length, start)
    const all = buf.subarray(0, n).toString('utf8').split('\n').filter(Boolean)
    // drop the first entry when we started mid-file: it is a partial line, and
    // slicing mid-character would leave a mojibake fragment
    if (start > 0) all.shift()
    return all.slice(-lines)
  } catch {
    // a sentinel, not []: an empty array renders as a blank progress box with
    // no hint that the log itself is the problem
    return ['(progress log unavailable)']
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// The Host/Origin gate below cannot see a framing attempt: a frame navigation
// carries a passing Host, no Origin, and same-origin clicks.
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // artist-verify and "Open radar" open Apple in a new tab, which otherwise
  // carries a Referer naming this local editor
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
}

function json(res, code, body) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  woff2: 'font/woff2',
}

// hasOwn, not a bare lookup: a file named "x.constructor" would otherwise
// resolve to a function and make writeHead throw, 500-ing a readable file.
const mimeOf = (file) => {
  const ext = file.split('.').pop()
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : 'application/octet-stream'
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
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      // No built CSS = unstyled but fully functional (every control is
      // semantic HTML); only happens in a broken clone.
      const href = cssHref()
      res.end(PAGE.replace('<!--CSS-->', href ? `<link rel="stylesheet" href="${href}">` : ''))
    } else if (req.method === 'GET' && url.pathname === '/api/prefs') {
      const p = readPrefs()
      // Per-genre and per-source yield of the latest fetch, for the chip markers.
      // Only non-followed releases count, for the reason fetch-releases.mjs gives
      // where it writes the tally. sourceCounts is keyed by the fetcher's sources
      // tags (country:<code>, playlist:<name>).
      const genreCounts = {}
      // An unreadable data file must report null, never zeros (see genreCount).
      let countsAvailable = true
      try {
        for (const r of JSON.parse(readFileSync(DATA_PATH, 'utf8')).releases ?? []) {
          if (r.followed) continue
          if (r.genre) {
            const k = r.genre.toLowerCase()
            genreCounts[k] = (genreCounts[k] ?? 0) + 1
          }
        }
      } catch {
        countsAvailable = false
      }

      // Source yield over a window, from the fetcher's rolling tally rather than
      // the latest file. sourceWindow (shared with the audit) skips failed days.
      const sourceCounts = {}
      let historyDays = 0
      try {
        const h = JSON.parse(readFileSync(SOURCE_ACTIVITY_PATH, 'utf8'))
        historyDays = (h.days ?? []).length
        const idx = windowIndices(h, SOURCE_CHIP_DAYS)
        for (const tag of Object.keys(h.sources ?? {})) sourceCounts[tag] = sourceWindow(h, tag, idx)
      } catch (e) {
        // Absent before the first fetch is normal. Unreadable after months of
        // nightly writes would present as "still collecting", so say it out loud.
        if (e.code !== 'ENOENT') console.error(`could not read source-activity.json (${e.message}) — chips say "collecting"`)
      }
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
        countsAvailable,
        historyDays,
        countryNames: STOREFRONTS,
        streamingOnly: [...STREAMING_ONLY],
        // the always-scanned sources, so the editor can audit them like the
        // editable lists. Order matches the fetcher's.
        alwaysScanned: [
          { label: 'US most-played chart', tag: sourceTag('chart', 'us'), sub: 'albums' },
          ...GENRE_FEEDS.map((f) => ({
            label: f.tag,
            tag: sourceTag('genre', f.tag),
            sub: feedTypesOf(f).join(' + '),
          })),
        ],
      })
    } else if (req.method === 'POST' && url.pathname === '/api/prefs') {
      // Buffers, not string concat: a multibyte name straddling a chunk boundary
      // decodes to U+FFFD on both sides, and the result is written straight to
      // preferences.json. CJK artist names make that a real corruption path.
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1_000_000) return json(res, 413, { error: 'body too large' })
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks).toString('utf8')
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
      p.artists = { ...p.artists, followed: incoming.artists.followed, blocked: incoming.artists.blocked }
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
      // Same 30s abort the fetcher uses: a stalled iTunes connection would
      // otherwise hang this request, and the editor's dropdown with it.
      const upstream = await fetch(
        id
          ? `https://itunes.apple.com/lookup?id=${id}&country=US`
          : `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=musicArtist&country=US&limit=6`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) }
      )
      if (!upstream.ok) throw new Error(`iTunes search failed (HTTP ${upstream.status})`)
      const data = await upstream.json()
      json(res, 200, {
        // wrapperType filter: a lookup id for a song/album would otherwise
        // return as a picker entry credited to its artist
        results: (data.results ?? []).filter((a) => a.wrapperType === 'artist').map((a) => ({
          id: a.artistId,
          name: a.artistName,
          genre: a.primaryGenreName ?? '',
          // scheme-checked like the fetcher's appleLink: this becomes an href
          // in a page that can rewrite preferences.json and trigger a push
          url: /^https:\/\/(music|itunes)\.apple\.com\//.test(a.artistLinkUrl ?? '') ? a.artistLinkUrl : '',
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
      // 308, not 302: the trailing slash is permanent, and 308 keeps the method
      res.writeHead(308, { ...SECURITY_HEADERS, Location: SITE_PATH })
      res.end()
    } else if (req.method === 'GET' && url.pathname.startsWith(SITE_PATH)) {
      const rel = url.pathname.slice(SITE_PATH.length) || 'index.html'
      const file = join(DOCS_DIR, normalize(rel))
      if (!file.startsWith(DOCS_DIR)) return json(res, 403, { error: 'forbidden' })
      try {
        // realpath re-check: the lexical check above can't see a symlink
        // inside docs/ pointing elsewhere
        if (!realpathSync(file).startsWith(DOCS_REAL)) {
          return json(res, 403, { error: 'forbidden' })
        }
        const body = readFileSync(file)
        // assets/ only: it carries a content hash, so it can be cached hard.
        // fonts/ is re-copied under a stable name by every build, so pinning it
        // for a year would strand a replaced subset in the browser; docs/data
        // changes after every fetch and index.html points at the current bundle.
        const hashed = /^assets\//.test(normalize(rel))
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': mimeOf(file),
          'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        })
        res.end(body)
      } catch {
        json(res, 404, { error: 'not found' })
      }
    } else {
      json(res, 404, { error: 'not found' })
    }
  } catch (e) {
    // Also to the terminal prefs.command opened: the browser gets one line, and
    // a parse failure in preferences.json is worth a stack somewhere.
    console.error(`${req.method} ${url.pathname} failed:`, e)
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
<header class="mb-1 flex items-baseline justify-between"><h1 class="text-lg font-bold">Preferences</h1><a href="${SITE_URL}" id="site-link" target="_blank" rel="noopener noreferrer" class="text-[13px] text-muted-foreground hover:text-foreground">Open radar →</a></header>
<!-- header outside main: it is a banner landmark only while it is not a
     descendant of main -->
<main>
<p class="mb-[18px] text-[12.5px] text-muted-foreground">Edits config/preferences.json. Save keeps changes for tonight's automatic update; Save &amp; Refresh applies them right away and publishes to the public site (about two minutes). Genre chips count the last ${WINDOW_DAYS} days, so they run higher than New, which shows 24 hours. Country, playlist and feed chips count ${SOURCE_CHIP_DAYS} measured days, as only-here/shared/total.</p>
<div id="sections"></div>
<div id="log-wrap" hidden class="fixed bottom-[92px] left-1/2 z-10 w-[min(640px,calc(100%-32px))] -translate-x-1/2">
  <button id="log-hide" class="absolute top-0.5 right-1 inline-flex size-6 cursor-pointer items-center justify-center text-[15px] leading-none text-muted-foreground hover:text-foreground" title="Hide the progress log (the refresh keeps running)" aria-label="Hide progress log">×</button>
  <pre id="log" class="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-muted px-3 py-2.5 pr-8 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap wrap-break-word"></pre>
</div>
<div id="banner" hidden role="status"></div>
</main>
<footer class="fixed inset-x-0 bottom-0 flex items-center justify-center gap-2 border-t border-border bg-background px-4 py-2.5">
  <span id="status" role="status" class="mr-auto max-w-[50%] text-xs leading-snug text-muted-foreground"></span>
  <button id="quit" class="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-[7px] text-[13px]">Quit</button>
  <button id="save" disabled class="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-[7px] text-[13px] disabled:cursor-default disabled:opacity-45">Save</button>
  <button id="refresh" class="cursor-pointer rounded-lg border border-primary bg-primary px-4 py-[7px] text-[13px] text-primary-foreground disabled:cursor-default disabled:opacity-45">Save &amp; Refresh</button>
</footer>
<script>
let prefs, activity = {}, genreOptions = [], genreCounts = {}, sourceCounts = {}, countryNames = {}, dirty = false
let countsAvailable = true
let streamingOnly = new Set(), alwaysScanned = [], historyDays = 0
// display-only sort for the followed section: false = A-Z, true = oldest
// release first (dormant prune candidates cluster at the top)
let dormancySort = false
const $ = (id) => document.getElementById(id)
// Interpolated from shared.mjs's sourceTag so the wire format has exactly one
// definition; hardcoding it here is what would make every chip read 0 in silence.
const TAG_COUNTRY = '${sourceTag('country', '')}'
const TAG_PLAYLIST = '${sourceTag('playlist', '')}'
// artist entries are {name, id} (picker-pinned; the server rejects anything
// else); genres are plain strings; playlists are {name, url}
const nameOf = (e) => (typeof e === 'string' ? e : e.name)
const OFFLINE = 'Editor not responding. Reopen prefs.command.'
// Full literals, not composed strings — Tailwind scans this file as text.
// These shades clear AA at 11px on bg-muted where amber-700 and the red
// primary fall just short.
const AMBER = 'text-[11px] text-amber-800 dark:text-amber-400'
const MUTED = 'text-[11px] text-muted-foreground'
// average month; the dormancy hints are approximate by nature
const MONTH_MS = 2629746000
// Set when a message came from a user action, so the 10s poll won't overwrite
// it with the ambient log tail. Cleared by the next action.
let statusHeld = false
// truncate, not wrap: the footer is fixed at bottom-0 and the banner and log sit
// at hardcoded offsets above it, so a status line long enough to wrap covers them.
const STATUS_BASE = 'mr-auto max-w-[50%] truncate text-xs leading-snug'
function setStatus(text, isError, hold) {
  statusHeld = !!hold
  const el = $('status')
  if (!el) return
  el.textContent = text
  el.title = text ?? ''
  el.className = STATUS_BASE + (isError ? ' text-destructive' : ' text-muted-foreground')
}
// Unhidden before the write: a role=alert that is display:none at mutation time
// is out of the a11y tree, so it may not announce at all.
function setFieldError(key, text) {
  const el = $('err-' + key)
  if (!el) return
  el.hidden = !text
  el.textContent = text
  $('add-' + key)?.setAttribute('aria-invalid', text ? 'true' : 'false')
}
const clearFieldError = (key) => setFieldError(key, '')
// kind drives the placeholder AND the wiring, so adding a picker is one entry
// here plus one PICKERS row, not three parallel edits.
const SECTIONS = [
  { key: 'artists.followed', label: 'Followed artists', sub: 'pinned first ★, fetched by Apple ID, bypass filters', kind: 'artist' },
  { key: 'artists.blocked', label: 'Blocked artists', sub: 'never shown (matched by Apple ID)', kind: 'artist' },
  { key: 'genres.followed', label: 'Followed genres', sub: 'discovery only surfaces these (followed artists always show)', kind: 'genre' },
  { key: 'discovery.countries', label: 'Additional countries', sub: 'each country\\'s Top 100, plus its purchase charts where Apple runs a store', kind: 'country' },
  { key: 'discovery.playlists', label: 'Discovery playlists', sub: 'Apple Music playlists scanned nightly for day-of releases', kind: 'playlist' },
]
const getList = (key) => key.split('.').reduce((o, k) => o[k], prefs)
// country entries are bare codes; the display name comes from the server's
// verified code→name map. hasOwn so an inherited key ("constructor") doesn't
// resolve to junk.
const displayOf = (s, e) =>
  s.kind === 'country' && Object.hasOwn(countryNames, e) ? countryNames[e] : nameOf(e)

// Apple runs no purchase store in a few storefronts, so "Top 100 and purchase
// charts" is only true for most of them. Say which ones, rather than quietly
// scanning a different feed set behind an identical-looking chip.
function streamingOnlyNote() {
  const span = document.createElement('span')
  span.className = MUTED
  span.textContent = '· streaming only'
  span.title = 'Apple runs no purchase store here, so only the most-played chart is scanned'
  return span
}

// https://music.apple.com/us/playlist/<slug>/pl.<id> — display name from slug.
// The same shape isPlaylistList enforces on save: a looser test here would add a
// chip and then fail Save with an "invalid list shape" that names no entry.
const PLAYLIST_RE = /^https:\\/\\/music\\.apple\\.com\\/[a-z]{2}\\/playlist\\/([^/]+)\\/pl\\./
function parsePlaylist(u) {
  const m = PLAYLIST_RE.exec(u)
  if (!m) return null
  return { name: m[1].replace(/-/g, ' ').replace(/\\b\\w/g, (c) => c.toUpperCase()), url: u }
}

// one dropdown row, same shape for artists, playlists, and genres. The optional
// trailing element (the artist picker's ↗ link) sits BESIDE the button, never inside it:
// interactive content nested in a button is invalid, and screen readers
// flatten it into the button's name instead of exposing a link.
function resultRow(results, label, note, onPick, extra) {
  const b = document.createElement('button')
  const nm = document.createElement('span')
  nm.textContent = label
  b.appendChild(nm)
  b.className = 'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5 py-[7px] text-left text-[13px] hover:bg-muted focus-visible:bg-muted'
  if (note) {
    const n = document.createElement('span')
    n.className = 'ml-auto whitespace-nowrap text-[11.5px] text-muted-foreground'
    n.textContent = note
    b.appendChild(n)
  }
  b.onclick = onPick
  const row = document.createElement('div')
  row.className = 'flex w-full items-center'
  row.append(b)
  if (extra) row.append(extra)
  results.appendChild(row)
}

// A non-pickable dropdown row: "Searching…" and "no matches" must not look like
// something you can choose, and a hidden dropdown reads as "no matches" instead.
function noteRow(results, text) {
  const d = document.createElement('div')
  d.className = 'px-2.5 py-[7px] text-[13px] text-muted-foreground'
  d.textContent = text
  results.replaceChildren(d)
  results.hidden = false
}

// Clearing the held status too: "Saved." pins itself against the idle poll, and
// without this it stays on screen contradicting the re-enabled Save button.
function markDirty() { dirty = true; $('save').disabled = false; statusHeld = false }

// Genre yield marker: releases admitted via this genre (followed artists
// excluded). Amber 0 = prune candidate. Null when the data file was unreadable,
// because a false 0 here reads as "delete me".
function genreCount(name) {
  if (!countsAvailable) return null
  const n = genreCounts[name.toLowerCase()] ?? 0
  const span = document.createElement('span')
  span.className = n === 0 ? AMBER : MUTED
  span.textContent = '· ' + n
  span.title = 'found by the latest update via this genre'
  return span
}

// Source yield marker (countries, playlists, always-scanned feeds):
// unique/duplicate/total releases over the window. Unique = only this source
// surfaced it, which is what pruning would actually cost you.
const THIN_DAYS = ${SOURCE_THIN_DAYS}
const CHIP_DAYS = ${SOURCE_CHIP_DAYS}
function sourceCount(tag) {
  const c = sourceCounts[tag]
  const span = document.createElement('span')
  // Per source, not per file: a country added to months-old history has only its
  // own measured nights behind it.
  if (!c || c.measured < THIN_DAYS) {
    span.className = MUTED
    span.textContent = '· collecting'
    const n = c?.measured ?? 0
    span.title = historyDays < THIN_DAYS
      ? 'Needs about a week of nightly updates before this figure means anything (' + historyDays + ' nights so far)'
      : 'Only ' + n + ' measured ' + (n === 1 ? 'night' : 'nights') + ' for this source so far'
    return span
  }
  const shared = c.surfaced - c.unique
  span.className = c.surfaced === 0 ? AMBER : MUTED
  span.textContent = '· ' + (c.surfaced === 0 ? '0' : c.unique + '/' + shared + '/' + c.surfaced)
  span.title = c.surfaced === 0
    ? 'nothing across ' + c.measured + ' measured days in the last ' + CHIP_DAYS + ', worth a look'
    : c.unique + ' only here / ' + shared + ' shared / ' + c.surfaced + ' total, over ' +
      c.measured + ' measured days' + (c.last ? '; last found something on ' + c.last : '')
  return span
}

// The always-scanned feeds are code constants, not a control: nothing to add,
// remove or pick. A closed footnote keeps their yield one click from the country
// and playlist chips it gets compared against, without one more pill per fixed
// feed that looks exactly as editable as the ones above it.
let fixedOpen = false
function renderFixed() {
  const d = document.createElement('details')
  d.className = 'mt-[18px]'
  d.open = fixedOpen
  // renderAll rebuilds this node on every edit, so the open state has to live
  // outside it or the panel snaps shut mid-edit.
  d.ontoggle = () => { fixedOpen = d.open }
  const sum = document.createElement('summary')
  sum.className = 'cursor-pointer text-[12.5px] text-muted-foreground hover:text-foreground'
  sum.textContent = 'Always scanned · ' + alwaysScanned.length + ' · US charts and genre feeds, fixed in code'
  const list = document.createElement('ul')
  list.className = 'mt-2 ml-4 text-[12.5px] leading-[1.5] text-muted-foreground'
  for (const e of alwaysScanned) {
    const li = document.createElement('li')
    li.appendChild(document.createTextNode(e.label + ' (' + e.sub + ') '))
    li.appendChild(sourceCount(e.tag))
    list.appendChild(li)
  }
  d.append(sum, list)
  return d
}

function renderAll() {
  const root = $('sections')
  root.replaceChildren()
  // A standing condition, so it lives here rather than in #status, which the
  // idle poll overwrites with the log tail every 10s.
  if (!countsAvailable) {
    const warn = document.createElement('p')
    warn.className = 'mb-2 text-[12.5px] text-amber-800 dark:text-amber-400'
    warn.textContent = 'Could not read the latest results, so the genre chip counts are hidden. Press Save & Refresh to rebuild them.'
    root.appendChild(warn)
  }
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
      sort.setAttribute('aria-pressed', String(dormancySort))
      sort.id = 'sort-followed'
      sort.onclick = () => {
        dormancySort = !dormancySort
        renderAll()
        $('sort-followed')?.focus() // renderAll replaced this very button
      }
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
    for (const entry of entries) {
      const chip = document.createElement('span')
      chip.className = 'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-[3px] text-[13px]'
      chip.appendChild(document.createTextNode(displayOf(s, entry)))
      if (s.kind === 'country') {
        const code = document.createElement('span')
        code.className = 'text-[11px] text-muted-foreground'
        code.textContent = '· ' + entry
        chip.appendChild(code)
        if (streamingOnly.has(entry)) chip.appendChild(streamingOnlyNote())
        chip.appendChild(sourceCount(TAG_COUNTRY + entry))
      }
      if (s.kind === 'playlist') chip.appendChild(sourceCount(TAG_PLAYLIST + nameOf(entry)))
      if (s.key === 'genres.followed') {
        const c = genreCount(nameOf(entry))
        if (c) chip.appendChild(c)
      }
      if (typeof entry !== 'string') chip.title = entry.url ?? 'Apple Music artist #' + entry.id
      // Dormancy hint: an artist with no release in 18+ months is a prune
      // candidate. Mostly curation: the sweep batches BATCH_SIZE artists per
      // paced call, so cost only moves when a removal crosses a batch boundary.
      const last = s.key === 'artists.followed' && entry.id ? activity[entry.id] : null
      if (last && Date.now() - Date.parse(last) > 18 * MONTH_MS) {
        const months = Math.round((Date.now() - Date.parse(last)) / MONTH_MS)
        const ago = document.createElement('span')
        ago.className = months >= 36 ? 'text-[11px] text-accent-foreground' : AMBER
        // round, not floor — floor showed a 3.9y gap as "3y"
        ago.textContent = '· ' + (months >= 24 ? Math.round(months / 12) + 'y' : months + 'mo')
        ago.title = 'Last release ' + last
        chip.appendChild(ago)
      }
      const x = document.createElement('button')
      // size-6 for a 24x24 target on the only destructive control here; the
      // negative margins spend the chip's own padding rather than widening it.
      x.className = 'inline-flex size-6 cursor-pointer items-center justify-center -my-1 -mr-1.5 text-[13px] leading-none text-muted-foreground hover:text-destructive'
      x.textContent = '×'
      x.title = 'Remove'
      x.setAttribute('aria-label', 'Remove ' + displayOf(s, entry))
      x.onclick = () => {
        const l = getList(s.key); l.splice(l.indexOf(entry), 1); markDirty(); renderAll()
        $('add-' + s.key)?.focus() // renderAll replaced every node; don't strand focus on <body>
      }
      chip.appendChild(x)
      chips.appendChild(chip)
    }
    root.append(h, chips, makeAdder(s))
  }
  root.append(renderFixed())
}

function addTo(key, item) {
  const list = getList(key)
  const name = nameOf(item).trim()
  if (!name) return
  const section = SECTIONS.find((s) => s.key === key)
  const displayName = section ? displayOf(section, typeof item === 'string' ? name : item) : name
  // Identity is the Apple ID where there is one: two artists can share a name,
  // and re-adding a same-named artist is the documented fix for a wrong pick.
  const dupe = item.id != null
    ? list.some((e) => e.id === item.id)
    : list.some((e) => nameOf(e).toLowerCase() === name.toLowerCase())
  if (dupe) {
    setFieldError(key, displayName + ' is already in ' + (section?.label ?? key) + '.')
    return
  }
  list.push(typeof item === 'string' ? name : { ...item, name })
  markDirty(); renderAll()
  // renderAll rebuilds the inputs, so keyboard focus has to be put back
  $('add-' + key)?.focus()
}

// Dropdown keyboard + focus, shared by all four pickers. Hiding keys on focus
// leaving the WRAPPER, not on input blur: blur fires before focus reaches a
// row, so a blur-hide leaves the rows unreachable by Tab or arrow — and the
// ID-required sections refuse Enter, so that is their only way to add anything.
function wireDropdown(wrap, input, results) {
  const rows = () => [...results.querySelectorAll('button')]
  const focusRow = (i) => {
    const r = rows()
    if (r.length) r[(i + r.length) % r.length].focus()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !results.hidden) { e.preventDefault(); focusRow(0) }
    else if (e.key === 'Escape') results.hidden = true
  })
  results.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(rows().indexOf(document.activeElement) + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(rows().indexOf(document.activeElement) - 1) }
    else if (e.key === 'Escape') { e.preventDefault(); results.hidden = true; input.focus() }
  })
  // Safari and Firefox on macOS do not focus a <button> on mousedown, so
  // without this the focusout below fires with a null relatedTarget and hides
  // the list before mouseup — the row's click never lands. prefs.command opens
  // the DEFAULT browser, so that is the common case, not the edge case.
  results.addEventListener('mousedown', (e) => e.preventDefault())
  wrap.addEventListener('focusout', (e) => {
    if (!wrap.contains(e.relatedTarget)) results.hidden = true
  })
}

// Shared input + dropdown shell; one wireX per picker kind supplies the rows.
const PICKERS = {
  artist: { placeholder: 'Add artist (name, Apple ID, or artist page URL, then pick from the list)…', wire: wireArtist },
  playlist: { placeholder: 'Add playlist (paste an Apple Music playlist URL, then pick from the list)…', wire: wirePlaylist },
  country: { placeholder: 'Add country (pick from the list)…', wire: wireCountry },
  genre: { placeholder: 'Add genre (pick from the list, or press Enter for exact text)…', wire: wireGenre },
}

function makeAdder(s) {
  const wrap = document.createElement('div')
  wrap.className = 'relative flex gap-1.5'
  const input = document.createElement('input')
  input.id = 'add-' + s.key
  input.className = 'flex-1 rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-[13px]'
  // placeholders disappear on typing — give the field a persistent name
  input.setAttribute('aria-label', 'Add to ' + s.label)
  // Left set permanently: a description pointing at a hidden element is out of
  // the accessibility tree, so it needs no toggling alongside err.hidden.
  input.setAttribute('aria-describedby', 'err-' + s.key)
  const picker = PICKERS[s.kind]
  input.placeholder = picker.placeholder
  const results = document.createElement('div')
  results.className = 'absolute inset-x-0 top-[34px] z-10 max-h-60 overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-background shadow-[0_8px_24px_rgba(0,0,0,.12)]'
  results.hidden = true
  const err = document.createElement('p')
  err.id = 'err-' + s.key
  err.hidden = true
  err.setAttribute('role', 'alert')
  // Above the input, not below: the dropdown is absolutely positioned over the
  // space under it, and every one of these messages points AT that list, so it
  // has to stay readable while the list is open.
  err.className = 'mb-1 text-[11.5px] text-destructive'
  // No clear here: a successful add re-renders the adder, and the reject path
  // inside addTo sets a message this would wipe.
  const pick = (item) => { addTo(s.key, item); input.value = ''; results.hidden = true }
  picker.wire(s, input, results, pick)
  // addEventListener, not input.oninput: every wireX assigns that property.
  input.addEventListener('input', () => clearFieldError(s.key))
  wireDropdown(wrap, input, results)
  wrap.append(input, results)
  // err goes outside wrap: wrap is the flex row and the positioning context for
  // the absolute results list.
  const col = document.createElement('div')
  col.append(err, wrap)
  return col
}

function wireArtist(s, input, results, pick) {
  let timer
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    // free-text entries have no Apple ID — the fetcher can't sweep them
    setFieldError(s.key, 'Pick an artist from the search list, then press Down to reach it. Entries are pinned by Apple ID.')
  }
  input.oninput = () => {
    clearTimeout(timer)
    const q = input.value
    if (q.trim().length < 2) { results.hidden = true; return }
    // 500ms of debounce plus a request round trip, and this dropdown is the only
    // way to add an artist (Enter is refused above), so the wait needs a marker.
    noteRow(results, 'Searching…')
    timer = setTimeout(async () => { // 500ms: iTunes Search is ~20 req/min
      let found
      try {
        const res = await fetch('/api/artist-search?q=' + encodeURIComponent(q))
        if (!res.ok) throw new Error('search failed')
        found = (await res.json()).results
        if (!Array.isArray(found)) throw new Error('search failed')
      } catch {
        // this runs inside a timer, so an unreported throw here is invisible:
        // the box would simply never produce suggestions
        results.hidden = true
        setFieldError(s.key, 'Artist search unavailable. The editor may have stopped; reopen prefs.command.')
        return
      }
      if (!found.length) { noteRow(results, 'No artists found'); return }
      results.replaceChildren()
      for (const a of found) {
        let verify
        if (a.url) {
          // verify the identity on its Apple Music page before adding
          verify = document.createElement('a')
          // Padded to clear 24x24 (measured 26.6x32): it sits flush against the
          // pick button, so WCAG 2.5.8's spacing exception does not cover it and
          // both axes have to make the size on their own.
          verify.className = 'shrink-0 px-2 py-1.5 text-sm text-muted-foreground no-underline hover:text-foreground'
          verify.textContent = '↗'
          verify.href = a.url
          verify.target = '_blank'
          verify.rel = 'noopener noreferrer'
          verify.title = 'Open on Apple Music to verify'
          verify.setAttribute('aria-label', 'Open ' + a.name + ' on Apple Music')
        }
        resultRow(results, a.name, a.genre, () => pick({ name: a.name, id: a.id }), verify)
      }
      results.hidden = false
    }, 500)
  }
}

// a valid URL shows one result row with the derived name, so the chip text is
// visible before adding. No raw-text onchange fallback: the mid-edit re-render
// would fire it with the URL still in the box and add a second, URL-named chip.
function wirePlaylist(s, input, results, pick) {
  const taken = (pl) => getList(s.key).some((e) => e.url === pl.url)
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    const pl = parsePlaylist(input.value.trim())
    if (!pl) { setFieldError(s.key, 'Not an Apple Music playlist URL.'); return }
    // addTo owns duplicate rejection for every section; taken() stays only to
    // label the row below, where it warns before the click rather than after.
    pick(pl)
  }
  input.oninput = () => {
    results.replaceChildren()
    const pl = parsePlaylist(input.value.trim())
    if (!pl) { results.hidden = true; return }
    const dupe = taken(pl)
    resultRow(results, pl.name, dupe ? 'already in the list' : 'playlist', () => pick(pl))
    results.hidden = false
  }
}

// focus lists every storefront not yet followed, typing filters by name or
// code; add only from the list (codes are verified server-side).
function wireCountry(s, input, results, pick) {
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    const q = input.value.trim().toLowerCase()
    const code = Object.hasOwn(countryNames, q) ? q : Object.keys(countryNames).find((c) => countryNames[c].toLowerCase() === q)
    if (!code) { setFieldError(s.key, 'Pick a country from the list.'); return }
    pick(code)
  }
  const show = () => {
    results.replaceChildren()
    const typed = input.value.trim().toLowerCase()
    const have = new Set(getList(s.key))
    const opts = Object.entries(countryNames)
      .filter(([code, name]) => !have.has(code) && (name.toLowerCase().includes(typed) || code.includes(typed)))
      .sort((a, b) => a[1].localeCompare(b[1]))
    for (const [code, name] of opts)
      resultRow(results, name, streamingOnly.has(code) ? code + ' · streaming only' : code, () => pick(code))
    results.hidden = opts.length === 0
  }
  input.oninput = show
  input.onfocus = show
}

// focus lists the curated options, typing filters, Enter takes exact free text
// (any Apple genre name is followable).
function wireGenre(s, input, results, pick) {
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    if (!input.value.trim()) { setFieldError(s.key, 'Type a genre name, or pick one from the list.'); return }
    pick(input.value)
  }
  const show = () => {
    results.replaceChildren()
    const typed = input.value.trim().toLowerCase()
    const have = new Set(getList(s.key).map((g) => nameOf(g).toLowerCase()))
    const opts = genreOptions.filter((g) => !have.has(g.toLowerCase()) && g.toLowerCase().includes(typed))
    for (const g of opts) resultRow(results, g, '', () => pick(g))
    // nothing matches: offer the exact text explicitly (what Enter does)
    if (!opts.length && typed && !have.has(typed)) {
      resultRow(results, 'Follow exact text "' + input.value.trim() + '"', 'exact Apple genre match', () => pick(input.value))
      results.hidden = false
      return
    }
    results.hidden = opts.length === 0
  }
  input.oninput = show
  input.onfocus = show
}

let wasRunning = false
let pollTimer
let offline = false
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
  running: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  ok: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100',
  warn: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-100',
  // primary, not accent: the dark accent is 28%-alpha and this strip floats
  // over the chips, so an error banner must be opaque
  bad: 'bg-primary text-primary-foreground',
}
function setBanner(cls, text) {
  const b = $('banner')
  // role=status re-announces on every mutation, and poll() re-sets the identical
  // running text every 2s for the length of a refresh.
  const key = (cls ?? '') + '|' + (text ?? '')
  if (b.dataset.rendered === key) return
  b.dataset.rendered = key
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
    if (offline) { offline = false; setBanner(null); setStatus('') } // recovered
    $('refresh').disabled = st.running
    $('refresh').textContent = st.running ? 'Refreshing…' : 'Save & Refresh'
    // The log tail is ambient information, so it must never overwrite something
    // the user needs to read. A message from an action holds until they act again.
    if (!statusHeld) setStatus(st.running ? '' : (st.log.at(-1) ?? ''))
    if (st.running && !wasRunning) logDismissed = false // new refresh, show again
    $('log-wrap').hidden = !st.running || logDismissed
    if (st.running) {
      $('log').textContent = st.log.join('\\n')
      $('log').scrollTop = $('log').scrollHeight
      setBanner('running', 'Refreshing. Usually about two minutes, longer if the site deploy needs a retry. Live progress above; safe to close this page, the refresh continues in the background.')
    } else if (wasRunning) {
      // Classify from what update.sh actually logs. ERROR and WARNING mean
      // different things (a failed source vs a failed deploy) and neither is a
      // clean success; "fetch did not run" published nothing at all.
      const published = st.log.some((l) => /Published|No changes/.test(l))
      const neverRan = st.log.some((l) => /ERROR: fetch did not run/.test(l))
      const failed = st.log.some((l) => /ERROR:/.test(l))
      const warned = st.log.some((l) => /WARNING:/.test(l))
      if (neverRan || !published) {
        setBanner('bad', 'The update could not run, so nothing was published. Check config/preferences.json, then ~/Library/Logs/new-music-radar.log.')
      } else if (failed) {
        setBanner('warn', 'Refresh finished, but a source failed. Everything else was published; check ~/Library/Logs/new-music-radar.log.')
      } else if (warned) {
        setBanner('warn', 'New data was published, but the site deploy did not confirm. The page may show old data until the next update. See ~/Library/Logs/new-music-radar.log.')
      } else {
        setBanner('ok', 'Refresh complete. The site shows the new data within a minute.')
      }
      reloadPrefs() // chip counts and dormancy hints are stale after a fetch
    }
    wasRunning = st.running
  } else if (!offline) {
    // without this a dead server looks exactly like an idle healthy one
    offline = true
    // Banner only: both it and #status are role="status", so writing the same
    // sentence to each in one tick has assistive tech read it twice.
    setBanner('bad', OFFLINE)
  }
  // Nothing to show while the tab is hidden, and this loop otherwise runs for
  // as long as the page stays open. visibilitychange restarts it.
  if (document.hidden && !st?.running) return
  pollTimer = setTimeout(poll, st?.running ? 2000 : 10000)
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { clearTimeout(pollTimer); poll() }
})

async function save() {
  try {
    const r = await fetch('/api/prefs', { method: 'POST', body: JSON.stringify(prefs) })
    if (r.ok) { dirty = false; $('save').disabled = true; setStatus('Saved.', false, true); return true }
    const body = await r.json().catch(() => ({}))
    setStatus('Save failed: ' + (body.error ?? 'HTTP ' + r.status), true, true)
    return false
  } catch {
    setStatus(OFFLINE, true, true)
    return false
  }
}
$('save').onclick = save
$('refresh').onclick = async () => {
  if (dirty && !(await save())) return
  setBanner('running', 'Starting refresh…')
  try {
    const r = await fetch('/api/refresh', { method: 'POST' })
    // 409 = a detached refresh from an earlier click is still going
    if (r.status === 409) { setStatus('A refresh is already running.', false, true) }
    else if (!r.ok) {
      // a reachable server that refused is a different problem from a dead one
      const body = await r.json().catch(() => ({}))
      setBanner('bad', 'Could not start the refresh.')
      setStatus('Could not start the refresh: ' + (body.error || 'HTTP ' + r.status), true, true)
      return
    }
  } catch {
    setBanner('bad', OFFLINE)
    return
  }
  wasRunning = true
  logDismissed = false // this click preempts poll's false→true transition
  clearTimeout(pollTimer) // restart the single poll chain, don't fork a second one
  poll()
}
$('quit').onclick = async () => {
  // onbeforeunload can't guard this: quitting is a fetch plus an innerHTML
  // swap, not a navigation, so that handler never fires here.
  if (dirty && !confirm('You have unsaved changes. Quit without saving them?')) return
  dirty = false // confirmed: don't let onbeforeunload ask a second time
  clearTimeout(pollTimer) // the page is about to lose its status elements
  try {
    await fetch('/api/quit', { method: 'POST' })
  } catch {
    // the server may exit before the response lands — that is a successful quit
  }
  document.body.innerHTML = '<p class="p-10 text-center">Server stopped. You can close this tab.</p>'
}
window.onbeforeunload = () => (dirty ? true : undefined)

function applyPrefs(p) {
  prefs = { artists: p.artists, genres: p.genres, discovery: { countries: p.countries ?? [], playlists: p.playlists ?? [] } }
  activity = p.activity ?? {}
  genreOptions = p.genreOptions ?? []
  genreCounts = p.genreCounts ?? {}
  sourceCounts = p.sourceCounts ?? {}
  countsAvailable = p.countsAvailable !== false
  countryNames = p.countryNames ?? {}
  historyDays = p.historyDays ?? 0
  streamingOnly = new Set(p.streamingOnly ?? [])
  alwaysScanned = p.alwaysScanned ?? []
  renderAll()
}

// Skipped while dirty: re-rendering from disk would throw away edits the user
// has not saved.
function reloadPrefs() {
  if (dirty) return
  // A re-render rebuilds every input, so refreshing under an active field would
  // swallow a half-typed name, its open dropdown and any error mid-keystroke.
  // The dirty flag doesn't cover this: typing sets nothing until an add lands.
  if ($('sections')?.contains(document.activeElement)) return
  fetch('/api/prefs')
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => { if (p && !dirty) applyPrefs(p) })
    .catch(() => {})
}

fetch('/api/prefs').then(async (r) => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status)
  return r.json()
}).then((p) => {
  applyPrefs(p)
  poll()
}).catch((err) => {
  // A hand-edited preferences.json that no longer parses is the case this
  // editor exists to recover from, so it must not render as a blank page. Build
  // with DOM nodes, not innerHTML: the message carries the parser's text.
  const box = document.createElement('div')
  box.className = 'py-4 text-sm text-destructive'
  const p1 = document.createElement('p')
  p1.textContent = 'Could not load preferences. Check that config/preferences.json is valid JSON, then reload this page.'
  const p2 = document.createElement('p')
  p2.className = 'mt-2 font-mono text-[12px] break-words'
  p2.textContent = String(err && err.message ? err.message : err)
  box.append(p1, p2)
  $('sections').replaceChildren(box)
  setStatus('Preferences did not load.', true, true)
  poll() // still detect the server dying while the page sits in this state
})
</script>
</body>
</html>`

// Double-clicking prefs.command twice is the everyday case: the browser lands
// on the editor already running, so the second process has only noise to add.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`The editor is already running at http://127.0.0.1:${PORT}`)
    process.exit(0)
  }
  console.error(`Could not start the preferences editor: ${e.message}`)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Preferences editor: http://127.0.0.1:${PORT}`)
})
