#!/usr/bin/env node
// Two checks against Apple's live genre tree:
//
// 1. Every curated and followed genre name still EXISTS. Apple renames genres
//    (Regional Mexicano became Música Mexicana in mid-2026), and because there
//    is no mapping layer a renamed name matches nothing, silently. Exit 1.
// 2. Which unfollowed genres discovery has been DROPPING (from the rolling
//    streak the fetcher tallies into config/genre-activity.json). Apple labels
//    releases with both umbrella and leaf names, so following "Hip-Hop/Rap"
//    does not catch a release labelled "Rap". Advisory, never fails.
//
// Run after editing GENRE_OPTIONS or genres.followed, and occasionally to see
// what the follow list is missing.

import { readFileSync } from 'node:fs'
import { GENRE_OPTIONS } from './genre-options.mjs'
import { GENRE_ACTIVITY_PATH, PREFS_PATH, UA } from './shared.mjs'

const followed = JSON.parse(readFileSync(PREFS_PATH, 'utf8')).genres?.followed ?? []
const followedSet = new Set(followed.map((g) => g.toLowerCase()))

const res = await fetch('https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/genres', {
  headers: { 'User-Agent': UA },
  signal: AbortSignal.timeout(30_000),
})
if (!res.ok) throw new Error(`HTTP ${res.status} fetching the genre tree`)
const music = (await res.json())['34'] // 34 = Music
if (!music) throw new Error('genre tree has no Music root (key 34) — API shape changed')

// name → ancestor names, outermost first. Umbrella/leaf pairs are the whole
// point of check 2, so the tree has to be kept, not flattened to a name set.
const ancestors = new Map()
;(function walk(node, path) {
  ancestors.set(node.name, path)
  for (const child of Object.values(node.subgenres ?? {})) walk(child, [...path, node.name])
})(music, [])

// ---------- 1. names still exist ----------

let misses = 0
const checkExists = (names, label) => {
  for (const name of names) {
    if (ancestors.has(name)) continue
    console.error(`"${name}" (${label}) is not in Apple's genre tree — renamed? update GENRE_OPTIONS and genres.followed`)
    misses++
  }
}
checkExists(GENRE_OPTIONS, 'curated picker')
checkExists(followed, 'followed')

if (misses) {
  console.error(`\n${misses} missing genre names`)
  process.exit(1)
}
console.log(`Names OK: all ${GENRE_OPTIONS.length} curated and ${followed.length} followed names exist in Apple's tree.`)

// ---------- 2. what the follow list is missing ----------

let activity = {}
try {
  activity = JSON.parse(readFileSync(GENRE_ACTIVITY_PATH, 'utf8'))
} catch {
  console.log('\nNo drop history yet (config/genre-activity.json). Run `npm run fetch` first.')
  process.exit(0)
}

const entries = Object.entries(activity).filter(([g]) => !followedSet.has(g.toLowerCase()))
if (!entries.length) {
  console.log('\nNothing dropped recently that you do not already follow.')
  process.exit(0)
}

// Only ONE direction is a signal. A genre nested UNDER one you follow means you
// asked for the umbrella and Apple filed the release under a leaf — you almost
// certainly wanted it. The reverse (an ancestor of something you follow) is not:
// following Singer/Songwriter says nothing about wanting all of Rock.
const under = (g) => (ancestors.get(g) ?? []).find((a) => followedSet.has(a.toLowerCase()))
const over = (g) => followed.find((f) => (ancestors.get(f) ?? []).includes(g))

const likely = []
const rest = []
for (const e of entries.sort((a, b) => b[1].dropped - a[1].dropped)) {
  ;(under(e[0]) ? likely : rest).push(e)
}

const pad = (s, n) => String(s).padEnd(n)
const show = ([g, d], note) => {
  console.log(`  ${pad(g, 18)} ${pad(d.dropped + ' dropped', 12)} ${pad(note ?? '', 30)}`.trimEnd())
  console.log(`    e.g. ${d.example}`)
}

console.log(`\nUnfollowed genres discovery is dropping. The count is the current`)
console.log(`run of consecutive days, and an entry disappears after 30 quiet days:`)
if (likely.length) {
  console.log('\n  LIKELY ADDS — Apple filed these under a leaf of a genre you already')
  console.log('  follow, and exact matching means the umbrella does not catch them:')
  likely.forEach((e) => show(e, `under ${under(e[0])}`))
}
if (rest.length) {
  console.log('\n  Everything else (discovery working as intended — ignore unless one')
  console.log('  of these is a genre you actually want):')
  rest.forEach((e) => show(e, over(e[0]) ? `parent of ${over(e[0])}` : null))
}
console.log('\nAdd any you want via the prefs editor, or by typing the exact name.')
