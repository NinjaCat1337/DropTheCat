// Device helpers: platform detection, safe-area insets, touch guards and viewport-change notifications.
// Nothing here touches window/document at import time (importable by Node).

const hasDom = () => typeof window !== 'undefined' && typeof document !== 'undefined';

/**
 * iPhone, iPod or iPad, including iPadOS, which reports a desktop Mac user agent.
 * @returns {boolean}
 */
export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

/**
 * Running as an installed Home Screen / standalone web app (not inside a browser tab).
 * @returns {boolean}
 */
export function isStandalone() {
  try {
    if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
    return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

let probe = null;

/** `?safe=top,right,bottom,left` (CSS px) → insets, or null when the parameter is absent. */
function safeOverride() {
  try {
    const raw = new URLSearchParams(location.search).get('safe');
    if (raw === null) return null;
    const parts = raw.split(',').map((s) => parseFloat(s));
    const at = (i) => (Number.isFinite(parts[i]) && parts[i] > 0 ? parts[i] : 0);
    return { top: at(0), right: at(1), bottom: at(2), left: at(3) };
  } catch {
    return null;
  }
}

/**
 * Safe-area insets in CSS px, measured through a hidden probe element padded with
 * env(safe-area-inset-*). The `?safe=t,r,b,l` URL parameter overrides them (Chrome emulation reports 0).
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
export function readSafeInsets() {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!hasDom()) return zero;
  const override = safeOverride();
  if (override) return override;
  try {
    if (!probe || !probe.isConnected) {
      probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);' +
        'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);';
      (document.body || document.documentElement).appendChild(probe);
    }
    const cs = getComputedStyle(probe);
    const px = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  } catch {
    return zero;
  }
}

/**
 * Stops the browser gestures that fight a drag game. touchstart is cancelled ONLY on the canvas
 * (no loupe, callout, double-tap zoom or tab edge-swipe there; DOM buttons keep their clicks).
 * Document-wide: touchmove is cancelled unless it is a one-finger scroll inside a `.scroll` element;
 * gesturestart/gesturechange/gestureend (pinch) and dblclick are cancelled. contextmenu is cancelled on the canvas.
 * @param {HTMLCanvasElement} canvas
 * @returns {() => void} removes the guards
 */
export function installTouchGuards(canvas) {
  if (!hasDom() || !canvas) return () => {};
  const active = { passive: false };
  const prevent = (e) => {
    if (e.cancelable) e.preventDefault();
  };
  const onTouchMove = (e) => {
    const t = e.target;
    const inScroll = t && typeof t.closest === 'function' && t.closest('.scroll');
    if (!inScroll || (e.touches && e.touches.length > 1)) prevent(e);
  };
  const offs = [];
  const on = (target, type, fn) => {
    target.addEventListener(type, fn, active);
    offs.push(() => target.removeEventListener(type, fn, active));
  };
  on(canvas, 'touchstart', prevent);
  on(canvas, 'contextmenu', prevent);
  on(document, 'touchmove', onTouchMove);
  on(document, 'gesturestart', prevent);
  on(document, 'gesturechange', prevent);
  on(document, 'gestureend', prevent);
  on(document, 'dblclick', prevent);
  return () => offs.forEach((off) => off());
}

/**
 * Calls `cb(metrics)` whenever the viewport may have changed: ResizeObserver on `root`, window resize,
 * orientation change, pageshow and visibility → visible, plus a re-check ~350 ms after installation and
 * after each orientation change / pageshow / visible (iOS reports some sizes late). Calls are coalesced per
 * animation frame (one resize may still give two calls with the same metrics). metrics = { width, height }
 * of root (CSS px), dpr = min(devicePixelRatio, 3), safe = readSafeInsets().
 * @param {Element} root
 * @param {(m: { width: number, height: number, dpr: number, safe: { top: number, right: number, bottom: number, left: number } }) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onViewportChange(root, cb) {
  if (!hasDom() || typeof cb !== 'function') return () => {};
  let raf = 0;
  let disposed = false;
  const timers = new Set();
  const offs = [];

  const run = () => {
    raf = 0;
    if (disposed) return;
    const r = root && root.getBoundingClientRect ? root.getBoundingClientRect() : { width: innerWidth, height: innerHeight };
    cb({ width: r.width, height: r.height, dpr: Math.min(window.devicePixelRatio || 1, 3), safe: readSafeInsets() });
  };
  const schedule = () => {
    if (!raf && !disposed) raf = requestAnimationFrame(run);
  };
  const scheduleWithRecheck = () => {
    schedule();
    const id = setTimeout(() => {
      timers.delete(id);
      schedule();
    }, 350);
    timers.add(id);
  };
  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    offs.push(() => target.removeEventListener(type, fn));
  };

  if (root && typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    offs.push(() => ro.disconnect());
  }
  on(window, 'resize', schedule);
  if (screen.orientation && typeof screen.orientation.addEventListener === 'function') {
    on(screen.orientation, 'change', scheduleWithRecheck);
  } else {
    on(window, 'orientationchange', scheduleWithRecheck);
  }
  on(window, 'pageshow', scheduleWithRecheck);
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleWithRecheck();
  });
  scheduleWithRecheck();

  return () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    timers.forEach((id) => clearTimeout(id));
    timers.clear();
    offs.forEach((off) => off());
  };
}
