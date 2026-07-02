// Data contract between scripts/fetch-releases.mjs (producer) and the app (consumer).
// The fetcher resolves the link priority chain (Apple Music → YouTube → none),
// assigns the canonical genre tag, and pre-sorts (preferred artist → preferred
// genre → date desc), so the app just renders.

export type ReleaseType = 'album' | 'ep' | 'song'

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
  releases: Release[]
}
