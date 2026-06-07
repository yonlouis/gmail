const CACHE = "gmail-agent-v1";
const ASSETS = ["/", "/index.html"];

self.addEventListener("install", e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(ASSETS))
));

self.addEventListener("fetch", e => {
  if (e.request.url.includes("/agent/run") || e.request.url.includes("/auth/")) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
