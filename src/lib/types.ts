// Data contract between scripts/fetch-releases.mjs (producer) and the app (consumer).
// The fetcher supplies the Apple Music link and Apple's genre name verbatim.
// Its releases/upcoming routing IS the New/Upcoming split — both lists
// arrive sorted and the app renders them as-is; every window and label
// anchors to fetched_at, never the viewer's clock.

// song = a single (Apple's designation, or a 1-track release);
// album = everything larger — EPs, mini albums, full albums, variants.
export type ReleaseType = 'album' | 'song'

export interface Release {
  title: string
  artist: string
  type: ReleaseType
  release_date: string // YYYY-MM-DD (sources report dates, not times)
  artwork: string // '' when the source has none
  // Apple's genre name — verbatim from the catalog lookup, or the surfacing
  // chart feed's own Apple label when that lookup failed; null when unknown
  genre?: string | null
  link?: string // Apple Music URL, always the US storefront
  followed?: boolean // artist is in config/preferences.json — pinned first
  // producer-side only (dedup merges, block-list matching); the UI never reads it
  artist_id?: number
  // producer-side only: country:<code> / playlist:<name> tags for the
  // preferences editor's source-yield audit; the UI never reads it
  sources?: string[]
}

export interface FeedData {
  fetched_at: number // ms epoch
  releases: Release[]
  upcoming?: Release[] // announced pre-orders from followed artists, soonest first
}
