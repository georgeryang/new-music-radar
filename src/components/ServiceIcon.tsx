import { Music } from 'lucide-react'
import type { ReleaseLink } from '@/lib/types'

// One resolved link per release (Apple Music preferred, YouTube fallback,
// none when neither matched). Same shape and size for both services —
// distinguished by brand color and icon: note = Apple Music, play = YouTube.
export function ServiceIcon({ link }: { link: ReleaseLink }) {
  const isApple = link.service === 'apple'
  return (
    <span
      aria-label={isApple ? 'Opens in Apple Music' : 'Opens on YouTube'}
      className={`flex h-5 w-7 shrink-0 items-center justify-center rounded-md text-white ${
        isApple ? 'bg-gradient-to-b from-[#fb5c74] to-[#fa233b]' : 'bg-[#ff0000]'
      }`}
    >
      {isApple ? (
        <Music className="size-3" aria-hidden="true" />
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-3" aria-hidden="true">
          <path d="M8 5v14l11-7z" />
        </svg>
      )}
    </span>
  )
}
