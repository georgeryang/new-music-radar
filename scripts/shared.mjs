// Values the fetcher, the prefs editor and the source audit must agree on. All
// three read the same files and speak the sources wire format, so a copy in each
// script drifts silently (a renamed tag makes every editor chip read 0, with no
// error).

// The file holds this many days of releases; the editor's chip counts span it.
export const WINDOW_DAYS = 3

// A genre-activity entry disappears after this many quiet days. The fetcher
// prunes on it and check-genres states it in its report.
export const GENRE_MEMORY_DAYS = 30

// How many days of per-source yield source-activity.json keeps. Long enough for
// 7/30/90-day windows and to see a source die months ago; short enough that a
// file committed and pushed nightly stays around 30KB.
export const SOURCE_MEMORY_DAYS = 180

// Window the editor's source chips and the audit's 30d column both report on,
// and the history needed before either says a number instead of "collecting".
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
// Upper bound alone, for callers carrying future-dated pre-orders forward.
export const notOlderThan = (date, days) => daysSince(date) <= days + GRACE_DAYS

// Artists per sweep lookup. 30, not 20: `limit` is PER ARTIST, not per batch, so
// a bigger batch loses nothing (verified 2026-07-30 — the same 60 artists at
// sizes 20/30/40/50/60 returned identical collection sets, zero orphans). 30
// halves the paced calls while keeping ~1MB payloads, a 3.3s request well inside
// the 30s abort, and a failed batch costing 30 artists rather than the sweep.
export const BATCH_SIZE = 30

// Collection ids per lookup call. 200, not 100: once the artist sweep is batched
// these chunks are the run's dominant cost, and each one buys another paced slot.
// Verified against a real 512-id set 2026-07-30 — 100s and 200s returned identical
// collections; Apple starts truncating past 200. The audit prices sources in
// chunks, so it has to agree with the fetcher on the divisor.
export const LOOKUP_CHUNK = 200
// Mean gap the iTunes pacer holds between calls, for the audit's cost estimates.
export const PACED_CALL_S = 3.25

export const PREFS_PATH = new URL('../config/preferences.json', import.meta.url)
export const DATA_PATH = new URL('../docs/data/releases.json', import.meta.url)
export const ACTIVITY_PATH = new URL('../config/artist-activity.json', import.meta.url)
export const GENRE_ACTIVITY_PATH = new URL('../config/genre-activity.json', import.meta.url)
export const SOURCE_ACTIVITY_PATH = new URL('../config/source-activity.json', import.meta.url)

// "Save & Refresh" spawns update.sh DETACHED into launchd's log, with a pidfile,
// so quitting the editor can't kill a running refresh. The audit reads both: it
// refuses to run against a half-written file, and counts block hits in the log.
// Not /tmp (world-writable — another user could plant a pidfile and block refreshes).
export const REFRESH_LOG = `${process.env.HOME}/Library/Logs/new-music-radar.log`
export const REFRESH_PIDFILE = `${process.env.HOME}/Library/Logs/new-music-radar-refresh.pid`

// Per-release provenance tags, written by the fetcher and read back by the
// editor's source-yield chips.
export const sourceTag = (kind, key) => `${kind}:${key}`

// ---------- source-activity.json readers ----------

// Indices into hist.days that fall inside an N-day window. Hoisted out of
// sourceWindow so a caller scoring every source walks the date array once.
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

// ---------- always-scanned genre feeds ----------

// iTunes Store *purchase* charts per genre: buying spikes on release day, so drops
// appear within hours (most-played lags by days). `tag` is the feed's
// Apple genre name, used verbatim only as the fallback when an entry has no
// lookup-backed genre; `African` is the one tag not in genres.followed, so its
// fallback cards drop (accepted). `feeds` narrows a genre to the half that is alive.
//
// Lives here, not in the fetcher, because the editor lists these as always-scanned
// sources and importing fetch-releases.mjs would run the whole pipeline.
//
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
  // level with no umbrella above them, so nothing else reaches either. Dance is
  // here because it has admitted 20 releases; Singer/Songwriter's 2 does not pay
  // for the two requests.
  { genreId: 17, tag: 'Dance' },
  // topalbums for these two is abandoned: 1251's newest is months old, 18's
  // returns 6 entries with nothing since April.
  { genreId: 1251, tag: 'Cantopop/HK-Pop', feeds: ['topsongs'] },
  { genreId: 18, tag: 'Hip-Hop/Rap', feeds: ['topsongs'] },
]
// The two legacy-RSS purchase charts, per genre and per storefront alike.
export const PURCHASE_FEED_TYPES = ['topalbums', 'topsongs']
export const feedTypesOf = (f) => f.feeds ?? PURCHASE_FEED_TYPES
