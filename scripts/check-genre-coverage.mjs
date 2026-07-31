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
import { fetchGenreTree, overFollowed, underFollowed } from './genre-tree.mjs'
import { GENRE_ACTIVITY_PATH, GENRE_MEMORY_DAYS, PREFS_PATH } from './shared.mjs'

// This prints a report for a person, so its own failures get a sentence rather
// than a stack trace over an npm banner.
const die = (msg) => { console.error(msg); process.exit(1) }

let followed
try {
  followed = JSON.parse(readFileSync(PREFS_PATH, 'utf8')).genres?.followed ?? []
} catch (e) {
  die(`Could not read config/preferences.json (${e.message}). Fix the file, then run this again.`)
}
const followedSet = new Set(followed.map((g) => g.toLowerCase()))

let ancestors
try {
  ;({ ancestors } = await fetchGenreTree())
} catch (e) {
  die(e.message)
}

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

// Note it, but keep going: the coverage report below is the part worth reading,
// and one renamed name should not hide it. Exit code is set at the very end.
if (misses) console.error(`\n${misses} missing genre name(s) — fix those first.\n`)
else console.log(`Names OK: all ${GENRE_OPTIONS.length} curated and ${followed.length} followed names exist in Apple's tree.`)

// ---------- 2. what the follow list is missing ----------

let activity = {}
try {
  activity = JSON.parse(readFileSync(GENRE_ACTIVITY_PATH, 'utf8'))
} catch {
  console.log('\nNo drop history yet (config/genre-activity.json). Run `npm run fetch` first.')
  process.exit(misses ? 1 : 0)
}

const entries = Object.entries(activity).filter(([g]) => !followedSet.has(g.toLowerCase()))
if (!entries.length) {
  console.log('\nNothing dropped recently that you do not already follow.')
  process.exit(misses ? 1 : 0)
}

// see genre-tree.mjs for why only the "under" direction is a signal
const under = (g) => underFollowed(ancestors, followedSet, g)
const over = (g) => overFollowed(ancestors, followed, g)

const likely = []
const rest = []
for (const e of entries.sort((a, b) => b[1].dropped - a[1].dropped)) {
  ;(under(e[0]) ? likely : rest).push(e)
}

const pad = (s, n) => String(s).padEnd(n)
const show = ([g, d], note) => {
  console.log(`  ${pad(g, 18)} ${pad(d.dropped + ' dropped', 12)} ${note ?? ''}`.trimEnd())
  console.log(`    e.g. ${d.example}`)
}

console.log(`\nUnfollowed genres discovery is dropping. The count is the current`)
console.log(`run of consecutive days, and an entry disappears after ${GENRE_MEMORY_DAYS} quiet days:`)
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

process.exit(misses ? 1 : 0)
