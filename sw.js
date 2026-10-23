// Offline shell: serve same-origin files from cache, refresh them in the
// background so the next load is current. Shell files are refreshed together
// so index.html and app.js never mix versions. Bump CACHE only to drop old files.
const CACHE = "note-v1";
const SHELL = [
  "./",
  "app.js",
  "draw.js",
  "manifest.json",
  "fonts/VictorMono.woff2",
  "fonts/SourceSans3.woff2",
  "fonts/SourceSerif4.woff2",
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

// Swap the shell only once every file downloaded
async function refreshShell() {
  const res = await Promise.all(SHELL.map((u) => fetch(u, { cache: "no-cache" })));
  if (!res.every((r) => r.ok)) return;
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map((u, i) => cache.put(u, res[i])));
}

const shellUrls = new Set(SHELL.map((u) => new URL(u, location).href));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  // Sign-in redirects (worker.js) must reach the network, never the shell
  if (url.pathname.startsWith("/auth/")) return;
  // All navigations (?id=…) render the same page
  const key = req.mode === "navigate" ? new URL("./", location).href : req;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key, { ignoreSearch: true });
      if (req.mode === "navigate") e.waitUntil(refreshShell().catch(() => {}));
      if (cached) {
        if (!shellUrls.has(url.origin + url.pathname)) e.waitUntil(update(cache, req).catch(() => {}));
        return cached;
      }
      return update(cache, req.mode === "navigate" ? new Request(key) : req);
    }),
  );
});

// no-cache: skip any HTTP cache when revalidating
function update(cache, req) {
  return fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
}
