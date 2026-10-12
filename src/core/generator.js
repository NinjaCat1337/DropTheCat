// Level generator for Meow Drop. Pure (no DOM); importable by Node and the browser; deterministic for a given
// (params, seed) — only the seeded PRNG is used, never Math.random or the clock.
//
// Method: REVERSE CONSTRUCTION. Holes get an intended solution order 0..m-1 (hole 0 moves first and swallows all
// of its cats in one drag, then hole 1, …). They are built from the last one back to the first on a board that
// starts empty. For each hole: pick a start on free cells, walk it forward through free cells (never over a cat
// or the start of an already built hole — those are all still on the board when it moves), then put cats of its
// colour on cells its walk covers for the first time (never on its start); need = cats placed, and the walk is
// cut where the last one drops. Its start and cats then become obstacles for the holes built after it (= moving
// before it). Biases that make the puzzle:
//  * order — walk cells left without a cat are "slots" (the first cells in front of a late mover are kept free on
//    purpose): holes built later put their cats or their start there, so they must move first;
//  * blocking — holes built later also lay their cats around the starts of later movers (a different colour);
//  * allocation traps — within a colour the least mobile hole (axis lock, big shape) moves last, and its
//    siblings get trails on cells it can never cover (pockets, corridors, other rows), starting near its cats:
//    a careless player feeds the wrong hole and is stuck.
// densify() then packs the board with extra cats that a hole of the solution swallows on its way or with a
// one-cell detour, and ice, boxes, crates + key are added where the intended solution allows them. Every change
// is replayed with the real Game; every candidate is also solved by the hint solver and measured by random
// playouts (trapRate: random productive play dead-ends; deep trap rate: so does careful play that never breaks
// the cat/hole allocation) — the candidate closest to the wanted difficulty() wins. levelParams(n) holds the
// campaign curve (sizes, colours, holes, mechanics, difficulty window) shared by the pack tool and endless levels.
import { compileLevel, Game, DIRS } from './rules.js';
import { SHAPES, orientations } from './shapes.js';
import { createRng } from './rng.js';
import { solve, explorer, applyPath, replay } from './solver.js';

const DX = DIRS.map((d) => d[0]);
const DY = DIRS.map((d) => d[1]);
const DCH = DIRS.map(([dx, dy]) => (dx > 0 ? 'R' : dx < 0 ? 'L' : dy > 0 ? 'D' : 'U'));

const ORIENTS = Object.fromEntries(Object.entries(SHAPES).map(([name, cells]) => [name, orientations(cells)]));
const SMALL = new Set(['I1', 'I2']);
const MAX_W = 8;
const MAX_H = 10;

const FREE = 0;
const CAT = 1;
const START = 2;

/** Default generation parameters (see levelParams for the campaign curve). */
export const DEFAULT_PARAMS = Object.freeze({
  id: 0,
  w: 6,
  h: 8,
  colors: 3,
  holes: 4,
  shapes: ['I1', 'I2', 'L3', 'O4'],
  need: [2, 8], // per-hole need range
  cats: [12, 24], // accepted total cats
  maxNeed: 12,
  floor: ['rect', 'corners'], // floor styles to pick from
  walls: 0, // number of wall pairs/pillars
  fence: false, // a wall line with 1-cell gaps across the board
  density: 0.72, // chance of a cat on a fresh walk cell
  slotDensity: 0.92, // chance of a cat on a walk cell another hole must cross later
  minFill: 0.5, // (cats + hole cells) / floor cells after construction
  fill: 0.9, // densify up to this fill
  densifyBudget: 160, // replays the densify pass may spend
  ice: 0,
  box: 0,
  lock: 0, // number of crate cells (with one key cat)
  axis: 0, // number of axis-locked holes
  axisShared: true, // put axis locks on colours that have another hole (traps) rather than on lone ones
  decoy: 0.5, // bias: same-coloured holes start next to each other's cats
  slotBias: 2, // walk bias toward cells another hole must cross later (ordering dependencies)
  blockBias: 2, // walk bias toward free cells next to the start of a hole that moves later
  exclBias: 2, // walk bias toward cells a same-coloured sibling can never cover (allocation traps)
  sharedDensity: 0.6, // cat chance factor on cells a same-coloured sibling could cover too
  lead: 1, // steps at the start of a walk that get few own cats (left for earlier movers: blocks the hole)
  leadDensity: 0.1,
  contrast: true, // same-coloured holes get different shapes
  minDeps: 1, // dependencies between holes in the intended solution
  maxStartHoles: 99, // at most this many holes may swallow something at the start
  target: [0, 2.5], // wanted difficulty() window
  candidates: 6, // candidates to compare
  attempts: 120, // construction attempts at most
  playouts: 48,
  solverNodes: 20000,
  hard: false,
});

// ---------------------------------------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------------------------------------

const FLOOR_STYLES = ['rect', 'corners', 'notch', 'waist', 'steps', 'cross', 'bevel'];

function makeBoard(P, rng) {
  const w = P.w;
  const h = P.h;
  const g = Array.from({ length: h }, () => new Array(w).fill('.'));
  const styles = Array.isArray(P.floor) ? P.floor : [P.floor];
  const style = rng.pick(styles) || 'rect';
  const both = (x, y, ch) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    g[y][x] = ch;
    g[y][w - 1 - x] = ch;
  };
  const top = rng.chance(0.5);
  const bottom = !top || rng.chance(0.5);
  switch (style) {
    case 'corners': {
      const s = rng.range(1, 2);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s - y; x++) {
          if (top) both(x, y, '_');
          if (bottom) both(x, h - 1 - y, '_');
        }
      }
      break;
    }
    case 'bevel': {
      const deep = h >= 8;
      if (top) {
        both(0, 0, '_');
        if (deep) both(0, 1, '_');
      }
      if (bottom) {
        both(0, h - 1, '_');
        if (deep) both(0, h - 2, '_');
      }
      break;
    }
    case 'notch': {
      const nw = w % 2 === 0 ? 2 : 1;
      const x0 = (w - nw) / 2;
      const d = rng.range(1, 2);
      for (let y = 0; y < d; y++) {
        for (let x = x0; x < x0 + nw; x++) {
          if (top) g[y][x] = '_';
          if (bottom) g[h - 1 - y][x] = '_';
        }
      }
      break;
    }
    case 'waist': {
      const y0 = Math.floor(h / 2) - 1;
      for (let y = y0; y < y0 + 2; y++) both(0, y, '_');
      break;
    }
    case 'steps': {
      if (top) {
        both(0, 0, '_');
        both(1, 0, '_');
        both(0, 1, '_');
      }
      if (bottom) {
        both(0, h - 1, '_');
        both(1, h - 1, '_');
        both(0, h - 2, '_');
      }
      break;
    }
    case 'cross': {
      const s = 2;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s - (y === s - 1 ? 1 : 0); x++) {
          both(x, y, '_');
          both(x, h - 1 - y, '_');
        }
      }
      break;
    }
    default:
      break;
  }
  // A fence: a wall row with single-cell gaps (big holes cannot pass).
  if (P.fence) {
    const y = rng.range(Math.floor(h / 2) - 1, Math.floor(h / 2));
    for (let x = 0; x < w; x++) if (g[y][x] === '.') g[y][x] = '#';
    const gaps = w >= 7 ? 2 : 1;
    const xs = [];
    if (gaps === 1) xs.push(rng.range(1, w - 2));
    else {
      const gx = rng.range(1, Math.floor(w / 2) - 1);
      xs.push(gx, w - 1 - gx);
    }
    if (rng.chance(0.5) && w >= 6) xs.push(rng.chance(0.5) ? 0 : w - 1);
    for (const x of xs) g[y][x] = '.';
  }
  // Pillars: symmetric wall cells inside the board.
  for (let i = 0, tries = 0; i < P.walls && tries < 50; tries++) {
    const x = rng.range(1, Math.max(1, Math.floor((w - 1) / 2)));
    const y = rng.range(1, h - 2);
    if (g[y][x] !== '.' || g[y][w - 1 - x] !== '.') continue;
    // keep pillars apart so they do not form long walls
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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rows[y][x] === '.') {
        floor[y * w + x] = 1;
        count++;
      }
    }
  }
  // The floor must be one piece.
  const first = floor.indexOf(1);
  if (first < 0) return null;
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
  return { w, h, n, rows, floor, floorCount: count, style };
}

// ---------------------------------------------------------------------------------------------------------
// Plan: colours, shapes, axis locks, intended order
// ---------------------------------------------------------------------------------------------------------

/** Rough mobility rank of a hole spec (higher = reaches more cells). */
function mobility(spec) {
  if (spec.axis) return 0;
  return 5 - SHAPES[spec.name].length;
}

function makePlan(P, rng) {
  const palette = rng.shuffle([0, 1, 2, 3, 4, 5, 6, 7]).slice(0, P.colors);
  const colorOf = palette.slice();
  const count = new Map(palette.map((c) => [c, 1]));
  while (colorOf.length < P.holes) {
    const pool = palette.filter((c) => count.get(c) < 3);
    const c = rng.pick(pool.length ? pool : palette);
    count.set(c, count.get(c) + 1);
    colorOf.push(c);
  }
  rng.shuffle(colorOf);
  const shapes = P.shapes;
  const smallPool = shapes.filter((s) => SMALL.has(s));
  const bigPool = shapes.filter((s) => !SMALL.has(s));
  const holes = colorOf.map((c) => ({ c, name: rng.pick(shapes), axis: null }));
  if (P.contrast && smallPool.length && bigPool.length) {
    // Same-coloured holes alternate small / big shapes, so they cannot go everywhere the other one goes.
    const seen = new Map();
    for (const hole of holes) {
      const k = seen.get(hole.c) || 0;
      if (k > 0) {
        const firstSmall = seen.get(`s${hole.c}`);
        hole.name = rng.pick(firstSmall ? bigPool : smallPool);
      } else seen.set(`s${hole.c}`, SMALL.has(hole.name));
      seen.set(hole.c, k + 1);
    }
  }
  // Axis-locked holes: preferably in a colour that has another (free) hole, which makes the trap.
  if (P.axis > 0) {
    const idx = holes.map((_, i) => i);
    rng.shuffle(idx);
    const shared = (i) => (count.get(holes[i].c) > 1 ? 1 : 0);
    if (P.axisShared) idx.sort((a, b) => shared(b) - shared(a));
    else idx.sort((a, b) => shared(a) - shared(b));
    for (let i = 0; i < Math.min(P.axis, holes.length); i++) {
      const hole = holes[idx[i]];
      hole.axis = rng.chance(0.5) ? 'h' : 'v';
      hole.name = rng.pick(['I1', 'I1', 'I2', 'O4'].filter((s) => s === 'I1' || shapes.includes(s)));
    }
  }
  // Within a colour, the least mobile holes move last: their (built later) siblings then get trails the
  // restricted hole can never cover, which is what makes swallowing the wrong cats a trap.
  const byColor = new Map();
  holes.forEach((hole, i) => {
    if (!byColor.has(hole.c)) byColor.set(hole.c, []);
    byColor.get(hole.c).push(i);
  });
  for (const idx of byColor.values()) {
    if (idx.length < 2) continue;
    const specs = idx.map((i) => holes[i]).sort((a, b) => mobility(b) - mobility(a));
    idx.forEach((i, r) => {
      holes[i] = specs[r];
    });
  }
  // Need targets spread the wanted number of cats over the holes, bigger shapes taking more.
  // The construction aims a bit low: densify() packs the board up to the wanted count afterwards.
  const total = rng.range(Math.round(P.cats[0] * 0.75), Math.round((P.cats[0] + P.cats[1]) / 2));
  const weight = holes.map((hole) => {
    const size = SHAPES[hole.name].length;
    return (size >= 3 ? 1.35 : size === 2 ? 1.1 : 0.9) * (0.7 + 0.6 * rng.next());
  });
  const sum = weight.reduce((a, b) => a + b, 0);
  for (let i = 0; i < holes.length; i++) {
    const t = Math.round((total * weight[i]) / sum);
    holes[i].target = Math.max(P.need[0], Math.min(P.need[1], P.maxNeed, t));
  }
  return holes; // index = intended move order
}

// ---------------------------------------------------------------------------------------------------------
// Reverse construction
// ---------------------------------------------------------------------------------------------------------

/** Cells a hole (shape cells, axis) starting at (x0, y0) could ever cover on the board without cats or holes. */
function boardCover(board, cells, axis, x0, y0) {
  const { w, h, n, floor } = board;
  let bw = 0;
  let bh = 0;
  for (const [dx, dy] of cells) {
    bw = Math.max(bw, dx + 1);
    bh = Math.max(bh, dy + 1);
  }
  const cover = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const fits = (x, y) => {
    if (x < 0 || y < 0 || x + bw > w || y + bh > h) return false;
    for (const [dx, dy] of cells) if (!floor[(y + dy) * w + x + dx]) return false;
    return true;
  };
  const queue = [x0, y0];
  seen[y0 * w + x0] = 1;
  for (let q = 0; q < queue.length; q += 2) {
    const x = queue[q];
    const y = queue[q + 1];
    for (const [dx, dy] of cells) cover[(y + dy) * w + x + dx] = 1;
    for (let d = 0; d < 4; d++) {
      if ((axis === 'h' && DY[d] !== 0) || (axis === 'v' && DX[d] !== 0)) continue;
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx]) continue;
      seen[ny * w + nx] = 1;
      if (fits(nx, ny)) queue.push(nx, ny);
    }
  }
  return cover;
}

function construct(P, rng, board, plan) {
  const { w, h, n, floor } = board;
  const occ = new Uint8Array(n);
  const owner = new Int16Array(n).fill(-1); // hole (plan index) owning the cat / start on a cell
  const catColor = new Int8Array(n).fill(-1);
  const slotOf = new Uint32Array(n); // bit j: the walk of hole j crosses this cell without a cat of its own
  const built = new Array(plan.length);
  const free = (i) => floor[i] === 1 && occ[i] === FREE;
  // near[i] = colour bits of built holes whose start touches free cell i (cats there block those holes).
  const near = new Uint8Array(n);
  for (let j = plan.length - 1; j >= 0; j--) {
    const spec = plan[j];
    // Cells no already built hole of the same colour can ever cover: cats there can only be this hole's.
    let excl = null;
    for (let i = j + 1; i < plan.length; i++) {
      if (plan[i].c !== spec.c) continue;
      if (!excl) excl = new Uint8Array(n).fill(1);
      const cov = built[i].cover;
      for (let q = 0; q < n; q++) if (cov[q]) excl[q] = 0;
    }
    let res = null;
    for (let tries = 0; tries < 16 && !res; tries++) {
      // Crowded board: a shorter walk, then a smaller shape.
      let sp = spec;
      if (tries >= 6) sp = { ...spec, target: Math.max(P.need[0], Math.ceil(spec.target * 0.6)) };
      if (tries >= 11 && !spec.axis && SHAPES[spec.name].length > 2) sp = { ...sp, name: rng.chance(0.5) ? 'I2' : 'I1' };
      res = buildHole(P, rng, board, sp, j, free, slotOf, catColor, owner, excl, near);
    }
    if (!res) return null;
    res.cover = boardCover(board, res.cells, res.axis, res.x, res.y);
    for (const i of res.startCells) {
      const x = i % w;
      const y = (i - x) / w;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) near[ny * w + nx] |= 1 << spec.c;
      }
    }
    for (const i of res.startCells) {
      occ[i] = START;
      owner[i] = j;
    }
    for (const { cell } of res.cats) {
      occ[cell] = CAT;
      catColor[cell] = spec.c;
      owner[cell] = j;
    }
    for (const i of res.slots) slotOf[i] |= 1 << j;
    built[j] = res;
  }
  // Dependencies: hole j needs hole i (i < j) to move first when i's cat or start sits on j's walk.
  const deps = plan.map(() => new Set());
  for (let j = 0; j < plan.length; j++) {
    for (const i of built[j].slots) if (owner[i] >= 0 && owner[i] !== j) deps[j].add(owner[i]);
  }
  let edges = 0;
  const depth = new Array(plan.length).fill(1);
  for (let j = 0; j < plan.length; j++) {
    edges += deps[j].size;
    for (const i of deps[j]) depth[j] = Math.max(depth[j], depth[i] + 1);
  }
  let cats = 0;
  let holeCells = 0;
  for (const b of built) {
    cats += b.cats.length;
    holeCells += b.startCells.length;
  }
  const fill = (cats + holeCells) / board.floorCount;
  return { built, occ, catColor, owner, deps: edges, depth: Math.max(...depth), cats, fill, w, h };
}

function buildHole(P, rng, board, spec, j, free, slotOf, catColor, owner, excl, near) {
  // A cat of this colour next to a later mover's start blocks it (unless that mover has the same colour).
  const blocker = (i) => near[i] !== 0 && (near[i] & (1 << spec.c)) === 0;
  const { w, h } = board;
  const cells = rng.pick(ORIENTS[spec.name]);
  let bw = 0;
  let bh = 0;
  for (const [dx, dy] of cells) {
    bw = Math.max(bw, dx + 1);
    bh = Math.max(bh, dy + 1);
  }
  const offs = cells.map(([dx, dy]) => dy * w + dx);
  const axis = spec.axis;
  const fits = (x, y) => {
    if (x < 0 || y < 0 || x + bw > w || y + bh > h) return false;
    const p = y * w + x;
    for (const o of offs) if (!free(p + o)) return false;
    return true;
  };
  const dirOk = (d) => !((axis === 'h' && DY[d] !== 0) || (axis === 'v' && DX[d] !== 0));
  // --- start position
  let best = null;
  let bestScore = -Infinity;
  for (let y = 0; y + bh <= h; y++) {
    for (let x = 0; x + bw <= w; x++) {
      if (!fits(x, y)) continue;
      let canMove = false;
      for (let d = 0; d < 4; d++) if (dirOk(d) && fits(x + DX[d], y + DY[d])) canMove = true;
      if (!canMove) continue;
      const p = y * w + x;
      let slots = 0;
      let adj = 0;
      let decoy = 0;
      const mine = new Set(offs.map((o) => p + o));
      for (const o of offs) {
        const i = p + o;
        if (slotOf[i]) slots++;
        const cx = i % w;
        const cy = (i - cx) / w;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d];
          const ny = cy + DY[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            adj += 0.5;
            continue;
          }
          const ni = ny * w + nx;
          if (mine.has(ni)) continue;
          if (!free(ni)) adj++;
          if (catColor[ni] === spec.c && owner[ni] !== j) decoy++;
        }
      }
      const score = 2.5 * slots + 0.6 * adj + P.decoy * 3 * Math.min(decoy, 2) + rng.next() * 3;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  if (!best) return reject(P, 'h:noStart');
  // --- forward walk
  const covered = new Set();
  const startCells = offs.map((o) => best.y * w + best.x + o);
  for (const i of startCells) covered.add(i);
  let x = best.x;
  let y = best.y;
  const steps = [];
  let fresh = 0;
  let last = -1;
  const want = Math.ceil(spec.target / Math.max(0.35, P.density)) + 1 + (j > 0 ? P.lead * cells.length : 0);
  for (let s = 0; s < 64 && fresh < want; s++) {
    const opts = [];
    let total = 0;
    for (let d = 0; d < 4; d++) {
      if (!dirOk(d)) continue;
      if (axis && last >= 0 && d !== last) continue;
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (!fits(nx, ny)) continue;
      const p = ny * w + nx;
      const nu = [];
      let slots = 0;
      let ex = 0;
      let blk = 0;
      for (const o of offs) {
        if (!covered.has(p + o)) {
          nu.push(p + o);
          if (slotOf[p + o]) slots++;
          if (excl && excl[p + o]) ex++;
          if (blocker(p + o)) blk++;
        }
      }
      if (!nu.length) continue;
      const bias = (1 + P.slotBias * slots) * (1 + P.exclBias * ex) * (1 + P.blockBias * blk);
      const wgt = (1 + nu.length) * bias * (d === last ? 2.2 : 1) * (0.4 + rng.next());
      opts.push({ d, nx, ny, nu, wgt });
      total += wgt;
    }
    if (!opts.length) break;
    let r = rng.next() * total;
    let pick = opts[opts.length - 1];
    for (const o of opts) {
      r -= o.wgt;
      if (r <= 0) {
        pick = o;
        break;
      }
    }
    x = pick.nx;
    y = pick.ny;
    last = pick.d;
    for (const i of pick.nu) covered.add(i);
    steps.push({ d: pick.d, fresh: pick.nu });
    fresh += pick.nu.length;
  }
  if (!steps.length) return reject(P, 'h:noStep');
  // --- cats on first-covered cells
  const cats = [];
  const target = Math.min(spec.target, P.maxNeed);
  // The first cells in front of a hole that moves late stay free of its own cats, so that holes built after
  // it (moving earlier) fill them: it is blocked until they have gone.
  const lead = j > 0 ? P.lead : 0;
  for (let t = 0; t < steps.length && cats.length < target; t++) {
    for (const cell of steps[t].fresh) {
      if (cats.length >= target) break;
      let p;
      if (t < lead) p = P.leadDensity;
      else {
        p = slotOf[cell] ? P.slotDensity : P.density;
        if (excl) p = excl[cell] ? Math.max(p, 0.95) : p * P.sharedDensity;
        if (blocker(cell)) p = Math.max(p, P.slotDensity);
      }
      if (rng.next() < p) cats.push({ cell, t });
    }
  }
  if (cats.length < Math.min(P.need[0], target)) return reject(P, 'h:fewCats');
  const lastT = cats[cats.length - 1].t;
  const kept = steps.slice(0, lastT + 1);
  const catSet = new Set(cats.map((c) => c.cell));
  const slots = [];
  for (const st of kept) for (const i of st.fresh) if (!catSet.has(i)) slots.push(i);
  return {
    c: spec.c,
    name: spec.name,
    cells,
    axis,
    x: best.x,
    y: best.y,
    startCells,
    path: kept.map((st) => DCH[st.d]).join(''),
    cats,
    slots,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Features: ice, boxes, crates + key — only where the intended solution allows them
// ---------------------------------------------------------------------------------------------------------

/** Replays the intended solution and records when every cat drops and when every cell is first covered. */
function timeline(def, order) {
  const game = new Game(def);
  const { w, n } = game.L;
  const dropT = new Int32Array(n).fill(-1);
  const dropsBefore = new Int32Array(n).fill(-1);
  const firstCover = new Int32Array(n).fill(0x7fffffff);
  const firstBy = new Int16Array(n).fill(-1);
  let t = 0;
  let drops = 0;
  const coverNow = (k) => {
    for (const [dx, dy] of game.L.holes[k].cells) {
      const i = (game.hy[k] + dy) * w + game.hx[k] + dx;
      if (firstCover[i] > t) {
        firstCover[i] = t;
        firstBy[i] = k;
      }
    }
  };
  for (let k = 0; k < game.holeCount; k++) coverNow(k);
  for (const [k, path] of order) {
    for (const ch of path) {
      t++;
      const [dx, dy] = ch === 'R' ? [1, 0] : ch === 'L' ? [-1, 0] : ch === 'D' ? [0, 1] : [0, -1];
      if (!game.canStep(k, dx, dy)) return null;
      const ev = game.step(k, dx, dy, []);
      coverNow(k);
      const before = drops;
      for (const e of ev) {
        if (e.type !== 'drop') continue;
        const i = e.y * w + e.x;
        dropT[i] = t;
        dropsBefore[i] = before;
        drops++;
      }
    }
  }
  if (!game.isWon()) return null;
  return { dropT, dropsBefore, firstCover, firstBy, steps: t, drops };
}

const OPP = { R: 'L', L: 'R', U: 'D', D: 'U' };

/**
 * Packs the board: puts cats on empty cells that a hole of the intended solution swallows on its way (a cell
 * its walk covers first) or with a one-cell detour (step aside and back). Cells next to the start of a hole
 * that moves later are filled first, by a hole of another colour, which blocks that hole until then. Every
 * change is checked by replaying the whole solution with the real rules. Mutates def / solution.
 */
function densify(P, rng, def, solution, wantFill, budget) {
  const { w, h } = def;
  const holes = def.holes;
  const moveOf = new Map(solution.map(([k], i) => [k, i]));
  const startCell = new Map();
  for (let k = 0; k < holes.length; k++) {
    for (const [dx, dy] of holes[k].cells) startCell.set((holes[k].y + dy) * w + holes[k].x + dx, k);
  }
  let floorCount = 0;
  for (const row of def.grid) for (const ch of row) if (ch === '.') floorCount++;
  const catAt = new Set(def.cats.map(([x, y]) => y * w + x));
  const fill = () => (def.cats.length + startCell.size) / floorCount;
  const empties = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (def.grid[y][x] !== '.' || catAt.has(i) || startCell.has(i)) continue;
      // Holes (other than the first mover) whose start touches this cell.
      const adj = [];
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = startCell.get(ny * w + nx);
        if (k !== undefined && moveOf.get(k) > 0 && !adj.includes(k)) adj.push(k);
      }
      empties.push({ i, x, y, adj, pri: (adj.length ? 10 : 0) + rng.next() * 4 });
    }
  }
  empties.sort((a, b) => b.pri - a.pri);
  let tl = timeline(def, solution);
  if (!tl) return false;
  let tries = 0;
  // Offsets of each move in the global step count, and every hole's positions along its path.
  const track = () => {
    const out = [];
    let t = 0;
    for (const [k, path] of solution) {
      const pos = [[holes[k].x, holes[k].y]];
      let [x, y] = pos[0];
      for (const ch of path) {
        x += ch === 'R' ? 1 : ch === 'L' ? -1 : 0;
        y += ch === 'D' ? 1 : ch === 'U' ? -1 : 0;
        pos.push([x, y]);
      }
      out.push({ k, t0: t, pos });
      t += path.length;
    }
    return out;
  };
  let moves = track();
  for (const e of empties) {
    if (fill() >= wantFill || def.cats.length >= P.cats[1] || tries >= budget) break;
    const opts = [];
    // (a) a hole already walks over the cell first: just put one of its cats there.
    const by = tl.firstBy[e.i];
    // (never next to the start of a hole of the same colour: that would hand it a free first move)
    if (by >= 0 && !e.adj.some((k) => holes[k].c === holes[by].c)) {
      opts.push({ k: by, mi: moveOf.get(by), t: -1, pri: 2 });
    }
    // (b) a detour from a hole passing next to it, before anyone else covers it.
    for (let mi = 0; mi < moves.length; mi++) {
      const { k, t0, pos } = moves[mi];
      const hole = holes[k];
      if (hole.need >= P.maxNeed) continue;
      if (e.adj.some((x) => x === k || holes[x].c === hole.c || moveOf.get(x) < mi)) continue;
      for (let t = 0; t < pos.length - 1; t++) {
        if (t0 + t >= tl.firstCover[e.i]) break;
        const [px, py] = pos[t];
        for (let d = 0; d < 4; d++) {
          if ((hole.axis === 'h' && DY[d] !== 0) || (hole.axis === 'v' && DX[d] !== 0)) continue;
          const qx = px + DX[d];
          const qy = py + DY[d];
          let covers = false;
          for (const [dx, dy] of hole.cells) if (qx + dx === e.x && qy + dy === e.y) covers = true;
          if (covers) opts.push({ k, mi, t, d, pri: (e.adj.length ? 3 : 1) + rng.next() });
        }
      }
    }
    if (!opts.length) continue;
    opts.sort((a, b) => b.pri - a.pri);
    for (const o of opts.slice(0, 4)) {
      if (holes[o.k].need >= P.maxNeed) continue;
      tries++;
      const oldPath = solution[o.mi][1];
      if (o.t >= 0) {
        solution[o.mi][1] = oldPath.slice(0, o.t) + DCH[o.d] + OPP[DCH[o.d]] + oldPath.slice(o.t);
      }
      def.cats.push([e.x, e.y, holes[o.k].c]);
      holes[o.k].need++;
      if (verifySolution(def, solution)) {
        catAt.add(e.i);
        tl = timeline(def, solution);
        moves = track();
        break;
      }
      def.cats.pop();
      holes[o.k].need--;
      solution[o.mi][1] = oldPath;
    }
  }
  def.cats.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return true;
}

function addFeatures(P, rng, def, order, intro) {
  const tl = timeline(def, order);
  if (!tl) return false;
  const { w, h } = def;
  const cats = def.cats;
  const at = new Map(cats.map((cat, idx) => [cat[1] * w + cat[0], idx]));
  const used = new Set();
  // Ice: n ≤ cats dropped before the step that swallows it.
  if (P.ice > 0) {
    // Prefer cats that drop late (the ice then matters longer), with some noise. (Sort keys are drawn once:
    // a comparator calling the RNG would make the order depend on the engine's sort algorithm.)
    const cand = cats
      .map((cat, idx) => ({ idx, before: tl.dropsBefore[cat[1] * w + cat[0]] }))
      .filter((o) => o.before >= 2)
      .map((o) => ({ ...o, key: o.before + (rng.next() - 0.5) * 8 }));
    cand.sort((a, b) => b.key - a.key || a.idx - b.idx);
    let placed = 0;
    for (const o of cand) {
      if (placed >= P.ice) break;
      const max = Math.min(o.before, intro === 'ice' ? 6 : 9);
      const lo = Math.max(2, Math.floor(max / 2));
      const v = rng.range(lo, max);
      cats[o.idx][3] = { ice: v };
      used.add(o.idx);
      placed++;
    }
    if (placed < Math.min(P.ice, 1)) return false;
  }
  // Boxes: a 4-neighbour cat drops at an earlier step.
  if (P.box > 0) {
    const cand = [];
    cats.forEach((cat, idx) => {
      if (used.has(idx)) return;
      const i = cat[1] * w + cat[0];
      let ok = false;
      for (let d = 0; d < 4; d++) {
        const nx = cat[0] + DX[d];
        const ny = cat[1] + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (!at.has(ny * w + nx)) continue;
        const nj = ny * w + nx;
        if (tl.dropT[nj] >= 0 && tl.dropT[nj] < tl.dropT[i]) ok = true;
      }
      if (ok) cand.push(idx);
    });
    rng.shuffle(cand);
    let placed = 0;
    for (const idx of cand) {
      if (placed >= P.box) break;
      // (Boxing a neighbour too is fine: boxes never change when anything drops in the intended solution.)
      cats[idx][3] = { box: 1 };
      used.add(idx);
      placed++;
    }
    if (placed < Math.min(P.box, 1)) return false;
  }
  // Crates + key: crates on empty cells first covered after the key cat drops.
  if (P.lock > 0) {
    const holeStart = new Set();
    for (const hole of def.holes) for (const [dx, dy] of hole.cells) holeStart.add((hole.y + dy) * w + hole.x + dx);
    const keyCand = cats
      .map((cat, idx) => ({ idx, t: tl.dropT[cat[1] * w + cat[0]] }))
      .filter((o) => !used.has(o.idx) && o.t > 0)
      .sort((a, b) => a.t - b.t);
    let done = false;
    for (let attempt = 0; attempt < 6 && !done && keyCand.length; attempt++) {
      const pickFrom = keyCand.slice(0, Math.max(1, Math.ceil(keyCand.length * 0.45)));
      const key = rng.pick(pickFrom);
      const empties = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (def.grid[y][x] !== '.' || at.has(i) || holeStart.has(i)) continue;
          if (tl.firstCover[i] <= key.t) continue;
          empties.push({ i, x, y, crossed: tl.firstCover[i] !== 0x7fffffff });
        }
      }
      const crossed = empties.filter((e) => e.crossed);
      if (!crossed.length) continue;
      rng.shuffle(crossed);
      const chosen = new Set();
      // Grow a little cluster around a crossed cell, preferring crossed cells.
      const seed0 = crossed[0];
      chosen.add(seed0.i);
      const pool = new Map(empties.map((e) => [e.i, e]));
      while (chosen.size < P.lock) {
        let add = null;
        for (const i of chosen) {
          const x = i % w;
          const y = (i - x) / w;
          for (let d = 0; d < 4 && add === null; d++) {
            const nx = x + DX[d];
            const ny = y + DY[d];
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const j = ny * w + nx;
            if (pool.has(j) && !chosen.has(j)) add = j;
          }
          if (add !== null) break;
        }
        if (add === null) {
          const rest = crossed.find((e) => !chosen.has(e.i)) || empties.find((e) => !chosen.has(e.i));
          if (!rest) break;
          add = rest.i;
        }
        chosen.add(add);
      }
      const rows = def.grid.map((r) => r.split(''));
      for (const i of chosen) rows[(i - (i % w)) / w][i % w] = 'L';
      def.grid = rows.map((r) => r.join(''));
      cats[key.idx][3] = { key: 1 };
      used.add(key.idx);
      done = true;
    }
    if (!done) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Assembly and checks
// ---------------------------------------------------------------------------------------------------------

function assemble(P, rng, board, res) {
  const { w, h } = board;
  const m = res.built.length;
  const perm = rng.shuffle(Array.from({ length: m }, (_, i) => i)); // plan index → def index
  const holes = new Array(m);
  for (let j = 0; j < m; j++) {
    const b = res.built[j];
    const hole = { x: b.x, y: b.y, c: b.c, cells: b.cells.map((p) => [p[0], p[1]]), need: b.cats.length };
    if (b.axis) hole.axis = b.axis;
    holes[perm[j]] = hole;
  }
  const cats = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = res.catColor[y * w + x];
      if (c >= 0) cats.push([x, y, c]);
    }
  }
  const solution = res.built.map((b, j) => [perm[j], b.path]);
  return { def: { w, h, grid: board.rows.slice(), cats, holes }, solution };
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
// Difficulty measurement
// ---------------------------------------------------------------------------------------------------------

/**
 * Random "reasonable" playouts: at every turn a random hole that can swallow something makes a random
 * productive macro-move (smart: only moves after which the cats can still be shared out among the holes).
 * When holes only block each other, a blocker is moved aside. Returns the fraction that dead-ends.
 */
export function trapRate(level, n, seed, smart = false) {
  const L = level && level.ground instanceof Uint8Array ? level : compileLevel(level);
  const ex = explorer(L);
  const rng = createRng(seed);
  const g0 = new Game(L);
  let dead = 0;
  for (let r = 0; r < n; r++) {
    let g = g0.clone();
    let reps = 0;
    for (;;) {
      if (g.isWon()) break;
      const scans = [];
      for (let k = 0; k < g.need.length; k++) {
        if (g.need[k] <= 0) continue;
        const s = ex.scan(g, k);
        if (s.targets.length) scans.push(s);
      }
      if (!scans.length) {
        if (reps < 12 && !g.isStuck()) {
          const rm = ex.unblockMoves(g, null, 1);
          if (rm.length) {
            g = rng.pick(rm).game;
            reps++;
            continue;
          }
        }
        dead++;
        break;
      }
      if (!smart) {
        const s = rng.pick(scans);
        applyPath(g, s.k, ex.pathTo(s, rng.pick(s.targets)));
        continue;
      }
      const all = [];
      for (const s of scans) for (const q of s.targets) all.push([s, q]);
      rng.shuffle(all);
      let next = null;
      for (const [s, q] of all) {
        const t = g.clone();
        applyPath(t, s.k, ex.pathTo(s, q));
        if (ex.feasible(t)) {
          next = t;
          break;
        }
      }
      if (!next) {
        dead++;
        break;
      }
      g = next;
    }
  }
  return n ? dead / n : 0;
}

/**
 * Measures a level definition.
 * @param {object} def level definition (solution optional)
 * @param {{ playouts?: number, seed?: number, maxNodes?: number }} [opts]
 * @returns {{ solvable: boolean, nodes: number, solverMoves: number, solutionOk: boolean | null,
 *   startMoves: number, startHoles: number, trapRate: number, smartTrapRate: number,
 *   cats: number, holes: number, colors: number, steps: number }}
 */
export function evaluateLevel(def, opts = {}) {
  const L = compileLevel(def);
  const game = new Game(L);
  const ex = explorer(L);
  const sol = solve(game, { maxNodes: opts.maxNodes ?? 30000 });
  const startMoves = ex.productiveMoves(game);
  const n = opts.playouts ?? 64;
  const seed = opts.seed ?? 12345;
  const solution = def.solution || null;
  return {
    solvable: !!sol,
    nodes: sol ? sol.nodes : -1,
    solverMoves: sol ? sol.moves.length : -1,
    solutionOk: solution ? verifySolution(def, solution) : null,
    startMoves: startMoves.length,
    startHoles: new Set(startMoves.map((mv) => mv.hole)).size,
    trapRate: trapRate(L, n, seed, false),
    smartTrapRate: trapRate(L, n, seed + 1, true),
    cats: L.catCells.length,
    holes: L.holes.length,
    colors: L.colors.length,
    steps: solution ? solution.reduce((a, s) => a + s[1].length, 0) : 0,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------------------------

function normalizeParams(params) {
  const P = { ...DEFAULT_PARAMS, ...params };
  P.w = Math.max(3, Math.min(MAX_W, P.w | 0));
  P.h = Math.max(3, Math.min(MAX_H, P.h | 0));
  P.colors = Math.max(1, Math.min(8, P.colors | 0));
  P.holes = Math.max(P.colors, Math.min(30, P.holes | 0));
  P.maxNeed = Math.max(1, Math.min(12, P.maxNeed | 0));
  P.need = [Math.max(1, P.need[0]), Math.max(P.need[0], Math.min(P.maxNeed, P.need[1]))];
  P.shapes = P.shapes.filter((s) => ORIENTS[s]);
  if (!P.shapes.length) P.shapes = ['I1'];
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
  const plan = makePlan(P, rng);
  const res = construct(P, rng, board, plan);
  if (!res) return reject(P, 'construct');
  if (res.cats > P.cats[1]) return reject(P, 'tooManyCats');
  if (res.fill < P.minFill) return reject(P, 'fill');
  if (res.deps < P.minDeps) return reject(P, 'deps');
  const { def, solution } = assemble(P, rng, board, res);
  if (P.fill > 0) densify(P, rng, def, solution, P.fill, P.densifyBudget);
  if (def.cats.length < P.cats[0] || def.cats.length > P.cats[1]) return reject(P, 'catCount');
  const intro = P.intro || null;
  if ((P.ice || P.box || P.lock) && !addFeatures(P, rng, def, solution, intro)) return reject(P, 'features');
  try {
    compileLevel(def);
  } catch {
    return reject(P, 'compile');
  }
  if (!verifySolution(def, solution)) return reject(P, 'replay');
  let holeCells = 0;
  for (const hole of def.holes) holeCells += hole.cells.length;
  const fill = (def.cats.length + holeCells) / board.floorCount;
  return { def, solution, meta: { deps: res.deps, depth: res.depth, fill, style: board.style } };
}

/**
 * Difficulty of a level from its playout trap rates: random play dead-ends (trapRate) and careful random
 * play — never making a move after which the cats can no longer be shared out — still dead-ends
 * (deepTrapRate, weighted more: those traps need real planning). 0 = no way to fail … 2.5.
 */
export function difficulty(trap, deep) {
  return trap + 1.5 * deep;
}

/** Distance of a candidate from the wanted difficulty (lower is better). */
function candidateScore(P, cand, ev) {
  const [lo, hi] = P.target;
  const d = difficulty(ev.trapRate, ev.smartTrapRate);
  let s = d < lo ? lo - d : d > hi ? (d - hi) * 0.5 : 0;
  s += 0.04 * Math.max(0, ev.startHoles - P.maxStartHoles);
  s -= 0.01 * Math.min(cand.meta.depth, 6);
  s -= 0.15 * cand.meta.fill;
  return s;
}

/**
 * Generates a solvable level.
 * @param {object} params see DEFAULT_PARAMS
 * @param {number} seed
 * @returns {object} level definition { id, w, h, grid, cats, holes, hard?, solution, stats }
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
    const sol = P.solverNodes > 0 ? solve(game, { maxNodes: P.solverNodes }) : { nodes: 0, moves: [] };
    if (!sol) {
      reject(P, 'solver');
      continue;
    }
    const ex = explorer(L);
    const start = ex.productiveMoves(game);
    if (!start.length) {
      reject(P, 'noStartMove');
      continue;
    }
    const ev = {
      trapRate: P.playouts ? trapRate(L, P.playouts, sub, false) : 0,
      smartTrapRate: P.playouts ? trapRate(L, P.playouts, sub + 1, true) : 0,
      startHoles: new Set(start.map((mv) => mv.hole)).size,
      nodes: sol.nodes,
    };
    found++;
    const score = candidateScore(P, cand, ev);
    if (P._debug) (P._debug.cands || (P._debug.cands = [])).push({ ...ev, score, depth: cand.meta.depth, fill: cand.meta.fill });
    if (!best || score < best.score) best = { cand, ev, score };
  }
  if (!best) {
    if (params._relaxed) throw new Error('generator: no level found');
    // Relax: no features that may not fit, looser fill / dependencies.
    const [lo, hi] = P.cats;
    const relaxed = {
      ...params,
      _relaxed: true,
      minFill: 0,
      minDeps: 0,
      ice: 0,
      box: 0,
      lock: 0,
      fence: false,
      walls: 0,
      attempts: Math.max(P.attempts, 120) * 2,
      cats: [Math.max(1, Math.floor(lo * 0.7)), Math.min(45, Math.ceil(hi * 1.2))],
    };
    return generateLevel(relaxed, seed + 1);
  }
  const { cand, ev } = best;
  const out = { id: P.id, w: cand.def.w, h: cand.def.h };
  if (P.hard) out.hard = true;
  out.grid = cand.def.grid;
  out.cats = cand.def.cats;
  out.holes = cand.def.holes;
  out.solution = cand.solution;
  out.stats = {
    moves: cand.solution.length,
    steps: cand.solution.reduce((a, s) => a + s[1].length, 0),
    trapRate: Math.round(ev.trapRate * 100) / 100,
    ...(params._relaxed ? { relaxed: true } : {}),
    smartTrapRate: Math.round(ev.smartTrapRate * 100) / 100,
    deps: cand.meta.deps,
    depth: cand.meta.depth,
    startHoles: ev.startHoles,
    fill: Math.round(cand.meta.fill * 100) / 100,
    nodes: ev.nodes,
  };
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Campaign curve
// ---------------------------------------------------------------------------------------------------------

const BASIC = ['I1', 'I2', 'L3', 'O4'];
const MID = ['I1', 'I2', 'I3', 'L3', 'O4', 'T4'];
const ALL_SHAPES = ['I1', 'I2', 'I3', 'L3', 'O4', 'I4', 'L4', 'T4', 'S4'];

/** Cat count range that packs a w×h board (minus wall cells) with the given number of holes (at most 45). */
function catRange(w, h, holes, lo = 0.8, walls = 0) {
  const max = Math.min(45, Math.round((w * h * 0.92 - walls) * 0.92 - holes * 2.4));
  return [Math.round(max * lo), max];
}

/** Seed used for level n (pack and endless). */
export function levelSeed(n) {
  return (Math.imul(n, 0x9e3779b1) ^ 0x5eed1e5) >>> 0;
}

/** Every 10th level is a hard one. */
export function isHard(n) {
  return n % 10 === 0;
}

const CURVE = [[4, 0], [9, 0.08], [20, 0.45], [35, 0.75], [50, 0.95], [100, 1.3]];

/** difficulty() aimed at by level n: one continuous, non-decreasing curve (a window is kept around it). */
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

/**
 * Generation parameters of level n (≥ 4; 1-3 are hand-made tutorials) on a smooth difficulty curve: board
 * size, colours, holes, shapes and mechanics grow by tier, and the candidate whose difficulty() falls in a
 * window around targetDifficulty(n) is kept. Every 10th level is hard (aims well above the curve); a new
 * mechanic is introduced on a gentle level (12 ice, 22 boxes, 36 axis locks, 45 crates + key). Levels beyond
 * the pack keep the late-game mix with per-level variety. Deterministic.
 */
export function levelParams(n) {
  const r = createRng(levelSeed(n) ^ 0xa11ce);
  const hard = isHard(n);
  const endless = n > 100;
  // The pack (built offline) compares many candidates; endless levels are generated in the browser.
  const P = {
    id: n,
    hard,
    candidates: endless ? 3 : hard ? 40 : 24,
    attempts: endless ? 60 : hard ? 900 : 400,
    playouts: endless ? 16 : 48,
  };
  let intro = false;
  if (n <= 10) {
    // 2-3 colours, 3-4 holes: holes swallow their colour and clear the way for each other.
    const t = (n - 4) / 6;
    Object.assign(P, {
      w: n <= 5 ? 5 : 6,
      h: n <= 7 ? 7 : 8,
      colors: n <= 6 ? 2 : 3,
      holes: n <= 7 ? 3 : 4,
      shapes: n <= 4 ? ['I1', 'I2'] : n <= 6 ? ['I1', 'I2', 'O4'] : BASIC,
      cats: [Math.round(9 + 6 * t), Math.round(13 + 8 * t)],
      need: [2, 7],
      floor: n <= 6 ? ['rect'] : ['rect', 'corners', 'bevel'],
      fill: 0.82,
      minFill: 0.3,
      maxStartHoles: 2,
    });
    if (hard) Object.assign(P, { holes: 5, cats: [18, 24], walls: 2, minFill: 0.4, maxStartHoles: 3 });
  } else if (n <= 20) {
    // 3-4 colours, 4-6 holes, shaped floors and pillars; ice from 12.
    Object.assign(P, {
      w: n <= 14 ? 6 : 7,
      h: n <= 14 ? 8 : 9,
      colors: n <= 15 ? 3 : 4,
      holes: n <= 13 ? 4 : n <= 17 ? 5 : 6,
      shapes: n <= 14 ? BASIC : MID,
      need: [2, 9],
      floor: FLOOR_STYLES,
      walls: 1 + r.int(2),
      fill: 0.85,
      maxStartHoles: 3,
    });
    if (n === 12) {
      Object.assign(P, { intro: 'ice', ice: 4, holes: 4, colors: 3, walls: 0 });
      intro = true;
    } else if (n > 12 && r.chance(0.5)) P.ice = 1 + r.int(2);
    if (hard) Object.assign(P, { holes: 7, walls: 3, fence: false });
  } else if (n <= 35) {
    // 4-5 colours, several holes per colour; boxes from 22.
    Object.assign(P, {
      w: 7,
      h: 9,
      colors: n <= 27 ? 4 : 5,
      holes: n <= 25 ? 6 : n <= 31 ? 7 : 8,
      shapes: n <= 25 ? MID : ALL_SHAPES,
      need: [2, 10],
      floor: FLOOR_STYLES,
      walls: 1 + r.int(3),
      fence: r.chance(0.15),
      fill: 0.88,
      maxStartHoles: 4,
    });
    if (n === 22) {
      Object.assign(P, { intro: 'box', box: 5, holes: 5, colors: 4, fence: false });
      intro = true;
    } else if (n > 22) {
      if (r.chance(0.5)) P.box = 1 + r.int(3);
      if (r.chance(0.35)) P.ice = 1 + r.int(2);
    } else if (r.chance(0.4)) P.ice = 1 + r.int(2);
    if (hard) Object.assign(P, { holes: P.holes + 1, walls: 3, fence: false });
  } else if (n <= 50) {
    // 5 colours, 7-8 holes; axis-locked holes from 36, crates and a key from 45.
    const big = n >= 41 || hard;
    Object.assign(P, {
      w: big ? 8 : 7,
      h: big ? 10 : 9,
      colors: 5,
      holes: n <= 42 ? 7 : 8,
      shapes: ALL_SHAPES,
      need: [2, 11],
      floor: FLOOR_STYLES,
      walls: 1 + r.int(3),
      fence: r.chance(0.15),
      fill: 0.88,
      maxStartHoles: 4,
    });
    if (n === 36) {
      Object.assign(P, { intro: 'axis', axis: 3, axisShared: false, holes: 6, colors: 4, fence: false });
      intro = true;
    } else if (n === 45) {
      Object.assign(P, { intro: 'lock', lock: 4, holes: 6, colors: 4, fence: false });
      intro = true;
    } else {
      if (r.chance(0.5)) P.axis = 1 + r.int(2);
      if (n > 45 && r.chance(0.5)) P.lock = 2 + r.int(3);
      if (r.chance(0.35)) P.box = 1 + r.int(2);
      if (r.chance(0.35)) P.ice = 1 + r.int(2);
    }
    if (hard) Object.assign(P, { holes: 9, walls: 3, fence: false, axis: Math.max(P.axis || 0, 1) });
  } else {
    // Everything mixed: 5-6 colours, up to 9 holes, 7×9 to 8×10.
    const t = Math.min(1, (n - 51) / 49);
    const big = hard || r.chance(0.35 + 0.5 * t);
    Object.assign(P, {
      w: big ? 8 : 7,
      h: big ? 10 : 9,
      colors: hard ? 5 : r.chance(0.3 + 0.5 * t) ? 6 : 5,
      holes: hard ? 9 : big ? 8 + r.int(2) : 7 + r.int(2),
      shapes: ALL_SHAPES,
      need: [2, 12],
      floor: FLOOR_STYLES,
      walls: 1 + r.int(3),
      fence: r.chance(0.2),
      fill: 0.9,
      maxStartHoles: 4,
    });
    if (r.chance(0.45)) P.axis = 1 + r.int(2);
    if (r.chance(0.35)) P.lock = 2 + r.int(3);
    if (r.chance(0.4)) P.box = 1 + r.int(3);
    if (r.chance(0.4)) P.ice = 1 + r.int(2);
    if (hard) Object.assign(P, { walls: 3, fence: false, axis: Math.max(P.axis || 0, 1) });
  }
  P.holes = Math.max(P.holes, P.colors);
  if (P.fence) P.walls = Math.min(P.walls || 0, 1);
  if (!P.cats) P.cats = catRange(P.w, P.h, P.holes, n <= 20 ? 0.7 : 0.8, 2 * (P.walls || 0) + (P.fence ? P.w - 2 : 0));
  const base = n > 100 ? targetDifficulty(100) - 0.2 + 0.3 * r.next() : targetDifficulty(n);
  if (intro) P.target = [0, 0.15];
  else if (hard) P.target = [base + 0.6, base + 1.2];
  else P.target = [Math.max(0, base - 0.15), base + 0.15];
  return P;
}
