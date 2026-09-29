import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { fixture, run, background } from './helpers.mjs'

function git(root, ...args) {
  const r = run(root, '/usr/bin/git', args)
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
function publishFixture(t) {
  const root = fixture(t)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'baseline')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(root, 'config', 'remote.origin.url', 'https://invalid.invalid/no-network')
  git(root, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  git(root, 'config', 'branch.main.remote', 'origin'); git(root, 'config', 'branch.main.merge', 'refs/heads/main')
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/git'), `#!/bin/bash
if [ "$1" = push ]; then echo pushed > home/pushed; exit 0; fi
if [ "$1" = "$FAIL_GIT" ]; then exit 1; fi
exec /usr/bin/git "$@"
`, { mode: 0o755 })
  writeFileSync(join(root, 'bin/gh'), '#!/bin/bash\nif [ "$2" = list ]; then echo 123; else echo success; fi\n', { mode: 0o755 })
  writeFileSync(join(root, 'scripts/fetch-releases.mjs'), `import {writeFileSync} from 'node:fs';
if (process.env.NEW_DATA !== '0') writeFileSync('docs/data/releases.json', '{"test":true}');
process.exit(Number(process.env.FETCH_STATUS ?? 0));`)
  return { root, update: (env = {}, args = []) => run(root, 'bash', ['scripts/update.sh', ...args], { PATH: join(root, 'bin') + ':' + process.env.PATH, ...env }) }
}

for (const newData of ['1', '0']) test('publishing holds unrelated history, new data ' + newData, (t) => {
    const { root, update } = publishFixture(t)
    writeFileSync(join(root, 'work.txt'), 'unpublished work')
    git(root, 'add', 'work.txt'); git(root, 'commit', '-m', 'private work')
    const head = git(root, 'rev-parse', 'HEAD')
    const r = update({ NEW_DATA: newData })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, newData === '1' ? /UNPUBLISHED:/ : /HELD:/)
    assert.equal(git(root, 'rev-parse', 'HEAD'), head)
    assert.equal(existsSync(join(root, 'home/pushed')), false)
  })

for (const newData of ['1', '0']) test('publishing holds code introduced only by a merge, new data ' + newData, (t) => {
  const { root, update } = publishFixture(t)
  git(root, 'branch', 'side')
  writeFileSync(join(root, 'docs/data/releases.json'), '{"main":true}')
  git(root, 'add', 'docs/data'); git(root, 'commit', '-m', 'main data')
  git(root, 'switch', 'side')
  writeFileSync(join(root, 'config/merge-fixture.json'), '{}')
  git(root, 'add', 'config/merge-fixture.json'); git(root, 'commit', '-m', 'side data')
  git(root, 'switch', 'main')
  git(root, 'merge', '--no-commit', '--no-ff', 'side')
  writeFileSync(join(root, 'work.txt'), 'unpublished merge work')
  git(root, 'add', 'work.txt'); git(root, 'commit', '-m', 'merge with private work')
  const head = git(root, 'rev-parse', 'HEAD')
  const r = update({ NEW_DATA: newData })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, newData === '1' ? /UNPUBLISHED:/ : /HELD:/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  assert.equal(existsSync(join(root, 'home/pushed')), false)
})

for (const failure of ['rev-list', 'log', 'missing-upstream']) test('history fails closed: ' + failure, (t) => {
  const { root, update } = publishFixture(t)
  if (failure === 'missing-upstream') git(root, 'config', '--unset', 'branch.main.remote')
  const head = git(root, 'rev-parse', 'HEAD')
  const r = update({ FAIL_GIT: failure })
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stdout, /UNPUBLISHED:/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  assert.equal(existsSync(join(root, 'home/pushed')), false)
})

test('data-only publish preserves unrelated staging and partial exit status', (t) => {
  const { root, update } = publishFixture(t)
  writeFileSync(join(root, 'staged.txt'), 'keep staged')
  git(root, 'add', 'staged.txt')
  const r = update({ FETCH_STATUS: '2' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stdout, /Published/)
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'staged.txt')
  assert.equal(git(root, 'show', '--format=', '--name-only', 'HEAD'), 'docs/data/releases.json')
})

test('active lock excludes another process and admits verified nested fetch', async (t) => {
  const root = fixture(t)
  const child = await background(t, root, `import {holdRunLock} from './scripts/run-lock.mjs'; const lock=holdRunLock('refresh'); console.log(lock.token); setInterval(()=>{},1000)`)
  const owner = JSON.parse(readFileSync(join(root, '.radar-run.lock.json')))
  const code = "import {holdRunLock} from './scripts/run-lock.mjs'; holdRunLock('fetch')"
  assert.equal(run(root, process.execPath, ['--input-type=module', '-e', code]).status, 1)
  assert.equal(run(root, process.execPath, ['--input-type=module', '-e', code], { RADAR_RUN_TOKEN: owner.token }).status, 0)
  assert.ok(existsSync(join(root, '.radar-run.lock')))
  child.kill(); await once(child, 'exit')
  assert.equal(existsSync(join(root, '.radar-run.lock.json')), false)
})

test('stale lock is reclaimed after owner exits', (t) => {
  const root = fixture(t)
  const dead = run(root, process.execPath, ['-e', 'console.log(process.pid)'])
  writeFileSync(join(root, '.radar-run.lock'), dead.stdout)
  const r = run(root, process.execPath, ['--input-type=module', '-e', "import {holdRunLock} from './scripts/run-lock.mjs'; holdRunLock('fetch')"])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(existsSync(join(root, '.radar-run.lock.json')), false)
})

for (const fresh of [false, true]) test('carryover eligibility with fresh results: ' + fresh, (t) => {
  const root = fixture(t)
  const date = new Date().toISOString().slice(0, 10)
  const future = new Date(Date.now() + 86400e3 * 3).toISOString().slice(0, 10)
  const card = (title, extra = {}) => ({ title, artist: title, type: 'album', release_date: date, artwork: '', genre: 'Other', ...extra })
  const prefs = { artists: { followed: [{ name: 'One', id: 1 }], blocked: [{ name: 'Blocked', id: 3 }] }, genres: { followed: ['Pop'] }, discovery: { countries: [], playlists: [] } }
  writeFileSync(join(root, 'config/preferences.json'), JSON.stringify(prefs))
  writeFileSync(join(root, 'docs/data/releases.json'), JSON.stringify({ fetched_at: Date.now(), releases: [
    card('collab', { via_artist_id: 1, artist_id: 9, followed: true }),
    card('blocked', { via_artist_id: 1, artist_id: 3, followed: true }),
    card('removed', { artist_id: 2, followed: true }),
    card('discovery', { artist_id: 2, followed: true, genre: 'pOp' }),
    card('unknown', { followed: true }),
  ], upcoming: [card('future', { release_date: future, via_artist_id: 1, artist_id: 9, followed: true }), card('removed future', { release_date: future, artist_id: 2, followed: true })] }))
  writeFileSync(join(root, 'offline.mjs'), `const timer=globalThis.setTimeout; globalThis.setTimeout=(fn,ms,...args)=>timer(fn,Math.min(ms,1),...args);
globalThis.fetch=async(url)=>{
  if (${fresh} && url.includes('most-played/50/albums')) return new Response(JSON.stringify({feed:{results:[{id:'44',name:'fresh',artistName:'fresh',artistId:'44',releaseDate:'${date}',genres:[{name:'Pop'}]}]}}));
  if (${fresh} && url.includes('lookup?id=44&')) return new Response(JSON.stringify({results:[{wrapperType:'collection',collectionId:44,collectionName:'fresh',artistName:'fresh',artistId:44,releaseDate:'${date}',primaryGenreName:'Pop',trackCount:3}]}));
  throw new Error('fixture outage');
}`)
  const r = run(root, process.execPath, ['--import', './offline.mjs', 'scripts/fetch-releases.mjs'])
  assert.equal(r.status, 2, r.stderr)
  const result = JSON.parse(readFileSync(join(root, 'docs/data/releases.json')))
  assert.deepEqual(result.releases.map((r) => r.title).sort(), fresh ? ['collab', 'fresh'] : ['collab', 'discovery'])
  if (!fresh) assert.equal(result.releases.find((r) => r.title === 'discovery').followed, false)
  assert.deepEqual(result.upcoming.map((r) => r.title), ['future'])
  const history = JSON.parse(readFileSync(join(root, 'config/source-activity.json')))
  if (!fresh) assert.equal(history.sources['chart:us'].at(-1), null)
})

test('data-only retry pushes without creating an extra commit', (t) => {
  const { root, update } = publishFixture(t)
  writeFileSync(join(root, 'docs/data/releases.json'), '{"retry":true}')
  git(root, 'add', 'docs/data'); git(root, 'commit', '-m', 'data retry')
  const head = git(root, 'rev-parse', 'HEAD')
  const r = update({ NEW_DATA: '0' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Published/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
})

test('log rotation resets the run offset before fetching', (t) => {
  const { root, update } = publishFixture(t)
  const log = join(root, 'home/Library/Logs/new-music-radar.log')
  writeFileSync(log, 'x'.repeat(1100000))
  writeFileSync(join(root, 'scripts/fetch-releases.mjs'), `import {readFileSync,writeFileSync,statSync} from 'node:fs';
const owner=JSON.parse(readFileSync('.radar-run.lock.json'));writeFileSync('home/offset',String(owner.logStart));
if(owner.logStart!==statSync(process.env.HOME+'/Library/Logs/new-music-radar.log').size)process.exit(1);`)
  const r = update()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(Number(readFileSync(join(root, 'home/offset'))), 262144)
})

test('kernel lock recovers after abrupt owner termination; audit respects active owner', async (t) => {
  const root = fixture(t)
  const child = await background(t, root, "import {holdRunLock} from './scripts/run-lock.mjs'; holdRunLock('refresh'); console.log('ready'); setInterval(()=>{},1000)")
  const denied = run(root, process.execPath, ['scripts/audit-sources.mjs', '--no-discover'])
  assert.equal(denied.status, 1)
  assert.match(denied.stderr, /BUSY:/)
  child.kill('SIGKILL'); await once(child, 'exit')
  const recovered = run(root, process.execPath, ['--input-type=module', '-e', "import {holdRunLock} from './scripts/run-lock.mjs'; holdRunLock('fetch')"])
  assert.equal(recovered.status, 0, recovered.stderr)
})

test('scheduled refresh repairs invalid timestamps and skips a fresh valid feed', (t) => {
  const { root, update } = publishFixture(t)
  for (const [fetched_at, stale] of [[undefined, true], [null, true], ['invalid', true], [-1, true], [Number.MAX_SAFE_INTEGER, true], [Date.now(), false]]) {
    writeFileSync(join(root, 'docs/data/releases.json'), JSON.stringify({ fetched_at }))
    const result = update({}, ['--if-stale'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.includes('Fetching new releases'), stale)
  }
})

for (const source of ['genre singleton', 'chart duplicate']) test('discovery preserves valid genres from ' + source, (t) => {
  const root = fixture(t)
  const date = new Date().toISOString().slice(0, 10)
  writeFileSync(join(root, 'config/preferences.json'), JSON.stringify({ artists: { followed: [], blocked: [] }, genres: { followed: ['Pop'] }, discovery: { countries: [], playlists: [] } }))
  writeFileSync(join(root, 'offline.mjs'), `const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,Math.min(ms,1),...args);
const collection={wrapperType:'collection',collectionId:101,collectionName:'Fixture',artistName:'Artist',artistId:10,releaseDate:'${date}',primaryGenreName:'Pop',trackCount:2};
globalThis.fetch=async(url)=>new Response(JSON.stringify(url.includes('/lookup?')
  ? {results:'${source}'==='chart duplicate'?[{...collection,primaryGenreName:null},{...collection,collectionId:102}]:[collection]}
  : {feed:'${source}'==='genre singleton'&&url.includes('/topalbums/genre=14/') ? {entry:{id:{attributes:{'im:id':'101'}},'im:releaseDate':{label:'${date}'}}} : '${source}'==='chart duplicate'&&url.includes('/most-played/50/albums')?{results:[{id:'101',releaseDate:'${date}',genres:[]}]}:{entry:[],results:[]}}));`)
  const result = run(root, process.execPath, ['--import', './offline.mjs', 'scripts/fetch-releases.mjs'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const feed = JSON.parse(readFileSync(join(root, 'docs/data/releases.json')))
  assert.deepEqual(feed.releases.map((r) => r.title), ['Fixture'])
  assert.equal(feed.releases[0].genre, 'Pop')
  const history = JSON.parse(readFileSync(join(root, 'config/source-activity.json')))
  assert.equal(history.sources[source === 'genre singleton' ? 'genre:Pop' : 'chart:us'].at(-1)[0], 1)
})

for (const lookup of ['failed', 'recovered', 'late recovery', 'replacement', 'success']) test('audit keeps incomplete evidence and combined removal advice safe: ' + lookup, (t) => {
  const root = fixture(t)
  const playlists = ['First', 'Second'].map((name) => ({ name, url: 'https://music.apple.com/us/playlist/' + name.toLowerCase() + '/pl.fixture' }))
  writeFileSync(join(root, 'config/preferences.json'), JSON.stringify({ artists: { followed: [{ id: 7, name: 'Unrated' }], blocked: [] }, genres: { followed: ['pOp'] }, discovery: { countries: [], playlists } }))
  writeFileSync(join(root, 'docs/data/releases.json'), JSON.stringify({ releases: [] }))
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 86400e3).toISOString().slice(0, 10))
  writeFileSync(join(root, 'config/source-activity.json'), JSON.stringify({ days, sources: Object.fromEntries(playlists.map((p) => ['playlist:' + p.name, days.map(() => [0, 0])])) }))
  writeFileSync(join(root, 'offline.mjs'), `import { GENRE_OPTIONS } from './scripts/genre-options.mjs';
const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,Math.min(ms,1),...args);
let lookups=0;
globalThis.fetch=async(url)=>{
  let body;
  if(url.includes('/ws/genres')) body={'34':{name:'Music',subgenres:Object.fromEntries(GENRE_OPTIONS.map((name,i)=>[i+100,{name}]))}};
  else if(url.includes('/search?')) return new Response('https://music.apple.com/us/playlist/candidate/pl.candidate');
  else if(url.includes('/playlist/')) return new Response('<script type="application/json" id="serialized-server-data">'+JSON.stringify(Array.from({length:'${lookup}'==='replacement'&&url.includes('/second/')?26:21},(_,i)=>({artistName:'Artist',contentDescriptor:{identifiers:{storeAdamID:String(i+1000)}}})))+'</script>');
  else if(url.includes('/rss/topalbums/')&&!url.includes('/genre=')) body={feed:{entry:Array.from({length:8},(_,i)=>({id:{attributes:{'im:id':String(i+2000)}},'im:releaseDate':{label:new Date().toISOString()}}))}};
  else if(url.includes('entity=album')) body={results:[{wrapperType:'collection',collectionId:9}]};
  else if(url.includes('/lookup?')) {
    lookups++;
    if('${lookup}'==='failed'||('${lookup}'==='recovered'&&lookups===1)||('${lookup}'==='late recovery'&&lookups<=3))throw new Error('fixture lookup outage');
    body={results:new URL(url).searchParams.get('id').split(',').map((id,i)=>({wrapperType:'collection',collectionId:Number(id),releaseDate:new Date(Date.now()-(i<5||'${lookup}'==='late recovery'?0:60)*86400e3).toISOString(),primaryGenreName:'Pop'}))};
  } else body={feed:{entry:[],results:[]}};
  return new Response(JSON.stringify(body));
};`)
  const result = run(root, process.execPath, ['--import', './offline.mjs', 'scripts/audit-sources.mjs', '--json', ...(['failed', 'late recovery'].includes(lookup) ? [] : ['--no-discover'])])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.sections.artists, [])
  assert.ok(report.warnings.some((w) => w.includes('this batch is unrated')))
  assert.equal(report.recommend.some((r) => r.target.includes('Unrated') || r.target === 'genre "pOp" (followed)'), false)
  const rows = report.sections.sources.filter((r) => r.kind === 'playlist')
  const advice = report.recommend.filter((r) => ['First', 'Second'].includes(r.target))
  assert.equal(rows.length, 2)
  assert.equal(advice.length, 2)
  if (['failed', 'late recovery'].includes(lookup)) {
    assert.ok(rows.every((r) => !r.live.ok && r.density == null))
    assert.ok(advice.every((r) => r.action === 'CHECK'))
    assert.equal(report.coverageComplete, false)
    assert.ok(report.warnings.some((w) => w.includes('additive counts are provisional')))
    if (lookup === 'failed') {
      assert.ok(report.sections.candidateCountries.some((r) => r.lookupFailed))
      assert.deepEqual(report.sections.candidatePlaylists, [])
    } else {
      assert.equal(report.sections.candidatePlaylists.length, 1)
      assert.ok(report.recommend.some((r) => r.action === 'CHECK' && r.target === 'playlist "Candidate"' && r.why.includes('coverage is incomplete')))
    }
    assert.equal(report.recommend.some((r) => r.action === 'ADD' && /^(country|playlist) /.test(r.target)), false)
  } else {
    assert.ok(rows.every((r) => r.live.ok && r.liveIds === 5))
    assert.equal(advice.filter((r) => r.action === 'REMOVE').length, 1)
    assert.ok(advice.some((r) => r.action === 'CHECK'))
    if (lookup === 'replacement') assert.equal(advice.find((r) => r.action === 'REMOVE').target, 'Second')
  }
  if (lookup === 'success') {
    const genres = run(root, process.execPath, ['--import', './offline.mjs', 'scripts/check-genre-coverage.mjs'])
    assert.equal(genres.status, 0, genres.stdout + genres.stderr)
  }
})
