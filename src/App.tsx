import { useEffect, useState, type KeyboardEvent } from 'react'
import { ReleaseCard } from '@/components/ReleaseCard'
import { formatRelativeTime, isFreshAsOf } from '@/lib/utils'
import { cardKeyOf } from '../scripts/card-key.mjs'
import type { FeedData } from '@/lib/types'

const PREFS_URL = 'http://127.0.0.1:4747'

export default function App() {
  const [data, setData] = useState<FeedData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prefsUp, setPrefsUp] = useState(false)
  const [tab, setTab] = useState<'new' | 'upcoming'>('new')

  // Show the ⚙ link only when the local editor is running on this machine —
  // elsewhere the ping fails silently.
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
    // no-cache = conditional revalidation: a fresh deploy shows immediately
    // (Pages ETags), an unchanged file costs a 304 with no body. The stable
    // URL also lets index.html preload this request.
    // timeout so a stalled connection lands in the error UI instead of
    // pulsing the skeleton grid forever
    fetch(`${import.meta.env.BASE_URL}data/releases.json`, {
      cache: 'no-cache',
      signal: AbortSignal.timeout(15_000),
    })
      .then((r) => {
        if (!r.ok) throw new Error()
        return r.json()
      })
      .then((d: FeedData) => {
        // a malformed file should land in the error UI, not crash the render.
        // upcoming too — it is filtered below, so a non-array throws mid-render
        if (!Array.isArray(d?.releases)) throw new Error()
        if (d.upcoming !== undefined && !Array.isArray(d.upcoming)) throw new Error()
        if (!cancelled) setData(d)
      })
      .catch(() => {
        // one written message, never the raw rejection: an HTML error page
        // makes r.json() reject with "Unexpected token '<'"
        if (!cancelled) setError('Could not load releases. The nightly update may not have run yet.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const releases = (data?.releases ?? []).filter(
    (r) => r.followed || isFreshAsOf(r.release_date, data?.fetched_at ?? 0)
  )
  // followed artists only — Upcoming is a follow-list feature
  const upcoming = (data?.upcoming ?? []).filter((r) => r.followed)
  // An empty tab hides: only-New renders barless, only-Upcoming shows one
  // labelled pill, both-empty falls through to the info message.
  const tabs = [
    { key: 'new' as const, label: `New · ${releases.length}`, items: releases },
    { key: 'upcoming' as const, label: `Upcoming · ${upcoming.length}`, items: upcoming },
  ].filter((t) => t.items.length > 0)
  const active = tabs.find((t) => t.key === tab) ?? tabs[0]
  // both lists empty means no tabs at all; the info message below covers it
  const activeKey = active?.key ?? 'new'
  const shown = active?.items ?? []
  const showBar = upcoming.length > 0

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((t) => t.key === activeKey)
    let next: number
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (idx + tabs.length - 1) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    // else the arrows also scroll the page while switching tabs
    e.preventDefault()
    setTab(tabs[next].key)
    document.getElementById(`tab-${tabs[next].key}`)?.focus()
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
            <a href={PREFS_URL} target="_blank" rel="noopener noreferrer" title="Edit preferences" aria-label="Edit preferences" className="-m-2 p-2 hover:text-foreground">
              ⚙
            </a>
          )}
        </span>
      </header>

      {error && (
        <p role="alert" className="py-4 text-sm text-destructive">
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
          className="mb-4 flex w-fit gap-0.5 rounded-lg border border-border p-0.5 text-[13px] sm:text-xs"
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              id={`tab-${t.key}`}
              role="tab"
              aria-selected={activeKey === t.key}
              aria-controls="release-panel"
              tabIndex={activeKey === t.key ? 0 : -1}
              onClick={() => setTab(t.key)}
              className={`rounded-md px-3 py-1.5 font-medium sm:py-1 ${
                activeKey === t.key ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
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
            aria-labelledby={showBar ? `tab-${activeKey}` : undefined}
            className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          >
            {shown.map((r, i) => (
              <ReleaseCard
                key={cardKeyOf(r)}
                release={r}
                upcoming={activeKey === 'upcoming'}
                fetchedAt={data.fetched_at}
                // first four: one row at sm and up, two rows on a phone. All
                // are above the fold either way, and lazy-loading them costs
                // the largest image a round trip.
                eager={i < 4}
              />
            ))}
          </div>
        ) : (
          <p role="status" className="py-3 text-sm text-muted-foreground">
            {activeKey === 'upcoming'
              ? 'Nothing announced yet.'
              : 'No new releases right now. Updates every evening.'}
          </p>
        ))}
    </div>
  )
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="aspect-square rounded-lg bg-muted motion-safe:animate-pulse" />
      ))}
    </div>
  )
}
