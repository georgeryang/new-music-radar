import test from 'node:test'
import assert from 'node:assert/strict'
import { itunesJSON } from '../scripts/apple-api.mjs'
import { overFollowed } from '../scripts/genre-tree.mjs'

test('genre ancestry accepts case-insensitive followed names', () => {
  assert.equal(overFollowed(new Map([['Soft Rock', ['Music', 'Rock']]]), ['soft rock'], 'rock'), 'soft rock')
})

test('concurrent iTunes requests reserve separate slots after a failure', async (t) => {
  const starts = []
  t.mock.method(globalThis, 'fetch', async () => {
    starts.push(Date.now())
    if (starts.length === 1) throw new Error('fixture failure')
    return new Response('{}')
  })
  const results = await Promise.allSettled(['one', 'two', 'three'].map(itunesJSON))
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled'])
  assert.ok(starts[1] - starts[0] >= 2450)
  assert.ok(starts[2] - starts[1] >= 2450)
})
