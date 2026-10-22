import { useState, type MouseEvent } from 'react'
import { appleMusicAppLink, formatUpcoming } from '@/lib/utils'
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

// Apple's artwork URLs end in "{size}x{size}bb.{ext}"; any square size is served.
const ARTWORK_SIZE = /\d+x\d+bb(\.\w+)$/
function artworkSrcSet(url: string): string | undefined {
  if (!ARTWORK_SIZE.test(url)) return undefined
  return [300, 400, 600].map((n) => `${url.replace(ARTWORK_SIZE, `${n}x${n}bb$1`)} ${n}w`).join(', ')
}

export function ReleaseCard({
  release,
  upcoming = false,
  fetchedAt,
  eager = false,
  enterIndex,
}: {
  release: Release
  upcoming?: boolean
  fetchedAt: number
  eager?: boolean
  enterIndex?: number
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = release.artwork.startsWith('http') && !imgFailed

  const card = (
    <div
      className={`group ${enterIndex === undefined ? '' : 'motion-safe:animate-[card-in_500ms_var(--ease-spring)_both]'}`}
      style={enterIndex === undefined ? undefined : { animationDelay: `${enterIndex * 20}ms` }}
    >
      <div className="relative mb-2 aspect-square overflow-hidden rounded-lg bg-muted">
        {showImg ? (
          <img
            src={release.artwork}
            crossOrigin="anonymous"
            srcSet={artworkSrcSet(release.artwork)}
            sizes="(width < 40rem) 46vw, 200px"
            alt=""
            width={400}
            height={400}
            loading={eager ? 'eager' : 'lazy'}
            fetchPriority={eager ? 'high' : undefined}
            decoding="async"
            onError={() => setImgFailed(true)}
            className="size-full object-cover motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:scale-[1.03]"
          />
        ) : (
          <div aria-hidden="true" className="flex size-full items-center justify-center text-3xl">
            🎵
          </div>
        )}
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-foreground/8 ring-inset" />
      </div>
      <p className="line-clamp-2 text-xs leading-snug font-semibold">{release.title}</p>
      <p className="truncate text-xs text-muted-foreground">
        {release.followed && (
          <>
            <span className="sr-only">From an artist you follow: </span>
            <span aria-hidden="true" className="text-primary">
              ★{' '}
            </span>
          </>
        )}
        {release.artist}
      </p>
      {/* Pills are 11px on purpose, below gry-design-system's 12px floor: they are secondary metadata. */}
      <div className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
        <TypeIcon type={release.type} />
        {release.genre && (
          // break-words, not truncate: a long unbreakable token ("Cantopop/
          // HK-Pop") must stay inside the card, but truncating hid the rest
          // from touch users, where the title tooltip never fires
          <span className="max-w-full rounded-full border border-border px-1.5 py-px text-[11px] break-words">
            {release.genre}
          </span>
        )}
        {upcoming && <UpcomingBadge date={release.release_date} fetchedAt={fetchedAt} />}
      </div>
    </div>
  )

  const href = appleMusicAppLink(release.link)
  if (!href) return card

  // Safari kicks a cross-site link activation out of a pinned tab into a new tab,
  // and music:// counts as cross-site: that tab hands off to the app, closes, and
  // Safari lands elsewhere. Script navigation is not a link activation. The href
  // stays for long-press, copy link and assistive tech.
  const openInMusic = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    window.location.assign(href)
  }

  return (
    <a href={href} onClick={openInMusic} className="block rounded-lg motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-spring motion-safe:active:scale-[0.97]">
      {card}
    </a>
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
      className={`rounded-full px-1.5 py-px text-[11px] ${
        soon ? 'relative overflow-hidden bg-primary text-primary-foreground' : 'border border-border'
      }`}
    >
      {soon && (
        <span aria-hidden="true" className="absolute inset-0 -translate-x-[120%] bg-[linear-gradient(100deg,transparent_30%,rgb(255_255_255/0.4)_50%,transparent_70%)] motion-safe:animate-[sheen_4s_ease-in-out_infinite]" />
      )}
      <span className="relative">{label}</span>
      {/* aria-label on a generic span is unreliably exposed, title is mouse-only */}
      <span className="sr-only"> (pre-order, releases {full})</span>
    </span>
  )
}
