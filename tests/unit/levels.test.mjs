// Level pack and endless levels (src/core/levels.js, src/core/level-data.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileLevel, Game, MAX_COLORS } from '../../src/core/rules.js';
import { LEVEL_COUNT, getLevel, isHardLevel, isEndlessLevel } from '../../src/core/levels.js';
import { LEVELS } from '../../src/core/level-data.js';
import { generateLevel, levelParams, levelSeed, INTRO } from '../../src/core/generator.js';
import { solve, hint, hasHungry, explorer, applyPath, STEPS } from '../../src/core/solver.js';
import { createRng } from '../../src/core/rng.js';

const mods = (def, k) => def.cats.filter((c) => c[3] && c[3][k]).length;
const has = {
  layers: (d) => d.holes.some((h) => h.next && h.next.length),
  walls: (d) => d.grid.some((r) => r.includes('#')),
  pentomino: (d) => d.holes.some((h) => h.cells.length === 5),
  ice: (d) => mods(d, 'ice') > 0,
  box: (d) => mods(d, 'box') > 0,
  hungry: (d) => mods(d, 'hungry') > 0,
  axis: (d) => d.holes.some((h) => h.axis),
  lock: (d) => d.grid.some((r) => r.includes('L')) && mods(d, 'key') > 0,
};

function emptyCells(def) {
  const used = new Set(def.cats.map(([x, y]) => y * def.w + x));
  for (const hole of def.holes) for (const [dx, dy] of hole.cells) used.add((hole.y + dy) * def.w + hole.x + dx);
  for (const [x, y] of def.gates || []) used.add(y * def.w + x);
  let empty = 0;
  for (let y = 0; y < def.h; y++) for (let x = 0; x < def.w; x++) if (def.grid[y][x] === '.' && !used.has(y * def.w + x)) empty++;
  return empty;
}

/** Plays the stored drags like the UI (endMove after each). Returns the game, or a string saying what failed. */
function playStored(def) {
  const g = new Game(def);
  for (let t = 0; t < def.solution.length; t++) {
    const [k, path] = def.solution[t];
    if (!applyPath(g, k, path)) return `drag ${t + 1} is not legal`;
    g.endMove(null);
    if (g.isFailed()) return `a hungry cat starved after drag ${t + 1}`;
  }
  return g.isWon() ? g : 'not won';
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
  assert.ok(empty >= 1 && empty <= 4, `${label}: ${empty} empty cells`);
  const g = new Game(def);
  assert.ok(explorer(g.L).productiveMoves(g).length > 0, `${label}: a productive first move`);
  return g;
}

test('the pack has 100 levels numbered 1..100', () => {
  assert.equal(LEVEL_COUNT, 100);
  assert.equal(LEVELS.length, 100);
  LEVELS.forEach((def, i) => assert.equal(def.id, i + 1));
});

test('every pack level is a packed board with one hole per colour', () => {
  for (let n = 1; n <= LEVEL_COUNT; n++) checkPlayable(getLevel(n), `level ${n}`);
});

test('every stored solution: exactly par drags, replayed with endMove, no hungry cat starves, it wins', () => {
  for (let n = 1; n <= LEVEL_COUNT; n++) {
    const def = getLevel(n);
    assert.ok(Number.isInteger(def.par) && def.par >= def.holes.length, `level ${n}: par ${def.par}`);
    assert.equal(def.solution.length, def.par, `level ${n}: one entry per drag`);
    for (let t = 1; t < def.solution.length; t++) assert.notEqual(def.solution[t][0], def.solution[t - 1][0], `level ${n}: a drag is one hole's move`);
    const res = playStored(def);
    assert.ok(typeof res !== 'string', `level ${n}: ${res}`);
  }
});

test('the hint solver wins every pack level from its start (hungry deadlines included)', () => {
  for (let n = 1; n <= LEVEL_COUNT; n++) {
    const g = new Game(getLevel(n));
    const r = solve(g, { maxNodes: 50000 });
    assert.ok(r, `level ${n}`);
    const end = g.clone();
    for (const mv of r.moves) {
      assert.ok(applyPath(end, mv.hole, mv.path), `level ${n}: legal`);
      end.endMove(null);
      assert.equal(end.isFailed(), false, `level ${n}: no hungry cat starves`);
    }
    assert.ok(end.isWon(), `level ${n}: solver line wins`);
  }
});

test('hungry levels: a hint all along the par line, and hints alone win in time', () => {
  let levels = 0;
  for (let n = 1; n <= LEVEL_COUNT; n++) {
    const def = getLevel(n);
    if (!def.cats.some((c) => c[3] && c[3].hungry)) continue;
    levels++;
    const g = new Game(def);
    for (const [k, path] of def.solution) {
      if (hasHungry(g)) assert.ok(hint(g), `level ${n}: a hint after ${g.moves} par drags`);
      applyPath(g, k, path);
      g.endMove(null);
    }
    const h = new Game(def);
    for (let guard = 0; guard < 200 && !h.isWon(); guard++) {
      const mv = hint(h);
      assert.ok(mv, `level ${n}: a hint after ${h.moves} hinted drags`);
      assert.ok(applyPath(h, mv.hole, mv.path));
      h.endMove(null);
      assert.equal(h.isFailed(), false, `level ${n}: following hints never starves a cat`);
    }
    assert.ok(h.isWon(), `level ${n}: hints win`);
  }
  assert.ok(levels >= 10, `${levels} levels with hungry cats`);
});

test('no dead ends (hungry deadlines aside): thousands of random playouts never get stuck', () => {
  const rng = createRng(2024);
  let playouts = 0;
  for (let n = 1; n <= LEVEL_COUNT; n++) {
    const g0 = new Game(getLevel(n));
    const ex = explorer(g0.L);
    for (let p = 0; p < 25; p++) {
      const g = g0.clone();
      let won = false;
      for (let guard = 0; guard < 500; guard++) {
        if (g.isWon()) {
          won = true;
          break;
        }
        assert.equal(g.isStuck(), false, `level ${n} playout ${p}: stuck`);
        if (rng.chance(0.3)) {
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
    assert.equal(def.par, def.holes.length, `level ${n}: one drag per hole`);
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

test('each mechanic comes first on its own level, gentler than the levels after it', () => {
  const diff = (n) => getLevel(n).stats.difficulty;
  const intros = new Set(Object.values(INTRO));
  for (const [name, at] of Object.entries(INTRO)) {
    let first = 0;
    for (let n = 1; n <= LEVEL_COUNT && !first; n++) if (has[name](getLevel(n))) first = n;
    assert.equal(first, at, `${name}: first on level ${at}`);
    const next = [];
    for (let n = at + 1; next.length < 3; n++) if (!intros.has(n) && !isHardLevel(n)) next.push(diff(n));
    const mean = next.reduce((a, b) => a + b, 0) / next.length;
    assert.ok(diff(at) < mean, `intro ${at} (${diff(at)}) is gentler than the next levels (${mean.toFixed(2)})`);
  }
});

test('no gates anywhere; one free cell from level 10 on', () => {
  for (let n = 1; n <= 120; n++) {
    const def = getLevel(n);
    assert.ok(!def.gates || !def.gates.length, `level ${n} has no gates`);
    if (n >= 10) assert.equal(emptyCells(def), 1, `level ${n}: one free cell`);
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

test('boards grow, free cells shrink and difficulty rises through the pack', () => {
  const avg = (a, b, f) => {
    let s = 0;
    for (let n = a; n <= b; n++) s += f(getLevel(n));
    return s / (b - a + 1);
  };
  const tiers = [[4, 9], [11, 29], [31, 59], [61, 99]];
  const d = tiers.map(([a, b]) => avg(a, b, (x) => x.stats.difficulty));
  const cells = tiers.map(([a, b]) => avg(a, b, (x) => x.w * x.h));
  const free = tiers.map(([a, b]) => avg(a, b, emptyCells));
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(d[i] > d[i - 1], `difficulty ${d.map((v) => v.toFixed(2)).join(' < ')}`);
    assert.ok(cells[i] >= cells[i - 1], `board size ${cells.map((v) => v.toFixed(1)).join(' <= ')}`);
    assert.ok(free[i] <= free[i - 1] + 0.01, `free cells ${free.map((v) => v.toFixed(2)).join(' >= ')}`);
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

test('endless levels 101..120 are valid, solvable, have a par and are deterministic', () => {
  for (let n = 101; n <= 120; n++) {
    const def = getLevel(n);
    assert.equal(def.id, n);
    assert.equal(def.hard === true, n % 10 === 0, `hard flag ${n}`);
    assert.equal(isHardLevel(n), n % 10 === 0);
    checkPlayable(def, `endless ${n}`);
    assert.equal(def.solution.length, def.par);
    assert.ok(typeof playStored(def) !== 'string', `endless ${n}: stored drags win`);
    assert.ok(solve(new Game(def), { maxNodes: 50000 }), `endless ${n} solved`);
    assert.deepEqual(getLevel(n), def, `endless ${n} is stable`);
  }
  for (const n of [103, 117]) {
    const fresh = generateLevel(levelParams(n), levelSeed(n));
    const def = getLevel(n);
    assert.deepEqual(def.cats, fresh.cats);
    assert.deepEqual(def.holes, fresh.holes);
    assert.deepEqual(def.grid, fresh.grid);
    assert.equal(def.par, fresh.par);
  }
});

test('level-data.js stays small', () => {
  const file = fileURLToPath(new URL('../../src/core/level-data.js', import.meta.url));
  const size = fs.statSync(file).size;
  assert.ok(size < 250 * 1024, `${(size / 1024).toFixed(1)} KB`);
});
