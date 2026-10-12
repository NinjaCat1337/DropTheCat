import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../../src/core/rules.js';
import { createSlide } from '../../src/ui/slide.js';

// 5×5 open board helper.
const open = (rows = 5, cols = 5) => Array.from({ length: rows }, () => '.'.repeat(cols));

test('dragging straight up drops the matching cats on the way and closes the hole', () => {
  const g = new Game({
    w: 5, h: 5, grid: open(),
    cats: [[2, 0, 0], [2, 1, 0], [2, 2, 0]],
    holes: [{ x: 2, y: 4, c: 0, cells: [[0, 0]], need: 3 }],
  });
  const s = createSlide(g, 0);
  const ev = s.moveToward(2, 3.6); // not past half-way: no step yet
  assert.equal(ev.length, 0);
  assert.equal(g.hy[0], 4);
  assert.ok(Math.abs(s.y - 3.6) < 1e-9);
  const ev2 = s.moveToward(2, -3);
  assert.deepEqual(ev2.filter((e) => e.type === 'drop').map((e) => e.y), [2, 1, 0]);
  assert.ok(ev2.some((e) => e.type === 'complete'));
  assert.ok(ev2.some((e) => e.type === 'win'));
  assert.equal(s.done, true);
  assert.equal(g.isWon(), true);
});

test('walls and other-coloured cats stop the hole; the game position stays the nearest legal cell', () => {
  const g = new Game({
    w: 5, h: 5, grid: ['.....', '..#..', '.....', '.....', '.....'],
    cats: [[4, 4, 1], [0, 0, 0]],
    holes: [{ x: 2, y: 4, c: 0, cells: [[0, 0]], need: 1 }, { x: 0, y: 4, c: 1, cells: [[0, 0]], need: 1 }],
  });
  const s = createSlide(g, 0);
  s.moveToward(2, -5);
  assert.equal(g.hy[0], 2); // the wall at (2,1) blocks
  assert.equal(s.y, 2);
  s.moveToward(9, 2); // right is free all the way
  assert.equal(g.hx[0], 4);
  const s2 = createSlide(g, 0);
  s2.moveToward(4, 9); // the orange cat at (4,4) blocks the red hole
  assert.equal(g.hy[0], 3);
});

test('mid-cell turn: the hole slides to the end of its segment that allows the turn (corner assist)', () => {
  // Row 2 is a corridor; the only way up is column 3.
  const g = new Game({
    w: 5, h: 5, grid: ['#####', '###.#', '.....', '#####', '#####'],
    cats: [[3, 1, 0]],
    holes: [{ x: 1, y: 2, c: 0, cells: [[0, 0]], need: 1 }],
  });
  const s = createSlide(g, 0);
  s.moveToward(2.6, 2); // mid-cell between columns 2 and 3 (game at 3)
  assert.equal(g.hx[0], 3);
  s.moveToward(2.6, 0); // finger goes up: the hole aligns on column 3, then goes up and collects the cat
  assert.equal(g.isWon(), true);
});

test('an axis-locked hole ignores the other direction', () => {
  const g = new Game({
    w: 5, h: 5, grid: open(),
    cats: [[4, 2, 0], [0, 0, 1]],
    holes: [{ x: 0, y: 2, c: 0, cells: [[0, 0], [1, 0]], need: 1, axis: 'h' }, { x: 0, y: 4, c: 1, cells: [[0, 0]], need: 1 }],
  });
  const s = createSlide(g, 0);
  s.moveToward(0, 0);
  assert.equal(g.hy[0], 2);
  assert.equal(s.y, 2);
  s.moveToward(5, 0);
  assert.equal(g.need[0], 0);
});

test('a two-cell hole needs both cells free; the slide reports its steps', () => {
  const g = new Game({
    w: 5, h: 5, grid: open(),
    cats: [[1, 1, 1], [4, 0, 0], [4, 1, 0]],
    holes: [{ x: 0, y: 3, c: 0, cells: [[0, 0], [1, 0]], need: 2 }, { x: 0, y: 4, c: 1, cells: [[0, 0]], need: 1 }],
  });
  const s = createSlide(g, 0);
  s.moveToward(0, 0); // (1,1) is an orange cat: the 2-wide hole stops at row 2
  assert.equal(g.hy[0], 2);
  assert.equal(s.steps, 1);
  s.moveToward(3, 2);
  s.moveToward(3, -1);
  assert.equal(g.need[0], 0);
});
