// Level pack and endless levels (src/core/levels.js, src/core/level-data.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileLevel, Game } from '../../src/core/rules.js';
import { LEVEL_COUNT, getLevel, isHardLevel, isEndlessLevel } from '../../src/core/levels.js';
import { LEVELS } from '../../src/core/level-data.js';
import { generateLevel, levelParams, levelSeed, difficulty } from '../../src/core/generator.js';
import { solve, replay, explorer } from '../../src/core/solver.js';

const mods = (def, k) => def.cats.filter((c) => c[3] && c[3][k]).length;
const hasLock = (def) => def.grid.some((r) => r.includes('L'));
const hasAxis = (def) => def.holes.some((h) => h.axis);
const diff = (def) => difficulty(def.stats.trapRate, def.stats.deepTrapRate);

function checkPlayable(def, label) {
  assert.doesNotThrow(() => compileLevel(def), label);
  assert.ok(def.w <= 8 && def.h <= 10, `${label}: ${def.w}×${def.h}`);
  assert.ok(def.cats.length <= 45, `${label}: cats`);
  for (const h of def.holes) assert.ok(h.need >= 1 && h.need <= 12, `${label}: need`);
  const g = new Game(def);
  const end = replay(g, def.solution);
  assert.ok(end && end.isWon(), `${label}: the stored solution wins`);
  assert.ok(explorer(g.L).productiveMoves(g).length > 0, `${label}: a productive first move`);
  return g;
}

test('the pack has 100 levels numbered 1..100', () => {
  assert.equal(LEVEL_COUNT, 100);
  assert.equal(LEVELS.length, 100);
  LEVELS.forEach((def, i) => assert.equal(def.id, i + 1));
});

test('every pack level compiles, fits a phone and its stored solution wins', () => {
  for (let n = 1; n <= LEVEL_COUNT; n++) checkPlayable(getLevel(n), `level ${n}`);
});

test('the solver wins every pack level from its start', () => {
  for (let n = 1; n <= LEVEL_COUNT; n++) {
    const g = new Game(getLevel(n));
    const r = solve(g, { maxNodes: 50000 });
    assert.ok(r, `level ${n}`);
    const end = replay(g, r.moves);
    assert.ok(end && end.isWon(), `level ${n}: solver line wins`);
  }
});

test('tutorials teach one thing at a time', () => {
  const t1 = getLevel(1);
  assert.equal(t1.holes.length, 1);
  assert.deepEqual(t1.holes[0].cells, [[0, 0]]);
  assert.equal(t1.cats.length, 3);
  assert.ok(t1.cats.every(([x, , c]) => x === t1.holes[0].x && c === t1.holes[0].c), 'a straight line above the hole');
  assert.ok(t1.cats.every(([, y]) => y < t1.holes[0].y));
  assert.deepEqual(t1.solution, [[0, 'UUU']]);
  const t2 = getLevel(2);
  assert.equal(new Set(t2.holes.map((h) => h.c)).size, 2);
  assert.equal(t2.holes.length, 2);
  // Level 3: the red hole cannot reach its cats until the blue row is gone.
  const g = new Game(getLevel(3));
  const ex = explorer(g.L);
  const first = ex.productiveMoves(g);
  assert.ok(first.length > 0 && first.every((mv) => g.holeColor(mv.hole) !== 0));
  assert.equal(g.canEverCollect(0), false);
});

test('mechanics are introduced on gentle levels and not before', () => {
  const firstWith = (pred) => {
    for (let n = 1; n <= LEVEL_COUNT; n++) if (pred(getLevel(n))) return n;
    return 0;
  };
  assert.equal(firstWith((d) => mods(d, 'ice') > 0), 12);
  assert.equal(firstWith((d) => mods(d, 'box') > 0), 22);
  assert.equal(firstWith(hasAxis), 36);
  assert.equal(firstWith((d) => hasLock(d) && mods(d, 'key') > 0), 45);
  for (const n of [12, 22, 36, 45]) assert.ok(diff(getLevel(n)) <= 0.3, `intro level ${n} is gentle`);
});

test('every 10th level is hard and clearly harder than the levels before it', () => {
  for (let n = 1; n <= LEVEL_COUNT; n++) {
    assert.equal(isHardLevel(n), n % 10 === 0, `level ${n}`);
    assert.equal(getLevel(n).hard === true, n % 10 === 0);
  }
  for (let n = 10; n <= LEVEL_COUNT; n += 10) {
    const before = [];
    for (let k = n - 9; k < n; k++) before.push(diff(getLevel(k)));
    before.sort((a, b) => a - b);
    const median = before[4];
    assert.ok(diff(getLevel(n)) > median, `level ${n}: ${diff(getLevel(n)).toFixed(2)} vs median ${median.toFixed(2)}`);
  }
});

test('the difficulty trends upward through the pack', () => {
  const avg = (a, b) => {
    let s = 0;
    for (let n = a; n <= b; n++) s += diff(getLevel(n));
    return s / (b - a + 1);
  };
  const tiers = [avg(4, 9), avg(11, 29), avg(31, 59), avg(61, 99)];
  for (let i = 1; i < tiers.length; i++) assert.ok(tiers[i] > tiers[i - 1], `tiers ${tiers.map((t) => t.toFixed(2)).join(' < ')}`);
});

test('getLevel returns fresh copies and rejects bad numbers', () => {
  const a = getLevel(7);
  a.cats.length = 0;
  a.grid[0] = 'xx';
  const b = getLevel(7);
  assert.ok(b.cats.length > 0);
  assert.notEqual(b.grid[0], 'xx');
  assert.throws(() => getLevel(0), RangeError);
  assert.throws(() => getLevel(1.5), RangeError);
  assert.equal(isHardLevel(0), false);
  assert.equal(isEndlessLevel(100), false);
  assert.equal(isEndlessLevel(101), true);
});

test('endless levels 101..120 are valid, solvable and deterministic', () => {
  for (let n = 101; n <= 120; n++) {
    const def = getLevel(n);
    assert.equal(def.id, n);
    assert.equal(def.hard === true, n % 10 === 0, `hard flag ${n}`);
    assert.equal(isHardLevel(n), n % 10 === 0);
    const g = checkPlayable(def, `endless ${n}`);
    const r = solve(g, { maxNodes: 50000 });
    assert.ok(r, `endless ${n} solved`);
    assert.deepEqual(getLevel(n), def, `endless ${n} is stable`);
  }
  // Same as generating from scratch (no hidden state).
  for (const n of [103, 117]) {
    const fresh = generateLevel(levelParams(n), levelSeed(n));
    const def = getLevel(n);
    assert.deepEqual(def.cats, fresh.cats);
    assert.deepEqual(def.holes, fresh.holes);
    assert.deepEqual(def.grid, fresh.grid);
  }
});

test('level-data.js stays small', () => {
  const file = fileURLToPath(new URL('../../src/core/level-data.js', import.meta.url));
  const size = fs.statSync(file).size;
  assert.ok(size < 250 * 1024, `${(size / 1024).toFixed(1)} KB`);
});
