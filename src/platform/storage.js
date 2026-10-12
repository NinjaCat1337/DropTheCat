// localStorage helpers. Every access is guarded (private mode, blocked storage, quota errors, corrupted
// JSON), so nothing here ever throws. Keys are namespaced: the github.io origin is shared by all projects.
import { isStandalone } from './device.js';

/** localStorage keys used by the app. */
export const KEYS = Object.freeze({
  progress: 'dropcat:progress:v1',
  level: 'dropcat:level:v1',
  settings: 'dropcat:settings:v1',
  hints: 'dropcat:hints:v1',
});

function store() {
  try {
    const ls = globalThis.localStorage;
    return ls && typeof ls.getItem === 'function' ? ls : null;
  } catch {
    return null; // SecurityError when storage is disabled
  }
}

/**
 * Reads a JSON value. Returns `fallback` when the key is missing, storage is unavailable, the JSON is
 * corrupted, the value is null, or (when `fallback` is not null/undefined) the value's type differs
 * from the fallback's (number vs object vs array…).
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
export function loadJSON(key, fallback) {
  try {
    const ls = store();
    const raw = ls ? ls.getItem(key) : null;
    if (raw === null || raw === undefined) return fallback;
    const value = JSON.parse(raw);
    if (value === null || value === undefined) return fallback;
    if (fallback !== null && fallback !== undefined &&
        (typeof value !== typeof fallback || Array.isArray(value) !== Array.isArray(fallback))) {
      return fallback;
    }
    return value;
  } catch {
    return fallback;
  }
}

/**
 * Stores a value as JSON (undefined removes the key).
 * @param {string} key
 * @param {*} value
 * @returns {boolean} true when the value was written
 */
export function saveJSON(key, value) {
  try {
    const ls = store();
    if (!ls) return false;
    if (value === undefined) {
      ls.removeItem(key);
      return true;
    }
    ls.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // QuotaExceededError, cyclic value…
  }
}

/**
 * Deletes a key.
 * @param {string} key
 * @returns {boolean} true when storage was reachable
 */
export function removeKey(key) {
  try {
    const ls = store();
    if (!ls) return false;
    ls.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks for persistent storage (iOS grants it to Home Screen apps; it protects the save from eviction).
 * Only runs in standalone mode, where no permission prompt is shown.
 * @returns {Promise<boolean>} whether storage is (now) persistent
 */
export function requestPersistence() {
  try {
    const sm = typeof navigator !== 'undefined' ? navigator.storage : null;
    if (!sm || typeof sm.persist !== 'function' || !isStandalone()) return Promise.resolve(false);
    const already = typeof sm.persisted === 'function' ? sm.persisted() : Promise.resolve(false);
    return Promise.resolve(already)
      .then((p) => p || sm.persist())
      .then(Boolean, () => false);
  } catch {
    return Promise.resolve(false);
  }
}
