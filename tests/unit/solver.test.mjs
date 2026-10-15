// Hint solver (src/core/solver.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../../src/core/rules.js';
import { solve, hint, replay, applyPath, explorer, STEPS, minDrags, hasHungry } from '../../src/core/solver.js';
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

test('solves layered holes (each layer its own colour)', () => {
  const def = lvl(
    ['....', '....', '....'],
    [[1, 0, 0], [2, 0, 0], [3, 0, 5], [3, 1, 5], [0, 2, 3]],
    [
      { x: 0, y: 0, c: 0, cells: I1, need: 2, next: [[5, 2]] },
      { x: 0, y: 1, c: 3, cells: I1, need: 1 },
    ],
  );
  const g = new Game(def);
  const r = solve(g);
  assert.ok(r && wins(g, r.moves));
  assert.equal(explorer(g.L).unique, true);
});

test('unstall finds the slides that let someone eat on a packed board', () => {
  // Nobody can eat: the red bar needs to pass the blue one, which first has to step up into the gap.
  const def = lvl(
    ['##..##', '......'],
    [[4, 1, 0], [5, 1, 5]],
    [
      { x: 0, y: 1, c: 0, cells: [[0, 0], [1, 0]], need: 1 },
      { x: 2, y: 1, c: 5, cells: [[0, 0], [1, 0]], need: 1 },
    ],
  );
  const g = new Game(def);
  const ex = explorer(g.L);
  assert.equal(ex.productiveMoves(g).length, 0, 'a stall');
  const seq = ex.unstall(g);
  assert.deepEqual(seq[0], [1, 'U'], 'blue steps aside first');
  assert.ok(seq.length <= 4);
  const t = g.clone();
  for (const [k, ch] of seq) assert.ok(applyPath(t, k, ch));
  assert.ok(ex.productiveMoves(t).length > 0);
  const r = solve(g);
  assert.ok(r && wins(g, r.moves));
});

test('on levels with one hole per colour the solver wins from any reachable state', () => {
  // Random states: random productive drags mixed with random single slides of random holes.
  let seed = 7;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  for (const n of [6, 21, 47, 73, 98]) {
    const def = getLevel(n);
    const g0 = new Game(def);
    const ex = explorer(g0.L);
    assert.ok(ex.unique, `level ${n} has one hole per colour`);
    for (let trial = 0; trial < 6; trial++) {
      const g = g0.clone();
      const moves = Math.floor(rand() * 25);
      for (let i = 0; i < moves && !g.isWon(); i++) {
        if (rand() < 0.4) {
          const k = Math.floor(rand() * g.holeCount);
          const [dx, dy] = Object.values(STEPS)[Math.floor(rand() * 4)];
          if (g.canStep(k, dx, dy)) g.step(k, dx, dy, null);
          continue;
        }
        const mv = ex.productiveMoves(g);
        if (!mv.length) continue;
        const m = mv[Math.floor(rand() * mv.length)];
        applyPath(g, m.hole, m.path);
      }
      if (g.isWon()) continue;
      const r = solve(g, { maxNodes: 20000 });
      assert.ok(r, `level ${n} trial ${trial}`);
      assert.ok(wins(g, r.moves), `level ${n} trial ${trial} replays`);
    }
  }
});

/** Plays drags like the UI: endMove() after each; false when a hungry cat starves or a drag is illegal. */
function playDrags(game, moves) {
  const g = game.clone();
  for (const mv of moves) {
    if (!applyPath(g, mv.hole, mv.path)) return null;
    g.endMove(null);
    if (g.isFailed()) return null;
  }
  return g;
}

test('minDrags finds the fewest drags: a hole sweeps all its cats in one drag', () => {
  // The red hole can take its three cats in one continuous drag (through its own cats).
  const def = lvl(
    ['.....', '.....'],
    [[1, 0, 0], [2, 0, 0], [2, 1, 0], [4, 0, 5], [4, 1, 5]],
    [
      { x: 0, y: 0, c: 0, cells: I1, need: 3 },
      { x: 3, y: 0, c: 5, cells: [[0, 0], [0, 1]], need: 2 },
    ],
  );
  const g = new Game(def);
  const r = minDrags(g, { beam: 16 });
  assert.ok(r);
  assert.equal(r.drags, 2);
  assert.equal(r.moves.length, 2);
  assert.notEqual(r.moves[0].hole, r.moves[1].hole);
  assert.ok(playDrags(g, r.moves).isWon());
});

test('hints respect hungry cats: the right hole goes first, from the live move counter', () => {
  // Hole 0 (blue) comes first in a plain search, but the hungry red cat must be eaten in drag 1.
  const def = lvl(
    ['....', '....'],
    [[3, 0, 0, { hungry: 1 }], [1, 1, 5], [2, 1, 5]],
    [
      { x: 0, y: 1, c: 5, cells: I1, need: 2 },
      { x: 0, y: 0, c: 0, cells: I1, need: 1 },
    ],
  );
  const g = new Game(def);
  assert.ok(hasHungry(g));
  const h = hint(g);
  assert.equal(h.hole, 1, 'red first');
  const r = solve(g);
  assert.ok(r && playDrags(g, r.moves).isWon(), 'no cat starves');
  // Once the deadline has passed, there is no way to win.
  const late = g.clone();
  late.endMove(null);
  assert.equal(late.isFailed(), true);
  assert.equal(hint(late), null);
  // With one move used up but the cat still due in move 2, the hint still saves it.
  const def2 = { ...def, cats: [[3, 0, 0, { hungry: 2 }], [1, 1, 5], [2, 1, 5]] };
  const g2 = new Game(def2);
  g2.endMove(null);
  const h2 = hint(g2);
  assert.equal(h2.hole, 1);
});

test('solves levels with gates', () => {
  // Only red may pass the gate in the corridor; blue goes round.
  const def = lvl(
    ['.....', '.###.', '.....'],
    [[4, 0, 0], [4, 2, 5]],
    [
      { x: 0, y: 0, c: 0, cells: I1, need: 1 },
      { x: 0, y: 2, c: 5, cells: I1, need: 1 },
    ],
  );
  def.gates = [[2, 0, 0]];
  const g = new Game(def);
  const r = solve(g);
  assert.ok(r && wins(g, r.moves));
  const md = minDrags(g, { beam: 8 });
  assert.equal(md.drags, 2);
});
