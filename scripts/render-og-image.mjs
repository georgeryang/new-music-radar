import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const favicon = readFileSync(new URL('../src/assets/favicon.svg', import.meta.url), 'utf8')
const drawing = favicon.match(/<g [\s\S]*<\/g>/)?.[0]
if (!drawing) throw new Error('Radar drawing missing from favicon.svg')

const html = `<!doctype html><style>
html, body { margin: 0; width: 1200px; height: 630px; }
body { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #6C172C, #B3264A); }
</style><svg width="400" height="400" viewBox="3 3 24 24">${drawing}</svg>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.setContent(html)
  await page.screenshot({ path: new URL('../public/assets/og-image.png', import.meta.url).pathname })
} finally { await browser.close() }
