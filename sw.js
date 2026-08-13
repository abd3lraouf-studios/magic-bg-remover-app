/*
 * Offline service worker for Magic BG Remover.
 *
 * Strategy (base-path agnostic — classifies by request path):
 *   - Model + WASM (/imgly/**, /opencv/**, *.wasm, *.onnx) → CacheFirst in a
 *     dedicated cache (large, immutable; downloaded once, then served offline).
 *   - The offline manifest                       → NetworkFirst (never stale).
 *   - Navigations                                → NetworkFirst, falling back to the
 *     cached app shell when offline.
 *   - Static assets (/_next/static/**, images…)  → CacheFirst.
 *   - Everything else same-origin                → StaleWhileRevalidate.
 *
 * First online visit populates the caches; every later visit works fully offline.
 * The "Available offline" toggle front-loads the whole manifest — that precache
 * runs in the PAGE (lib/offline.ts) writing into these same caches, so a long
 * multi-hundred-MB download isn't at the mercy of worker lifetime.
 *
 * Cache names are duplicated in lib/offline.ts — keep the two in sync.
 */
const VERSION = "v3";
// App shell / code: versioned, so bumping VERSION drops the previous build.
const RUNTIME = `mbr-runtime-${VERSION}`;
// Immutable heavyweights (AI model chunks, OpenCV, ONNX/codec WASM). The name is
// deliberately frozen across app versions: these are content-addressed, and
// re-keying them would force users to re-download >100 MB on every deploy.
const ASSETS = "mbr-model-v2";
const KEEP = [RUNTIME, ASSETS];

// Take over only when the page asks (see SKIP_WAITING below). Activating behind
// the user's back swaps the code out from under an in-progress edit.
self.addEventListener("install", () => {});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

const isModelOrWasm = (url) =>
  url.pathname.includes("/imgly/") ||
  url.pathname.includes("/opencv/") ||
  url.pathname.endsWith(".wasm") ||
  url.pathname.endsWith(".onnx");

const isManifest = (url) => url.pathname.endsWith("/offline-manifest.json");

const isStatic = (url) =>
  url.pathname.includes("/_next/static/") ||
  /\.(js|css|woff2?|png|jpg|jpeg|svg|webp|ico|json|webmanifest)$/.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // only our self-hosted assets

  if (isModelOrWasm(url)) {
    event.respondWith(cacheFirst(req, ASSETS));
  } else if (isManifest(url)) {
    // Must reflect the deployed build, or the offline toggle would compare
    // against a stale asset list and report "up to date" forever.
    event.respondWith(networkFirst(req, RUNTIME));
  } else if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, RUNTIME));
  } else if (isStatic(url)) {
    event.respondWith(cacheFirst(req, RUNTIME));
  } else {
    event.respondWith(staleWhileRevalidate(req, RUNTIME));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    const shell = await cache.match(self.registration.scope);
    if (shell) return shell;
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || network;
}
