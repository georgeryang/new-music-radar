import { readFileSync, unlinkSync, mkdirSync, statSync, openSync, closeSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { REFRESH_LOG, writeFileAtomic } from './shared.mjs'

const lockPath = fileURLToPath(new URL('../.radar-run.lock', import.meta.url))
const ownerPath = lockPath + '.json'
export class BusyError extends Error {
  constructor() { super('Another operation is running. Wait for it to finish, then try again.') }
}

export function runOwner() {
  let owner
  try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid operation owner')
  try { process.kill(owner.pid, 0) } catch (e) {
    if (e.code === 'ESRCH') return null
    if (e.code !== 'EPERM') throw e
  }
  return owner
}

export function acquireRunLock(kind, { inherited = false } = {}) {
  const owner = runOwner()
  if (inherited && owner?.kind === 'refresh' && owner.token && owner.token === process.env.RADAR_RUN_TOKEN) {
    return { token: owner.token, release() {} }
  }
  // lockf's descriptor mode locks the shared open-file description. Keep this
  // inode: unlinking it would let another process lock a different file.
  const fd = openSync(lockPath, 'a+', 0o600)
  const result = spawnSync('/usr/bin/lockf', ['-s', '-t', '0', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] })
  if (result.error || result.status !== 0) {
    closeSync(fd)
    if (result.error) throw result.error
    if (result.status === 75) throw new BusyError()
    throw new Error('Could not acquire operation lock: ' + result.stderr.toString().trim())
  }
  const token = randomUUID()
  let logStart = 0
  try { logStart = statSync(REFRESH_LOG).size } catch {}
  try { writeFileAtomic(ownerPath, JSON.stringify({ pid: process.pid, token, kind, logStart })) } catch (e) {
    closeSync(fd)
    throw e
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    try { if (runOwner()?.token === token) unlinkSync(ownerPath) } finally { closeSync(fd) }
  }
  return { token, fd, release }
}

export function holdRunLock(kind) {
  let lock
  try { lock = acquireRunLock(kind, { inherited: kind === 'fetch' }) } catch (e) {
    console.error(`${e instanceof BusyError ? 'BUSY' : 'ERROR'}: ${e.message}`)
    process.exit(1)
  }
  process.once('exit', lock.release)
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => process.exit(code))
  }
  return lock
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [kind, command, ...args] = process.argv.slice(2)
  if (kind === '--owns-refresh' || kind === '--reset-log-start') {
    const owner = runOwner()
    if (owner?.kind !== 'refresh' || !owner.token || owner.token !== process.env.RADAR_RUN_TOKEN) process.exit(1)
    if (kind === '--reset-log-start') {
      let logStart = 0
      try { logStart = statSync(REFRESH_LOG).size } catch {}
      writeFileAtomic(ownerPath, JSON.stringify({ ...owner, logStart }))
    }
    process.exit(0)
  }
  if (kind !== 'refresh' || !command) throw new Error('usage: run-lock.mjs refresh command [args]')
  const lock = acquireRunLock(kind)
  mkdirSync(dirname(REFRESH_LOG), { recursive: true })
  const child = spawn(command, args, { stdio: ['inherit', 'inherit', 'inherit', lock.fd], env: { ...process.env, RADAR_RUN_TOKEN: lock.token } })
  if (process.send) process.send({ ready: true })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.once('error', (e) => { console.error(`ERROR: ${e.message}`); lock.release(); process.exitCode = 1 })
  child.once('exit', (code) => { lock.release(); process.exitCode = code ?? 1 })
}
