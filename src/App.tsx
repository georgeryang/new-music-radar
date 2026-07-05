import { useEffect, useState } from 'react'
import { ReleaseCard } from '@/components/ReleaseCard'
import { formatRelativeTime, isFresh } from '@/lib/utils'
import type { FeedData } from '@/lib/types'

const PREFS_URL = 'http://127.0.0.1:4747'

export default function App() {
  const [data, setData] = useState<FeedData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prefsUp, setPrefsUp] = useState(false)

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

  // Fetcher pre-sorts (followed artists first, then alphabetical by artist);
  // the data file holds a wider window than we show — display trims per tier:
  // followed artists stay 72h, discovery finds 24h. Strict either way: an
  // empty window means an empty page, never older filler.
  const releases = (data?.releases ?? []).filter((r) => isFresh(r.release_date, r.followed ? 72 : 24))

  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 pb-12">
      <header className="mb-5 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">New Music Radar</h1>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {formatRelativeTime(data?.fetched_at ?? null)}
          {prefsUp && (
            <a href={PREFS_URL} target="_blank" rel="noopener noreferrer" title="Edit preferences" aria-label="Edit preferences" className="hover:text-foreground">
              ⚙
            </a>
          )}
        </span>
      </header>

      {error && <p className="py-4 text-sm text-destructive">{error}</p>}
      {!data && !error && <LoadingGrid />}
      {data &&
        (releases.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* | key separator — a hyphen is ambiguous when artist or title contains one */}
            {releases.map((r) => (
              <ReleaseCard key={`${r.artist}|${r.title}|${r.type}`} release={r} />
            ))}
          </div>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">No new releases right now.</p>
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
