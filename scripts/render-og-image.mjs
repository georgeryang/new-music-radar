import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const favicon = readFileSync(new URL('../src/assets/favicon.svg', import.meta.url), 'utf8')
const drawing = favicon.match(/<g [\s\S]*<\/g>/)?.[0]
const stops = [...favicon.matchAll(/stop-color="([^"]+)"/g)].map((m) => m[1])
if (!drawing || stops.length !== 2) throw new Error('Radar drawing or gradient missing from favicon.svg')

const html = `<!doctype html><style>
html, body { margin: 0; width: 1200px; height: 630px; }
body { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, ${stops.join(', ')}); }
</style><svg width="400" height="400" viewBox="3 3 24 24">${drawing}</svg>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.setContent(html)
  await page.screenshot({ path: fileURLToPath(new URL('../public/assets/og-image.png', import.meta.url)) })
} finally { await browser.close() }
