import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, realpathSync } from 'node:fs'
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
  const result = run(root, process.execPath, ['--import', './offline.mjs', 'scripts/audit-sources.mjs', '--json', ...(['failed', 'late recovery'].includes(lookup) ? ['--discover'] : [])])
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
    assert.equal(report.coverageComplete, true)
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

function auditFixture(t, { countries = [], playlists = [], followed = [], setup = '' } = {}) {
  const root = fixture(t)
  writeFileSync(join(root, 'config/preferences.json'), JSON.stringify({ artists: { followed: [], blocked: [] }, genres: { followed }, discovery: { countries, playlists } }))
  writeFileSync(join(root, 'config/source-activity.json'), '{"days":[],"sources":{}}')
  writeFileSync(join(root, 'docs/data/releases.json'), '{"releases":[]}')
  writeFileSync(join(root, 'offline.mjs'), `import {writeFileSync} from 'node:fs';
import {GENRE_OPTIONS} from './scripts/genre-options.mjs';
const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,Math.min(ms,1),...args);
const requests=[];process.on('exit',()=>writeFileSync('requests.json',JSON.stringify(requests)));
const date=new Date().toISOString();
const album=(id,days=0)=>({wrapperType:'collection',collectionId:id,releaseDate:new Date(Date.now()-days*86400e3).toISOString(),primaryGenreName:'Pop'});
const song=(id)=>({releaseDate:date,url:'https://music.apple.com/us/album/fixture/'+id+'?i=9'});
const page=(ids)=>'<script type="application/json" id="serialized-server-data">'+JSON.stringify(ids.map(id=>({artistName:'Artist',contentDescriptor:{identifiers:{storeAdamID:String(id)}}})))+'</script>';
${setup}
globalThis.fetch=async(url)=>{
  requests.push(url);
  if(url.includes('/ws/genres'))return new Response(JSON.stringify({'34':{name:'Music',subgenres:Object.fromEntries(GENRE_OPTIONS.map((name,i)=>[i+100,{name}]))}}));
  const result=typeof respond==='function'?respond(url):null;
  return new Response(typeof result==='string'?result:JSON.stringify(result??{feed:{entry:[],results:[]},results:[]}));
};`)
  return {
    root,
    audit: (...flags) => run(root, process.execPath, ['--import', './offline.mjs', 'scripts/audit-sources.mjs', ...flags]),
    requests: () => JSON.parse(readFileSync(join(root, 'requests.json'))),
  }
}

test('audit discovery is opt-in and incompatible flags fail before requests', (t) => {
  const { audit, requests } = auditFixture(t, { countries: ['kr'] })
  for (const flags of [[], ['--no-discover'], ['--discover']]) {
    const result = audit('--json', ...flags)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.coverageComplete, true)
    assert.equal('candidateCountries' in report.sections, flags.includes('--discover'))
    const scannedCountries = requests().filter((url) => url.includes('/most-played/100/songs.json'))
    assert.equal(scannedCountries.length, flags.includes('--discover') ? 31 : 1)
    assert.equal(requests().some((url) => url.includes('/kr/rss/')), false)
  }
  const incompatible = auditFixture(t)
  const conflict = incompatible.audit('--discover', '--no-discover')
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /conflict/)
  assert.deepEqual(incompatible.requests(), [])
  assert.equal(existsSync(join(incompatible.root, '.radar-run.lock')), false)
})

test('audit pools duplicate playlist IDs and bounds retries independently of source count', (t) => {
  const playlists = Array.from({ length: 12 }, (_, i) => ({ name: 'List ' + i, url: 'https://music.apple.com/us/playlist/list-' + i + '/pl.fixture' }))
  const { audit, requests } = auditFixture(t, {
    playlists,
    setup: `function respond(url){
      if(url.includes('/playlist/'))return page([101,101,102]);
      if(url.includes('/lookup?'))throw new Error('fixture outage');
    }`,
  })
  const result = audit('--json')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.coverageComplete, false)
  assert.equal(report.sections.sources.filter((row) => row.kind === 'playlist' && !row.live.ok).length, playlists.length)
  const lookups = requests().filter((url) => url.includes('/lookup?'))
  assert.equal(lookups.length, 2)
  assert.ok(lookups.every((url) => new URL(url).searchParams.get('id') === '101,102'))
})

test('audit retries only failed lookup chunks and scores recovered cache entries', (t) => {
  const { audit, requests } = auditFixture(t, {
    playlists: [{ name: 'Large', url: 'https://music.apple.com/us/playlist/large/pl.fixture' }],
    setup: `let outage=true;function respond(url){
      if(url.includes('/playlist/'))return page(Array.from({length:401},(_,i)=>i+1000));
      if(url.includes('/lookup?')){
        const ids=new URL(url).searchParams.get('id').split(',').map(Number);
        if(ids[0]===1000&&outage){outage=false;throw new Error('fixture outage')}
        return {results:ids.map(id=>album(id))};
      }
    }`,
  })
  const result = audit('--json')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.coverageComplete, true)
  assert.equal(report.sections.sources.find((row) => row.kind === 'playlist').liveIds, 401)
  const chunks = requests().filter((url) => url.includes('/lookup?')).map((url) => new URL(url).searchParams.get('id').split(','))
  assert.deepEqual(chunks.map((ids) => ids.length), [200, 200, 1, 200])
  assert.deepEqual(chunks[3], chunks[0])
})

test('audit reports unmeasured windows separately from measured zero and excludes raw payloads', (t) => {
  const { root, audit } = auditFixture(t, { setup: `function respond(url){if(url.includes('/most-played/50/albums'))return {feed:{results:[{id:'99',releaseDate:date,privatePayload:'omit'}]}};}` })
  const result = audit()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /days7\/30/)
  assert.match(result.stdout, /US most-played chart\s+-\s+-\s+-\s+1\s+1/)
  assert.match(result.stdout, /0\/0/)
  const date = new Date().toISOString().slice(0, 10)
  writeFileSync(join(root, 'config/source-activity.json'), JSON.stringify({ days: [date], sources: { 'chart:us': [[0, 0]] } }))
  const measured = audit()
  assert.match(measured.stdout, /US most-played chart\s+0\s+0\s+0\s+1\s+1/)
  assert.match(measured.stdout, /1\/1/)
  const json = audit('--json')
  assert.equal(json.status, 0, json.stderr)
  const report = JSON.parse(json.stdout)
  assert.equal(report.coverageComplete, true)
  assert.equal(report.sections.sources[0].w30.measured, 1)
  assert.equal(report.sections.sources[1].w30.measured, 0)
  assert.equal('results' in report.sections.sources[0].live, false)
  assert.equal(json.stdout.includes('privatePayload'), false)
})

test('candidate country probes include streaming-only Top 100 contributions', (t) => {
  const { audit, requests } = auditFixture(t, { setup: `function respond(url){
    if(url.includes('/api/v2/kr/music/most-played/100/songs'))return {feed:{results:Array.from({length:8},(_,i)=>song(i+2000))}};
    if(url.includes('/lookup?'))return {results:new URL(url).searchParams.get('id').split(',').map(id=>album(Number(id)))};
  }` })
  const result = audit('--discover', '--json')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const report = JSON.parse(result.stdout)
  const country = report.sections.candidateCountries.find((row) => row.sf === 'kr')
  assert.equal(country.recent, 8)
  assert.equal(country.additive, 8)
  assert.ok(report.recommend.some((rec) => rec.action === 'ADD' && rec.target === 'country Korea (kr)'))
  assert.equal(requests().filter((url) => url.includes('/api/v2/kr/')).length, 1)
  assert.equal(requests().some((url) => url.includes('/kr/rss/')), false)
})

for (const coverage of ['replacement only', 'retained', 'incomplete', 'quiet', 'failed candidate']) test('picker removal requires complete retained coverage: ' + coverage, (t) => {
  const ids = Array.from({ length: 5 }, (_, i) => i + 1000)
  const { audit } = auditFixture(t, {
    playlists: [{ name: 'Stale', url: 'https://music.apple.com/us/playlist/stale/pl.fixture' }],
    setup: `function respond(url){
      if(url.includes('/playlist/'))return page(Array.from({length:26},(_,i)=>i+1000));
      if(url.includes('/lookup?'))return {results:new URL(url).searchParams.get('id').split(',').map(id=>album(Number(id),Number(id)<1005?0:60))};
      if(url.includes('/api/v2/ar/music/most-played/100/songs')){
        if('${coverage}'==='failed candidate')throw new Error('fixture outage');
        return {feed:{results:${JSON.stringify(ids)}.slice(0,'${coverage}'==='quiet'?1:5).map(song)}};
      }
      if(url.includes('/most-played/50/albums')){
        if('${coverage}'==='incomplete')throw new Error('fixture outage');
        if(['retained','quiet','failed candidate'].includes('${coverage}'))return {feed:{results:${JSON.stringify(ids)}.map(id=>({id:String(id),releaseDate:date}))}};
      }
    }`,
  })
  const result = audit('--discover', '--json')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const report = JSON.parse(result.stdout)
  assert.ok(report.recommend.some((rec) => ['REMOVE', 'REPLACE'].includes(rec.action) && rec.target === 'Stale'))
  if (coverage === 'replacement only') assert.ok(report.recommend.some((rec) => rec.action === 'REPLACE' && rec.target === 'Stale'))
  assert.equal(report.recommend.some((rec) => rec.action === 'REMOVE' && rec.target === 'picker option Argentina (ar)'), coverage === 'retained')
  const candidate = report.sections.candidateCountries.find((row) => row.sf === 'ar')
  if (coverage === 'replacement only') assert.equal(candidate.additive, 5)
  if (coverage === 'incomplete') assert.equal(report.coverageComplete, false)
  if (coverage === 'failed candidate') assert.equal(candidate.ok, false)
})

for (const history of ['missing', 'malformed', 'invalid shape', 'unreadable']) test('genre checker identifies ' + history + ' history', (t) => {
  const { root, requests } = auditFixture(t)
  const path = join(root, 'config/genre-activity.json')
  rmSync(path, { force: true })
  if (history === 'malformed') writeFileSync(path, '{')
  if (history === 'invalid shape') writeFileSync(path, 'null')
  if (history === 'unreadable') mkdirSync(path)
  const result = run(root, process.execPath, ['--import', './offline.mjs', 'scripts/check-genre-coverage.mjs'])
  assert.equal(result.status, history === 'missing' ? 0 : 1, result.stdout + result.stderr)
  if (history === 'missing') assert.match(result.stdout, /No drop history yet/)
  else {
    assert.match(result.stderr, /Could not read config\/genre-activity.json/)
    assert.deepEqual(requests(), [])
  }
  assert.equal((result.stdout + result.stderr).includes('npm run fetch'), false)
})

test('fixture children ignore ambient Git redirection and external XDG configuration', async (t) => {
  const root = fixture(t)
  const external = fixture(t)
  git(root, 'init', '-b', 'main')
  git(external, 'init', '-b', 'main')
  const externalConfig = join(external, 'xdg/git')
  const externalHooks = join(external, 'hooks')
  mkdirSync(externalConfig, { recursive: true })
  mkdirSync(externalHooks)
  writeFileSync(join(externalHooks, 'pre-commit'), '#!/bin/sh\ntouch "' + join(external, 'hook-fired') + '"\n', { mode: 0o755 })
  writeFileSync(join(externalConfig, 'config'), '[core]\nworktree = ' + external + '\nhooksPath = ' + externalHooks + '\n')
  const inherited = {
    GIT_DIR: join(external, '.git'), GIT_WORK_TREE: external, GIT_INDEX_FILE: join(external, 'redirected-index'),
    GIT_CONFIG_GLOBAL: join(externalConfig, 'config'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: externalHooks,
    XDG_CONFIG_HOME: join(external, 'xdg'),
  }
  const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]))
  Object.assign(process.env, inherited)
  try {
    assert.equal(git(root, 'rev-parse', '--show-toplevel'), realpathSync(root))
    assert.equal(run(root, '/usr/bin/git', ['config', '--get', 'core.hooksPath']).status, 1)
    assert.equal(run(root, '/usr/bin/git', ['config', '--get', 'core.worktree']).status, 1)
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'isolated')
    assert.equal(existsSync(join(external, 'hook-fired')), false)
    assert.equal(run(external, '/usr/bin/git', ['rev-parse', '--verify', 'HEAD']).status, 128)
    assert.equal(existsSync(join(external, 'redirected-index')), false)
    const child = await background(t, root, `import {execFileSync} from 'node:child_process';console.log(execFileSync('/usr/bin/git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim());setInterval(()=>{},1000)`)
    assert.equal(child.ready, realpathSync(root))
    child.kill(); await once(child, 'exit')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const explicit = run(root, '/usr/bin/git', ['rev-parse', '--show-toplevel'], { GIT_DIR: join(external, '.git'), GIT_WORK_TREE: external })
  assert.equal(explicit.stdout.trim(), realpathSync(external))
})
