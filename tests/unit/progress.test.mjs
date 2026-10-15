import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newProgress, sanitizeProgress, completeLevel, useBooster, buyBooster, buySnack, markTip, PRICES, REWARD,
  starsFor, starThresholds, chapterOf, chapterNeed, totalStars, isPlayable, CHAPTER_SIZE,
} from '../../src/core/progress.js';

test('a fresh profile starts at level 1 with a few free boosters and no stars', () => {
  const p = newProgress();
  assert.equal(p.level, 1);
  assert.ok(p.boosters.hint > 0 && p.boosters.treat > 0);
  assert.deepEqual(p.stars, {});
  assert.deepEqual(sanitizeProgress(JSON.parse(JSON.stringify(p))), p);
});

test('sanitizeProgress repairs broken data and migrates v1 profiles', () => {
  assert.deepEqual(sanitizeProgress(null), newProgress());
  assert.deepEqual(sanitizeProgress({ v: 3, level: 9 }), newProgress());
  const p = sanitizeProgress({ v: 1, level: 7, coins: -5, boosters: { hint: 2, treat: 'x' }, tips: ['drag', 5] });
  assert.equal(p.level, 7);
  assert.equal(p.coins, newProgress().coins);
  assert.equal(p.boosters.hint, 2);
  assert.equal(p.boosters.treat, newProgress().boosters.treat);
  assert.deepEqual(p.tips, ['drag']);
  assert.deepEqual(p.stars, { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 }, 'old finished levels count as one star');
  const q = sanitizeProgress({ v: 2, level: 4, stars: { 1: 3, 2: 9, 3: 2, 7: 3, x: 1 } });
  assert.deepEqual(q.stars, { 1: 3, 2: 1, 3: 2 });
});

test('stars follow the par thresholds', () => {
  assert.deepEqual(starThresholds(10), { three: 10, two: 13 });
  assert.deepEqual(starThresholds(4), { three: 4, two: 6 });
  assert.equal(starsFor(10, 10), 3);
  assert.equal(starsFor(13, 10), 2);
  assert.equal(starsFor(14, 10), 1);
  assert.equal(starsFor(50, undefined), 3);
});

test('finishing levels pays for the level and for new stars; replays pay only improvements', () => {
  const p = newProgress();
  const c0 = p.coins;
  let r = completeLevel(p, 1, false, 2);
  assert.deepEqual(r, { coins: REWARD.normal + 2 * REWARD.star, stars: 2, best: 2, first: true, newStars: 2 });
  assert.equal(p.level, 2);
  r = completeLevel(p, 1, false, 1);
  assert.equal(r.coins, 0);
  assert.equal(p.stars[1], 2, 'the best rating is kept');
  r = completeLevel(p, 1, false, 3);
  assert.equal(r.coins, REWARD.star);
  r = completeLevel(p, 2, true, 1);
  assert.equal(r.coins, REWARD.hard + REWARD.star);
  assert.equal(p.coins, c0 + REWARD.normal + 3 * REWARD.star + REWARD.hard + REWARD.star);
  assert.equal(totalStars(p), 4);
});

test('chapters open with enough stars', () => {
  assert.equal(chapterOf(1), 1);
  assert.equal(chapterOf(CHAPTER_SIZE), 1);
  assert.equal(chapterOf(CHAPTER_SIZE + 1), 2);
  assert.equal(chapterNeed(1), 0);
  const p = newProgress();
  for (let n = 1; n <= CHAPTER_SIZE; n++) completeLevel(p, n, false, 1);
  assert.equal(p.level, CHAPTER_SIZE + 1);
  assert.equal(isPlayable(p, 5), true);
  assert.equal(isPlayable(p, CHAPTER_SIZE + 1), false, 'one star per level is not enough');
  for (let n = 1; n <= CHAPTER_SIZE; n++) completeLevel(p, n, false, 2);
  assert.ok(totalStars(p) >= chapterNeed(2));
  assert.equal(isPlayable(p, CHAPTER_SIZE + 1), true);
  assert.equal(isPlayable(p, CHAPTER_SIZE + 2), false, 'not reached yet');
});

test('boosters and snacks are spent and bought with coins', () => {
  const p = newProgress();
  p.boosters.hint = 1;
  assert.equal(useBooster(p, 'hint'), true);
  assert.equal(useBooster(p, 'hint'), false);
  p.coins = PRICES.hint - 1;
  assert.equal(buyBooster(p, 'hint'), false);
  p.coins = PRICES.hint;
  assert.equal(buyBooster(p, 'hint'), true);
  assert.equal(p.coins, 0);
  assert.equal(p.boosters.hint, 1);
  assert.equal(useBooster(p, 'nope'), false);
  assert.equal(buySnack(p), false);
  p.coins = PRICES.snack;
  assert.equal(buySnack(p), true);
  assert.equal(p.coins, 0);
});

test('tips are shown once', () => {
  const p = newProgress();
  assert.equal(markTip(p, 'ice'), true);
  assert.equal(markTip(p, 'ice'), false);
});
