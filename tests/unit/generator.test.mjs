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
  verifyDrags,
  difficulty,
  randomSolve,
  fiddleBudget,
  targetDifficulty,
  isHard,
  mosaic,
  INTRO,
} from '../../src/core/generator.js';
import { solve, explorer } from '../../src/core/solver.js';

const QUICK = { candidates: 2, playouts: 6, parBeam: 8 };

/** Empty floor cells at the start (gates and crates are not empty). */
function emptyCells(def) {
  const used = new Set(def.cats.map(([x, y]) => y * def.w + x));
  for (const hole of def.holes) for (const [dx, dy] of hole.cells) used.add((hole.y + dy) * def.w + hole.x + dx);
  for (const [x, y] of def.gates || []) used.add(y * def.w + x);
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
    assert.ok(hole.cells.length <= 5, `${label}: at most pentominoes`);
    colours.push(hole.c);
    for (const [c, need] of hole.next || []) {
      assert.equal(need, hole.cells.length, `${label}: every layer needs as many cats as the hole has cells`);
      colours.push(c);
    }
  }
  assert.equal(new Set(colours).size, colours.length, `${label}: one hole per colour (layers included)`);
  assert.ok(colours.length <= MAX_COLORS, `${label}: colours`);
  const empty = emptyCells(def);
  assert.ok(empty >= 1 && empty <= 4, `${label}: ${empty} empty cells`);
  assert.equal(def.par, def.solution.length, `${label}: one stored drag per par`);
  for (let i = 1; i < def.solution.length; i++) assert.notEqual(def.solution[i][0], def.solution[i - 1][0], `${label}: drags alternate holes`);
  assert.ok(verifySolution(def, def.solution), `${label}: stored solution wins`);
  assert.ok(verifyDrags(def, def.solution), `${label}: and with endMove after every drag`);
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

test('generated levels are packed mosaics with one hole per colour and a par', () => {
  const sets = [
    { w: 4, h: 6, holes: 4, openers: 3 },
    { w: 5, h: 7, holes: 5, layered: 1 },
    { w: 6, h: 9, holes: 7, layered: 2, palette: 10, maxColors: 10, empty: [1, 2] },
    { w: 7, h: 10, holes: 6, layered: 3, layers3: 0.5, palette: 12, maxColors: 11, empty: [1, 2] },
    { w: 99, h: 99, holes: 8, layered: 2, palette: 10 }, // clamped to 7×10
  ];
  sets.forEach((P, i) => {
    for (const seed of [1, 2]) {
      const def = generateLevel({ ...P, ...QUICK }, seed * 7919 + i);
      checkDesign(def, `set ${i} seed ${seed}`);
      assert.ok(def.par >= def.holes.length, `set ${i}: every hole needs a drag`);
      assert.ok(def.stats && def.stats.steps > 0, `set ${i}: stats`);
    }
  });
});

test('narrow passages, gates and pentominoes', () => {
  const fence = generateLevel({ w: 6, h: 9, holes: 6, layered: 1, fence: true, gates: 1, shapes: { I2: 2, L3: 2, P5: 2, U5: 1 }, ...QUICK }, 21);
  checkDesign(fence, 'fence');
  assert.ok(fence.grid.some((r) => r.includes('#')), 'a wall line');
  assert.equal(fence.gates.length, 1);
  const [gx, gy, gc] = fence.gates[0];
  assert.equal(fence.grid[gy][gx], '.');
  const owner = fence.holes.filter((h) => h.c === gc);
  assert.equal(owner.length, 1, 'the gate colour belongs to one hole');
  assert.ok(!owner[0].next, 'a single-layer hole');
  assert.ok(fence.holes.some((h) => h.cells.length === 5), 'a pentomino hole');
  const split = generateLevel({ w: 7, h: 9, holes: 7, layered: 2, split: true, gates: 2, ...QUICK }, 22);
  checkDesign(split, 'split');
  assert.equal(split.gates.length, 2);
});

test('hungry cats get deadlines from the par line', () => {
  const def = generateLevel({ w: 6, h: 8, holes: 6, layered: 1, hungry: 2, hungrySlack: 2, ...QUICK }, 31);
  checkDesign(def, 'hungry');
  const hungry = def.cats.filter((c) => c[3] && c[3].hungry);
  assert.equal(hungry.length, 2);
  // Each one is eaten in time by the stored drags (verifyDrags), and not frozen or boxed.
  for (const cat of hungry) assert.deepEqual(Object.keys(cat[3]), ['hungry']);
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
  assert.ok(ev.fail >= 0 && ev.fail <= 1 && ev.shuffle >= 0 && ev.shuffle <= 1);
  assert.equal(ev.difficulty, difficulty({ ...st, fail: ev.fail, shuffle: ev.shuffle }));
  assert.equal(ev.cats, def.cats.length);
  assert.equal(ev.holes, def.holes.length);
  assert.ok(ev.mosaic >= 0 && ev.mosaic <= 1);
  assert.equal(mosaic({ w: 2, h: 1, cats: [[0, 0, 1], [1, 0, 1]] }), 1);
  assert.equal(mosaic({ w: 2, h: 1, cats: [[0, 0, 1], [1, 0, 2]] }), 0);
});

test('random solve: how often fiddling wins within the drag budget', () => {
  const easy = { id: 1, w: 4, h: 2, grid: ['....', '....'], cats: [[2, 0, 0], [3, 0, 0], [2, 1, 2], [3, 1, 2]], holes: [{ x: 0, y: 0, c: 0, cells: [[0, 0], [1, 0]], need: 2 }, { x: 0, y: 1, c: 2, cells: [[0, 0], [1, 0]], need: 2 }] };
  const rs = randomSolve(easy, 12, 5, fiddleBudget(2));
  assert.equal(rs.fail, 0, 'a trivial level is solved by fiddling');
  assert.ok(rs.median >= 2 && rs.median <= 10);
  assert.deepEqual(randomSolve(easy, 12, 5, 10), randomSolve(easy, 12, 5, 10), 'deterministic');
  assert.equal(fiddleBudget(30), 60);
  assert.equal(fiddleBudget(4), 20);
});

test('the campaign curve: hard from the start, one new thing per intro level, no gates', () => {
  let last = -1;
  for (let n = 4; n <= 100; n++) {
    const t = targetDifficulty(n);
    assert.ok(t >= last - 1e-9, `target(${n})`);
    last = t;
  }
  assert.ok(targetDifficulty(4) >= 6, 'hard from level 4 on');
  assert.ok(targetDifficulty(100) > targetDifficulty(4) + 3, 'and rising');
  const has = {
    layers: (P) => P.layered > 0,
    walls: (P) => P.fence || P.split || P.walls > 0,
    pentomino: (P) => Object.keys(P.shapes).some((s) => s.endsWith('5')),
    ice: (P) => P.ice > 0,
    box: (P) => P.box > 0,
    hungry: (P) => P.hungry > 0,
    axis: (P) => P.axis > 0,
    lock: (P) => P.lock > 0,
  };
  for (const [name, at] of Object.entries(INTRO)) {
    let first = 0;
    for (let n = 4; n <= 100 && !first; n++) if (has[name](levelParams(n))) first = n;
    assert.equal(first, at, `${name} first on level ${at}`);
    const P = levelParams(at);
    assert.equal(P.intro, name);
    assert.ok(P.target[1] < targetDifficulty(at), `intro ${at} is gentle`);
    for (const [other, test2] of Object.entries(has)) {
      if (other === name || INTRO[other] > at || other === 'layers' || other === 'pentomino') continue;
      assert.ok(!test2(P), `intro ${at} (${name}) shows nothing else new: ${other}`);
    }
  }
  for (let n = 4; n <= 160; n++) {
    const P = levelParams(n);
    assert.deepEqual(levelParams(n), P, `deterministic ${n}`);
    assert.equal(P.id, n);
    assert.equal(P.hard, n % 10 === 0);
    assert.equal(isHard(n), n % 10 === 0);
    assert.ok(P.w <= 7 && P.h <= 10, `size ${n}`);
    assert.ok(P.holes + P.layered <= P.maxColors && P.maxColors <= MAX_COLORS, `colours ${n}`);
    assert.ok(!P.gates, `no gates on level ${n}`);
    assert.equal(P.openers, 1, `one hole can eat at the start of level ${n}`);
    assert.ok(P.empty[1] <= (n <= 9 ? 2 : 1), `level ${n}: one free cell (two on a few early levels)`);
    if (P.hard && n >= 20) {
      assert.ok(P.empty[1] <= 2 && P.openers === 1, `hard ${n} is tight`);
      assert.ok(P.target[0] > levelParams(n - 1).target[1], `hard ${n} aims higher`);
    }
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
