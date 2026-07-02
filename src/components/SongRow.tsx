import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ServiceIcon } from '@/components/ServiceIcon'
import type { Release } from '@/lib/types'

// Compact song card: artwork sits flush against the card's left edge
// (no padding on the image side), text and badges tightly packed.
export function SongRow({ release }: { release: Release }) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = release.artwork.startsWith('http') && !imgFailed

  const row = (
    <Card className="flex-row items-center gap-2.5 overflow-hidden p-0 pr-2.5 transition-colors hover:bg-accent">
      {showImg ? (
        <img
          src={release.artwork}
          alt=""
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="size-12 shrink-0 self-stretch object-cover"
        />
      ) : (
        <div className="flex size-12 shrink-0 items-center justify-center bg-muted text-lg">🎵</div>
      )}
      <div className="min-w-0 flex-1 py-1.5">
        <p className="truncate text-[13px] leading-tight font-medium">{release.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {release.preferred && <span className="text-amber-500">★ </span>}
          {release.artist}
        </p>
      </div>
      {release.genre && (
        <Badge className="hidden border-border text-[10px] text-muted-foreground sm:inline-flex" variant="outline">
          {release.genre}
        </Badge>
      )}
      {release.charting && (
        <Badge className="bg-amber-400 text-[10px] font-bold text-amber-950">
          {release.charting.storefront} #{release.charting.rank}
        </Badge>
      )}
      {release.link && <ServiceIcon link={release.link} />}
    </Card>
  )

  return release.link ? (
    <a href={release.link.url} target="_blank" rel="noopener noreferrer" className="block min-w-0">
      {row}
    </a>
  ) : (
    row
  )
}
