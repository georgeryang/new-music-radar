import { useEffect, useState, type KeyboardEvent } from 'react'
import { ReleaseCard } from '@/components/ReleaseCard'
import { formatRelativeTime, isFreshAsOf } from '@/lib/utils'
import { keyOf } from '../scripts/card-key.mjs'
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

  // One clock: everything anchors to the LAST FETCH, never the viewer's. The
  // fetcher decides the New/Upcoming split (releases[] vs upcoming[]) and
  // writes both lists sorted; this component renders them as-is — a pre-order
  // moves to New only when a fetch finds its date passed, and cards never
  // expire between fetches, only a new file changes the set. Followed artists
  // get the file's full window (the fetcher's WINDOW_DAYS); discovery finds
  // show only when released within 24h of the fetch, re-evaluated each fetch.
  // keyOf is the fetcher's own dedup key (shared module) — a weaker key here
  // would let one release render twice when its title drifts between fetches.
  // release_date joins the key because keyOf alone over-collapses across the
  // two lists: a deluxe/edition PRE-ORDER of an already-released album strips
  // to the same keyOf and must keep its Upcoming card. The lists are disjoint
  // by construction, but a stale/hand-edited file might overlap them — drop
  // an upcoming entry whose card already renders on New.
  const cardKey = (r: Release) => `${keyOf(r)}|${r.release_date}`
  const releases = (data?.releases ?? []).filter(
    (r) => r.followed || isFreshAsOf(r.release_date, 24, data?.fetched_at ?? 0)
  )
  const newKeys = new Set(releases.map(cardKey))
  // followed artists only — a non-followed find with a future date must not
  // leak into Upcoming (Upcoming is a follow-list feature)
  const upcoming = (data?.upcoming ?? []).filter((r) => r.followed && !newKeys.has(cardKey(r)))
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
            <a href={PREFS_URL} target="_blank" rel="noopener noreferrer" title="Edit preferences" aria-label="Edit preferences" className="-m-2 p-2 hover:text-foreground">
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
          className="mb-4 flex w-fit gap-0.5 rounded-lg border border-border p-0.5 text-[13px] sm:text-xs"
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
              className={`rounded-md px-3 py-1.5 font-medium sm:py-1 ${
                active?.key === t.key ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
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
            {shown.map((r) => (
              <ReleaseCard
                key={cardKey(r)}
                release={r}
                upcoming={active?.key === 'upcoming'}
                fetchedAt={data.fetched_at}
              />
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
        <div key={i} className="aspect-square rounded-lg bg-muted motion-safe:animate-pulse" />
      ))}
    </div>
  )
}
