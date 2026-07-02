import { Music } from 'lucide-react'

// Apple Music is the only link target (Apple-only architecture) — the icon
// marks a card as linked; unlinked cards simply have no icon.
export function ServiceIcon() {
  return (
    <span
      aria-label="Opens in Apple Music"
      className="flex h-5 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-b from-[#fb5c74] to-[#fa233b] text-white"
    >
      <Music className="size-3" aria-hidden="true" />
    </span>
  )
}
