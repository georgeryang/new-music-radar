// Hand-written declarations for card-key.mjs (TS pairs .mjs with .d.mts).
interface CardLike {
  artist: string
  title: string
  type: 'song' | 'album'
  release_date: string
}
// Only what TypeScript imports. keyOf/releaseOrder/upcomingOrder are used by
// the .mjs fetcher, which never reads these declarations.
export declare const cardKeyOf: (r: CardLike) => string
