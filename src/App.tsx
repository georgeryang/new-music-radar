import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { ReleaseCard } from '@/components/ReleaseCard'
import { GearIcon, HourglassIcon, Notice, RadarIcon, RadarState } from '@/components/Icons'
import { formatRelativeTime, isFreshAsOf } from '@/lib/utils'
import { NAV_BAR_QUERY } from '@/lib/nav'
import { cardKeyOf } from '../scripts/card-key.mjs'
import { parseFeed } from '@/lib/feed-data'
import type { FeedData } from '@/lib/types'

const PREFS_URL = 'http://127.0.0.1:4747'
// Home Screen web apps stay resident overnight; refetch when reopened after this long.
const STALE_MS = 30 * 60e3
const GRID = 'grid grid-cols-2 gap-x-3 gap-y-4 @[34rem]:grid-cols-4 @[48rem]:grid-cols-6'
const PULL_TRIGGER = 72

const isHomeScreenApp = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

type TabKey = 'new' | 'upcoming'
type Filter = 'all' | 'following' | 'discovered'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'following', label: 'Following' },
  { key: 'discovered', label: 'Discovered' },
]

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function transition(update: () => void) {
  if (!document.startViewTransition || reducedMotion()) {
    update()
    return
  }
  // flushSync: React commits state asynchronously, and the transition must
  // snapshot the new DOM, not the old one.
  document.startViewTransition(() => flushSync(update))
}

function useMediaQuery(query: string) {
  const subscribe = useCallback((notify: () => void) => {
    const list = matchMedia(query)
    list.addEventListener('change', notify)
    return () => list.removeEventListener('change', notify)
  }, [query])
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false)
}

export default function App() {
  const [data, setData] = useState<FeedData | null>(null)
  const [failure, setFailure] = useState<'offline' | 'error' | null>(null)
  const [cached, setCached] = useState<'offline' | 'error' | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [rejected, setRejected] = useState(0)
  const [prefsUp, setPrefsUp] = useState(false)
  const [tab, setTab] = useState<TabKey>('new')
  const [minimized, setMinimized] = useState(false)
  const loadedAt = useRef(0)
  const animateIn = useRef(true)
  const navIsBar = useMediaQuery(NAV_BAR_QUERY)

  useEffect(() => {
    let cancelled = false
    fetch(`${PREFS_URL}/api/ping`, { signal: AbortSignal.timeout(800) })
      .then((r) => {
        if (!cancelled) setPrefsUp(r.ok)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback((background: boolean): Promise<boolean> => {
    // no-cache = conditional revalidation: a fresh deploy shows immediately
    // (Pages ETags), an unchanged file costs a 304 with no body. The stable
    // URL also lets index.html preload this request.
    return fetch(`${import.meta.env.BASE_URL}data/releases.json`, {
      cache: 'no-cache',
      signal: AbortSignal.timeout(15_000),
    })
      .then((r) => {
        if (!r.ok) throw new Error()
        const fallback = r.headers.get('X-Radar-Cached')
        setCached(fallback === 'offline' || fallback === 'error' ? fallback : null)
        return r.json()
      })
      .then((value: unknown) => {
        const parsed = parseFeed(value)
        loadedAt.current = Date.now()
        setData(parsed.data)
        setRejected(parsed.rejected)
        setFailure(null)
        return true
      })
      .catch(() => {
        if (!background) setFailure(navigator.onLine === false ? 'offline' : 'error')
        return false
      })
  }, [])

  // Home Screen apps have no reload button; Safari tabs already pull to refresh.
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNotice, setRefreshNotice] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (!isHomeScreenApp()) return
    document.documentElement.style.overscrollBehaviorY = 'none'
    let start: number | null = null
    let distance = 0
    const onStart = (e: TouchEvent) => { start = scrollY <= 0 ? e.touches[0].clientY : null }
    const onMove = (e: TouchEvent) => {
      if (start === null) return
      distance = Math.max(0, Math.min(120, (e.touches[0].clientY - start) * 0.6))
      if (distance > 0) e.preventDefault()
      setPull(distance)
    }
    const onEnd = () => {
      if (start !== null && distance >= PULL_TRIGGER) {
        setRefreshing(true)
        load(true).then((ok) => {
          setRefreshing(false)
          if (!ok) {
            setRefreshNotice(true)
            clearTimeout(noticeTimer.current)
            noticeTimer.current = setTimeout(() => setRefreshNotice(false), 3000)
          }
        })
      }
      start = null
      distance = 0
      setPull(0)
    }
    addEventListener('touchstart', onStart, { passive: true })
    addEventListener('touchmove', onMove, { passive: false })
    addEventListener('touchend', onEnd)
    return () => {
      removeEventListener('touchstart', onStart)
      removeEventListener('touchmove', onMove)
      removeEventListener('touchend', onEnd)
    }
  }, [load])

  useEffect(() => {
    load(false)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && loadedAt.current && Date.now() - loadedAt.current > STALE_MS) load(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  useEffect(() => {
    if (data) animateIn.current = false
  }, [data])

  useEffect(() => {
    let last = scrollY
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const y = scrollY
        if (y < 24) setMinimized(false)
        else if (y > last + 8) setMinimized(true)
        else if (y < last - 8) setMinimized(false)
        last = y
      })
    }
    addEventListener('scroll', onScroll, { passive: true })
    return () => {
      removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [])

  const releases = (data?.releases ?? []).filter(
    (r) => r.followed || isFreshAsOf(r.release_date, data?.fetched_at ?? 0)
  )
  const upcoming = (data?.upcoming ?? []).filter((r) => r.followed)
  const tabs = [
    { key: 'new' as const, label: 'New', Icon: RadarIcon, items: releases },
    { key: 'upcoming' as const, label: 'Upcoming', Icon: HourglassIcon, items: upcoming },
  ].filter((t) => t.items.length > 0)
  const active = tabs.find((t) => t.key === tab) ?? tabs[0]
  const activeKey = active?.key ?? 'new'
  const shown = active?.items ?? []
  const showBar = upcoming.length > 0

  const switchTab = (key: TabKey) => {
    if (key === activeKey) return
    transition(() => {
      setTab(key)
      setFilter('all')
    })
  }

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((t) => t.key === activeKey)
    let next: number
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % tabs.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx + tabs.length - 1) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    // else the arrows also scroll the page while switching tabs
    e.preventDefault()
    switchTab(tabs[next].key)
    document.getElementById(`tab-${tabs[next].key}`)?.focus()
  }

  // Only when both kinds exist, so a filter can never empty the grid.
  const showFilter = activeKey === 'new' && shown.some((r) => r.followed) && shown.some((r) => !r.followed)
  const activeFilter: Filter = showFilter ? filter : 'all'
  const visible = activeFilter === 'all' ? shown : shown.filter((r) => Boolean(r.followed) === (activeFilter === 'following'))

  const fetchedAt = data?.fetched_at ?? null
  const shownLabel = activeKey === 'upcoming' ? `${shown.length} announced` : `${shown.length} new`

  return (
    <div className="nav-side:flex nav-side:items-start">
      {(pull > 0 || refreshing) && (
        <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-30 flex justify-center" style={{ transform: `translateY(${refreshing ? 24 : pull / 2}px)` }}>
          <span className="floating flex size-10 items-center justify-center rounded-full text-primary">
            <RadarIcon className={`size-5 ${refreshing ? 'motion-safe:animate-[radar-spin_0.9s_linear_infinite]' : ''}`} />
          </span>
        </div>
      )}

      <nav
        data-minimized={minimized ? 'true' : undefined}
        className={`group/nav floating z-20
          nav-bar:fixed nav-bar:bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] nav-bar:left-1/2 nav-bar:-translate-x-1/2 nav-bar:rounded-full nav-bar:p-1
          nav-side:sticky nav-side:top-[max(0.75rem,env(safe-area-inset-top))] nav-side:mt-[max(0.75rem,env(safe-area-inset-top))] nav-side:mb-[max(0.75rem,env(safe-area-inset-bottom))] nav-side:ml-[max(0.75rem,calc(env(safe-area-inset-left)+0.5rem))]
          nav-side:flex nav-side:h-[calc(100dvh-max(0.75rem,env(safe-area-inset-top))-max(0.75rem,env(safe-area-inset-bottom)))] nav-side:w-56 nav-side:shrink-0 nav-side:flex-col nav-side:rounded-3xl nav-side:px-2 nav-side:pt-5 nav-side:pb-4
          ${data && !showBar ? 'nav-bar:hidden' : ''} ${data ? '' : 'invisible'}`}
      >
        <p className="hidden px-3 pb-4 text-xl leading-tight font-bold tracking-tight nav-side:block">New Music Radar</p>
        <div
          role="tablist"
          aria-label="Release lists"
          aria-orientation={navIsBar ? 'horizontal' : 'vertical'}
          onKeyDown={onTabKey}
          className="flex gap-0.5 nav-side:flex-col"
        >
          {tabs.map(({ key, label, Icon }) => {
            const selected = activeKey === key
            return (
              <button
                key={key}
                id={`tab-${key}`}
                role="tab"
                aria-selected={selected}
                aria-controls="release-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => switchTab(key)}
                className={`group relative flex cursor-pointer items-center justify-center rounded-full text-xs font-medium motion-safe:transition-[width,min-height,color] motion-safe:duration-300 motion-safe:ease-spring
                  nav-bar:min-h-13 nav-bar:w-23 nav-bar:flex-col nav-bar:gap-0.5 nav-bar:group-data-[minimized=true]/nav:min-h-10 nav-bar:group-data-[minimized=true]/nav:w-12
                  nav-side:min-h-11 nav-side:w-full nav-side:justify-start nav-side:gap-3 nav-side:rounded-lg nav-side:px-3 nav-side:text-base
                  ${selected ? 'text-primary' : 'text-foreground hover:text-primary'}`}
              >
                {selected && (
                  <span
                    aria-hidden="true"
                    style={{ viewTransitionName: 'nav-pill' }}
                    className="absolute inset-0 rounded-[inherit] bg-foreground/8"
                  />
                )}
                <Icon className="relative size-5.5 shrink-0 nav-side:size-5" />
                <span className="relative nav-bar:group-data-[minimized=true]/nav:sr-only">{label}</span>
              </button>
            )
          })}
        </div>
        <div className="hidden flex-1 nav-side:block" />
        <div className="hidden items-center justify-between gap-2 px-3 nav-side:flex">
          <UpdatedLabel fetchedAt={fetchedAt} className="text-sm text-muted-foreground" />
          {prefsUp && <PrefsLink />}
        </div>
      </nav>

      <div
        className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-[max(1rem,env(safe-area-inset-left))] pt-[max(1.5rem,calc(env(safe-area-inset-top)+0.5rem))]
          nav-bar:pb-[calc(env(safe-area-inset-bottom)+6.5rem)]
          nav-side:px-6 nav-side:pt-8 nav-side:pb-12 nav-side:pr-[max(1.5rem,calc(env(safe-area-inset-right)+1rem))]"
      >
        <header className="mb-5 flex items-start justify-between gap-3 nav-side:hidden">
          <div className="min-w-0">
            <h1 className="text-xl leading-tight font-bold tracking-tight">New Music Radar</h1>
            {data && (
              <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                {shownLabel} · <UpdatedLabel fetchedAt={fetchedAt} as="span" />
              </p>
            )}
          </div>
          {prefsUp && <PrefsLink />}
        </header>
        <header className="mb-6 hidden nav-side:block">
          <h1 className="text-[2rem] leading-tight font-bold tracking-tight">{active?.label ?? 'New'}</h1>
          {data && <p className="mt-1 text-sm text-muted-foreground tabular-nums">{shownLabel}</p>}
        </header>

        {/* header outside main: banner landmark only while not inside it */}
        <main className="@container">
          {cached === 'offline' && data && <Notice icon="offline">You’re offline. Showing the last saved update.</Notice>}
          {(cached === 'error' || refreshNotice) && data && <Notice icon="offline">Couldn’t refresh. Showing the last saved update.</Notice>}
          {rejected > 0 && data && (
            <Notice icon="warning" tone="warning">
              Some releases could not be displayed because their data is incomplete. Try reloading after the next update.
            </Notice>
          )}
          {!data && !failure && <RadarState mode="scan" title="Scanning for New Releases" body="Loading the latest update." live />}
          {!data && failure === 'offline' && (
            <RadarState mode="offline" title="You’re Offline" body="Connect once to load releases. After that, the latest update stays on this device." onRetry={() => { setFailure(null); load(false) }} live />
          )}
          {!data && failure === 'error' && (
            <RadarState title="Couldn’t Load Releases" body="The daily update may still be running. Try again in a few minutes." onRetry={() => { setFailure(null); load(false) }} live />
          )}
          {data && showFilter && (
            <div role="group" aria-label="Show" className="mb-4 flex flex-wrap gap-1.5">
              {FILTERS.map(({ key, label }) => (
                <button
                  key={key}
                  aria-pressed={activeFilter === key}
                  onClick={() => transition(() => setFilter(key))}
                  className={`min-h-9 cursor-pointer rounded-full px-3.5 text-sm font-medium ${
                    activeFilter === key ? 'bg-foreground text-background' : 'border border-border text-foreground hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {data &&
            (visible.length ? (
              <div
                id="release-panel"
                role={showBar || !navIsBar ? 'tabpanel' : undefined}
                aria-labelledby={showBar || !navIsBar ? `tab-${activeKey}` : undefined}
                className={GRID}
              >
                {visible.map((r, i) => (
                  <ReleaseCard
                    key={cardKeyOf(r)}
                    release={r}
                    upcoming={activeKey === 'upcoming'}
                    fetchedAt={data.fetched_at}
                    // above the fold at every layout (one row of six, three of two);
                    // lazy-loading them costs the largest image a round trip
                    eager={i < 6}
                    enterIndex={animateIn.current && i < 12 ? i : undefined}
                  />
                ))}
              </div>
            ) : rejected > 0 ? (
              <RadarState title="Nothing to Show Yet" body="No releases can be displayed from this update. Try reloading after the next update." live />
            ) : (
              <RadarState title="No New Releases Right Now" body="Updates daily." live />
            ))}
        </main>
      </div>

      {showBar && <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 bottom-0 z-10 hidden h-28 bg-gradient-to-t from-background/90 to-transparent nav-bar:block" />}
    </div>
  )
}

function UpdatedLabel({ fetchedAt, as: Tag = 'p', className = '' }: { fetchedAt: number | null; as?: 'p' | 'span'; className?: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60e3)
    return () => clearInterval(id)
  }, [])
  const text = formatRelativeTime(fetchedAt)
  return (
    <Tag
      key={text}
      className={`tabular-nums motion-safe:animate-[fade-in_300ms_ease-out] ${className}`}
      title={fetchedAt ? new Date(fetchedAt).toLocaleString() : undefined}
    >
      {text}
    </Tag>
  )
}

function PrefsLink() {
  return (
    <a href={PREFS_URL} target="_blank" rel="noopener noreferrer" title="Edit preferences" aria-label="Edit preferences" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong text-foreground hover:bg-muted">
      <GearIcon />
    </a>
  )
}
