// Data contract between scripts/fetch-releases.mjs (producer) and the app (consumer).
// The fetcher resolves the link priority chain (Apple Music → YouTube → none),
// so the app just renders `link` as-is.

export type ReleaseType = 'album' | 'ep' | 'song'

export interface ReleaseLink {
  service: 'apple' | 'youtube'
  url: string
}

export interface Release {
  title: string
  artist: string
  type: ReleaseType
  release_date: string // YYYY-MM-DD (sources report dates, not times)
  artwork: string // '' when the source has none
  link?: ReleaseLink
  charting?: { storefront: 'KR' | 'US'; rank: number }
}

export interface SceneData {
  fetched_at: number // ms epoch
  releases: Release[]
}

export type Scene = 'kpop' | 'pop'

export const SCENES: { id: Scene; label: string }[] = [
  { id: 'kpop', label: 'K-pop' },
  { id: 'pop', label: 'Pop' },
]
