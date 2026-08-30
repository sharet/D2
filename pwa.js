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
    navigator.serviceWorker.register("/sw.js?v=" + encodeURIComponent(version)).then(function (reg) {
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
