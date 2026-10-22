import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installBuild } from '../scripts/build-site.mjs'

test('incomplete staging retains old HTML/assets; successful replacement preserves data', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'radar-build-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stage = join(root, 'stage'), dest = join(root, 'docs')
  for (const dir of [stage, join(dest, 'assets'), join(dest, 'fonts'), join(dest, 'data')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dest, 'index.html'), 'old'); writeFileSync(join(dest, 'assets/old.js'), 'old')
  writeFileSync(join(dest, 'data/releases.json'), 'keep data')
  assert.throws(() => installBuild(stage, dest))
  assert.equal(readFileSync(join(dest, 'index.html'), 'utf8'), 'old')
  assert.ok(existsSync(join(dest, 'assets/old.js')))
  for (const dir of ['assets', 'fonts']) mkdirSync(join(stage, dir))
  writeFileSync(join(stage, 'index.html'), 'new'); writeFileSync(join(stage, 'assets/new.js'), 'new')
  assert.throws(() => installBuild(stage, dest))
  assert.equal(readFileSync(join(dest, 'index.html'), 'utf8'), 'old')
  writeFileSync(join(stage, 'sw.js'), 'worker')
  installBuild(stage, dest)
  assert.equal(readFileSync(join(dest, 'index.html'), 'utf8'), 'new')
  assert.equal(readFileSync(join(dest, 'sw.js'), 'utf8'), 'worker')
  assert.equal(existsSync(join(dest, 'assets/old.js')), false)
  assert.equal(readFileSync(join(dest, 'data/releases.json'), 'utf8'), 'keep data')
})

test('link preview meta points at an absolute, published image of the declared size', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const meta = (key) => html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`))?.[1]
  const site = 'https://georgeryang.github.io/new-music-radar/'
  assert.equal(meta('og:url'), site)
  const image = meta('og:image')
  assert.ok(image?.startsWith(site + 'assets/'), image)
  const png = readFileSync(new URL('../public/' + image.slice(site.length), import.meta.url))
  assert.equal(png.readUInt32BE(16), Number(meta('og:image:width')))
  assert.equal(png.readUInt32BE(20), Number(meta('og:image:height')))
  assert.equal(meta('og:description'), meta('description'))
  assert.ok(meta('description').length <= 80, meta('description'))
})
