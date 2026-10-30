import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const PREFS_FILE = 'config/preferences.json'
// Paths a nightly data commit touches; update.sh publishes these unasked too.
const DATA_PATHS = ['docs/data', 'config']

function git(args, timeout = 20_000) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: REPO, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: e.message }))
    child.on('close', (code, signal) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: (signal ? `git ${args[0]} timed out` : stderr).trim() }))
  })
}
const firstLine = (r) => (r.stderr || r.stdout).split('\n')[0]
const pushError = (r) => (r.stderr || r.stdout).split('\n').find((l) => /rejected|error|fatal|timed out/.test(l)) ?? firstLine(r)
// The cloud job clones main, so preferences only count once they are on origin/main.
const PUBLISHED_BRANCH = 'main'

// Fetches the upstream and checks that local history may be published here:
// unpushed commits must stay inside docs/data and config, and the data paths
// must have no uncommitted edits besides preferences.json.
async function upstream() {
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (up.code) return { reason: 'this branch has no upstream to push to' }
  const [remote, ...rest] = up.stdout.split('/')
  const branch = rest.join('/')
  if (branch !== PUBLISHED_BRANCH) return { reason: `this checkout tracks ${up.stdout}, not ${remote}/${PUBLISHED_BRANCH}, which the cloud job reads` }
  const fetched = await git(['fetch', '--quiet', remote, branch])
  if (fetched.code) return { reason: 'could not reach GitHub (' + firstLine(fetched) + ')' }
  const outside = await git(['log', '--format=', '--name-only', '--diff-merges=separate', '@{u}..HEAD', '--', '.', ...DATA_PATHS.map((p) => ':!' + p)])
  if (outside.code) return { reason: 'could not inspect unpushed commits' }
  if (outside.stdout) return { reason: 'unpushed commits touch files outside docs/data and config; push them yourself first' }
  const dirty = await git(['status', '--porcelain', '--untracked-files=no', '--', ...DATA_PATHS, ':!' + PREFS_FILE])
  if (dirty.stdout) return { reason: 'docs/data or config has uncommitted changes' }
  const counts = await git(['rev-list', '--left-right', '--count', '@{u}...HEAD'])
  const [behind, ahead] = counts.stdout.split(/\s+/).map(Number)
  return { remote, branch, behind, ahead }
}

async function catchUp(state) {
  if (!state.behind) return null
  if (!state.ahead) {
    const r = await git(['merge', '--ff-only', '--quiet', '@{u}'])
    return r.code ? 'could not fast-forward (' + firstLine(r) + ')' : null
  }
  const r = await git(['rebase', '--autostash', '--quiet', '@{u}'])
  if (!r.code && /autostash resulted in conflicts/i.test(r.stderr + r.stdout)) return 'your uncommitted edits conflicted and were moved to git stash; run git stash pop'
  if (!r.code) return null
  await git(['rebase', '--abort'])
  return 'local and GitHub history both changed and could not be combined (' + firstLine(r) + ')'
}

// Callers hold the preferences run lock, so a fetch cannot be writing the data
// paths these git operations read and move.
export async function publishPrefs(message = 'Update preferences') {
  let state = await upstream()
  if (state.reason) return { pushed: false, reason: state.reason }
  const changed = await git(['status', '--porcelain', '--', PREFS_FILE])
  if (changed.stdout) {
    const c = await git(['commit', '--quiet', '-m', message, '--', PREFS_FILE])
    if (c.code) return { pushed: false, reason: 'could not commit preferences (' + firstLine(c) + ')' }
    state = { ...state, ahead: state.ahead + 1 }
  }
  for (let attempt = 0; ; attempt++) {
    const stuck = await catchUp(state)
    if (stuck) return { pushed: false, reason: stuck }
    if (!state.ahead) return { pushed: true }
    const p = await git(['push', '--quiet', state.remote, 'HEAD:refs/heads/' + state.branch])
    if (!p.code) return { pushed: true }
    if (attempt) return { pushed: false, reason: 'push failed (' + pushError(p) + ')' }
    // Most often the cloud job pushed in between: fetch and catch up once more.
    state = await upstream()
    if (state.reason) return { pushed: false, reason: state.reason }
  }
}

// Brings the Mac's copies of the published data up to date without committing.
export async function syncLocal() {
  const state = await upstream()
  if (state.reason) return { synced: false, reason: state.reason }
  if (!state.behind) return { synced: true }
  if (state.ahead) return { synced: false, reason: 'local commits are not pushed yet' }
  const r = await git(['merge', '--ff-only', '--quiet', '@{u}'])
  return r.code ? { synced: false, reason: 'could not fast-forward (' + firstLine(r) + ')' } : { synced: true }
}

// The cloud job reads preferences from GitHub, so a refresh needs them pushed.
export async function prefsPublished() {
  const state = await upstream()
  if (state.reason) return { ok: false, reason: state.reason }
  const local = await git(['status', '--porcelain', '--', PREFS_FILE])
  if (local.stdout) return { ok: false, reason: 'preferences have unsaved or uncommitted changes' }
  const diff = await git(['diff', '--quiet', '@{u}', 'HEAD', '--', PREFS_FILE])
  return diff.code ? { ok: false, reason: 'saved preferences are not on GitHub yet; press Save to push them' } : { ok: true }
}
