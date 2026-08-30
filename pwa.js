/*
 * Dear Diary - PWA glue (plain JS, no build step).
 *
 * Loaded as a prod-only <head> script (fine-spa/build.gradle.kts's webExtraHeadScripts, a
 * deliberate divergence from ClientDevMain.VENDOR_SCRIPTS - a service worker would shadow
 * :watch's recompiled JS/CSS in dev). Registers ./sw.js (document-relative, so the whole
 * bundle is folder-agnostic - works at the site root or in any subfolder), tracks
 * install/update availability, and exposes globals the TeaVM side reads via
 * app.services.PwaService:
 *
 *   window.finePwaState()  -> "none" | "install" | "update"
 *   window.finePwaAction() -> show the install prompt, or apply a waiting update
 *
 * and dispatches a plain "finepwachange" Event on window whenever finePwaState() may have
 * changed (app.services.PwaService.CHANGE_EVENT; LoginJs listens with an EventListener). No
 * callback global - a @JSFunctor round-trip is fragile under this TeaVM/Closure build.
 */
(function () {
  "use strict";

  var deferredPrompt = null;   // a stashed beforeinstallprompt event
  var updateWaiting = null;    // a ServiceWorker in "installed" state, waiting to activate

  function currentState() {
    if (updateWaiting) return "update";
    if (deferredPrompt) return "install";
    return "none";
  }

  function notify() {
    try { window.dispatchEvent(new Event("finepwachange")); } catch (e) { /* non-fatal */ }
  }

  window["finePwaState"] = function () { return currentState(); };

  // Returns the resulting state - the Java side (PwaService.act) uses the return value, which
  // is what keeps Closure ADVANCED from dead-code-eliminating the call.
  window["finePwaAction"] = function () {
    if (updateWaiting) {
      updateWaiting.postMessage("SKIP_WAITING");   // -> sw.js self.skipWaiting() -> controllerchange -> reload
      return currentState();
    }
    if (deferredPrompt) {
      var evt = deferredPrompt;
      deferredPrompt = null;
      evt.prompt();
      notify();
    }
    return currentState();
  };

  // Fires before the TeaVM bundle runs, so it must be caught here in the head script.
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    notify();
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    notify();
  });

  // theme-color, kept out of the shared FineRoot <head>
  try {
    var meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#0366d6");
    document.head.appendChild(meta);
  } catch (e) { /* non-fatal */ }

  if (!("serviceWorker" in navigator)) return;

  var reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  function watchInstalling(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", function () {
      // "installed" while a controller already exists == an update (not the very first install).
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        updateWaiting = worker;
        notify();
      }
    });
  }

  window.addEventListener("load", function () {
    var version = window["site_version"] || "dev";
    // "sw.js", not "/sw.js": resolves against the document base (the <base href> the shell's
    // inline bootstrap installed), so the SW scope is the app's mount folder, not the origin.
    navigator.serviceWorker.register("sw.js?v=" + encodeURIComponent(version)).then(function (reg) {
      if (reg.waiting && navigator.serviceWorker.controller) {
        updateWaiting = reg.waiting;
        notify();
      }
      watchInstalling(reg.installing);
      reg.addEventListener("updatefound", function () { watchInstalling(reg.installing); });
    }).catch(function (e) {
      console.error("service worker registration failed", e);
    });
  });
})();
