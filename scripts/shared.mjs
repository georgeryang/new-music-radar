// Values the fetcher and the prefs editor must agree on. Both read the same
// files and both speak the sources wire format, so a copy in each script drifts
// silently (a renamed tag makes every editor chip read 0, with no error).

// The file holds this many days of releases; the editor's chip counts span it.
export const WINDOW_DAYS = 3

export const UA = 'new-music-radar/1.0'

export const PREFS_PATH = new URL('../config/preferences.json', import.meta.url)
export const DATA_PATH = new URL('../docs/data/releases.json', import.meta.url)
export const ACTIVITY_PATH = new URL('../config/artist-activity.json', import.meta.url)
export const GENRE_ACTIVITY_PATH = new URL('../config/genre-activity.json', import.meta.url)

// Per-release provenance tags, written by the fetcher and read back by the
// editor's source-yield chips.
export const sourceTag = (kind, key) => `${kind}:${key}`
