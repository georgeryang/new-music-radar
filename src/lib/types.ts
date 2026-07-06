// Data contract between scripts/fetch-releases.mjs (producer) and the app (consumer).
// The fetcher supplies the Apple Music link and assigns the canonical genre
// tag. Its releases/upcoming routing is a fetch-time snapshot — the app
// recomputes the New/Upcoming split (and each tab's order) against the
// viewer's clock at render.

// song = a single (Apple's designation, or a 1-track release);
// album = everything larger — EPs, mini albums, full albums, variants.
export type ReleaseType = 'album' | 'song'

export interface Release {
  title: string
  artist: string
  type: ReleaseType
  release_date: string // YYYY-MM-DD (sources report dates, not times)
  artwork: string // '' when the source has none
  genre?: string | null // canonical tag (K-pop, Latin, …); null when unknown
  link?: string // Apple Music URL, always the US storefront
  followed?: boolean // artist is in config/preferences.json — pinned first
}

export interface FeedData {
  fetched_at: number // ms epoch
  releases: Release[]
  upcoming?: Release[] // announced pre-orders from followed artists, soonest first
}
