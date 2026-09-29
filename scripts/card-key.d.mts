interface CardLike {
  artist: string
  title: string
  type: 'song' | 'album'
  release_date: string
}
export declare const cardKeyOf: (r: CardLike) => string
