import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, gitRemote, run, background } from './helpers.mjs'

const gh = '#!/bin/bash\nif [ "$2" = list ]; then echo 123; else echo success; fi\n'

function cloudFixture(t) {
  const root = fixture(t)
  writeFileSync(join(root, 'scripts/fetch-releases.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync('fetch-ran', '1');
if (process.env.NEW_DATA !== '0') writeFileSync('docs/data/releases.json', JSON.stringify({ fetched_at: Date.now(), releases: [] }));
process.exit(Number(process.env.FETCH_STATUS ?? 0));`)
  writeFileSync(join(root, '.gitignore'), '.radar-run.lock*\n*.tmp\nhome/\nbin/\nfetch-ran\n')
  const repo = gitRemote(t, root)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/gh'), gh, { mode: 0o755 })
  writeFileSync(join(root, 'bin/git'), `#!/bin/bash
if [ "$1" = push ] && [ -n "$PUSH_THEN_FAIL" ]; then /usr/bin/git "$@"; exit 1; fi
exec /usr/bin/git "$@"
`, { mode: 0o755 })
  const refresh = (args = [], env = {}) => run(root, 'bash', ['scripts/cloud-refresh.sh', ...args], { PATH: join(root, 'bin') + ':' + process.env.PATH, ...env })
  return { root, ...repo, refresh }
}

test('cloud refresh publishes data with the pathspec only, and a partial fetch still exits 0', (t) => {
  const { root, git, remoteLog, refresh } = cloudFixture(t)
  writeFileSync(join(root, 'scripts/unrelated.mjs'), '// local edit')
  const r = refresh([], { FETCH_STATUS: '2' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /publishing partial data/)
  assert.match(r.stdout, /Published/)
  assert.match(r.stdout, /Pages deploy verified/)
  assert.match(remoteLog().split('\n')[0], /^Update data /)
  assert.equal(git('show', '--format=', '--name-only', 'HEAD'), 'docs/data/releases.json')
})

test('cloud refresh stops before committing when the fetch does not run', (t) => {
  const { remoteLog, refresh } = cloudFixture(t)
  const r = refresh([], { FETCH_STATUS: '1' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /ERROR: fetch did not run/)
  assert.equal(remoteLog(), 'baseline')
})

test('cloud refresh --if-stale skips a fresh feed and --force runs anyway', (t) => {
  const { root, remoteLog, refresh } = cloudFixture(t)
  writeFileSync(join(root, 'docs/data/releases.json'), JSON.stringify({ fetched_at: Date.now(), releases: [] }))
  const skipped = refresh(['--if-stale'])
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
  assert.match(skipped.stdout, /No changes: the last fetch already covers/)
  assert.equal(existsSync(join(root, 'fetch-ran')), false)
  const forced = refresh(['--if-stale', '--force'])
  assert.equal(forced.status, 0, forced.stdout + forced.stderr)
  assert.equal(existsSync(join(root, 'fetch-ran')), true)
  assert.match(remoteLog().split('\n')[0], /^Update data /)
})

test('cloud refresh --no-push leaves the remote untouched', (t) => {
  const { remoteLog, refresh } = cloudFixture(t)
  const r = refresh(['--no-push'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /docs\/data\/releases\.json/)
  assert.equal(remoteLog(), 'baseline')
})

test('cloud refresh rebases onto a preferences push and retries once', (t) => {
  const { remoteLog, refresh, other } = cloudFixture(t)
  other('Update preferences', 'config/preferences.json', '{"changed":true}\n')
  const r = refresh()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /Published/)
  assert.deepEqual(remoteLog().split('\n').map((l) => l.split(' ').slice(0, 2).join(' ')), ['Update data', 'Update preferences', 'baseline'])
})

test('cloud refresh stands down when a concurrent run already published', (t) => {
  const { remoteLog, refresh, other } = cloudFixture(t)
  other('Update data from another run', 'docs/data/releases.json', '{"fetched_at":1}\n')
  const r = refresh()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /No changes: a newer run already published/)
  assert.equal(remoteLog().split('\n')[0], 'Update data from another run')
})

test('cloud refresh stops when the remote changed the data and cannot be rebased onto', (t) => {
  const { remoteLog, refresh, other } = cloudFixture(t)
  other('Hand edit of data', 'docs/data/releases.json', '{"hand":true}\n')
  const r = refresh()
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /ERROR: push failed: the remote changed/)
  assert.equal(remoteLog().split('\n')[0], 'Hand edit of data')
})

test('cloud refresh notes preferences that changed during the run', (t) => {
  const { refresh, other } = cloudFixture(t)
  other('Update preferences', 'config/preferences.json', '{"changed":true}\n')
  const r = refresh()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /NOTE: preferences changed during this run/)
})

test('cloud refresh treats a push that errored but landed as published', (t) => {
  const { remoteLog, refresh } = cloudFixture(t)
  const r = refresh([], { PUSH_THEN_FAIL: '1' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /commit landed/)
  assert.match(r.stdout, /Published/)
  assert.match(remoteLog().split('\n')[0], /^Update data /)
})

const publishScript = (fn) => ['--input-type=module', '-e', `const m = await import('./scripts/publish-prefs.mjs'); console.log(JSON.stringify(await m.${fn}()))`]

function prefsFixture(t) {
  const root = fixture(t)
  const repo = gitRemote(t, root)
  const call = (fn) => {
    const r = run(root, process.execPath, publishScript(fn))
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  const editPrefs = (marker) => {
    const p = JSON.parse(readFileSync(join(root, 'config/preferences.json'), 'utf8'))
    p.marker = marker
    writeFileSync(join(root, 'config/preferences.json'), JSON.stringify(p, null, 2) + '\n')
  }
  return { root, ...repo, call, editPrefs }
}

test('publishPrefs commits and pushes preferences after fast-forwarding', (t) => {
  const { git, remoteLog, call, editPrefs, other } = prefsFixture(t)
  other('Update data', 'docs/data/releases.json', '{"fetched_at":2}\n')
  editPrefs(1)
  assert.deepEqual(call('publishPrefs'), { pushed: true })
  assert.deepEqual(remoteLog().split('\n'), ['Update preferences', 'Update data', 'baseline'])
  assert.equal(git('status', '--porcelain'), '')
  assert.deepEqual(call('publishPrefs'), { pushed: true })
})

test('publishPrefs refuses unrelated unpushed commits', (t) => {
  const { root, git, remoteLog, call, editPrefs } = prefsFixture(t)
  writeFileSync(join(root, 'scripts/unrelated.mjs'), '// code')
  git('add', 'scripts/unrelated.mjs'); git('commit', '-q', '-m', 'local code')
  editPrefs(1)
  const r = call('publishPrefs')
  assert.equal(r.pushed, false)
  assert.match(r.reason, /outside docs\/data and config/)
  assert.equal(remoteLog(), 'baseline')
})

test('publishPrefs refuses merged code history even when it nets to no change', (t) => {
  const { root, git, remoteLog, call, editPrefs } = prefsFixture(t)
  git('switch', '-q', '-c', 'side')
  writeFileSync(join(root, 'scripts/shared.mjs'), readFileSync(join(root, 'scripts/shared.mjs'), 'utf8') + '// try\n')
  git('commit', '-qam', 'try'); git('revert', '--no-edit', 'HEAD')
  git('switch', '-q', 'main'); git('merge', '-q', '--no-ff', '-m', 'merge side', 'side')
  editPrefs(1)
  const r = call('publishPrefs')
  assert.equal(r.pushed, false)
  assert.match(r.reason, /outside docs\/data and config/)
  assert.equal(remoteLog(), 'baseline')
})

test('publishPrefs rebases a stranded preferences commit around an unrelated dirty file', (t) => {
  const { root, git, remoteLog, call, editPrefs, other } = prefsFixture(t)
  editPrefs(1)
  git('commit', '-q', '-m', 'Update preferences', '--', 'config/preferences.json')
  other('Update data', 'docs/data/releases.json', '{"fetched_at":3}\n')
  writeFileSync(join(root, 'scripts/shared.mjs'), readFileSync(join(root, 'scripts/shared.mjs'), 'utf8') + '// dirty\n')
  editPrefs(2)
  assert.deepEqual(call('publishPrefs'), { pushed: true })
  assert.deepEqual(remoteLog().split('\n'), ['Update preferences', 'Update preferences', 'Update data', 'baseline'])
  assert.equal(git('status', '--porcelain'), 'M scripts/shared.mjs')
})

test('publishPrefs refuses a checkout that does not track main', (t) => {
  const { git, remoteLog, call, editPrefs } = prefsFixture(t)
  git('switch', '-q', '-c', 'feature'); git('push', '-q', '-u', 'origin', 'feature')
  editPrefs(1)
  const r = call('publishPrefs')
  assert.equal(r.pushed, false)
  assert.match(r.reason, /not origin\/main/)
  assert.equal(remoteLog(), 'baseline')
})

test('publishPrefs catches up and retries after losing a push race', (t) => {
  const { root, remote, remoteLog, editPrefs } = prefsFixture(t)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/git'), `#!/bin/bash
if [ "$1" = push ] && [ ! -f race-lost ]; then
  touch race-lost
  d="$(mktemp -d)"
  ( /usr/bin/git clone -q "${remote}" "$d/c" && cd "$d/c" && echo '{"race":1}' > docs/data/releases.json \
    && /usr/bin/git -c user.name=Other -c user.email=o@example.com commit -qam "Update data" && /usr/bin/git push -q origin main )
  rm -rf "$d"
  echo ' ! [rejected]        HEAD -> main (fetch first)' >&2
  exit 1
fi
exec /usr/bin/git "$@"
`, { mode: 0o755 })
  writeFileSync(join(root, '.gitignore'), '.radar-run.lock*\n*.tmp\nhome/\nbin/\nrace-lost\n')
  editPrefs(1)
  const r = run(root, process.execPath, publishScript('publishPrefs'), { PATH: join(root, 'bin') + ':' + process.env.PATH })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { pushed: true })
  assert.deepEqual(remoteLog().split('\n'), ['Update preferences', 'Update data', 'baseline'])
})

test('update.sh --if-stale stands down when Cloud Refresh is the writer', (t) => {
  const root = fixture(t)
  writeFileSync(join(root, 'scripts/cloud-config.mjs'), 'export const CLOUD_REFRESH = true\n')
  writeFileSync(join(root, 'scripts/fetch-releases.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('fetch-ran', '1')")
  writeFileSync(join(root, 'docs/data/releases.json'), JSON.stringify({ fetched_at: 1, releases: [] }))
  const r = run(root, 'bash', ['scripts/update.sh', '--if-stale'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(existsSync(join(root, 'fetch-ran')), false)
})

test('syncLocal fast-forwards published data', (t) => {
  const { root, call, other } = prefsFixture(t)
  other('Update data', 'docs/data/releases.json', '{"fetched_at":4}\n')
  assert.deepEqual(call('syncLocal'), { synced: true })
  assert.equal(readFileSync(join(root, 'docs/data/releases.json'), 'utf8'), '{"fetched_at":4}\n')
})

test('lock command uses lockf on macOS and flock elsewhere, both busy on 75', async () => {
  const { lockCommand } = await import('../scripts/run-lock.mjs')
  assert.deepEqual(lockCommand('darwin'), ['/usr/bin/lockf', ['-s', '-t', '0', '3']])
  assert.deepEqual(lockCommand('linux'), ['flock', ['-n', '-E', '75', '3']])
})

test('findGcloud prefers PATH and reports a missing install', async (t) => {
  const root = fixture(t)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/gcloud'), '#!/bin/bash\n', { mode: 0o755 })
  const { findGcloud } = await import('../scripts/cloud-run.mjs')
  assert.equal(findGcloud({ PATH: join(root, 'bin') }, []), join(root, 'bin/gcloud'))
  assert.equal(findGcloud({ PATH: '' }, []), null)
})

// The editor in cloud mode, against a gcloud stub that reads its answers from files.
async function cloudEditor(t, env = {}) {
  const root = fixture(t)
  writeFileSync(join(root, 'scripts/cloud-config.mjs'), `export const CLOUD_REFRESH = true
export const PROJECT = 'test-project'
export const REGION = 'us-central1'
export const JOB = 'radar-refresh'
export const LOGS_URL = 'https://console.example/logs'
`)
  writeFileSync(join(root, '.gitignore'), '.radar-run.lock*\n*.tmp\nhome/\nbin/\ngcloud-*\n.radar-cloud-run.json\n')
  const repo = gitRemote(t, root)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/gcloud'), `#!/bin/bash
echo "$*" >> gcloud-calls.txt
case "$*" in
  "run jobs executions list"*) cat gcloud-list.json 2>/dev/null || echo '[]' ;;
  "run jobs execute"*) echo '{"metadata":{"name":"radar-refresh-x1"}}' ;;
  "run jobs executions describe"*) cat gcloud-describe.json ;;
  "logging read"*) tail -r gcloud-log.txt 2>/dev/null ;;
esac
`, { mode: 0o755 })
  writeFileSync(join(root, 'serve.mjs'), `const { start } = await import('./scripts/prefs-server.mjs'); start(0)`)
  const child = await background(t, root, "await import('./serve.mjs')", { PATH: join(root, 'bin') + ':' + process.env.PATH, ...env })
  const port = Number(child.ready.match(/:(\d+)/)[1])
  const request = (path, method = 'GET', payload) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false, headers: { host: '127.0.0.1:4747' } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }))
    })
    req.on('error', reject); req.end(payload)
  })
  const until = async (check, ms = 20_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await check()
      if (v) return v
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('condition not met in time')
  }
  return { root, ...repo, request, until, file: (name, content) => writeFileSync(join(root, name), content) }
}

test('cloud Save & refresh pushes pending preferences, refuses a running job, then tracks one to its outcome', async (t) => {
  const { root, request, until, file, remoteLog, git } = await cloudEditor(t)
  const prefsPath = join(root, 'config/preferences.json')
  writeFileSync(prefsPath, readFileSync(prefsPath, 'utf8').replace(/\n$/, ' \n'))
  file('gcloud-list.json', '[{"metadata":{"name":"radar-refresh-old"},"status":{}}]')
  // The startup sync can also answer 409 while it holds the lock, so wait for the push.
  await until(async () => (await request('/api/refresh', 'POST')).status === 409 && remoteLog().startsWith('Update preferences'))

  file('gcloud-list.json', '[]')
  file('gcloud-describe.json', '{"status":{}}')
  assert.equal((await request('/api/refresh', 'POST')).status, 200)
  assert.match(readFileSync(join(root, 'gcloud-calls.txt'), 'utf8'), /run jobs execute radar-refresh .*--args=--force/)
  await until(async () => (await request('/api/status')).body.running)

  file('gcloud-describe.json', '{"status":{"completionTime":"2026-10-30T10:00:00Z","succeededCount":1}}')
  file('gcloud-log.txt', 'Fetching new releases...\nERROR: fetch failed for at least one source (publishing partial data)\n')
  await new Promise((r) => setTimeout(r, 4000))
  assert.equal((await request('/api/status')).body.running, true)

  const filler = Array.from({ length: 12 }, (_, i) => `push detail ${i}`).join('\n')
  file('gcloud-log.txt', `Fetching new releases...\nERROR: fetch failed for at least one source (publishing partial data)\n${filler}\nPublished\nPages deploy verified\n`)
  const done = await until(async () => {
    const st = (await request('/api/status')).body
    return !st.running && st
  })
  assert.ok(done.log.includes('Published'))
  assert.ok(done.log.some((l) => l.startsWith('ERROR: fetch failed')), 'an early partial-fetch line still reaches the banner')
  assert.equal(existsSync(join(root, '.radar-cloud-run.json')), false)

  writeFileSync(join(root, 'scripts/unrelated.mjs'), '// code')
  git('add', 'scripts/unrelated.mjs'); git('commit', '-q', '-m', 'local code')
  writeFileSync(prefsPath, readFileSync(prefsPath, 'utf8').replace(/\n$/, ' \n'))
  const blocked = await request('/api/refresh', 'POST')
  assert.equal(blocked.status, 400)
  assert.match(blocked.body.error, /preferences are not on GitHub yet: unpushed commits touch files outside/)
})

test('the editor drops a tracked cloud run that Google no longer knows', async (t) => {
  const { root, request, until, file } = await cloudEditor(t)
  file('gcloud-list.json', '[]')
  file('gcloud-describe.json', '{"status":{}}')
  await until(async () => (await request('/api/refresh', 'POST')).status === 200)
  await until(async () => (await request('/api/status')).body.running)
  writeFileSync(join(root, 'bin/gcloud'), readFileSync(join(root, 'bin/gcloud'), 'utf8').replace('cat gcloud-describe.json', 'echo "ERROR: (gcloud.run.jobs.executions.describe) Cannot find execution [radar-refresh-x1]." >&2; exit 1'))
  const st = await until(async () => { const b = (await request('/api/status')).body; return !b.running && b })
  assert.match(st.log.at(-1), /ERROR: lost track of the cloud run/)
  assert.equal(existsSync(join(root, '.radar-cloud-run.json')), false)
})

const failOn = (root, call, message) => writeFileSync(join(root, 'bin/gcloud'),
  readFileSync(join(root, 'bin/gcloud'), 'utf8').replace(call, `echo "ERROR: (gcloud) ${message}" >&2; echo "Updates are available for some Google Cloud CLI components." >&2; exit 1`))

test('a finished run whose log never arrives closes as outcome unknown, not as unpublished', async (t) => {
  const { root, request, until, file } = await cloudEditor(t, { RADAR_CLOUD_SETTLE_MS: '1500' })
  file('gcloud-list.json', '[]')
  file('gcloud-describe.json', '{"status":{"completionTime":"2026-10-31T09:30:00Z","succeededCount":1}}')
  failOn(root, 'cat gcloud-log.txt 2>/dev/null', 'PERMISSION_DENIED: logging')
  await until(async () => (await request('/api/refresh', 'POST')).status === 200)
  const st = await until(async () => { const b = (await request('/api/status')).body; return !b.running && b })
  assert.match(st.log.at(-1), /lost track of the cloud run \(log incomplete; the run succeeded\)/)
})

test('an unfinished run that keeps failing is dropped at the limit, after one visible status line', async (t) => {
  const { root, request, until, file } = await cloudEditor(t, { RADAR_CLOUD_LIMIT_MS: '30000' })
  file('gcloud-list.json', '[]')
  file('gcloud-describe.json', '{"status":{}}')
  await until(async () => (await request('/api/refresh', 'POST')).status === 200)
  failOn(root, 'cat gcloud-describe.json', 'UNAVAILABLE: try again')
  const flaky = await until(async () => { const b = (await request('/api/status')).body; return b.log.some((l) => l.startsWith('Cloud status unavailable')) && b })
  assert.equal(flaky.running, true)
  assert.equal(flaky.log.filter((l) => l.startsWith('Cloud status unavailable')).length, 1)
  assert.match(flaky.log.at(-1), /UNAVAILABLE: try again/)
  const dropped = await until(async () => { const b = (await request('/api/status')).body; return !b.running && b }, 40_000)
  assert.match(dropped.log.at(-1), /ERROR: lost track of the cloud run/)
})

test('Save pushes preferences and reports when it cannot', async (t) => {
  const { request, remoteLog, git, root, until } = await cloudEditor(t)
  const body = (genre) => JSON.stringify({ artists: { followed: [], blocked: [] }, genres: { followed: [genre] }, discovery: { countries: ['us'], playlists: [] } })
  // The startup sync briefly holds the preferences lock, so Save can answer 409 first.
  const saved = await until(async () => { const r = await request('/api/prefs', 'POST', body('Pop')); return r.status !== 409 && r })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.pushed, true)
  assert.equal(remoteLog().split('\n')[0], 'Update preferences')

  writeFileSync(join(root, 'scripts/unrelated.mjs'), '// code')
  git('add', 'scripts/unrelated.mjs'); git('commit', '-q', '-m', 'local code')
  const refused = await request('/api/prefs', 'POST', body('Rock'))
  assert.equal(refused.status, 200)
  assert.equal(refused.body.pushed, false)
  assert.match(refused.body.reason, /outside docs\/data and config/)
})
