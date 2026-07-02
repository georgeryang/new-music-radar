import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import type { Release } from '@/lib/types'

// Muted type icons under the artwork: music note = song, disc = album.
function TypeIcon({ type }: { type: Release['type'] }) {
  return type === 'song' ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5 shrink-0" aria-label="Song">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5 shrink-0" aria-label="Album">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  )
}

// Unified release card (the only card type): clean artwork, then title,
// artist, and a small meta row — type icon, genre chip, chart badge.
// The whole card links to Apple Music.
export function ReleaseCard({ release }: { release: Release }) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = release.artwork.startsWith('http') && !imgFailed

  const card = (
    <div className="group">
      <div className="mb-1.5 aspect-square overflow-hidden rounded-lg bg-muted">
        {showImg ? (
          <img
            src={release.artwork}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="size-full object-cover transition-transform group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-3xl">🎵</div>
        )}
      </div>
      <p className="line-clamp-2 text-xs leading-snug font-semibold">{release.title}</p>
      <p className="truncate text-[11px] text-muted-foreground">
        {release.preferred && <span className="text-amber-500">★ </span>}
        {release.artist}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
        <TypeIcon type={release.type} />
        {release.genre && (
          <Badge variant="outline" className="border-border px-1.5 text-[9px]">
            {release.genre}
          </Badge>
        )}
        {release.charting && (
          <Badge className="bg-amber-400 px-1.5 text-[9px] font-bold text-amber-950">
            {release.charting.storefront} #{release.charting.rank}
          </Badge>
        )}
      </div>
    </div>
  )

  return release.link ? (
    <a href={release.link.url} target="_blank" rel="noopener noreferrer" className="block">
      {card}
    </a>
  ) : (
    card
  )
}
