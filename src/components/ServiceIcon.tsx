import type { ReleaseLink } from '@/lib/types'

// One resolved link per release (Apple Music preferred, YouTube fallback,
// none when neither matched). Shapes are deliberately different so the two
// services read apart at a glance: Apple Music = square gradient + note,
// YouTube = wide red lozenge + play triangle.
export function ServiceIcon({ link }: { link: ReleaseLink }) {
  if (link.service === 'apple') {
    return (
      <span
        aria-label="Opens in Apple Music"
        className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-gradient-to-b from-[#fb5c74] to-[#fa233b] text-[11px] leading-none text-white"
      >

      </span>
    )
  }
  return (
    <span
      aria-label="Opens on YouTube"
      className="flex h-4 w-6 shrink-0 items-center justify-center rounded-[8px] bg-[#ff0000] text-white"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-2.5" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    </span>
  )
}
