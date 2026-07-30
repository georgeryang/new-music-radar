// Data contract between scripts/fetch-releases.mjs (producer) and the app.
// The fetcher's releases/upcoming routing IS the New/Upcoming split; both
// lists arrive sorted and render as-is.

// song = a single (or 1-track release); album = everything larger.
export type ReleaseType = 'album' | 'song'

export interface Release {
  title: string
  artist: string
  type: ReleaseType
  release_date: string // YYYY-MM-DD (sources report dates, not times)
  artwork: string // '' when the source has none
  // Apple's genre name, verbatim from the lookup (or the feed's own label on
  // lookup failure); null when unknown
  genre?: string | null
  link?: string // Apple Music URL, US storefront
  followed?: boolean // came from a followed artist's discography — pinned first
  artist_id?: number // producer-side (dedup, block matching); UI ignores it
  // producer-side: followed artist whose discography returned this, which for
  // a collab is not artist_id; UI ignores it
  via_artist_id?: number
  // producer-side: country:<code> / playlist:<name> tags for the editor's
  // source-yield audit; UI ignores it
  sources?: string[]
}

export interface FeedData {
  fetched_at: number // ms epoch
  releases: Release[]
  upcoming?: Release[] // announced pre-orders from followed artists, soonest first
}
