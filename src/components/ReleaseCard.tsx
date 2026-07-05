import { useState } from 'react'
import { formatUpcoming } from '@/lib/utils'
import type { Release } from '@/lib/types'

// Muted type icons under the artwork: music note = song, disc = album.
function TypeIcon({ type }: { type: Release['type'] }) {
  // role="img" — bare <svg> aria-labels are inconsistently exposed to screen
  // readers, and this icon is the only song/album indicator on the card.
  return type === 'song' ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5 shrink-0" role="img" aria-label="Song">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5 shrink-0" role="img" aria-label="Album">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  )
}

// Unified release card (the only card type): clean artwork, then title,
// artist, and a small meta row — type icon, genre chip. On the Upcoming tab
// (upcoming prop) a release-date line sits under the artist, amber when the
// drop is within a week. The whole card links to Apple Music.
export function ReleaseCard({ release, upcoming = false }: { release: Release; upcoming?: boolean }) {
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
            decoding="async"
            onError={() => setImgFailed(true)}
            className="size-full object-cover transition-transform group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-3xl">🎵</div>
        )}
      </div>
      <p className="line-clamp-2 text-xs leading-snug font-semibold">{release.title}</p>
      <p className="truncate text-[11px] text-muted-foreground">
        {release.followed && <span className="text-amber-500">★ </span>}
        {release.artist}
      </p>
      {upcoming && <UpcomingDate date={release.release_date} />}
      <div className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
        <TypeIcon type={release.type} />
        {release.genre && (
          <span className="rounded-full border border-border px-1.5 py-px text-[9px] font-medium">
            {release.genre}
          </span>
        )}
      </div>
    </div>
  )

  return release.link ? (
    <a href={release.link} target="_blank" rel="noopener noreferrer" className="block">
      {card}
    </a>
  ) : (
    card
  )
}

function UpcomingDate({ date }: { date: string }) {
  const { label, soon } = formatUpcoming(date)
  return (
    <p className={`text-[11px] font-medium ${soon ? 'text-amber-500' : 'text-muted-foreground'}`}>
      {label}
    </p>
  )
}
