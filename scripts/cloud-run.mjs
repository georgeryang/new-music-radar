import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { JOB, PROJECT, REGION } from './cloud-config.mjs'

// A Finder-launched prefs.command has no shell PATH, so Homebrew's locations
// are checked explicitly, like find-node.sh does for node.
const CANDIDATES = [
  '/opt/homebrew/bin', '/usr/local/bin',
  '/opt/homebrew/share/google-cloud-sdk/bin', '/usr/local/share/google-cloud-sdk/bin',
  '/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin',
]
export function findGcloud(env = process.env, candidates = CANDIDATES) {
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...candidates]
  return dirs.map((d) => join(d, 'gcloud')).find((p) => existsSync(p)) ?? null
}

function gcloud(args, timeout = 30_000) {
  const bin = findGcloud()
  if (!bin) return Promise.reject(new Error('gcloud is not installed (brew install --cask google-cloud-sdk)'))
  return new Promise((resolve, reject) => {
    execFile(bin, [...args, '--project', PROJECT, '--quiet'], { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      // gcloud can print an update notice after the error, so pick the ERROR line.
      const lines = (stderr || err?.message || '').trim().split('\n')
      if (err) reject(new Error(lines.find((l) => /ERROR/.test(l)) ?? lines.at(-1)))
      else resolve(stdout)
    })
  })
}
const done = (e) => !!e?.status?.completionTime
export const isExecutionName = (name) => typeof name === 'string' && /^[a-z0-9-]+$/.test(name)

export async function runningExecution() {
  const list = JSON.parse(await gcloud(['run', 'jobs', 'executions', 'list', '--job', JOB, '--region', REGION, '--limit', '5', '--format', 'json']))
  return list.find((e) => !done(e))?.metadata?.name ?? null
}

export async function startExecution() {
  const out = JSON.parse(await gcloud(['run', 'jobs', 'execute', JOB, '--region', REGION, '--async', '--args=--force', '--format', 'json'], 60_000))
  const name = out?.metadata?.name
  if (!name) throw new Error('gcloud did not return an execution name')
  return name
}

export async function executionState(name) {
  const e = JSON.parse(await gcloud(['run', 'jobs', 'executions', 'describe', name, '--region', REGION, '--format', 'json']))
  return { done: done(e), succeeded: (e.status?.succeededCount ?? 0) > 0 }
}

export async function executionLog(name) {
  if (!isExecutionName(name)) throw new Error('invalid execution name')
  const filter = `resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="${name}"`
  const out = await gcloud(['logging', 'read', filter, '--order', 'desc', '--limit', '300', '--format', 'value(textPayload)'])
  return out.split('\n').filter(Boolean).reverse()
}
