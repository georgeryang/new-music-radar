import { useState } from 'react'
import { formatUpcoming, isUnreleased } from '@/lib/utils'
import type { Release } from '@/lib/types'

// Muted type icons under the artwork: music note = song, disc = album.
function TypeIcon({ type }: { type: Release['type'] }) {
  // role="img" — bare <svg> aria-labels are inconsistently exposed to screen
  // readers, and this icon is the only song/album indicator on the card.
  return type === 'song' ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0 sm:size-3.5" role="img" aria-label="Song">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0 sm:size-3.5" role="img" aria-label="Album">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  )
}

// Unified release card (the only card type): clean artwork, then title,
// artist, and a small meta row — type icon, genre chip. A card whose date is
// still in the future carries a release-date badge (red within a week) —
// with App's clock-driven split those are exactly the Upcoming-tab cards, so
// the badge doubles as that tab's date label and New stays chip-free.
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
            decoding="async"
            onError={() => setImgFailed(true)}
            className="size-full object-cover motion-safe:transition-transform motion-safe:group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-3xl">🎵</div>
        )}
      </div>
      <p className="line-clamp-2 text-[13px] leading-snug font-semibold sm:text-xs">{release.title}</p>
      <p className="truncate text-xs text-muted-foreground sm:text-[11px]">
        {release.followed && (
          <>
            <span className="sr-only">Followed artist: </span>
            <span aria-hidden="true" className="text-primary">
              ★{' '}
            </span>
          </>
        )}
        {release.artist}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
        <TypeIcon type={release.type} />
        {release.genre && (
          <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-medium sm:text-[9px]">
            {release.genre}
          </span>
        )}
        {isUnreleased(release.release_date) && <UpcomingBadge date={release.release_date} />}
      </div>
    </div>
  )

  return release.link ? (
    <a href={release.link} target="_blank" rel="noopener noreferrer" className="block rounded-lg">
      {card}
    </a>
  ) : (
    card
  )
}

function UpcomingBadge({ date }: { date: string }) {
  const { label, soon } = formatUpcoming(date)
  const full = new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  return (
    <span
      title={`Pre-order, releases ${full}`}
      className={`rounded-full px-1.5 py-px text-[10px] sm:text-[9px] ${
        soon ? 'bg-primary font-bold text-primary-foreground' : 'border border-border font-medium'
      }`}
    >
      {label}
      {/* name-from-content: aria-label on a generic span is unreliably
          exposed, and title is mouse-only */}
      <span className="sr-only"> (pre-order, releases {full})</span>
    </span>
  )
}
