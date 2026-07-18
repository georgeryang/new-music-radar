// Hand-written declarations for card-key.mjs (TS pairs .mjs with .d.mts).
interface CardLike {
  artist: string
  title: string
  type: string
  release_date: string
  followed?: boolean
}
export declare const normArtist: (raw: string) => string
export declare const keyOf: (r: CardLike) => string
export declare const cardKeyOf: (r: CardLike) => string
export declare const releaseOrder: (a: CardLike, b: CardLike) => number
export declare const upcomingOrder: (a: CardLike, b: CardLike) => number
