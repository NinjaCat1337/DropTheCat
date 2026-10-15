// Game rules (pure, no DOM; importable by Node). Holes slide one cell at a time over a grid. When a hole
// covers a cat of its own colour, the cat drops in; a hole that has swallowed `need` cats closes and leaves
// the board. The level is won when every hole has closed. Shared by the UI, the hint solver and the level
// generator, so the rules exist exactly once.
//
// Level definition (plain JSON):
//   { w, h,
//     grid:  string[h], each w chars: '.' floor, '#' wall, '_' void (not part of the board),
//            'L' locked crate standing on floor (blocks holes until a key cat drops),
//     cats:  [[x, y, color, mods?], ...]   color 0..11; mods (optional object):
//            { box: 1 }  hidden in a box: blocks every hole until a cat next to it (4-neighbour) drops,
//            { ice: n }  frozen: blocks every hole until n more cats (anywhere) have dropped,
//            { key: 1 }  carries the key: when it drops, every 'L' crate opens,
//            { hungry: D }  hungry cat: it must drop before the move counter reaches D (see Game.moves),
//                           otherwise the level is lost (Game.isFailed); cannot be boxed or frozen,
//     gates: [[x, y, c], ...]  optional coloured gates on floor cells: only a hole whose current colour is c
//            may cover such a cell; cats never stand on gates. c must be the colour of a single-layer hole
//            (a layered hole changes colour and could be shut out behind its own gate).
//     holes: [{ x, y, c, cells: [[dx, dy], ...], need, next?: [[c2, need2], ...], axis?: 'h' | 'v' }, ...] }
// x = column (0 = left), y = row (0 = top). A hole at (x, y) covers (x + dx, y + dy) for each of its cells.
// Layered holes: a hole with `next` first takes `need` cats of colour c; then it turns colour c2 and takes
// need2 cats, and so on; it closes after its last layer. A colour used by a layered hole may not be used by
// any other hole (or twice in its layers), so a layer never finishes while it still covers a cat of its colour.
// Per colour, the needs of all layers must add up to the number of cats of that colour.
import { normalize, isConnected } from './shapes.js';

export const VOID = 0;
export const FLOOR = 1;
export const WALL = 2;
export const LOCK = 3;
export const MAX_COLORS = 12;
export const DIRS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);

const BOX = 1;
const KEY = 2;
const MAX_SIDE = 16;

function fail(msg) {
  throw new Error(`level: ${msg}`);
}

/**
 * Validates a level definition and turns it into the immutable structure a Game runs on.
 * Throws an Error describing the first problem found.
 * @param {object} def
 */
export function compileLevel(def) {
  if (!def || typeof def !== 'object') fail('not an object');
  const w = def.w;
  const h = def.h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) {
    fail(`bad size ${w}×${h}`);
  }
  const n = w * h;
  const ground = new Uint8Array(n);
  if (!Array.isArray(def.grid) || def.grid.length !== h) fail(`grid must have ${h} rows`);
  let hasLocks = false;
  for (let y = 0; y < h; y++) {
    const row = def.grid[y];
    if (typeof row !== 'string' || row.length !== w) fail(`grid row ${y} must have ${w} chars`);
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      const g = ch === '.' ? FLOOR : ch === '#' ? WALL : ch === '_' ? VOID : ch === 'L' ? LOCK : -1;
      if (g < 0) fail(`bad grid char "${ch}" at ${x},${y}`);
      if (g === LOCK) hasLocks = true;
      ground[y * w + x] = g;
    }
  }

  const color = new Int8Array(n).fill(-1);
  const flags = new Uint8Array(n);
  const ice = new Uint8Array(n);
  const hungry = new Int16Array(n);
  const perColor = new Array(MAX_COLORS).fill(0);
  let keys = 0;
  if (!Array.isArray(def.cats)) fail('cats must be an array');
  for (const cat of def.cats) {
    if (!Array.isArray(cat) || cat.length < 3) fail('a cat must be [x, y, color, mods?]');
    const [x, y, c, mods] = cat;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h) fail(`cat off board at ${x},${y}`);
    if (!Number.isInteger(c) || c < 0 || c >= MAX_COLORS) fail(`bad cat colour ${c} at ${x},${y}`);
    const i = y * w + x;
    if (ground[i] !== FLOOR) fail(`cat at ${x},${y} is not on plain floor`);
    if (color[i] !== -1) fail(`two cats at ${x},${y}`);
    color[i] = c;
    perColor[c]++;
    if (mods !== undefined && mods !== null) {
      if (typeof mods !== 'object') fail(`bad mods at ${x},${y}`);
      if (mods.box) flags[i] |= BOX;
      if (mods.key) {
        flags[i] |= KEY;
        keys++;
      }
      if (mods.ice !== undefined && mods.ice !== 0) {
        if (!Number.isInteger(mods.ice) || mods.ice < 0 || mods.ice > 99) fail(`bad ice at ${x},${y}`);
        if (mods.box) fail(`cat at ${x},${y} cannot be both boxed and frozen`);
        ice[i] = mods.ice;
      }
      if (mods.hungry !== undefined && mods.hungry !== 0) {
        if (!Number.isInteger(mods.hungry) || mods.hungry < 1 || mods.hungry > 999) fail(`bad hungry at ${x},${y}`);
        if (mods.box || ice[i]) fail(`hungry cat at ${x},${y} cannot be boxed or frozen`);
        hungry[i] = mods.hungry;
      }
    }
  }
  if (hasLocks && keys === 0) fail('locked crates need at least one key cat');

  if (!Array.isArray(def.holes) || def.holes.length === 0) fail('holes must be a non-empty array');
  if (def.holes.length > 100) fail('too many holes');
  const holes = [];
  const hx = new Int16Array(def.holes.length);
  const hy = new Int16Array(def.holes.length);
  const need = new Int16Array(def.holes.length);
  const taken = new Int8Array(n).fill(-1);
  const needPerColor = new Array(MAX_COLORS).fill(0);
  const users = Array.from({ length: MAX_COLORS }, () => []);
  def.holes.forEach((hole, k) => {
    if (!hole || typeof hole !== 'object') fail(`hole ${k} is not an object`);
    const { c, axis } = hole;
    if (!Number.isInteger(c) || c < 0 || c >= MAX_COLORS) fail(`hole ${k}: bad colour ${c}`);
    if (axis !== undefined && axis !== null && axis !== 'h' && axis !== 'v') fail(`hole ${k}: bad axis ${axis}`);
    if (!Array.isArray(hole.cells) || !hole.cells.length || hole.cells.some((p) => !Array.isArray(p) || !Number.isInteger(p[0]) || !Number.isInteger(p[1]))) {
      fail(`hole ${k}: bad cells`);
    }
    if (!isConnected(hole.cells)) fail(`hole ${k}: cells must form one connected piece`);
    if (!Number.isInteger(hole.need) || hole.need < 1) fail(`hole ${k}: need must be ≥ 1`);
    // Normalize the shape and move the origin so the covered cells stay the same.
    let mx = Infinity;
    let my = Infinity;
    for (const [dx, dy] of hole.cells) {
      mx = Math.min(mx, dx);
      my = Math.min(my, dy);
    }
    const layers = [{ c, need: hole.need }];
    if (hole.next !== undefined && hole.next !== null) {
      if (!Array.isArray(hole.next) || hole.next.length > 7) fail(`hole ${k}: bad next layers`);
      for (const layer of hole.next) {
        if (!Array.isArray(layer) || layer.length !== 2) fail(`hole ${k}: a layer must be [colour, need]`);
        const [lc, ln] = layer;
        if (!Number.isInteger(lc) || lc < 0 || lc >= MAX_COLORS) fail(`hole ${k}: bad layer colour ${lc}`);
        if (!Number.isInteger(ln) || ln < 1) fail(`hole ${k}: layer need must be ≥ 1`);
        layers.push({ c: lc, need: ln });
      }
    }
    const cells = normalize(hole.cells);
    const ox = hole.x + mx;
    const oy = hole.y + my;
    let bw = 0;
    let bh = 0;
    for (const [dx, dy] of cells) {
      const x = ox + dx;
      const y = oy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) fail(`hole ${k} off board`);
      const i = y * w + x;
      if (ground[i] !== FLOOR) fail(`hole ${k} at ${x},${y} is not on plain floor`);
      if (color[i] !== -1) fail(`hole ${k} starts on a cat at ${x},${y}`);
      if (taken[i] !== -1) fail(`holes ${taken[i]} and ${k} overlap at ${x},${y}`);
      taken[i] = k;
      bw = Math.max(bw, dx + 1);
      bh = Math.max(bh, dy + 1);
    }
    hx[k] = ox;
    hy[k] = oy;
    need[k] = hole.need;
    for (const layer of layers) {
      needPerColor[layer.c] += layer.need;
      users[layer.c].push(k);
    }
    holes.push(Object.freeze({
      c,
      layers: Object.freeze(layers.map((layer) => Object.freeze(layer))),
      axis: axis || null,
      cells: Object.freeze(cells.map((p) => Object.freeze(p))),
      bw,
      bh,
    }));
  });
  holes.forEach((hole, k) => {
    if (hole.layers.length < 2) return;
    for (const { c } of hole.layers) {
      if (users[c].length !== 1) fail(`hole ${k}: layered colour ${c} must belong to this hole alone, once`);
    }
  });
  for (let c = 0; c < MAX_COLORS; c++) {
    if (perColor[c] !== needPerColor[c]) {
      fail(`colour ${c}: ${perColor[c]} cat(s) but the holes need ${needPerColor[c]}`);
    }
  }

  const gate = new Int8Array(n).fill(-1);
  let hasGates = false;
  if (def.gates !== undefined && def.gates !== null) {
    if (!Array.isArray(def.gates)) fail('gates must be an array');
    for (const g of def.gates) {
      if (!Array.isArray(g) || g.length !== 3) fail('a gate must be [x, y, colour]');
      const [x, y, c] = g;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h) fail(`gate off board at ${x},${y}`);
      if (!Number.isInteger(c) || c < 0 || c >= MAX_COLORS) fail(`bad gate colour ${c} at ${x},${y}`);
      const i = y * w + x;
      if (ground[i] !== FLOOR) fail(`gate at ${x},${y} is not on plain floor`);
      if (color[i] !== -1) fail(`gate at ${x},${y} holds a cat`);
      if (gate[i] !== -1) fail(`two gates at ${x},${y}`);
      const k = taken[i];
      if (k !== -1 && holes[k].layers[0].c !== c) fail(`hole ${k} starts on a gate of another colour at ${x},${y}`);
      if (!holes.some((hole) => hole.layers.length === 1 && hole.layers[0].c === c)) {
        fail(`gate colour ${c} at ${x},${y} must belong to a single-layer hole`);
      }
      gate[i] = c;
      hasGates = true;
    }
  }

  const catCells = [];
  for (let i = 0; i < n; i++) if (color[i] !== -1) catCells.push(i);
  return Object.freeze({
    w,
    h,
    n,
    ground,
    hasLocks,
    hasGates,
    gate,
    holes: Object.freeze(holes),
    catCells: Object.freeze(catCells),
    colors: Object.freeze(perColor.map((v, c) => (v > 0 ? c : -1)).filter((c) => c >= 0)),
    cat0: Object.freeze({ color, flags, ice, hungry }),
    hole0: Object.freeze({ x: hx, y: hy, need }),
    def,
  });
}

/**
 * One play-through of a level: mutable state plus the rules. Cats never move; they are addressed by their
 * cell index i = y * w + x. Holes are addressed by their index in the level definition.
 *
 * Events (returned by step / treat; pass `null` as the events array to skip them in hot loops):
 *   { type: 'drop', x, y, c, hole, left, key, fly? }  a cat dropped into `hole` (`left` = its remaining need)
 *   { type: 'reveal', x, y, c }                       a box opened, showing a cat of colour c
 *   { type: 'ice', x, y, left }                       a frozen cat thawed a bit
 *   { type: 'melt', x, y, c }                         the ice is gone
 *   { type: 'unlock', cells: [[x, y], ...] }          the key opened every crate
 *   { type: 'layer', hole, c, prev, need, hx, hy }    a layer is full: the hole turned colour c (from prev)
 *   { type: 'complete', hole, x, y }                  the hole is full and closed
 *   { type: 'win' }                                   every hole has closed
 * endMove() (called by the UI after each finished drag) returns:
 *   { type: 'hungry', x, y, left }                    a hungry cat now has `left` moves to go (left ≥ 1)
 *   { type: 'starve', x, y, c }                       a hungry cat waited too long: the level is lost
 */
export class Game {
  /** @param {object} level a level definition or the result of compileLevel() */
  constructor(level) {
    const L = level && level.ground instanceof Uint8Array ? level : compileLevel(level);
    this.L = L;
    this.color = L.cat0.color.slice();
    this.flags = L.cat0.flags.slice();
    this.ice = L.cat0.ice.slice();
    this.hx = L.hole0.x.slice();
    this.hy = L.hole0.y.slice();
    this.need = L.hole0.need.slice();
    this.layer = new Uint8Array(L.holes.length);
    this.locked = L.hasLocks;
    this.dropped = 0;
    this.moves = 0;
    this.grace = 0;
    this.holeAt = new Int8Array(L.n);
    this.rebuild();
  }

  get w() {
    return this.L.w;
  }

  get h() {
    return this.L.h;
  }

  get holeCount() {
    return this.L.holes.length;
  }

  /** Recomputes holeAt from the hole positions. */
  rebuild() {
    this.holeAt.fill(-1);
    for (let k = 0; k < this.L.holes.length; k++) if (this.need[k] > 0) this.mark(k, k);
  }

  mark(k, v) {
    const { w } = this.L;
    const x0 = this.hx[k];
    const y0 = this.hy[k];
    for (const [dx, dy] of this.L.holes[k].cells) this.holeAt[(y0 + dy) * w + x0 + dx] = v;
  }

  /** A copy that shares the immutable level. */
  clone() {
    const g = Object.create(Game.prototype);
    g.L = this.L;
    g.color = this.color.slice();
    g.flags = this.flags.slice();
    g.ice = this.ice.slice();
    g.hx = this.hx.slice();
    g.hy = this.hy.slice();
    g.need = this.need.slice();
    g.layer = this.layer.slice();
    g.locked = this.locked;
    g.dropped = this.dropped;
    g.moves = this.moves;
    g.grace = this.grace;
    g.holeAt = this.holeAt.slice();
    return g;
  }

  /** Mutable state as a plain object of typed-array copies (for undo). */
  snapshot() {
    return {
      color: this.color.slice(),
      flags: this.flags.slice(),
      ice: this.ice.slice(),
      hx: this.hx.slice(),
      hy: this.hy.slice(),
      need: this.need.slice(),
      layer: this.layer.slice(),
      locked: this.locked,
      dropped: this.dropped,
      moves: this.moves,
      grace: this.grace,
    };
  }

  /** Restores a snapshot() taken from a game of the same level. */
  restore(s) {
    this.color.set(s.color);
    this.flags.set(s.flags);
    this.ice.set(s.ice);
    this.hx.set(s.hx);
    this.hy.set(s.hy);
    this.need.set(s.need);
    if (s.layer) this.layer.set(s.layer);
    else this.layer.fill(0);
    this.locked = s.locked;
    this.dropped = s.dropped;
    this.moves = Number.isInteger(s.moves) ? s.moves : 0;
    this.grace = Number.isInteger(s.grace) ? s.grace : 0;
    this.rebuild();
  }

  /** JSON-safe state (for saving). */
  toJSON() {
    const s = this.snapshot();
    return {
      v: 1,
      color: Array.from(s.color),
      flags: Array.from(s.flags),
      ice: Array.from(s.ice),
      hx: Array.from(s.hx),
      hy: Array.from(s.hy),
      need: Array.from(s.need),
      layer: Array.from(s.layer),
      locked: s.locked,
      dropped: s.dropped,
      moves: s.moves,
      grace: s.grace,
    };
  }

  /**
   * Rebuilds a game from toJSON() output. Returns null when the data does not fit the level
   * (wrong sizes, cats that were never there, impossible needs…).
   */
  static fromJSON(level, data) {
    try {
      const g = new Game(level);
      const L = g.L;
      if (!data || data.v !== 1) return null;
      const ints = (a, len) => Array.isArray(a) && a.length === len && a.every(Number.isInteger);
      const m = L.holes.length;
      if (!ints(data.color, L.n) || !ints(data.flags, L.n) || !ints(data.ice, L.n)) return null;
      if (!ints(data.hx, m) || !ints(data.hy, m) || !ints(data.need, m)) return null;
      for (let i = 0; i < L.n; i++) {
        const c = data.color[i];
        if (c !== -1 && c !== L.cat0.color[i]) return null; // cats only ever disappear
      }
      const layer = data.layer === undefined ? new Array(m).fill(0) : data.layer;
      if (!ints(layer, m)) return null;
      for (let k = 0; k < m; k++) {
        const layers = L.holes[k].layers;
        if (layer[k] < 0 || layer[k] >= layers.length) return null;
        if (data.need[k] < 0 || data.need[k] > layers[layer[k]].need) return null;
        if (data.need[k] === 0 && layer[k] !== layers.length - 1) return null;
      }
      g.restore({
        color: Int8Array.from(data.color),
        flags: Uint8Array.from(data.flags),
        ice: Uint8Array.from(data.ice),
        hx: Int16Array.from(data.hx),
        hy: Int16Array.from(data.hy),
        need: Int16Array.from(data.need),
        layer: Uint8Array.from(layer),
        locked: !!data.locked && L.hasLocks,
        dropped: Number.isInteger(data.dropped) ? data.dropped : 0,
        moves: Number.isInteger(data.moves) && data.moves >= 0 ? data.moves : 0,
        grace: Number.isInteger(data.grace) && data.grace >= 0 ? data.grace : 0,
      });
      // Every open hole must stand on cells it may occupy, without overlapping another hole.
      const seen = new Int8Array(L.n).fill(-1);
      for (let k = 0; k < m; k++) {
        if (g.need[k] === 0) continue;
        for (const [dx, dy] of L.holes[k].cells) {
          const x = g.hx[k] + dx;
          const y = g.hy[k] + dy;
          if (x < 0 || y < 0 || x >= L.w || y >= L.h) return null;
          const i = y * L.w + x;
          if (seen[i] !== -1) return null;
          seen[i] = k;
        }
        if (!g.canPlace(k, g.hx[k], g.hy[k])) return null;
      }
      return g;
    } catch {
      return null;
    }
  }

  /** Compact key of the whole mutable state (solver visited sets). */
  stateKey() {
    let s = '';
    for (let k = 0; k < this.hx.length; k++) {
      s += this.need[k] > 0 ? `${this.hx[k]},${this.hy[k]},${this.layer[k]},${this.need[k]};` : '-;';
    }
    let bits = 0;
    let nb = 0;
    for (const i of this.L.catCells) {
      bits = bits * 2 + (this.color[i] === -1 ? 0 : 1);
      if (++nb === 30) {
        s += bits.toString(36) + '.';
        bits = 0;
        nb = 0;
      }
    }
    return s + bits.toString(36);
  }

  /** Colour of the hole's current layer. */
  holeColor(k) {
    return this.L.holes[k].layers[this.layer[k]].c;
  }

  /** Index of the hole's current layer (0 = first). */
  holeLayer(k) {
    return this.layer[k];
  }

  /** Colours of the layers still to come after the current one (empty for single-layer holes). */
  holeNext(k) {
    return this.L.holes[k].layers.slice(this.layer[k] + 1).map((layer) => layer.c);
  }

  holeCells(k) {
    return this.L.holes[k].cells;
  }

  holeAxis(k) {
    return this.L.holes[k].axis;
  }

  isOpenHole(k) {
    return this.need[k] > 0;
  }

  ground(x, y) {
    if (x < 0 || y < 0 || x >= this.L.w || y >= this.L.h) return VOID;
    const g = this.L.ground[y * this.L.w + x];
    return g === LOCK && !this.locked ? FLOOR : g;
  }

  /** Colour of the cat at (x, y), or -1. Boxed cats report their real colour (check isBoxed). */
  catAt(x, y) {
    if (x < 0 || y < 0 || x >= this.L.w || y >= this.L.h) return -1;
    return this.color[y * this.L.w + x];
  }

  isBoxed(x, y) {
    return (this.flags[y * this.L.w + x] & BOX) !== 0;
  }

  hasKey(x, y) {
    return (this.flags[y * this.L.w + x] & KEY) !== 0;
  }

  /** Colour of the gate on (x, y), or -1. */
  gateAt(x, y) {
    if (x < 0 || y < 0 || x >= this.L.w || y >= this.L.h) return -1;
    return this.L.gate[y * this.L.w + x];
  }

  /** Moves left for the hungry cat on (x, y) (≤ 0 = it starved), or null when it is not a hungry cat. */
  hungerAt(x, y) {
    const i = y * this.L.w + x;
    const d = this.L.cat0.hungry[i];
    return d && this.color[i] !== -1 ? d + this.grace - this.moves : null;
  }

  /**
   * One finished drag (or booster use) of the player: counts the move and reports hungry cats.
   * @param {object[] | null} [events]
   */
  endMove(events = []) {
    this.moves++;
    const { w, catCells } = this.L;
    const hungry = this.L.cat0.hungry;
    for (const i of catCells) {
      const d = hungry[i];
      if (!d || this.color[i] === -1) continue;
      const left = d + this.grace - this.moves;
      if (events) {
        const x = i % w;
        const y = (i - x) / w;
        events.push(left <= 0 ? { type: 'starve', x, y, c: this.color[i] } : { type: 'hungry', x, y, left });
      }
    }
    return events;
  }

  /** True when a hungry cat is still on the board after its last move (the level is lost). */
  isFailed() {
    const hungry = this.L.cat0.hungry;
    for (const i of this.L.catCells) if (hungry[i] && this.color[i] !== -1 && hungry[i] + this.grace - this.moves <= 0) return true;
    return false;
  }

  /** Snack booster: every hungry cat waits n more moves. */
  feed(n) {
    this.grace += n;
  }

  iceAt(x, y) {
    return this.ice[y * this.L.w + x];
  }

  /** True when a hole of colour c could stand on cell i right now (other holes ignored). */
  cellOpen(c, i) {
    const g = this.L.ground[i];
    if (g === VOID || g === WALL || (g === LOCK && this.locked)) return false;
    const gate = this.L.gate[i];
    if (gate !== -1 && gate !== c) return false;
    const cc = this.color[i];
    if (cc === -1) return true;
    return cc === c && (this.flags[i] & BOX) === 0 && this.ice[i] === 0;
  }

  /** True when hole k may cover cell (x, y): on the board, not blocked, not another hole's. */
  isOpen(k, x, y) {
    const { w, h } = this.L;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = y * w + x;
    const o = this.holeAt[i];
    if (o !== -1 && o !== k) return false;
    return this.cellOpen(this.holeColor(k), i);
  }

  /** True when hole k may stand with its origin at (x, y). */
  canPlace(k, x, y) {
    for (const [dx, dy] of this.L.holes[k].cells) if (!this.isOpen(k, x + dx, y + dy)) return false;
    return true;
  }

  /** True when hole k may move one cell by (dx, dy) (|dx| + |dy| = 1), respecting its axis lock. */
  canStep(k, dx, dy) {
    if (this.need[k] <= 0) return false;
    const axis = this.L.holes[k].axis;
    if ((axis === 'h' && dy !== 0) || (axis === 'v' && dx !== 0)) return false;
    return this.canPlace(k, this.hx[k] + dx, this.hy[k] + dy);
  }

  /**
   * Moves hole k one cell (caller checked canStep) and drops every matching cat it now covers.
   * @param {object[] | null} [events] receives the events (see class comment); null skips them
   * @returns {object[] | null} the events array
   */
  step(k, dx, dy, events = []) {
    this.mark(k, -1);
    this.hx[k] += dx;
    this.hy[k] += dy;
    this.mark(k, k);
    this.collect(k, events);
    return events;
  }

  /** Drops the matching cats under hole k (in cell order) until it is full. */
  collect(k, events = []) {
    const { w } = this.L;
    const c = this.holeColor(k);
    for (const [dx, dy] of this.L.holes[k].cells) {
      if (this.need[k] <= 0 || this.holeColor(k) !== c) break;
      const i = (this.hy[k] + dy) * w + this.hx[k] + dx;
      if (this.color[i] === c && (this.flags[i] & BOX) === 0 && this.ice[i] === 0) this.drop(i, k, events, false);
    }
    return events;
  }

  drop(i, k, events, fly) {
    const { w, h, n } = this.L;
    const x = i % w;
    const y = (i - x) / w;
    const c = this.color[i];
    const key = (this.flags[i] & KEY) !== 0;
    this.color[i] = -1;
    this.flags[i] = 0;
    this.ice[i] = 0;
    this.need[k]--;
    this.dropped++;
    if (events) {
      const e = { type: 'drop', x, y, c, hole: k, left: this.need[k], key };
      if (fly) e.fly = true;
      events.push(e);
    }
    // Boxes next to the dropped cat open.
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (this.color[j] !== -1 && (this.flags[j] & BOX) !== 0) {
        this.flags[j] &= ~BOX;
        if (events) events.push({ type: 'reveal', x: nx, y: ny, c: this.color[j] });
      }
    }
    // Every frozen cat thaws by one.
    for (let j = 0; j < n; j++) {
      if (this.ice[j] === 0) continue;
      this.ice[j]--;
      if (events) {
        const jx = j % w;
        const jy = (j - jx) / w;
        events.push(this.ice[j] === 0 ? { type: 'melt', x: jx, y: jy, c: this.color[j] } : { type: 'ice', x: jx, y: jy, left: this.ice[j] });
      }
    }
    if (key && this.locked) {
      this.locked = false;
      if (events) {
        const cells = [];
        for (let j = 0; j < n; j++) if (this.L.ground[j] === LOCK) cells.push([j % w, Math.floor(j / w)]);
        events.push({ type: 'unlock', cells });
      }
    }
    const layers = this.L.holes[k].layers;
    if (this.need[k] === 0 && this.layer[k] + 1 < layers.length) {
      // Layer filled: the hole turns the next colour and wants that layer's cats.
      const prev = layers[this.layer[k]].c;
      this.layer[k]++;
      this.need[k] = layers[this.layer[k]].need;
      if (events) {
        events.push({ type: 'layer', hole: k, c: layers[this.layer[k]].c, prev, need: this.need[k], hx: this.hx[k], hy: this.hy[k] });
      }
    } else if (this.need[k] === 0) {
      this.mark(k, -1);
      if (events) {
        events.push({ type: 'complete', hole: k, x: this.hx[k], y: this.hy[k] });
        if (this.isWon()) events.push({ type: 'win' });
      }
    }
  }

  isWon() {
    for (let k = 0; k < this.need.length; k++) if (this.need[k] > 0) return false;
    return true;
  }

  /** Cats still on the board. */
  catsLeft() {
    let v = 0;
    for (const i of this.L.catCells) if (this.color[i] !== -1) v++;
    return v;
  }

  /**
   * Cat treat booster: the nearest active (not boxed, not frozen) cats of the hole's colour jump into it
   * until its current layer is full or none is left. Returns the events (drops carry fly: true and their cell).
   */
  treat(k, events = []) {
    if (this.need[k] <= 0) return events;
    const { w } = this.L;
    const { bw, bh } = this.L.holes[k];
    const c = this.holeColor(k);
    const layer = this.layer[k];
    const cx = this.hx[k] + (bw - 1) / 2;
    const cy = this.hy[k] + (bh - 1) / 2;
    while (this.need[k] > 0 && this.layer[k] === layer) {
      let best = -1;
      let bestD = Infinity;
      for (const i of this.L.catCells) {
        if (this.color[i] !== c || (this.flags[i] & BOX) !== 0 || this.ice[i] !== 0) continue;
        const x = i % w;
        const y = (i - x) / w;
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) break;
      this.drop(best, k, events, true);
    }
    return events;
  }

  /**
   * True when hole k can reach a cat it could swallow if every other hole moved out of the way
   * (other holes are ignored; walls, closed crates and other cats block).
   */
  canEverCollect(k) {
    if (this.need[k] <= 0) return false;
    const { w, h } = this.L;
    const hole = this.L.holes[k];
    const { cells, axis, bw, bh } = hole;
    const c = this.holeColor(k);
    const seen = new Uint8Array(w * h);
    const fits = (x, y) => {
      if (x < 0 || y < 0 || x + bw > w || y + bh > h) return false;
      for (const [dx, dy] of cells) if (!this.cellOpen(c, (y + dy) * w + x + dx)) return false;
      return true;
    };
    const covers = (x, y) => {
      for (const [dx, dy] of cells) {
        const i = (y + dy) * w + x + dx;
        if (this.color[i] === c) return true; // open + same colour = swallowable
      }
      return false;
    };
    const queue = [this.hx[k], this.hy[k]];
    seen[this.hy[k] * w + this.hx[k]] = 1;
    for (let q = 0; q < queue.length; q += 2) {
      const x = queue[q];
      const y = queue[q + 1];
      if (covers(x, y)) return true;
      for (const [dx, dy] of DIRS) {
        if ((axis === 'h' && dy !== 0) || (axis === 'v' && dx !== 0)) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx]) continue;
        if (!fits(nx, ny)) continue;
        seen[ny * w + nx] = 1;
        queue.push(nx, ny);
      }
    }
    return false;
  }

  /**
   * True when no cat can ever drop again although holes are still open (the level cannot be finished
   * from here). Sound but not complete: deeper dead ends are only detected once they reach this point.
   */
  isStuck() {
    if (this.isWon()) return false;
    for (let k = 0; k < this.need.length; k++) if (this.canEverCollect(k)) return false;
    return true;
  }
}
