// PD Media — service worker
// -----------------------------------------------------------------------
// Two jobs:
//   1. Cache the app shell so the PWA opens even with zero signal.
//   2. Background Sync: when an upload is queued offline, the page tells the
//      SW to wake up when network comes back and finish the chunked PUTs.
//
// Bump CACHE_NAME whenever the app shell changes to force a refresh.

const CACHE_NAME  = "pd-media-v1";
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
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// --- Fetch: cache-first for app shell, network-first for API ----------
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never touch upload PUTs — those go straight to Google.
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("google.com")) return;

  // Network-first for our own API
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/functions/")) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({ error: "Offline" }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      ))
    );
    return;
  }

  // Cache-first for everything else (app shell)
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((resp) => {
      // Stash GETs we didn't pre-cache for next time
      if (event.request.method === "GET" && resp.ok && resp.type === "basic") {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone)).catch(() => {});
      }
      return resp;
    }))
  );
});

// --- Background Sync: poke the page to resume queued uploads -----------
// The page registers a sync tag 'pd-media-resume-uploads' whenever it
// queues something. Chrome/Android fires this when connectivity returns.
self.addEventListener("sync", (event) => {
  if (event.tag !== "pd-media-resume-uploads") return;
  event.waitUntil(notifyClientsToResume());
});

// Send a message to every open client; the page handles the actual upload
// resume logic (it already has all the chunking + IndexedDB code).
async function notifyClientsToResume() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "RESUME_UPLOADS" });
}

// Allow the page to ask us to wake up
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
