const VERSION = new URL(location.href).searchParams.get('v') ?? 'dev'
const SHELL = `radar-shell-${VERSION}`
const LIVE = 'radar-live'
const ART = 'radar-art'
// A card caches a 60px preview and one srcset size, so about 100 cards.
const ART_LIMIT = 200
// Plane and captive Wi-Fi often hang instead of failing.
const NETWORK_TIMEOUT = 3500

const scope = new URL(self.registration.scope)
const INDEX = scope.href
const DATA = new URL('data/releases.json', scope).href

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('radar-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

async function precache() {
  const index = await fetch(INDEX, { cache: 'no-cache' })
  if (!index.ok) throw new Error('index unavailable')
  const html = await index.clone().text()
  const assets = [...new Set(html.match(/[^"'\s]*\/assets\/[^"'\s]+/g) ?? [])].map((u) => new URL(u, scope).href)
  const fonts = []
  for (const css of assets.filter((u) => u.endsWith('.css'))) {
    const text = await (await fetch(css)).text()
    for (const [, u] of text.matchAll(/url\(["']?([^"')]*\/fonts\/[^"')]+)["']?\)/g)) fonts.push(new URL(u, css).href)
  }
  await (await caches.open(SHELL)).addAll([...assets, ...new Set(fonts)])
  const live = await caches.open(LIVE)
  await live.put(INDEX, index)
  const data = await fetch(DATA, { cache: 'no-cache' }).catch(() => null)
  if (data?.ok) await live.put(DATA, data)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // Only the app page itself: other paths keep their real 404s and are never cached as the index.
  if (request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html')) {
    event.respondWith(networkFirst(event, INDEX))
  } else if (url.href.split('?')[0] === DATA) {
    event.respondWith(networkFirst(event, DATA))
  } else if (url.href.startsWith(new URL('assets/', scope).href)) {
    event.respondWith(cacheFirst(request, SHELL))
  } else if (url.href.startsWith(new URL('fonts/', scope).href)) {
    event.respondWith(staleWhileRevalidate(request))
  } else if (url.hostname.endsWith('.mzstatic.com')) {
    event.respondWith(cacheFirst(request, ART, ART_LIMIT))
  }
})

async function networkFirst(event, key) {
  const cache = await caches.open(LIVE)
  const network = fetch(event.request)
  const first = await Promise.race([
    network.catch(() => null),
    new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT, null)),
  ])
  if (first?.ok) {
    await cache.put(key, first.clone())
    return first
  }
  const cached = await cache.match(key, { ignoreSearch: true, ignoreVary: true })
  if (cached) {
    // A slow network may still answer after the timeout; keep that copy for next time.
    if (!first) event.waitUntil(network.then((late) => late.ok && cache.put(key, late.clone())).catch(() => {}))
    return markCached(cached, first ? 'error' : 'offline')
  }
  try {
    const late = await network
    if (late.ok) await cache.put(key, late.clone())
    return late
  } catch {
    return Response.error()
  }
}

function markCached(response, reason) {
  const headers = new Headers(response.headers)
  headers.set('X-Radar-Cached', reason)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function cacheFirst(request, name, limit) {
  const cache = await caches.open(name)
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) return cached
  const response = await fetch(request)
  // Opaque responses can't be checked and count their padded size against quota.
  if (response.ok && response.type !== 'opaque') {
    await cache.put(request, response.clone())
    if (limit) trim(cache, limit)
  }
  return response
}

async function trim(cache, limit) {
  const keys = await cache.keys()
  await Promise.all(keys.slice(0, Math.max(0, keys.length - limit)).map((k) => cache.delete(k)))
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL)
  const cached = await cache.match(request, { ignoreVary: true })
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone())
    return response
  })
  if (!cached) return network
  network.catch(() => {})
  return cached
}
