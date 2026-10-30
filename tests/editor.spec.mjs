import { test as nodeTest, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { build } from 'vite'
import { PAGE } from '../scripts/prefs-server.mjs'
import { repo } from './helpers.mjs'

const { chromium } = await import('playwright').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes("'playwright'")) {
    throw new Error('Playwright is missing. Run npm ci, then npm run test:browser:install.', { cause: error })
  }
  throw error
})
const test = (name, run) => nodeTest(name, { timeout: 60_000 }, run)
const site = mkdtempSync(join(tmpdir(), 'radar-browser-'))
let browser, css
try {
  await build({ root: repo, logLevel: 'error', build: { outDir: site, emptyOutDir: true } })
  css = readdirSync(join(site, 'assets')).find((name) => name.endsWith('.css'))
  assert.ok(css, 'The browser fixture requires built CSS')
  browser = await chromium.launch({ headless: true }).catch((error) => {
    if (error.message.includes("Executable doesn't exist at")) {
      throw new Error('Chromium is missing. Run npm run test:browser:install.', { cause: error })
    }
    throw error
  })
} catch (error) {
  rmSync(site, { recursive: true, force: true })
  throw error
}
after(async () => {
  try { await browser.close() }
  finally { rmSync(site, { recursive: true, force: true }) }
})
const prefs = () => ({ artists: { followed: [], blocked: [] }, genres: { followed: ['Pop'] }, countries: [], playlists: [], genreOptions: ['Pop', 'Rock'], countryNames: { us: 'United States' }, countsAvailable: true })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

async function editor(t, handlers = {}, ready = true) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  t.after(() => assert.deepEqual(errors, []))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: PAGE.replace('<!--CSS-->', `<link rel="stylesheet" href="/new-music-radar/assets/${css}">`) })
    if (path === '/api/prefs') {
      if (route.request().method() === 'POST') return handlers.save ? handlers.save(route) : json(route, { ok: true })
      return handlers.prefs ? handlers.prefs(route) : json(route, prefs())
    }
    if (path === '/api/status') return handlers.status ? handlers.status(route) : json(route, { running: false, busy: false, log: [] })
    if (path === '/api/artist-search') return handlers.search ? handlers.search(route, url.searchParams.get('q')) : json(route, { results: [] })
    if (path === '/api/refresh') return handlers.refresh ? handlers.refresh(route) : json(route, { running: true })
    if (path === '/api/quit') return json(route, { ok: true })
    if (path.startsWith('/new-music-radar/assets/') || path.startsWith('/new-music-radar/fonts/')) {
      const file = join(site, path.slice('/new-music-radar/'.length))
      return route.fulfill({ path: file })
    }
    return route.abort()
  })
  await page.goto('http://127.0.0.1:4747/')
  if (ready) await page.locator('[id="add-genres.followed"]').waitFor()
  return page
}
async function addGenre(page, name) {
  const input = page.locator('[id="add-genres.followed"]')
  await input.fill(name); await input.press('Enter')
}
function ignoreSearchCancellation(page) {
  return page.evaluate(() => { const original = window.fetch; window.fetch = (url, options) => original(url, String(url).includes('artist-search') ? {} : options) })
}

test('Save & refresh preserves edits made during its save and does not refresh', async (t) => {
  const entered = deferred(), release = deferred()
  let refreshes = 0
  const page = await editor(t, {
    save: async (route) => { entered.resolve(); await release.promise; await json(route, { ok: true }) },
    refresh: (route) => { refreshes++; return json(route, { running: true }) },
  })
  await addGenre(page, 'Dance')
  await page.getByRole('button', { name: 'Save & refresh', exact: true }).click()
  await entered.promise
  await addGenre(page, 'Latin')
  release.resolve()
  await page.getByText('Newer changes are still unsaved.', { exact: false }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true)
  assert.equal(refreshes, 0)
})

test('busy save leaves edits and gives a visible explanation', async (t) => {
  const page = await editor(t, { save: (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Another operation is running. Wait for it to finish, then try again.' }) }) })
  await addGenre(page, 'Dance')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('#banner').filter({ hasText: 'Another operation' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true)
})

test('late search responses cannot overwrite newer suggestions', async (t) => {
  const first = deferred(), release = deferred(), completed = deferred()
  const page = await editor(t, { search: async (route, q) => {
    if (q === 'Old') { first.resolve(); await release.promise }
    await json(route, { results: [{ id: q === 'Old' ? 1 : 2, name: q + ' Artist', genre: 'Pop' }] })
    if (q === 'Old') completed.resolve()
  } })
  await ignoreSearchCancellation(page)
  const input = page.locator('[id="add-artists.followed"]')
  await input.fill('Old'); await first.promise
  await input.fill('New')
  await page.getByText('New Artist', { exact: true }).waitFor()
  release.resolve(); await completed.promise
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await page.getByText('Old Artist', { exact: true }).count(), 0)
  const row = await page.getByRole('button', { name: 'New Artist' }).boundingBox()
  assert.ok(row)
  await input.focus()
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2)
  await page.mouse.down()
  assert.equal(await input.evaluate((el) => el === document.activeElement), true)
  await page.mouse.move(0, 0)
  await page.mouse.up()
  await input.press('ArrowDown')
  await page.keyboard.press('Enter')
  // the chip view transition renders the new chip a frame later
  await page.getByRole('button', { name: 'Remove New Artist' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Remove New Artist' }).count(), 1)
})

for (const dismissal of ['Escape', 'blur']) {
  test('dismissed artist search stays hidden after ' + dismissal, async (t) => {
    const entered = deferred(), release = deferred(), completed = deferred()
    const page = await editor(t, { search: async (route) => {
      entered.resolve(); await release.promise
      await json(route, { results: [{ id: 1, name: 'Late Artist' }] })
      completed.resolve()
    } })
    await ignoreSearchCancellation(page)
    const input = page.locator('[id="add-artists.followed"]')
    await input.fill('Late'); await entered.promise
    if (dismissal === 'Escape') await input.press('Escape')
    else await page.locator('[id="add-artists.blocked"]').focus()
    release.resolve(); await completed.promise
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(await page.getByRole('button', { name: 'Late Artist' }).count(), 0)
  })
}

test('network save failure preserves edits and explains how to retry', async (t) => {
  const page = await editor(t, { save: (route) => route.abort() })
  await addGenre(page, 'Dance')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('#banner').filter({ hasText: 'Keep this tab open, reopen prefs.command' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Remove Dance' }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true)
})

for (const [outcomes, message] of [
  [['No changes'], 'Nothing new was published.'],
  [['Published'], 'Available results were published.'],
  [['Published', 'WARNING: Pages deploy not finished'], 'Available results were published. The site deploy did not confirm, so the page may still show old data.'],
]) {
  test('source failure reports publication and deployment: ' + outcomes.join('; '), async (t) => {
    const page = await editor(t, { status: (route) => json(route, { running: false, busy: false, log: ['ERROR: fetch failed for at least one source', ...outcomes] }) })
    await page.evaluate(async () => {
      while (polling) await new Promise(requestAnimationFrame)
      wasRunning = true
      await poll()
    })
    assert.match(await page.locator('#banner').textContent(), /a source failed/)
    assert.ok((await page.locator('#banner').textContent()).includes(message))
  })
}

test('background preference response cannot replace a newly focused input', async (t) => {
  const entered = deferred(), release = deferred()
  let loads = 0
  const page = await editor(t, { prefs: async (route) => {
    if (++loads > 1) { entered.resolve(); await release.promise }
    return json(route, prefs())
  } })
  await page.locator('h1').click()
  await page.evaluate(() => reloadPrefs())
  await entered.promise
  const input = page.locator('[id="add-artists.followed"]')
  await input.fill('Unfinished')
  const response = page.waitForResponse((r) => r.url().endsWith('/api/prefs'))
  release.resolve()
  await (await response).finished()
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await input.inputValue(), 'Unfinished')
})

test('visibility changes do not overlap status requests; quit stops polling', async (t) => {
  let active = 0, max = 0
  const entered = deferred(), release = deferred()
  const page = await editor(t, { status: async (route) => {
    active++; max = Math.max(max, active); entered.resolve(); await release.promise
    active--; await json(route, { running: false, log: [] })
  } })
  await entered.promise
  await page.evaluate(() => { for (let i = 0; i < 5; i++) document.dispatchEvent(new Event('visibilitychange')) })
  assert.equal(max, 1)
  release.resolve()
  await page.getByRole('button', { name: 'Quit editor', exact: true }).click()
  await page.getByText('Server stopped. You can close this tab.').waitFor()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
})

for (const failure of [false, true]) test('quit ignores a late initial preferences response, failure: ' + failure, async (t) => {
  const entered = deferred(), release = deferred()
  const page = await editor(t, { prefs: async (route) => {
    entered.resolve(); await release.promise
    if (failure) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture failure' }) })
    return json(route, prefs())
  } }, false)
  await entered.promise
  await page.getByRole('button', { name: 'Quit editor', exact: true }).click()
  await page.getByText('Server stopped. You can close this tab.').waitFor()
  const response = page.waitForResponse((r) => r.url().endsWith('/api/prefs'))
  release.resolve()
  await (await response).finished()
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await page.getByText('Server stopped. You can close this tab.').count(), 1)
})

test('actions card and error text fit narrow layouts after the last section', async (t) => {
  const longName = 'A'.repeat(190)
  const page = await editor(t, { prefs: (route) => json(route, {
    ...prefs(), artists: { followed: [{ id: 1, name: longName }], blocked: [] },
    countries: ['kr'], countryNames: { kr: 'Korea' }, streamingOnly: ['kr'],
  }) })
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; setStatus('A long status message must remain visible without hiding the controls.', true, true) })
    await page.evaluate(() => new Promise(requestAnimationFrame))
    const layout = await page.evaluate(() => {
      const dock = document.getElementById('editor-dock')
      const status = document.getElementById('status').getBoundingClientRect()
      return {
        width: document.documentElement.scrollWidth, viewport: innerWidth,
        afterMain: dock.previousElementSibling?.tagName === 'MAIN',
        inFlow: getComputedStyle(dock).position === 'static',
        status: { left: status.left, right: status.right, height: status.height },
        buttons: ['refresh', 'save', 'quit'].map((id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, right: b.right, height: b.height } }),
      }
    })
    assert.ok(layout.width <= layout.viewport, JSON.stringify(layout))
    assert.ok(layout.afterMain && layout.inFlow, JSON.stringify(layout))
    assert.ok(layout.status.left >= 0 && layout.status.right <= layout.viewport && layout.status.height >= 24, JSON.stringify(layout))
    for (const b of layout.buttons) assert.ok(b.height >= 24 && b.left >= 0 && b.right <= layout.viewport, JSON.stringify(layout))
    for (const name of [longName, 'Korea']) {
      const remove = await page.getByRole('button', { name: 'Remove ' + name, exact: true }).boundingBox()
      assert.ok(remove.width >= 24 && remove.x + remove.width <= layout.viewport)
    }
    assert.ok((await page.getByText('Korea', { exact: true }).boundingBox()).width > 0)
    await page.getByRole('textbox', { name: 'Add to Followed Genres' }).focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    const focus = await page.getByRole('button', { name: 'Remove Korea', exact: true }).evaluate((el) => {
      const box = el.getBoundingClientRect()
      return {
        active: el === document.activeElement,
        hit: el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
      }
    })
    assert.deepEqual(focus, { active: true, hit: true })
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; setStatus('Unsaved changes', false, true) })
  const tops = await page.evaluate(() => ['status', 'refresh', 'save'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().top + document.getElementById(id).getBoundingClientRect().height / 2)))
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, JSON.stringify(tops))
  await page.screenshot({ path: '/private/tmp/radar-editor-dark.png', fullPage: true })
})

test('built site keeps valid cards, warns on malformed entries, and supports tab keys', async (t) => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  t.after(() => context.close())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const fetched_at = Date.UTC(2026, 8, 29, 12)
  const card = { title: 'New Release', artist: 'Fixture Artist', type: 'album', release_date: '2026-09-29', artwork: '', genre: 'Pop', link: 'https://music.apple.com/us/album/fixture/123', followed: true }
  const feed = { fetched_at, releases: [card, null], upcoming: [{ ...card, title: 'Upcoming Release', release_date: '2026-10-01' }] }
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/data/releases.json')) return json(route, feed)
    if (url.pathname === '/api/ping') return route.fulfill({ status: 204 })
    if (url.pathname.startsWith('/new-music-radar/')) {
      const path = url.pathname.slice('/new-music-radar/'.length) || 'index.html'
      return route.fulfill({ path: join(site, path) })
    }
    return route.abort()
  })
  await page.goto('http://127.0.0.1:4747/new-music-radar/')
  await page.getByText('Some releases could not be displayed', { exact: false }).waitFor()
  assert.ok(await page.locator('#release-panel a').count() > 0)
  assert.equal(await page.locator('#release-panel a[target]').count(), 0)
  for (const href of await page.locator('#release-panel a').evaluateAll((els) => els.map((el) => el.getAttribute('href')))) assert.match(href, /^music:\/\/music.apple.com\/us\//)
  await page.locator('#tab-new').focus(); await page.keyboard.press('ArrowRight')
  // the view transition commits the tab change a frame later
  await page.locator('#tab-upcoming[aria-selected="true"]').waitFor()
  assert.equal(await page.getByText('Upcoming Release', { exact: true }).count(), 1)
  feed.releases = [null]
  feed.upcoming = []
  await page.reload()
  await page.getByText('No releases can be displayed from this update.', { exact: false }).waitFor()
  assert.equal(await page.getByText('No New Releases Right Now', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
})

// The feed omits followed for discovered releases.
const fixtureCard = (i, followed = true) => ({ title: `Release ${i}`, artist: `Artist ${i}`, type: 'album', release_date: '2026-09-29', artwork: '', genre: 'Pop', link: `https://music.apple.com/us/album/fixture/${i}`, ...(followed && { followed }) })

async function sitePage(t, data, viewport = { width: 402, height: 874 }) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport })
  t.after(() => context.close())
  const page = await context.newPage()
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/data/releases.json')) return data(route)
    if (url.pathname.startsWith('/new-music-radar/')) return route.fulfill({ path: join(site, url.pathname.slice('/new-music-radar/'.length) || 'index.html') })
    return route.abort()
  })
  return page
}

const navLayouts = [
  { width: 402, height: 874, nav: 'bar' },
  { width: 466, height: 678, nav: 'bar' },
  { width: 669, height: 951, nav: 'side' },
  { width: 951, height: 669, nav: 'side' },
  { width: 874, height: 402, nav: 'side' },
  { width: 1280, height: 800, nav: 'side' },
  { width: 639, height: 900, nav: 'bar' },
  { width: 640, height: 900, nav: 'side' },
]
for (const { width, height, nav } of navLayouts) test(`built site places the ${nav} nav at ${width}x${height} without covering cards`, async (t) => {
  const feed = { fetched_at: Date.UTC(2026, 8, 29, 12), releases: Array.from({ length: 30 }, (_, i) => fixtureCard(i)), upcoming: [{ ...fixtureCard(99), title: 'Upcoming Release', release_date: '2026-10-01' }] }
  const page = await sitePage(t, (route) => json(route, feed), { width, height })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://127.0.0.1:4747/new-music-radar/')
  await page.locator('#release-panel a').first().waitFor()
  const layout = await page.evaluate(() => {
    const nav = document.querySelector('[role="tablist"]').closest('nav')
    const style = getComputedStyle(nav)
    const box = nav.getBoundingClientRect()
    return { position: style.position, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }, scrollWidth: document.documentElement.scrollWidth, innerWidth, orientation: document.querySelector('[role="tablist"]').getAttribute('aria-orientation') }
  })
  assert.ok(layout.scrollWidth <= layout.innerWidth, JSON.stringify(layout))
  if (nav === 'bar') {
    assert.equal(layout.position, 'fixed')
    assert.equal(layout.orientation, 'horizontal')
    assert.ok(Math.abs((layout.box.left + layout.box.right) / 2 - width / 2) < 2, JSON.stringify(layout))
  } else {
    assert.equal(layout.position, 'sticky')
    assert.equal(layout.orientation, 'vertical')
    assert.ok(layout.box.left < 40 && layout.box.width > 150 && layout.box.bottom <= height, JSON.stringify(layout))
  }
  // at the end of the page the floating nav must not sit over the last card
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(400)
  const overlap = await page.evaluate(() => {
    const last = [...document.querySelectorAll('#release-panel a')].at(-1).getBoundingClientRect()
    const nav = document.querySelector('[role="tablist"]').closest('nav').getBoundingClientRect()
    return last.left < nav.right && nav.left < last.right && last.top < nav.bottom && nav.top < last.bottom
  })
  assert.equal(overlap, false)
  await page.locator('#tab-new').focus()
  await page.keyboard.press(nav === 'bar' ? 'ArrowRight' : 'ArrowDown')
  await page.locator('#tab-upcoming[aria-selected="true"]').waitFor()
  assert.deepEqual(errors, [])
})

test('built site filters New by following only when both kinds exist', async (t) => {
  const fetched_at = Date.UTC(2026, 8, 29, 12)
  let feed = { fetched_at, releases: [fixtureCard(1), fixtureCard(2), fixtureCard(3, false)], upcoming: [] }
  const page = await sitePage(t, (route) => json(route, feed))
  await page.goto('http://127.0.0.1:4747/new-music-radar/')
  await page.locator('#release-panel a').first().waitFor()
  const pills = page.getByRole('group', { name: 'Show' }).getByRole('button')
  assert.deepEqual(await pills.allTextContents(), ['All', 'Following', 'Discovered'])
  assert.equal(await page.locator('#release-panel a').count(), 3)
  await page.getByRole('button', { name: 'Following' }).click()
  await page.locator('#release-panel a').nth(2).waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: 'Following' }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: 'Discovered' }).click()
  await page.getByText('Release 3', { exact: true }).waitFor()
  assert.equal(await page.locator('#release-panel a').count(), 1)
  feed = { fetched_at, releases: [fixtureCard(1), fixtureCard(2)], upcoming: [] }
  await page.reload()
  await page.locator('#release-panel a').first().waitFor()
  assert.equal(await page.getByRole('group', { name: 'Show' }).count(), 0)
  assert.equal(await page.locator('#release-panel a').count(), 2)
})

test('built site explains an empty update', async (t) => {
  const feed = { fetched_at: Date.UTC(2026, 8, 29, 12), releases: [], upcoming: [] }
  const page = await sitePage(t, (route) => json(route, feed))
  await page.goto('http://127.0.0.1:4747/new-music-radar/')
  await page.getByText('No New Releases Right Now', { exact: true }).waitFor()
  await page.getByText('Updates daily.', { exact: true }).waitFor()
})

test('built site offers Try again when the feed fails to load', async (t) => {
  let fail = true
  const feed = { fetched_at: Date.UTC(2026, 8, 29, 12), releases: [fixtureCard(1)], upcoming: [] }
  const page = await sitePage(t, (route) => fail ? route.fulfill({ status: 500, body: 'error' }) : json(route, feed))
  await page.goto('http://127.0.0.1:4747/new-music-radar/')
  await page.getByText('Couldn’t Load Releases', { exact: true }).waitFor()
  fail = false
  await page.getByRole('button', { name: 'Try again' }).click()
  await page.locator('#release-panel a').first().waitFor()
})

test('built site keeps the last update available offline and names a server failure', async (t) => {
  const feed = JSON.stringify({ fetched_at: Date.UTC(2026, 8, 29, 12), releases: [fixtureCard(1), fixtureCard(2, false)], upcoming: [] })
  let failData = false
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (!path.startsWith('/new-music-radar/')) return res.writeHead(404).end()
    if (path.endsWith('/data/releases.json')) return failData ? res.writeHead(500).end() : res.writeHead(200, { 'Content-Type': 'application/json' }).end(feed)
    const file = join(site, path.slice('/new-music-radar/'.length) || 'index.html')
    if (!existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', Vary: 'Origin' }).end(readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/new-music-radar/`)
  await page.locator('#release-panel a').first().waitFor()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.waitForFunction(() => navigator.serviceWorker.controller)
  const base = `http://127.0.0.1:${server.address().port}/new-music-radar/`
  assert.equal((await page.goto(base + 'missing')).status(), 404)
  await page.goto(base + 'data/releases.json')
  await page.goto(base)
  await page.locator('#release-panel a').first().waitFor()
  await context.setOffline(true)
  await page.reload()
  await page.getByText('You’re offline. Showing the last saved update.', { exact: true }).waitFor()
  assert.equal(await page.locator('#release-panel a').count(), 2)
  await context.setOffline(false)
  failData = true
  await page.reload()
  await page.getByText('Couldn’t refresh. Showing the last saved update.', { exact: true }).waitFor()
  assert.equal(await page.getByText('You’re offline', { exact: false }).count(), 0)
  assert.deepEqual(errors, [])
})

test('removing a chip offers Undo that restores it and keeps the edit unsaved', async (t) => {
  const page = await editor(t)
  await page.getByRole('button', { name: 'Remove Pop', exact: true }).click()
  await page.locator('#undo-toast').getByText('Removed Pop').waitFor()
  // the chip leaves inside a view transition, a frame after the toast appears
  await page.getByRole('button', { name: 'Remove Pop', exact: true }).waitFor({ state: 'detached' })
  await page.locator('#undo-toast').getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('button', { name: 'Remove Pop', exact: true }).waitFor()
  assert.equal(await page.locator('#undo-toast').count(), 0)
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'add-genres.followed')
  assert.equal(await page.locator('#save').isDisabled(), false)
})

test('section index follows the scroll position, including the last section', async (t) => {
  const many = () => ({ ...prefs(), artists: { followed: Array.from({ length: 40 }, (_, i) => ({ id: 1000 + i, name: `Artist ${i}` })), blocked: [] } })
  const page = await editor(t, { prefs: (route) => json(route, many()) })
  const current = () => page.locator('#section-index a[aria-current="true"]').innerText()
  await page.locator('#section-index a', { hasText: 'Playlists' }).click()
  await page.waitForFunction(() => document.querySelector('#section-index a[aria-current="true"]')?.textContent === 'Playlists')
  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForFunction(() => document.querySelector('#section-index a[aria-current="true"]')?.textContent === 'Artists')
  assert.equal(await current(), 'Artists')
  await page.locator('#section-index a', { hasText: 'Filters' }).click()
  await page.waitForFunction(() => document.querySelector('#section-index a[aria-current="true"]')?.textContent === 'Filters')
  const visible = await page.evaluate(() => {
    const nav = document.getElementById('section-index').getBoundingClientRect()
    const link = document.querySelector('#section-index a[aria-current="true"]').getBoundingClientRect()
    return link.left >= nav.left - 1 && link.right <= nav.right + 1
  })
  assert.ok(visible)
})

test('US, chart genres, source counts and the filter toggle', async (t) => {
  const page = await editor(t, { prefs: (route) => json(route, {
    ...prefs(), genres: { followed: ['Pop', 'Afrobeats'] }, countries: ['us', 'kr'],
    countryNames: { us: 'United States', kr: 'Korea' }, streamingOnly: ['kr'],
    chartGenres: { pop: 'genre:Pop' },
    sourceCounts: { 'chart:us': { surfaced: 21, unique: 5, measured: 18, failed: 0, last: null } },
    filters: { hide_alternate_versions: true },
  }) })
  assert.equal(await page.getByText('Always scanned').count(), 0)
  const us = page.locator('[data-section="discovery.countries"] span', { hasText: 'United States' }).first()
  assert.match(await us.innerText(), /5 only here/)
  assert.equal(await us.getAttribute('title'), 'Most-played albums, top 50')
  const genres = page.locator('[data-section="genres.followed"]')
  assert.equal(await genres.getByText('· US chart').count(), 1)
  await page.getByRole('button', { name: 'Remove United States', exact: true }).click()
  await page.getByRole('button', { name: 'Remove United States', exact: true }).waitFor({ state: 'detached' })
  await page.getByRole('textbox', { name: 'Add to Countries' }).fill('United States')
  await page.getByRole('textbox', { name: 'Add to Countries' }).press('Enter')
  await page.getByRole('button', { name: 'Remove United States', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('save').disabled)
  const box = page.getByRole('checkbox', { name: 'Hide instrumental, sped-up and slowed versions' })
  assert.equal(await box.isChecked(), true)
  let posted
  await page.route('**/api/prefs', async (route) => {
    if (route.request().method() === 'POST') { posted = JSON.parse(route.request().postData()); return json(route, { ok: true }) }
    return route.fallback()
  })
  await box.uncheck()
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), false)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('save').disabled)
  assert.deepEqual(posted.filters, { hide_alternate_versions: false })
  assert.ok(posted.discovery.countries.includes('us'))
})
