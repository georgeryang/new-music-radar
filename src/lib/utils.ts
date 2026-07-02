export function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return ''
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'Updated just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Updated ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Updated ${hours}h ago`
  return `Updated ${Math.floor(hours / 24)}d ago`
}

// Display window: only releases from the last N hours. Sources report plain
// dates (no time), so compare against the calendar date N hours ago in the
// viewer's timezone — a release dated on/after that day counts as fresh.
export function isFresh(releaseDate: string, hours: number): boolean {
  const cutoff = new Date(Date.now() - hours * 3600e3)
  const cutStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
  return releaseDate >= cutStr
}
