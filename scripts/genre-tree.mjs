// Apple's live genre tree, shared by check-genre-coverage.mjs and
// audit-sources.mjs. Both need the same two things: proof that a configured
// genre name still exists, and the umbrella/leaf relationships that say which
// unfollowed genres are worth following.

import { UA } from './shared.mjs'

// Throws with a sentence a person can act on; callers decide whether that is
// fatal (check-genres exits) or just one degraded section (the audit continues).
export async function fetchGenreTree() {
  let res
  try {
    res = await fetch('https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/genres', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new Error(`Could not reach Apple's genre list (${e.message}). Check the connection and try again.`)
  }
  if (!res.ok) throw new Error(`Apple's genre list returned HTTP ${res.status}. Try again in a minute.`)
  const music = (await res.json())['34'] // 34 = Music
  if (!music) throw new Error("Apple's genre list has no Music root (key 34) — the API shape changed, so this check needs updating.")

  // name → ancestor names, outermost first. Umbrella/leaf pairs are the whole
  // point, so the tree is kept rather than flattened to a name set.
  const ancestors = new Map()
  ;(function walk(node, path) {
    ancestors.set(node.name, path)
    for (const child of Object.values(node.subgenres ?? {})) walk(child, [...path, node.name])
  })(music, [])
  return { music, ancestors }
}

// Only ONE direction is a signal. A genre nested UNDER one you follow means you
// asked for the umbrella and Apple filed the release under a leaf — you almost
// certainly wanted it. The reverse (an ancestor of something you follow) is not:
// following Singer/Songwriter says nothing about wanting all of Rock.
export const underFollowed = (ancestors, followedSet, g) =>
  (ancestors.get(g) ?? []).find((a) => followedSet.has(a.toLowerCase()))
export const overFollowed = (ancestors, followed, g) =>
  followed.find((f) => (ancestors.get(f) ?? []).includes(g))

// id → name, for verifying a GENRE_FEEDS entry points where its tag claims.
// Guessing an id is how 1123 got labelled Afro-Beat when it is Música Mexicana.
export function genreNamesById(music) {
  const byId = new Map()
  ;(function walk(node) {
    for (const [id, child] of Object.entries(node.subgenres ?? {})) {
      byId.set(String(id), child.name)
      walk(child)
    }
  })(music)
  return byId
}
