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

// Sources report plain dates (no time) — all window math happens on local
// calendar dates.
const localDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Discovery display window: released within `hours` of the LAST FETCH — not
// the viewer's clock, so the set never shrinks between fetches; a card shown
// once stays until the next fetch re-evaluates it. Dates are calendar dates
// (no time), so "24h" concretely means "dated the fetch day or the day
// before". Lower bound only: future dates pass (use isUnreleased for those).
export function isFreshAsOf(releaseDate: string, hours: number, fetchedAt: number): boolean {
  return releaseDate >= localDateStr(new Date(fetchedAt - hours * 3600e3))
}

// Still unreleased: dated strictly after today. Drives the Upcoming tab —
// on release day the card leaves Upcoming and enters the grid via the next
// fetch.
export function isUnreleased(releaseDate: string): boolean {
  return releaseDate > localDateStr(new Date())
}

// Upcoming-card date label: relative inside a week ("Tomorrow", "In 5 days"),
// calendar date beyond ("Sep 18").
export function formatUpcoming(releaseDate: string): { label: string; soon: boolean } {
  const todayStr = localDateStr(new Date())
  const days = Math.round((Date.parse(releaseDate) - Date.parse(todayStr)) / 86400e3)
  if (days <= 1) return { label: 'Tomorrow', soon: true }
  if (days <= 7) return { label: `In ${days} days`, soon: true }
  // T00:00:00 pins the date to local time — a bare date string parses as UTC
  // and can render one day off in the viewer's timezone
  const d = new Date(releaseDate + 'T00:00:00')
  return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), soon: false }
}
