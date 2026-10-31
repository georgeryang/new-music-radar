import { mkdtempSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'

export const repo = fileURLToPath(new URL('../', import.meta.url))
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'radar-test-'))
  for (const dir of ['scripts', 'config', 'docs']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  // Fixtures exercise the Mac path unless a test writes its own cloud config.
  const cloudConfig = join(root, 'scripts/cloud-config.mjs')
  const config = readFileSync(cloudConfig, 'utf8')
  if (!/^export const CLOUD_REFRESH = (true|false)$/m.test(config)) throw new Error('cloud-config.mjs no longer declares CLOUD_REFRESH as expected')
  writeFileSync(cloudConfig, config.replace('CLOUD_REFRESH = true', 'CLOUD_REFRESH = false'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(root, '.gitignore'), '.radar-run.lock*\n*.tmp\nhome/\nbin/\n')
  mkdirSync(join(root, 'home/Library/Logs'), { recursive: true })
  mkdirSync(join(root, 'home/.config'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
export function gitRemote(t, root) {
  const remote = root + '-remote.git'
  t.after(() => rmSync(remote, { recursive: true, force: true }))
  const git = (cwd, ...args) => {
    const r = spawnSync('/usr/bin/git', args, { cwd, env: childEnv(root), encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'baseline')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'remote', 'add', 'origin', remote)
  git(root, 'push', '-q', '-u', 'origin', 'main')
  // A second clone stands in for another writer (the cloud job or another Mac).
  const other = (message, file, content) => {
    const dir = root + '-other'
    rmSync(dir, { recursive: true, force: true })
    git(root, 'clone', '-q', remote, dir)
    git(dir, 'config', 'user.name', 'Other'); git(dir, 'config', 'user.email', 'other@example.com')
    writeFileSync(join(dir, file), content)
    git(dir, 'add', file); git(dir, 'commit', '-q', '-m', message); git(dir, 'push', '-q', 'origin', 'main')
    rmSync(dir, { recursive: true, force: true })
  }
  return { remote, git: (...args) => git(root, ...args), remoteLog: () => git(remote, 'log', '--format=%s', 'main'), other }
}

export function childEnv(root, overrides = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'home/.config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...overrides,
  }
}
export function run(root, command, args, env = {}) {
  return spawnSync(command, args, { cwd: root, env: childEnv(root, env), encoding: 'utf8', timeout: 30_000 })
}
export async function background(t, root, code, env = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, env: childEnv(root, env), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (data) => { stderr += data })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit') }
  })
  const ready = await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error('Fixture exited before ready: ' + code + ' ' + stderr) }),
  ])
  child.ready = ready[0].toString().trim()
  return child
}
