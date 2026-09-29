import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFeed } from '../src/lib/feed-data.ts'

const card = { title: 'Title', artist: 'Artist', type: 'album', release_date: '2026-09-29', artwork: 'https://is1-ssl.mzstatic.com/art.webp' }
const feed = { fetched_at: Date.now(), releases: [card], upcoming: [] }
test('invalid records do not hide valid releases', () => {
  const result = parseFeed({ ...feed, releases: [card, null, { ...card, artist: 2 }, { ...card, release_date: '2026-02-30' }, { ...card, followed: 'yes' }] })
  assert.equal(result.rejected, 4)
  assert.equal(result.data.releases.length, 1)
})
test('invalid envelopes fail, legitimate empty data remains valid', () => {
  for (const bad of [null, { ...feed, fetched_at: NaN }, { ...feed, fetched_at: 1e20 }, { ...feed, releases: {} }, { ...feed, upcoming: {} }]) assert.throws(() => parseFeed(bad))
  assert.equal(parseFeed({ ...feed, releases: [] }).rejected, 0)
})
test('untrusted artwork uses placeholder; valid Unicode metadata survives', () => {
  const result = parseFeed({ ...feed, releases: [{ ...card, artist: '안녕', artwork: 'https://evil.example#.mzstatic.com/x' }] })
  assert.equal(result.data.releases[0].artist, '안녕')
  assert.equal(result.data.releases[0].artwork, '')
})
