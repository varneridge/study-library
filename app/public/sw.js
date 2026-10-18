// Service worker. Serves the app shell offline. Readings are cached in
// IndexedDB by the app itself, so they are not handled here.
//
// The build fills in BUILD and PRECACHE. Each build gets its own shell
// cache, filled with every script and style sheet at install, so a part of
// the app you have not opened yet still works offline. The previous
// build's cache is kept for a tab still open on it; older ones are deleted.
const BUILD = "__BUILD__";
const PRECACHE = /*__PRECACHE__*/[];
const PREFIX = "study-shell-";
const CACHE = PREFIX + BUILD;
// Fonts and pictures in notes never change at an address, so they keep
// their own caches across builds.
const FONTS = "study-fonts-v1";
const PICTURES = "study-pictures-v1";
const KEEP_OTHERS = new Set([FONTS, PICTURES]);
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/pdf.worker.min.mjs"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...SHELL, ...PRECACHE])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => {
        // Shell caches are named with the build time first, so they sort in order.
        const shells = keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).sort();
        const previous = shells.filter((key) => key < CACHE).at(-1);
        const stale = keys.filter((key) => key !== CACHE && key !== previous && !KEEP_OTHERS.has(key));
        return Promise.all(stale.map((key) => caches.delete(key)));
      })
      .then(() => self.clients.claim()),
  );
});

function cacheFirst(request, name) {
  return caches.match(request).then(
    (hit) =>
      hit ||
      fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          void caches.open(name).then((cache) => cache.put(request, copy));
        }
        return response;
      }),
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (/^\/api\/objects\/files\/[0-9a-f]{64}\.(png|jpg|gif|webp)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, PICTURES));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;

  // Pages: try the network first so updates arrive, then fall back to the shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Built assets have content hashes in their names, so the cache can win.
  if (/^\/assets\/.+\.(woff2?|ttf)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, FONTS));
    return;
  }
  if (url.pathname.startsWith("/assets/") || SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, CACHE));
  }
});
