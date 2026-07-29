import { useState } from 'react'
import { formatUpcoming } from '@/lib/utils'
import type { Release } from '@/lib/types'

function TypeIcon({ type }: { type: Release['type'] }) {
  // role="img": bare <svg> aria-labels are inconsistently exposed, and this is
  // the only song/album indicator on the card.
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

export function ReleaseCard({
  release,
  upcoming = false,
  fetchedAt = 0,
  eager = false,
}: {
  release: Release
  upcoming?: boolean
  fetchedAt?: number
  eager?: boolean
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = release.artwork.startsWith('http') && !imgFailed

  const card = (
    <div className="group">
      <div className="mb-1.5 aspect-square overflow-hidden rounded-lg bg-muted">
        {showImg ? (
          <img
            src={release.artwork}
            alt=""
            loading={eager ? 'eager' : 'lazy'}
            fetchPriority={eager ? 'high' : undefined}
            decoding="async"
            onError={() => setImgFailed(true)}
            className="size-full object-cover motion-safe:transition-transform motion-safe:group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-3xl">🎵</div>
        )}
      </div>
      <p className="line-clamp-2 text-[13px] leading-snug font-semibold sm:text-xs">{release.title}</p>
      <p className="truncate text-xs text-muted-foreground">
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
          // break-words, not truncate: a long unbreakable token ("Cantopop/
          // HK-Pop") must stay inside the card, but truncating hid the rest
          // from touch users, where the title tooltip never fires
          <span
            title={release.genre}
            className="max-w-full rounded-full border border-border px-1.5 py-px text-[10px] font-medium break-words"
          >
            {release.genre}
          </span>
        )}
        {upcoming && <UpcomingBadge date={release.release_date} fetchedAt={fetchedAt} />}
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

function UpcomingBadge({ date, fetchedAt }: { date: string; fetchedAt: number }) {
  const { label, soon } = formatUpcoming(date, fetchedAt)
  const full = new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  return (
    <span
      title={`Pre-order, releases ${full}`}
      className={`rounded-full px-1.5 py-px text-[10px] ${
        soon ? 'bg-primary font-bold text-primary-foreground' : 'border border-border font-medium'
      }`}
    >
      {label}
      {/* aria-label on a generic span is unreliably exposed, title is mouse-only */}
      <span className="sr-only"> (pre-order, releases {full})</span>
    </span>
  )
}
