import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { fixture, background } from './helpers.mjs'

async function editor(t) {
  const root = fixture(t)
  writeFileSync(join(root, 'mock-server.mjs'), `import {appendFileSync} from 'node:fs';
    globalThis.fetch=async(url)=>{appendFileSync('requests.txt',url+'\\n');return new Response(JSON.stringify({results:[{wrapperType:'artist',artistId:42,artistName:'Test',artistLinkUrl:'https://music.apple.com/us/artist/test/42'}]}))};
    const {server}=await import('./scripts/prefs-server.mjs'); server.listen(0,'127.0.0.1',()=>console.log(server.address().port));`)
  const child = await background(t, root, "await import('./mock-server.mjs')")
  const port = Number(child.ready)
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: '127.0.0.1:4747', ...options.headers } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })))
    })
    req.on('error', reject); req.end(options.body)
  })
  return { root, request, port }
}

test('editor rejects malformed targets and foreign origins while staying available', async (t) => {
  const { port, request } = await editor(t)
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '//[', headers: { host: '127.0.0.1:4747' } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(status, 400)
  assert.equal((await request('/api/prefs', { headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await request('/api/prefs')).status, 200)
})

test('scheduled refresh blocks preference writes and appears in editor status', async (t) => {
  const { root, request } = await editor(t)
  const before = readFileSync(join(root, 'config/preferences.json'), 'utf8')
  const child = await background(t, root, "import {holdRunLock} from './scripts/run-lock.mjs'; holdRunLock('refresh'); console.log('ready'); setInterval(()=>{},1000)")
  assert.equal((await (await request('/api/status')).json()).running, true)
  const saved = await request('/api/prefs', { method: 'POST', body: before })
  assert.equal(saved.status, 409)
  assert.equal((await request('/api/refresh', { method: 'POST' })).status, 409)
  assert.equal(readFileSync(join(root, 'config/preferences.json'), 'utf8'), before)
  child.kill(); await once(child, 'exit')
  assert.equal((await request('/api/prefs', { method: 'POST', body: before })).status, 200)
})

test('duplicate searches share one upstream request', async (t) => {
  const { root, request } = await editor(t)
  const responses = await Promise.all([request('/api/artist-search?q=Test'), request('/api/artist-search?q=Test')])
  assert.deepEqual(await responses[0].json(), await responses[1].json())
  await request('/api/artist-search?q=Test')
  assert.equal(readFileSync(join(root, 'requests.txt'), 'utf8').trim().split('\n').length, 1)
})

test('editor refresh reserves ownership before responding and continues independently', async (t) => {
  const { root, request } = await editor(t)
  writeFileSync(join(root, 'scripts/update.sh'), '#!/bin/bash\nsleep 0.4\necho Published\n')
  const before = readFileSync(join(root, 'config/preferences.json'), 'utf8')
  assert.equal((await request('/api/refresh', { method: 'POST' })).status, 200)
  assert.equal((await request('/api/prefs', { method: 'POST', body: before })).status, 409)
  await new Promise((resolve) => setTimeout(resolve, 600))
  const status = await (await request('/api/status')).json()
  assert.equal(status.running, false)
  assert.deepEqual(status.log, ['Published'])
})

test('direct fetch blocks writes without claiming a publishing refresh', async (t) => {
  const { root, request } = await editor(t)
  const child = await background(t, root, "import {holdRunLock} from './scripts/run-lock.mjs'; holdRunLock('fetch'); console.log('ready'); setInterval(()=>{},1000)")
  const status = await (await request('/api/status')).json()
  assert.equal(status.running, false)
  assert.equal(status.busy, true)
  const saved = await request('/api/prefs', { method: 'POST', body: readFileSync(join(root, 'config/preferences.json'), 'utf8') })
  assert.equal(saved.status, 409)
  child.kill(); await once(child, 'exit')
  const finished = await (await request('/api/status')).json()
  assert.equal(finished.running, false)
  assert.equal(finished.busy, false)
})
