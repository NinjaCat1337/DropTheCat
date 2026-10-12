// Hint solver: finds a sequence of drags that wins the level from the current state of a Game. Pure (no DOM);
// importable by Node and the browser. Every move is checked and played with the Game API (canStep / step), so
// the rules exist only in rules.js. Layered holes are handled through game.holeColor(k) (the current layer).
//
// Search space — "macro-moves": from a state, each open hole slides through positions where it swallows
// nothing (a BFS over its positions; walls, other cats and other holes block exactly as canStep says) and
// stops on the first position that covers a cat of its colour. Every macro-move drops at least one cat. When
// no hole can reach a cat on its own (holes block each other on a packed board), an "unstall" BFS over the
// positions of all holes together finds the shortest sequence of slides after which some hole can eat.
//
// Pruning and ordering:
//  * coverage — a hole can only ever stand inside its connected component of the empty board (walls, void and
//    its axis lock never change), so the cells it can ever cover are known per level.
//  * safe moves — when no other open hole that still has the colour among its layers can ever cover the cats a
//    move swallows (always the case when every colour belongs to one hole), those cats are this hole's in every
//    solution. Swallowing them now never turns a winnable state into a lost one (cats only disappear, which only
//    opens cells, boxes, ice and crates; a finished layer only changes the colour the hole wants next; the hole
//    can retrace its path), so such a move is the node's only child. On levels with one hole per colour every
//    productive move is safe: the search is greedy, and complete together with the unstall BFS.
//  * allocation check — a state where the remaining cats of a colour cannot be shared out among the holes that
//    still take that colour (each taking exactly its need, within its coverage; bipartite b-matching) is dropped.
//  * visited set up to free slides — after a move, the moved hole's position is canonicalized to the lowest
//    position it can slide to without swallowing anything (equivalent states, since such slides reverse).
//  * best-first on the number of cats left (ties: most recent first); repositioning costs as much as 12 cats,
//    so it is tried only once the productive lines below failed; runs restart with a doubled budget and
//    slightly shuffled preferences (heavy-tailed searches).
import { DIRS, FLOOR, LOCK, MAX_COLORS } from './rules.js';

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
    // holesOf[c] = holes that have colour c in one of their layers; catsOf[c] = cat cells of colour c.
    this.holesOf = Array.from({ length: MAX_COLORS }, () => []);
    L.holes.forEach((hole, k) => {
      for (const layer of hole.layers || [{ c: hole.c }]) if (!this.holesOf[layer.c].includes(k)) this.holesOf[layer.c].push(k);
    });
    this.catsOf = Array.from({ length: MAX_COLORS }, () => []);
    for (const i of L.catCells) this.catsOf[L.cat0.color[i]].push(i);
    // True when every colour is taken by a single hole: then no move can ever lead into a dead end.
    this.unique = this.holesOf.every((list) => list.length <= 1);
  }

  /**
   * How many cats of colour c hole k still has to take (0 if it never will again): its current need when c is
   * its current layer, the layer's need when c is a later layer.
   */
  needFor(g, k, c) {
    if (g.need[k] <= 0) return 0;
    const layers = this.L.holes[k].layers;
    if (!layers) return this.L.holes[k].c === c ? g.need[k] : 0;
    const cur = g.layer[k];
    if (layers[cur].c === c) return g.need[k];
    for (let j = cur + 1; j < layers.length; j++) if (layers[j].c === c) return layers[j].need;
    return 0;
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
    const { axis } = hole;
    const c = g.holeColor(k);
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

  /** Cat cells of hole k's current colour that hole k would cover at position q. */
  catsUnder(g, k, q) {
    const c = g.holeColor(k);
    const out = [];
    for (const o of this.offs[k]) if (g.color[q + o] === c) out.push(q + o);
    return out;
  }

  /**
   * True when no other open hole that still takes hole k's current colour can ever cover any of the cats k
   * would swallow at q: those cats are k's in every solution, so swallowing them now is safe.
   */
  exclusive(g, k, q) {
    const c = g.holeColor(k);
    const rivals = this.holesOf[c];
    if (rivals.length <= 1) return true;
    for (const o of this.offs[k]) {
      const i = q + o;
      if (g.color[i] !== c) continue;
      for (const j of rivals) if (j !== k && this.cover[j][i] && this.needFor(g, j, c) > 0) return false;
    }
    return true;
  }

  /**
   * False when the remaining cats of some colour cannot be shared out among the holes that still take that
   * colour, each taking exactly its need, using only the cells it can ever cover. Sound: never rejects a
   * winnable state.
   */
  feasible(g) {
    const color = g.color;
    for (let c = 0; c < MAX_COLORS; c++) {
      const hs = this.holesOf[c];
      if (!hs.length) continue;
      const takers = [];
      const needs = [];
      for (const k of hs) {
        const v = this.needFor(g, k, c);
        if (v > 0) {
          takers.push(k);
          needs.push(v);
        }
      }
      const cats = [];
      for (const i of this.catsOf[c]) if (color[i] !== -1) cats.push(i);
      let total = 0;
      for (const v of needs) total += v;
      if (total !== cats.length) return false;
      if (!takers.length) continue;
      if (takers.length === 1) {
        const cov = this.cover[takers[0]];
        for (const i of cats) if (!cov[i]) return false;
        continue;
      }
      if (!this.bmatch(takers, needs, cats)) return false;
    }
    return true;
  }

  bmatch(takers, needs, cats) {
    const m = takers.length;
    const cover = this.cover;
    const load = new Int16Array(m);
    const owner = new Int8Array(cats.length).fill(-1);
    let visited = null;
    const tryCat = (ci) => {
      for (let a = 0; a < m; a++) {
        if (visited[a] || !cover[takers[a]][cats[ci]]) continue;
        visited[a] = 1;
        if (load[a] < needs[a]) {
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
   * A short sequence of slides (several holes, swallowing nothing) after which some hole can take a cat. Only
   * holes that matter move: those that could eat if no hole were in the way ("candidates"), plus
   * (transitively) the holes standing on cells they could use; any other hole never touches those cells.
   * Weighted A* over the positions of those holes together; the estimate is, for the best candidate, its
   * distance to a cat (ignoring holes) plus 2 per hole standing in its way. Returns [[hole, letter], ...]
   * ([] when a hole can already reach a cat on its own), or null when none was found within maxStates.
   */
  unstall(g, maxStates = 30000) {
    const L = this.L;
    const { w, n } = L;
    const zone = new Uint8Array(n);
    const H = [];
    const isIn = new Uint8Array(g.need.length);
    const scans = new Map();
    for (let k = 0; k < g.need.length; k++) {
      if (g.need[k] <= 0) continue;
      const s = this.scan(g, k, true);
      if (!s.targets.length) continue;
      isIn[k] = 1;
      H.push(k);
      scans.set(k, s);
      for (const list of [s.region, s.targets]) for (const p of list) for (const o of this.offs[k]) zone[p + o] = 1;
    }
    const nc = H.length; // candidates come first in H
    if (!nc) return null;
    for (let grew = true; grew; ) {
      grew = false;
      for (let k = 0; k < g.need.length; k++) {
        if (isIn[k] || g.need[k] <= 0) continue;
        const p = g.hy[k] * w + g.hx[k];
        if (!this.offs[k].some((o) => zone[p + o])) continue;
        isIn[k] = 1;
        H.push(k);
        const s = this.scan(g, k, true);
        for (const list of [s.region, s.targets]) for (const q of list) for (const o of this.offs[k]) zone[q + o] = 1;
        grew = true;
      }
    }
    // Focused tries first: one candidate, plus the holes near the way to its nearest cat (free roaming of
    // far-away holes is what makes the joint search big).
    const byDist = H.slice(0, nc).map((k) => ({ k, d: this.distTo(scans.get(k), scans.get(k).targets[0]) }));
    byDist.sort((a, b) => a.d - b.d || a.k - b.k);
    for (const { k } of byDist) {
      const s = scans.get(k);
      const near = new Uint8Array(n);
      const mark = (i) => {
        const x = i % w;
        const y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < L.h) near[ny * w + nx] = 1;
          }
        }
      };
      for (let p = s.targets[0]; p !== -1; p = p === s.start ? -1 : s.parent[p]) for (const o of this.offs[k]) mark(p + o);
      const movers = [k];
      for (const j of H) if (j !== k && this.offs[j].some((o) => near[g.hy[j] * w + g.hx[j] + o])) movers.push(j);
      const res = this.jointSearch(g, movers, 1, scans, 4000);
      if (res) return res;
    }
    return this.jointSearch(g, H, nc, scans, maxStates);
  }

  /**
   * Weighted A* over the positions of the holes in H together (the first nc are candidates: they can eat if
   * nothing is in the way; scans holds their hole-ignoring scans). Other holes stay put. Returns the slides
   * [[hole, letter], ...] after which some hole of H can take a cat, or null.
   */
  jointSearch(g, H, nc, scans, maxStates) {
    const L = this.L;
    const { w, h, n } = L;
    const isIn = new Uint8Array(g.need.length);
    for (const k of H) isIn[k] = 1;
    const mh = H.length;
    // Static per-cell data: cells every hole may slide over, and per hole the cats it could take right now.
    const free = new Uint8Array(n);
    for (let i = 0; i < n; i++) free[i] = g.color[i] === -1 && g.cellOpen(-1, i) ? 1 : 0;
    const food = [];
    const maxX = [];
    const maxY = [];
    const axes = [];
    for (const k of H) {
      const c = g.holeColor(k);
      const f = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (g.color[i] === c && g.cellOpen(c, i)) f[i] = 1;
      food.push(f);
      maxX.push(w - L.holes[k].bw);
      maxY.push(h - L.holes[k].bh);
      axes.push(L.holes[k].axis);
    }
    const dirOk = (a, d) => !((axes[a] === 'h' && DY[d] !== 0) || (axes[a] === 'v' && DX[d] !== 0));
    // Candidates: distance (in slides, ignoring holes) from each position to one where it can eat, and the
    // cells it sweeps on the way (its corridor).
    const dist = [];
    const corridor = [];
    for (let a = 0; a < nc; a++) {
      const offs = this.offs[H[a]];
      const fits = (q, wantFood) => {
        let eats = false;
        for (const o of offs) {
          const i = q + o;
          if (free[i]) continue;
          if (food[a][i]) {
            eats = true;
            continue;
          }
          return false;
        }
        return wantFood ? eats : !eats;
      };
      const dd = new Int16Array(n).fill(-1);
      const next = new Int16Array(n).fill(-1);
      const queue = [];
      for (const q of scans.get(H[a]).targets) {
        const qx = q % w;
        const qy = (q - qx) / w;
        for (let d = 0; d < 4; d++) {
          if (!dirOk(a, d)) continue;
          const px = qx - DX[d];
          const py = qy - DY[d];
          if (px < 0 || py < 0 || px > maxX[a] || py > maxY[a]) continue;
          const p = py * w + px;
          if (dd[p] !== -1 || !fits(p, false)) continue;
          dd[p] = 1;
          next[p] = q;
          queue.push(p);
        }
      }
      for (let qi = 0; qi < queue.length; qi++) {
        const p = queue[qi];
        const px = p % w;
        const py = (p - px) / w;
        for (let d = 0; d < 4; d++) {
          if (!dirOk(a, d)) continue;
          const nx = px + DX[d];
          const ny = py + DY[d];
          if (nx < 0 || ny < 0 || nx > maxX[a] || ny > maxY[a]) continue;
          const q = ny * w + nx;
          if (dd[q] !== -1 || !fits(q, false)) continue;
          dd[q] = dd[p] + 1;
          next[q] = p;
          queue.push(q);
        }
      }
      dist.push(dd);
      const memo = new Map();
      corridor.push((p) => {
        let cells = memo.get(p);
        if (!cells) {
          cells = [];
          for (let q = p, guard = 0; q !== -1 && guard < n; q = dd[q] > 0 ? next[q] : -1, guard++) for (const o of offs) cells.push(q + o);
          memo.set(p, cells);
        }
        return cells;
      });
    }
    const occ = new Int8Array(n);
    const fixed = new Int8Array(n).fill(-1);
    for (let k = 0; k < g.need.length; k++) {
      if (g.need[k] <= 0 || isIn[k]) continue;
      for (const o of this.offs[k]) fixed[g.hy[k] * w + g.hx[k] + o] = 100;
    }
    const fill = (cfg) => {
      occ.set(fixed);
      for (let a = 0; a < mh; a++) for (const o of this.offs[H[a]]) occ[cfg[a] + o] = a;
    };
    const estimate = (cfg) => {
      let best = Infinity;
      for (let a = 0; a < nc; a++) {
        const d0 = dist[a][cfg[a]];
        if (d0 < 0) continue;
        let blockers = 0;
        const seen = new Set();
        for (const i of corridor[a](cfg[a])) {
          const o = occ[i];
          if (o !== -1 && o !== a && !seen.has(o)) {
            seen.add(o);
            blockers++;
          }
        }
        best = Math.min(best, d0 + 2 * blockers);
      }
      return best === Infinity ? 99 : best;
    };
    const start = H.map((k) => g.hy[k] * w + g.hx[k]);
    const keyOf = (cfg) => String.fromCharCode(...cfg);
    const startKey = keyOf(start);
    const meta = new Map([[startKey, { prev: null, a: -1, d: -1, g: 0 }]]);
    const heap = [];
    const push = (node) => {
      heap.push(node);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].f < node.f || (heap[p].f === node.f && heap[p].t <= node.t)) break;
        heap[i] = heap[p];
        i = p;
      }
      heap[i] = node;
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let b = -1;
          if (l < heap.length) b = l;
          if (r < heap.length && (heap[r].f < heap[l].f || (heap[r].f === heap[l].f && heap[r].t < heap[l].t))) b = r;
          if (b < 0 || last.f < heap[b].f || (last.f === heap[b].f && last.t <= heap[b].t)) break;
          heap[i] = heap[b];
          i = b;
        }
        heap[i] = last;
      }
      return top;
    };
    const steps = (key) => {
      const out = [];
      for (let m0 = meta.get(key); m0 && m0.prev !== null; m0 = meta.get(m0.prev)) out.push([H[m0.a], DCH[m0.d]]);
      return out.reverse();
    };
    fill(start);
    let tick = 0;
    push({ f: estimate(start), t: tick++, cfg: start, key: startKey, g: 0 });
    while (heap.length) {
      const node = pop();
      const cfg = node.cfg;
      if (meta.get(node.key).g < node.g) continue;
      fill(cfg);
      for (let a = 0; a < mh; a++) {
        const offs = this.offs[H[a]];
        const fd = food[a];
        const p = cfg[a];
        const px = p % w;
        const py = (p - px) / w;
        for (let d = 0; d < 4; d++) {
          if (!dirOk(a, d)) continue;
          const nx = px + DX[d];
          const ny = py + DY[d];
          if (nx < 0 || ny < 0 || nx > maxX[a] || ny > maxY[a]) continue;
          const q = ny * w + nx;
          let ok = true;
          let eats = false;
          for (let t = 0; t < offs.length; t++) {
            const i = q + offs[t];
            const o = occ[i];
            if (o !== -1 && o !== a) {
              ok = false;
              break;
            }
            if (free[i]) continue;
            if (fd[i]) {
              eats = true;
              continue;
            }
            ok = false;
            break;
          }
          if (!ok) continue;
          if (eats) return steps(node.key);
          const nextCfg = cfg.slice();
          nextCfg[a] = q;
          const key = keyOf(nextCfg);
          const g2 = node.g + 1;
          const old = meta.get(key);
          if (old && old.g <= g2) continue;
          if (!old && meta.size >= maxStates) return null;
          meta.set(key, { prev: node.key, a, d, g: g2 });
          // Estimate with this hole moved (occ is restored right after).
          for (const o of offs) occ[p + o] = -1;
          for (const o of offs) occ[q + o] = a;
          const hh = estimate(nextCfg);
          for (const o of offs) occ[q + o] = fixed[q + o];
          for (const o of offs) occ[p + o] = a;
          push({ f: g2 + 2 * hh, t: tick++, cfg: nextCfg, key, g: g2 });
        }
      }
    }
    return null;
  }

  /**
   * Repositioning moves that unblock another hole: [{ hole, path, game }] where `hole` slides (swallowing
   * nothing) to a position from which some other hole can reach a target it could not reach before.
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

/** Merges consecutive moves of the same hole ([[hole, letter or path], ...]) into drags [[hole, path], ...]. */
export function mergeMoves(list) {
  const out = [];
  for (const [k, p] of list) {
    if (!p) continue;
    const last = out[out.length - 1];
    if (last && last[0] === k) last[1] += p;
    else out.push([k, p]);
  }
  return out;
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
  return g.catsLeft();
}

/** Moves from the root to `node` (each node carries [[hole, path], ...]), merged into drags. */
function movesOf(node) {
  const chain = [];
  for (let p = node; p && p.seq0; p = p.parent) chain.push(p);
  chain.reverse();
  const flat = [];
  for (const p of chain) for (const mv of p.seq0) flat.push(mv);
  return mergeMoves(flat).map(([hole, path]) => ({ hole, path }));
}

/**
 * Children of a node: [{ k, path, game }] — a single safe move when one exists, otherwise every productive
 * move, preferred first. rng (optional) shuffles the preference a little (used by restarts).
 */
function expand(ex, g, lastHole, rng) {
  const m = g.need.length;
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
    const c = g.holeColor(k);
    for (const q of s.targets) {
      const d = ex.distTo(s, q);
      const cats = ex.catsUnder(g, k, q);
      // "Steal" = how much farther this hole is from these cats than its nearest rival of the same colour.
      let rival = Infinity;
      for (const j of ex.holesOf[c]) {
        if (j === k || g.need[j] <= 0 || g.holeColor(j) !== c) continue;
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

/** Repositioning children of a node: the shortest unstall sequence first, then single unblocking slides. */
function repositions(ex, g) {
  const out = [];
  const seq = ex.unstall(g);
  if (seq && seq.length) {
    const t = g.clone();
    let ok = true;
    for (const [k, ch] of seq) if (!applyPath(t, k, ch)) ok = false;
    if (ok) {
      const moves = mergeMoves(seq);
      out.push({ k: moves[moves.length - 1][0], seq: moves, game: t });
    }
  }
  if (!ex.unique) {
    for (const mv of ex.unblockMoves(g)) out.push({ k: mv.hole, seq: [[mv.hole, mv.path]], game: mv.game });
  }
  return out;
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
  // Repositioned states are kept apart, by exact key: a slide may lead to exactly the state that stands for
  // its parent's free-slide class, and must still be explored (it is the point of the slide).
  const seenExact = new Set([root.stateKey()]);
  const heap = new Heap();
  let seq = 0;
  let nodes = 1;
  let pops = 0;
  heap.push({ g: root, parent: null, k: -1, seq0: null, f: catsLeft(root) * 4, seq: seq++, deferred: false, reps: 0 });
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
      const kids = repositions(ex, g);
      node.g = null;
      const reps = node.reps + 1;
      for (let i = kids.length - 1; i >= 0; i--) {
        const kid = kids[i];
        if (kid.game.isWon()) return { nodes, moves: movesOf({ parent: node.parent, seq0: kid.seq }) };
        const key = kid.game.stateKey();
        if (seenExact.has(key)) continue;
        seenExact.add(key);
        if (++nodes > budget) return { nodes };
        const f = catsLeft(kid.game) * 4 + reps * REPOSITION_COST;
        heap.push({ g: kid.game, parent: node.parent, k: kid.k, seq0: kid.seq, f, seq: seq++, deferred: false, reps });
      }
      continue;
    }
    const g = node.g;
    const res = expand(ex, g, node.k, rng);
    if (!res.safe) {
      // Repositioning is only looked at once the productive moves below have failed.
      const f = node.f + REPOSITION_COST - 1;
      heap.push({ g, parent: node, k: -1, seq0: null, f, seq: seq++, deferred: true, reps: node.reps });
    }
    node.g = null;
    const kids = res.kids;
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      const seq0 = [[kid.k, kid.path]];
      if (kid.game.isWon()) return { nodes, moves: movesOf({ parent: node, seq0 }) };
      const key = keyOf(kid.game, kid.k);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!ex.feasible(kid.game)) continue;
      if (++nodes > budget) return { nodes };
      const f = catsLeft(kid.game) * 4 + node.reps * REPOSITION_COST;
      heap.push({ g: kid.game, parent: node, k: kid.k, seq0, f, seq: seq++, deferred: false, reps: node.reps });
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
