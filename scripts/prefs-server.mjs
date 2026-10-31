#!/usr/bin/env node

import http from 'node:http'
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, normalize } from 'node:path'
import { GENRE_OPTIONS } from './genre-options.mjs'
import { COUNTRY_NAMES, STREAMING_ONLY, US_STOREFRONT } from './storefronts.mjs'
import { ACTIVITY_PATH, DATA_PATH, GENRE_FEEDS, PREFS_PATH, REFRESH_LOG, SOURCE_ACTIVITY_PATH, SOURCE_CHIP_DAYS, SOURCE_THIN_DAYS, WINDOW_DAYS, hideNoiseOf, sourceTag, sourceWindow, windowIndices, writeFileAtomic } from './shared.mjs'

import { acquireRunLock, BusyError, runOwner } from './run-lock.mjs'
import { itunesJSON } from './apple-api.mjs'
import { CLOUD_REFRESH, LOGS_URL } from './cloud-config.mjs'
import { executionLog, executionState, isExecutionName, runningExecution, startExecution } from './cloud-run.mjs'
import { publishPrefs, syncLocal } from './publish-prefs.mjs'

const PORT = 4747
const REPO_DIR = fileURLToPath(new URL('..', import.meta.url))
const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url))
// Same drawing as src/assets/favicon.svg.
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6C172C"/><stop offset="1" stop-color="#B3264A"/></linearGradient></defs><rect width="30" height="30" rx="6.5" fill="url(#g)"/><g transform="translate(3 3)" fill="none" stroke="#FFF" stroke-width="2" stroke-linecap="round"><path d="M8.46 8.46a5 5 0 0 0 0 7.07M15.54 8.46a5 5 0 0 1 0 7.07M5.64 5.64a9 9 0 0 0 0 12.73M18.36 5.64a9 9 0 0 1 0 12.73"/><circle cx="12" cy="12" r="2" fill="#FFF" stroke="none"/></g></svg>')
// Symlink-resolved prefix (trailing / so a sibling like docs-evil/ can't pass
// a startsWith check); the static handler re-checks realpaths against this.
const DOCS_REAL = realpathSync(DOCS_DIR) + '/'
const SITE_PATH = '/new-music-radar/'
const SITE_URL = `http://127.0.0.1:${PORT}${SITE_PATH}`

// Resolve the hashed stylesheet per request because builds replace its filename.
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

const readActivity = () => {
  try {
    return JSON.parse(readFileSync(ACTIVITY_PATH, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`could not read artist-activity.json (${e.message}) — dormancy hints unavailable`)
    return {}
  }
}

const isName = (s) => typeof s === 'string' && s.trim().length > 0 && s.length < 200
const isPinnedArtistList = (v) =>
  Array.isArray(v) && v.every((e) => e && isName(e.name) && Number.isSafeInteger(e.id) && e.id > 0)
const isStringList = (v) => Array.isArray(v) && v.every(isName)
const PLAYLIST_URL_RE = /^https:\/\/music\.apple\.com\/[a-z]{2}\/playlist\/([^/]+)\/pl\./
const isPlaylistList = (v) =>
  Array.isArray(v) &&
  v.every(
    (e) => e && isName(e.name) && typeof e.url === 'string' && PLAYLIST_URL_RE.test(e.url)
  )
const isCountryList = (v) =>
  Array.isArray(v) && v.every((c) => typeof c === 'string' && Object.hasOwn(COUNTRY_NAMES, c))
const isFilters = (v) =>
  v === undefined || (!!v && typeof v === 'object' && !Array.isArray(v) && typeof v.hide_alternate_versions === 'boolean')

let refreshLogStart = null

async function startRefresh() {
  if (runOwner()) return false
  const fd = openSync(REFRESH_LOG, 'a')
  refreshLogStart = fstatSync(fd).size
  try {
    const child = fork(new URL('./run-lock.mjs', import.meta.url), ['refresh', 'bash', 'scripts/update.sh'], {
      cwd: REPO_DIR,
      execArgv: [],
      detached: true,
      stdio: ['ignore', fd, fd, 'ipc'],
    })
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => resolve(false))
      child.once('message', () => {
        child.disconnect()
        child.unref()
        resolve(true)
      })
    })
  } finally { closeSync(fd) }
}

// The cloud job's progress, refreshed in the background so /api/status never
// waits on gcloud.
const CLOUD_STATE = fileURLToPath(new URL('../.radar-cloud-run.json', import.meta.url))
// The partial-fetch ERROR line precedes Published, so it is not an outcome.
const OUTCOME = /Published|No changes|ERROR: (fetch did not run|push failed|commit failed)/
// The job's task timeout (45m) plus margin: a tracked run older than this is abandoned.
// Both limits take an override only so tests need not wait them out.
const CLOUD_RUN_LIMIT_MS = Number(process.env.RADAR_CLOUD_LIMIT_MS) || 50 * 60_000
const SETTLE_MS = Number(process.env.RADAR_CLOUD_SETTLE_MS) || 90_000
// "Pages deploy failure; requesting a fresh build" is not a verdict; its rebuild result is.
const DEPLOY_VERDICT = /Pages deploy (verified|cancelled)|WARNING:|gh not found/
const cloud = { name: null, startedAt: 0, running: false, busy: false, log: [], doneAt: 0, idleCheckedAt: 0, failures: 0 }

function readCloudState() {
  try {
    const { name, startedAt } = JSON.parse(readFileSync(CLOUD_STATE, 'utf8'))
    if (isExecutionName(name)) return { name, startedAt: Number(startedAt) || Date.now() }
  } catch {}
  rmSync(CLOUD_STATE, { force: true })
  return null
}

async function finishCloudRun(log) {
  rmSync(CLOUD_STATE, { force: true })
  await syncUnderLock()
  Object.assign(cloud, { name: null, startedAt: 0, running: false, busy: false, doneAt: 0, failures: 0, log })
}

// Cloud Logging lags the execution, so a finished run is held as running until
// its outcome (and, after a publish, the deploy verdict) has arrived, up to 90s.
const settled = (log) => log.some((l) => OUTCOME.test(l)) && (!log.some((l) => /Published/.test(l)) || log.some((l) => DEPLOY_VERDICT.test(l)))

function syncUnderLock() {
  let lock
  try { lock = acquireRunLock('preferences') } catch { return Promise.resolve() }
  return syncLocal()
    .then((r) => { if (!r.synced) console.log(`Local data not refreshed: ${r.reason}`) })
    .finally(() => lock.release())
}

async function pollCloud() {
  try {
    if (!cloud.name) Object.assign(cloud, readCloudState() ?? {})
    if (cloud.name) {
      const lost = (e) => finishCloudRun([...cloud.log, `ERROR: lost track of the cloud run (${e.message})`])
      const expired = () => Date.now() - cloud.startedAt > CLOUD_RUN_LIMIT_MS
      let state
      try {
        state = await executionState(cloud.name)
      } catch (e) {
        if (/NOT_FOUND|not found|cannot find/i.test(e.message) || expired()) return await lost(e)
        throw e
      }
      if (!state.done && expired()) return await lost(new Error('no result after the task time limit'))
      if (state.done) cloud.doneAt ||= Date.now()
      try {
        cloud.log = await executionLog(cloud.name)
        cloud.failures = 0
      } catch (e) {
        // A finished run still settles through the cap below on its last log.
        if (!state.done) throw e
      }
      if (state.done && settled(cloud.log)) {
        await finishCloudRun(cloud.log)
      } else if (state.done && Date.now() - cloud.doneAt > SETTLE_MS) {
        // An incomplete log must not read as "nothing was published" when the run did publish.
        const unknown = state.succeeded || cloud.log.some((l) => /Published/.test(l))
        await finishCloudRun(unknown ? [...cloud.log, `ERROR: lost track of the cloud run (log incomplete; the run ${state.succeeded ? 'succeeded' : 'failed'})`] : cloud.log)
      } else {
        cloud.running = cloud.busy = true
      }
    } else if (Date.now() - cloud.idleCheckedAt > 60_000) {
      cloud.idleCheckedAt = Date.now()
      cloud.busy = !!(await runningExecution())
    }
  } catch (e) {
    console.error(`Cloud status unavailable: ${e.message}`)
    // Expired gcloud credentials would otherwise leave "Refreshing" with no reason shown.
    if (cloud.name && ++cloud.failures === 3) cloud.log = [...cloud.log, `Cloud status unavailable: ${e.message}`]
    if (!cloud.name) cloud.busy = false
  } finally {
    setTimeout(pollCloud, cloud.name ? 3000 : 10_000).unref()
  }
}

// The page shows the last 10 lines, but classifies the outcome from all of them.
const statusLog = (log) => [...log.slice(0, -10).filter((l) => /ERROR:|WARNING:/.test(l)), ...log.slice(-10)]

let cloudStarting = null
function startCloudRefresh() {
  cloudStarting ??= startCloudRefreshOnce().finally(() => { cloudStarting = null })
  return cloudStarting
}

async function startCloudRefreshOnce() {
  const lock = acquireRunLock('preferences')
  let pushed
  try { pushed = await publishPrefs() } finally { lock.release() }
  if (!pushed.pushed) return { code: 400, body: { error: 'preferences are not on GitHub yet: ' + pushed.reason } }
  if (cloud.name || await runningExecution()) return { code: 409, body: { running: true } }
  const name = await startExecution()
  const startedAt = Date.now()
  writeFileAtomic(CLOUD_STATE, JSON.stringify({ name, startedAt }))
  Object.assign(cloud, { name, startedAt, running: true, busy: true, log: [], doneAt: 0, failures: 0 })
  return { code: 200, body: { running: true } }
}

const searchCache = new Map()
async function searchArtists(q) {
  const cached = searchCache.get(q)
  if (cached && cached.until > Date.now()) return cached.promise
  const urlId = q.match(/^https:\/\/music\.apple\.com\/[a-z]{2}\/artist\/[^/]+\/(\d+)/)?.[1]
  const id = urlId ?? (/^\d+$/.test(q) ? q : null)
  const promise = itunesJSON(id
    ? `https://itunes.apple.com/lookup?id=${id}&country=US`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=musicArtist&country=US&limit=6`)
  searchCache.set(q, { promise, until: Date.now() + 60_000 })
  if (searchCache.size > 50) searchCache.delete(searchCache.keys().next().value)
  promise.catch(() => { if (searchCache.get(q)?.promise === promise) searchCache.delete(q) })
  return promise
}

// Tail only: update.sh lets the log reach 1MB. 8KB holds the lines the page
// shows (the longest observed line is under 400 chars).
const TAIL_BYTES = 8192
// since: never read before this byte, so a caller classifying an outcome cannot
// see an earlier run. null falls back to a plain tail, which is what a refresh
// launchd started, or one predating this server, has to be read as.
function logTail(lines, since = null) {
  let fd
  try {
    fd = openSync(REFRESH_LOG, 'r')
    const { size } = fstatSync(fd)
    const start = Math.max(since !== null && since <= size ? since : 0, size - TAIL_BYTES, 0)
    const buf = Buffer.alloc(size - start)
    // update.sh can truncate the log between stat and read; decode only the bytes read.
    const n = readSync(fd, buf, 0, buf.length, start)
    const all = buf.subarray(0, n).toString('utf8').split('\n').filter(Boolean)
    // drop the first entry when we started mid-file: it is a partial line, and
    // slicing mid-character would leave a mojibake fragment
    if (start > 0 && start !== since) all.shift()
    return all.slice(-lines)
  } catch {
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
  svg: 'image/svg+xml',
  png: 'image/png',
}

// hasOwn, not a bare lookup: a file named "x.constructor" would otherwise
// resolve to a function and make writeHead throw, 500-ing a readable file.
const mimeOf = (file) => {
  const ext = file.split('.').pop()
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : 'application/octet-stream'
}

const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])

export const server = http.createServer(async (req, res) => {
  let url
  try { url = new URL(req.url, `http://127.0.0.1:${PORT}`) } catch {
    return json(res, 400, { error: 'invalid URL' })
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      // The deployed site pings this to decide whether to show its gear button —
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
      const href = cssHref()
      res.end(PAGE.replace('<!--CSS-->', href ? `<link rel="stylesheet" href="${href}">` : ''))
    } else if (req.method === 'GET' && url.pathname === '/api/prefs') {
      const p = readPrefs()
      const genreCounts = {}
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

      const sourceCounts = {}
      let historyDays = 0
      try {
        const h = JSON.parse(readFileSync(SOURCE_ACTIVITY_PATH, 'utf8'))
        historyDays = (h.days ?? []).length
        const idx = windowIndices(h, SOURCE_CHIP_DAYS)
        for (const tag of Object.keys(h.sources ?? {})) sourceCounts[tag] = sourceWindow(h, tag, idx)
      } catch (e) {
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
        genreOptions: [...GENRE_OPTIONS].sort((a, b) => a.localeCompare(b)),
        genreCounts,
        sourceCounts,
        countsAvailable,
        historyDays,
        countryNames: COUNTRY_NAMES,
        streamingOnly: [...STREAMING_ONLY],
        chartGenres: Object.fromEntries(GENRE_FEEDS.map((f) => [f.tag.toLowerCase(), sourceTag('genre', f.tag)])),
        filters: { hide_alternate_versions: hideNoiseOf(p) },
      })
    } else if (req.method === 'POST' && url.pathname === '/api/prefs') {
      // Decode after joining buffers: a UTF-8 character can straddle request chunks.
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
        !isCountryList(incoming?.discovery?.countries) ||
        !isFilters(incoming?.filters)
      ) return json(res, 400, { error: 'invalid list shape' })
      const lock = acquireRunLock('preferences')
      let published
      try {
        const p = readPrefs()
        p.artists = { ...p.artists, followed: incoming.artists.followed, blocked: incoming.artists.blocked }
        p.genres = { ...p.genres, followed: incoming.genres.followed }
        p.discovery = { ...p.discovery, countries: incoming.discovery.countries, playlists: incoming.discovery.playlists }
        if (incoming.filters) p.filters = { ...p.filters, hide_alternate_versions: incoming.filters.hide_alternate_versions }
        writeFileAtomic(PREFS_PATH, JSON.stringify(p, null, 2) + '\n')
        published = await publishPrefs()
      } finally { lock.release() }
      json(res, 200, { ok: true, ...published })
    } else if (req.method === 'GET' && url.pathname === '/api/artist-search') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 100).trim()
      if (q.length < 2) return json(res, 200, { results: [] })
      const data = await searchArtists(q)
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
      if (CLOUD_REFRESH) {
        const r = await startCloudRefresh()
        return json(res, r.code, r.body)
      }
      json(res, await startRefresh() ? 200 : 409, { running: true })
    } else if (req.method === 'GET' && url.pathname === '/api/status') {
      if (CLOUD_REFRESH) return json(res, 200, { running: cloud.running, busy: cloud.busy || !!runOwner(), log: statusLog(cloud.log) })
      const owner = runOwner()
      const running = owner?.kind === 'refresh'
      if (running) refreshLogStart = owner.logStart
      json(res, 200, { running, busy: !!owner, log: logTail(10, refreshLogStart) })
    } else if (req.method === 'POST' && url.pathname === '/api/quit') {
      json(res, 200, { ok: true })
      setTimeout(() => process.exit(0), 100)
    } else if (req.method === 'GET' && url.pathname === SITE_PATH.slice(0, -1)) {
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
        // Only assets/ has content hashes; fonts keep stable names across builds.
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
    if (e instanceof BusyError) return json(res, 409, { error: e.message })
    console.error(`${req.method} ${url.pathname} failed:`, e)
    json(res, 500, { error: e.message })
  }
})

const SECTION_LINK = 'inline-flex min-h-9 shrink-0 items-center rounded-full px-2 text-sm font-medium min-[420px]:px-3.5 aria-[current=true]:bg-foreground/8 aria-[current=true]:text-accent-foreground'

export const PAGE = /* html */ `<!doctype html>
<html lang="en" class="scroll-pt-20">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>New Music Radar Preferences</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<!--CSS-->
</head>
<body class="mx-auto max-w-[680px] break-words px-4 pt-10 pb-10">
<header class="mb-2 flex flex-wrap items-baseline justify-between gap-2"><h1 class="min-w-0 text-[2rem] leading-tight font-bold tracking-tight [overflow-wrap:anywhere]">Preferences</h1><div class="flex items-baseline gap-4"><button id="quit" class="min-h-6 cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">Quit editor</button><a href="${SITE_URL}" id="site-link" target="_blank" rel="noopener noreferrer" class="text-sm font-medium text-accent-foreground hover:underline">Open radar →</a></div></header>
<!-- header outside main: it is a banner landmark only while it is not a
     descendant of main -->
<main>
<nav id="section-index" aria-label="Sections" class="floating sticky top-3 z-20 mx-auto mb-4 flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-full p-1">
  <a href="#section-artists-followed" class="${SECTION_LINK}">Artists</a>
  <a href="#section-artists-blocked" class="${SECTION_LINK}">Blocked</a>
  <a href="#section-genres-followed" class="${SECTION_LINK}">Genres</a>
  <a href="#section-discovery-countries" class="${SECTION_LINK}">Countries</a>
  <a href="#section-discovery-playlists" class="${SECTION_LINK}">Playlists</a>
  <a href="#section-filters" class="${SECTION_LINK}">Filters</a>
</nav>
<p class="mb-2 text-sm leading-relaxed text-muted-foreground">Save applies changes at tonight's update. Save &amp; refresh applies them now and publishes in about ${CLOUD_REFRESH ? 'five' : 'two'} minutes.</p>
<div id="sections"></div>
</main>
<div id="editor-dock" class="mt-4 rounded-2xl border border-border bg-surface-raised p-3">
<div id="log-wrap" hidden class="relative mb-3">
  <button id="log-hide" class="absolute top-0.5 right-1 inline-flex size-6 cursor-pointer items-center justify-center text-base leading-none text-muted-foreground hover:text-foreground" title="Hide the progress log (the refresh keeps running)" aria-label="Hide progress log">×</button>
  <pre id="log" class="max-h-[180px] overflow-y-auto rounded-xl bg-muted px-3 py-2.5 pr-8 font-mono text-xs leading-[1.5] whitespace-pre-wrap wrap-break-word"></pre>
</div>
<div id="banner" hidden role="status"></div>
<footer class="flex flex-wrap items-center gap-2">
  <span id="status" role="status" class="min-w-0 grow basis-48 break-words text-sm leading-snug tabular-nums text-muted-foreground empty:hidden"></span>
  <button id="refresh" class="min-h-10 max-w-full cursor-pointer rounded-full border border-action-secondary-border bg-transparent px-4 text-sm font-medium text-action-secondary-fg disabled:cursor-default disabled:opacity-45">Save &amp; refresh</button>
  <button id="save" disabled class="min-h-10 cursor-pointer rounded-full border border-primary bg-primary px-5 text-sm font-medium text-primary-foreground disabled:cursor-default disabled:opacity-45">Save</button>
</footer>
</div>
<script>
let editRevision = 0, saving = null, refreshStarting = false, stopped = false
let prefs, activity = {}, genreOptions = [], genreCounts = {}, sourceCounts = {}, countryNames = {}, dirty = false
let countsAvailable = true
let streamingOnly = new Set(), chartGenres = {}, historyDays = 0
let dormancySort = false
const $ = (id) => document.getElementById(id)
const TAG_COUNTRY = '${sourceTag('country', '')}'
const TAG_PLAYLIST = '${sourceTag('playlist', '')}'
const TAG_CHART_US = '${sourceTag('chart', 'us')}'
const nameOf = (e) => (typeof e === 'string' ? e : e.name)
const OFFLINE = 'Editor not responding. Reopen prefs.command.'
const LOG_HINT = ${CLOUD_REFRESH ? JSON.stringify('the job logs at ' + LOGS_URL) : JSON.stringify('~/Library/Logs/new-music-radar.log')}
// Full literals, not composed strings — Tailwind scans this file as text.
const AMBER = 'text-xs tabular-nums text-warning-text'
const MUTED = 'text-xs tabular-nums text-muted-foreground'
const STALE = 'text-xs tabular-nums text-accent-foreground'
// average month
const MONTH_MS = 2629746000
let statusHeld = false
const STATUS_BASE = 'min-w-0 grow basis-48 break-words text-sm leading-snug tabular-nums empty:hidden'
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
const SECTIONS = [
  { key: 'artists.followed', label: 'Followed Artists', sub: 'Every release shows, pinned first ★', kind: 'artist' },
  { key: 'artists.blocked', label: 'Blocked Artists', sub: 'Never shown', kind: 'artist' },
  { key: 'genres.followed', label: 'Followed Genres', sub: 'Releases from artists you don\\'t follow show only in these genres. Genres marked US chart also scan Apple\\'s US chart for that genre.', kind: 'genre' },
  { key: 'discovery.countries', label: 'Countries', sub: 'Apple Music charts scanned for new releases', kind: 'country' },
  { key: 'discovery.playlists', label: 'Discovery Playlists', sub: 'Apple Music playlists scanned for new releases', kind: 'playlist' },
]
const getList = (key) => key.split('.').reduce((o, k) => o[k], prefs)
const displayOf = (s, e) =>
  s.kind === 'country' && Object.hasOwn(countryNames, e) ? countryNames[e] : nameOf(e)

function countryNote(code) {
  if (code === '${US_STOREFRONT}') return 'Most-played albums, top 50'
  if (streamingOnly.has(code)) return 'Streaming chart only: Apple runs no purchase store here'
  return ''
}

const PLAYLIST_RE = /${PLAYLIST_URL_RE.source}/
function parsePlaylist(u) {
  const m = PLAYLIST_RE.exec(u)
  if (!m) return null
  return { name: m[1].replace(/-/g, ' ').replace(/\\b\\w/g, (c) => c.toUpperCase()), url: u }
}

// Keep the optional link beside the button; nested interactive elements are invalid.
function resultRow(results, label, note, onPick, extra) {
  const b = document.createElement('button')
  const nm = document.createElement('span')
  nm.textContent = label
  b.appendChild(nm)
  b.className = 'flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-left text-sm hover:bg-foreground/8 focus-visible:bg-foreground/8'
  if (note) {
    const n = document.createElement('span')
    n.className = 'ml-auto whitespace-nowrap text-xs text-muted-foreground'
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

function noteRow(results, text) {
  const d = document.createElement('div')
  d.className = 'px-2.5 py-[7px] text-sm text-muted-foreground'
  d.textContent = text
  results.replaceChildren(d)
  results.hidden = false
}

function markDirty() { editRevision++; dirty = true; $('save').disabled = false; setStatus('Unsaved changes', false, true) }

function chartNote(tag) {
  const span = document.createElement('span')
  span.className = MUTED
  span.textContent = '· US chart'
  const c = sourceCounts[tag]
  span.title = 'Also scans Apple\\'s US chart for this genre' + (c && c.measured >= THIN_DAYS ? '. ' + countDetail(c) : '')
  return span
}

function genreCount(name) {
  if (!countsAvailable) return null
  const n = genreCounts[name.toLowerCase()] ?? 0
  const span = document.createElement('span')
  span.className = n === 0 ? AMBER : MUTED
  span.textContent = '· ' + n
  span.title = 'Releases from artists you don\\'t follow in this genre, last ${WINDOW_DAYS} days'
  return span
}

const THIN_DAYS = ${SOURCE_THIN_DAYS}
const CHIP_DAYS = ${SOURCE_CHIP_DAYS}
function countDetail(c) {
  return 'Last ' + CHIP_DAYS + ' days: ' + c.unique + ' only here, ' + (c.surfaced - c.unique) + ' shared, ' + c.surfaced +
    ' total, over ' + c.measured + ' measured days' + (c.last ? '; last found something on ' + c.last : '')
}
function sourceCount(tag) {
  const c = sourceCounts[tag]
  const span = document.createElement('span')
  if (!c || c.measured < THIN_DAYS) {
    span.className = MUTED
    span.textContent = '· collecting'
    const n = c?.measured ?? 0
    span.title = historyDays < THIN_DAYS
      ? 'Needs about a week of daily updates before this figure means anything (' + historyDays + ' days so far)'
      : 'Only ' + n + ' measured ' + (n === 1 ? 'day' : 'days') + ' for this source so far'
    return span
  }
  span.className = c.surfaced === 0 ? AMBER : MUTED
  span.textContent = '· ' + (c.surfaced === 0 ? '0 found' : c.unique + ' only here')
  span.title = c.surfaced === 0
    ? 'Nothing across ' + c.measured + ' measured days in the last ' + CHIP_DAYS + ', worth a look'
    : countDetail(c)
  return span
}

function renderFilters() {
  const card = document.createElement('section')
  card.className = 'mt-4 rounded-2xl border border-border bg-surface-raised p-4'
  card.id = 'section-filters'
  const h = document.createElement('h2')
  h.className = 'mb-3 text-base font-semibold'
  h.textContent = 'Filters'
  const row = document.createElement('div')
  row.className = 'flex items-start gap-2.5'
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.id = 'hide-alternate-versions'
  box.className = 'mt-0.5 size-4.5 shrink-0 cursor-pointer accent-primary'
  box.checked = prefs.filters.hide_alternate_versions
  box.setAttribute('aria-describedby', 'hide-alternate-versions-sub')
  box.onchange = () => { prefs.filters.hide_alternate_versions = box.checked; markDirty() }
  const text = document.createElement('div')
  const label = document.createElement('label')
  label.htmlFor = box.id
  label.className = 'cursor-pointer text-sm font-medium'
  label.textContent = 'Hide instrumental, sped-up and slowed versions'
  const sub = document.createElement('p')
  sub.id = 'hide-alternate-versions-sub'
  sub.className = 'text-sm text-muted-foreground'
  sub.textContent = 'Applies to every release, including followed artists'
  text.append(label, sub)
  row.append(box, text)
  card.append(h, row)
  return card
}

// Names exist only on the edited section's chips: every named element is
// snapshotted. Keys are Apple IDs, or the name or url where there is no ID;
// never indices, because lists re-sort.
let transitionKey = null
let currentTransition = null
function chipTransitionName(s, entry) {
  const id = typeof entry === 'string'
    ? entry.toLowerCase()
    : entry.id != null ? String(entry.id) : (entry.url ?? entry.name)
  return CSS.escape('chip-' + s.key.replace('.', '-') + '-' + id)
}
function nameChip(chip) {
  chip.style.viewTransitionName = chip.dataset.vt
  chip.style.viewTransitionClass = 'chip'
}
async function withChipTransition(key, update) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { update(); return }
  for (const chip of document.querySelectorAll('[data-vt]')) {
    chip.style.viewTransitionName = ''
    chip.style.viewTransitionClass = ''
  }
  for (const chip of document.querySelectorAll('[data-section="' + key + '"] [data-vt]')) nameChip(chip)
  transitionKey = key
  const token = {}
  currentTransition = token
  const transition = document.startViewTransition(update)
  transition.finished.finally(() => {
    // A newer transition may have renamed these chips; leave them to it.
    if (currentTransition !== token) return
    transitionKey = null
    for (const chip of document.querySelectorAll('[data-section="' + key + '"] [data-vt]')) {
      chip.style.viewTransitionName = ''
      chip.style.viewTransitionClass = ''
    }
  })
  await transition.updateCallbackDone
}

function renderAll() {
  const root = $('sections')
  root.replaceChildren()
  if (!countsAvailable) {
    const warn = document.createElement('p')
    warn.className = 'mb-2 text-sm text-warning-text'
    warn.textContent = 'Could not read the latest results, so the genre chip counts are hidden. Press Save & refresh to rebuild them.'
    root.appendChild(warn)
  }
  for (const s of SECTIONS) {
    getList(s.key).sort((a, b) =>
      displayOf(s, a).toLowerCase().localeCompare(displayOf(s, b).toLowerCase())
    )
    const card = document.createElement('section')
    card.className = 'mt-4 rounded-2xl border border-border bg-surface-raised p-4'
    card.dataset.section = s.key
    card.id = 'section-' + s.key.replace('.', '-')
    const h = document.createElement('h2')
    h.className = 'text-base font-semibold'
    h.textContent = s.label + ' '
    const small = document.createElement('small')
    small.className = 'text-sm font-normal text-muted-foreground tabular-nums'
    small.textContent = getList(s.key).length
    h.appendChild(small)
    const sub = document.createElement('p')
    sub.className = 'mt-0.5 mb-3 text-sm text-muted-foreground'
    sub.textContent = s.sub
    if (s.key === 'artists.followed') {
      const sort = document.createElement('button')
      sort.className = 'ml-2 min-h-6 cursor-pointer p-0 text-xs text-muted-foreground underline hover:text-foreground'
      sort.textContent = dormancySort ? 'Sort: oldest release' : 'Sort: A-Z'
      sort.title = 'Toggle display order (the saved file stays alphabetical)'
      sort.setAttribute('aria-pressed', String(dormancySort))
      sort.id = 'sort-followed'
      sort.onclick = () => {
        dormancySort = !dormancySort
        renderAll()
        $('sort-followed')?.focus()
      }
      h.appendChild(sort)
    }
    let entries = getList(s.key)
    if (s.key === 'artists.followed' && dormancySort) {
      entries = [...entries].sort((a, b) => {
        const da = (a.id && activity[a.id]) || '9999' // no data -> sort last
        const db = (b.id && activity[b.id]) || '9999'
        return da.localeCompare(db) || nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase())
      })
    }
    const chips = document.createElement('div')
    chips.className = 'mb-3 flex flex-wrap gap-1.5'
    for (const entry of entries) {
      const chip = document.createElement('span')
      chip.className = 'inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full bg-muted py-1 pr-1 pl-3 text-sm'
      chip.dataset.vt = chipTransitionName(s, entry)
      if (s.key === transitionKey) nameChip(chip)
      const label = document.createElement('span')
      label.className = 'min-w-0 [overflow-wrap:anywhere]'
      label.textContent = displayOf(s, entry)
      chip.appendChild(label)
      if (s.kind === 'country') {
        const note = countryNote(entry)
        chip.title = note
        if (note) {
          const hidden = document.createElement('span')
          hidden.className = 'sr-only'
          hidden.textContent = note
          chip.appendChild(hidden)
        }
        chip.appendChild(sourceCount(entry === '${US_STOREFRONT}' ? TAG_CHART_US : TAG_COUNTRY + entry))
      }
      if (s.kind === 'playlist') chip.appendChild(sourceCount(TAG_PLAYLIST + nameOf(entry)))
      if (s.key === 'genres.followed') {
        const c = genreCount(nameOf(entry))
        if (c) chip.appendChild(c)
        const chartTag = chartGenres[nameOf(entry).toLowerCase()]
        if (chartTag) chip.appendChild(chartNote(chartTag))
      }
      if (typeof entry !== 'string') chip.title = entry.url ?? 'Apple Music artist #' + entry.id
      const last = s.key === 'artists.followed' && entry.id ? activity[entry.id] : null
      if (last && Date.now() - Date.parse(last) > 18 * MONTH_MS) {
        const months = Math.round((Date.now() - Date.parse(last)) / MONTH_MS)
        const ago = document.createElement('span')
        ago.className = months >= 36 ? STALE : AMBER
        ago.textContent = '· ' + (months >= 24 ? Math.round(months / 12) + 'y' : months + 'mo')
        ago.title = 'Last release ' + last
        chip.appendChild(ago)
      }
      const x = document.createElement('button')
      // size-6 provides a 24x24 target for the destructive control.
      x.className = 'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-sm leading-none text-muted-foreground hover:bg-foreground/10 hover:text-destructive'
      x.textContent = '×'
      x.title = 'Remove'
      x.setAttribute('aria-label', 'Remove ' + displayOf(s, entry))
      x.onclick = () => {
        const l = getList(s.key)
        const i = l.indexOf(entry)
        if (i < 0) return
        l.splice(i, 1); markDirty()
        withChipTransition(s.key, () => { renderAll(); $('add-' + s.key)?.focus() })
        showUndo(s, entry)
      }
      chip.appendChild(x)
      chips.appendChild(chip)
    }
    card.append(h, sub, chips, makeAdder(s))
    root.append(card)
  }
  root.append(renderFilters())
  observeSections()
}

let sectionObserver = null
const inBand = new Set()
let bandSection = ''
function markSection() {
  const sections = [...document.querySelectorAll('#sections section[id]')]
  bandSection = sections.find((s) => inBand.has(s.id))?.id ?? bandSection
  // The last section is too short to reach the observer band.
  const atBottom = scrollY > 0 && innerHeight + scrollY >= document.documentElement.scrollHeight - 2
  const id = navHold ?? (atBottom ? sections.at(-1)?.id : bandSection)
  for (const a of document.querySelectorAll('#section-index a')) {
    const current = a.getAttribute('href') === '#' + id
    if (current && a.getAttribute('aria-current') !== 'true') revealInNav(a)
    a.setAttribute('aria-current', String(current))
  }
}
// scrollIntoView would also scroll the page and unstick the nav.
function revealInNav(a) {
  const nav = $('section-index')
  const left = a.offsetLeft, right = left + a.offsetWidth
  if (left < nav.scrollLeft) nav.scrollLeft = left
  else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth
}
// A short last section scrolls the page to the bottom, where markSection would
// otherwise mark the last section instead of the clicked one. Released by any
// scroll that leaves where the jump lands, so the jump's own scroll events keep it.
let navHold = null, navLanding = 0
$('section-index').addEventListener('click', (e) => {
  const a = e.target.closest('a')
  const target = a && document.getElementById(a.getAttribute('href').slice(1))
  if (!target) return
  const maxY = document.documentElement.scrollHeight - innerHeight
  const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0
  navLanding = Math.max(0, Math.min(maxY, scrollY + target.getBoundingClientRect().top - pad))
  navHold = target.id
  markSection()
})
addEventListener('scroll', () => { if (navHold && Math.abs(scrollY - navLanding) > 2) navHold = null }, { passive: true })
function observeSections() {
  sectionObserver?.disconnect()
  inBand.clear()
  sectionObserver = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? inBand.add(e.target.id) : inBand.delete(e.target.id)
    markSection()
  }, { rootMargin: '-80px 0px -60% 0px' })
  for (const card of document.querySelectorAll('#sections section[id]')) sectionObserver.observe(card)
}
addEventListener('scroll', markSection, { passive: true })

let undoTimer = 0
function showUndo(s, entry) {
  clearTimeout(undoTimer)
  $('undo-toast')?.remove()
  const toast = document.createElement('div')
  toast.id = 'undo-toast'
  toast.setAttribute('role', 'status')
  toast.className = 'fixed bottom-6 left-1/2 z-30 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-foreground py-1.5 pr-1.5 pl-5 text-sm text-background shadow-md motion-safe:animate-[fade-in_200ms_ease-out]'
  const text = document.createElement('span')
  text.textContent = 'Removed ' + displayOf(s, entry)
  const undo = document.createElement('button')
  undo.className = 'min-h-9 cursor-pointer rounded-full bg-background/15 px-4 font-semibold text-background'
  undo.textContent = 'Undo'
  undo.onclick = () => {
    clearTimeout(undoTimer)
    toast.remove()
    addTo(s.key, entry)
    if (!document.activeElement || document.activeElement === document.body) $('add-' + s.key)?.focus()
  }
  const close = () => {
    const hadFocus = toast.contains(document.activeElement)
    toast.remove()
    if (hadFocus) $('add-' + s.key)?.focus()
  }
  const wait = () => { clearTimeout(undoTimer); undoTimer = setTimeout(close, 8000) }
  for (const type of ['pointerenter', 'focusin']) toast.addEventListener(type, () => clearTimeout(undoTimer))
  for (const type of ['pointerleave', 'focusout']) toast.addEventListener(type, () => { if (!toast.matches(':hover, :focus-within')) wait() })
  toast.append(text, undo)
  document.body.appendChild(toast)
  wait()
}

function addTo(key, item) {
  const list = getList(key)
  const name = nameOf(item).trim()
  if (!name) return
  const section = SECTIONS.find((s) => s.key === key)
  const displayName = section ? displayOf(section, typeof item === 'string' ? name : item) : name
  const dupe = item.id != null
    ? list.some((e) => e.id === item.id)
    : list.some((e) => nameOf(e).toLowerCase() === name.toLowerCase())
  if (dupe) {
    setFieldError(key, displayName + ' is already in ' + (section?.label ?? key) + '.')
    return
  }
  list.push(typeof item === 'string' ? name : { ...item, name })
  markDirty()
  return withChipTransition(key, () => { renderAll(); $('add-' + key)?.focus() })
}

// Hide on focus leaving the wrapper: input blur fires before focus reaches a row.
function wireDropdown(wrap, input, results, onDismiss) {
  const dismiss = () => { results.hidden = true; onDismiss?.() }
  const rows = () => [...results.querySelectorAll('button')]
  const focusRow = (i) => {
    const r = rows()
    if (r.length) r[(i + r.length) % r.length].focus()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !results.hidden) { e.preventDefault(); focusRow(0) }
    else if (e.key === 'Escape') dismiss()
  })
  results.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(rows().indexOf(document.activeElement) + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(rows().indexOf(document.activeElement) - 1) }
    else if (e.key === 'Escape') { e.preventDefault(); dismiss(); input.focus() }
  })
  // Safari and Firefox on macOS do not focus buttons on mousedown; prevent
  // focusout from hiding the list before the row's click lands.
  results.addEventListener('mousedown', (e) => e.preventDefault())
  wrap.addEventListener('focusout', (e) => {
    if (!wrap.contains(e.relatedTarget)) dismiss()
  })
}

const PICKERS = {
  artist: { placeholder: 'Add artist: name, Apple ID or link', hint: 'Type a name, Apple ID or artist page URL, then pick from the list', wire: wireArtist },
  playlist: { placeholder: 'Add playlist: paste a link', hint: 'Paste an Apple Music playlist URL, then pick from the list', wire: wirePlaylist },
  country: { placeholder: 'Add country', hint: 'Pick a country from the list', wire: wireCountry },
  genre: { placeholder: 'Add genre', hint: 'Pick from the list, or press Enter to follow the exact text', wire: wireGenre },
}

function makeAdder(s) {
  const wrap = document.createElement('div')
  wrap.className = 'relative flex gap-1.5'
  const input = document.createElement('input')
  input.id = 'add-' + s.key
  input.className = 'min-h-11 min-w-0 flex-1 rounded-xl border border-border-strong bg-transparent px-3 text-sm'
  input.setAttribute('aria-label', 'Add to ' + s.label)
  // Left set permanently: a description pointing at a hidden element is out of
  // the accessibility tree, so it needs no toggling alongside err.hidden.
  input.setAttribute('aria-describedby', 'err-' + s.key)
  const picker = PICKERS[s.kind]
  input.placeholder = picker.placeholder
  input.title = picker.hint
  const results = document.createElement('div')
  results.className = 'absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-x-hidden overflow-y-auto rounded-2xl border bg-surface-raised p-1.5 shadow-lg'
  results.hidden = true
  const err = document.createElement('p')
  err.id = 'err-' + s.key
  err.hidden = true
  err.setAttribute('role', 'alert')
  // Keep errors above the input so the absolute dropdown cannot cover them.
  err.className = 'mb-1 text-xs text-destructive'
  // No clear here: a successful add re-renders the adder, and the reject path
  // inside addTo sets a message this would wipe.
  const pick = (item) => { addTo(s.key, item); input.value = ''; results.hidden = true }
  const onDismiss = picker.wire(s, input, results, pick)
  // addEventListener, not input.oninput: every wireX assigns that property.
  input.addEventListener('input', () => clearFieldError(s.key))
  wireDropdown(wrap, input, results, onDismiss)
  wrap.append(input, results)
  const col = document.createElement('div')
  col.append(err, wrap)
  return col
}

function wireArtist(s, input, results, pick) {
  let timer, controller
  let generation = 0
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    setFieldError(s.key, 'Pick an artist from the search list, then press Down to reach it. Entries are pinned by Apple ID.')
  }
  input.oninput = () => {
    clearTimeout(timer)
    controller?.abort()
    const current = ++generation
    const fresh = () => current === generation && input.isConnected
    const q = input.value
    if (q.trim().length < 2) { results.hidden = true; return }
    // 500ms of debounce plus a request round trip, and this dropdown is the only
    // way to add an artist (Enter is refused above), so the wait needs a marker.
    noteRow(results, 'Searching…')
    timer = setTimeout(async () => { // 500ms: iTunes Search is ~20 req/min
      let found
      try {
        controller = new AbortController()
        const res = await fetch('/api/artist-search?q=' + encodeURIComponent(q), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
        if (!fresh()) return
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          if (!fresh()) return
          results.hidden = true
          setFieldError(s.key, body.error || 'Artist search failed (HTTP ' + res.status + ').')
          return
        }
        found = (await res.json()).results
        if (!Array.isArray(found)) throw new Error('search failed')
      } catch {
        if (!fresh() || controller?.signal.aborted) return
        results.hidden = true
        setFieldError(s.key, 'Artist search unavailable. The editor may have stopped; reopen prefs.command.')
        return
      }
      if (!fresh()) return
      if (!found.length) { noteRow(results, 'No artists found'); return }
      results.replaceChildren()
      for (const a of found) {
        let verify
        if (a.url) {
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
  return () => { clearTimeout(timer); controller?.abort(); generation++ }
}

// An onchange fallback would add a second, URL-named chip during a re-render.
function wirePlaylist(s, input, results, pick) {
  const taken = (pl) => getList(s.key).some((e) => e.url === pl.url)
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return
    const pl = parsePlaylist(input.value.trim())
    if (!pl) { setFieldError(s.key, 'Not an Apple Music playlist URL.'); return }
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
      resultRow(results, name, code + (code === '${US_STOREFRONT}' ? ' · albums top 50' : streamingOnly.has(code) ? ' · streaming only' : ''), () => pick(code))
    results.hidden = opts.length === 0
  }
  input.oninput = show
  input.onfocus = show
}

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
    for (const g of opts) resultRow(results, g, chartGenres[g.toLowerCase()] ? 'US chart' : '', () => pick(g))
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
let pollTimer, pollController
let polling = false
let offline = false
let logDismissed = false
$('log-hide').onclick = () => {
  logDismissed = true
  $('log-wrap').hidden = true
}
const BANNER_BASE = 'mb-3 rounded-xl px-4 py-2.5 text-sm'
const BANNER = {
  running: 'bg-foreground text-background',
  ok: 'bg-success-surface text-success-text',
  warn: 'bg-warning-surface text-warning-text',
  bad: 'border border-accent-foreground bg-accent text-accent-foreground',
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
  if (cls === 'bad' || cls === 'warn') $('editor-dock').scrollIntoView({ block: 'nearest' })
}

async function poll() {
  clearTimeout(pollTimer)
  if (polling || stopped) return
  polling = true
  pollController = new AbortController()
  const st = await fetch('/api/status', { signal: AbortSignal.any([pollController.signal, AbortSignal.timeout(10_000)]) })
    .then((r) => r.ok ? r.json() : null).catch(() => null)
  polling = false
  if (stopped) return
  if (st) {
    if (offline) { offline = false; setBanner(null); setStatus('') }
    $('refresh').disabled = st.busy || st.running || refreshStarting
    $('refresh').textContent = st.running ? 'Refreshing…' : 'Save & refresh'
    if (!statusHeld) setStatus(st.running ? '' : (st.log.at(-1) ?? ''))
    if (st.running && !wasRunning) logDismissed = false
    $('log-wrap').hidden = !st.running || logDismissed
    if (st.running) {
      $('log').textContent = st.log.join('\\n')
      $('log').scrollTop = $('log').scrollHeight
      setBanner('running', 'Refreshing. Usually about ${CLOUD_REFRESH ? 'five' : 'two'} minutes, longer if the site deploy needs a retry. Live progress above; safe to close this page, the refresh continues in the background.')
    } else if (wasRunning) {
      const publishedNew = st.log.some((l) => /Published/.test(l))
      const noChanges = st.log.some((l) => /No changes/.test(l))
      const held = st.log.some((l) => /HELD:/.test(l))
      const lostTrack = st.log.some((l) => /ERROR: lost track of the cloud run/.test(l))
      const neverRan = st.log.some((l) => /ERROR: fetch did not run/.test(l))
      const failed = st.log.some((l) => /ERROR:/.test(l))
      const warned = st.log.some((l) => /WARNING:/.test(l))
      const unpublished = st.log.some((l) => /UNPUBLISHED:/.test(l))
      const finished = publishedNew || noChanges || held || unpublished
      if (lostTrack) {
        setBanner('warn', 'The editor lost track of the cloud run, so its outcome is unknown. Check ' + LOG_HINT + '.')
      } else if (neverRan) {
        setBanner('bad', 'The update could not run, so nothing was published. Check config/preferences.json, then ' + LOG_HINT + '.')
      } else if (!finished) {
        setBanner('bad', 'The refresh stopped before it finished, so nothing was published. See ' + LOG_HINT + ' for what stopped it.')
      } else if (unpublished) {
        setBanner('warn', 'The results were kept locally. Publishing stopped because local commits or upstream history need attention.')
      } else if (held) {
        setBanner('warn', 'Nothing was published: there was no new data, and local commits touching other files are held back. Push them yourself if they are meant to go live.')
      } else if (failed) {
        setBanner('warn', 'Refresh finished, but a source failed. ' + (publishedNew ? 'Available results were published.' : 'Nothing new was published.') + (warned ? ' The site deploy did not confirm, so the page may still show old data.' : '') + ' Check ' + LOG_HINT + '.')
      } else if (warned) {
        setBanner('warn', 'New data was published, but the site deploy did not confirm. The page may show old data until the next update. See ' + LOG_HINT + '.')
      } else if (noChanges) {
        setBanner('ok', 'Refresh complete. Nothing new was found, so the site is unchanged.')
      } else {
        setBanner('ok', 'Refresh complete. The site shows the new data within a minute.')
      }
      reloadPrefs()
    }
    wasRunning = st.running
  } else if (!offline) {
    offline = true
    // Banner only: both it and #status are role="status", so writing the same
    // sentence to each in one tick has assistive tech read it twice.
    setBanner('bad', OFFLINE)
  }
  if (document.hidden && !st?.running) return
  pollTimer = setTimeout(poll, st?.running ? 2000 : 10000)
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { clearTimeout(pollTimer); poll() }
})

function save() {
  if (saving) return saving
  const revision = editRevision
  const snapshot = JSON.stringify(prefs)
  saving = (async () => {
    try {
      const r = await fetch('/api/prefs', { method: 'POST', body: snapshot, signal: AbortSignal.timeout(120_000) })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? 'HTTP ' + r.status)
      if (stopped) return false
      if (revision !== editRevision) {
        setStatus('Newer changes are still unsaved. Save again before refreshing.', true, true)
        return false
      }
      dirty = false
      $('save').disabled = true
      setBanner(null)
      if (body.pushed === false) {
        setStatus('Saved here, but not pushed: ' + body.reason, true, true)
        return true
      }
      setStatus('Saved.', false, true)
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        $('status').animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 350, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.25)' })
      }
      return true
    } catch (e) {
      if (stopped) return false
      const message = e instanceof TypeError || e.name === 'TimeoutError' || e.name === 'AbortError'
        ? 'The editor did not confirm the save. Keep this tab open, reopen prefs.command, then try Save again. Your edits are still here.'
        : 'Your changes were not saved. ' + e.message
      setBanner('bad', message)
      setStatus('Save failed.', true, true)
      return false
    } finally { saving = null }
  })()
  return saving
}
$('save').onclick = save
$('refresh').onclick = async () => {
  if (refreshStarting) return
  refreshStarting = true
  try {
    if (dirty && !(await save())) return
    if (stopped) return
    setBanner('running', 'Starting refresh')
    const r = await fetch('/api/refresh', { method: 'POST', signal: AbortSignal.timeout(300_000) })
    if (stopped) return
    if (r.status === 409) {
      setBanner('warn', 'Another operation is running. Wait for it to finish, then try again.')
      return
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}))
      if (stopped) return
      setBanner('bad', 'Could not start the refresh.')
      setStatus('Could not start the refresh: ' + (body.error || 'HTTP ' + r.status), true, true)
      return
    }
    wasRunning = true
    logDismissed = false
    poll()
  } catch {
    if (!stopped) setBanner('bad', OFFLINE)
  } finally { refreshStarting = false }
}
$('quit').onclick = async () => {
  // onbeforeunload can't guard this: quitting is a fetch plus an innerHTML
  // swap, not a navigation, so that handler never fires here.
  if (!confirm(dirty ? 'You have unsaved changes. Quit without saving them?' : 'Stop the editor? Reopen it with prefs.command.')) return
  dirty = false
  stopped = true
  pollController?.abort()
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
  prefs = {
    artists: p.artists, genres: p.genres, discovery: { countries: p.countries ?? [], playlists: p.playlists ?? [] },
    filters: { hide_alternate_versions: p.filters?.hide_alternate_versions !== false },
  }
  activity = p.activity ?? {}
  genreOptions = p.genreOptions ?? []
  genreCounts = p.genreCounts ?? {}
  sourceCounts = p.sourceCounts ?? {}
  countsAvailable = p.countsAvailable !== false
  countryNames = p.countryNames ?? {}
  historyDays = p.historyDays ?? 0
  streamingOnly = new Set(p.streamingOnly ?? [])
  chartGenres = p.chartGenres ?? {}
  renderAll()
}

function reloadPrefs() {
  if (dirty) return
  if ($('sections')?.contains(document.activeElement)) return
  const revision = editRevision
  fetch('/api/prefs', { signal: AbortSignal.timeout(15_000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => { if (p && !stopped && !dirty && revision === editRevision && !$('sections')?.contains(document.activeElement)) applyPrefs(p) })
    .catch(() => {})
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 's' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
  e.preventDefault()
  if (stopped || $('save').disabled) return
  save().then((ok) => { if (!ok) $('editor-dock').scrollIntoView({ block: 'nearest' }) })
})

fetch('/api/prefs', { signal: AbortSignal.timeout(15_000) }).then(async (r) => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status)
  return r.json()
}).then((p) => {
  if (stopped) return
  applyPrefs(p)
  poll()
}).catch((err) => {
  if (stopped) return
  // Build with DOM nodes, not innerHTML: the message carries the parser's text.
  const box = document.createElement('div')
  box.setAttribute('role', 'alert')
  box.className = 'py-4 text-sm text-destructive'
  const p1 = document.createElement('p')
  p1.textContent = 'Could not load preferences. Check that config/preferences.json is valid JSON, then reload this page.'
  const p2 = document.createElement('p')
  p2.className = 'mt-2 font-mono text-xs break-words'
  p2.textContent = String(err && err.message ? err.message : err)
  box.append(p1, p2)
  $('sections').replaceChildren(box)
  setStatus('Preferences did not load.', true, true)
  poll()
})
</script>
</body>
</html>`

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`The editor is already running at http://127.0.0.1:${PORT}`)
    process.exit(0)
  }
  console.error(`Could not start the preferences editor: ${e.message}`)
  process.exit(1)
})

export function start(port = PORT) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`Preferences editor: http://127.0.0.1:${server.address().port}`)
    syncUnderLock()
    if (CLOUD_REFRESH) pollCloud()
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start()
