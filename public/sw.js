/*
 * Service worker managed by Buildy (Website Settings > Installable app).
 * Buildy rewrites this file when that setting changes, so put custom logic in
 * your app code instead of editing it here.
 *
 * Strategy:
 * - Page loads: network first (with a plain-GET retry so an aborted navigate
 *   fetch isn't mistaken for offline), cached app shell when truly offline.
 * - Built assets under /assets/ (content-hashed by Vite): cache first.
 * - Other same-origin images, fonts, styles, scripts: serve cached, refresh in background.
 * - /api/ requests and non-GET requests are never cached.
 */
const VERSION = "mufcbnod";
const CACHE_PREFIX = "buildy-pwa-";
const SHELL_CACHE = CACHE_PREFIX + "shell-" + VERSION;
const ASSET_CACHE = CACHE_PREFIX + "assets-" + VERSION;
const RUNTIME_CACHE = CACHE_PREFIX + "runtime-" + VERSION;
const SHELL_URL = "/";
const RUNTIME_CACHE_LIMIT = 150;
// Publishes change the hashed asset names but not this worker's version, so
// old assets pile up under the same cache. Keep the newest few builds' worth.
const ASSET_CACHE_LIMIT = 200;
const CACHEABLE_DESTINATIONS = ["style", "script", "image", "font", "manifest"];

const OFFLINE_HTML =
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
  "<title>Offline</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;" +
  "justify-content:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
  "background:#fff;color:#111;text-align:center;padding:24px}" +
  ".bar{position:fixed;top:0;left:0;right:0;height:4px;background:#f05942}" +
  ".name{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#888;margin:0 0 12px}" +
  "h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#555}" +
  "button{margin-top:20px;padding:10px 18px;border:1px solid #f05942;border-radius:8px;" +
  "background:#f05942;color:#fff;font-size:14px;cursor:pointer}" +
  "</style></head><body><div class=\"bar\"></div><div>" +
  "<p class=\"name\">Audio Expert</p>" +
  "<h1>You are offline</h1><p>Check your connection and try again.</p>" +
  "<button onclick=\"location.reload()\">Retry</button></div>" +
  "<script>addEventListener('online',function(){location.reload()})</script>" +
  "</body></html>";

self.addEventListener("install", (event) => {
  // Same guard as later navigations: a hosting placeholder must not become
  // the offline shell.
  event.waitUntil(
    fetch(new Request(SHELL_URL, { cache: "reload" }))
      .then((response) => (response.ok ? updateShellCache(response) : undefined))
      .catch(() => undefined)
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && !key.endsWith("-" + VERSION))
            .map((key) => caches.delete(key))
        );
      } catch {
        // Old caches stay until the next activation; the worker still takes over.
      }
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          // Not supported in this browser.
        }
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (CACHEABLE_DESTINATIONS.includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
  }
});

async function handleNavigation(event) {
  try {
    const preloaded = event.preloadResponse ? await event.preloadResponse : null;
    const response = preloaded || (await fetch(event.request));
    if (response && response.ok) {
      await updateShellCache(response.clone());
    }
    return response;
  } catch {
    // A navigate-mode fetch can fail while the origin is reachable: the browser
    // aborts the navigation preload and in-flight requests when a page
    // navigates away, and navigate-mode requests are handled differently from
    // plain GETs behind some proxies. Retry once as a plain same-origin GET
    // (manual redirect keeps an opaqueredirect returnable for the navigation)
    // before falling back to the cached shell or offline page.
    try {
      const retry = await fetch(event.request.url, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "manual",
      });
      if (retry && retry.ok) {
        await updateShellCache(retry.clone());
      }
      return retry;
    } catch {
      const shell = await matchCache(await openCache(SHELL_CACHE), SHELL_URL);
      if (shell) return shell;
      return new Response(OFFLINE_HTML, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }
}

// Only real app shells go in the shell cache. A hosting placeholder page also
// answers with HTML, and caching it would trap offline users on that page.
async function updateShellCache(response) {
  // Respect the server: a shell marked no-store must not be stored and served
  // back offline.
  const cacheControl = response.headers.get("cache-control") || "";
  if (/\bno-store\b/i.test(cacheControl)) return;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return;
  let body;
  try {
    body = await response.clone().text();
  } catch {
    return;
  }
  if (!body.includes('id="root"')) return;
  await storeInCache(await openCache(SHELL_CACHE), SHELL_URL, response);
}

async function cacheFirst(request, cacheName) {
  const cache = await openCache(cacheName);
  const cached = await matchCache(cache, request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    await storeInCache(cache, request, response, ASSET_CACHE_LIMIT);
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await openCache(cacheName);
  const cached = await matchCache(cache, request);
  const network = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        await storeInCache(cache, request, response, RUNTIME_CACHE_LIMIT);
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const response = await network;
  if (response) return response;
  return new Response("", { status: 504, statusText: "Offline" });
}

// Cache storage is an optimization, never a dependency. It can fail at any
// call (storage quota, private browsing, eviction between calls), and a
// failed cache write must not turn a good network response into an error.
async function openCache(name) {
  try {
    return await caches.open(name);
  } catch {
    return null;
  }
}

async function matchCache(cache, request) {
  if (!cache) return undefined;
  try {
    return await cache.match(request);
  } catch {
    return undefined;
  }
}

async function storeInCache(cache, request, response, limit) {
  if (!cache) return;
  try {
    await cache.put(request, response.clone());
    if (limit) await trimCache(cache, limit);
  } catch {
    // The response was already handed to the page; nothing to recover.
  }
}

async function trimCache(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}
