/*
 * Dear Diary - service worker (plain JS, no build step).
 *
 * Registered by pwa.js as "sw.js?v=<site_version>" (document-relative), so the whole bundle is
 * folder-agnostic: SCOPE below is whatever folder the app was deployed into (the site root or
 * any subfolder), discovered at runtime from self.registration.scope. site_version is
 * "<appVersion>.<bundleHash>" (fine.web.build.ClientProdBuildMain), so every prod build changes
 * the ?v= -> the browser installs a fresh worker -> the login page's Install link becomes
 * Update. The worker reads its own ?v= to name its cache; nothing is templated in.
 *
 * Offline model: the app's DATA is already offline-first (IndexedDB via LocalStore). This
 * worker only adds the SHELL - index.html, the hashed JS/CSS bundle, the vendor UMD scripts,
 * the icons. All same-origin, GET, under SCOPE, path-allowlisted: anything else (notably the
 * user-entered WebDAV base used by sync, which also issues PROPFIND/PUT/DELETE) falls straight
 * through to the network untouched.
 */
"use strict";

var VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
var CACHE = "dear-diary-" + VERSION;

// SHELL_URL: absolute, e.g. "https://site/notes/" - always ends with "/". SCOPE: just its
// pathname ("/notes/"), for same-origin path comparisons.
var SHELL_URL = self.registration.scope;
var SCOPE = new URL(SHELL_URL).pathname;

var ASSET_DIRS = ["js/", "css/", "static/", "icons/"];
var ASSET_FILES = ["manifest.json", "pwa.js", "favicon.ico", "apple-touch-icon.png"];
var EXTRA_PRECACHE = ASSET_FILES.concat([
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"
]);

function scoped(rel) { return SCOPE + rel; }

function isAsset(pathname) {
  if (pathname.indexOf(SCOPE) !== 0) return false;
  var rel = pathname.slice(SCOPE.length);
  for (var i = 0; i < ASSET_FILES.length; i++) if (rel === ASSET_FILES[i]) return true;
  for (var j = 0; j < ASSET_DIRS.length; j++) if (rel.indexOf(ASSET_DIRS[j]) === 0) return true;
  return false;
}

// Serve the cached shell for a navigation, with <base href="SCOPE"> spliced in so a deep-link
// document (e.g. /notes/entry/5) resolves the shell's document-relative asset URLs correctly.
function shellResponse(res) {
  return res.text().then(function (html) {
    if (html.indexOf("<base ") === -1) {
      html = html.replace("<head>", '<head><base href="' + SCOPE + '">');
    }
    return new Response(html, {
      status: res.status,
      statusText: res.statusText,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  });
}

self.addEventListener("install", function (e) {
  e.waitUntil((async function () {
    var cache = await caches.open(CACHE);
    var res = await fetch(SHELL_URL, { cache: "reload" });
    await cache.put(SHELL_URL, res.clone());

    // Scrape the shell's own asset URLs (document-relative) and resolve them against the shell
    // URL - no coupling to the build's hash names.
    var html = await res.text();
    var want = {};
    var re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
    var m;
    while ((m = re.exec(html))) {
      var raw = m[1];
      if (/^[a-z]+:/i.test(raw) || raw.indexOf("//") === 0) continue;   // skip absolute / protocol URLs
      var p = new URL(raw, SHELL_URL + "index.html").pathname;
      if (isAsset(p)) want[p] = true;
    }
    EXTRA_PRECACHE.forEach(function (rel) { want[scoped(rel)] = true; });

    await Promise.all(Object.keys(want).map(function (p) {
      return cache.add(p).catch(function () { /* best-effort - a missing extra must not fail install */ });
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
  if (url.pathname.indexOf(SCOPE) !== 0) return;   // outside the app's folder - leave alone

  // Navigations (incl. SPA deep links): always answer from the cached shell - never from the
  // deep-link URL itself, which the host may not have an SPA fallback for. For a deep link the
  // shell gets <base href="SCOPE"> spliced in so its document-relative assets still resolve.
  // Updates ride in via a whole new worker (pwa.js bumps ?v= each build), not a revalidate here.
  if (req.mode === "navigate") {
    e.respondWith((async function () {
      var cache = await caches.open(CACHE);
      var shell = await cache.match(SHELL_URL);
      if (!shell) {
        // install hasn't finished caching yet - fetch the canonical shell once
        try {
          var net = await fetch(SHELL_URL, { cache: "reload" });
          if (net.ok) { await cache.put(SHELL_URL, net.clone()); shell = net; }
        } catch (e) { /* offline with nothing cached yet */ }
      }
      if (!shell) return fetch(req);
      return url.pathname === SCOPE ? shell : shellResponse(shell);
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
