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

// Sources report plain dates (no time); window math is on calendar dates.
const localDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Discovery window: released within 24h of the LAST FETCH, not the viewer's
// clock, so the set never shrinks between fetches. Dates are calendar dates,
// so "24h" means "dated the fetch day or the day before".
export function isFreshAsOf(releaseDate: string, fetchedAt: number): boolean {
  return releaseDate >= localDateStr(new Date(fetchedAt - 24 * 3600e3))
}

// Upcoming date label: relative inside a week ("Tomorrow", "In 5 days"),
// calendar date beyond. Anchored to the fetch, so before a morning fetch a
// card can read "Tomorrow"; the header's "Updated Xh ago" carries staleness.
export function formatUpcoming(releaseDate: string, fetchedAt: number): { label: string; soon: boolean } {
  const todayStr = localDateStr(new Date(fetchedAt))
  const days = Math.round((Date.parse(releaseDate) - Date.parse(todayStr)) / 86400e3)
  if (days <= 1) return { label: 'Tomorrow', soon: true }
  if (days <= 7) return { label: `In ${days} days`, soon: true }
  // T00:00:00 pins to local time — a bare date string parses as UTC and can
  // render a day off in the viewer's timezone
  const d = new Date(releaseDate + 'T00:00:00')
  return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), soon: false }
}
