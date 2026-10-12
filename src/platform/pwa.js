// Service-worker registration and the update flow.
// - The first install ends with clients.claim(), which fires `controllerchange` although nothing was
//   updated: it is ignored because only applyUpdate() arms the reload.
// - An update is "ready" when a worker is waiting AND the page is already controlled.
// - A resumed Home Screen app never navigates, so updates are checked on visibility → visible and hourly.
// - Loop guard: applyUpdate() refuses (returns false) for a while after an update reload in this tab.
// Nothing touches window/document at import time.

const RELOAD_KEY = 'dropcat:sw-reload-at';
const LOOP_GUARD_MS = 15000;
const CHECK_EVERY_MS = 60 * 60 * 1000;

function reloadedRecently() {
  try {
    const t = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    return Date.now() - t < LOOP_GUARD_MS;
  } catch {
    return false;
  }
}

function markReload() {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

function afterLoad() {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => window.addEventListener('load', () => resolve(), { once: true }));
}

/**
 * Registers ./sw.js (after `load`) and wires the update flow.
 * App policy (implemented by the caller): if an update is ready before the first interaction after launch,
 * apply it immediately; otherwise show the "Update" pill and apply it when the next game starts.
 * @param {{ onUpdateReady?: (api: object) => void, beforeReload?: () => void }} [options]
 *   onUpdateReady: called once per waiting version, never before this promise has resolved; it also receives
 *   the API object. beforeReload: called right before the update reload (save the game there!).
 * @returns {Promise<{ applyUpdate(): boolean, hasUpdate(): boolean, check(): void } | null>}
 *   null when service workers are unavailable (no support, insecure context such as http://192.168.x.x) or
 *   registration failed. applyUpdate() → true when SKIP_WAITING was sent (the page reloads on controllerchange),
 *   false when nothing is waiting or the loop guard refused (keep showing the "Update" pill then).
 */
export function initServiceWorker({ onUpdateReady, beforeReload } = {}) {
  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return Promise.resolve(null);
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  return afterLoad()
    .then(() => navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }))
    .then((reg) => (reg ? wire(reg, onUpdateReady, beforeReload) : null))
    .catch((err) => {
      console.warn('[dropcat] service worker unavailable:', err);
      return null;
    });
}

function wire(reg, onUpdateReady, beforeReload) {
  const sw = navigator.serviceWorker;
  let requested = false; // set only by applyUpdate()
  let reloading = false;
  let announced = null; // the waiting worker already reported

  const hasUpdate = () => !!(reg.waiting && sw.controller);

  const check = () => {
    try {
      reg.update().then(() => announce(), () => {}); // offline or 404: try again later
    } catch {
      // registration gone
    }
  };

  const api = {
    /** Activates the waiting version; the page reloads once it takes control. */
    applyUpdate() {
      const waiting = reg.waiting;
      if (!waiting || !sw.controller || reloading || reloadedRecently()) return false;
      requested = true;
      try {
        waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch {
        requested = false;
        return false;
      }
      return true;
    },
    hasUpdate,
    /** Checks the server for a new version now (also runs on visibility → visible and hourly). */
    check,
  };

  function announce() {
    if (!hasUpdate() || announced === reg.waiting) return;
    announced = reg.waiting;
    try {
      if (onUpdateReady) onUpdateReady(api);
    } catch (err) {
      console.error(err);
    }
  }

  const track = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') announce();
    });
  };

  track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));

  sw.addEventListener('controllerchange', () => {
    if (!requested || reloading) return; // first install (clients.claim) or another tab's update
    reloading = true;
    markReload();
    try {
      if (beforeReload) beforeReload();
    } catch (err) {
      console.error(err);
    }
    location.reload();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  setInterval(check, CHECK_EVERY_MS);

  // A version downloaded earlier may already be waiting. Report it only after the caller has the API
  // (the returned promise resolves first), so onUpdateReady can apply it right away.
  setTimeout(announce, 0);

  return api;
}
