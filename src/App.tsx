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
    fetch(`${PREFS_URL}/api/ping`, { signal: AbortSignal.timeout(800) })
      .then((r) => setPrefsUp(r.ok))
      .catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    // ?v= busts the GitHub Pages CDN cache so a fresh deploy shows up immediately
    fetch(`${import.meta.env.BASE_URL}data/releases.json?v=${Date.now()}`)
      .then((r) => {
        if (!r.ok) throw new Error('Data not available.')
        return r.json()
      })
      .then((d: FeedData) => {
        if (!cancelled) setData(d)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || 'Failed to load releases')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Fetcher pre-sorts (preferred artist → preferred genre → date desc); the
  // data file holds a wider window than we show — display trims to 36 hours.
  const releases = (data?.releases ?? []).filter((r) => isFresh(r.release_date, 36))

  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 pb-12">
      <header className="mb-5 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">New Music Radar</h1>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {formatRelativeTime(data?.fetched_at ?? null)}
          {prefsUp && (
            <a href={PREFS_URL} target="_blank" rel="noopener noreferrer" title="Edit preferences" className="hover:text-foreground">
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
            {releases.map((r) => (
              <ReleaseCard key={`${r.artist}-${r.title}-${r.type}`} release={r} />
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
