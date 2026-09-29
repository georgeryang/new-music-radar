import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAGE } from '../scripts/prefs-server.mjs'
import { repo } from './helpers.mjs'

const { chromium } = await import('playwright').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes("'playwright'")) {
    throw new Error('Playwright is missing. Run npm ci, then npm run test:browser:install.', { cause: error })
  }
  throw error
})
const browser = await chromium.launch({ headless: true }).catch((error) => {
  if (error.message.includes("Executable doesn't exist at")) {
    throw new Error('Chromium is missing. Run npm run test:browser:install.', { cause: error })
  }
  throw error
})
test.after(() => browser.close())
const prefs = () => ({ artists: { followed: [], blocked: [] }, genres: { followed: ['Pop'] }, countries: [], playlists: [], genreOptions: ['Pop', 'Rock'], countryNames: { us: 'United States' }, countsAvailable: true })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

async function editor(t, handlers = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  t.after(() => assert.deepEqual(errors, []))
  const css = readdirSync(join(repo, 'docs/assets')).find((name) => name.endsWith('.css'))
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
      const file = join(repo, 'docs', path.slice('/new-music-radar/'.length))
      return route.fulfill({ path: file })
    }
    return route.abort()
  })
  await page.goto('http://127.0.0.1:4747/')
  await page.locator('[id="add-genres.followed"]').waitFor()
  return page
}
async function addGenre(page, name) {
  const input = page.locator('[id="add-genres.followed"]')
  await input.fill(name); await input.press('Enter')
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
  // Simulate a transport that finishes despite cancellation, exercising the generation check.
  await page.evaluate(() => { const original = window.fetch; window.fetch = (url, options) => original(url, String(url).includes('artist-search') ? {} : options) })
  const input = page.locator('[id="add-artists.followed"]')
  await input.fill('Old'); await first.promise
  await input.fill('New')
  await page.getByText('New Artist', { exact: true }).waitFor()
  release.resolve(); await completed.promise
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await page.getByText('Old Artist', { exact: true }).count(), 0)
  await input.press('ArrowDown')
  await page.keyboard.press('Enter')
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
    await page.evaluate(() => { const original = window.fetch; window.fetch = (url, options) => original(url, String(url).includes('artist-search') ? {} : options) })
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
  await page.getByRole('button', { name: 'Quit', exact: true }).click()
  await page.getByText('Server stopped. You can close this tab.').waitFor()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
})

test('footer and error text fit narrow layouts and reserve content space', async (t) => {
  const page = await editor(t)
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; setStatus('A long status message must remain visible without hiding the controls.', true, true) })
    await page.evaluate(() => new Promise(requestAnimationFrame))
    const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, padding: parseFloat(getComputedStyle(document.body).paddingBottom), dock: document.getElementById('editor-dock').getBoundingClientRect().height }))
    assert.ok(layout.width <= layout.viewport, JSON.stringify(layout))
    assert.ok(layout.padding >= layout.dock)
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '' })
  await page.screenshot({ path: '/private/tmp/radar-editor-dark.png', fullPage: true })
})

test('built site keeps valid cards, warns on malformed entries, and supports tab keys', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const feed = JSON.parse(readFileSync(join(repo, 'docs/data/releases.json')))
  feed.releases.push(null)
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/data/releases.json')) return json(route, feed)
    if (url.pathname === '/api/ping') return route.fulfill({ status: 204 })
    if (url.pathname.startsWith('/new-music-radar/')) {
      const path = url.pathname.slice('/new-music-radar/'.length) || 'index.html'
      return route.fulfill({ path: join(repo, 'docs', path) })
    }
    return route.abort()
  })
  await page.goto('http://127.0.0.1:4747/new-music-radar/')
  await page.getByText('Some releases could not be displayed', { exact: false }).waitFor()
  assert.ok(await page.locator('#release-panel > a').count() > 0)
  for (const href of await page.locator('#release-panel > a').evaluateAll((els) => els.map((el) => el.getAttribute('href')))) assert.match(href, /^music:\/\/music.apple.com\/us\//)
  if (await page.locator('#tab-upcoming').count()) {
    await page.locator('#tab-new').focus(); await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('#tab-upcoming').getAttribute('aria-selected'), 'true')
  }
  feed.releases = [null]
  feed.upcoming = []
  await page.reload()
  await page.getByText('No releases can be displayed from this update.', { exact: false }).waitFor()
  assert.equal(await page.getByText('No new releases right now.', { exact: false }).count(), 0)
  assert.deepEqual(errors, [])
})
