// Behaviour of the game rules (src/core/rules.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel, Game, FLOOR, LOCK, WALL, VOID } from '../../src/core/rules.js';

/** Level definition from grid rows (w/h taken from them). */
function lvl(grid, cats, holes) {
  return { w: grid[0].length, h: grid.length, grid, cats, holes };
}

const I1 = [[0, 0]];
const types = (events) => events.map((e) => e.type);

test('compileLevel rejects broken definitions', () => {
  const ok = () => lvl(['...', '...'], [[1, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 1 }]);
  assert.doesNotThrow(() => compileLevel(ok()));
  const bad = (mutate, re) => {
    const def = ok();
    mutate(def);
    assert.throws(() => compileLevel(def), re);
  };
  assert.throws(() => compileLevel(null), /not an object/);
  bad((d) => (d.w = 0), /bad size/);
  bad((d) => (d.h = 17), /bad size/);
  bad((d) => d.grid.pop(), /grid must have/);
  bad((d) => (d.grid[1] = '..'), /must have 3 chars/);
  bad((d) => (d.grid[1] = '.x.'), /bad grid char/);
  bad((d) => (d.cats = [[5, 0, 0]]), /off board/);
  bad((d) => (d.grid[0] = '.#.') && (d.cats = [[1, 0, 0]]), /not on plain floor/);
  bad((d) => (d.cats = [[1, 0, 0], [1, 0, 0]]), /two cats/);
  bad((d) => (d.cats = [[1, 0, 12]]), /bad cat colour/);
  bad((d) => (d.grid[1] = '.L.'), /need at least one key/);
  bad((d) => (d.holes = []), /non-empty/);
  bad((d) => (d.holes[0].x = 3), /off board/);
  bad((d) => (d.grid[0] = '_..'), /not on plain floor/);
  bad((d) => (d.holes[0].x = 1), /starts on a cat/);
  bad((d) => d.holes.push({ x: 0, y: 0, c: 1, cells: I1, need: 1 }) && d.cats.push([2, 1, 1]), /overlap/);
  bad((d) => (d.holes[0].need = 2), /colour 0: 1 cat\(s\) but the holes need 2/);
  bad((d) => (d.holes[0].need = 0), /need must be/);
  bad((d) => (d.holes[0].cells = [[0, 0], [2, 0]]), /connected/);
  bad((d) => (d.holes[0].axis = 'x'), /bad axis/);
  bad((d) => (d.cats[0][3] = { box: 1, ice: 2 }), /both boxed and frozen/);
  bad((d) => (d.cats[0][3] = { ice: 1.5 }), /bad ice/);
});

test('compileLevel normalizes hole shapes and keeps the covered cells', () => {
  const L = compileLevel(lvl(['....', '....'], [[3, 1, 0]], [{ x: 1, y: 1, c: 0, cells: [[0, -1], [1, -1], [0, 0]], need: 1 }]));
  assert.deepEqual(L.holes[0].cells, [[0, 0], [1, 0], [0, 1]]);
  assert.equal(L.hole0.x[0], 1);
  assert.equal(L.hole0.y[0], 0);
  assert.equal(L.holes[0].bw, 2);
  assert.equal(L.holes[0].bh, 2);
});

test('a hole swallows cats of its colour, closes at its need, and the level is won', () => {
  const g = new Game(lvl(['....', '....'], [[1, 0, 0], [2, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 2 }]));
  assert.equal(g.catsLeft(), 2);
  assert.ok(g.canStep(0, 1, 0));
  let ev = g.step(0, 1, 0);
  assert.deepEqual(types(ev), ['drop']);
  assert.deepEqual({ x: ev[0].x, y: ev[0].y, c: ev[0].c, hole: ev[0].hole, left: ev[0].left }, { x: 1, y: 0, c: 0, hole: 0, left: 1 });
  assert.equal(g.catAt(1, 0), -1);
  assert.equal(g.isWon(), false);
  ev = g.step(0, 1, 0);
  assert.deepEqual(types(ev), ['drop', 'complete', 'win']);
  assert.equal(g.isWon(), true);
  assert.equal(g.isOpenHole(0), false);
  assert.equal(g.canStep(0, 1, 0), false, 'a closed hole never moves');
  assert.ok(Array.from(g.holeAt).every((v) => v === -1), 'a closed hole leaves the board');
  assert.equal(g.dropped, 2);
});

test('holes are blocked by other cats, walls, void, the edge and other holes', () => {
  const g = new Game(
    lvl(
      ['..#', '._.', '...'],
      [[1, 0, 5], [2, 2, 0]],
      [
        { x: 0, y: 0, c: 0, cells: I1, need: 1 },
        { x: 0, y: 1, c: 5, cells: I1, need: 1 },
      ],
    ),
  );
  assert.equal(g.canStep(0, 1, 0), false, 'blue cat');
  assert.equal(g.canStep(0, -1, 0), false, 'edge');
  assert.equal(g.canStep(0, 0, 1), false, 'other hole');
  assert.equal(g.canStep(1, 1, 0), false, 'void');
  assert.equal(g.ground(2, 0), WALL);
  assert.equal(g.ground(1, 1), VOID);
  assert.equal(g.ground(-1, 0), VOID);
  assert.equal(g.ground(0, 2), FLOOR);
  // blue hole: up into the cell of the red hole is blocked, down is free
  assert.equal(g.canStep(1, 0, -1), false);
  assert.ok(g.canStep(1, 0, 1));
});

test('collect drops in cell order and stops when the hole is full', () => {
  const def = lvl(
    ['...', '...', '...'],
    [[0, 0, 0], [1, 0, 0], [2, 2, 0]],
    [
      { x: 0, y: 1, c: 0, cells: [[0, 0], [1, 0]], need: 1 },
      { x: 2, y: 0, c: 0, cells: I1, need: 2 },
    ],
  );
  const g = new Game(def);
  const ev = g.step(0, 0, -1);
  assert.deepEqual(types(ev), ['drop', 'complete']);
  assert.equal(ev[0].x, 0, 'first cell of the shape first');
  assert.equal(g.catAt(1, 0), 0, 'the second cat stays');
  assert.equal(g.isOpenHole(0), false);
  // the other red hole takes the rest
  g.step(1, -1, 0);
  assert.equal(g.catAt(1, 0), -1);
  g.step(1, 1, 0);
  g.step(1, 0, 1);
  const last = g.step(1, 0, 1);
  assert.deepEqual(types(last), ['drop', 'complete', 'win']);
});

test('a boxed cat blocks every hole until a cat next to it drops', () => {
  const g = new Game(
    lvl(['....', '....'], [[1, 0, 0], [2, 0, 5, { box: 1 }]], [
      { x: 0, y: 0, c: 0, cells: I1, need: 1 },
      { x: 3, y: 0, c: 5, cells: I1, need: 1 },
    ]),
  );
  assert.equal(g.isBoxed(2, 0), true);
  assert.equal(g.catAt(2, 0), 5, 'catAt reports the real colour');
  assert.equal(g.canStep(1, -1, 0), false, 'boxed: blue cannot swallow it yet');
  const ev = g.step(0, 1, 0);
  assert.deepEqual(types(ev), ['drop', 'reveal', 'complete']);
  assert.deepEqual(ev[1], { type: 'reveal', x: 2, y: 0, c: 5 });
  assert.equal(g.isBoxed(2, 0), false);
  assert.ok(g.canStep(1, -1, 0));
  assert.deepEqual(types(g.step(1, -1, 0)), ['drop', 'complete', 'win']);
});

test('a frozen cat blocks every hole until enough other cats dropped', () => {
  const g = new Game(
    lvl(['...', '...'], [[1, 0, 0], [2, 0, 0], [1, 1, 5, { ice: 2 }]], [
      { x: 0, y: 0, c: 0, cells: I1, need: 2 },
      { x: 0, y: 1, c: 5, cells: I1, need: 1 },
    ]),
  );
  assert.equal(g.iceAt(1, 1), 2);
  assert.equal(g.canStep(1, 1, 0), false);
  let ev = g.step(0, 1, 0);
  assert.deepEqual(types(ev), ['drop', 'ice']);
  assert.deepEqual(ev[1], { type: 'ice', x: 1, y: 1, left: 1 });
  assert.equal(g.canStep(1, 1, 0), false);
  ev = g.step(0, 1, 0);
  assert.deepEqual(types(ev), ['drop', 'melt', 'complete']);
  assert.deepEqual(ev[1], { type: 'melt', x: 1, y: 1, c: 5 });
  assert.equal(g.iceAt(1, 1), 0);
  assert.deepEqual(types(g.step(1, 1, 0)), ['drop', 'complete', 'win']);
});

test('locked crates block holes until the key cat drops', () => {
  const g = new Game(
    lvl(['.L..', '....'], [[2, 0, 5], [1, 1, 0, { key: 1 }]], [
      { x: 0, y: 0, c: 5, cells: I1, need: 1 },
      { x: 0, y: 1, c: 0, cells: I1, need: 1 },
    ]),
  );
  assert.equal(g.ground(1, 0), LOCK);
  assert.equal(g.locked, true);
  assert.equal(g.hasKey(1, 1), true);
  assert.equal(g.canStep(0, 1, 0), false);
  const ev = g.step(1, 1, 0);
  assert.deepEqual(types(ev), ['drop', 'unlock', 'complete']);
  assert.equal(ev[0].key, true);
  assert.deepEqual(ev[1].cells, [[1, 0]]);
  assert.equal(g.ground(1, 0), FLOOR);
  assert.ok(g.canStep(0, 1, 0));
  g.step(0, 1, 0);
  assert.deepEqual(types(g.step(0, 1, 0)), ['drop', 'complete', 'win']);
});

test('axis-locked holes only slide along their axis', () => {
  const g = new Game(
    lvl(['...', '...', '...'], [[2, 0, 0], [0, 2, 5]], [
      { x: 0, y: 0, c: 0, cells: I1, need: 1, axis: 'h' },
      { x: 2, y: 2, c: 5, cells: I1, need: 1, axis: 'v' },
    ]),
  );
  assert.equal(g.holeAxis(0), 'h');
  assert.equal(g.canStep(0, 0, 1), false);
  assert.ok(g.canStep(0, 1, 0));
  assert.equal(g.canStep(1, -1, 0), false);
  assert.ok(g.canStep(1, 0, -1));
  // the vertical hole can never reach its cat
  assert.equal(g.canEverCollect(1), false);
  assert.equal(g.canEverCollect(0), true);
});

test('treat pulls the nearest active cats of the colour into the hole', () => {
  const g = new Game(
    lvl(['....', '....', '....', '....'], [[3, 0, 0], [0, 3, 0], [2, 2, 0], [1, 0, 0, { box: 1 }], [2, 1, 5], [3, 3, 5]], [
      { x: 0, y: 0, c: 0, cells: I1, need: 3 },
      { x: 1, y: 3, c: 5, cells: I1, need: 2 },
      { x: 3, y: 2, c: 0, cells: I1, need: 1 },
    ]),
  );
  const ev = g.treat(0);
  const drops = ev.filter((e) => e.type === 'drop');
  assert.equal(drops.length, 3);
  assert.ok(drops.every((e) => e.fly === true && e.hole === 0));
  assert.deepEqual(drops.map((e) => [e.x, e.y]), [[2, 2], [3, 0], [0, 3]], 'nearest first, the boxed cat is skipped');
  assert.equal(g.isOpenHole(0), false);
  assert.equal(g.catAt(1, 0), 0, 'the boxed cat is still there');
  assert.deepEqual(g.treat(0), [], 'a closed hole gets no treat');
});

test('treat stops when no active cat of the colour is left', () => {
  const g = new Game(lvl(['...'], [[2, 0, 0, { ice: 3 }], [1, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 2 }]));
  const ev = g.treat(0);
  assert.equal(ev.filter((e) => e.type === 'drop').length, 1);
  assert.equal(g.need[0], 1);
});

test('isStuck: no hole can ever reach a cat it could swallow', () => {
  const walled = new Game(lvl(['.#.'], [[2, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 1 }]));
  assert.equal(walled.isStuck(), true);
  const open = new Game(lvl(['...'], [[2, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 1 }]));
  assert.equal(open.isStuck(), false);
  open.step(0, 1, 0);
  open.step(0, 1, 0);
  assert.equal(open.isWon(), true);
  assert.equal(open.isStuck(), false, 'a won game is not stuck');
  // A cat of another colour walls it in for good: its own hole is walled off.
  const blocked = new Game(
    lvl(['...', '##.'], [[1, 0, 5], [2, 0, 0]], [
      { x: 0, y: 0, c: 0, cells: I1, need: 1 },
      { x: 2, y: 1, c: 5, cells: I1, need: 1, axis: 'v' },
    ]),
  );
  assert.equal(blocked.canEverCollect(1), false);
  assert.equal(blocked.isStuck(), true);
});

test('canEverCollect ignores other holes but not cats', () => {
  const g = new Game(
    lvl(['....'], [[3, 0, 0], [2, 0, 5]], [
      { x: 0, y: 0, c: 0, cells: I1, need: 1 },
      { x: 1, y: 0, c: 5, cells: I1, need: 1 },
    ]),
  );
  assert.equal(g.canEverCollect(0), false, 'the blue cat is in the way');
  assert.equal(g.canEverCollect(1), true);
  g.step(1, 1, 0);
  assert.equal(g.canEverCollect(0), true);
});

test('clone, snapshot/restore and stateKey', () => {
  const g = new Game(lvl(['....'], [[2, 0, 0], [3, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 2 }]));
  const key0 = g.stateKey();
  const c = g.clone();
  assert.equal(c.stateKey(), key0);
  c.step(0, 1, 0);
  assert.notEqual(c.stateKey(), key0);
  assert.equal(g.stateKey(), key0, 'the original is untouched');
  const snap = g.snapshot();
  g.step(0, 1, 0);
  g.step(0, 1, 0);
  assert.equal(g.catAt(2, 0), -1);
  g.restore(snap);
  assert.equal(g.stateKey(), key0);
  assert.equal(g.catAt(2, 0), 0);
  assert.equal(g.holeAt[0], 0);
});

test('toJSON / fromJSON round trip and validation', () => {
  const def = lvl(['....', '.L..'], [[2, 0, 0], [3, 0, 0, { ice: 1 }], [0, 1, 5, { key: 1 }], [2, 1, 5, { box: 1 }]], [
    { x: 0, y: 0, c: 0, cells: I1, need: 2 },
    { x: 3, y: 1, c: 5, cells: I1, need: 2 },
  ]);
  const g = new Game(def);
  g.step(0, 1, 0);
  g.step(0, 1, 0);
  const data = JSON.parse(JSON.stringify(g.toJSON()));
  const back = Game.fromJSON(def, data);
  assert.ok(back);
  assert.equal(back.stateKey(), g.stateKey());
  assert.equal(back.iceAt(3, 0), g.iceAt(3, 0));
  assert.equal(back.locked, g.locked);
  // Both continue identically.
  for (const game of [g, back]) {
    game.step(0, 1, 0);
  }
  assert.equal(back.stateKey(), g.stateKey());
  assert.equal(Game.fromJSON(def, null), null);
  assert.equal(Game.fromJSON(def, { ...data, v: 2 }), null);
  assert.equal(Game.fromJSON(def, { ...data, color: data.color.slice(1) }), null, 'wrong size');
  const ghost = data.color.slice();
  ghost[1] = 0; // a cat where there never was one
  assert.equal(Game.fromJSON(def, { ...data, color: ghost }), null);
  const need = data.need.slice();
  need[0] = 9;
  assert.equal(Game.fromJSON(def, { ...data, need }), null, 'impossible need');
  assert.equal(Game.fromJSON(def, { ...data, hx: [1, 1], hy: [0, 0], need: [1, 2] }), null, 'holes overlapping / on a cat');
  assert.equal(Game.fromJSON(def, { ...data, hx: [9, 3] }), null, 'off board');
});

test('Game accepts a compiled level and shares it between clones', () => {
  const L = compileLevel(lvl(['..'], [[1, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 1 }]));
  const g = new Game(L);
  assert.equal(g.L, L);
  assert.equal(g.clone().L, L);
  assert.equal(g.w, 2);
  assert.equal(g.h, 1);
  assert.equal(g.holeCount, 1);
  assert.equal(g.holeColor(0), 0);
  assert.deepEqual(g.holeCells(0), [[0, 0]]);
  assert.ok(g.step(0, 1, 0, null) === null, 'null events skip event objects');
  assert.equal(g.isWon(), true);
});

// ---------------------------------------------------------------------------------------------------------
// Layered holes and the 12 colours
// ---------------------------------------------------------------------------------------------------------

/** A 2-layer hole (red, then blue) and a lime hole on a 4×3 board. */
function layered() {
  return lvl(
    ['....', '....', '....'],
    [[1, 0, 0], [2, 0, 0], [3, 0, 5], [3, 1, 5], [0, 2, 3]],
    [
      { x: 0, y: 0, c: 0, cells: I1, need: 2, next: [[5, 2]] },
      { x: 0, y: 1, c: 3, cells: I1, need: 1 },
    ],
  );
}

test('compileLevel checks layered holes and accepts colours up to 11', () => {
  assert.doesNotThrow(() => compileLevel(layered()));
  const L = compileLevel(layered());
  assert.deepEqual(L.holes[0].layers, [{ c: 0, need: 2 }, { c: 5, need: 2 }]);
  const bad = (mutate, re) => {
    const def = layered();
    mutate(def);
    assert.throws(() => compileLevel(def), re);
  };
  bad((d) => (d.holes[0].next = [[5]]), /a layer must be \[colour, need\]/);
  bad((d) => (d.holes[0].next = 'x'), /bad next layers/);
  bad((d) => (d.holes[0].next = [[12, 2]]), /bad layer colour/);
  bad((d) => (d.holes[0].next = [[5, 0]]), /layer need must be/);
  bad((d) => (d.holes[0].next = [[5, 3]]), /colour 5: 2 cat\(s\) but the holes need 3/);
  // A layered colour belongs to that hole alone, once.
  bad((d) => d.holes.push({ x: 1, y: 2, c: 5, cells: I1, need: 1 }) && d.cats.push([2, 2, 5]), /must belong to this hole alone/);
  bad((d) => (d.holes[0].next = [[5, 2], [0, 1]]) && d.cats.push([2, 2, 0]), /must belong to this hole alone/);
  // Colours 8..11 exist; 12 does not.
  const wide = lvl(['...'], [[1, 0, 11], [2, 0, 8]], [{ x: 0, y: 0, c: 11, cells: I1, need: 1, next: [[8, 1]] }]);
  assert.doesNotThrow(() => compileLevel(wide));
  assert.throws(() => compileLevel(lvl(['..'], [[1, 0, 12]], [{ x: 0, y: 0, c: 12, cells: I1, need: 1 }])), /bad (cat|hole)/);
});

test('a layered hole turns its next colour when a layer is full, then closes after the last one', () => {
  const g = new Game(layered());
  assert.equal(g.holeColor(0), 0);
  assert.equal(g.holeLayer(0), 0);
  assert.deepEqual(g.holeNext(0), [5]);
  assert.equal(g.canStep(0, 0, 1), false, 'the lime hole is below it');
  g.step(0, 1, 0);
  const ev = g.step(0, 1, 0);
  assert.deepEqual(types(ev), ['drop', 'layer']);
  assert.deepEqual(ev[1], { type: 'layer', hole: 0, c: 5, prev: 0, need: 2, hx: 2, hy: 0 });
  assert.equal(g.holeColor(0), 5);
  assert.equal(g.holeLayer(0), 1);
  assert.deepEqual(g.holeNext(0), []);
  assert.equal(g.isOpenHole(0), true);
  assert.equal(g.need[0], 2);
  // Now it takes blue cats (it could not step onto them while red).
  assert.deepEqual(types(g.step(0, 1, 0)), ['drop']);
  assert.deepEqual(types(g.step(0, 0, 1)), ['drop', 'complete']);
  assert.equal(g.isOpenHole(0), false);
  g.step(1, 0, 1);
  assert.equal(g.isWon(), true);
});

test('layers are part of the state: stateKey, snapshot/restore, toJSON/fromJSON', () => {
  const def = layered();
  const g = new Game(def);
  g.step(0, 1, 0);
  const before = g.stateKey();
  const snap = g.snapshot();
  g.step(0, 1, 0); // finishes the red layer
  assert.notEqual(g.stateKey(), before);
  const data = JSON.parse(JSON.stringify(g.toJSON()));
  assert.deepEqual(data.layer, [1, 0]);
  const back = Game.fromJSON(def, data);
  assert.ok(back);
  assert.equal(back.holeColor(0), 5);
  assert.equal(back.stateKey(), g.stateKey());
  assert.equal(Game.fromJSON(def, { ...data, layer: [2, 0] }), null, 'no such layer');
  assert.equal(Game.fromJSON(def, { ...data, layer: [0, 0], need: [0, 1] }), null, 'a finished first layer must have moved on');
  assert.equal(Game.fromJSON(def, { ...data, need: [3, 1] }), null, 'more than the layer needs');
  // Saves from before layers existed (no layer field) load as first layers.
  const early = new Game(def);
  early.step(0, 1, 0);
  const old = JSON.parse(JSON.stringify(early.toJSON()));
  delete old.layer;
  const loaded = Game.fromJSON(def, old);
  assert.ok(loaded);
  assert.equal(loaded.holeLayer(0), 0);
  assert.equal(loaded.stateKey(), early.stateKey());
  g.restore(snap);
  assert.equal(g.stateKey(), before);
  assert.equal(g.holeColor(0), 0);
});

test('treat fills the current layer only', () => {
  const g = new Game(layered());
  const ev = g.treat(0);
  assert.deepEqual(types(ev), ['drop', 'drop', 'layer']);
  assert.ok(ev.slice(0, 2).every((e) => e.c === 0 && e.fly));
  assert.equal(g.holeColor(0), 5);
  assert.equal(g.need[0], 2);
  assert.equal(g.catAt(3, 0), 5, 'the blue cats wait for another treat or a drag');
});

test('canEverCollect and isStuck use the current layer colour', () => {
  const g = new Game(layered());
  assert.equal(g.canEverCollect(0), true);
  g.step(0, 1, 0);
  g.step(0, 1, 0);
  assert.equal(g.canEverCollect(0), true, 'blue cats are next to it now');
  assert.equal(g.isStuck(), false);
});
