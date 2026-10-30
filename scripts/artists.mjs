#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BusyError, acquireRunLock, holdRunLock } from './run-lock.mjs'
import { artistAlbumsUrl, errDetail, groupArtistLookup, itunesJSON, lookupUrl } from './apple-api.mjs'
import { BATCH_SIZE, DATA_PATH, PREFS_PATH, writeFileAtomic } from './shared.mjs'
import { publishPrefs, syncLocal } from './publish-prefs.mjs'

const CONTRACT = 'artists: list | associations | block | follow'
const USAGE = `${CONTRACT}
usage: node scripts/artists.mjs list --feed|--followed|--blocked [--offset N] [--limit N] [--json]
       node scripts/artists.mjs associations --id N [--id N ...] [--json]
       node scripts/artists.mjs block|follow N [N ...] [--json]`
// Apple returns at most this many collections per artist in one lookup.
const LOOKUP_LIMIT = 200

const die = (m) => { console.error(m); process.exit(1) }

const readJSON = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Could not read ${decodeURIComponent(String(p)).split('/').slice(-2).join('/')} (${e.message}).`)
    return fallback
  }
}

export function listArtists(mode) {
  const prefs = readJSON(PREFS_PATH, null)
  if (!prefs) throw new Error('config/preferences.json is missing.')
  const entries = (list) => (list ?? []).filter((e) => e?.id).map((e) => ({ id: e.id, name: e.name }))
  if (mode === 'followed') return entries(prefs.artists?.followed)
  if (mode === 'blocked') return entries(prefs.artists?.blocked)
  const skip = new Set([...(prefs.artists?.blocked ?? []), ...(prefs.artists?.followed ?? [])].map((e) => e.id))
  const feed = readJSON(DATA_PATH, { releases: [] })
  const seen = new Map()
  for (const r of [...(feed.releases ?? []), ...(feed.upcoming ?? [])]) {
    if (r.followed || !r.artist_id || skip.has(r.artist_id) || seen.has(r.artist_id)) continue
    seen.set(r.artist_id, { id: r.artist_id, name: r.artist })
  }
  return [...seen.values()]
}

// Variant editions (sped up, instrumental, clean/explicit twins) collapse to one title.
const titleKey = (name) =>
  (name ?? '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+[-–—]\s+.*$/, '').trim().toLowerCase()

async function lookupGroups(ids) {
  const groups = new Map()
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    const { groups: part, orphans } = groupArtistLookup((await itunesJSON(artistAlbumsUrl(batch, LOOKUP_LIMIT))).results)
    if (orphans) throw new Error(`${orphans} collections arrived before any artist record; lookup grouping changed`)
    for (const [id, g] of part) if (batch.includes(id)) groups.set(id, g)
  }
  return groups
}

async function artistNames(ids) {
  const found = new Map()
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const d = await itunesJSON(lookupUrl(ids.slice(i, i + BATCH_SIZE)))
    for (const r of d.results ?? []) if (r.wrapperType === 'artist') found.set(r.artistId, r.artistName)
  }
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length) throw new Error(`no Apple artist for ID ${missing.join(', ')}`)
  return found
}

export async function associations(ids) {
  const blocked = listArtists('blocked')
  // An album ID would be grouped under the previous artist record and misattribute its collection.
  await artistNames(ids.filter((id) => !blocked.some((b) => b.id === id)))
  const groups = await lookupGroups([...new Set([...ids, ...blocked.map((b) => b.id)])])
  return ids.map((id) => {
    const own = groups.get(id)?.albums ?? []
    const truncated = new Set(own.length >= LOOKUP_LIMIT ? [id] : [])
    const partners = []
    for (const b of blocked) {
      if (b.id === id) continue
      const theirs = groups.get(b.id)?.albums ?? []
      const ownIds = new Set(own.map((c) => c.collectionId).filter(Boolean))
      // A joint credit has its own artist ID but appears in both members' groups.
      const hits = [...theirs.filter((c) => c.artistId === id || ownIds.has(c.collectionId)), ...own.filter((c) => c.artistId === b.id)]
      if (theirs.length >= LOOKUP_LIMIT) truncated.add(b.id)
      if (!hits.length) continue
      const byTitle = new Map()
      for (const c of hits) {
        const key = titleKey(c.collectionName)
        const date = c.releaseDate?.slice(0, 10)
        if (!date) continue
        const prev = byTitle.get(key)
        if (!prev || date < prev.date) byTitle.set(key, { title: c.collectionName, date })
      }
      if (!byTitle.size) continue
      partners.push({ id: b.id, name: groups.get(b.id)?.name ?? b.name, shared: [...byTitle.values()].sort((x, y) => x.date.localeCompare(y.date)) })
    }
    return { id, name: groups.get(id)?.name ?? null, partners, truncated: [...truncated] }
  })
}

async function addTo(listKey, ids, asJSON) {
  const unique = [...new Set(ids)]
  let found
  try { found = await artistNames(unique) } catch (e) { die(`ERROR: ${errDetail(e)}; nothing was changed.`) }

  let lock
  try { lock = acquireRunLock('preferences') } catch (e) {
    die(`${e instanceof BusyError ? 'BUSY' : 'ERROR'}: ${e.message}`)
  }
  const added = [], skipped = []
  let published = null
  try {
    const p = JSON.parse(readFileSync(PREFS_PATH, 'utf8'))
    const list = p.artists[listKey]
    if (listKey === 'followed') {
      const blockedHits = unique.filter((id) => p.artists.blocked.some((e) => e.id === id))
      if (blockedHits.length) throw new Error(`ID ${blockedHits.join(', ')} is blocked, and a block overrides a follow; nothing was changed.`)
    }
    for (const id of unique) {
      const entry = { name: found.get(id), id }
      if (list.some((e) => e.id === id)) { skipped.push(entry); continue }
      list.push(entry)
      added.push(entry)
    }
    list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    if (added.length) {
      writeFileAtomic(PREFS_PATH, JSON.stringify(p, null, 2) + '\n')
      published = await publishPrefs()
    }
  } finally { lock.release() }
  // stderr, so --json output stays parseable
  if (published) console.error(published.pushed ? 'Pushed to GitHub.' : `WARNING: saved here, but not pushed: ${published.reason}`)
  const verb = listKey === 'blocked' ? 'Blocked' : 'Followed'
  if (asJSON) return console.log(JSON.stringify({ [listKey]: added, skipped }, null, 2))
  for (const e of added) console.log(`${verb}: ${e.name} (${e.id})`)
  for (const e of skipped) console.log(`Already ${verb.toLowerCase()}: ${e.name} (${e.id})`)
}

const integerArg = (raw, flag) => {
  const n = /^\d+$/.test(raw ?? '') ? Number(raw) : NaN
  if (!Number.isSafeInteger(n)) die(`${flag} needs a non-negative integer (${USAGE})`)
  return n
}

function parse(argv) {
  if (!argv.length) die(USAGE)
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0) }
  const [command, ...rest] = argv
  const opts = { command, json: false, modes: [], ids: [], offset: 0, limit: Infinity }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--json') opts.json = true
    else if (command === 'list' && ['--feed', '--followed', '--blocked'].includes(a)) opts.modes.push(a.slice(2))
    else if (command === 'list' && a === '--offset') opts.offset = integerArg(rest[++i], a)
    else if (command === 'list' && a === '--limit') opts.limit = integerArg(rest[++i], a)
    else if (command === 'associations' && a === '--id') opts.ids.push(integerArg(rest[++i], a))
    else if ((command === 'block' || command === 'follow') && /^\d+$/.test(a)) opts.ids.push(integerArg(a, command))
    else die(`unknown argument '${a}' (${USAGE})`)
  }
  if (!['list', 'associations', 'block', 'follow'].includes(command)) die(`unknown command '${command}' (${USAGE})`)
  if (command === 'list' && opts.modes.length !== 1) die(`list needs exactly one of --feed, --followed, --blocked (${USAGE})`)
  if (command !== 'list' && (!opts.ids.length || opts.ids.includes(0))) die(`${command} needs Apple artist IDs (${USAGE})`)
  return opts
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parse(process.argv.slice(2))
  try {
    if (opts.command === 'block' || opts.command === 'follow') await addTo(opts.command === 'block' ? 'blocked' : 'followed', opts.ids, opts.json)
    else {
      holdRunLock('audit')
      if (opts.command === 'list' && opts.modes[0] === 'feed') {
        const synced = await syncLocal()
        if (!synced.synced) console.error(`NOTE: local data not refreshed (${synced.reason}); the feed may be out of date`)
      }
      if (opts.command === 'list') {
        const rows = listArtists(opts.modes[0]).slice(opts.offset, opts.offset + opts.limit)
        if (opts.json) console.log(JSON.stringify(rows, null, 2))
        else for (const r of rows) console.log(`${r.id}\t${r.name}`)
      } else {
        const rows = await associations([...new Set(opts.ids)])
        if (opts.json) console.log(JSON.stringify(rows, null, 2))
        else for (const r of rows) console.log(`${r.name ?? r.id} (${r.id}): ${r.partners.map((p) => `${p.name} ×${p.shared.length}`).join(', ') || 'no shared releases'}${r.truncated.length ? ` · truncated ${r.truncated.join(', ')}` : ''}`)
      }
    }
  } catch (e) { die(`ERROR: ${e.message}`) }
}
