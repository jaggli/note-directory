// Offline shell: serve same-origin files from cache, refresh them in the
// background so the next load is current. Bump CACHE only to drop old files.
const CACHE = "note-v1";
const SHELL = [
  "./",
  "app.js",
  "manifest.json",
  "victor-mono/VictorMono-Regular.woff2",
  "img/favicon.ico",
  "img/favicon-32x32.png",
  "img/android-chrome-192x192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  // All navigations (?id=…) render the same page
  const key = req.mode === "navigate" ? new URL("./", location).href : req;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key, { ignoreSearch: true });
      // no-cache: skip GitHub Pages' 10-minute HTTP cache when revalidating
      const fresh = fetch(req.mode === "navigate" ? key : req, { cache: "no-cache" })
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        });
      if (cached) {
        e.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      return fresh;
    }),
  );
});
