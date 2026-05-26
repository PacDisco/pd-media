// PD Media — service worker
// -----------------------------------------------------------------------
// Two jobs:
//   1. Make the app open instantly when there's no signal (cache fallback).
//   2. Background Sync: when an upload is queued offline, the SW wakes the
//      page up to finish the chunked PUTs when network returns.
//
// Strategy:
//   - HTML & JS / app shell: **network-first** with cache fallback. This
//     means each app open fetches fresh code if online — so deploys reach
//     installed phones the next time they load the app with signal. Cache
//     is only used when fully offline.
//   - Static assets (icons, manifest): cache-first. They rarely change.
//   - API & upload calls: pass through to the network, never cached.
//
// Bump CACHE_NAME whenever we want to wipe out a bad cached version.

const CACHE_NAME  = "pd-media-v3";
const APP_SHELL   = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// --- Install: pre-cache the shell ---------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// --- Activate: clean old caches ----------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// --- Fetch routing ------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Don't touch upload PUTs or anything cross-origin.
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") return;

  // API + functions: always network, never cache. If offline, return a
  // tidy JSON error the page can render.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/functions/")) {
    event.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ error: "Offline" }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      ))
    );
    return;
  }

  // Navigations (HTML) + script files → network-first so new deploys reach
  // the phone next time the app opens with signal.
  const isHtml   = req.mode === "navigate" || req.destination === "document" ||
                   url.pathname === "/" || url.pathname.endsWith(".html");
  const isScript = req.destination === "script";
  if (isHtml || isScript) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Static assets: cache-first.
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    if (fresh.ok) {
      // Stash the fresh copy so we can serve it later when offline
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Last resort: serve the cached root so the app still opens
    return (await caches.match("/index.html")) ||
           new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok && fresh.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

// --- Background Sync: poke the page to resume queued uploads -----------
self.addEventListener("sync", (event) => {
  if (event.tag !== "pd-media-resume-uploads") return;
  event.waitUntil(notifyClientsToResume());
});

async function notifyClientsToResume() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "RESUME_UPLOADS" });
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
