// Level generator for Meow Drop. Pure (no DOM); importable by Node and the browser; deterministic for a given
// (params, seed) — only the seeded PRNG is used, never Math.random or the clock.
//
// Levels look like the original game: a small board packed with single cats of many colours (a mosaic) between
// big polyomino holes, only 2-4 empty cells at the start. Exactly ONE hole per colour (each layer of a layered
// hole has its own colour), and every layer needs as many cats as the hole has cells. With one hole per colour
// a level can never dead-end: every move either swallows cats nobody else could take (which only frees space)
// or is a slide that can be undone, so every reachable state stays solvable. The puzzle is finding a way
// through the packed board: few moves at the start, holes that have to step aside for each other, and the
// order in which to open room for the big shapes.
//
// Method: LAZY COLOURING. The holes (shapes, layers, all colours different) and 2-4 empty cells are placed on
// the board; every other floor cell holds a cat whose colour is not decided yet. Then the game is played
// FORWARDS: a hole may swallow any undecided cat its current layer still has room for, and that cat takes the
// hole's colour for good. The recorded play is a solution of the coloured level, so the level is solvable by
// construction (and replayed with the real Game to be sure). The move policy shapes the puzzle (see lazyPlay):
// a few "opener" holes start, the others stay walled in by other colours until room opens up around them; cats
// get colours their 4-neighbours do not have (the mosaic); the cats left must always remain shareable among the
// open holes (b-matching on what each shape can ever cover), so the play does not jam at the end.
// Ice, boxes and crates + key are added where the solution allows them. Later boards get narrow passages (wall
// lines with 1-2 cell gaps), coloured gates on the chokepoints (only the hole of that colour, always a
// single-layer one, may cover a gate; the colouring plays with that rule) and pentomino holes. Every candidate
// is solved by the hint solver; its difficulty is measured by playing it (see playStats) and the candidate
// closest to the wanted difficulty wins. The par is the fewest drags found (a beam search over whole drags,
// see solver.minDrags, against the construction and solver lines); the stored solution is exactly par drags.
// Hungry cats get a deadline: the drag of that line which eats them plus some slack. levelParams(n) holds the
// campaign curve.
import { compileLevel, Game, DIRS, MAX_COLORS } from './rules.js';
import { SHAPES, orientations } from './shapes.js';
import { createRng } from './rng.js';
import { solve, explorer, applyPath, replay, mergeMoves, minDrags } from './solver.js';

const DX = DIRS.map((d) => d[0]);
const DY = DIRS.map((d) => d[1]);
const DCH = DIRS.map(([dx, dy]) => (dx > 0 ? 'R' : dx < 0 ? 'L' : dy > 0 ? 'D' : 'U'));
const OPP = { R: 'L', L: 'R', U: 'D', D: 'U' };

/** Readable pentominoes for the big holes of later levels (5 cells: need 5 per layer). */
const PENTOMINOES = {
  I5: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
  L5: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]],
  P5: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]],
  U5: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
  T5: [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]],
  Z5: [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]],
  V5: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]],
};
const ALL_SHAPES = { ...SHAPES, ...PENTOMINOES };
const ORIENTS = Object.fromEntries(Object.entries(ALL_SHAPES).map(([name, cells]) => [name, orientations(cells)]));
const SIZE = Object.fromEntries(Object.entries(ALL_SHAPES).map(([name, cells]) => [name, cells.length]));
const MAX_W = 7;
const MAX_H = 10;
/** Colours in the order new ones are taken (0 red, 1 orange, 2 yellow, 3 lime, 4 cyan, 5 blue, 6 purple,
 * 7 pink, 8 white, 9 navy, 10 brown, 11 grey). */
const PALETTE = [0, 2, 5, 3, 7, 6, 1, 4, 8, 9, 10, 11];

/** Default generation parameters (see levelParams for the campaign curve). */
export const DEFAULT_PARAMS = Object.freeze({
  id: 0,
  w: 5,
  h: 7,
  holes: 5, // one colour each (plus one per extra layer)
  shapes: { I2: 3, I3: 2, L3: 3, T4: 2, L4: 1, S4: 1, O4: 1 }, // shape weights
  layered: 0, // holes with 2 layers
  layers3: 0, // chance that a layered hole has 3 layers
  empty: [2, 4], // empty cells at the start
  floor: ['rect'], // floor styles to pick from: rect, corners, notch
  walls: 0, // wall pairs
  ice: 0,
  box: 0,
  lock: 0, // crate cells (with one key cat)
  gates: 0, // coloured gates (on narrow passages when the board has some)
  fence: false, // a wall line across the board with 1-cell gaps
  split: false, // a wall column down the board with 1-cell gaps
  hungry: 0, // hungry cats (deadline = the par drag that eats it + hungrySlack)
  hungrySlack: 2,
  parBeam: 64, // beam width of the par search
  axis: 0, // axis-locked holes
  penta: 0, // at least this many pentomino holes (taken from the 5-cell shapes in `shapes`)
  openers: 2, // holes that may swallow what they reach at the start; the others stay walled in until room opens
  mosaic: true, // a cat preferably gets a colour no 4-neighbour has
  target: [0, 99], // wanted difficulty() window
  candidates: 6,
  attempts: 200,
  playouts: 24,
  hard: false,
});

// ---------------------------------------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------------------------------------

function makeBoard(P, rng) {
  const w = P.w;
  const h = P.h;
  const g = Array.from({ length: h }, () => new Array(w).fill('.'));
  const styles = Array.isArray(P.floor) ? P.floor : [P.floor];
  const style = rng.pick(styles) || 'rect';
  const both = (x, y, ch) => {
    g[y][x] = ch;
    g[y][w - 1 - x] = ch;
  };
  if (style === 'corners') {
    if (rng.chance(0.5)) both(0, 0, '_');
    else both(0, h - 1, '_');
  } else if (style === 'corners4') {
    both(0, 0, '_');
    both(0, h - 1, '_');
  } else if (style === 'notch' && w % 2 === 1) {
    g[rng.chance(0.5) ? 0 : h - 1][(w - 1) / 2] = '_';
  }
  // Narrow passages: a wall line across the board with a 1-cell gap (only thin shapes get through it) and a
  // 2-cell gap further along (medium shapes); the 1-cell gaps are where gates go.
  const gaps = [];
  const line = (len, setCell, openCell) => {
    for (let t = 0; t < len; t++) setCell(t);
    const narrow = rng.range(0, len - 1);
    openCell(narrow);
    gaps.push(narrow);
    const wide = [];
    for (let t = 0; t + 1 < len; t++) if (Math.abs(t - narrow) > 2 && Math.abs(t + 1 - narrow) > 2) wide.push(t);
    if (wide.length) {
      const t = rng.pick(wide);
      openCell(t);
      openCell(t + 1);
    }
  };
  if (P.fence) {
    const y = rng.range(2, h - 3);
    const cells = [];
    line(
      w,
      (x) => {
        if (g[y][x] === '.') g[y][x] = '#';
      },
      (x) => {
        g[y][x] = '.';
        cells.push(y * w + x);
      },
    );
    gaps.splice(gaps.length - 1, 1, cells[0]);
  }
  if (P.split && w >= 6) {
    const x = rng.chance(0.5) ? Math.floor((w - 1) / 2) : Math.ceil((w - 1) / 2);
    const cells = [];
    line(
      h,
      (y) => {
        if (g[y][x] === '.') g[y][x] = '#';
      },
      (y) => {
        g[y][x] = '.';
        cells.push(y * w + x);
      },
    );
    gaps.splice(gaps.length - 1, 1, cells[0]);
  }
  for (let i = 0, tries = 0; i < P.walls && tries < 40; tries++) {
    const x = rng.range(1, Math.max(1, Math.floor((w - 1) / 2)));
    const y = rng.range(1, h - 2);
    if (g[y][x] !== '.' || g[y][w - 1 - x] !== '.') continue;
    let near = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (g[y + dy] && g[y + dy][x + dx] === '#') near = true;
    if (near) continue;
    both(x, y, '#');
    i++;
  }
  const rows = g.map((r) => r.join(''));
  const n = w * h;
  const floor = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (rows[(i - (i % w)) / w][i % w] === '.') {
      floor[i] = 1;
      count++;
    }
  }
  // One connected piece of floor.
  const first = floor.indexOf(1);
  const seen = new Uint8Array(n);
  const stack = [first];
  seen[first] = 1;
  let reach = 0;
  while (stack.length) {
    const i = stack.pop();
    reach++;
    const x = i % w;
    const y = (i - x) / w;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (floor[j] && !seen[j]) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  if (reach !== count) return null;
  return { w, h, n, rows, floor, floorCount: count, style, gaps: gaps.filter((i) => floor[i]) };
}

// ---------------------------------------------------------------------------------------------------------
// Plan: shapes, layers, colours — Σ (1 + layers) × size = floor − empty − crates
// ---------------------------------------------------------------------------------------------------------

function pickShape(rng, weights, size) {
  const names = Object.keys(weights).filter((s) => ORIENTS[s] && (size === undefined || SIZE[s] === size) && weights[s] > 0);
  if (!names.length) return null;
  let total = 0;
  for (const s of names) total += weights[s];
  let r = rng.next() * total;
  for (const s of names) {
    r -= weights[s];
    if (r <= 0) return s;
  }
  return names[names.length - 1];
}

function makePlan(P, rng, board) {
  const room = board.floorCount - P.lock - P.gates;
  const m = P.holes;
  const maxSize = Math.max(...Object.keys(P.shapes).map((name) => SIZE[name] || 0));
  const big = Object.keys(P.shapes).filter((name) => SIZE[name] === 5);
  for (let attempt = 0; attempt < 60; attempt++) {
    const holes = [];
    for (let k = 0; k < m; k++) holes.push({ name: pickShape(rng, P.shapes), layers: 1, axis: null });
    // At least P.penta pentomino holes (their intro level); those keep their shape.
    const forced = new Set();
    if (P.penta > 0 && big.length) {
      for (const k of rng.shuffle(holes.map((_, j) => j)).slice(0, Math.min(m, P.penta))) {
        holes[k].name = rng.pick(big);
        forced.add(k);
      }
    }
    const order = rng.shuffle(holes.map((_, k) => k));
    for (let i = 0; i < Math.min(P.layered, m); i++) holes[order[i]].layers = rng.chance(P.layers3) ? 3 : 2;
    const total = () => holes.reduce((a, hole) => a + (1 + hole.layers) * SIZE[hole.name], 0);
    const lo = room - P.empty[1];
    const hi = room - P.empty[0];
    // Grow or shrink shapes until the cells add up.
    for (let fix = 0; fix < 40 && (total() < lo || total() > hi); fix++) {
      const k = rng.int(m);
      if (forced.has(k)) continue;
      const s = SIZE[holes[k].name];
      const want = total() < lo ? s + 1 : s - 1;
      const name = pickShape(rng, P.shapes, want) || (want >= 1 && want <= maxSize ? pickShape(rng, { I1: 1, I2: 1, I3: 1, I4: 1, I5: 1 }, want) : null);
      if (name) holes[k].name = name;
    }
    if (total() < lo || total() > hi) continue;
    if (holes.filter((hole) => SIZE[hole.name] === 5).length < Math.min(m, P.penta || 0)) continue;
    // Walls leave awkward cells: keep a couple of small holes that can get everywhere.
    if ((P.fence || P.split || P.walls) && holes.filter((hole) => SIZE[hole.name] <= 3).length < Math.min(2, m)) continue;
    const colours = holes.reduce((a, hole) => a + hole.layers, 0);
    if (colours > Math.min(MAX_COLORS, P.maxColors || MAX_COLORS)) continue;
    // Colours: all different (layers too).
    const palette = PALETTE.slice(0, Math.max(colours, Math.min(MAX_COLORS, P.palette || 8)));
    rng.shuffle(palette);
    let next = 0;
    for (const hole of holes) {
      hole.colors = [];
      for (let l = 0; l < hole.layers; l++) hole.colors.push(palette[next++]);
      hole.size = SIZE[hole.name];
      hole.cells = rng.pick(ORIENTS[hole.name]);
    }
    // Axis locks on single-layer holes with a straight or square shape.
    const axisable = rng.shuffle(holes.filter((hole) => hole.layers === 1 && ['I2', 'I3', 'O4', 'I1'].includes(hole.name)));
    for (let i = 0; i < Math.min(P.axis, axisable.length); i++) {
      const hole = axisable[i];
      const [bw, bh] = hole.cells.reduce(([a, b], [dx, dy]) => [Math.max(a, dx + 1), Math.max(b, dy + 1)], [0, 0]);
      // A bar slides along its length; a square either way.
      hole.axis = bw > bh ? 'h' : bh > bw ? 'v' : rng.chance(0.5) ? 'h' : 'v';
    }
    if (holes.filter((hole) => hole.axis).length < Math.min(P.axis, m)) continue;
    return { holes, empty: room - total() };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Lazy colouring
// ---------------------------------------------------------------------------------------------------------

function lazyPlay(P, rng, board, plan) {
  const { w, h, n, floor } = board;
  const BLANK = -2;
  const H = plan.holes.map((spec) => {
    let bw = 0;
    let bh = 0;
    for (const [dx, dy] of spec.cells) {
      bw = Math.max(bw, dx + 1);
      bh = Math.max(bh, dy + 1);
    }
    return { spec, offs: spec.cells.map(([dx, dy]) => dy * w + dx), bw, bh, x: 0, y: 0, x0: 0, y0: 0, li: 0, need: spec.size, open: true };
  });
  const m = H.length;
  const state = new Int8Array(n).fill(-1); // -1 empty, BLANK blank cat
  const final = new Int8Array(n).fill(-1); // colour each cat ends up with
  const holeAt = new Int8Array(n).fill(-1);
  const wall = new Uint8Array(n);
  const gateOf = new Int8Array(n).fill(-1);
  let gates = [];
  let crates = [];
  let total = 0;
  // passable(k, i): no wall/crate, and no gate of another colour than hole k's current one.
  const passable = (k, i) => !wall[i] && (gateOf[i] === -1 || gateOf[i] === H[k].spec.colors[H[k].li]);
  /**
   * One random layout: holes (bulkiest first), coloured gates on chokepoints (the gaps of narrow passages,
   * then corridor cells: only the hole of that colour, always a single-layer one, may cover them; cats never
   * stand on them), crates, the empty cells; blank cats everywhere else. Returns a reason when it fails.
   */
  const layout = () => {
    state.fill(-1);
    holeAt.fill(-1);
    gateOf.fill(-1);
    for (let i = 0; i < n; i++) wall[i] = floor[i] ? 0 : 1;
    gates = [];
    const order = rng.shuffle(H.map((_, k) => k)).sort((x, y) => H[y].offs.length - H[x].offs.length || x - y);
    for (const k of order) {
      const hole = H[k];
      const spots = [];
      for (let y = 0; y + hole.bh <= h; y++) {
        for (let x = 0; x + hole.bw <= w; x++) {
          const p = y * w + x;
          if (hole.offs.every((o) => !wall[p + o] && holeAt[p + o] === -1)) spots.push(p);
        }
      }
      if (!spots.length) return 'lz:spots';
      const p = rng.pick(spots);
      hole.x = hole.x0 = p % w;
      hole.y = hole.y0 = (p - hole.x) / w;
      for (const o of hole.offs) holeAt[p + o] = k;
    }
    if (P.gates > 0) {
      const single = H.map((_, k) => k).filter((k) => H[k].spec.layers === 1);
      if (!single.length) return 'lz:gateHole';
      const free0 = (i) => floor[i] && holeAt[i] === -1;
      const corridor = [];
      for (let i = 0; i < n; i++) {
        if (!free0(i) || board.gaps.includes(i)) continue;
        const x = i % w;
        const y = (i - x) / w;
        let nb = 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && floor[ny * w + nx]) nb++;
        }
        if (nb <= 2) corridor.push(i);
      }
      const pool = rng.shuffle(board.gaps.filter(free0)).concat(rng.shuffle(corridor));
      for (const i of pool) {
        if (gates.length >= P.gates) break;
        if (gates.some((j) => Math.abs((j % w) - (i % w)) + Math.abs(Math.floor(j / w) - Math.floor(i / w)) <= 1)) continue;
        gateOf[i] = H[rng.pick(single)].spec.colors[0];
        gates.push(i);
      }
      if (gates.length < P.gates) return 'lz:gates';
    }
    // Cells no hole can ever cover must stay empty: they take the empty cells first.
    coverOf = H.map(coverFor);
    const coverable = new Uint8Array(n);
    for (const cov of coverOf) for (let i = 0; i < n; i++) if (cov[i]) coverable[i] = 1;
    const rest = [];
    const dead = [];
    for (let i = 0; i < n; i++) {
      if (wall[i] || holeAt[i] !== -1 || gateOf[i] !== -1) continue;
      (coverable[i] ? rest : dead).push(i);
    }
    if (dead.length > plan.empty) return 'lz:dead';
    rng.shuffle(rest);
    crates = rest.splice(0, P.lock);
    for (const i of crates) wall[i] = 1;
    rest.splice(0, plan.empty - dead.length); // these stay empty
    for (const i of rest) state[i] = BLANK;
    total = rest.length;
    if (total !== H.reduce((s, hole) => s + hole.spec.size * hole.spec.layers, 0)) return 'lz:count';
    return null;
  };
  const sameAround = (i, c) => {
    const x = i % w;
    const y = (i - x) / w;
    let s = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && final[ny * w + nx] === c) s++;
    }
    return s;
  };
  const dirOk = (hole, d) => !((hole.spec.axis === 'h' && DY[d] !== 0) || (hole.spec.axis === 'v' && DX[d] !== 0));
  // Positions hole k reaches over empty cells; targets: next positions where it swallows 1..need blank cats.
  const scan = (k) => {
    const hole = H[k];
    const start = hole.y * w + hole.x;
    const parent = new Map([[start, -1]]);
    const dir = new Map();
    const region = [start];
    const targets = [];
    for (let qi = 0; qi < region.length; qi++) {
      const p = region[qi];
      const px = p % w;
      const py = (p - px) / w;
      for (let d = 0; d < 4; d++) {
        if (!dirOk(hole, d)) continue;
        const nx = px + DX[d];
        const ny = py + DY[d];
        if (nx < 0 || ny < 0 || nx + hole.bw > w || ny + hole.bh > h) continue;
        const q = ny * w + nx;
        if (parent.has(q)) continue;
        let blanks = 0;
        let ok = true;
        for (const o of hole.offs) {
          const i = q + o;
          if (!passable(k, i) || (holeAt[i] !== -1 && holeAt[i] !== k)) {
            ok = false;
            break;
          }
          if (state[i] === BLANK) blanks++;
        }
        if (!ok || blanks > hole.need) continue;
        parent.set(q, p);
        dir.set(q, d);
        if (blanks) targets.push(q);
        else region.push(q);
      }
    }
    const path = (q) => {
      let s = '';
      for (let p = q; p !== start; p = parent.get(p)) s = DCH[dir.get(p)] + s;
      return s;
    };
    return { region, targets, path };
  };
  // Cells each hole could ever cover on the board (walls, other colours' gates; crates open later).
  const coverFor = (hole) => {
    const cov = new Uint8Array(n);
    const seen = new Uint8Array(n);
    const start = hole.y * w + hole.x;
    const mine = hole.spec.layers === 1 ? hole.spec.colors[0] : -2;
    const queue = [start];
    seen[start] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (const o of hole.offs) cov[p + o] = 1;
      const px = p % w;
      const py = (p - px) / w;
      for (let d = 0; d < 4; d++) {
        if (!dirOk(hole, d)) continue;
        const nx = px + DX[d];
        const ny = py + DY[d];
        if (nx < 0 || ny < 0 || nx + hole.bw > w || ny + hole.bh > h) continue;
        const q = ny * w + nx;
        if (seen[q] || !hole.offs.every((o) => floor[q + o] && (gateOf[q + o] === -1 || gateOf[q + o] === mine))) continue;
        seen[q] = 1;
        queue.push(q);
      }
    }
    return cov;
  };
  let coverOf = [];
  let universal = [];
  // After hole k swallows eatCells, can the blank cats left still be shared out among the open holes, each
  // taking exactly what it still needs (all its layers) within the cells it can ever cover? (b-matching)
  const allocOk = (k, eatCells) => {
    const eatSet = new Set(eatCells);
    const caps = H.map((hole) => (hole.open ? hole.need + hole.spec.size * (hole.spec.layers - hole.li - 1) : 0));
    caps[k] -= eatCells.length;
    let picky = false;
    for (let j = 0; j < m; j++) if (caps[j] > 0 && !universal[j]) picky = true;
    if (!picky) return true; // every hole left can reach every cell
    const blanks = [];
    for (let i = 0; i < n; i++) if (state[i] === BLANK && !eatSet.has(i)) blanks.push(i);
    const owner = new Int16Array(blanks.length).fill(-1);
    const load = new Int16Array(m);
    let visited;
    const tryCat = (b0) => {
      for (let j = 0; j < m; j++) {
        if (caps[j] <= 0 || visited[j] || !coverOf[j][blanks[b0]]) continue;
        visited[j] = 1;
        if (load[j] < caps[j]) {
          owner[b0] = j;
          load[j]++;
          return true;
        }
        for (let b2 = 0; b2 < blanks.length; b2++) {
          if (owner[b2] !== j) continue;
          owner[b2] = -1;
          load[j]--;
          if (tryCat(b2)) {
            owner[b0] = j;
            load[j]++;
            return true;
          }
          owner[b2] = j;
          load[j]++;
        }
      }
      return false;
    };
    for (let b0 = 0; b0 < blanks.length; b0++) {
      visited = new Uint8Array(m);
      if (!tryCat(b0)) return false;
    }
    return true;
  };
  // Lay the board out until the cats can be shared out among the holes from the start.
  let why = 'lz:layout';
  let laid = false;
  for (let attempt = 0; attempt < 40 && !laid; attempt++) {
    why = layout();
    if (why) continue;
    universal = coverOf.map((cov) => {
      for (let i = 0; i < n; i++) if (floor[i] && !cov[i]) return false;
      return true;
    });
    if (allocOk(0, [])) laid = true;
    else why = 'lz:alloc0';
  }
  if (!laid) return reject(P, why);
  // A few openers may swallow what they reach at the start; every other hole must not (it stays walled in by
  // other colours until room opens up around it), unless nothing else can happen.
  const openerSet = new Set(rng.shuffle(H.map((_, k) => k)).slice(0, Math.max(1, Math.min(m, P.openers || 2))));
  const keyAt = P.lock > 0 ? Math.floor(total * (0.25 + 0.35 * rng.next())) : -1;
  let key = -1;
  let eaten = 0;
  let unstalls = 0;
  const steps = [];
  // Cats each hole could reach right at the start: a non-opener never gets those in its colour, so at the start
  // it is walled in by other colours.
  const reach0 = H.map((_, k) => {
    const s = scan(k);
    const cells = new Set();
    for (const q of s.targets) for (const o of H[k].offs) if (state[q + o] === BLANK) cells.add(q + o);
    return cells;
  });
  const moveTo = (k, path) => {
    const hole = H[k];
    for (const ch of path) {
      const [dx, dy] = STEP_OF[ch];
      for (const o of hole.offs) holeAt[hole.y * w + hole.x + o] = -1;
      hole.x += dx;
      hole.y += dy;
      for (const o of hole.offs) holeAt[hole.y * w + hole.x + o] = k;
      steps.push([k, ch]);
    }
  };
  for (let guard = 0; guard < 4 * total + 50; guard++) {
    if (!H.some((hole) => hole.open)) break;
    const options = [];
    for (let k = 0; k < m; k++) {
      if (!H[k].open) continue;
      const hole = H[k];
      const c = hole.spec.colors[hole.li];
      const s = scan(k);
      for (const q of s.targets) {
        const path = s.path(q);
        const cells = hole.offs.map((o) => q + o).filter((i) => state[i] === BLANK);
        let bad = 0;
        for (const i of cells) bad += sameAround(i, c);
        bad += cells.length - 1; // cats swallowed together sit next to each other
        // A cat it could reach at the start, in its first colour, frees a hole at once: only openers do that.
        let early = 0;
        if (!openerSet.has(k) && hole.li === 0) for (const i of cells) if (reach0[k].has(i)) early++;
        if (!allocOk(k, cells)) continue;
        // Big holes eat first; small, nimble ones are kept for the awkward last cats.
        const score = 2 + 0.5 * Math.min(path.length - 1, 4) + 0.3 * hole.spec.size + (hole.need === cells.length ? 0.5 : 0) + rng.next() * 2;
        // Tiers: clean moves first; then mosaic breaks; then ones that free a hole at the start.
        const tier = early ? 2 + (bad && P.mosaic ? 1 : 0) : bad && P.mosaic ? 1 : 0;
        options.push({ k, q, path, cells, score, bad, early, tier });
      }
    }
    const best = options.length ? Math.min(...options.map((o) => o.tier)) : 9;
    if (best > 0 && unstalls < 3 * m) {
      // Only compromising moves: let holes step aside first if that opens a clean one.
      const seq = lazyUnstall(true);
      if (seq && seq.length) {
        unstalls++;
        for (const [k, ch] of seq) moveTo(k, ch);
        continue;
      }
    }
    if (!options.length) {
      // Nobody can eat: let holes step aside (joint BFS).
      const seq = lazyUnstall(false);
      if (!seq || !seq.length) return reject(P, `lz:stuck@${Math.round((10 * eaten) / total)}`);
      for (const [k, ch] of seq) moveTo(k, ch);
      continue;
    }
    const pool = options.filter((o) => o.tier === best);
    let tot = 0;
    for (const o of pool) tot += o.score;
    let r = rng.next() * tot;
    let pick = pool[pool.length - 1];
    for (const o of pool) {
      r -= o.score;
      if (r <= 0) {
        pick = o;
        break;
      }
    }
    const hole = H[pick.k];
    const c = hole.spec.colors[hole.li];
    moveTo(pick.k, pick.path); // the last step lands on the cats
    for (const i of pick.cells) {
      state[i] = -1;
      final[i] = c;
      if (key < 0 && keyAt >= 0 && eaten >= keyAt) {
        key = i;
        for (const j of crates) wall[j] = 0; // the key opens the crates
      }
      eaten++;
    }
    hole.need -= pick.cells.length;
    if (hole.need === 0) {
      if (hole.li + 1 < hole.spec.layers) {
        hole.li++;
        hole.need = hole.spec.size;
      } else {
        hole.open = false;
        for (const o of hole.offs) holeAt[hole.y * w + hole.x + o] = -1;
      }
    }
  }
  if (H.some((hole) => hole.open)) return reject(P, 'lz:guard');
  if (P.lock > 0 && key < 0) return reject(P, 'lz:key');
  return {
    cat: final,
    holes: H.map((hole) => ({ x: hole.x0, y: hole.y0, spec: hole.spec })),
    solution: mergeMoves(steps),
    key,
    crates,
    gates: gates.map((i) => [i % w, (i - (i % w)) / w, gateOf[i]]),
  };

  /**
   * Joint BFS over hole positions (slides over empty cells) until some hole can swallow a blank cat (clean:
   * without breaking the mosaic or freeing a non-opener at the start).
   */
  function lazyUnstall(clean) {
    const A = [];
    for (let k = 0; k < m; k++) if (H[k].open) A.push(k);
    const startCfg = A.map((k) => H[k].y * w + H[k].x);
    const keyOf = (cfg) => String.fromCharCode(...cfg);
    const seen = new Map([[keyOf(startCfg), null]]);
    const queue = [startCfg];
    const occ = new Int8Array(n);
    for (let qi = 0; qi < queue.length && seen.size < (clean ? 3000 : 20000); qi++) {
      const cfg = queue[qi];
      occ.fill(-1);
      for (let a = 0; a < A.length; a++) for (const o of H[A[a]].offs) occ[cfg[a] + o] = a;
      for (let a = 0; a < A.length; a++) {
        const hole = H[A[a]];
        const p = cfg[a];
        const px = p % w;
        const py = (p - px) / w;
        for (let d = 0; d < 4; d++) {
          if (!dirOk(hole, d)) continue;
          const nx = px + DX[d];
          const ny = py + DY[d];
          if (nx < 0 || ny < 0 || nx + hole.bw > w || ny + hole.bh > h) continue;
          const q = ny * w + nx;
          let ok = true;
          let blanks = 0;
          for (const o of hole.offs) {
            const i = q + o;
            if (!passable(A[a], i) || (occ[i] !== -1 && occ[i] !== a)) {
              ok = false;
              break;
            }
            if (state[i] === BLANK) blanks++;
          }
          if (!ok || blanks > hole.need) continue;
          if (blanks) {
            if (clean) {
              const c = hole.spec.colors[hole.li];
              let dirty = blanks > 1;
              for (const o of hole.offs) {
                const i = q + o;
                if (state[i] !== BLANK) continue;
                if (sameAround(i, c) || (!openerSet.has(A[a]) && hole.li === 0 && reach0[A[a]].has(i))) dirty = true;
              }
              if (dirty) continue;
            }
            const out = [];
            for (let key = keyOf(cfg); seen.get(key); ) {
              const st = seen.get(key);
              out.push([A[st.a], DCH[st.d]]);
              key = st.prev;
            }
            return out.reverse();
          }
          const next = cfg.slice();
          next[a] = q;
          const nk = keyOf(next);
          if (seen.has(nk)) continue;
          seen.set(nk, { prev: keyOf(cfg), a, d });
          queue.push(next);
        }
      }
    }
    return null;
  }
}


const STEP_OF = { R: [1, 0], L: [-1, 0], D: [0, 1], U: [0, -1] };

/**
 * Shortens a solution: inside one drag, a step out and straight back that swallows nothing leaves the board
 * as it was, so both letters go (drags that end up empty disappear). Checked with the real rules.
 */
function simplify(def, solution) {
  const g = new Game(def);
  const out = [];
  for (const [k, path] of solution) {
    const letters = path.split('');
    for (let changed = true; changed; ) {
      changed = false;
      const t = g.clone();
      const drops = [];
      for (const ch of letters) {
        const [dx, dy] = STEP_OF[ch];
        if (!t.canStep(k, dx, dy)) return solution;
        drops.push(t.step(k, dx, dy, []).some((e) => e.type === 'drop'));
      }
      for (let i = 0; i + 1 < letters.length; i++) {
        if (OPP[letters[i]] === letters[i + 1] && !drops[i] && !drops[i + 1]) {
          letters.splice(i, 2);
          changed = true;
          break;
        }
      }
    }
    if (!letters.length) continue;
    const p = letters.join('');
    if (!applyPath(g, k, p)) return solution;
    out.push([k, p]);
  }
  return mergeMoves(out);
}

// ---------------------------------------------------------------------------------------------------------
// Assembly, mechanics, checks
// ---------------------------------------------------------------------------------------------------------

function assemble(board, res) {
  const { w, h } = board;
  const rows = board.rows.map((r) => r.split(''));
  for (const i of res.crates) rows[(i - (i % w)) / w][i % w] = 'L';
  const cats = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = res.cat[y * w + x];
      if (c < 0) continue;
      const cat = [x, y, c];
      if (y * w + x === res.key) cat.push({ key: 1 });
      cats.push(cat);
    }
  }
  const holes = res.holes.map(({ x, y, spec }) => {
    const hole = { x, y, c: spec.colors[0], cells: spec.cells.map(([dx, dy]) => [dx, dy]), need: spec.size };
    if (spec.layers > 1) hole.next = spec.colors.slice(1).map((c) => [c, spec.size]);
    if (spec.axis) hole.axis = spec.axis;
    return hole;
  });
  const def = { w, h, grid: rows.map((r) => r.join('')), cats, holes };
  if (res.gates && res.gates.length) def.gates = res.gates;
  return def;
}

/** Replays a solution and records when each cat drops and how many dropped before that step. */
function timeline(def, solution) {
  const game = new Game(def);
  const { w, n } = game.L;
  const dropT = new Int32Array(n).fill(-1);
  const dropsBefore = new Int32Array(n).fill(-1);
  let t = 0;
  let drops = 0;
  for (const [k, path] of solution) {
    for (const ch of path) {
      t++;
      const [dx, dy] = ch === 'R' ? [1, 0] : ch === 'L' ? [-1, 0] : ch === 'D' ? [0, 1] : [0, -1];
      if (!game.canStep(k, dx, dy)) return null;
      const before = drops;
      for (const e of game.step(k, dx, dy, [])) {
        if (e.type !== 'drop') continue;
        const i = e.y * w + e.x;
        dropT[i] = t;
        dropsBefore[i] = before;
        drops++;
      }
    }
  }
  return game.isWon() ? { dropT, dropsBefore } : null;
}

/** Ice (n ≤ cats dropped before it is taken) and boxes (a neighbour drops at an earlier step). */
function addMods(P, rng, def, solution) {
  if (!P.ice && !P.box) return true;
  const tl = timeline(def, solution);
  if (!tl) return false;
  const { w, h } = def;
  const at = new Map(def.cats.map((cat, idx) => [cat[1] * w + cat[0], idx]));
  const free = (idx) => def.cats[idx].length < 4;
  if (P.ice) {
    const cand = def.cats
      .map((cat, idx) => ({ idx, before: tl.dropsBefore[cat[1] * w + cat[0]], key: rng.next() }))
      .filter((o) => free(o.idx) && o.before >= 3)
      .sort((a, b) => b.before - a.before + (b.key - a.key) * 6 || a.idx - b.idx);
    let placed = 0;
    for (const o of cand) {
      if (placed >= P.ice) break;
      const max = Math.min(o.before, 8);
      def.cats[o.idx].push({ ice: rng.range(Math.max(2, Math.floor(max / 2)), max) });
      placed++;
    }
    if (placed < P.ice) return false;
  }
  if (P.box) {
    const cand = [];
    def.cats.forEach((cat, idx) => {
      if (!free(idx)) return;
      const i = cat[1] * w + cat[0];
      for (let d = 0; d < 4; d++) {
        const nx = cat[0] + DX[d];
        const ny = cat[1] + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !at.has(ny * w + nx)) continue;
        const j = ny * w + nx;
        if (tl.dropT[j] >= 0 && tl.dropT[j] < tl.dropT[i]) {
          cand.push(idx);
          return;
        }
      }
    });
    rng.shuffle(cand);
    if (cand.length < P.box) return false;
    for (const idx of cand.slice(0, P.box)) def.cats[idx].push({ box: 1 });
  }
  return true;
}

/** True when `solution` (list of [hole, path]) wins `def` when played with the real rules. */
export function verifySolution(def, solution) {
  try {
    const g = replay(new Game(def), solution);
    return !!g && g.isWon();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------------------

/**
 * Plays the level `n` times with a random player: every turn a random hole that can swallow something makes
 * a random productive drag; when no hole can (a "stall": holes must first step aside for each other), the
 * shortest unstall sequence is played. Returns averages per playout: stalls, unstall slides (repo), drags,
 * branching (holes that could eat, per turn), plus startMoves / startHoles at the beginning and stuck (playouts
 * that found no way on — always 0 for levels with one hole per colour).
 */
export function playStats(level, n, seed) {
  const L = level && level.ground instanceof Uint8Array ? level : compileLevel(level);
  const ex = explorer(L);
  const rng = createRng(seed);
  const g0 = new Game(L);
  const start = ex.productiveMoves(g0);
  let stalls = 0;
  let repo = 0;
  let drags = 0;
  let turns = 0;
  let able = 0;
  let stuck = 0;
  for (let r = 0; r < n; r++) {
    const g = g0.clone();
    for (let guard = 0; guard < 500 && !g.isWon(); guard++) {
      const scans = [];
      for (let k = 0; k < g.need.length; k++) {
        if (g.need[k] <= 0) continue;
        const s = ex.scan(g, k);
        if (s.targets.length) scans.push(s);
      }
      turns++;
      able += scans.length;
      if (!scans.length) {
        const seq = ex.unstall(g);
        if (!seq) {
          stuck++;
          break;
        }
        stalls++;
        repo += seq.length;
        for (const [k, ch] of seq) applyPath(g, k, ch);
        continue;
      }
      const s = rng.pick(scans);
      applyPath(g, s.k, ex.pathTo(s, rng.pick(s.targets)));
      drags++;
    }
  }
  const avg = (v) => (n ? v / n : 0);
  return {
    stalls: avg(stalls),
    repo: avg(repo),
    drags: avg(drags),
    branching: turns ? able / turns : 0,
    startMoves: start.length,
    startHoles: new Set(start.map((mv) => mv.hole)).size,
    stuck,
  };
}

/**
 * Difficulty of a level (no timer, no dead ends): how hard it is to find a way through it. Grows with the
 * stalls a random player runs into (the board has to be rearranged before anyone can eat), the slides those
 * need, a tight opening (few holes able to eat) and few choices along the way.
 */
export function difficulty(st) {
  const opening = 1 / Math.max(1, st.startHoles);
  const tight = 1 / Math.max(1, st.branching);
  return st.stalls * 0.6 + st.repo * 0.08 + opening * 0.8 + tight * 1.2;
}

/**
 * Measures a level definition.
 * @param {object} def level definition (solution optional)
 * @param {{ playouts?: number, seed?: number, maxNodes?: number }} [opts]
 */
export function evaluateLevel(def, opts = {}) {
  const L = compileLevel(def);
  const game = new Game(L);
  const sol = solve(game, { maxNodes: opts.maxNodes ?? 30000 });
  const st = playStats(L, opts.playouts ?? 24, opts.seed ?? 12345);
  const solution = def.solution || null;
  let empty = 0;
  const holeCells = new Set();
  for (const hole of def.holes) for (const [dx, dy] of hole.cells) holeCells.add((hole.y + dy) * def.w + hole.x + dx);
  const catCells = new Set(def.cats.map(([x, y]) => y * def.w + x));
  for (let y = 0; y < def.h; y++) {
    for (let x = 0; x < def.w; x++) {
      const i = y * def.w + x;
      if (def.grid[y][x] === '.' && !holeCells.has(i) && !catCells.has(i)) empty++;
    }
  }
  return {
    solvable: !!sol,
    nodes: sol ? sol.nodes : -1,
    solverDrags: sol ? sol.moves.length : -1,
    solutionOk: solution ? verifySolution(def, solution) : null,
    ...st,
    difficulty: difficulty(st),
    cats: L.catCells.length,
    holes: L.holes.length,
    colors: L.colors.length,
    empty,
    mosaic: mosaic(def),
    drags: solution ? solution.length : 0,
    steps: solution ? solution.reduce((a, s) => a + s[1].length, 0) : 0,
  };
}

/** Share of cats with a 4-neighbour of the same colour (0 = perfect mosaic). */
export function mosaic(def) {
  const w = def.w;
  const at = new Map(def.cats.map(([x, y, c]) => [y * w + x, c]));
  let same = 0;
  for (const [x, y, c] of def.cats) {
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx >= 0 && nx < w && at.get(ny * w + nx) === c) {
        same++;
        break;
      }
    }
  }
  return def.cats.length ? same / def.cats.length : 0;
}

// ---------------------------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------------------------

function normalizeParams(params) {
  const P = { ...DEFAULT_PARAMS, ...params };
  P.w = Math.max(3, Math.min(MAX_W, P.w | 0));
  P.h = Math.max(3, Math.min(MAX_H, P.h | 0));
  P.holes = Math.max(1, Math.min(MAX_COLORS, P.holes | 0));
  P.layered = Math.max(0, Math.min(P.holes, P.layered | 0));
  P.empty = [Math.max(0, P.empty[0]), Math.max(P.empty[0], P.empty[1])];
  P.lock = Math.max(0, P.lock | 0);
  return P;
}

/** Counts why candidates are rejected when params._debug is an object (tuning aid). */
function reject(P, why) {
  if (P._debug) P._debug[why] = (P._debug[why] || 0) + 1;
  return null;
}

function buildCandidate(P, seed) {
  const rng = createRng(seed);
  const board = makeBoard(P, rng);
  if (!board) return reject(P, 'board');
  const plan = makePlan(P, rng, board);
  if (!plan) return reject(P, 'plan');
  const res = lazyPlay(P, rng, board, plan);
  if (!res) return reject(P, 'lazy');
  const def = assemble(board, res);
  try {
    compileLevel(def);
  } catch {
    return reject(P, 'compile');
  }
  if (!verifySolution(def, res.solution)) return reject(P, 'replay');
  const solution = simplify(def, res.solution);
  if (!verifySolution(def, solution)) return reject(P, 'simplify');
  if (!addMods(P, rng, def, solution)) return reject(P, 'mods');
  if (!verifySolution(def, solution)) return reject(P, 'replay2');
  return { def, solution };
}

/**
 * Generates a solvable level.
 * @param {object} params see DEFAULT_PARAMS
 * @param {number} seed
 * @returns {object} level definition { id, w, h, hard?, grid, cats, holes, solution, stats }
 */
export function generateLevel(params = {}, seed = 1) {
  const P = normalizeParams(params);
  const rng = createRng((seed >>> 0) ^ 0x9e3779b9);
  let best = null;
  let found = 0;
  for (let attempt = 0; attempt < P.attempts && found < P.candidates; attempt++) {
    const sub = (rng.next() * 0x100000000) >>> 0;
    const cand = buildCandidate(P, sub);
    if (!cand) continue;
    const L = compileLevel(cand.def);
    const game = new Game(L);
    const sol = solve(game, { maxNodes: 20000 });
    if (!sol) {
      reject(P, 'solver');
      continue;
    }
    const st = playStats(L, P.playouts, sub);
    if (st.stuck || !st.startMoves) {
      reject(P, st.stuck ? 'stuck' : 'noStart');
      continue;
    }
    const solverLine = sol.moves.map((mv) => [mv.hole, mv.path]);
    found++;
    const d = difficulty(st);
    const [lo, hi] = P.target;
    const score = (d < lo ? lo - d : d > hi ? d - hi : 0) + 1.2 * mosaic(cand.def) + rng.next() * 0.01;
    if (P._debug) (P._debug.cands || (P._debug.cands = [])).push({ ...st, d, mosaic: mosaic(cand.def) });
    if (!best || score < best.score) best = { def: cand.def, lines: [cand.solution, solverLine], st, d, score };
  }
  if (!best) throw new Error(`generator: no level found (${JSON.stringify(P._debug || {})})`);
  const def = best.def;
  // Par: the fewest drags found (beam search over whole drags, or the construction / solver line if shorter).
  const lines = best.lines.map((line) => mergeMoves(line));
  const found2 = minDrags(new Game(def), { beam: P.parBeam });
  if (found2) lines.push(found2.moves.map((mv) => [mv.hole, mv.path]));
  const steps = (line) => line.reduce((a, x) => a + x[1].length, 0);
  let line = null;
  for (const l of lines) {
    if (!verifyDrags(def, l)) continue;
    if (!line || l.length < line.length || (l.length === line.length && steps(l) < steps(line))) line = l;
  }
  if (!line) throw new Error('generator: no verified solution');
  // Hungry cats: each must drop by the drag that eats it in the par line plus some slack; the hint solver
  // must still find its way from the start (else other cats, more slack, or none).
  if (P.hungry > 0) {
    const plain = def.cats.map((cat) => cat.slice());
    let ok = false;
    for (let attempt = 0; attempt < 6 && !ok; attempt++) {
      def.cats = plain.map((cat) => cat.slice());
      addHungry({ ...P, hungrySlack: P.hungrySlack + (attempt >= 3 ? 1 : 0) }, rng, def, line);
      ok = verifyDrags(def, line) && !!solve(new Game(def), { maxNodes: 20000 });
    }
    if (!ok) def.cats = plain;
  }
  if (!verifyDrags(def, line)) throw new Error('generator: hungry deadlines broke the par line');
  const out = { id: P.id, w: def.w, h: def.h };
  if (P.hard) out.hard = true;
  out.grid = def.grid;
  out.cats = def.cats;
  out.holes = def.holes;
  if (def.gates) out.gates = def.gates;
  out.par = line.length;
  out.solution = line;
  out.stats = {
    steps: steps(line),
    difficulty: Math.round(best.d * 100) / 100,
    stalls: Math.round(best.st.stalls * 100) / 100,
    startHoles: best.st.startHoles,
  };
  return out;
}

/**
 * True when the drags (list of [hole, path]) win def with the move counter running: endMove() after every
 * drag, as the UI does, and no hungry cat starves on the way.
 */
export function verifyDrags(def, line) {
  try {
    const g = new Game(def);
    for (const [k, path] of line) {
      if (!applyPath(g, k, path)) return false;
      g.endMove(null);
      if (g.isFailed()) return false;
    }
    return g.isWon();
  } catch {
    return false;
  }
}

/** Makes P.hungry cats hungry: deadline = the drag of the par line that eats the cat + P.hungrySlack. */
function addHungry(P, rng, def, line) {
  const g = new Game(def);
  const { w } = def;
  const dragOf = new Map();
  line.forEach(([k, path], t) => {
    for (const ch of path) {
      const [dx, dy] = STEP_OF[ch];
      for (const e of g.step(k, dx, dy, [])) if (e.type === 'drop') dragOf.set(e.y * w + e.x, t + 1);
    }
    g.endMove(null);
  });
  const last = Math.max(2, Math.ceil(line.length * (P.intro === 'hungry' ? 0.35 : 0.6)));
  const cand = def.cats
    .map((cat, idx) => ({ idx, t: dragOf.get(cat[1] * w + cat[0]), key: rng.next() }))
    .filter((o) => def.cats[o.idx].length === 3 && o.t >= 2 && o.t <= last)
    .sort((a, b) => a.key - b.key || a.idx - b.idx);
  for (const o of cand.slice(0, P.hungry)) def.cats[o.idx].push({ hungry: o.t + P.hungrySlack });
}

// ---------------------------------------------------------------------------------------------------------
// Campaign curve (filled in below)
// ---------------------------------------------------------------------------------------------------------

/** Seed used for level n (pack and endless). */
export function levelSeed(n) {
  return (Math.imul(n, 0x9e3779b1) ^ 0x5eed1e5) >>> 0;
}

/** Every 10th level is a hard one. */
export function isHard(n) {
  return n % 10 === 0;
}

const SHAPES_EARLY = { I2: 3, I3: 2, L3: 3, T4: 1, O4: 1 };
const SHAPES_MID = { I2: 3, I3: 2, L3: 3, T4: 2, L4: 2, S4: 1, O4: 1, I1: 0.5, P5: 0.6, L5: 0.5, U5: 0.4, T5: 0.4 };
const SHAPES_LATE = { I2: 2, I3: 2, L3: 2, T4: 2, L4: 2, S4: 2, O4: 1, I1: 0.6, I4: 0.6, P5: 1, L5: 1, U5: 0.8, T5: 0.8, Z5: 0.6, V5: 0.6, I5: 0.4 };

/** difficulty() aimed at by level n: one continuous, non-decreasing curve (a window is kept around it). */
const CURVE = [[4, 1.5], [10, 2.4], [15, 3.3], [20, 4.2], [35, 5.4], [50, 6.2], [100, 7.6]];
export function targetDifficulty(n) {
  if (n <= CURVE[0][0]) return CURVE[0][1];
  for (let i = 1; i < CURVE.length; i++) {
    const [x1, y1] = CURVE[i];
    if (n <= x1) {
      const [x0, y0] = CURVE[i - 1];
      return y0 + ((y1 - y0) * (n - x0)) / (x1 - x0);
    }
  }
  return CURVE[CURVE.length - 1][1];
}

/** Number of holes that packs a w×h board (about 3 free cells) with the given number of extra layers. */
function holesFor(cells, layered, avgSize) {
  return Math.max(2, Math.round((cells - 3) / (2 * avgSize) - layered * 0.5));
}

/** Mechanics introduced on their own gentle level (one new thing each). */
export const INTRO = Object.freeze({ layers: 7, walls: 11, pentomino: 12, ice: 15, gates: 18, box: 25, hungry: 28, axis: 35, lock: 45 });

/**
 * Generation parameters of level n (≥ 4; 1-3 are hand-made tutorials) on a rising difficulty curve: bigger and
 * tighter boards (fewer free cells), more layers and big shapes, narrow passages, gates and hungry cats; the
 * candidate whose difficulty() falls in a window around targetDifficulty(n) is kept. Every 10th level is hard
 * (aims well above the curve: one opener, one or two free cells). Each new mechanic comes first on a gentle
 * level of its own (see INTRO). Levels beyond the pack keep the late mix with per-level variety. Deterministic.
 */
export function levelParams(n) {
  const r = createRng(levelSeed(n) ^ 0xa11ce);
  const hard = isHard(n);
  const endless = n > 100;
  const P = {
    id: n,
    hard,
    candidates: endless ? 4 : hard ? 60 : 30,
    attempts: endless ? 40 : 300,
    playouts: endless ? 12 : 32,
    parBeam: endless ? 8 : 96,
  };
  let intro = null;
  for (const [k, v] of Object.entries(INTRO)) if (v === n) intro = k;
  const after = (k) => n > INTRO[k];
  // Board size.
  let size;
  if (n <= 6) size = n <= 4 ? [4, 6] : [5, 6];
  else if (n <= 10) size = [5, n <= 8 ? 6 : 7];
  else if (n <= 20) size = n <= 14 ? [5, 7] : n <= 17 ? [5, 8] : [6, 8];
  else if (n <= 35) size = r.chance(0.5) ? [6, 8] : [6, 9];
  else if (n <= 50) size = r.chance(0.5) ? [6, 9] : [7, 9];
  else size = r.pick([[6, 9], [7, 9], [7, 9], [7, 10], [6, 10]]);
  if (hard && n > 10) size = n <= 30 ? [6, 9] : [7, n >= 60 ? 10 : 9];
  [P.w, P.h] = size;
  // Free cells: 2-4 early, 1-2 late, one or two on hard levels.
  P.empty = n <= 14 ? [2, 4] : n <= 29 ? [2, 3] : n <= 59 ? [1, 3] : [1, 2];
  if (hard && n >= 20) P.empty = [1, 2];
  // Layers: one layered hole from 7, then more, with 3-layer holes later.
  P.layered = n < 7 ? 0 : n <= 14 ? 1 : n <= 30 ? 2 : n <= 50 ? r.pick([2, 3]) : r.pick([3, 3, 4]);
  P.layers3 = n <= 30 ? 0 : n <= 50 ? 0.2 : 0.4;
  // Shapes: pentominoes from their intro on.
  P.shapes = n < INTRO.pentomino ? SHAPES_EARLY : n <= 35 ? SHAPES_MID : SHAPES_LATE;
  if (n === INTRO.pentomino) {
    P.shapes = { ...SHAPES_EARLY, P5: 1.2 };
    P.penta = 1;
  }
  P.palette = n <= 20 ? 8 : n <= 50 ? 10 : 12;
  P.maxColors = n <= 10 ? 6 : n <= 20 ? 8 : n <= 50 ? 10 : 11;
  const avg = n < INTRO.pentomino ? 3 : n <= 35 ? 3.3 : 3.7;
  P.holes = Math.min(holesFor(P.w * P.h, P.layered, avg), P.maxColors - P.layered - (P.layers3 ? 1 : 0));
  // Narrow passages (walls) and pillars.
  if (n === INTRO.walls) P.fence = true;
  else if (after('walls')) {
    const roll = r.next();
    P.fence = roll < 0.3;
    P.split = roll >= 0.3 && roll < 0.55;
    P.walls = !P.fence && !P.split && r.chance(0.5) ? 1 + r.int(2) : 0;
  }
  if (n > 40) P.floor = ['rect', 'rect', 'rect', 'corners', 'corners4', 'notch'];
  // Gates (they route the other holes best on narrow passages).
  if (n === INTRO.gates) {
    P.gates = 1;
    P.fence = true;
  } else if (after('gates') && r.chance(0.4)) {
    P.gates = 1 + r.int(2);
    if (!P.fence && !P.split) P.fence = true;
    P.walls = 0;
  }
  // The other mechanics, each gentle at first, then now and then.
  if (n === INTRO.ice) P.ice = 3;
  else if (after('ice') && r.chance(0.3)) P.ice = 1 + r.int(2);
  if (n === INTRO.box) P.box = 3;
  else if (after('box') && r.chance(0.3)) P.box = 1 + r.int(2);
  if (n === INTRO.hungry) {
    P.hungry = 1;
    P.hungrySlack = 3;
  } else if (after('hungry') && r.chance(0.45)) {
    P.hungry = 1 + r.int(2);
    P.hungrySlack = hard ? 1 : 2;
  }
  if (n === INTRO.axis) P.axis = 2;
  else if (after('axis') && r.chance(0.3)) P.axis = 1;
  if (n === INTRO.lock) P.lock = 3;
  else if (after('lock') && r.chance(0.25)) P.lock = 2;
  // Openers: holes free to eat at the start (the others are walled in by other colours).
  P.openers = hard ? 1 : n <= 6 ? P.holes - 1 : n <= 10 ? 3 : n <= 14 ? 2 : r.pick([1, 2, 2]);
  if (intro) {
    // The new thing is the point: an easy level with room to breathe and nothing else new on it.
    const keep = {
      walls: ['fence'],
      gates: ['fence', 'gates'],
      ice: ['ice'],
      box: ['box'],
      hungry: ['hungry', 'hungrySlack'],
      axis: ['axis'],
      lock: ['lock'],
    }[intro] || [];
    for (const k of ['fence', 'split', 'walls', 'gates', 'ice', 'box', 'hungry', 'axis', 'lock']) if (!keep.includes(k)) delete P[k];
    P.openers = Math.max(P.openers, 2);
    P.empty = [2, 4];
    if (P.hungry) P.hungrySlack = 3;
  }
  P.intro = intro;
  const base = endless ? targetDifficulty(100) - 0.5 + r.next() : targetDifficulty(n);
  if (intro) P.target = [0, Math.max(1.2, base - 2)];
  else if (hard) P.target = [base + 2, base + 5];
  else P.target = [base - 0.3, base + 0.3];
  return P;
}
