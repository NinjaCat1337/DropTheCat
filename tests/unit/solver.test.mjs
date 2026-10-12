// Hint solver (src/core/solver.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../../src/core/rules.js';
import { solve, hint, replay, applyPath, explorer, STEPS } from '../../src/core/solver.js';
import { getLevel, LEVEL_COUNT } from '../../src/core/levels.js';

const I1 = [[0, 0]];
const O4 = [[0, 0], [1, 0], [0, 1], [1, 1]];

function lvl(grid, cats, holes) {
  return { w: grid[0].length, h: grid.length, grid, cats, holes };
}

/** Replays moves one cell at a time with canStep/step; true when the level ends won. */
function wins(game, moves) {
  const end = replay(game, moves);
  return !!end && end.isWon();
}

test('one drag wins the first tutorial', () => {
  const g = new Game(lvl(['.....', '.....', '.....', '.....', '.....', '.....'], [[2, 2, 0], [2, 3, 0], [2, 4, 0]], [{ x: 2, y: 5, c: 0, cells: I1, need: 3 }]));
  const r = solve(g);
  assert.ok(r);
  assert.deepEqual(r.moves, [{ hole: 0, path: 'UUU' }]);
  assert.ok(r.nodes >= 0);
});

test('clears the blocking row first', () => {
  const def = lvl(
    ['.....', '.....', '.....', '.....', '.....', '.....'],
    [[1, 1, 0], [2, 1, 0], [3, 1, 0], [0, 2, 5], [1, 2, 5], [2, 2, 5], [3, 2, 5], [4, 2, 5]],
    [
      { x: 2, y: 5, c: 0, cells: I1, need: 3 },
      { x: 0, y: 3, c: 5, cells: I1, need: 5 },
    ],
  );
  const g = new Game(def);
  const r = solve(g);
  assert.ok(r);
  assert.equal(r.moves[0].hole, 1, 'the blue hole has to go first');
  assert.ok(wins(g, r.moves));
});

test('paths end exactly where their hole closes and every drag is legal', () => {
  const def = lvl(
    ['......', '......', '......', '......'],
    [[1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0], [0, 2, 5], [1, 2, 5]],
    [
      { x: 0, y: 0, c: 0, cells: I1, need: 4 },
      { x: 0, y: 3, c: 5, cells: [[0, 0], [1, 0]], need: 2 },
    ],
  );
  const g = new Game(def);
  const r = solve(g);
  assert.ok(r);
  const t = g.clone();
  for (const mv of r.moves) {
    assert.ok(mv.path.length > 0);
    for (let i = 0; i < mv.path.length; i++) {
      assert.ok(t.isOpenHole(mv.hole), 'no letters after the hole closed');
      const [dx, dy] = STEPS[mv.path[i]];
      assert.ok(t.canStep(mv.hole, dx, dy));
      t.step(mv.hole, dx, dy, null);
    }
  }
  assert.ok(t.isWon());
});

test('solve does not modify the game it is given', () => {
  const g = new Game(lvl(['....'], [[2, 0, 0], [3, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 2 }]));
  const key = g.stateKey();
  solve(g);
  hint(g);
  assert.equal(g.stateKey(), key);
});

test('picks the hole that fits: the small hole must keep its need for the narrow pocket', () => {
  // (1,0) is a pocket only the 1×1 hole fits into; the 2×2 hole must swallow the two cats in the open.
  const def = lvl(
    ['#.###', '.....', '.....', '.....'],
    [[1, 0, 0], [1, 1, 0], [2, 1, 0]],
    [
      { x: 0, y: 3, c: 0, cells: I1, need: 1 },
      { x: 3, y: 2, c: 0, cells: O4, need: 2 },
    ],
  );
  const g = new Game(def);
  const r = solve(g);
  assert.ok(r);
  assert.equal(r.moves[0].hole, 1, 'the big hole goes first');
  assert.ok(wins(g, r.moves));
  // Swallowing an open cat with the small hole is a dead end the solver recognizes.
  const bad = g.clone();
  assert.ok(applyPath(bad, 0, 'UUR'));
  assert.equal(bad.isOpenHole(0), false);
  assert.equal(explorer(bad.L).feasible(bad), false);
  assert.equal(solve(bad), null);
});

test('moves a hole out of the way when two holes block each other in a corridor', () => {
  // Each hole has to get past the other; only the side pocket at (2,0) lets them.
  const def = lvl(
    ['##.###', '......', '######'],
    [[5, 1, 0], [0, 1, 5]],
    [
      { x: 1, y: 1, c: 0, cells: I1, need: 1 },
      { x: 4, y: 1, c: 5, cells: I1, need: 1 },
    ],
  );
  const g = new Game(def);
  assert.equal(explorer(g.L).productiveMoves(g).length, 0, 'nothing can be swallowed at the start');
  const r = solve(g);
  assert.ok(r);
  assert.ok(wins(g, r.moves));
  const first = hint(g);
  assert.ok(first);
  const t = g.clone();
  assert.ok(applyPath(t, first.hole, first.path));
  assert.equal(t.catsLeft(), 2, 'the first drag only makes room');
});

test('returns null when the level cannot be won', () => {
  const walled = new Game(lvl(['.#.'], [[2, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 1 }]));
  assert.equal(solve(walled), null);
  assert.equal(hint(walled), null);
  // Two horizontal-only red holes: the one in row 2 can never reach a cat in row 0.
  const holes = [
    { x: 0, y: 0, c: 0, cells: I1, need: 1, axis: 'h' },
    { x: 2, y: 2, c: 0, cells: I1, need: 1, axis: 'h' },
  ];
  assert.equal(solve(new Game(lvl(['...', '...', '...'], [[1, 0, 0], [2, 0, 0]], holes))), null);
  assert.ok(solve(new Game(lvl(['...', '...', '...'], [[2, 0, 0], [0, 2, 0]], holes))), 'one cat in each row is fine');
});

test('a won game needs no moves; hint is null', () => {
  const g = new Game(lvl(['..'], [[1, 0, 0]], [{ x: 0, y: 0, c: 0, cells: I1, need: 1 }]));
  g.step(0, 1, 0, null);
  assert.deepEqual(solve(g), { moves: [], nodes: 0 });
  assert.equal(hint(g), null);
});

test('respects the node budget', () => {
  const def = lvl(
    ['......', '......', '......'],
    [[1, 0, 0], [3, 0, 0], [5, 0, 0], [1, 2, 5], [3, 2, 5], [5, 2, 5]],
    [
      { x: 0, y: 0, c: 0, cells: I1, need: 2 },
      { x: 0, y: 1, c: 0, cells: I1, need: 1 },
      { x: 0, y: 2, c: 5, cells: I1, need: 3 },
    ],
  );
  const g = new Game(def);
  assert.equal(solve(g, { maxNodes: 1 }), null);
  const r = solve(g);
  assert.ok(r && wins(g, r.moves));
});

test('solves pack levels from the start and from states along their stored solution', () => {
  for (const n of [5, 18, 33, 47, 60, 77, 92, LEVEL_COUNT]) {
    const def = getLevel(n);
    const g = new Game(def);
    const t0 = performance.now();
    const r = solve(g);
    const ms = performance.now() - t0;
    assert.ok(r, `level ${n} solved`);
    assert.ok(wins(g, r.moves), `level ${n} solution replays`);
    assert.ok(ms < 5000, `level ${n} solved in ${ms.toFixed(0)} ms`);
    // Halfway through the stored solution, the hint still leads to a win.
    const half = def.solution.slice(0, Math.floor(def.solution.length / 2));
    const mid = replay(g, half);
    assert.ok(mid);
    const h = solve(mid);
    assert.ok(h && wins(mid, h.moves), `level ${n} mid-game`);
    const first = hint(mid);
    assert.deepEqual(first, h.moves[0]);
  }
});

test('typical late-level hints are fast', () => {
  const times = [];
  for (let n = 60; n <= LEVEL_COUNT; n++) {
    const g = new Game(getLevel(n));
    const t0 = performance.now();
    assert.ok(hint(g), `level ${n}`);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1];
  assert.ok(median < 150, `median hint ${median.toFixed(1)} ms`);
});
