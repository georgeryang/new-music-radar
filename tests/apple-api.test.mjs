import test from 'node:test'
import assert from 'node:assert/strict'
import { itunesJSON } from '../scripts/apple-api.mjs'
import { overFollowed } from '../scripts/genre-tree.mjs'

test('genre ancestry accepts case-insensitive followed names', () => {
  assert.equal(overFollowed(new Map([['Soft Rock', ['Music', 'Rock']]]), ['soft rock'], 'rock'), 'soft rock')
})

test('concurrent iTunes requests reserve separate slots after a failure', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 })
  t.mock.method(Math, 'random', () => 0)
  const first = Promise.withResolvers(), second = Promise.withResolvers()
  const starts = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    starts.push([url, Date.now()])
    if (starts.length === 1) { first.resolve(); throw new Error('fixture failure') }
    if (starts.length === 2) second.resolve()
    return new Response('{}')
  })
  const pending = Promise.allSettled(['one', 'two', 'three'].map(itunesJSON))
  await first.promise
  t.mock.timers.tick(2499)
  assert.equal(starts.length, 1)
  t.mock.timers.tick(1)
  await second.promise
  t.mock.timers.tick(2499)
  assert.equal(starts.length, 2)
  t.mock.timers.tick(1)
  const results = await pending
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled'])
  assert.deepEqual(starts, [['one', 10_000], ['two', 12_500], ['three', 15_000]])
})
