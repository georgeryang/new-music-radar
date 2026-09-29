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
  installBuild(stage, dest)
  assert.equal(readFileSync(join(dest, 'index.html'), 'utf8'), 'new')
  assert.equal(existsSync(join(dest, 'assets/old.js')), false)
  assert.equal(readFileSync(join(dest, 'data/releases.json'), 'utf8'), 'keep data')
})
