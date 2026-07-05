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

// Upcoming-card date label: relative inside a week ("Tomorrow", "In 5 days"),
// calendar date beyond ("Sep 18"). Same calendar-day math as isFresh — the
// data carries dates, not times.
export function formatUpcoming(releaseDate: string): { label: string; soon: boolean } {
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const days = Math.round((Date.parse(releaseDate) - Date.parse(todayStr)) / 86400e3)
  if (days <= 1) return { label: 'Tomorrow', soon: true }
  if (days <= 7) return { label: `In ${days} days`, soon: true }
  // T00:00:00 pins the date to local time — a bare date string parses as UTC
  // and can render one day off in the viewer's timezone
  const d = new Date(releaseDate + 'T00:00:00')
  return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), soon: false }
}
