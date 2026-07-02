import type { ReleaseLink } from '@/lib/types'

// One resolved link per release (Apple Music preferred, YouTube fallback,
// none when neither matched) — the icon tells you where the card goes.
export function ServiceIcon({ link }: { link: ReleaseLink }) {
  if (link.service === 'apple') {
    return (
      <span
        aria-label="Opens in Apple Music"
        className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[#fa2d48] text-[11px] leading-none text-white"
      >

      </span>
    )
  }
  return (
    <span
      aria-label="Opens on YouTube"
      className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[#ff0000] text-white"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-3" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    </span>
  )
}
