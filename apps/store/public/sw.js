/**
 * BluelineGPT Store — minimal, conservative service worker.
 *
 * Shared Commerce Foundation Prompt 3D (§15-20). This is deliberately the
 * SMALLEST safe version, not an offline-first ecommerce shell:
 *
 *   - It caches ONLY Vite's content-hashed `/assets/*` bundles (JS/CSS) and
 *     the static icon/manifest files under `/icons/` — nothing that can ever
 *     contain a Customer's data.
 *   - Every navigation request (HTML page load) and every API endpoint request is
 *     served from the network ONLY. This file never intercepts them, so
 *     Customer auth, profile, addresses, My Orders, Order detail, tracking
 *     results and password-reset responses are structurally impossible to
 *     read from this cache — there is no code path that could put them there.
 *   - No background sync, no offline mutation queue, no push handling here
 *     (push is a separate future concern per Part I — this file does not
 *     listen for `push` events at all).
 *
 * Plain vanilla `self.caches`/`fetch` — no Workbox, no build step. Kept this
 * small on purpose: a hand-reviewable file is easier to trust than a
 * generated one for something this security-sensitive.
 */

const CACHE_VERSION = "blueline-store-static-v1";

// Fetch handler ONLY matches these two prefixes. Everything else -- most
// importantly every navigation (HTML) request and every API endpoint request --
// falls through untouched to the browser's normal network fetch.
const CACHEABLE_PREFIXES = ["/assets/", "/icons/"];

function isCacheableRequest(url) {
  if (url.origin !== self.location.origin) return false;
  return CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

self.addEventListener("install", (event) => {
  // Activate immediately rather than waiting for all tabs to close -- a
  // static-asset-only cache has no stale-Customer-data risk from an
  // in-flight page adopting a new version mid-session.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await self.caches.keys();
      await Promise.all(
        keys
          // Only ever touch OUR OWN versioned cache names -- never a cache
          // this file did not create (§18: "do not delete unrelated
          // browser caches").
          .filter((key) => key.startsWith("blueline-store-static-") && key !== CACHE_VERSION)
          .map((key) => self.caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // Never intercept a mutation.

  const url = new URL(request.url);
  if (!isCacheableRequest(url)) return; // Network, untouched -- see comment above.

  event.respondWith(
    (async () => {
      const cache = await self.caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      if (cached !== undefined) return cached;
      const response = await fetch(request);
      // Content-hashed assets never change under the same URL, so caching a
      // successful response is always safe; a non-OK response (e.g. a
      // removed icon after a redeploy) is never cached.
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })(),
  );
});
