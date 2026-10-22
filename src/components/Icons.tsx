// Same drawing as src/assets/favicon.svg.
export function RadarIcon({ className = '', slashed = false }: { className?: string; slashed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <path
        d="M8.46 8.46a5 5 0 0 0 0 7.07M15.54 8.46a5 5 0 0 1 0 7.07"
        className="origin-center group-aria-selected:motion-safe:animate-[radar-wave_900ms_cubic-bezier(0.33,0,0.2,1)]"
      />
      <path
        d="M5.64 5.64a9 9 0 0 0 0 12.73M18.36 5.64a9 9 0 0 1 0 12.73"
        className="origin-center group-aria-selected:motion-safe:animate-[radar-wave_900ms_cubic-bezier(0.33,0,0.2,1)_120ms_both]"
      />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" className="origin-center group-aria-selected:motion-safe:animate-[radar-dot_600ms_cubic-bezier(0.33,0,0.2,1)]" />
      {slashed && <path d="M3 3l18 18" />}
    </svg>
  )
}

export function HourglassIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <g className="origin-center group-aria-selected:motion-safe:animate-[hourglass-flip_900ms_cubic-bezier(0.45,0,0.2,1)]">
        <path d="M6 2h12M6 22h12M7 2v3a5 5 0 0 0 2.5 4.3L12 12l2.5-2.7A5 5 0 0 0 17 5V2M7 22v-3a5 5 0 0 1 2.5-4.3L12 12l2.5 2.7A5 5 0 0 1 17 19v3" />
      </g>
    </svg>
  )
}

export function GearIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function RadarState({
  title,
  body,
  mode = 'still',
  onRetry,
  live = false,
}: {
  title: string
  body?: string
  mode?: 'scan' | 'still' | 'offline'
  onRetry?: () => void
  live?: boolean
}) {
  return (
    <div role={live ? 'status' : undefined} className="flex flex-col items-center gap-3 px-6 pt-16 pb-6 text-center">
      <div aria-hidden="true" className="relative size-33 overflow-hidden rounded-full border border-border bg-surface-raised">
        <div className="absolute inset-[18%] rounded-full border border-primary/15" />
        {mode === 'scan' && <div className="absolute inset-0 bg-[conic-gradient(from_300deg,color-mix(in_oklab,var(--color-primary)_28%,transparent),transparent_70deg)] motion-safe:animate-[radar-spin_2.4s_linear_infinite]" />}
        <RadarIcon slashed={mode === 'offline'} className={`absolute inset-0 m-auto size-11 ${mode === 'offline' ? 'text-muted-foreground' : 'text-primary'}`} />
      </div>
      <p className="mt-2 text-[1.0625rem] font-semibold">{title}</p>
      {body && <p className="max-w-72 text-sm leading-relaxed text-muted-foreground">{body}</p>}
      {onRetry && (
        <button onClick={onRetry} className="mt-2 min-h-11 cursor-pointer rounded-full bg-primary px-5.5 text-sm font-medium text-primary-foreground">
          Try again
        </button>
      )}
    </div>
  )
}

const NOTICE_ICONS = {
  offline: 'M2 8.8a15 15 0 0 1 4.2-2.7M10.7 5.1A15 15 0 0 1 22 8.8M5 12.6a10 10 0 0 1 5.2-2.8M16.9 11.1A10 10 0 0 1 19 12.6M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M3 3l18 18',
  warning: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
} as const

export function Notice({ icon, tone = 'neutral', children }: { icon: keyof typeof NOTICE_ICONS; tone?: 'neutral' | 'warning'; children: string }) {
  return (
    <p role="status" className={`mb-4 flex items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-sm leading-snug ${tone === 'warning' ? 'bg-warning-surface text-warning-text' : 'bg-muted text-foreground'}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4.5 shrink-0" aria-hidden="true">
        <path d={NOTICE_ICONS[icon]} />
      </svg>
      <span>{children}</span>
    </p>
  )
}
