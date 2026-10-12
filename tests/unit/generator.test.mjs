// Level generator (src/core/generator.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel, Game, MAX_COLORS } from '../../src/core/rules.js';
import {
  generateLevel,
  evaluateLevel,
  levelParams,
  levelSeed,
  playStats,
  verifySolution,
  difficulty,
  targetDifficulty,
  isHard,
  mosaic,
} from '../../src/core/generator.js';
import { solve, explorer } from '../../src/core/solver.js';

const QUICK = { candidates: 2, playouts: 6 };

/** Empty floor cells at the start. */
function emptyCells(def) {
  const used = new Set(def.cats.map(([x, y]) => y * def.w + x));
  for (const hole of def.holes) for (const [dx, dy] of hole.cells) used.add((hole.y + dy) * def.w + hole.x + dx);
  let empty = 0;
  for (let y = 0; y < def.h; y++) for (let x = 0; x < def.w; x++) if (def.grid[y][x] === '.' && !used.has(y * def.w + x)) empty++;
  return empty;
}

/** The design rules every generated level follows. */
function checkDesign(def, label) {
  assert.doesNotThrow(() => compileLevel(def), label);
  assert.ok(def.w >= 3 && def.w <= 7 && def.h >= 3 && def.h <= 10, `${label}: size ${def.w}×${def.h}`);
  const colours = [];
  for (const hole of def.holes) {
    assert.equal(hole.need, hole.cells.length, `${label}: need = cells`);
    colours.push(hole.c);
    for (const [c, need] of hole.next || []) {
      assert.equal(need, hole.cells.length, `${label}: every layer needs as many cats as the hole has cells`);
      colours.push(c);
    }
  }
  assert.equal(new Set(colours).size, colours.length, `${label}: one hole per colour (layers included)`);
  assert.ok(colours.length <= MAX_COLORS, `${label}: colours`);
  const empty = emptyCells(def);
  assert.ok(empty >= 2 && empty <= 4, `${label}: ${empty} empty cells`);
  assert.ok(verifySolution(def, def.solution), `${label}: stored solution wins`);
  const g = new Game(def);
  assert.ok(explorer(g.L).unique, `${label}: unique colours`);
  assert.ok(explorer(g.L).productiveMoves(g).length > 0, `${label}: a productive first move`);
  assert.ok(solve(g, { maxNodes: 20000 }), `${label}: the solver wins it`);
}

test('the same (params, seed) gives the same level', () => {
  const P = { w: 6, h: 8, holes: 7, layered: 1, ...QUICK };
  const a = generateLevel(P, 1234);
  assert.deepEqual(generateLevel(P, 1234), a);
  assert.notDeepEqual(generateLevel(P, 1235).cats, a.cats);
});

test('generated levels are packed mosaics with one hole per colour, solvable by construction', () => {
  const sets = [
    { w: 4, h: 6, holes: 4, openers: 3 },
    { w: 5, h: 7, holes: 5, layered: 1 },
    { w: 6, h: 9, holes: 8, layered: 2, palette: 10, maxColors: 10 },
    { w: 7, h: 10, holes: 8, layered: 3, layers3: 0.5, palette: 12, maxColors: 11 },
    { w: 99, h: 99, holes: 8, layered: 2, palette: 10 }, // clamped to 7×10
  ];
  sets.forEach((P, i) => {
    for (const seed of [1, 2]) {
      const def = generateLevel({ ...P, ...QUICK }, seed * 7919 + i);
      checkDesign(def, `set ${i} seed ${seed}`);
      assert.ok(def.stats && def.stats.drags === def.solution.length, `set ${i}: stats`);
    }
  });
});

test('mechanics appear where the stored solution allows them', () => {
  const base = { w: 6, h: 8, holes: 7, layered: 1, ...QUICK };
  const mods = (def, k) => def.cats.filter((c) => c[3] && c[3][k]).length;
  const ice = generateLevel({ ...base, ice: 3 }, 11);
  checkDesign(ice, 'ice');
  assert.equal(mods(ice, 'ice'), 3);
  const box = generateLevel({ ...base, box: 3 }, 12);
  checkDesign(box, 'box');
  assert.equal(mods(box, 'box'), 3);
  const lock = generateLevel({ ...base, lock: 3 }, 13);
  checkDesign(lock, 'lock');
  assert.equal(mods(lock, 'key'), 1);
  assert.equal(lock.grid.join('').split('L').length - 1, 3);
  const axis = generateLevel({ ...base, axis: 2 }, 14);
  checkDesign(axis, 'axis');
  assert.equal(axis.holes.filter((h) => h.axis).length, 2);
});

test('playStats and evaluateLevel measure a level', () => {
  const def = generateLevel({ w: 6, h: 8, holes: 7, layered: 1, ...QUICK }, 99);
  const st = playStats(def, 10, 3);
  assert.equal(st.stuck, 0, 'never stuck: no dead ends');
  assert.ok(st.startHoles >= 1 && st.startMoves >= st.startHoles);
  assert.ok(st.stalls >= 0 && st.repo >= 0 && st.drags > 0 && st.branching > 0);
  assert.deepEqual(playStats(def, 10, 3), st, 'deterministic');
  const ev = evaluateLevel(def, { playouts: 10, seed: 3 });
  assert.equal(ev.solvable, true);
  assert.equal(ev.solutionOk, true);
  assert.equal(ev.difficulty, difficulty(st));
  assert.equal(ev.cats, def.cats.length);
  assert.equal(ev.holes, def.holes.length);
  assert.ok(ev.empty >= 2 && ev.empty <= 4);
  assert.ok(ev.mosaic >= 0 && ev.mosaic <= 1);
  assert.equal(mosaic({ w: 2, h: 1, cats: [[0, 0, 1], [1, 0, 1]] }), 1);
  assert.equal(mosaic({ w: 2, h: 1, cats: [[0, 0, 1], [1, 0, 2]] }), 0);
});

test('the campaign curve rises smoothly; hard levels and gentle introductions', () => {
  let last = -1;
  for (let n = 4; n <= 100; n++) {
    const t = targetDifficulty(n);
    assert.ok(t >= last - 1e-9, `target(${n})`);
    last = t;
  }
  const firstWith = (pred) => {
    for (let n = 4; n <= 100; n++) if (pred(levelParams(n))) return n;
    return 0;
  };
  assert.equal(firstWith((P) => P.layered > 0), 7);
  assert.equal(firstWith((P) => P.ice > 0), 15);
  assert.equal(firstWith((P) => P.box > 0), 25);
  assert.equal(firstWith((P) => P.axis > 0), 35);
  assert.equal(firstWith((P) => P.lock > 0), 45);
  for (const n of [7, 15, 25, 35, 45]) assert.ok(levelParams(n).target[1] < targetDifficulty(n), `intro ${n} is gentle`);
  for (let n = 4; n <= 160; n++) {
    const P = levelParams(n);
    assert.deepEqual(levelParams(n), P, `deterministic ${n}`);
    assert.equal(P.id, n);
    assert.equal(P.hard, n % 10 === 0);
    assert.equal(isHard(n), n % 10 === 0);
    assert.ok(P.w <= 7 && P.h <= 10, `size ${n}`);
    assert.ok(P.holes + P.layered <= P.maxColors && P.maxColors <= MAX_COLORS, `colours ${n}`);
    if (P.hard && n >= 20) assert.ok(P.target[0] > levelParams(n - 1).target[1], `hard ${n} aims higher`);
  }
  assert.notEqual(levelSeed(101), levelSeed(102));
});

test('an endless level is generated fast enough for the browser', () => {
  const times = [];
  for (const n of [101, 104, 107, 110, 113]) {
    const t0 = performance.now();
    const def = generateLevel(levelParams(n), levelSeed(n));
    times.push(performance.now() - t0);
    checkDesign(def, `endless ${n}`);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[2] < 300, `median ${times[2].toFixed(0)} ms`);
});
