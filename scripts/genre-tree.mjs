import { UA } from './shared.mjs'

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

  const ancestors = new Map()
  ;(function walk(node, path) {
    ancestors.set(node.name, path)
    for (const child of Object.values(node.subgenres ?? {})) walk(child, [...path, node.name])
  })(music, [])
  return { music, ancestors }
}

export const underFollowed = (ancestors, followedSet, g) =>
  (ancestors.get(g) ?? []).find((a) => followedSet.has(a.toLowerCase()))
export const overFollowed = (ancestors, followed, g) =>
  followed.find((f) => [...ancestors].some(([name, parents]) =>
    name.toLowerCase() === f.toLowerCase() && parents.some((parent) => parent.toLowerCase() === g.toLowerCase())
  ))

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
