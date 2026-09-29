import { mkdtempSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'

export const repo = fileURLToPath(new URL('../', import.meta.url))
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'radar-test-'))
  for (const dir of ['scripts', 'config', 'docs']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(root, '.gitignore'), '.radar-run.lock*\n*.tmp\nhome/\nbin/\n')
  mkdirSync(join(root, 'home/Library/Logs'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
export function run(root, command, args, env = {}) {
  return spawnSync(command, args, { cwd: root, env: { ...process.env, HOME: join(root, 'home'), ...env }, encoding: 'utf8', timeout: 30_000 })
}
export async function background(t, root, code, env = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, env: { ...process.env, HOME: join(root, 'home'), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
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
