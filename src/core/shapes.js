// Polyomino shapes for holes. A shape is an array of [dx, dy] cells, normalized so that the smallest dx and
// dy are 0 and sorted by row, then column. Pure; importable by Node and the browser.

/** Shifts cells so min dx = min dy = 0 and sorts them by (dy, dx). Returns a new array. */
export function normalize(cells) {
  let mx = Infinity;
  let my = Infinity;
  for (const [x, y] of cells) {
    if (x < mx) mx = x;
    if (y < my) my = y;
  }
  return cells.map(([x, y]) => [x - mx, y - my]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** Quarter turn clockwise (normalized). */
export function rotate(cells) {
  return normalize(cells.map(([x, y]) => [-y, x]));
}

/** Horizontal mirror (normalized). */
export function mirror(cells) {
  return normalize(cells.map(([x, y]) => [-x, y]));
}

/** Stable string id of a normalized shape, e.g. "0,0;1,0". */
export function shapeKey(cells) {
  return normalize(cells).map(([x, y]) => `${x},${y}`).join(';');
}

/** Width and height of the bounding box. */
export function bbox(cells) {
  let w = 0;
  let h = 0;
  for (const [x, y] of cells) {
    if (x + 1 > w) w = x + 1;
    if (y + 1 > h) h = y + 1;
  }
  return { w, h };
}

/** Every distinct rotation/reflection of a shape. */
export function orientations(cells) {
  const seen = new Map();
  let cur = normalize(cells);
  for (let flip = 0; flip < 2; flip++) {
    for (let r = 0; r < 4; r++) {
      const k = shapeKey(cur);
      if (!seen.has(k)) seen.set(k, cur);
      cur = rotate(cur);
    }
    cur = mirror(cur);
  }
  return [...seen.values()];
}

/** True when the cells form one 4-connected piece without duplicates. */
export function isConnected(cells) {
  if (!cells.length) return false;
  const set = new Set(cells.map(([x, y]) => `${x},${y}`));
  if (set.size !== cells.length) return false;
  const seen = new Set([`${cells[0][0]},${cells[0][1]}`]);
  const stack = [cells[0]];
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${y + dy}`;
      if (set.has(k) && !seen.has(k)) {
        seen.add(k);
        stack.push([x + dx, y + dy]);
      }
    }
  }
  return seen.size === cells.length;
}

/** Base shapes by name (one orientation each; use orientations() for the rest). */
export const SHAPES = Object.freeze({
  I1: [[0, 0]],
  I2: [[0, 0], [1, 0]],
  I3: [[0, 0], [1, 0], [2, 0]],
  L3: [[0, 0], [0, 1], [1, 1]],
  O4: [[0, 0], [1, 0], [0, 1], [1, 1]],
  I4: [[0, 0], [1, 0], [2, 0], [3, 0]],
  L4: [[0, 0], [0, 1], [0, 2], [1, 2]],
  T4: [[0, 0], [1, 0], [2, 0], [1, 1]],
  S4: [[1, 0], [2, 0], [0, 1], [1, 1]],
});
