"use strict";
/**
 * fine-pwa / pwa.ts — the page half of a two-file, build-step-free PWA helper.
 * Compiles (types stripped, otherwise as-is) to dist/pwa.js, a classic browser script.
 *
 * Load once per HTML entry point, from the directory that is your app's root:
 *
 *     <script src="pwa.js?v=<site-version>" data-manifest="manifest.json"></script>
 *
 * `<site-version>` is any token that changes when your assets change (a build hash, a
 * timestamp, a release tag). It is the sole update trigger. Omit "?v=" for dev mode: nothing
 * is cached and any previous installation for this directory is removed.
 *
 * The public API is `window.pwa`: a synchronous `state` snapshot you render from, and
 * `subscribe()` to hear about changes. There is nothing to poll.
 *
 *     pwa.subscribe((s) => render(s));        // called now, and on every change
 *     installButton.onclick = () => pwa.install();
 *     updateButton.onclick = () => pwa.update(); // when typeof s.nextVersion === "string"
 */
(() => {
    "use strict";
    /**
     * Extracts the set of URLs an app-shell document depends on for offline use. One instance,
     * bound to the app root; feed it the live `document` ({@link parseDocument}) or the HTML of a
     * freshly fetched shell ({@link parseHtml}).
     *
     * Scans `<script src>`, the media/icon elements in {@link HtmlParser.URL_SOURCES},
     * `<link>` whose rel is in {@link HtmlParser.CACHEABLE_LINK_RELS}, `srcset` candidates,
     * `<use href>`, and `url(...)` inside inline `<style>` / `style=`. Elements carrying
     * `data-pwa="skip"` (or nested under one) are ignored. The result always contains the shell
     * URL itself and the document's own pwa.js.
     */
    class HtmlParser {
        /** @param base absolute URL the shell is served from; relative refs resolve against it. */
        constructor(base) {
            this.base = base;
        }
        /**
         * Dependency set of a fetched shell's HTML.
         * @param html raw HTML the caller has already judged plausible (2xx, same-origin, HTML)
         */
        parseHtml(html) {
            return this.parseDocument(new DOMParser().parseFromString(html, "text/html"));
        }
        /**
         * Dependency set of a shell document.
         * @param doc a live `document`, or a `DOMParser` result
         * @returns `version` — the `?v=` of the document's pwa.js tag, or `null`; `urls` — sorted,
         *          de-duplicated absolute URLs, hash stripped
         */
        parseDocument(doc) {
            const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
            const resolveAgainst = baseHref ? new URL(baseHref, this.base).href : this.base;
            const urls = new Set();
            /** Resolve `raw` against `resolveAgainst` and keep it, unless it is non-cacheable. */
            function addUrl(raw) {
                if (!raw)
                    return;
                const value = raw.trim();
                if (value === "" || value.startsWith("#"))
                    return;
                if (/^(?:data|blob|javascript|mailto|tel|about|ws|wss):/i.test(value))
                    return;
                let resolved;
                try {
                    resolved = new URL(value, resolveAgainst);
                }
                catch {
                    return;
                }
                resolved.hash = "";
                urls.add(resolved.href);
            }
            /** Add the URL of every candidate in a comma-separated `srcset`. */
            function addSrcset(srcset) {
                for (const candidate of (srcset ?? "").split(",")) {
                    const url = candidate.trim().split(/\s+/, 1)[0];
                    if (url)
                        addUrl(url);
                }
            }
            for (const [selector, attribute] of HtmlParser.URL_SOURCES) {
                for (const el of doc.querySelectorAll(selector)) {
                    if (!HtmlParser.isExcluded(el))
                        addUrl(el.getAttribute(attribute));
                }
            }
            for (const el of doc.querySelectorAll("link[href]")) {
                if (HtmlParser.isExcluded(el))
                    continue;
                const rels = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
                if (rels.some((rel) => HtmlParser.CACHEABLE_LINK_RELS.has(rel))) {
                    addUrl(el.getAttribute("href"));
                }
            }
            for (const el of doc.querySelectorAll("img[srcset], source[srcset]")) {
                if (!HtmlParser.isExcluded(el))
                    addSrcset(el.getAttribute("srcset"));
            }
            for (const el of doc.querySelectorAll("use")) {
                if (!HtmlParser.isExcluded(el)) {
                    addUrl(el.getAttribute("href") ?? el.getAttribute("xlink:href"));
                }
            }
            for (const el of doc.querySelectorAll("style")) {
                if (!HtmlParser.isExcluded(el)) {
                    HtmlParser.cssUrlTargets(el.textContent ?? "").forEach(addUrl);
                }
            }
            for (const el of doc.querySelectorAll("[style]")) {
                if (!HtmlParser.isExcluded(el)) {
                    HtmlParser.cssUrlTargets(el.getAttribute("style") ?? "").forEach(addUrl);
                }
            }
            // The shell is always part of its own dependency set.
            urls.add(this.base);
            // Read the version declared by the document's own pwa.js.
            let version = null;
            for (const el of doc.querySelectorAll("script[src]")) {
                const src = el.getAttribute("src");
                if (src && /(?:^|\/)pwa\.js(?:\?|$)/.test(src)) {
                    const pwaUrl = new URL(src, resolveAgainst);
                    version = pwaUrl.searchParams.get("v");
                    urls.add(pwaUrl.href);
                }
            }
            return { version, urls: [...urls].sort() };
        }
        /** Whether `el`, or any ancestor, opts out of caching via `data-pwa="skip"`. */
        static isExcluded(el) {
            return el.closest('[data-pwa="skip"]') !== null;
        }
        /** Every `url(...)` target inside a chunk of CSS text (raw, unresolved). */
        static cssUrlTargets(css) {
            const targets = [];
            const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
            let match;
            while ((match = pattern.exec(css)) !== null)
                targets.push(match[2]);
            return targets;
        }
    }
    /** `[selector, attribute]` pairs naming a fetchable sub-resource on a matched element. */
    HtmlParser.URL_SOURCES = [
        ["script[src]", "src"],
        ["img[src]", "src"],
        ["source[src]", "src"],
        ["audio[src]", "src"],
        ["video[poster]", "poster"],
        ["object[data]", "data"],
        ["embed[src]", "src"],
        ["input[type=image][src]", "src"],
    ];
    /**
     * `<link rel="…">` values whose `href` is precached. `prefetch` is the mechanism for
     * pulling in resources the current page does not itself use (CSS fonts, manifest icons,
     * lazy chunks, other pages).
     */
    HtmlParser.CACHEABLE_LINK_RELS = new Set([
        "stylesheet", "icon", "apple-touch-icon", "mask-icon",
        "manifest", "preload", "prefetch", "modulepreload",
    ]);
    // ==========================================================================
    // Configuration — everything derived from the outside world, resolved once.
    // ==========================================================================
    /**
     * Everything pwa.js derives from `document.currentScript`, `location` and browser feature
     * detection. Build one with {@link Config.fromDocument}; the raw intermediates (the parsed
     * script URL, the cache-name prefix, the lib version) stay private.
     */
    class Config {
        constructor(scriptSrc, manifestAttr) {
            // `.src` (already resolved), not the raw attribute: a worker-served deep-link shell
            // carries an injected `<base href>`, and resolving against `location` would misplace
            // the whole app.
            const selfUrl = new URL(scriptSrc, document.baseURI);
            this.manifest = manifestAttr ? new URL(manifestAttr, document.baseURI).href : null;
            this.base = new URL("./", selfUrl).href;
            this.basePath = new URL(this.base).pathname;
            this.cachePrefix = `pwa:${this.basePath}:`;
            this.version = selfUrl.searchParams.get("v");
            this.workerUrl = new URL(`sw.js?lib=${Config.LIB_VERSION}`, this.base).href;
            this.off = /(?:^|[?&])pwa=off(?:[&=]|$)/.test(location.search);
            this.supported =
                "serviceWorker" in navigator &&
                    typeof caches !== "undefined" &&
                    window.isSecureContext === true;
            this.active = this.supported && this.version !== null && !this.off;
        }
        /**
         * From the running `document.currentScript`.
         * @returns `null` when pwa.js was not loaded as a classic `<script src>`
         */
        static fromDocument() {
            const el = document.currentScript;
            if (!el)
                return null;
            return new Config(el.src || el.getAttribute("src") || "", el.getAttribute("data-manifest"));
        }
        /** Whether `cacheName` is one of this app's Cache Storage entries. */
        ownsCache(cacheName) {
            return cacheName.startsWith(this.cachePrefix);
        }
        /** Whether a service-worker registration `scope` belongs to this app. */
        ownsRegistration(workerScope) {
            return new URL(workerScope).pathname === this.basePath;
        }
    }
    /**
     * Protocol version of the pwa.js + sw.js pair (see sw.js "?lib="). Bumping it re-points
     * the registration at a "new" script URL -> a normal service-worker byte update.
     */
    Config.LIB_VERSION = "1";
    const resolvedConfig = Config.fromDocument();
    if (!resolvedConfig) {
        console.warn("[pwa] document.currentScript is null — load pwa.js as a classic, " +
            "non-async <script src>. Aborting.");
        return;
    }
    // Bound to a non-null type so the hoisted function declarations below (which control-flow
    // analysis does not see the guard above) can read it without a null check.
    const config = resolvedConfig;
    const scanner = new HtmlParser(config.base);
    // ==========================================================================
    // State — one mutable object, one listener set, one `set()` that notifies
    // ==========================================================================
    /**
     * Everything `pwa.state` reports except `install`, which is derived from live browser facts.
     * A page the worker controls was served from its current cache, so its own version is the
     * current one — reported at once, confirmed by the first `status()`.
     */
    const stored = {
        current: config.active && navigator.serviceWorker.controller ? config.version : null,
        next: null,
        durable: false,
    };
    const listeners = new Set();
    /**
     * The most recent `beforeinstallprompt` event, kept for `install()`. `null` until the
     * browser fires one (Chromium only), and again once the prompt has been used.
     */
    let deferredInstallPrompt = null;
    /** Whether the page is running as an installed app. */
    function isStandalone() {
        return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    }
    /** The browser that has no install dialog and needs the app to show instructions, if any. */
    function detectPlatform() {
        const ua = navigator.userAgent;
        const touchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
        if (/iPhone|iPad|iPod/.test(ua) || touchMac)
            return "ios";
        if (/Android/.test(ua) && /Firefox\//.test(ua))
            return "android-firefox";
        if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(ua)) {
            return "macos-safari";
        }
        return null;
    }
    const platform = detectPlatform();
    /** The `install` field: derived from the browser's live facts plus the offline copy. */
    function installState() {
        if (!config.active)
            return "unavailable";
        if (isStandalone())
            return "installed";
        // iOS cannot be gated on the download: the installed app has its own storage and
        // downloads on its first launch anyway.
        if (platform === "ios")
            return "manual";
        if (typeof stored.current !== "string")
            return "unavailable";
        if (deferredInstallPrompt)
            return "prompt";
        return platform ? "manual" : "unavailable";
    }
    /** A copy of the current state, safe to hand out. */
    function snapshot() {
        return {
            currentVersion: copyDownload(stored.current),
            nextVersion: copyDownload(stored.next),
            install: installState(),
            durable: stored.durable,
        };
    }
    /** A deep copy of one {@link Download}, so a subscriber cannot mutate the store. */
    function copyDownload(download) {
        if (download === null || typeof download === "string")
            return download;
        return "progress" in download
            ? { version: download.version, progress: { ...download.progress } }
            : { ...download };
    }
    /** Apply `patch` and tell every listener. Call with `{}` after a derived fact changed. */
    function set(patch) {
        Object.assign(stored, patch);
        const next = snapshot();
        for (const listener of [...listeners]) {
            try {
                listener(next);
            }
            catch (err) {
                console.error("[pwa] subscriber threw:", err);
            }
        }
    }
    /** An error's message, without the `Error:` prefix `String()` would add (twice, across the RPC). */
    function describe(err) {
        return (err instanceof Error ? err.message : String(err)).replace(/^(Error: )+/, "");
    }
    /** Add the page's `<link rel="manifest">` (once): the browser offers install only after it. */
    function insertManifest() {
        if (!config.manifest || document.querySelector('link[rel="manifest"]'))
            return;
        const link = document.createElement("link");
        link.rel = "manifest";
        link.href = config.manifest;
        document.head.appendChild(link);
    }
    // ==========================================================================
    // Worker RPC — the page-side proxy for the shared `Rpc` interface
    //
    // Each call gets its own MessageChannel: `{ method, req }` out. A plain method replies
    // `{ ok, value } | { ok, error }`; a streaming method sends `{ frame }` per item then a
    // terminal `{ ok: true } | { ok: false, error }`.
    // ==========================================================================
    /** How long to wait for a worker reply / the next stream frame before giving up. */
    const WORKER_TIMEOUT_MS = 180000;
    /** One request → one reply. Rejects on `{ ok: false }` or timeout. */
    function call(worker, method, req) {
        return new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => reject(new Error(`[pwa] worker timed out on ${method}()`)), WORKER_TIMEOUT_MS);
            channel.port1.onmessage = (event) => {
                clearTimeout(timer);
                const reply = event.data;
                if (reply.ok)
                    resolve(reply.value);
                else
                    reject(new Error(reply.error));
            };
            worker.postMessage({ method, req }, [channel.port2]);
        });
    }
    /** A streaming method: `{ frame }` messages queue up; `{ ok: true }` ends, `{ ok: false }` fails. */
    function callStream(worker, method, req) {
        const queue = [];
        let ended = false;
        let failure = null;
        let waiting = null;
        function wake() {
            if (!waiting)
                return;
            if (failure)
                waiting.reject(failure);
            else if (queue.length)
                waiting.resolve(queue.shift());
            else if (ended)
                waiting.resolve(null);
            else
                return;
            waiting = null;
        }
        const channel = new MessageChannel();
        const timer = setTimeout(() => {
            if (!ended && !failure) {
                failure = new Error(`[pwa] ${method}() stream timed out`);
                wake();
            }
        }, WORKER_TIMEOUT_MS);
        channel.port1.onmessage = (event) => {
            const msg = event.data;
            if ("frame" in msg)
                queue.push(msg.frame);
            else if (msg.ok) {
                ended = true;
                clearTimeout(timer);
            }
            else {
                failure = new Error(msg.error);
                clearTimeout(timer);
            }
            wake();
        };
        worker.postMessage({ method, req }, [channel.port2]);
        function pull() {
            return new Promise((resolve, reject) => {
                waiting = { resolve, reject };
                wake();
            });
        }
        return pull;
    }
    /** Typed {@link Rpc} proxy against `worker` — one line per method. */
    function rpc(worker) {
        return {
            status() {
                return call(worker, "status");
            },
            precache(req) {
                return callStream(worker, "precache", req);
            },
            commit(req) {
                return call(worker, "commit", req);
            },
        };
    }
    // ==========================================================================
    // Operations
    // ==========================================================================
    /** The active worker for this scope. Throws if a registration exists but has no active worker. */
    async function activeWorker() {
        const registration = await navigator.serviceWorker.ready;
        if (!registration.active)
            throw new Error("[pwa] registration has no active worker");
        return registration.active;
    }
    /** Register the worker and resolve once it is active. */
    async function registerWorker() {
        await navigator.serviceWorker.register(config.workerUrl);
        return activeWorker();
    }
    /**
     * The version transaction: fill `plan.version`'s cache while mirroring the worker's progress
     * into the `slot` download of the state. The stream's rejection (a strict failure, message naming the URLs)
     * propagates. Serving is unchanged until a `commit`.
     */
    async function precache(worker, plan, slot) {
        const { version } = plan;
        set({ [slot]: { version, progress: { done: 0, total: 0 } } });
        const frames = rpc(worker).precache(plan);
        for (let frame; (frame = await frames()) !== null;) {
            set({ [slot]: { version, progress: { done: frame.done, total: frame.total } } });
        }
    }
    // ==========================================================================
    // Persistent storage
    // ==========================================================================
    /**
     * Record whether storage is durable. With `request`, also ask the browser — only from a
     * user gesture, an install event or an installed launch, never on a plain page load
     * (Firefox would show its permission prompt on arrival).
     */
    async function refreshDurable(request) {
        if (!navigator.storage || !navigator.storage.persisted)
            return;
        let durable = await navigator.storage.persisted();
        if (!durable && request && navigator.storage.persist)
            durable = await navigator.storage.persist();
        if (durable !== stored.durable)
            set({ durable });
    }
    // ==========================================================================
    // Sync — bring this scope to "a complete version is committed, and it is current"
    // ==========================================================================
    /** Minimum gap between update checks triggered by the tab becoming visible again. */
    const CHECK_INTERVAL_MS = 10 * 60 * 1000;
    let syncing = false;
    let lastSync = 0;
    /**
     * Fetch the shell fresh, bypassing the worker via a `?_pwa=` query (which its `fetch`
     * handler ignores). Rejects a non-2xx, a cross-scope redirect (a login page), a non-HTML
     * body, or HTML with no `pwa.js?v=` marker — as `{ error }`.
     */
    async function fetchShell() {
        let response;
        try {
            response = await fetch(`${config.base}?_pwa=${Date.now()}`, { cache: "reload" });
        }
        catch (err) {
            return { error: String(err) };
        }
        if (!response.ok)
            return { error: `http ${response.status}` };
        if (response.redirected &&
            new URL(response.url).pathname !== new URL(config.base).pathname) {
            return { error: "redirected away from shell" };
        }
        if (!(response.headers.get("content-type") ?? "").includes("text/html")) {
            return { error: "shell is not text/html" };
        }
        const html = await response.text();
        if (!/pwa\.js\?v=/.test(html))
            return { error: "no pwa.js?v= marker in fetched shell" };
        const shell = scanner.parseHtml(html);
        if (shell.version === null)
            return { error: "no version in fetched shell" };
        return { version: shell.version, urls: shell.urls };
    }
    /** First install: download this page's own version and serve it. */
    async function firstInstall(worker) {
        const found = scanner.parseDocument(document);
        const version = found.version ?? config.version;
        if (version === null)
            throw new Error("[pwa] no site version to cache");
        await precache(worker, { version, urls: found.urls }, "current");
        await rpc(worker).commit({ version, now: true });
        set({ current: version });
    }
    /**
     * Look for a newer deployment and, if there is one, download and park it (`next`). An
     * unreachable or implausible shell is ignored — being offline is not an error.
     */
    async function checkForUpdate(worker) {
        const pointers = await rpc(worker).status();
        const current = pointers.current;
        if (current === null)
            return;
        if (stored.current !== current)
            set({ current });
        const shell = await fetchShell();
        if ("error" in shell)
            return;
        if (shell.version === current) {
            // Nothing newer deployed; but this tab may be older than what another tab committed.
            set({ next: config.version !== current ? current : null });
            return;
        }
        // This tab already runs the deployed version (it was loaded past the worker, e.g. by a
        // hard reload): serve it now rather than offer an "update" into itself. The server just
        // confirmed it is the newest, so this cannot roll back.
        const now = shell.version === config.version;
        if (now || pointers.next !== shell.version) {
            try {
                await precache(worker, shell, now ? "current" : "next");
                await rpc(worker).commit({ version: shell.version, now });
            }
            catch (err) {
                if (now)
                    set({ current });
                else
                    set({ next: { version: shell.version, error: describe(err) } });
                console.error("[pwa] update failed:", err);
                return;
            }
        }
        set(now ? { current: shell.version, next: null } : { next: shell.version });
    }
    /**
     * Run on boot, when the tab becomes visible, and when the network returns: register the
     * worker, make sure a complete version is committed, ask for persistence when installed,
     * then look for an update. Failures land in the broken download's `{ error }`; the next trigger retries.
     */
    async function sync() {
        if (syncing)
            return;
        syncing = true;
        try {
            const worker = await registerWorker();
            const pointers = await rpc(worker).status();
            if (pointers.current === null)
                await firstInstall(worker);
            insertManifest();
            await refreshDurable(isStandalone());
            await checkForUpdate(worker);
        }
        catch (err) {
            // A failure before anything is committed breaks the first download; after that it is
            // only logged (an update's own failure lands in `next`, inside checkForUpdate).
            if (typeof stored.current !== "string") {
                const version = stored.current?.version ?? config.version ?? "";
                set({ current: { version, error: describe(err) } });
            }
            console.error("[pwa] sync failed:", err);
        }
        finally {
            syncing = false;
            lastSync = Date.now();
        }
    }
    // ==========================================================================
    // Public operations
    // ==========================================================================
    /**
     * Offer installation. Persistence is requested first and *synchronously* — it must ride on
     * the click's user gesture (Firefox prompts for it) — then the browser's install dialog.
     */
    async function install() {
        const state = installState();
        if (state === "manual") {
            void refreshDurable(true);
            return "manual";
        }
        if (state !== "prompt" || !deferredInstallPrompt)
            return "unavailable";
        const prompt = deferredInstallPrompt;
        deferredInstallPrompt = null;
        const durable = refreshDurable(true);
        await prompt.prompt();
        const outcome = (await prompt.userChoice).outcome;
        await durable;
        set({});
        return outcome === "accepted" ? "installed" : "dismissed";
    }
    /** Serve the ready update now, then reload. */
    async function update() {
        if (!config.active || typeof stored.next !== "string")
            return;
        const worker = await activeWorker();
        const { next } = await rpc(worker).status();
        if (next)
            await rpc(worker).commit({ version: next, now: true });
        reloadOnce();
    }
    /**
     * Reload the page — at most once per site version, so a stale server that keeps serving the
     * same version cannot cause a reload loop.
     */
    function reloadOnce() {
        const key = `pwa:reloaded:${config.version}`;
        try {
            if (sessionStorage.getItem(key)) {
                console.warn(`[pwa] already reloaded for "${config.version}" — not looping`);
                return;
            }
            sessionStorage.setItem(key, "1");
        }
        catch {
            /* storage disabled (private mode) — proceed without the guard */
        }
        location.reload();
    }
    /** Remove this app's worker registration and every cache it owns — on load in dev / "?pwa=off" mode. */
    async function teardown() {
        if (!("serviceWorker" in navigator))
            return;
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations
            .filter((registration) => config.ownsRegistration(registration.scope))
            .map((registration) => registration.unregister()));
        if (typeof caches !== "undefined") {
            const names = await caches.keys();
            await Promise.all(names.filter((name) => config.ownsCache(name)).map((name) => caches.delete(name)));
        }
    }
    // ==========================================================================
    // Entry point
    // ==========================================================================
    /** Wire up the browser listeners, kick off `sync()`, and publish `window.pwa`. */
    function main() {
        if (config.active) {
            if (config.manifest && document.querySelector('link[rel="manifest"]')) {
                console.warn("[pwa] the page has a static <link rel=manifest>: install is offered " +
                    "before the offline copy is complete. Use data-manifest on the pwa.js tag.");
            }
            window.addEventListener("beforeinstallprompt", (event) => {
                event.preventDefault();
                deferredInstallPrompt = event;
                set({});
            });
            window.addEventListener("appinstalled", () => {
                deferredInstallPrompt = null;
                set({});
                void refreshDurable(true);
            });
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState !== "visible")
                    return;
                const retryFirst = typeof stored.current !== "string";
                if (retryFirst || Date.now() - lastSync > CHECK_INTERVAL_MS)
                    void sync();
            });
            window.addEventListener("online", () => void sync());
            if (platform === "ios")
                insertManifest();
            void sync();
        }
        else if (!config.supported) {
            console.warn("[pwa] unsupported — needs a service worker, the Cache API and a secure context");
        }
        else {
            console.info("[pwa] disabled (dev / ?pwa=off) — nothing is cached");
            void teardown();
        }
        const api = {
            version: config.version,
            platform,
            get state() { return snapshot(); },
            subscribe(listener) {
                listeners.add(listener);
                listener(snapshot());
                return () => { listeners.delete(listener); };
            },
            install,
            update,
        };
        window.pwa = Object.freeze(api);
    }
    main();
})();
