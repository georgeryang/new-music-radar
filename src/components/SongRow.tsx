import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ServiceIcon } from '@/components/ServiceIcon'
import { formatReleaseDay } from '@/lib/utils'
import type { Release } from '@/lib/types'

// Compact row for the Songs list — small art, title/artist, date, badges.
export function SongRow({ release }: { release: Release }) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = release.artwork.startsWith('http') && !imgFailed

  const row = (
    <Card className="flex-row items-center gap-3 p-2.5 transition-colors hover:bg-accent">
      {showImg ? (
        <img
          src={release.artwork}
          alt=""
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="size-11 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-muted text-xl">
          🎵
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{release.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {release.artist} · {formatReleaseDay(release.release_date)}
        </p>
      </div>
      {release.charting && (
        <Badge className="bg-amber-400 text-[10px] font-bold text-amber-950">
          {release.charting.storefront} #{release.charting.rank}
        </Badge>
      )}
      {release.link && <ServiceIcon link={release.link} />}
    </Card>
  )

  return release.link ? (
    <a href={release.link.url} target="_blank" rel="noopener noreferrer" className="block">
      {row}
    </a>
  ) : (
    row
  )
}
