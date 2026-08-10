#!/usr/bin/env node
// Grade every source the preferences editor exposes, and suggest replacements.
// Read-only: it never edits config, it prints a report for a person to act on.
//
// Two rules this report is built around, printed with the recommendations at the
// end and explained in skills/audit-radar-sources/SKILL.md:
//
//   1. QUIET IS NOT DEAD — a feed with 0 entries is broken, a feed with 68 and
//      nothing recent is healthy and slow.
//   2. ABSENCE IS NOT ZERO — see sourceWindow in shared.mjs.
//
// Every feed URL, parser and pacer comes from apple-api.mjs, so this grades the
// feeds the pipeline reads rather than a copy that can drift.

import { readFileSync } from 'node:fs'
import { STOREFRONTS, STREAMING_ONLY, purchaseFeedsOf } from './storefronts.mjs'
import { GENRE_OPTIONS } from './genre-options.mjs'
import { fetchGenreTree, genreNamesById, underFollowed } from './genre-tree.mjs'
import {
  US_CHART_URL, albumIdFromTrackUrl, artistAlbumsUrl, asList, countryMostPlayedUrl,
  countryPurchaseUrl, errDetail, genreFeedUrl, getJSON, groupArtistLookup, itunesJSON,
  lookupUrl, marketingToolsJSON, normId, rssAlbumId, scrapeHTML, scrapePlaylistAlbumIds,
  sleep,
} from './apple-api.mjs'
import {
  BATCH_SIZE, DATA_PATH, GENRE_ACTIVITY_PATH, GENRE_FEEDS, LOOKUP_CHUNK, PACED_CALL_S,
  PREFS_PATH, REFRESH_LOG, REFRESH_PIDFILE, SOURCE_ACTIVITY_PATH, SOURCE_CHIP_DAYS,
  SOURCE_THIN_DAYS, daysSince, feedTypesOf, sourceTag, sourceWindow, windowIndices,
  withinDays,
} from './shared.mjs'

const USAGE = 'usage: node scripts/audit-sources.mjs [--no-discover] [--json]'
const die = (m) => { console.error(m); process.exit(1) }
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0) }
const unknown = argv.find((a) => a !== '--no-discover' && a !== '--json')
if (unknown) die(`unknown argument '${unknown}' (${USAGE})`)
const DISCOVER = !argv.includes('--no-discover')
const AS_JSON = argv.includes('--json')
const say = (...a) => { if (!AS_JSON) console.log(...a) }

// A fetch competing with a refresh would fight it for the same rate limit and
// read its half-written output. prefs-server owns this pidfile, so this catches
// an editor Save & Refresh; update.sh writes none, so the launchd nightly run is
// NOT caught here. EPERM means the pid was recycled (prefs-server clears it on
// that reading), so it is not a live refresh.
try {
  const pid = Number(readFileSync(REFRESH_PIDFILE, 'utf8').trim())
  if (pid) { process.kill(pid, 0); die(`A refresh is running (pid ${pid}). Let it finish, then run this again.`) }
} catch {}

// A missing file is a real "not yet"; a corrupt one is not. Falling back silently
// would report "0 day(s) of history" or "admitted: none" with no cause (rule 2).
const fileLabel = (p) => decodeURIComponent(String(p)).split('/').slice(-2).join('/')
const read = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) {
    if (e.code !== 'ENOENT') die(`Could not read ${fileLabel(p)} (${e.message}). Fix the file, then run this again.`)
    return fallback
  }
}
const PREFS = read(PREFS_PATH, null) ?? die('config/preferences.json is missing.')
const HIST = read(SOURCE_ACTIVITY_PATH, { days: [], sources: {} })
const GENRE_ACT = read(GENRE_ACTIVITY_PATH, {})
const FEED = read(DATA_PATH, { releases: [] })

const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)
// Politeness gap between legacy RSS probes; the fetcher staggers the same host.
const RSS_GAP_MS = 150

const followedGenres = PREFS.genres?.followed ?? []
const followedSet = new Set(followedGenres.map((g) => g.toLowerCase()))
const countries = PREFS.discovery?.countries ?? []
const playlists = PREFS.discovery?.playlists ?? []

// What the current file admitted through discovery; followed artists excluded for
// the reason fetch-releases.mjs gives where it writes the tally.
const admitted = {}
for (const r of FEED.releases ?? []) if (!r.followed && r.genre) admitted[r.genre] = (admitted[r.genre] ?? 0) + 1

// ---------- history windows ----------

// Index sets hoisted: sourceWindow is called twice per source, so re-walking the
// date array each time repeats one projection across every source.
const IDX7 = windowIndices(HIST, 7)
const IDX30 = windowIndices(HIST, SOURCE_CHIP_DAYS)
// consecutive measured days with zero yield, most recent first; nulls skipped
function zeroStreak(tag) {
  const col = HIST.sources[tag] ?? []
  let n = 0
  for (let i = col.length - 1; i >= 0; i--) {
    if (col[i] == null) continue
    if (col[i][0] === 0) n++
    else break
  }
  return n
}
const lastYield = (tag) => {
  const col = HIST.sources[tag] ?? []
  for (let i = col.length - 1; i >= 0; i--) if (col[i] && col[i][0] > 0) return HIST.days[i]
  return null
}
const historyDays = HIST.days.length
const THIN = historyDays < SOURCE_THIN_DAYS

// ---------- live probes ----------

// Liveness is deliberately separate from yield: entries answers "is this feed
// alive at all", newest answers "does it carry anything recent".
async function rssLiveness(url) {
  try {
    const d = await getJSON(url)
    const rows = asList(d.feed?.entry)
    const dates = rows.map((x) => x['im:releaseDate']?.label).filter(Boolean).sort()
    return { entries: rows.length, newest: dates.at(-1)?.slice(0, 10) ?? null, rows, ok: true }
  } catch (e) { return { ok: false, err: errDetail(e) } }
}
async function mtLiveness(url) {
  try {
    const d = await marketingToolsJSON(url)
    const r = d.feed?.results ?? []
    const dates = r.map((x) => x.releaseDate).filter(Boolean).sort()
    return { entries: r.length, newest: dates.at(-1)?.slice(0, 10) ?? null, results: r, ok: true }
  } catch (e) { return { ok: false, err: errDetail(e) } }
}

// A source's purchase feeds rolled into one set of numbers. Every RSS probe in the
// report goes through this, so the day thresholds cannot differ between the
// configured rows and the candidates.
async function probeRss(feeds) {
  const idSet = new Set()
  let entries = 0, newest = null, fresh = 0, ok = true, err = null
  for (const { url, ft } of feeds) {
    const l = await rssLiveness(url)
    if (!l.ok) { ok = false; err = l.err; continue }
    entries += l.entries
    if (!newest || (l.newest && l.newest > newest)) newest = l.newest
    for (const e of l.rows) {
      const d = e['im:releaseDate']?.label
      const id = rssAlbumId(e, ft)
      if (!id || !withinDays(d, OVERLAP_DAYS)) continue
      idSet.add(String(id))
      if (withinDays(d, FRESH_DAYS)) fresh++
    }
    await sleep(RSS_GAP_MS)
  }
  return { ok, entries, newest, err, idSet, fresh }
}

const lookupCache = new Map()
async function lookup(ids) {
  const uniq = [...new Set(ids.map(String))]
  const want = uniq.filter((i) => /^\d+$/.test(i) && !lookupCache.has(i))
  for (let i = 0; i < want.length; i += LOOKUP_CHUNK) {
    try {
      const d = await itunesJSON(lookupUrl(want.slice(i, i + LOOKUP_CHUNK)))
      for (const r of (d.results ?? []).filter((x) => x.wrapperType === 'collection')) lookupCache.set(String(r.collectionId), r)
    } catch { /* a miss degrades one row, never the report */ }
  }
  return uniq.map((i) => lookupCache.get(i)).filter(Boolean)
}

// Estimated paced-lookup seconds this source costs per run — the price side of
// the value/price ratio. Sources pool their ids into shared chunks, so this is a
// fair share rather than an exact bill; for playlists it is close to exact.
const costS = (ids) => (ids / LOOKUP_CHUNK) * PACED_CALL_S

const out = { generated: new Date().toISOString(), historyDays, sections: {}, recommend: [] }
const rec = (action, target, why, confidence = 'firm') => out.recommend.push({ action, target, why, confidence })

say(`Source audit — ${historyDays} day(s) of recorded history` + (THIN ? '  (THIN: windows below lean on live probes)' : ''))
if (DISCOVER) say('Discovery on; this takes a few minutes. --no-discover for the fast pass.\n')
else say('')

// ---------- artists ----------

say('=== FOLLOWED ARTISTS ===')
const artists = (PREFS.artists?.followed ?? []).filter((a) => a?.id)
const blockedIds = new Set((PREFS.artists?.blocked ?? []).map((b) => b?.id).filter(Boolean))
const artistRows = []
{
  const seen = new Map()
  for (const a of PREFS.artists?.followed ?? []) {
    if (!a?.id) { rec('FIX', `artist "${a?.name ?? a}"`, 'no Apple ID, so the sweep skips it entirely'); continue }
    if (seen.has(a.id)) rec('FIX', `artist ${a.name}`, `duplicate of "${seen.get(a.id)}" (same Apple ID ${a.id})`)
    else seen.set(a.id, a.name)
    if (blockedIds.has(a.id)) rec('FIX', `artist ${a.name}`, 'on the follow AND block lists; block wins, so the follow does nothing')
  }
  for (let i = 0; i < artists.length; i += BATCH_SIZE) {
    const batch = artists.slice(i, i + BATCH_SIZE)
    let results = []
    try {
      // limit=200, not the fetcher's 100: limit is per artist and prolific artists
      // hit the cap, which would silently undercount exactly the busiest ones
      const d = await itunesJSON(artistAlbumsUrl(batch.map((a) => a.id), 200))
      results = d.results ?? []
    } catch (e) { say(`  batch ${i / BATCH_SIZE + 1} failed (${errDetail(e)}) — those artists are unrated below`); continue }
    const { groups: per, orphans } = groupArtistLookup(results)
    // The fetcher exits 2 on this; here it only skews a row, but dropping it
    // silently would undercount exactly the artists being graded.
    if (orphans) say(`  ${orphans} collections arrived before any artist record — lookup grouping changed?`)
    for (const a of batch) {
      const hit = per.get(a.id)
      if (!hit) { artistRows.push({ ...a, dead: true }); continue }
      // one accumulating pass: 7d ⊂ 30d ⊂ 365d, and each withinDays parses a date
      const past = hit.albums.map((x) => x.releaseDate).filter((d) => d && daysSince(d) >= 0).sort()
      let d7 = 0, d30 = 0, d365 = 0
      for (const d of past) {
        if (!withinDays(d, 365)) continue
        d365++
        if (!withinDays(d, 30)) continue
        d30++
        if (withinDays(d, 7)) d7++
      }
      artistRows.push({
        ...a, appleName: hit.name, capped: hit.albums.length >= 200,
        d7, d30, d365, last: past.at(-1)?.slice(0, 10) ?? null,
      })
    }
  }
  const dead = artistRows.filter((r) => r.dead)
  const renamed = artistRows.filter((r) => r.appleName && r.appleName !== r.name)
  const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  const realRenames = renamed.filter((r) => norm(r.appleName) !== norm(r.name))
  const active = artistRows.filter((r) => !r.dead)
  const dormant = active.filter((r) => !r.last || daysSince(r.last) > 365).sort((a, b) => (a.last ?? '').localeCompare(b.last ?? ''))
  say(`  ${artistRows.length} followed, ${active.filter((r) => r.d30 > 0).length} released in the last 30d, ${active.filter((r) => r.d365 > 0).length} in the last year`)
  if (artistRows.some((r) => r.capped)) say(`  ${artistRows.filter((r) => r.capped).length} hit the 200-album cap; their yearly counts read as at-least`)
  for (const r of dead) rec('FIX', `artist ${r.name} (${r.id})`, 'Apple returns no record for this ID — deleted or merged, so it can never match again')
  for (const r of realRenames) rec('FIX', `artist ${r.name}`, `Apple now calls this artist "${r.appleName}" — rename locally so the chip matches`)
  if (dead.length) say(`  ${dead.length} ID(s) no longer resolve`)
  if (realRenames.length) say(`  ${realRenames.length} renamed on Apple`)
  say(`  ${dormant.length} with no release in over a year (curation, not cost — the sweep is batched)`)
  for (const r of dormant.slice(0, 8)) say(`    ${pad(r.name, 24)} last ${r.last ?? 'never'}`)
  if (dormant.length > 8) say(`    …and ${dormant.length - 8} more (see --json)`)
  out.sections.artists = artistRows
}

// ---------- genres ----------

say('\n=== FOLLOWED GENRES ===')
let ancestors = null, byId = null
try {
  const tree = await fetchGenreTree()
  ancestors = tree.ancestors
  byId = genreNamesById(tree.music)
  for (const [names, label] of [[GENRE_OPTIONS, 'picker'], [followedGenres, 'followed']]) {
    for (const n of names) if (!ancestors.has(n)) rec('FIX', `genre "${n}" (${label})`, 'no longer exists in Apple\'s tree — renamed, and exact matching means it now matches nothing')
  }
  // a GENRE_FEEDS id whose tag disagrees with Apple's own name for it
  for (const f of GENRE_FEEDS) {
    const real = byId.get(String(f.genreId))
    if (real && real !== f.tag) rec('FIX', `genre feed ${f.genreId}`, `tagged "${f.tag}" but Apple calls id ${f.genreId} "${real}"`)
  }
  say(`  names checked against Apple's live tree: ${GENRE_OPTIONS.length} picker, ${followedGenres.length} followed`)
} catch (e) { say(`  genre tree unavailable (${e.message}) — name checks skipped this run`) }

{
  const cold = followedGenres.filter((g) => !Object.keys(admitted).some((k) => k.toLowerCase() === g.toLowerCase()))
  say(`  admitted in the current file: ${Object.entries(admitted).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(', ') || 'none'}`)
  if (cold.length) say(`  no releases in the current file: ${cold.join(', ')}  (one day's data — not a prune signal)`)
  // leaf genres the filter is costing you, the check-genres logic
  if (ancestors) {
    const leaves = [], unrelated = []
    for (const [g, d] of Object.entries(GENRE_ACT)) {
      if (followedSet.has(g.toLowerCase())) continue
      const umbrella = underFollowed(ancestors, followedSet, g)
      ;(umbrella ? leaves : unrelated).push([g, d, umbrella])
    }
    leaves.sort((a, b) => b[1].dropped - a[1].dropped)
    for (const [g, d, umbrella] of leaves) {
      rec('ADD', `genre "${g}"`, `${d.dropped} dropped, filed by Apple under ${umbrella} which you already follow (e.g. ${d.example})`)
    }
    if (unrelated.length) say(`  dropped but unrelated to your follows: ${unrelated.map(([g, d]) => `${g} ${d.dropped}`).join(', ')}`)
  }
  out.sections.genres = { admitted, cold }
}

// ---------- configured sources ----------

// Every source keeps the set of collection ids it carried in the last 14 days.
// Overlap is computed from these sets, so redundancy is answerable on day one —
// history only tells you about yield, and takes a fortnight to say anything.
const OVERLAP_DAYS = 14
// Window the per-source cost estimate prices: only day-of arrivals cost a lookup.
const FRESH_DAYS = 3
// Redundancy needs a real sample. A storefront with one recent release whose single
// id happens to appear elsewhere is QUIET, not redundant — calling that clutter is
// the same quiet-versus-dead mistake in a new place. Below this, say so and move on.
const MIN_REDUNDANCY_SAMPLE = 5
const rows = []

// Measuring is minutes of paced calls before the first row can be printed, so
// name each source as it goes. stderr, so --json's stdout stays one parseable
// dump and a redirect keeps only the report.
const progress = (m) => process.stderr.write(`  … ${m}\n`)

say('\n=== SOURCES ===')
say(
  `  ${pad('source', 32)}${lpad('7d', 5)}${lpad('30d', 6)}${lpad('u30', 5)}  ` +
  `${lpad('14d', 5)}${lpad('uniq', 6)}  ${pad('most shared with', 22)}${lpad('zero', 5)}${lpad('fail', 5)}  ` +
  `${pad('liveness', 32)}cost`
)

// always-scanned: US chart + genre feeds. most-played/albums serialises the
// collection id directly; the songs feeds only expose it inside the track URL.
{
  progress('US most-played chart')
  const l = await mtLiveness(US_CHART_URL)
  const idSet = new Set((l.results ?? []).filter((e) => withinDays(e.releaseDate, OVERLAP_DAYS)).map((e) => normId(e.id)).filter(Boolean))
  const fresh = (l.results ?? []).filter((e) => withinDays(e.releaseDate, FRESH_DAYS)).length
  rows.push({ kind: 'chart', tag: sourceTag('chart', 'us'), label: 'US most-played chart', live: l, idSet, cost: costS(fresh) })
}
for (const f of GENRE_FEEDS) {
  progress(`genre feed ${f.tag}`)
  const fts = feedTypesOf(f)
  const p = await probeRss(fts.map((ft) => ({ url: genreFeedUrl(ft, f.genreId), ft })))
  rows.push({
    kind: 'genre', tag: sourceTag('genre', f.tag), label: f.tag, sub: fts.join('+'),
    live: { ok: p.ok, entries: p.entries, newest: p.newest, err: p.err }, idSet: p.idSet, cost: costS(p.fresh),
  })
}
for (const sf of countries) {
  progress(`country ${STOREFRONTS[sf] ?? sf}`)
  const p = await probeRss(purchaseFeedsOf(sf).map((ft) => ({ url: countryPurchaseUrl(sf, ft), ft })))
  let { ok, entries, newest, err, idSet, fresh } = p
  const mp = await mtLiveness(countryMostPlayedUrl(sf))
  if (mp.ok) {
    entries += mp.entries
    if (!newest || (mp.newest && mp.newest > newest)) newest = mp.newest
    for (const e of mp.results ?? []) {
      const id = albumIdFromTrackUrl(e.url)
      if (!id || !withinDays(e.releaseDate, OVERLAP_DAYS)) continue
      idSet.add(String(id))
      if (withinDays(e.releaseDate, FRESH_DAYS)) fresh++
    }
  } else { ok = false; err = mp.err }
  rows.push({
    kind: 'country', tag: sourceTag('country', sf), label: STOREFRONTS[sf] ?? sf,
    sub: sf + (STREAMING_ONLY.has(sf) ? ' streaming-only' : ''),
    live: { ok, entries, newest, err }, idSet, cost: costS(fresh),
  })
}
// Scraped first, then ONE pooled lookup: a per-playlist call each burned a paced
// slot on a partial chunk, where the union of every list fills whole ones. The
// per-playlist calls below then resolve from cache, keeping their own rows.
const plPages = []
for (const pl of playlists) {
  progress(`playlist ${pl.name}`)
  try { plPages.push({ pl, ids: (await scrapePlaylistAlbumIds(pl.url)).albumIds }) }
  catch (e) { plPages.push({ pl, err: errDetail(e) }) }
}
await lookup(plPages.flatMap((p) => p.ids ?? []))
for (const { pl, ids, err } of plPages) {
  const tag = sourceTag('playlist', pl.name)
  if (err) { rows.push({ kind: 'playlist', tag, label: pl.name, live: { ok: false, err }, idSet: new Set(), cost: 0 }); continue }
  const hits = await lookup(ids)
  const fresh30 = hits.filter((a) => withinDays(a.releaseDate, 30)).length
  const newest = hits.map((a) => a.releaseDate).filter((d) => d && daysSince(d) >= 0).sort().at(-1)?.slice(0, 10) ?? null
  rows.push({
    kind: 'playlist', tag, label: pl.name, sub: `${ids.length} albums`,
    live: { ok: true, entries: ids.length, newest },
    density: hits.length ? fresh30 / hits.length : 0,
    idSet: new Set(hits.filter((a) => withinDays(a.releaseDate, OVERLAP_DAYS)).map((a) => String(a.collectionId))),
    cost: costS(ids.length),
  })
}

// Live overlap across everything configured. Only sources whose probe SUCCEEDED
// count as cover — otherwise a source that merely failed to load would make its
// neighbours look redundant, which is how a probe failure turns into bad advice.
const measured = rows.filter((r) => r.live.ok)
// One pass over every id, so a row's uniqueness reads off a shared tally rather
// than rebuilding the union of all other sources per row.
const carriers = new Map()
for (const r of measured) for (const i of r.idSet) carriers.set(i, (carriers.get(i) ?? 0) + 1)
for (const r of rows) {
  const mine = [...r.idSet]
  const own = r.live.ok ? 1 : 0
  r.liveUnique = mine.filter((i) => (carriers.get(i) ?? 0) - own === 0).length
  let best = null
  for (const o of measured) {
    if (o === r || !mine.length) continue
    const shared = mine.filter((i) => o.idSet.has(i)).length
    if (shared && (!best || shared / mine.length > best.frac)) best = { label: o.label, frac: shared / mine.length }
  }
  r.near = best
}

for (const r of rows) {
  const w7 = sourceWindow(HIST, r.tag, IDX7), w30 = sourceWindow(HIST, r.tag, IDX30)
  Object.assign(r, { w7, w30, zero: zeroStreak(r.tag), last: lastYield(r.tag) })
  const liveTxt = !r.live.ok
    ? 'PROBE FAILED'
    : r.live.entries === 0
      ? 'no entries (dead)'
      : `${r.live.entries} entries, newest ${r.live.newest ?? '-'}`
  const nearTxt = r.near ? `${r.near.label.slice(0, 14)} ${Math.round(r.near.frac * 100)}%` : '-'
  const hist = THIN && r.w30.measured === 0 ? '  collecting' : ''
  say(
    `  ${pad(r.label + (r.sub ? ` (${r.sub})` : ''), 32)}${lpad(r.w7.surfaced, 5)}${lpad(r.w30.surfaced, 6)}${lpad(r.w30.unique, 5)}  ` +
    `${lpad(r.idSet.size, 5)}${lpad(r.liveUnique, 6)}  ${pad(nearTxt, 22)}${lpad(r.zero || '-', 5)}${lpad(r.w30.failed || '-', 5)}  ` +
    `${pad(liveTxt, 32)}${r.cost.toFixed(1)}s${hist}`
  )
}
say('  14d/uniq are live overlap and work today; 7d/30d/u30 need ~2 weeks of history.')
out.sections.sources = rows.map(({ idSet, ...r }) => ({ ...r, liveIds: idSet.size }))

// Verdicts. Redundancy is judged live; yield waits for history. The two are never
// mixed, because a source can be non-redundant and still not worth its cost.
for (const r of rows) {
  if (!r.live.ok) { rec('CHECK', r.label, `liveness probe failed (${r.live.err}) — unknown, not dead; re-run before concluding anything`, 'thin'); continue }
  if (r.live.entries === 0) {
    rec('REMOVE', r.label, 'the feed returns no entries at all — structurally dead, not merely quiet')
  } else if (r.idSet.size >= MIN_REDUNDANCY_SAMPLE && r.liveUnique === 0) {
    rec('REMOVE', r.label, `all ${r.idSet.size} of its releases in ${OVERLAP_DAYS}d are carried by other sources` + (r.near ? ` (${Math.round(r.near.frac * 100)}% by ${r.near.label} alone)` : '') + ' — redundant')
  } else if (r.idSet.size > 0 && r.liveUnique === 0) {
    rec('CHECK', r.label, `nothing unique in ${OVERLAP_DAYS}d, but only ${r.idSet.size} release(s) to judge on` + (r.near ? ` (covered by ${r.near.label})` : '') + ' — too quiet to call redundant', 'thin')
  } else if (r.kind === 'playlist' && r.density != null && r.density < 0.2 && r.live.entries > 20) {
    rec('REPLACE', r.label, `only ${Math.round(r.density * 100)}% of its albums came out in the last 30 days — a stale list, not a new-release list`)
  } else if (historyDays >= 14 && r.w30.measured >= 10 && r.w30.surfaced === 0) {
    rec('REMOVE', r.label, `nothing across ${r.w30.measured} measured days, though the feed is alive (newest ${r.live.newest})`)
  } else if (r.w30.surfaced === 0 && historyDays < 14) {
    rec('CHECK', r.label, 'no yield yet, but history is too short to judge', 'thin')
  }
}

// ---------- blocked ----------

{
  const blocked = PREFS.artists?.blocked ?? []
  let fired = null // null, not 0: an unreadable log has measured nothing
  let logErr = null
  try {
    const log = readFileSync(REFRESH_LOG, 'utf8')
    fired = new Set([...log.matchAll(/dropped: (.+?) — .+? \(artist blocked\)/g)].map((m) => m[1])).size
  } catch (e) {
    logErr = e.message
  }
  const firing = fired === null
    ? `log unavailable (${logErr}), so none counted`
    : `${fired} seen firing in the retained log`
  say(`\n=== BLOCKED ARTISTS ===\n  ${blocked.length} blocked, ${firing}. Blocks are a pure filter and cost no fetch time, so a quiet one is not waste.`)
  out.sections.blocked = { count: blocked.length, fired }
}

// ---------- candidates ----------

if (DISCOVER) {
  say('\n=== CANDIDATES ===')
  // The comparison set is EVERYTHING already configured — countries, playlists,
  // genre feeds and the US chart. Comparing only against other countries' purchase
  // charts overstates every candidate, because a release the pipeline already finds
  // via a playlist would still count as "new".
  const covered = new Set(carriers.keys())
  const coverOf = (ids) => {
    let best = null
    for (const r of measured) {
      const n = [...ids].filter((i) => r.idSet.has(i)).length
      if (n && (!best || n > best.n)) best = { label: r.label, n }
    }
    return best
  }

  const unselected = Object.keys(STOREFRONTS).filter((c) => !countries.includes(c))
  const sfScores = []
  for (const sf of unselected) {
    // purchaseFeedsOf, like the configured rows: probing feeds a storefront cannot
    // have would grade it on evidence that could never exist.
    const p = await probeRss(purchaseFeedsOf(sf).map((ft) => ({ url: countryPurchaseUrl(sf, ft), ft })))
    const additive = [...p.idSet].filter((i) => !covered.has(i))
    sfScores.push({ sf, name: STOREFRONTS[sf], ok: p.ok, entries: p.entries, recent: p.idSet.size, additive: additive.length, ids: p.idSet, addIds: additive })
  }

  // Genre mix of what a candidate would ADD, against what the file already carries.
  const heavy = new Set(Object.entries(admitted).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g))
  const ranked = sfScores.filter((s) => s.ok).sort((a, b) => b.additive - a.additive)
  const TOP = 6
  const shortSf = ranked.slice(0, TOP)
  const mixHits = await lookup(shortSf.flatMap((s) => s.addIds))
  const genreOf = new Map(mixHits.map((a) => [String(a.collectionId), a.primaryGenreName]))
  for (const s of shortSf) {
    const gs = s.addIds.map((i) => genreOf.get(i)).filter(Boolean)
    const mix = {}
    for (const g of gs) mix[g] = (mix[g] ?? 0) + 1
    s.mix = Object.entries(mix).sort((a, b) => b[1] - a[1])
    s.skew = gs.length ? gs.filter((g) => heavy.has(g)).length / gs.length : 0
  }

  say(`  storefronts you do NOT scan, ranked by what they would add over everything already configured (${OVERLAP_DAYS}d):`)
  for (const s of shortSf) {
    const mixTxt = s.mix?.length ? s.mix.slice(0, 3).map(([g, n]) => `${g} ${n}`).join(', ') : 'genres unresolved'
    say(`    ${pad(s.name, 18)}${lpad(s.recent, 4)} recent${lpad(s.additive, 5)} additive   ${mixTxt}${s.skew > 0.6 ? '   [deepens existing skew]' : ''}`)
  }
  for (const s of shortSf) {
    if (s.additive < 8) continue
    if (s.skew > 0.6) { rec('CHECK', `country ${s.name} (${s.sf})`, `${s.additive} additive in ${OVERLAP_DAYS}d, but ${Math.round(s.skew * 100)}% of it is genres already dominating the page — volume without balance`, 'thin'); continue }
    rec('ADD', `country ${s.name} (${s.sf})`, `${s.additive} releases in ${OVERLAP_DAYS}d that nothing already configured surfaced` + (s.mix?.length ? ` (${s.mix.slice(0, 2).map(([g, n]) => `${g} ${n}`).join(', ')})` : ''))
  }

  // Picker pruning, the other half of the same measurement: an option that would
  // add nothing can never be worth choosing. Same ok-and-non-empty gate as measured.
  const alive = sfScores.filter((s) => s.ok && s.entries > 0)
  const deadWeight = alive.filter((s) => s.recent >= MIN_REDUNDANCY_SAMPLE && s.additive === 0)
  const tooQuiet = alive.filter((s) => s.recent > 0 && s.recent < MIN_REDUNDANCY_SAMPLE && s.additive === 0)
  const unknown = sfScores.filter((s) => !s.ok || s.entries === 0)
  if (deadWeight.length) {
    say('\n  picker options that would add nothing over the current set:')
    for (const s of deadWeight) {
      const by = coverOf(s.ids)
      say(`    ${pad(s.name, 18)}${lpad(s.recent, 4)} recent, 0 additive   covered by ${by?.label ?? 'the current set'}`)
      rec('REMOVE', `picker option ${s.name} (${s.sf})`, `${s.recent} releases in ${OVERLAP_DAYS}d, none of them new to you` + (by ? ` — ${by.label} alone carries ${by.n}` : '') + '. Clutter in the country picker.')
    }
  }
  if (tooQuiet.length) say(`\n  ${tooQuiet.length} storefront(s) with nothing unique but under ${MIN_REDUNDANCY_SAMPLE} recent releases: ${tooQuiet.map((s) => s.sf).join(', ')} — too quiet to call redundant`)
  if (unknown.length) say(`\n  ${unknown.length} storefront(s) unmeasured this run (probe failed or empty): ${unknown.map((s) => s.sf).join(', ')} — unknown, not redundant`)
  out.sections.candidateCountries = sfScores.map(({ ids, addIds, ...r }) => r)

  // candidate playlists, discovered from Apple's own search for your genres
  const configuredUrls = new Set(playlists.map((p) => p.url))
  const SKIP = /essentials|set-list|hits-\d|karaoke|love-songs|throwback|best-of|rewind|videos|top-100|top-25/
  const perGenre = new Map()
  const found = new Map()
  const searchFailed = []
  for (const g of followedGenres) {
    const mine = []
    try {
      const html = await scrapeHTML(`https://music.apple.com/us/search?term=${encodeURIComponent(g)}`)
      for (const m of html.matchAll(/music\.apple\.com\/us\/playlist\/([a-z0-9-]+)\/(pl\.[a-z0-9]+)/g)) {
        if (SKIP.test(m[1])) continue
        const url = `https://music.apple.com/us/playlist/${m[1]}/${m[2]}`
        if (configuredUrls.has(url) || found.has(url)) continue
        found.set(url, m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
        mine.push(url)
      }
    } catch {
      searchFailed.push(g) // a failed search is not "this genre has no playlists"
    }
    perGenre.set(g, mine)
    await sleep(200)
  }
  if (searchFailed.length) say(`\n  ${searchFailed.length} genre search(es) failed, so their candidates are unmeasured: ${searchFailed.join(', ')}`)
  // Bounded on purpose, and said out loud: scoring each one costs paced lookups.
  // Round-robin across genres rather than taking the first N found — searching
  // genres in order and slicing meant every candidate came from the first genre.
  const CAP = 12
  const shortlist = []
  for (let round = 0; shortlist.length < CAP; round++) {
    let added = false
    for (const g of followedGenres) {
      const url = perGenre.get(g)?.[round]
      if (!url) continue
      added = true
      shortlist.push([url, found.get(url)])
      if (shortlist.length >= CAP) break
    }
    if (!added) break
  }
  say(`\n  candidate playlists: ${found.size} found, scoring ${shortlist.length}${found.size > CAP ? ` (capped at ${CAP}; the rest are unscored)` : ''}`)
  // Same pooling as the configured playlists: scrape all, then one lookup.
  const candPages = []
  const scrapeFailed = []
  for (const [url, name] of shortlist) {
    try {
      const ids = (await scrapePlaylistAlbumIds(url)).albumIds
      if (ids.length) candPages.push({ url, name, ids })
      else scrapeFailed.push(name) // reachable but no ids parsed: shape changed
    } catch {
      scrapeFailed.push(name)
    }
  }
  if (scrapeFailed.length) say(`  ${scrapeFailed.length} shortlisted playlist(s) could not be read, so they are unscored: ${scrapeFailed.join(', ')}`)
  await lookup(candPages.flatMap((p) => p.ids))
  const plScores = []
  for (const { url, name, ids } of candPages) {
    const hits = await lookup(ids)
    if (!hits.length) continue
    const d30 = hits.filter((a) => withinDays(a.releaseDate, 30)).length
    const recent = hits.filter((a) => withinDays(a.releaseDate, OVERLAP_DAYS)).map((a) => String(a.collectionId))
    const addIds = new Set(recent.filter((i) => !covered.has(i)))
    const gs = hits.filter((a) => addIds.has(String(a.collectionId))).map((a) => a.primaryGenreName).filter(Boolean)
    const skew = gs.length ? gs.filter((g) => heavy.has(g)).length / gs.length : 0
    plScores.push({ name, url, albums: ids.length, density: d30 / hits.length, additive: addIds.size, recent: recent.length, skew, cost: costS(ids.length) })
  }
  plScores.sort((a, b) => b.additive - a.additive || b.density - a.density)
  for (const p of plScores) {
    say(`    ${pad(p.name.slice(0, 24), 26)}${lpad(p.albums, 4)} albums  ${lpad(Math.round(p.density * 100) + '%', 5)} fresh(30d)${lpad(p.additive, 5)} additive  ${p.cost.toFixed(1)}s`)
  }
  // Same gate as everything else, storefronts included: freshness alone is not
  // enough, and volume that only deepens the dominant genres is not an improvement.
  for (const p of plScores.slice(0, 3)) {
    if (!(p.density > 0.4 && p.additive >= 3)) continue
    if (p.skew > 0.6) {
      rec('CHECK', `playlist "${p.name}"`, `${p.additive} additive and ${Math.round(p.density * 100)}% fresh, but ${Math.round(p.skew * 100)}% of what it adds is genres already dominating the page — ${p.url}`, 'thin')
      continue
    }
    rec('ADD', `playlist "${p.name}"`, `${p.additive} of its ${p.recent} recent releases are new to you, ${Math.round(p.density * 100)}% of the list is from the last 30 days — ${p.url}`)
  }
  out.sections.candidatePlaylists = plScores

  // followed genres with no US feed pointed at them, checked against the parent
  // that IS scanned — a leaf under a scanned umbrella typically adds ~1 a fortnight
  if (byId && ancestors) {
    const scanned = new Map(GENRE_FEEDS.map((f) => [f.tag, f.genreId]))
    const missing = followedGenres.filter((g) => !scanned.has(g))
    const idFor = new Map([...byId.entries()].map(([id, n]) => [n.toLowerCase(), id]))
    say('\n  followed genres with no dedicated US feed:')
    for (const g of missing) {
      const id = idFor.get(g.toLowerCase())
      if (!id) { say(`    ${pad(g, 20)} no id in Apple's tree`); continue }
      const parentTag = (ancestors.get(g) ?? []).find((a) => scanned.has(a))
      const p = await probeRss([{ url: genreFeedUrl('topsongs', id), ft: 'topsongs' }])
      if (!p.ok || p.entries <= 20) { say(`    ${pad(g, 20)} id ${pad(id, 8)} feed thin or dead`); continue }
      const addl = [...p.idSet].filter((i) => !covered.has(i)).length
      say(`    ${pad(g, 20)} id ${pad(id, 8)} ${lpad(p.entries, 3)} entries  newest ${p.newest}  ${lpad(p.idSet.size, 2)} ids/${OVERLAP_DAYS}d  ${addl} additive${parentTag ? `   (parent ${parentTag} already scanned)` : '   (no parent scanned)'}`)
      if (addl >= 3) rec('ADD', `genre feed ${id} (${g})`, `${addl} of its ${p.idSet.size} recent releases are new to you${parentTag ? `, despite ${parentTag} already being scanned` : ' and no parent feed covers it'}`)
      else if (parentTag) say(`      not recommended: ${parentTag} already carries all but ${addl}`)
    }
  }
}

// ---------- recommendations ----------

say('\n=== RECOMMENDATIONS ===')
if (!out.recommend.length) say('  Nothing to change.')
const order = { REMOVE: 0, REPLACE: 1, ADD: 2, FIX: 3, CHECK: 4 }
for (const r of out.recommend.sort((a, b) => order[a.action] - order[b.action])) {
  say(`  ${pad(r.action, 8)}${pad(r.target, 34)}${r.why}${r.confidence === 'thin' ? '   [thin evidence]' : ''}`)
}
say(
  '\n  Removal is only ever justified by a feed being structurally dead or fully' +
  '\n  redundant. A quiet source is not a dead one. Anything marked [thin evidence]' +
  '\n  needs more history or a re-probe before you act on it.'
)
if (THIN) say(`\n  Only ${historyDays} day(s) of history so far. The 7d/30d columns will mean much\n  more after a couple of weeks of nightly runs.`)

if (AS_JSON) console.log(JSON.stringify(out, null, 2))
