#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { GENRE_OPTIONS } from './genre-options.mjs'
import { fetchGenreTree, overFollowed, underFollowed } from './genre-tree.mjs'
import { GENRE_ACTIVITY_PATH, GENRE_MEMORY_DAYS, PREFS_PATH } from './shared.mjs'

const die = (msg) => { console.error(msg); process.exit(1) }

let followed
try {
  followed = JSON.parse(readFileSync(PREFS_PATH, 'utf8')).genres?.followed ?? []
} catch (e) {
  die(`Could not read config/preferences.json (${e.message}). Fix the file, then run this again.`)
}
const followedSet = new Set(followed.map((g) => g.toLowerCase()))

let activity = null
try {
  activity = JSON.parse(readFileSync(GENRE_ACTIVITY_PATH, 'utf8'))
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) throw new Error('expected a genre activity object')
} catch (e) {
  if (e.code !== 'ENOENT') die(`Could not read config/genre-activity.json (${e.message}). Fix the file, then run this again.`)
}

let ancestors
try {
  ;({ ancestors } = await fetchGenreTree())
} catch (e) {
  die(e.message)
}


let misses = 0
const genreNames = new Set([...ancestors.keys()].map((name) => name.toLowerCase()))
const checkExists = (names, label) => {
  for (const name of names) {
    if (genreNames.has(name.toLowerCase())) continue
    console.error(`"${name}" (${label}) is not in Apple's genre tree — renamed? update GENRE_OPTIONS and genres.followed`)
    misses++
  }
}
checkExists(GENRE_OPTIONS, 'curated picker')
checkExists(followed, 'followed')

if (misses) console.error(`\n${misses} missing genre name(s) — fix those first.\n`)
else console.log(`Names OK: all ${GENRE_OPTIONS.length} curated and ${followed.length} followed names exist in Apple's tree.`)


if (activity === null) {
  console.log('\nNo drop history yet (config/genre-activity.json). It is recorded by scheduled refreshes.')
  process.exit(misses ? 1 : 0)
}

const entries = Object.entries(activity).filter(([g]) => !followedSet.has(g.toLowerCase()))
if (!entries.length) {
  console.log('\nNothing dropped recently that you do not already follow.')
  process.exit(misses ? 1 : 0)
}

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
