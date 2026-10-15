// Player progress, stars and the coin economy (pure; the app persists it with storage.js).
// Levels are played in order: `level` is the next new level. Every finished level keeps its best star rating
// (fewer drags = more stars). Levels come in chapters of 20; a chapter opens once the player has enough
// stars in total, so replaying levels for ★★★ is how to move on. Coins come from new levels and new stars
// and buy boosters; Undo and Restart are always free (there is no timer).

export const CHAPTER_SIZE = 20;
export const PRICES = Object.freeze({ hint: 60, treat: 120, snack: 40 });
export const REWARD = Object.freeze({ normal: 10, hard: 25, star: 5 });
export const BOOSTERS = Object.freeze(['hint', 'treat']);
export const SNACK_MOVES = 3;
const STARS_PER_LEVEL_TO_UNLOCK = 1.3;
const START = Object.freeze({ coins: 40, hint: 3, treat: 2 });
const MAX_LEVEL = 100000;
const MAX_COINS = 9999999;

/** A fresh profile. */
export function newProgress() {
  return { v: 2, level: 1, coins: START.coins, boosters: { hint: START.hint, treat: START.treat }, tips: [], stars: {} };
}

const count = (v, max) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null);

/** Returns a valid progress object built from untrusted data (falls back field by field; migrates v1). */
export function sanitizeProgress(data) {
  const p = newProgress();
  if (!data || typeof data !== 'object' || (data.v !== 1 && data.v !== 2)) return p;
  const level = count(data.level, MAX_LEVEL);
  if (level !== null && level >= 1) p.level = level;
  const coins = count(data.coins, MAX_COINS);
  if (coins !== null) p.coins = coins;
  if (data.boosters && typeof data.boosters === 'object') {
    for (const b of BOOSTERS) {
      const n = count(data.boosters[b], 999);
      if (n !== null) p.boosters[b] = n;
    }
  }
  if (Array.isArray(data.tips)) p.tips = data.tips.filter((t) => typeof t === 'string' && t.length < 40).slice(0, 50);
  if (data.v === 2 && data.stars && typeof data.stars === 'object') {
    for (const [k, v] of Object.entries(data.stars)) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 1 && n < p.level && Number.isInteger(v) && v >= 1 && v <= 3) p.stars[n] = v;
    }
  }
  // Levels finished before stars existed (v1) or with a lost record count as one star.
  for (let n = 1; n < p.level && n <= 5000; n++) if (!p.stars[n]) p.stars[n] = 1;
  return p;
}

/** Drag counts for each rating: ★★★ up to `three`, ★★ up to `two`, ★ otherwise. */
export function starThresholds(par) {
  const three = Number.isInteger(par) && par > 0 ? par : 0;
  return { three, two: three ? three + Math.max(2, Math.ceil(three * 0.3)) : 0 };
}

/** Stars for finishing a level in `moves` drags (3 when the level has no par). */
export function starsFor(moves, par) {
  const { three, two } = starThresholds(par);
  if (!three || moves <= three) return 3;
  return moves <= two ? 2 : 1;
}

export const chapterOf = (n) => Math.ceil(n / CHAPTER_SIZE);

/** Stars needed in total to open a chapter. */
export function chapterNeed(chapter) {
  return chapter <= 1 ? 0 : Math.ceil((chapter - 1) * CHAPTER_SIZE * STARS_PER_LEVEL_TO_UNLOCK);
}

export function totalStars(p) {
  let s = 0;
  for (const v of Object.values(p.stars)) s += v;
  return s;
}

export function chapterStars(p, chapter) {
  let s = 0;
  for (let n = (chapter - 1) * CHAPTER_SIZE + 1; n <= chapter * CHAPTER_SIZE; n++) s += p.stars[n] || 0;
  return s;
}

/** True when level n may be played now: reached, and its chapter is open. */
export function isPlayable(p, n) {
  return n >= 1 && n <= p.level && totalStars(p) >= chapterNeed(chapterOf(n));
}

/**
 * Records a finished level. The first finish advances the profile and pays the level reward; every finish
 * pays for stars above the previous best.
 * @returns {{ coins: number, stars: number, best: number, first: boolean, newStars: number }}
 */
export function completeLevel(p, n, hard, stars) {
  const first = n === p.level;
  const before = p.stars[n] || 0;
  const best = Math.max(before, stars);
  const newStars = best - before;
  let coins = newStars * REWARD.star;
  if (first) {
    coins += hard ? REWARD.hard : REWARD.normal;
    p.level = Math.min(MAX_LEVEL, p.level + 1);
  }
  if (best > 0) p.stars[n] = best;
  p.coins = Math.min(MAX_COINS, p.coins + coins);
  return { coins, stars, best, first, newStars };
}

/** Spends one booster; false when none is left. */
export function useBooster(p, kind) {
  if (!BOOSTERS.includes(kind) || p.boosters[kind] <= 0) return false;
  p.boosters[kind]--;
  return true;
}

/** Buys one booster with coins; false when the player cannot afford it. */
export function buyBooster(p, kind) {
  if (!BOOSTERS.includes(kind) || p.coins < PRICES[kind]) return false;
  p.coins -= PRICES[kind];
  p.boosters[kind] = Math.min(999, p.boosters[kind] + 1);
  return true;
}

/** Pays for a snack (hungry cats wait SNACK_MOVES more moves); false when the player cannot afford it. */
export function buySnack(p) {
  if (p.coins < PRICES.snack) return false;
  p.coins -= PRICES.snack;
  return true;
}

/** Marks a one-time tip as shown; returns true the first time. */
export function markTip(p, id) {
  if (p.tips.includes(id)) return false;
  p.tips.push(id);
  return true;
}
