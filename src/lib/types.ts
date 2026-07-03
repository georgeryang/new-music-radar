// Data contract between scripts/fetch-releases.mjs (producer) and the app (consumer).
// The fetcher supplies the Apple Music link, assigns the canonical genre tag,
// and pre-sorts (preferred artist → preferred genre → date desc), so the app
// just renders.

// song = a single (Apple's designation, or a 1-track release);
// album = everything larger — EPs, mini albums, full albums, variants.
export type ReleaseType = 'album' | 'song'

export interface ReleaseLink {
  service: 'apple' // Apple-only architecture; field kept for shape stability
  url: string
}

export interface Release {
  title: string
  artist: string
  type: ReleaseType
  release_date: string // YYYY-MM-DD (sources report dates, not times)
  artwork: string // '' when the source has none
  genre?: string | null // canonical tag (K-pop, Latin, …); null when unknown
  link?: ReleaseLink
  charting?: { storefront: 'KR' | 'US'; rank: number }
  preferred?: boolean // artist is in config/preferences.json — pinned first
}

export interface FeedData {
  fetched_at: number // ms epoch
  daily_min?: number | null // display floor (config display.daily_min); quiet days backfill older releases up to this — never trims heavy days
  releases: Release[]
}
