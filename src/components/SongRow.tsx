import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { ServiceIcon } from '@/components/ServiceIcon'
import type { Release } from '@/lib/types'

// Compact Apple-Music-style row for the two-column Songs grid:
// small art, title over artist, hairline divider, badges on the right.
export function SongRow({ release }: { release: Release }) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = release.artwork.startsWith('http') && !imgFailed

  const row = (
    <div className="flex min-w-0 items-center gap-2.5 border-b border-border/70 py-2 transition-colors hover:bg-accent/50">
      {showImg ? (
        <img
          src={release.artwork}
          alt=""
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="size-10 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-lg">
          🎵
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] leading-tight font-medium">{release.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {release.preferred && <span className="text-amber-500">★ </span>}
          {release.artist}
        </p>
      </div>
      {release.charting && (
        <Badge className="bg-amber-400 text-[10px] font-bold text-amber-950">
          {release.charting.storefront} #{release.charting.rank}
        </Badge>
      )}
      {release.link && <ServiceIcon link={release.link} />}
    </div>
  )

  return release.link ? (
    <a href={release.link.url} target="_blank" rel="noopener noreferrer" className="block min-w-0">
      {row}
    </a>
  ) : (
    row
  )
}
