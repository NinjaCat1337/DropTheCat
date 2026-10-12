// Level generator (src/core/generator.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel, Game } from '../../src/core/rules.js';
import {
  generateLevel,
  evaluateLevel,
  levelParams,
  levelSeed,
  trapRate,
  verifySolution,
  difficulty,
  targetDifficulty,
  isHard,
} from '../../src/core/generator.js';
import { solve, explorer } from '../../src/core/solver.js';

const QUICK = { candidates: 2, playouts: 12 };
const ALL = ['I1', 'I2', 'I3', 'L3', 'O4', 'I4', 'L4', 'T4', 'S4'];

/** Checks the invariants every generated level must satisfy. */
function checkLevel(def, label) {
  assert.doesNotThrow(() => compileLevel(def), label);
  assert.ok(def.w >= 3 && def.w <= 8 && def.h >= 3 && def.h <= 10, `${label}: size ${def.w}×${def.h}`);
  assert.ok(def.cats.length <= 45, `${label}: ${def.cats.length} cats`);
  for (const hole of def.holes) assert.ok(hole.need >= 1 && hole.need <= 12, `${label}: need ${hole.need}`);
  assert.ok(Array.isArray(def.solution) && def.solution.length === def.holes.length, `${label}: one drag per hole`);
  assert.ok(verifySolution(def, def.solution), `${label}: stored solution wins`);
  const g = new Game(def);
  assert.ok(explorer(g.L).productiveMoves(g).length > 0, `${label}: a productive first move exists`);
  const r = solve(g, { maxNodes: 50000 });
  assert.ok(r, `${label}: the solver wins it`);
  assert.ok(def.stats && def.stats.trapRate >= 0 && def.stats.trapRate <= 1, `${label}: stats`);
}

test('the same (params, seed) gives the same level', () => {
  const P = { w: 7, h: 9, colors: 4, holes: 6, shapes: ALL, ice: 1, box: 1, ...QUICK };
  const a = generateLevel(P, 1234);
  const b = generateLevel(P, 1234);
  assert.deepEqual(a, b);
  const c = generateLevel(P, 1235);
  assert.notDeepEqual(c.cats, a.cats);
});

test('generated levels are valid, solvable and fit a phone screen', () => {
  const sets = [
    { w: 5, h: 7, colors: 2, holes: 3, shapes: ['I1', 'I2'], cats: [9, 14], minFill: 0.3 },
    { w: 6, h: 8, colors: 3, holes: 4, cats: [16, 26] },
    { w: 7, h: 9, colors: 4, holes: 6, shapes: ALL, walls: 2 },
    { w: 8, h: 10, colors: 6, holes: 9, shapes: ALL, cats: [36, 45], walls: 1, fence: true },
    { w: 99, h: 99, colors: 5, holes: 8, shapes: ALL, cats: [30, 45] }, // clamped to 8×10
  ];
  sets.forEach((P, i) => {
    for (const seed of [1, 2]) {
      const def = generateLevel({ ...P, ...QUICK }, seed * 7919 + i);
      checkLevel(def, `set ${i} seed ${seed}`);
      assert.equal(new Set(def.holes.map((h) => h.c)).size, Math.min(P.colors, 8), `set ${i}: colours`);
    }
  });
});

test('mechanics appear where the intended solution allows them', () => {
  const base = { w: 7, h: 9, colors: 4, holes: 6, shapes: ['I1', 'I2', 'I3', 'L3', 'O4', 'T4'], ...QUICK };
  const mods = (def, k) => def.cats.filter((c) => c[3] && c[3][k]).length;
  const ice = generateLevel({ ...base, ice: 3 }, 11);
  checkLevel(ice, 'ice');
  assert.ok(mods(ice, 'ice') >= 1);
  for (const c of ice.cats) if (c[3] && c[3].ice) assert.ok(c[3].ice >= 1 && c[3].ice <= 9);
  const box = generateLevel({ ...base, box: 3 }, 12);
  checkLevel(box, 'box');
  assert.ok(mods(box, 'box') >= 1);
  const lock = generateLevel({ ...base, lock: 3 }, 13);
  checkLevel(lock, 'lock');
  assert.equal(mods(lock, 'key'), 1);
  assert.ok(lock.grid.join('').includes('L'));
  const axis = generateLevel({ ...base, axis: 2 }, 14);
  checkLevel(axis, 'axis');
  const locked = axis.holes.filter((h) => h.axis);
  assert.equal(locked.length, 2);
  // An axis-locked hole's stored drag only uses its axis.
  axis.solution.forEach(([k, path]) => {
    if (axis.holes[k].axis === 'h') assert.match(path, /^[LR]+$/);
    if (axis.holes[k].axis === 'v') assert.match(path, /^[UD]+$/);
  });
});

test('evaluateLevel measures a level', () => {
  const def = generateLevel({ w: 7, h: 9, colors: 4, holes: 7, shapes: ALL, walls: 2, ...QUICK }, 99);
  const ev = evaluateLevel(def, { playouts: 24, seed: 5 });
  assert.equal(ev.solvable, true);
  assert.equal(ev.solutionOk, true);
  assert.ok(ev.nodes > 0);
  assert.ok(ev.startMoves >= 1 && ev.startHoles >= 1 && ev.startHoles <= ev.holes);
  for (const k of ['trapRate', 'smartTrapRate']) assert.ok(ev[k] >= 0 && ev[k] <= 1, k);
  assert.equal(ev.cats, def.cats.length);
  assert.equal(ev.holes, def.holes.length);
  assert.equal(ev.steps, def.solution.reduce((a, s) => a + s[1].length, 0));
  // Deterministic for a given seed.
  assert.deepEqual(evaluateLevel(def, { playouts: 24, seed: 5 }), ev);
});

test('one hole per colour never dead-ends; a shared colour can', () => {
  const single = {
    w: 5,
    h: 6,
    grid: ['.....', '.....', '.....', '.....', '.....', '.....'],
    cats: [[1, 1, 0], [2, 1, 0], [3, 1, 0], [0, 2, 5], [1, 2, 5], [2, 2, 5], [3, 2, 5], [4, 2, 5]],
    holes: [
      { x: 2, y: 5, c: 0, cells: [[0, 0]], need: 3 },
      { x: 0, y: 3, c: 5, cells: [[0, 0]], need: 5 },
    ],
  };
  assert.equal(trapRate(single, 40, 1), 0);
  // The small red hole must keep its need for the pocket only it fits into.
  const trap = {
    w: 5,
    h: 4,
    grid: ['#.###', '.....', '.....', '.....'],
    cats: [[1, 0, 0], [1, 1, 0], [2, 1, 0]],
    holes: [
      { x: 0, y: 3, c: 0, cells: [[0, 0]], need: 1 },
      { x: 3, y: 2, c: 0, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], need: 2 },
    ],
  };
  assert.ok(trapRate(trap, 40, 1) > 0);
  assert.equal(trapRate(trap, 40, 1, true), 0, 'careful play sees this one');
});

test('difficulty grows along the campaign curve', () => {
  assert.equal(difficulty(0, 0), 0);
  assert.ok(difficulty(0.5, 0.5) > difficulty(0.9, 0));
  let last = -1;
  for (let n = 4; n <= 100; n++) {
    const t = targetDifficulty(n);
    assert.ok(t >= last - 1e-9, `target(${n})`);
    last = t;
  }
});

test('levelParams: limits, hard levels and gentle mechanic introductions', () => {
  for (let n = 4; n <= 160; n++) {
    const P = levelParams(n);
    assert.deepEqual(levelParams(n), P, `deterministic ${n}`);
    assert.equal(P.id, n);
    assert.equal(P.hard, n % 10 === 0);
    assert.equal(isHard(n), n % 10 === 0);
    assert.ok(P.w <= 8 && P.h <= 10, `size ${n}`);
    assert.ok(P.cats[1] <= 45, `cats ${n}`);
    assert.ok(P.need[1] <= 12, `need ${n}`);
    assert.ok(P.holes >= P.colors, `holes ${n}`);
    if (n < 12) assert.ok(!P.ice, `no ice before 12 (${n})`);
    if (n < 22) assert.ok(!P.box, `no boxes before 22 (${n})`);
    if (n < 36) assert.ok(!P.axis, `no axis before 36 (${n})`);
    if (n < 45) assert.ok(!P.lock, `no crates before 45 (${n})`);
  }
  assert.equal(levelParams(12).intro, 'ice');
  assert.equal(levelParams(22).intro, 'box');
  assert.equal(levelParams(36).intro, 'axis');
  assert.equal(levelParams(45).intro, 'lock');
  for (const n of [12, 22, 36, 45]) assert.ok(levelParams(n).target[1] <= 0.2, `intro ${n} is gentle`);
  for (const n of [20, 50, 90]) assert.ok(levelParams(n).target[0] > levelParams(n - 1).target[1], `hard ${n} aims higher`);
  assert.notEqual(levelSeed(101), levelSeed(102));
});

test('an endless level is generated fast enough for the browser', () => {
  const times = [];
  for (const n of [101, 104, 107, 110, 113]) {
    const t0 = performance.now();
    const def = generateLevel(levelParams(n), levelSeed(n));
    times.push(performance.now() - t0);
    checkLevel(def, `endless ${n}`);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[2] < 300, `median ${times[2].toFixed(0)} ms`);
});
