import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

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

// Sources report release *dates* (no time), so relative stamps compare
// calendar days in the viewer's timezone.
export function formatReleaseDay(releaseDate: string): string {
  const [y, m, d] = releaseDate.split('-').map(Number)
  const release = new Date(y, m - 1, d)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((today.getTime() - release.getTime()) / 86400e3)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(release)
}
