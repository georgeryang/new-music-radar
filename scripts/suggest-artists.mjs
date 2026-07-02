#!/usr/bin/env node
// One-off helper: rank your local Music.app library by play count and print
// top artists + genre distribution, formatted for config/preferences.json.
// Runs osascript (will launch Music.app). NOT part of the nightly fetch.
//
// Caveat: only sees tracks added to your library — streaming-only listening
// leaves no local trace. There is no personal-listening API without a paid
// Apple Developer token.

import { execFileSync } from 'node:child_process'

const SCRIPT = `
set out to ""
tell application "Music"
  repeat with t in tracks of library playlist 1
    try
      set out to out & (artist of t) & tab & (genre of t) & tab & (played count of t) & linefeed
    end try
  end repeat
end tell
return out
`

let raw
try {
  raw = execFileSync('osascript', ['-e', SCRIPT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
} catch (e) {
  console.error('Could not read the Music.app library:', e.message)
  console.error('(Grant automation permission if macOS prompts, then rerun.)')
  process.exit(1)
}

const artists = new Map()
const genres = new Map()
let tracks = 0
for (const line of raw.split('\n')) {
  const [artist, genre, plays] = line.split('\t')
  if (!artist?.trim()) continue
  tracks++
  const p = parseInt(plays, 10) || 0
  artists.set(artist, (artists.get(artist) ?? 0) + p)
  if (genre?.trim()) genres.set(genre, (genres.get(genre) ?? 0) + p)
}

if (!tracks) {
  console.log('Library is empty — nothing to suggest. (Streaming-only plays are not visible locally.)')
  process.exit(0)
}

const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)

// usage: node scripts/suggest-artists.mjs [topArtists] [topGenres]
const N_ARTISTS = parseInt(process.argv[2], 10) || 50
const N_GENRES = parseInt(process.argv[3], 10) || 20

console.log(`${tracks} library tracks scanned.\n`)
console.log(`Top ${N_ARTISTS} artists by play count:`)
for (const [name, plays] of top(artists, N_ARTISTS)) console.log(`  ${String(plays).padStart(6)}  ${name}`)
console.log('\nGenre distribution (by plays):')
for (const [name, plays] of top(genres, N_GENRES)) console.log(`  ${String(plays).padStart(6)}  ${name}`)
console.log('\nPaste-ready for config/preferences.json → artists.preferred:')
console.log(JSON.stringify(top(artists, N_ARTISTS).map(([name]) => name)))
