import type { FeedData, Release } from './types'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function release(value: unknown): value is Release {
  if (!object(value)) return false
  if (!text(value.title) || !text(value.artist) || !text(value.release_date)) return false
  if (value.type !== 'song' && value.type !== 'album') return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.release_date)) return false
  const date = new Date(value.release_date)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.release_date) return false
  return typeof value.artwork === 'string'
    && (value.genre == null || typeof value.genre === 'string')
    && (value.link === undefined || typeof value.link === 'string')
    && (value.followed === undefined || typeof value.followed === 'boolean')
}

function artwork(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' && (parsed.hostname === 'mzstatic.com' || parsed.hostname.endsWith('.mzstatic.com'))) return url
  } catch {}
  return ''
}

export function parseFeed(value: unknown): { data: FeedData; rejected: number } {
  if (!object(value) || typeof value.fetched_at !== 'number' || value.fetched_at <= 0
    || !Number.isFinite(new Date(value.fetched_at).getTime())
    || !Array.isArray(value.releases) || (value.upcoming !== undefined && !Array.isArray(value.upcoming))) {
    throw new Error('Invalid release feed')
  }
  let rejected = 0
  const rows = (items: unknown[]): Release[] => items.flatMap((item) => {
    if (!release(item)) { rejected++; return [] }
    return [{ ...item, artwork: artwork(item.artwork) }]
  })
  const data = {
    fetched_at: value.fetched_at,
    releases: rows(value.releases),
    upcoming: rows(value.upcoming ?? []),
  }
  return { data, rejected }
}
