// Level pack and endless levels (src/core/levels.js, src/core/level-data.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileLevel, Game, MAX_COLORS } from '../../src/core/rules.js';
import { LEVEL_COUNT, getLevel, isHardLevel, isEndlessLevel } from '../../src/core/levels.js';
import { LEVELS } from '../../src/core/level-data.js';
import { generateLevel, levelParams, levelSeed } from '../../src/core/generator.js';
import { solve, replay, explorer, applyPath, STEPS } from '../../src/core/solver.js';
import { createRng } from '../../src/core/rng.js';

const mods = (def, k) => def.cats.filter((c) => c[3] && c[3][k]).length;
const hasLock = (def) => def.grid.some((r) => r.includes('L'));
const hasAxis = (def) => def.holes.some((h) => h.axis);
const hasLayers = (def) => def.holes.some((h) => h.next && h.next.length);

function emptyCells(def) {
  const used = new Set(def.cats.map(([x, y]) => y * def.w + x));
  for (const hole of def.holes) for (const [dx, dy] of hole.cells) used.add((hole.y + dy) * def.w + hole.x + dx);
  let empty = 0;
  for (let y = 0; y < def.h; y++) for (let x = 0; x < def.w; x++) if (def.grid[y][x] === '.' && !used.has(y * def.w + x)) empty++;
  return empty;
}

/** Design rules: packed board, one hole per colour (layers too), every layer needs as many cats as cells. */
function checkPlayable(def, label) {
  assert.doesNotThrow(() => compileLevel(def), label);
  assert.ok(def.w <= 7 && def.h <= 10, `${label}: ${def.w}×${def.h}`);
  const colours = [];
  for (const hole of def.holes) {
    assert.equal(hole.need, hole.cells.length, `${label}: need = cells`);
    colours.push(hole.c);
    for (const [c, need] of hole.next || []) {
      assert.equal(need, hole.cells.length, `${label}: layer need = cells`);
      colours.push(c);
    }
  }
  assert.equal(new Set(colours).size, colours.length, `${label}: one hole per colour`);
  assert.ok(colours.length <= MAX_COLORS);
  const empty = emptyCells(def);
  assert.ok(empty >= 2 && empty <= 4, `${label}: ${empty} empty cells`);
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

test('every pack level is a packed board with one hole per colour, and its stored solution wins', () => {
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

test('no dead ends: thousands of random playouts never get stuck before winning', () => {
  const rng = createRng(2024);
  let playouts = 0;
  for (let n = 1; n <= LEVEL_COUNT; n++) {
    const g0 = new Game(getLevel(n));
    const ex = explorer(g0.L);
    for (let p = 0; p < 25; p++) {
      const g = g0.clone();
      let won = false;
      for (let guard = 0; guard < 400; guard++) {
        if (g.isWon()) {
          won = true;
          break;
        }
        assert.equal(g.isStuck(), false, `level ${n} playout ${p}: stuck`);
        if (rng.chance(0.3)) {
          // A random slide of a random hole (players fiddle around).
          const k = rng.int(g.holeCount);
          const [dx, dy] = STEPS[rng.pick(['R', 'L', 'U', 'D'])];
          if (g.canStep(k, dx, dy)) g.step(k, dx, dy, null);
          continue;
        }
        const moves = ex.productiveMoves(g);
        if (moves.length) {
          const mv = rng.pick(moves);
          applyPath(g, mv.hole, mv.path);
          continue;
        }
        const seq = ex.unstall(g);
        assert.ok(seq, `level ${n} playout ${p}: no way on`);
        for (const [k, ch] of seq) applyPath(g, k, ch);
      }
      assert.ok(won, `level ${n} playout ${p}: won`);
      playouts++;
    }
  }
  assert.ok(playouts >= 2500);
});

test('tutorials: tiny packed boards, one clear drag per hole', () => {
  for (const n of [1, 2, 3]) {
    const def = getLevel(n);
    assert.ok(def.w * def.h <= 24, `level ${n} is tiny`);
    assert.equal(def.solution.length, def.holes.length, `level ${n}: one drag per hole`);
    assert.ok(def.holes.length <= 3);
  }
  const startHoles = (n) => {
    const g = new Game(getLevel(n));
    return new Set(explorer(g.L).productiveMoves(g).map((mv) => mv.hole)).size;
  };
  assert.equal(startHoles(1), 2, 'level 1: every hole can go');
  assert.equal(startHoles(2), 3, 'level 2: every hole can go');
  assert.equal(startHoles(3), 2, 'level 3: one hole waits for another');
  for (const n of [1, 2]) assert.ok(getLevel(n).solution.every(([, path]) => /^(U+|D+|L+|R+)$/.test(path)), `level ${n}: straight drags`);
});

test('mechanics are introduced on gentle levels and not before', () => {
  const firstWith = (pred) => {
    for (let n = 1; n <= LEVEL_COUNT; n++) if (pred(getLevel(n))) return n;
    return 0;
  };
  assert.equal(firstWith(hasLayers), 7);
  assert.equal(firstWith((d) => mods(d, 'ice') > 0), 15);
  assert.equal(firstWith((d) => mods(d, 'box') > 0), 25);
  assert.equal(firstWith(hasAxis), 35);
  assert.equal(firstWith((d) => hasLock(d) && mods(d, 'key') > 0), 45);
  const diff = (n) => getLevel(n).stats.difficulty;
  for (const n of [7, 15, 25, 35, 45]) {
    const around = [diff(n - 2), diff(n - 1), diff(n + 1), diff(n + 2)].sort((a, b) => a - b);
    assert.ok(diff(n) <= around[2], `intro ${n} (${diff(n)}) is not harder than its neighbours`);
  }
});

test('every 10th level is hard and clearly harder than the levels before it', () => {
  for (let n = 1; n <= LEVEL_COUNT; n++) {
    assert.equal(isHardLevel(n), n % 10 === 0, `level ${n}`);
    assert.equal(getLevel(n).hard === true, n % 10 === 0);
  }
  for (let n = 10; n <= LEVEL_COUNT; n += 10) {
    const before = [];
    for (let k = n - 9; k < n; k++) before.push(getLevel(k).stats.difficulty);
    before.sort((a, b) => a - b);
    assert.ok(getLevel(n).stats.difficulty > before[4] + 0.5, `level ${n}: ${getLevel(n).stats.difficulty} vs median ${before[4]}`);
  }
});

test('boards and difficulty grow through the pack', () => {
  const avg = (a, b, f) => {
    let s = 0;
    for (let n = a; n <= b; n++) s += f(getLevel(n));
    return s / (b - a + 1);
  };
  const tiers = [[4, 9], [11, 29], [31, 59], [61, 99]];
  const d = tiers.map(([a, b]) => avg(a, b, (x) => x.stats.difficulty));
  const cells = tiers.map(([a, b]) => avg(a, b, (x) => x.w * x.h));
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(d[i] > d[i - 1], `difficulty ${d.map((v) => v.toFixed(2)).join(' < ')}`);
    assert.ok(cells[i] >= cells[i - 1], `board size ${cells.map((v) => v.toFixed(1)).join(' <= ')}`);
  }
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
    assert.ok(solve(g, { maxNodes: 50000 }), `endless ${n} solved`);
    assert.deepEqual(getLevel(n), def, `endless ${n} is stable`);
  }
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
