import { useEffect, useState, type KeyboardEvent } from 'react'
import { ReleaseCard } from '@/components/ReleaseCard'
import { formatRelativeTime, isFreshAsOf, isUnreleased } from '@/lib/utils'
import type { FeedData, Release } from '@/lib/types'

const PREFS_URL = 'http://127.0.0.1:4747'

export default function App() {
  const [data, setData] = useState<FeedData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prefsUp, setPrefsUp] = useState(false)
  const [tab, setTab] = useState<'new' | 'upcoming'>('new')

  // Show the ⚙ link only when the local preferences editor (prefs.command)
  // is running on this machine — elsewhere the ping just fails silently.
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

  useEffect(() => {
    let cancelled = false
    // no-cache = conditional revalidation: a fresh deploy shows up immediately
    // (Pages serves ETags), but an unchanged file costs a 304 with no body
    // instead of the full re-download a ?v= cache-buster would force. The
    // stable URL also lets index.html preload this request.
    fetch(`${import.meta.env.BASE_URL}data/releases.json`, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error('Data not available.')
        return r.json()
      })
      .then((d: FeedData) => {
        // a malformed file should land in the error UI, not crash the render
        if (!Array.isArray(d?.releases)) throw new Error('Data not available.')
        if (!cancelled) setData(d)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || 'Failed to load releases')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The fetcher's New/Upcoming routing is an 18:15 KST snapshot; the split is
  // recomputed here against the viewer's clock so it stays honest between
  // fetches. Anything still future-dated renders on Upcoming — including
  // tomorrow-dated entries the fetch window deliberately admits into
  // releases[] — and a pre-order whose date has arrived joins the New grid at
  // local midnight instead of waiting for the evening fetch. Display windows
  // anchor to the LAST FETCH, never the viewer's clock — cards never expire
  // between fetches, only a new file changes the set. Followed artists get
  // the file's full window (the fetcher's WINDOW_DAYS); discovery finds show
  // only when released within 24h of the fetch, re-evaluated each fetch. The
  // two files' lists are disjoint by construction, but carryover after a
  // failed sweep can overlap them briefly — collapse by card key before
  // splitting.
  const byKey = new Map<string, Release>()
  for (const r of [...(data?.releases ?? []), ...(data?.upcoming ?? [])]) {
    const k = `${r.artist}|${r.title}|${r.type}`
    if (!byKey.has(k)) byKey.set(k, r)
  }
  const entries = [...byKey.values()]
  const releases = entries
    .filter(
      (r) =>
        !isUnreleased(r.release_date) &&
        (r.followed || isFreshAsOf(r.release_date, 24, data?.fetched_at ?? 0))
    )
    // re-sort: a flipped pre-order must slot into the fetcher's order
    // (followed first, artist A-Z, newest within artist), not trail the grid
    .sort(
      (a, b) =>
        (b.followed ? 1 : 0) - (a.followed ? 1 : 0) ||
        a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) ||
        b.release_date.localeCompare(a.release_date) ||
        a.title.localeCompare(b.title)
    )
  const upcoming = entries
    .filter((r) => isUnreleased(r.release_date))
    .sort(
      (a, b) =>
        a.release_date.localeCompare(b.release_date) ||
        a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
    )
  // An empty tab hides entirely: only-New renders barless (as before the
  // feature), only-Upcoming shows a single labelled pill for context, and
  // both-empty falls through to the info message.
  const tabs = [
    { key: 'new' as const, label: `New · ${releases.length}`, items: releases },
    { key: 'upcoming' as const, label: `Upcoming · ${upcoming.length}`, items: upcoming },
  ].filter((t) => t.items.length > 0)
  const active = tabs.find((t) => t.key === tab) ?? tabs[0]
  const shown = active?.items ?? []
  const showBar = upcoming.length > 0

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const idx = tabs.findIndex((t) => t.key === active?.key)
    const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    setTab(next.key)
    document.getElementById(`tab-${next.key}`)?.focus()
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 pb-12">
      <header className="mb-5 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">New Music Radar</h1>
        <span
          className="flex items-center gap-2 text-xs text-muted-foreground"
          title={data ? new Date(data.fetched_at).toLocaleString() : undefined}
        >
          {formatRelativeTime(data?.fetched_at ?? null)}
          {prefsUp && (
            <a href={PREFS_URL} target="_blank" rel="noopener noreferrer" title="Edit preferences" aria-label="Edit preferences" className="hover:text-foreground">
              ⚙
            </a>
          )}
        </span>
      </header>

      {error && (
        <p className="py-4 text-sm text-destructive">
          {error}{' '}
          <button onClick={() => location.reload()} className="underline hover:no-underline">
            Reload
          </button>
        </p>
      )}
      {!data && !error && <LoadingGrid />}
      {data && showBar && (
        <div
          role="tablist"
          aria-label="Release lists"
          onKeyDown={onTabKey}
          className="mb-4 flex w-fit gap-0.5 rounded-lg border border-border p-0.5 text-xs"
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              id={`tab-${t.key}`}
              role="tab"
              aria-selected={active?.key === t.key}
              aria-controls="release-panel"
              tabIndex={active?.key === t.key ? 0 : -1}
              onClick={() => setTab(t.key)}
              className={`rounded-md px-3 py-1 font-medium ${
                active?.key === t.key ? 'bg-muted' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {data &&
        (shown.length ? (
          <div
            id="release-panel"
            role={showBar ? 'tabpanel' : undefined}
            aria-labelledby={showBar && active ? `tab-${active.key}` : undefined}
            className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          >
            {/* | key separator — a hyphen is ambiguous when artist or title contains one */}
            {shown.map((r) => (
              <ReleaseCard key={`${r.artist}|${r.title}|${r.type}`} release={r} />
            ))}
          </div>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">
            {active?.key === 'upcoming'
              ? 'Nothing announced yet.'
              : 'No new releases right now. The page updates itself every evening.'}
          </p>
        ))}
    </div>
  )
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="aspect-square animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  )
}
