import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { ServiceIcon } from '@/components/ServiceIcon'
import type { Release } from '@/lib/types'

// Artwork-forward card for the Albums & EPs grid. Type and charting chips
// overlay the art; below it, title, then artist with the service icon.
export function AlbumCard({ release }: { release: Release }) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = release.artwork.startsWith('http') && !imgFailed

  const card = (
    <div className="group">
      <div className="relative mb-1.5 aspect-square overflow-hidden rounded-xl bg-muted">
        {showImg ? (
          <img
            src={release.artwork}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="size-full object-cover transition-transform group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-4xl">💿</div>
        )}
        <Badge className="absolute top-1.5 left-1.5 bg-black/55 text-[10px] text-white uppercase">
          {release.type}
        </Badge>
        {release.charting && (
          <Badge className="absolute top-1.5 right-1.5 bg-amber-400 text-[10px] font-bold text-amber-950">
            {release.charting.storefront} #{release.charting.rank}
          </Badge>
        )}
      </div>
      <p className="line-clamp-2 text-[13px] leading-snug font-semibold">{release.title}</p>
      <div className="mt-0.5 flex items-center justify-between gap-2">
        <p className="truncate text-xs text-muted-foreground">
          {release.preferred && <span className="text-amber-500">★ </span>}
          {release.artist}
        </p>
        {release.link && <ServiceIcon link={release.link} />}
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
