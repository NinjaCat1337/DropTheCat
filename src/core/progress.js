// Player progress and the coin economy (pure; the app persists it with storage.js).
// Levels are played in order: `level` is the next level to play. Coins come from finished levels and buy
// boosters; Undo and Restart are always free (there is no timer and no move limit).

export const PRICES = Object.freeze({ hint: 60, treat: 120 });
export const REWARD = Object.freeze({ normal: 10, hard: 25 });
export const BOOSTERS = Object.freeze(['hint', 'treat']);
const START = Object.freeze({ coins: 40, hint: 3, treat: 2 });
const MAX_LEVEL = 100000;
const MAX_COINS = 9999999;

/** A fresh profile. */
export function newProgress() {
  return { v: 1, level: 1, coins: START.coins, boosters: { hint: START.hint, treat: START.treat }, tips: [] };
}

const count = (v, max) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null);

/** Returns a valid progress object built from untrusted data (falls back field by field). */
export function sanitizeProgress(data) {
  const p = newProgress();
  if (!data || typeof data !== 'object' || data.v !== 1) return p;
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
  return p;
}

/**
 * Records a finished level. Only the current level advances the profile (replays earn nothing).
 * @returns {number} coins earned
 */
export function completeLevel(p, n, hard) {
  if (n !== p.level) return 0;
  const reward = hard ? REWARD.hard : REWARD.normal;
  p.level = Math.min(MAX_LEVEL, p.level + 1);
  p.coins = Math.min(MAX_COINS, p.coins + reward);
  return reward;
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

/** Marks a one-time tip as shown; returns true the first time. */
export function markTip(p, id) {
  if (p.tips.includes(id)) return false;
  p.tips.push(id);
  return true;
}
