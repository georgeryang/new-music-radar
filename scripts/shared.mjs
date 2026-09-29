import { renameSync, writeFileSync, rmSync } from 'node:fs'

export const WINDOW_DAYS = 3

export const GENRE_MEMORY_DAYS = 30

// How many days of per-source yield source-activity.json keeps. Long enough for
// 7/30/90-day windows and to see a source die months ago; short enough that a
// file committed and pushed nightly stays around 30KB.
export const SOURCE_MEMORY_DAYS = 180

export const SOURCE_CHIP_DAYS = 30
export const SOURCE_THIN_DAYS = 7

export const UA = 'new-music-radar/1.0'

// Every window rule is phrased in days since a date — one definition so the
// tolerances can't drift apart. The grace absorbs the timezone spread between
// Apple's dates and ours; the lower bound excludes pre-orders.
const GRACE_DAYS = 0.5
export const daysSince = (date) => (Date.now() - Date.parse(date)) / 86400e3
export const withinDays = (date, days) => {
  if (!date) return false
  const age = daysSince(date)
  return age <= days + GRACE_DAYS && age >= 0
}
export const notOlderThan = (date, days) => daysSince(date) <= days + GRACE_DAYS

// Apple applies `limit` per artist. Batches of 30 keep payloads near 1MB
// and limit the number of artists affected by one failed request.
export const BATCH_SIZE = 30

// Apple starts truncating collection lookups past 200 IDs.
export const LOOKUP_CHUNK = 200
// Mean gap the iTunes pacer holds between calls, for the audit's cost estimates.
export const PACED_CALL_S = 3.25

// Every file below is live state a later run reads back, so a crash or a
// bootout mid-write must leave the previous copy rather than a truncated one:
// writeFileSync overwrites in place, rename within a directory is atomic.
export function writeFileAtomic(target, data) {
  const suffix = '.' + process.pid + '.tmp'
  const tmp = target instanceof URL ? new URL(target.href + suffix) : target + suffix
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, target)
  } finally { rmSync(tmp, { force: true }) }
}

export const PREFS_PATH = new URL('../config/preferences.json', import.meta.url)
export const DATA_PATH = new URL('../docs/data/releases.json', import.meta.url)
export const ACTIVITY_PATH = new URL('../config/artist-activity.json', import.meta.url)
export const GENRE_ACTIVITY_PATH = new URL('../config/genre-activity.json', import.meta.url)
export const SOURCE_ACTIVITY_PATH = new URL('../config/source-activity.json', import.meta.url)

// Not /tmp (world-writable — another user could plant a pidfile and block refreshes).
export const REFRESH_LOG = `${process.env.HOME}/Library/Logs/new-music-radar.log`

export const sourceTag = (kind, key) => `${kind}:${key}`

export const windowIndices = (hist, days) => {
  const idx = []
  ;(hist.days ?? []).forEach((d, i) => { if (withinDays(d, days)) idx.push(i) })
  return idx
}

// One source's yield over those days. A null day means its fetch FAILED or it was
// not configured yet, NEVER zero. Leading nulls are pre-birth rather than failures,
// so only gaps at or after the first real reading count as failed.
export function sourceWindow(hist, tag, idx) {
  const col = hist.sources?.[tag] ?? []
  const born = col.findIndex((v) => v != null)
  let surfaced = 0, unique = 0, measured = 0, failed = 0, last = null
  for (const i of idx) {
    const v = col[i]
    if (v == null) {
      if (born !== -1 && i > born) failed++
      continue
    }
    measured++
    surfaced += v[0]
    unique += v[1]
    if (v[0] > 0) last = hist.days[i]
  }
  return { surfaced, unique, measured, failed, last }
}

// `tag` is Apple's verbatim fallback genre when a lookup provides none.
// 1251/1253 sit under Pop (14), NOT under Chinese (1232): 1232 is the traditional
// branch (Chinese Classical, Opera, Regional Folk) and yields no current releases.
export const GENRE_FEEDS = [
  { genreId: 51, tag: 'K-Pop' },
  { genreId: 12, tag: 'Latin' },
  { genreId: 14, tag: 'Pop' },
  { genreId: 15, tag: 'R&B/Soul' },
  { genreId: 27, tag: 'J-Pop' },
  { genreId: 1203, tag: 'African' },
  { genreId: 1253, tag: 'Mandopop' },
  // Dance and Singer/Songwriter are the only followed genres Apple files at top
  // level with no umbrella above them, so nothing else reaches either.
  { genreId: 17, tag: 'Dance' },
  // topalbums for these two is abandoned: 1251's newest is months old, 18's
  // returns 6 entries with nothing since April.
  { genreId: 1251, tag: 'Cantopop/HK-Pop', feeds: ['topsongs'] },
  { genreId: 18, tag: 'Hip-Hop/Rap', feeds: ['topsongs'] },
]
export const PURCHASE_FEED_TYPES = ['topalbums', 'topsongs']
export const feedTypesOf = (f) => f.feeds ?? PURCHASE_FEED_TYPES

export function serializeFeed(data) {
  const records = (rows) => rows.map((row) => JSON.stringify(row)).join(',\n')
  return `{\n"fetched_at":${data.fetched_at},\n"releases":[\n${records(data.releases)}\n],\n"upcoming":[\n${records(data.upcoming ?? [])}\n]\n}\n`
}
