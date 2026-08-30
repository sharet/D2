"use strict";

var VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
var CACHE = "dear-diary-" + VERSION;

var ASSET_PREFIXES = ["/js/", "/css/", "/static/", "/icons/"];
var ASSET_EXACT = ["/manifest.json", "/pwa.js", "/favicon.ico", "/apple-touch-icon.png"];
var EXTRA_PRECACHE = ASSET_EXACT.concat([
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"
]);

function isAsset(pathname) {
  for (var i = 0; i < ASSET_EXACT.length; i++) if (pathname === ASSET_EXACT[i]) return true;
  for (var j = 0; j < ASSET_PREFIXES.length; j++) if (pathname.indexOf(ASSET_PREFIXES[j]) === 0) return true;
  return false;
}

self.addEventListener("install", function (e) {
  e.waitUntil((async function () {
    var cache = await caches.open(CACHE);
    var res = await fetch("/", { cache: "reload" });
    await cache.put("/", res.clone());

    // Scrape the shell's own root-relative asset URLs - no coupling to the build's hash names.
    var html = await res.text();
    var want = {};
    var re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
    var m;
    while ((m = re.exec(html))) {
      var u = m[1].split("?")[0];
      if (u.indexOf("/") === 0 && isAsset(u)) want[u] = true;
    }
    EXTRA_PRECACHE.forEach(function (u) { want[u] = true; });

    await Promise.all(Object.keys(want).map(function (u) {
      return cache.add(u).catch(function () { /* best-effort - a missing extra must not fail install */ });
    }));
    // deliberately NOT self.skipWaiting() here: the waiting worker is what drives the Update button.
  })());
});

self.addEventListener("activate", function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (k !== CACHE && k.indexOf("dear-diary-") === 0) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener("message", function (e) {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations (incl. SPA deep links served index.html by StaticSpaServer): network first,
  // fall back to the cached shell so a cold offline load still boots.
  if (req.mode === "navigate") {
    e.respondWith((async function () {
      var cache = await caches.open(CACHE);
      try {
        var net = await fetch(req);
        cache.put("/", net.clone());
        return net;
      } catch (err) {
        var cached = await cache.match("/");
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  if (!isAsset(url.pathname)) return;

  // Content-hashed assets (and rarely-changing icons): cache first, fill on miss.
  e.respondWith((async function () {
    var cache = await caches.open(CACHE);
    var hit = await cache.match(url.pathname);
    if (hit) return hit;
    var net = await fetch(req);
    if (net && net.ok) cache.put(url.pathname, net.clone());
    return net;
  })());
});
