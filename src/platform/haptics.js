// Haptic feedback. Android: navigator.vibrate. iOS 17.4–26.4: clicking the <label> of a hidden
// <input type="checkbox" switch> toggles the switch, which plays the system haptic. It only works
// synchronously inside a real pointerup/touchend/click handler; iOS 26.5+ ignores programmatic clicks
// (WebKit 309082), which is accepted silently. Nothing touches the DOM at import time; nothing throws.
import { isIOS } from './device.js';

const VIBRATE_MS = { light: 10, medium: 20, heavy: [30, 40, 30] };
const IOS_TICKS = { light: 1, medium: 2, heavy: 3 };
const TICK_GAP_MS = 70;

/**
 * @returns {{ tick(): void, impact(level?: 'light'|'medium'|'heavy'): void, enabled: boolean, readonly supported: boolean }}
 */
export function createHaptics() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const canVibrate = !!nav && typeof nav.vibrate === 'function';
  let canSwitch = false;
  try {
    canSwitch = !canVibrate && isIOS() && typeof HTMLInputElement !== 'undefined' &&
      'switch' in HTMLInputElement.prototype;
  } catch {
    canSwitch = false;
  }
  let enabled = true;
  let label = null;

  const ensureLabel = () => {
    if (label || !canSwitch || typeof document === 'undefined') return label;
    try {
      const host = document.body || document.documentElement;
      if (!host) return null;
      const l = document.createElement('label');
      l.setAttribute('aria-hidden', 'true');
      l.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      const stop = (e) => e.stopPropagation(); // keep these synthetic clicks away from app handlers
      l.addEventListener('click', stop);
      input.addEventListener('click', stop);
      l.appendChild(input);
      host.appendChild(l);
      label = l;
    } catch {
      label = null;
    }
    return label;
  };

  const clickLabel = () => {
    try {
      const l = ensureLabel();
      if (l) l.click();
    } catch {
      // ignore
    }
  };

  const impact = (level = 'medium') => {
    if (!enabled) return;
    const key = Object.prototype.hasOwnProperty.call(IOS_TICKS, level) ? level : 'medium';
    try {
      if (canVibrate) {
        nav.vibrate(VIBRATE_MS[key]);
        return;
      }
      if (!canSwitch) return;
      clickLabel();
      for (let i = 1; i < IOS_TICKS[key]; i++) {
        setTimeout(() => {
          if (enabled) clickLabel();
        }, i * TICK_GAP_MS);
      }
    } catch {
      // ignore
    }
  };

  ensureLabel(); // create it up front when the body exists, so the first tick is cheap

  return {
    /** One light tick. Call synchronously inside pointerup/touchend/click. */
    tick() {
      impact('light');
    },
    /** light = 1 tick (10 ms vibration), medium = 2 ticks (20 ms), heavy = 3 ticks ([30,40,30] ms). */
    impact,
    get enabled() {
      return enabled;
    },
    set enabled(v) {
      enabled = !!v;
    },
    /** True when this device may produce haptics (vibrate API or the iOS switch control). */
    get supported() {
      return canVibrate || canSwitch;
    },
  };
}
