import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { repo } from './helpers.mjs'

const hosts = ['.claude', '.agents']
function fixture(t, names = ['first', 'with spaces']) {
  const root = mkdtempSync(join(tmpdir(), 'radar skills '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  cpSync(join(repo, 'scripts/setup-skills.sh'), join(root, 'scripts/setup-skills.sh'))
  mkdirSync(join(root, 'skills'))
  for (const name of names) {
    mkdirSync(join(root, 'skills', name))
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\n`)
  }
  return root
}
function setup(root) {
  return spawnSync('bash', [join(root, 'scripts/setup-skills.sh')], { cwd: tmpdir(), encoding: 'utf8', timeout: 10_000 })
}
function snapshot(root) {
  return readdirSync(root).sort().map((name) => {
    const path = join(root, name), stat = lstatSync(path)
    return [name, stat.isSymbolicLink() ? ['link', readlinkSync(path)] : stat.isDirectory() ? snapshot(path) : readFileSync(path, 'utf8')]
  })
}
function hostDirs(root) {
  for (const host of hosts) mkdirSync(join(root, host, 'skills'), { recursive: true })
}

test('both hosts resolve skills through relative links; repeated setup preserves links', (t) => {
  const root = fixture(t)
  const first = setup(root)
  assert.equal(first.status, 0, first.stderr)
  const inodes = []
  for (const host of hosts) {
    for (const name of ['first', 'with spaces']) {
      const link = join(root, host, 'skills', name)
      assert.equal(readlinkSync(link), `../../skills/${name}`)
      assert.equal(realpathSync(join(link, 'SKILL.md')), realpathSync(join(root, 'skills', name, 'SKILL.md')))
      inodes.push([link, lstatSync(link).ino])
    }
  }
  const before = snapshot(root)
  assert.equal(setup(root).status, 0)
  assert.deepEqual(snapshot(root), before)
  for (const [link, inode] of inodes) assert.equal(lstatSync(link).ino, inode)
})

for (const collision of ['file', 'directory', 'valid symlink', 'dangling symlink']) {
  test(`preflight preserves both hosts on a ${collision} collision`, (t) => {
    const root = fixture(t)
    hostDirs(root)
    symlinkSync('../../skills/retired', join(root, '.claude/skills/retired'))
    const path = join(root, '.agents/skills/with spaces')
    if (collision === 'file') writeFileSync(path, 'keep this')
    else if (collision === 'directory') { mkdirSync(path); writeFileSync(join(path, 'keep'), 'keep this') }
    else symlinkSync(collision === 'valid symlink' ? '../../skills/first' : '../../elsewhere', path)
    const before = snapshot(root)
    const result = setup(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ERROR:/)
    assert.deepEqual(snapshot(root), before)
  })
}

test('only owned stale links are pruned; unrelated entries survive', (t) => {
  const root = fixture(t)
  hostDirs(root)
  for (const host of hosts) {
    const dest = join(root, host, 'skills')
    symlinkSync('../../skills/retired', join(dest, 'retired'))
    symlinkSync('../../elsewhere', join(dest, 'unrelated'))
    symlinkSync('../../skills/different-name', join(dest, 'different-target'))
    symlinkSync('../../skills/first', join(dest, 'alias'))
    writeFileSync(join(dest, 'local-file'), 'keep')
    mkdirSync(join(dest, 'local-directory'))
  }
  const result = setup(root)
  assert.equal(result.status, 0, result.stderr)
  for (const host of hosts) {
    const dest = join(root, host, 'skills')
    assert.equal(readdirSync(dest).includes('retired'), false)
    assert.equal(readlinkSync(join(dest, 'unrelated')), '../../elsewhere')
    assert.equal(readlinkSync(join(dest, 'different-target')), '../../skills/different-name')
    assert.equal(readlinkSync(join(dest, 'alias')), '../../skills/first')
    assert.equal(readFileSync(join(dest, 'local-file'), 'utf8'), 'keep')
    assert.ok(lstatSync(join(dest, 'local-directory')).isDirectory())
  }
})

test('malformed sources stop before creating host directories or pruning links', (t) => {
  const root = fixture(t)
  rmSync(join(root, 'skills/first/SKILL.md'))
  mkdirSync(join(root, '.claude/skills'), { recursive: true })
  symlinkSync('../../skills/first', join(root, '.claude/skills/first'))
  const before = snapshot(root)
  const result = setup(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing readable SKILL.md/)
  assert.deepEqual(snapshot(root), before)
  assert.equal(existsSync(join(root, '.agents')), false)
})

test('empty source set creates no literal glob links and still prunes owned stale links', (t) => {
  const root = fixture(t, [])
  hostDirs(root)
  for (const host of hosts) symlinkSync('../../skills/retired', join(root, host, 'skills/retired'))
  const result = setup(root)
  assert.equal(result.status, 0, result.stderr)
  for (const host of hosts) assert.deepEqual(readdirSync(join(root, host, 'skills')), [])
  assert.equal(setup(root).status, 0)
})

for (const parent of ['.agents', '.agents/skills']) {
  test(`setup refuses a symlinked ${parent} directory`, (t) => {
    const root = fixture(t)
    mkdirSync(join(root, 'elsewhere'))
    if (parent.includes('/')) mkdirSync(join(root, '.agents'))
    symlinkSync(join(root, 'elsewhere'), join(root, parent))
    const before = snapshot(root)
    assert.equal(setup(root).status, 1)
    assert.deepEqual(snapshot(root), before)
  })
}
