const CACHE_NAME = "pideck-shell-v2"
const SHELL_KEY = "/__yaade-offline-shell__"

async function trimCache(cache, maxEntries = 128) {
  const keys = await cache.keys()
  const removable = keys.filter(request => !request.url.endsWith(SHELL_KEY))
  const excess = Math.max(0, keys.length - maxEntries)
  await Promise.all(removable.slice(0, excess).map(request => cache.delete(request)))
}

async function precacheShell() {
  const response = await fetch(new Request("/", { cache: "reload" }))
  if (!response.ok) return
  const html = await response.clone().text()
  const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map(match => match[1])
    .filter(Boolean)
  const cache = await caches.open(CACHE_NAME)
  await cache.put(SHELL_KEY, response)
  await Promise.all(assetPaths.map(async path => {
    const asset = await fetch(path)
    if (asset.ok) await cache.put(path, asset)
  }))
  await trimCache(cache)
}

function cacheable(request) {
  if (request.method !== "GET") return false
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false
  return !url.pathname.startsWith("/api/") &&
    url.pathname !== "/api" &&
    !url.pathname.startsWith("/agents/v1/") &&
    !url.pathname.startsWith("/tasks/api/") &&
    !url.pathname.startsWith("/terminal/") &&
    url.pathname !== "/tasks/health"
}

self.addEventListener("install", event => {
  event.waitUntil(precacheShell())
})

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") self.skipWaiting()
})

self.addEventListener("fetch", event => {
  const request = event.request
  if (!cacheable(request)) return

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone()
            event.waitUntil(
              caches.open(CACHE_NAME).then(async cache => {
                await cache.put(SHELL_KEY, copy)
                await trimCache(cache)
              }),
            )
          }
          return response
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME)
          return (await cache.match(request)) ??
            (await cache.match(SHELL_KEY)) ??
            Response.error()
        }),
    )
    return
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached
      return fetch(request).then(response => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone()
          event.waitUntil(
            caches.open(CACHE_NAME).then(async cache => {
              await cache.put(request, copy)
              await trimCache(cache)
            }),
          )
        }
        return response
      })
    }),
  )
})
