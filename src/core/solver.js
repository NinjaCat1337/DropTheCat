// Hint solver: finds a sequence of drags that wins the level from the current state of a Game. Pure (no DOM);
// importable by Node and the browser. Every move is checked and played with the Game API (canStep / step), so
// the rules exist only in rules.js.
//
// Search space — "macro-moves": from a state, each open hole slides through positions where it swallows
// nothing (a BFS over its positions; walls, other cats and other holes block exactly as canStep says) and
// stops on the first position that covers a cat of its colour. Every macro-move drops at least one cat, so a
// level with N cats needs at most N of them. When holes block each other, "repositioning" moves (a blocking
// hole slides aside without swallowing anything) are added, deferred behind the productive moves.
//
// Pruning and ordering:
//  * coverage — a hole can only ever stand inside its connected component of the empty board (walls, void and
//    its axis lock never change), so the cells it can ever cover are known per level.
//  * safe moves — when no other open hole of its colour can ever cover the cats a move swallows (always the
//    case for the last open hole of a colour), those cats are this hole's in every solution. Swallowing them
//    now never turns a winnable state into a lost one (cats only disappear, which only opens cells, boxes,
//    ice and crates, and the hole can retrace its path), so such a move is the node's only child. Branching
//    is left to cats that several holes of one colour could take: the allocation choices.
//  * allocation check — a state where the remaining cats of a colour cannot be shared out among that colour's
//    open holes (each taking exactly its need, within its coverage; bipartite b-matching) is dropped.
//  * visited set up to free slides — after a move, the moved hole's position is canonicalized to the lowest
//    position it can slide to without swallowing anything (equivalent states, since such slides reverse).
//  * best-first on the number of cats left (ties: most recent first), so the search dives and backtracks to
//    the latest choice; at a choice, a hole reaching a cat sooner than its same-coloured rivals goes first.
//    Repositioning costs as much as 12 cats, so it is tried only once the productive lines below failed.
//  * restarts — runs restart with a doubled budget and slightly shuffled preferences (heavy-tailed searches).
import { DIRS, FLOOR, LOCK } from './rules.js';

const DX = DIRS.map((d) => d[0]);
const DY = DIRS.map((d) => d[1]);
const DCH = DIRS.map(([dx, dy]) => (dx > 0 ? 'R' : dx < 0 ? 'L' : dy > 0 ? 'D' : 'U'));
/** Direction letter → [dx, dy]. R = +x, D = +y. */
export const STEPS = Object.freeze({ R: [1, 0], L: [-1, 0], D: [0, 1], U: [0, -1] });

const now = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());

// ---------------------------------------------------------------------------------------------------------
// Per-level helper (cached on the compiled level)
// ---------------------------------------------------------------------------------------------------------

const explorers = new WeakMap();

/** The (cached) Explorer of a compiled level (game.L). */
export function explorer(L) {
  let ex = explorers.get(L);
  if (!ex) {
    ex = new Explorer(L);
    explorers.set(L, ex);
  }
  return ex;
}

/** Cells hole k can ever cover: its connected component of positions on the board without cats or holes. */
function staticCover(L, k) {
  const { w, h, n, ground } = L;
  const hole = L.holes[k];
  const { cells, axis, bw, bh } = hole;
  const cover = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const fits = (x, y) => {
    for (const [dx, dy] of cells) {
      const g = ground[(y + dy) * w + x + dx];
      if (g !== FLOOR && g !== LOCK) return false;
    }
    return true;
  };
  const x0 = L.hole0.x[k];
  const y0 = L.hole0.y[k];
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
      if (nx < 0 || ny < 0 || nx + bw > w || ny + bh > h || seen[ny * w + nx]) continue;
      seen[ny * w + nx] = 1;
      if (fits(nx, ny)) queue.push(nx, ny);
    }
  }
  return cover;
}

/**
 * Move generation and dead-end checks for one compiled level. Holds scratch buffers, so it is not re-entrant
 * (fine: everything here is synchronous).
 */
export class Explorer {
  constructor(L) {
    this.L = L;
    const { w, n } = L;
    this.open = new Uint8Array(n);
    this.match = new Uint8Array(n);
    this.seen = new Uint32Array(n);
    this.stamp = 0;
    this.offs = L.holes.map((hole) => Int16Array.from(hole.cells, ([dx, dy]) => dy * w + dx));
    this.cover = L.holes.map((_, k) => staticCover(L, k));
    this.holesOf = Array.from({ length: 8 }, () => []);
    L.holes.forEach((hole, k) => this.holesOf[hole.c].push(k));
    this.catsOf = Array.from({ length: 8 }, () => []);
    for (const i of L.catCells) this.catsOf[L.cat0.color[i]].push(i);
  }

  /**
   * BFS over hole k's positions from where it stands. `region` = positions reachable without swallowing
   * anything (BFS order, the current one first); `targets` = positions next to the region where it would
   * swallow at least one cat (each reached by a shortest path through the region). Positions are encoded
   * y * w + x of the hole's origin. With ignoreHoles, other holes do not block (used to detect blockers).
   */
  scan(g, k, ignoreHoles = false) {
    const L = this.L;
    const { w, h, n } = L;
    const hole = L.holes[k];
    const { c, axis } = hole;
    const open = this.open;
    const match = this.match;
    const color = g.color;
    const holeAt = g.holeAt;
    for (let i = 0; i < n; i++) {
      const o = holeAt[i];
      const ok = (o === -1 || o === k || ignoreHoles) && g.cellOpen(c, i);
      open[i] = ok ? 1 : 0;
      match[i] = ok && color[i] === c ? 1 : 0;
    }
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const seen = this.seen;
    const offs = this.offs[k];
    const maxX = w - hole.bw;
    const maxY = h - hole.bh;
    const parent = new Int16Array(n);
    const dir = new Int8Array(n);
    const start = g.hy[k] * w + g.hx[k];
    seen[start] = stamp;
    parent[start] = -1;
    const region = [start];
    const targets = [];
    for (let qi = 0; qi < region.length; qi++) {
      const p = region[qi];
      const px = p % w;
      const py = (p - px) / w;
      for (let d = 0; d < 4; d++) {
        if ((axis === 'h' && DY[d] !== 0) || (axis === 'v' && DX[d] !== 0)) continue;
        const nx = px + DX[d];
        const ny = py + DY[d];
        if (nx < 0 || ny < 0 || nx > maxX || ny > maxY) continue;
        const q = ny * w + nx;
        if (seen[q] === stamp) continue;
        seen[q] = stamp;
        let ok = true;
        let col = false;
        for (let j = 0; j < offs.length; j++) {
          const i = q + offs[j];
          if (!open[i]) {
            ok = false;
            break;
          }
          if (match[i]) col = true;
        }
        if (!ok) continue;
        parent[q] = p;
        dir[q] = d;
        if (col) targets.push(q);
        else region.push(q);
      }
    }
    return { k, region, targets, parent, dir, start };
  }

  /** Direction string from the scan's start to position q. */
  pathTo(scan, q) {
    let s = '';
    for (let p = q; p !== scan.start; p = scan.parent[p]) s = DCH[scan.dir[p]] + s;
    return s;
  }

  /** Number of steps from the scan's start to position q. */
  distTo(scan, q) {
    let d = 0;
    for (let p = q; p !== scan.start; p = scan.parent[p]) d++;
    return d;
  }

  /** Cat cells of hole k's colour that hole k would cover at position q (in the scanned state). */
  catsUnder(g, k, q) {
    const c = this.L.holes[k].c;
    const out = [];
    for (const o of this.offs[k]) if (g.color[q + o] === c) out.push(q + o);
    return out;
  }

  /**
   * True when no other open hole of hole k's colour can ever cover any of the cats k would swallow at q:
   * those cats are k's in every solution, so swallowing them now is safe.
   */
  exclusive(g, k, q) {
    const c = this.L.holes[k].c;
    const rivals = this.holesOf[c];
    for (const o of this.offs[k]) {
      const i = q + o;
      if (g.color[i] !== c) continue;
      for (const j of rivals) if (j !== k && g.need[j] > 0 && this.cover[j][i]) return false;
    }
    return true;
  }

  /**
   * False when the remaining cats of some colour cannot be shared out among that colour's open holes, each
   * hole taking exactly its need, using only the cells it can ever cover. Sound: never rejects a winnable state.
   */
  feasible(g) {
    const { need, color } = g;
    for (let c = 0; c < 8; c++) {
      const hs = this.holesOf[c];
      if (!hs.length) continue;
      const open = [];
      for (const k of hs) if (need[k] > 0) open.push(k);
      const cats = [];
      for (const i of this.catsOf[c]) if (color[i] !== -1) cats.push(i);
      if (!open.length) {
        if (cats.length) return false;
        continue;
      }
      if (open.length === 1) {
        const cov = this.cover[open[0]];
        for (const i of cats) if (!cov[i]) return false;
        continue;
      }
      if (!this.bmatch(open, cats, need)) return false;
    }
    return true;
  }

  bmatch(open, cats, need) {
    const m = open.length;
    const cover = this.cover;
    const load = new Int16Array(m);
    const owner = new Int8Array(cats.length).fill(-1);
    let visited = null;
    const tryCat = (ci) => {
      for (let a = 0; a < m; a++) {
        if (visited[a] || !cover[open[a]][cats[ci]]) continue;
        visited[a] = 1;
        if (load[a] < need[open[a]]) {
          owner[ci] = a;
          load[a]++;
          return true;
        }
        for (let cj = 0; cj < cats.length; cj++) {
          if (owner[cj] !== a) continue;
          owner[cj] = -1;
          load[a]--;
          if (tryCat(cj)) {
            owner[ci] = a;
            load[a]++;
            return true;
          }
          owner[cj] = a;
          load[a]++;
        }
      }
      return false;
    };
    for (let ci = 0; ci < cats.length; ci++) {
      visited = new Uint8Array(m);
      if (!tryCat(ci)) return false;
    }
    return true;
  }

  /**
   * Visited-set key of a state, up to free slides of hole k (-1: none): hole k first slides — swallowing
   * nothing — to the lowest position of the area it can reach. The key is the stateKey of a state reachable
   * from g and back (such slides are reversible), so equal keys always mean equivalent states, while states
   * that only differ by where hole k stands in its free area merge.
   */
  canonKey(g, k) {
    if (k < 0 || g.need[k] <= 0) return g.stateKey();
    const s = this.scan(g, k);
    let best = s.start;
    for (const p of s.region) if (p < best) best = p;
    if (best === s.start) return g.stateKey();
    const t = g.clone();
    applyPath(t, k, this.pathTo(s, best));
    return t.stateKey();
  }

  /** Every productive macro-move: [{ hole, path, pos }] (pos = target origin y * w + x). */
  productiveMoves(g) {
    const out = [];
    for (let k = 0; k < g.need.length; k++) {
      if (g.need[k] <= 0) continue;
      const s = this.scan(g, k);
      for (const q of s.targets) out.push({ hole: k, path: this.pathTo(s, q), pos: q });
    }
    return out;
  }

  /**
   * Repositioning moves that unblock another hole: [{ hole, path }] where `hole` slides (swallowing nothing)
   * to a position from which some other hole can reach a target it could not reach before.
   * @param {number} perPair how many positions to try to keep per (blocker, blocked) pair
   */
  unblockMoves(g, scans = null, perPair = 2) {
    const L = this.L;
    const { w } = L;
    const m = g.need.length;
    const sc = scans || [];
    const get = (k) => sc[k] || (sc[k] = this.scan(g, k));
    const out = [];
    const used = new Set();
    for (let k = 0; k < m; k++) {
      if (g.need[k] <= 0) continue;
      const base = get(k);
      const free = this.scan(g, k, true);
      const have = new Set(base.targets);
      if (!free.targets.some((q) => !have.has(q))) continue;
      // Cells hole k could use if no hole were in the way.
      const cellsK = new Set();
      for (const list of [free.region, free.targets]) for (const p of list) for (const o of this.offs[k]) cellsK.add(p + o);
      for (let j = 0; j < m; j++) {
        if (j === k || g.need[j] <= 0) continue;
        let blocks = false;
        for (const o of this.offs[j]) if (cellsK.has(g.hy[j] * w + g.hx[j] + o)) blocks = true;
        if (!blocks) continue;
        const sj = get(j);
        let found = 0;
        for (let r = 1; r < sj.region.length && found < perPair; r++) {
          const p = sj.region[r];
          const key = j * 4096 + p;
          if (used.has(key)) continue;
          const path = this.pathTo(sj, p);
          const t = g.clone();
          if (!applyPath(t, j, path)) continue;
          const after = this.scan(t, k);
          if (after.targets.some((q) => !have.has(q))) {
            used.add(key);
            out.push({ hole: j, path, game: t });
            found++;
          }
        }
      }
    }
    return out;
  }

  /** Last resort when nothing is productive: a few positions for every hole (farthest first). */
  anyRepositions(g, perHole = 3) {
    const out = [];
    for (let j = 0; j < g.need.length; j++) {
      if (g.need[j] <= 0) continue;
      const s = this.scan(g, j);
      const reg = s.region;
      if (reg.length < 2) continue;
      const picks = new Set([reg[reg.length - 1], reg[Math.floor(reg.length / 2)], reg[1]]);
      let c = 0;
      for (const p of picks) {
        if (c++ >= perHole) break;
        const path = this.pathTo(s, p);
        const t = g.clone();
        if (applyPath(t, j, path)) out.push({ hole: j, path, game: t });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Playing paths
// ---------------------------------------------------------------------------------------------------------

/**
 * Plays `path` (a string of R/L/U/D) with hole k on `game` (mutates it). Stops early, successfully, if the
 * hole closes exactly on the last letter; returns false if a step is not allowed or letters remain after the
 * hole closed.
 */
export function applyPath(game, k, path) {
  for (let s = 0; s < path.length; s++) {
    const d = STEPS[path[s]];
    if (!d || !game.canStep(k, d[0], d[1])) return false;
    game.step(k, d[0], d[1], null);
  }
  return true;
}

/** Plays a list of moves ({ hole, path } or [hole, path]) on a clone; returns the final game or null. */
export function replay(game, moves) {
  const g = game.clone();
  for (const mv of moves) {
    const k = Array.isArray(mv) ? mv[0] : mv.hole;
    const path = Array.isArray(mv) ? mv[1] : mv.path;
    if (!applyPath(g, k, path)) return null;
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------------------

class Heap {
  constructor() {
    this.a = [];
  }

  get size() {
    return this.a.length;
  }

  static less(x, y) {
    return x.f < y.f || (x.f === y.f && x.seq > y.seq);
  }

  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let b = i;
        if (l < a.length && Heap.less(a[l], a[b])) b = l;
        if (r < a.length && Heap.less(a[r], a[b])) b = r;
        if (b === i) break;
        [a[i], a[b]] = [a[b], a[i]];
        i = b;
      }
    }
    return top;
  }
}

/** Priority cost of a repositioning move, in quarter-cats: one counts like 12 cats still to drop. */
const REPOSITION_COST = 48;

function catsLeft(g) {
  let s = 0;
  for (let k = 0; k < g.need.length; k++) if (g.need[k] > 0) s += g.need[k];
  return s;
}

/** Moves from the root to `node`, consecutive moves of the same hole merged into one drag. */
function movesOf(node) {
  const list = [];
  for (let p = node; p && p.k >= 0; p = p.parent) list.push(p);
  list.reverse();
  const out = [];
  for (const p of list) {
    const last = out[out.length - 1];
    if (last && last.hole === p.k) last.path += p.path;
    else out.push({ hole: p.k, path: p.path });
  }
  return out.filter((mv) => mv.path.length > 0);
}

/**
 * Children of a node: [{ k, path, game }] — a single safe move when one exists, otherwise every productive
 * move, preferred first. rng (optional) shuffles the preference a little (used by restarts).
 */
function expand(ex, g, lastHole, rng) {
  const m = g.need.length;
  const L = ex.L;
  // Safe move (every cat it swallows can only ever be this hole's): the last moved hole first (longer
  // drags), then the others; nearest target first (BFS order).
  const order = [];
  if (lastHole >= 0 && g.need[lastHole] > 0) order.push(lastHole);
  for (let k = 0; k < m; k++) if (k !== lastHole && g.need[k] > 0) order.push(k);
  const scans = new Array(m);
  for (const k of order) {
    const s = ex.scan(g, k);
    scans[k] = s;
    for (const q of s.targets) {
      if (!ex.exclusive(g, k, q)) continue;
      const path = ex.pathTo(s, q);
      const t = g.clone();
      applyPath(t, k, path);
      return { kids: [{ k, path, game: t }], safe: true };
    }
  }
  // No safe move: branch over every productive move. Distance from each open hole to each cat it can
  // swallow next, for the ordering.
  const dist = new Map(); // k * 4096 + cell → steps
  for (let k = 0; k < m; k++) {
    const s = scans[k];
    if (!s) continue;
    for (const q of s.targets) {
      const d = ex.distTo(s, q);
      for (const cell of ex.catsUnder(g, k, q)) {
        const key = k * 4096 + cell;
        const old = dist.get(key);
        if (old === undefined || d < old) dist.set(key, d);
      }
    }
  }
  const ranked = [];
  for (let k = 0; k < m; k++) {
    const s = scans[k];
    if (!s || !s.targets.length) continue;
    const c = L.holes[k].c;
    for (const q of s.targets) {
      const d = ex.distTo(s, q);
      const cats = ex.catsUnder(g, k, q);
      // "Steal" = how much farther this hole is from these cats than its nearest rival of the same colour.
      let rival = Infinity;
      for (const j of ex.holesOf[c]) {
        if (j === k || g.need[j] <= 0) continue;
        for (const cell of cats) {
          const dj = dist.get(j * 4096 + cell);
          if (dj !== undefined && dj < rival) rival = dj;
        }
      }
      let score = (rival === Infinity ? -1 : Math.max(0, d - rival)) * 4 - Math.min(cats.length, 2) + d * 0.25;
      if (k === lastHole) score -= 0.5;
      if (rng) score += rng.next() * 6;
      ranked.push({ k, q, score });
    }
  }
  ranked.sort((a, b) => a.score - b.score || a.k - b.k || a.q - b.q);
  const kids = [];
  for (const r of ranked) {
    const path = ex.pathTo(scans[r.k], r.q);
    const t = g.clone();
    applyPath(t, r.k, path);
    kids.push({ k: r.k, path, game: t });
  }
  return { kids, safe: false };
}

/** Small seeded PRNG for the restarts (mulberry32). */
function noise(seed) {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * One best-first run. Returns { moves } on success, { nodes, exhausted } otherwise (exhausted: the whole
 * reachable space was explored without a win), or { nodes, timeout }.
 */
function searchOnce(ex, root, budget, rng, deadline, tr) {
  const keyOf = (g, k) => ex.canonKey(g, k);
  const seen = new Set([keyOf(root, -1)]);
  const heap = new Heap();
  let seq = 0;
  let nodes = 1;
  let pops = 0;
  heap.push({ g: root, parent: null, k: -1, path: '', f: catsLeft(root) * 4, seq: seq++, deferred: false, reps: 0 });
  while (heap.size) {
    if ((++pops & 15) === 0 && now() > deadline) return { nodes, timeout: true };
    const node = heap.pop();
    if (tr) {
      const key = node.deferred ? 'deferred' : 'expanded';
      tr[key] = (tr[key] || 0) + 1;
    }
    if (node.deferred) {
      // Repositioning moves of a node whose productive moves were tried first.
      const g = node.g;
      let kids = ex.unblockMoves(g);
      if (!kids.length && !g.isStuck()) kids = ex.anyRepositions(g);
      node.g = null;
      const reps = node.reps + 1;
      for (let i = kids.length - 1; i >= 0; i--) {
        const kid = kids[i];
        // Exact key: a slide is the whole point here, so it must not merge with its free area.
        const key = kid.game.stateKey();
        if (seen.has(key)) continue;
        seen.add(key);
        if (++nodes > budget) return { nodes };
        const f = catsLeft(kid.game) * 4 + reps * REPOSITION_COST;
        heap.push({ g: kid.game, parent: node.parent, k: kid.hole, path: kid.path, f, seq: seq++, deferred: false, reps });
      }
      continue;
    }
    const g = node.g;
    const res = expand(ex, g, node.k, rng);
    if (!res.safe) {
      // Repositioning is only looked at once the productive moves below have failed.
      const f = node.f + REPOSITION_COST - 1;
      heap.push({ g, parent: node, k: -1, path: '', f, seq: seq++, deferred: true, reps: node.reps });
    }
    node.g = null;
    const kids = res.kids;
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid.game.isWon()) return { nodes, moves: movesOf({ parent: node, k: kid.k, path: kid.path }) };
      const key = keyOf(kid.game, kid.k);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!ex.feasible(kid.game)) continue;
      if (++nodes > budget) return { nodes };
      const f = catsLeft(kid.game) * 4 + node.reps * REPOSITION_COST;
      heap.push({ g: kid.game, parent: node, k: kid.k, path: kid.path, f, seq: seq++, deferred: false, reps: node.reps });
    }
  }
  return { nodes, exhausted: true };
}

/**
 * Searches for a winning sequence of drags. Best-first runs restart with a doubled budget and a slightly
 * shuffled move preference (search trees here are heavy-tailed: a restart usually beats digging on).
 * @param {import('./rules.js').Game} game the current state (not modified)
 * @param {{ maxNodes?: number, timeMs?: number, firstRun?: number, trace?: object }} [opts]
 *   maxNodes: budget of distinct states over all runs (default 50000); timeMs: optional wall-clock budget;
 *   firstRun: budget of the first run (default 1500); trace: object that receives expansion counters (debug)
 * @returns {{ moves: { hole: number, path: string }[], nodes: number } | null}
 *   moves replayed one cell at a time with canStep/step win the level (a path ends exactly where its hole
 *   closes; consecutive moves of one hole are merged into one drag); null when no solution was found within
 *   the budget (or none exists)
 */
export function solve(game, opts = {}) {
  const maxNodes = Math.max(1, opts.maxNodes ?? 50000);
  const deadline = opts.timeMs ? now() + opts.timeMs : Infinity;
  const ex = explorer(game.L);
  const root = game.clone();
  if (root.isWon()) return { moves: [], nodes: 0 };
  if (!ex.feasible(root)) return null;
  let used = 0;
  let budget = Math.min(maxNodes, opts.firstRun ?? 1500);
  for (let run = 0; used < maxNodes; run++) {
    const b = Math.min(budget, maxNodes - used);
    const r = searchOnce(ex, root, b, run === 0 ? null : noise(run * 0x9e3779b1), deadline, opts.trace || null);
    used += r.nodes;
    if (r.moves) return { moves: r.moves, nodes: used };
    if (r.exhausted || r.timeout) return null;
    budget *= 2;
  }
  return null;
}

/**
 * The next drag of a winning line from the current state.
 * @returns {{ hole: number, path: string } | null}
 */
export function hint(game, opts = {}) {
  const r = solve(game, opts);
  return r && r.moves.length ? r.moves[0] : null;
}
