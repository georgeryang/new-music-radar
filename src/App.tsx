import { useEffect, useState } from 'react'
import { AlbumCard } from '@/components/AlbumCard'
import { SongRow } from '@/components/SongRow'
import { formatRelativeTime, isFresh } from '@/lib/utils'
import type { FeedData } from '@/lib/types'

export default function App() {
  const [data, setData] = useState<FeedData | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  const albums = releases.filter((r) => r.type !== 'song')
  const songs = releases.filter((r) => r.type === 'song')

  return (
    <div className="mx-auto max-w-2xl px-4 pt-6 pb-12">
      <header className="mb-5 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">New Music Radar</h1>
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(data?.fetched_at ?? null)}
        </span>
      </header>

      {error && <p className="py-4 text-sm text-destructive">{error}</p>}
      {!data && !error && <LoadingGrid />}
      {data && (
        <>
          <section className="mb-6">
            <h2 className="mb-2.5 text-sm font-semibold text-muted-foreground">Albums &amp; EPs</h2>
            {albums.length ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {albums.map((r) => (
                  <AlbumCard key={`${r.artist}-${r.title}`} release={r} />
                ))}
              </div>
            ) : (
              <Empty what="albums" />
            )}
          </section>
          <section>
            <h2 className="mb-2.5 text-sm font-semibold text-muted-foreground">Songs</h2>
            {songs.length ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {songs.map((r) => (
                  <SongRow key={`${r.artist}-${r.title}`} release={r} />
                ))}
              </div>
            ) : (
              <Empty what="songs" />
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Empty({ what }: { what: string }) {
  return <p className="py-3 text-sm text-muted-foreground">No new {what} right now.</p>
}

function LoadingGrid() {
  return (
    <div aria-busy="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="aspect-square animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  )
}
