// Apple Music is the only link target — a play triangle on the Apple Music
// gradient marks a card as playable; unlinked cards simply have no icon.
export function ServiceIcon() {
  return (
    <span
      aria-label="Play in Apple Music"
      className="flex h-5 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-b from-[#fb5c74] to-[#fa233b] text-white"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-3" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    </span>
  )
}
