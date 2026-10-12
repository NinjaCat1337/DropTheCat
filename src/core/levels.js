// Level access: the campaign pack (level-data.js, written by `npm run levels`) and endless levels beyond it,
// generated on demand — deterministically from the level number, so every player gets the same level n.
// Pure (no DOM); importable by Node and the browser.
import { LEVELS } from './level-data.js';
import { generateLevel, levelParams, levelSeed, isHard } from './generator.js';

/** Number of levels in the campaign pack (levels after it are endless, generated). */
export const LEVEL_COUNT = LEVELS.length;

const endless = new Map(); // n → generated definition (a few kept)
const KEEP = 8;

const copy = (def) => JSON.parse(JSON.stringify(def));

/** True for the "hard" levels (every 10th: 10, 20, …), pack and endless alike. */
export function isHardLevel(n) {
  if (!Number.isInteger(n) || n < 1) return false;
  if (n <= LEVEL_COUNT) return LEVELS[n - 1].hard === true;
  return isHard(n);
}

/** True when level n is generated on demand (beyond the pack). */
export function isEndlessLevel(n) {
  return Number.isInteger(n) && n > LEVEL_COUNT;
}

function makeEndless(n) {
  const P = levelParams(n);
  // Deterministic fallbacks: other seeds, then fewer holes; generateLevel throws only in freak cases.
  for (let k = 0; k < 4; k++) {
    try {
      const params = k < 3 ? P : { ...P, holes: P.holes - 2, ice: 0, box: 0, lock: 0, axis: 0 };
      return generateLevel(params, (levelSeed(n) + k * 7919) >>> 0);
    } catch {
      // try the next variant
    }
  }
  return copy(LEVELS[LEVEL_COUNT - 1 - (n % 10 === 0 ? 0 : 1)]);
}

/**
 * Level definition n (1-based): { id, w, h, hard?, grid, cats, holes, solution, stats } — the format of
 * rules.js compileLevel plus metadata. Returns a fresh copy every time (callers may mutate it).
 * Levels beyond LEVEL_COUNT are generated (tens of milliseconds the first time; a few are cached).
 * @param {number} n
 */
export function getLevel(n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`no level ${n}`);
  if (n <= LEVEL_COUNT) return copy(LEVELS[n - 1]);
  let def = endless.get(n);
  if (!def) {
    def = makeEndless(n);
    def.id = n;
    if (isHard(n)) def.hard = true;
    else delete def.hard;
    endless.set(n, def);
    if (endless.size > KEEP) endless.delete(endless.keys().next().value);
  }
  return copy(def);
}
