"use strict";
/**
 * fine-pwa / sw.ts — the worker half. Compiles (types stripped, otherwise as-is) to
 * dist/sw.js, a classic service-worker script.
 *
 * Generic and version-agnostic: registered once at a stable URL ("<app-root>/sw.js?lib=<n>")
 * and never regenerated. Site versions exist only as a component of a cache name.
 *
 * Storage model — every name begins with `CACHE_PREFIX`:
 *
 *   pwa:<scope>:<site-version>   one cache per version — every precached response
 *   pwa:<scope>:state           a single JSON entry "state" -> { current, next, previous }
 *
 * An update is "fill a new version cache, then move a pointer" — no waiting worker, no
 * skipWaiting dance. The page either moves `current` at once, or parks the version as `next`,
 * which the next navigation promotes. The page drives every exchange through the {@link Rpc}
 * interface (see `serveRpc`); the worker sends nothing on its own.
 */
(() => {
    "use strict";
    // The DOM lib types bare `self` as a `Window`; cast it to the service-worker scope to reach
    // `registration`, `clients`, `skipWaiting()` and the ExtendableEvent listener overloads.
    // (Emits as `const sw = self;`.)
    const sw = self;
    /**
     * Path the registration is scoped to — the app root, always ends with "/".
     * @example "/"        // root deploy
     * @example "/app/"    // sub-folder deploy
     */
    const SCOPE_PATH = new URL(sw.registration.scope).pathname;
    /** Absolute shell URL — identical to the registration scope. e.g. "https://example.com/app/". */
    const SHELL_URL = sw.registration.scope;
    /** Prefix shared by every cache this app owns. e.g. "pwa:/app/:". */
    const CACHE_PREFIX = `pwa:${SCOPE_PATH}:`;
    /** Name of the cache holding the pointer entry. e.g. "pwa:/app/:state". */
    const STATE_CACHE = `${CACHE_PREFIX}state`;
    /**
     * Cache name for one site version.
     * @example versionCache("2026-09-07.a1b2c3") === "pwa:/app/:2026-09-07.a1b2c3"
     */
    function versionCache(version) {
        return `${CACHE_PREFIX}${version}`;
    }
    // =========================================================================
    // Pointer state
    // =========================================================================
    /**
     * Read the pointer. Uses `caches.match` with an explicit `cacheName`, which — unlike
     * `caches.open` — never creates the cache; a torn-down or brand-new worker therefore leaves
     * no empty state cache behind. Returns `{ current: null, previous: null }` when unset.
     */
    async function readPointer() {
        const empty = { current: null, next: null, previous: null };
        try {
            const entry = await caches.match("state", { cacheName: STATE_CACHE });
            return entry ? { ...empty, ...(await entry.json()) } : empty;
        }
        catch {
            return empty;
        }
    }
    /** Overwrite the pointer entry. */
    async function writePointer(pointer) {
        const cache = await caches.open(STATE_CACHE);
        await cache.put("state", new Response(JSON.stringify(pointer), { headers: { "content-type": "application/json" } }));
    }
    /** Persist `pointer` and delete every version cache it no longer references. */
    async function savePointer(pointer) {
        await writePointer(pointer);
        const keep = new Set([STATE_CACHE]);
        for (const version of [pointer.current, pointer.next, pointer.previous]) {
            if (version)
                keep.add(versionCache(version));
        }
        for (const name of await caches.keys()) {
            if (name.startsWith(CACHE_PREFIX) && !keep.has(name))
                await caches.delete(name);
        }
    }
    /**
     * Commit a fully cached `version`. `now` serves it immediately (the old `current` becomes
     * `previous`); otherwise it is parked as `next` for {@link promoteNext}. Idempotent.
     */
    async function commitVersion(version, now) {
        const pointer = await readPointer();
        if (pointer.current === version)
            return;
        if (now) {
            await savePointer({ current: version, next: null, previous: pointer.current });
        }
        else if (pointer.current === null) {
            // Nothing to keep serving yet — a parked version would just never be reached.
            await savePointer({ current: version, next: null, previous: null });
        }
        else if (pointer.next !== version) {
            await savePointer({ ...pointer, next: version });
        }
    }
    /**
     * Called on every navigation: a parked `next` becomes `current` (the launch-time update, as
     * a native app would). Returns the pointer to serve this navigation from.
     */
    async function promoteNext() {
        const pointer = await readPointer();
        if (!pointer.next)
            return pointer;
        const promoted = { current: pointer.next, next: null, previous: pointer.current };
        await savePointer(promoted);
        return promoted;
    }
    // =========================================================================
    // A pull stream you can push into (bridges `fillCache`'s callback to `Rpc.precache`)
    // =========================================================================
    function makeStream() {
        const queue = [];
        let ended = false;
        let failure = null;
        let waiting = null;
        function wake() {
            if (!waiting)
                return;
            if (failure)
                waiting.reject(failure.error);
            else if (queue.length)
                waiting.resolve(queue.shift());
            else if (ended)
                waiting.resolve(null);
            else
                return;
            waiting = null;
        }
        return {
            push(value) {
                queue.push(value);
                wake();
            },
            end() {
                ended = true;
                wake();
            },
            fail(error) {
                failure = { error };
                wake();
            },
            pull() {
                return new Promise((resolve, reject) => {
                    waiting = { resolve, reject };
                    wake();
                });
            },
        };
    }
    // =========================================================================
    // Precache — strict / all-or-nothing
    // =========================================================================
    /**
     * Fetch every not-yet-cached URL into `versionCache(version)`, reporting one
     * `{ done, total }` frame per step to `onFrame`. Same-origin responses must be ok (2xx);
     * cross-origin ones are fetched `no-cors` and stored opaque, best-effort.
     * @returns the URLs that could not be fetched
     */
    async function fillCache(version, urls, onFrame) {
        const cache = await caches.open(versionCache(version));
        const present = new Set((await cache.keys()).map((request) => request.url));
        const missing = urls.filter((url) => !present.has(url));
        const total = urls.length;
        let done = total - missing.length;
        const failed = [];
        onFrame({ done, total });
        for (const url of missing) {
            let sameOrigin;
            try {
                sameOrigin = new URL(url).origin === location.origin;
            }
            catch {
                failed.push(url);
                continue;
            }
            const request = new Request(url, sameOrigin ? { cache: "reload" } : { mode: "no-cors", cache: "reload" });
            try {
                const response = await fetch(request);
                if (sameOrigin && !response.ok) {
                    failed.push(url);
                    continue;
                }
                await cache.put(url, response);
                onFrame({ done: ++done, total });
            }
            catch {
                failed.push(url);
            }
        }
        return failed;
    }
    // =========================================================================
    // RPC — the worker-side implementation of the shared `Rpc` interface
    // =========================================================================
    /**
     * Wire `impl` up to `message` events. `{ method, req }` in; each streamed method frame goes
     * back as `{ frame }`, a plain result as `{ ok: true, value }`, and any rejection as
     * `{ ok: false, error }`.
     */
    function serveRpc(impl) {
        sw.addEventListener("message", (event) => {
            const port = event.ports[0];
            const msg = event.data;
            if (!port || !msg || !msg.method)
                return;
            const method = impl[msg.method];
            event.waitUntil((async () => {
                try {
                    const result = method(msg.req);
                    if (typeof result === "function") {
                        const pull = result;
                        for (let frame; (frame = await pull()) !== null;)
                            port.postMessage({ frame });
                        port.postMessage({ ok: true });
                    }
                    else {
                        port.postMessage({ ok: true, value: await result });
                    }
                }
                catch (err) {
                    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
                }
            })());
        });
    }
    /** The worker-side implementation of {@link Rpc}; `main` hands it to `serveRpc`. */
    const rpcImpl = {
        status() {
            return readPointer();
        },
        precache({ version, urls }) {
            const stream = makeStream();
            void (async () => {
                try {
                    const failed = await fillCache(version, urls, stream.push);
                    if (failed.length > 0) {
                        const { current, next, previous } = await readPointer();
                        if (version !== current && version !== next && version !== previous) {
                            await caches.delete(versionCache(version));
                        }
                        throw new Error(`precache failed for ${failed.length} url(s): ${failed.join(", ")}`);
                    }
                    stream.end();
                }
                catch (err) {
                    stream.fail(err);
                }
            })();
            return stream.pull;
        },
        async commit({ version, now }) {
            await commitVersion(version, now);
        },
    };
    // =========================================================================
    // Serving
    // =========================================================================
    /**
     * Return `shellResponse` unchanged for a navigation to the app root, or with
     * `<base href="<scope>">` spliced into its `<head>` for a deeper path, so the shell's
     * document-relative URLs still resolve.
     * @param shellResponse a cached 200 HTML response
     * @param url           the navigation target
     */
    async function withInjectedBase(shellResponse, url) {
        if (url.pathname === SCOPE_PATH)
            return shellResponse;
        let html = await shellResponse.text();
        if (!html.includes("<base ")) {
            html = html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}<base href="${SCOPE_PATH}">`);
        }
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    /** A minimal 503 page for a cold navigation with nothing cached yet. */
    function offlineResponse() {
        return new Response("<!doctype html><meta charset=utf-8><title>Offline</title><h1>Offline</h1>", { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    /**
     * Navigation strategy: an exact cached entry first (so a multi-page site that prefetched
     * its pages serves each directly), otherwise the cached shell via {@link withInjectedBase},
     * then the network, then the previous version's shell, then {@link offlineResponse}. An SPA
     * prefetches no HTML, so every route lands on the shell.
     */
    async function serveNavigation(request, url, current, previous) {
        const exact = await caches.match(request, {
            cacheName: versionCache(current),
            ignoreSearch: true,
        });
        if (exact)
            return exact;
        const shell = await caches.match(SHELL_URL, { cacheName: versionCache(current) });
        if (shell)
            return withInjectedBase(shell, url);
        try {
            return await fetch(request);
        }
        catch {
            const previousShell = previous
                ? await caches.match(SHELL_URL, { cacheName: versionCache(previous) })
                : undefined;
            return previousShell ? withInjectedBase(previousShell, url) : offlineResponse();
        }
    }
    /**
     * Answer one request from the live version's cache, falling back to the previous version
     * and then the network. `caches.match` with a `cacheName` is used throughout — it never
     * creates a cache, so serving can never resurrect one that a teardown (`?pwa=off`, dev mode) just deleted, and
     * nothing is cached opportunistically.
     */
    async function serve(request, url) {
        const isNavigation = request.mode === "navigate";
        const { current, previous } = isNavigation ? await promoteNext() : await readPointer();
        if (!current)
            return fetch(request);
        if (isNavigation) {
            return serveNavigation(request, url, current, previous);
        }
        const live = (await caches.match(url.href, { cacheName: versionCache(current) })) ||
            (await caches.match(request, { cacheName: versionCache(current), ignoreSearch: true }));
        if (live)
            return live;
        if (previous) {
            const stale = (await caches.match(url.href, { cacheName: versionCache(previous) })) ||
                (await caches.match(request, { cacheName: versionCache(previous), ignoreSearch: true }));
            if (stale)
                return stale;
        }
        return fetch(request);
    }
    /**
     * `fetch` listener. Handles only same-origin GETs inside the scope, skips a `Range` request
     * and the page's `?_pwa=` update-check fetch (which must reach the network); everything else
     * is left to the network. Delegates to {@link serve}.
     */
    function onFetch(event) {
        const { request } = event;
        if (request.method !== "GET")
            return;
        let url;
        try {
            url = new URL(request.url);
        }
        catch {
            return;
        }
        if (url.origin !== location.origin)
            return;
        if (!url.pathname.startsWith(SCOPE_PATH))
            return;
        if (url.searchParams.has("_pwa"))
            return;
        if (request.headers.has("range"))
            return;
        event.respondWith(serve(request, url));
    }
    // =========================================================================
    // Entry point
    // =========================================================================
    /** Register the RPC handler and the lifecycle / fetch listeners. */
    function main() {
        serveRpc(rpcImpl);
        sw.addEventListener("install", () => {
            void sw.skipWaiting();
        });
        sw.addEventListener("activate", (event) => {
            event.waitUntil(sw.clients.claim());
        });
        sw.addEventListener("fetch", onFetch);
    }
    main();
})();
