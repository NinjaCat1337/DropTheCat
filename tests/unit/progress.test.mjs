import test from 'node:test';
import assert from 'node:assert/strict';
import { newProgress, sanitizeProgress, completeLevel, useBooster, buyBooster, markTip, PRICES, REWARD } from '../../src/core/progress.js';

test('a fresh profile starts at level 1 with a few free boosters', () => {
  const p = newProgress();
  assert.equal(p.level, 1);
  assert.ok(p.boosters.hint > 0 && p.boosters.treat > 0);
  assert.deepEqual(sanitizeProgress(JSON.parse(JSON.stringify(p))), p);
});

test('sanitizeProgress repairs broken data field by field', () => {
  assert.deepEqual(sanitizeProgress(null), newProgress());
  assert.deepEqual(sanitizeProgress({ v: 2, level: 9 }), newProgress());
  const p = sanitizeProgress({ v: 1, level: 7, coins: -5, boosters: { hint: 2, treat: 'x' }, tips: ['drag', 5] });
  assert.equal(p.level, 7);
  assert.equal(p.coins, newProgress().coins);
  assert.equal(p.boosters.hint, 2);
  assert.equal(p.boosters.treat, newProgress().boosters.treat);
  assert.deepEqual(p.tips, ['drag']);
});

test('finishing the current level advances it and pays; replays pay nothing', () => {
  const p = newProgress();
  const c0 = p.coins;
  assert.equal(completeLevel(p, 1, false), REWARD.normal);
  assert.equal(p.level, 2);
  assert.equal(completeLevel(p, 1, false), 0);
  assert.equal(completeLevel(p, 2, true), REWARD.hard);
  assert.equal(p.coins, c0 + REWARD.normal + REWARD.hard);
});

test('boosters are spent and bought with coins', () => {
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
});

test('tips are shown once', () => {
  const p = newProgress();
  assert.equal(markTip(p, 'ice'), true);
  assert.equal(markTip(p, 'ice'), false);
});
