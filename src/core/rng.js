// Seeded PRNG (mulberry32): the same seed gives the same sequence on every machine, so generated levels
// are reproducible. Pure; importable by Node and the browser.

/**
 * @param {number} seed any number; only its low 32 bits are used
 */
export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** Float in [0, 1). */
    next,
    /** Integer in [0, n). */
    int: (n) => Math.floor(next() * n),
    /** Integer in [lo, hi] (inclusive). */
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    /** Random element (undefined for an empty array). */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** True with probability p. */
    chance: (p) => next() < p,
    /** In-place Fisher–Yates shuffle; returns the array. */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
      return arr;
    },
    get state() {
      return a;
    },
  };
}
