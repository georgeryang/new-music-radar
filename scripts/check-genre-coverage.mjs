#!/usr/bin/env node
// Assert every curated GENRE_OPTIONS name still exists in Apple's genre
// tree. Apple renames genres (Regional Mexicano became Música Mexicana in
// mid-2026 and silently broke a name-based map) — a renamed genre here means
// followed releases silently stop matching. Run ad hoc after editing
// GENRE_OPTIONS or whenever cards look wrong; exit 1 on any miss. Zero
// deps, one unthrottled request.

import { GENRE_OPTIONS } from './genre-map.mjs'

const res = await fetch('https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/genres', {
  headers: { 'User-Agent': 'new-music-radar/1.0' },
  signal: AbortSignal.timeout(30_000),
})
if (!res.ok) throw new Error(`HTTP ${res.status} fetching the genre tree`)
const music = (await res.json())['34'] // 34 = Music
if (!music) throw new Error('genre tree has no Music root (key 34) — API shape changed')

const treeNames = new Set()
;(function walk(node) {
  treeNames.add(node.name)
  for (const child of Object.values(node.subgenres ?? {})) walk(child)
})(music)

let misses = 0
for (const name of GENRE_OPTIONS) {
  if (!treeNames.has(name)) {
    console.error(`"${name}" is not in Apple's genre tree (renamed?) — update GENRE_OPTIONS and genres.followed`)
    misses++
  }
}

if (misses) {
  console.error(`${misses} missing genre names`)
  process.exit(1)
}
console.log(`genre options OK: all ${GENRE_OPTIONS.length} curated names exist in Apple's tree`)
