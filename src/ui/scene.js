// Board rendering and visual state: hole positions (eased toward the game), falling cats, closing holes,
// box / ice / crate animations, hints and particles. Reads the Game; never changes it. Times are in ms.
import { ease, createParticles } from './fx.js';
import { PALETTE } from './art.js';
import { LOCK } from '../core/rules.js';

const FALL_MS = 430;
const FLY_MS = 480;
const CLOSE_MS = 600;
const PULSE_MS = 280;
const HOP_MS = 600;
const REVEAL_MS = 460;
const CRACK_MS = 340;
const MELT_MS = 480;
const UNLOCK_MS = 600;
const APPEAR_MS = 420;

const TAU = Math.PI * 2;

export function createScene(canvas, art) {
  const ctx = canvas.getContext('2d');
  const particles = createParticles();
  let game = null;
  let L = null;
  let board = null;
  let views = [];
  let drag = null;
  let falling = [];
  let closing = [];
  let pulses = [];
  let fx = new Map();
  let unlockT0 = -1;
  let hint = null;
  let highlight = false;
  let lastNow = 0;
  let shown = null;

  const fxOf = (i) => {
    let e = fx.get(i);
    if (!e) {
      e = {};
      fx.set(i, e);
    }
    return e;
  };

  // Centre of a hole shape in cells (relative to its origin), snapped into one of its cells for badges.
  const centroid = (cells) => {
    let sx = 0;
    let sy = 0;
    for (const [dx, dy] of cells) {
      sx += dx + 0.5;
      sy += dy + 0.5;
    }
    return { x: sx / cells.length, y: sy / cells.length };
  };

  function holeOrigin(k) {
    if (drag && drag.k === k) return { x: drag.x, y: drag.y };
    return views[k];
  }

  function reset(g) {
    game = g;
    board = null;
    views = [];
    for (let k = 0; k < g.holeCount; k++) views.push({ x: g.hx[k], y: g.hy[k], lift: 0 });
    drag = null;
    falling = [];
    closing = [];
    pulses = new Array(g.holeCount).fill(-1e9);
    fx = new Map();
    unlockT0 = -1;
    hint = null;
    highlight = false;
    shown = g.color.slice();
    particles.clear();
  }

  function px(cx) {
    return L.x + cx * L.cell;
  }

  function py(cy) {
    return L.y + cy * L.cell;
  }

  function handle(events, now) {
    for (const e of events) {
      const i = e.x !== undefined ? e.y * game.w + e.x : -1;
      if (e.type === 'drop') {
        const view = holeOrigin(e.hole);
        falling.push({ x: e.x, y: e.y, c: e.c, k: e.hole, t0: now, fly: !!e.fly, seed: i,
          hx: view.x, hy: view.y, key: e.key });
        pulses[e.hole] = now;
        if (shown) shown[i] = -1;
        if (!e.fly) particles.puff(px(e.x + 0.5), py(e.y + 0.5), PALETTE[e.c].light, now, L.cell / 56);
      } else if (e.type === 'reveal') {
        fxOf(i).reveal = now;
      } else if (e.type === 'ice') {
        fxOf(i).crack = now;
      } else if (e.type === 'melt') {
        fxOf(i).melt = now;
      } else if (e.type === 'unlock') {
        unlockT0 = now;
      } else if (e.type === 'complete') {
        const view = holeOrigin(e.hole);
        const cells = game.holeCells(e.hole);
        closing.push({ k: e.hole, x0: view.x, y0: view.y, x: view.x, y: view.y, tx: e.x, ty: e.y, t0: now });
        const c = centroid(cells);
        const col = PALETTE[game.holeColor(e.hole)];
        particles.burst(px(view.x + c.x), py(view.y + c.y), [col.main, col.light, '#FFFFFF', '#FFE45C'], now + 120, L.cell / 56);
        if (drag && drag.k === e.hole) drag = null;
      }
    }
  }

  // Outline of a hole's outer edges (no seams between its own cells), drawn just outside the rim.
  function outline(cells, ox, oy, color, alpha) {
    const has = new Set(cells.map(([x, y]) => x + ',' + y));
    const e = Math.max(1.5, L.cell * 0.05);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2.5, L.cell * 0.085);
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = L.cell * 0.25;
    ctx.beginPath();
    for (const [dx, dy] of cells) {
      const x0 = px(ox + dx) - e;
      const y0 = py(oy + dy) - e;
      const x1 = px(ox + dx + 1) + e;
      const y1 = py(oy + dy + 1) + e;
      if (!has.has(dx + ',' + (dy - 1))) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y0);
      }
      if (!has.has(dx + ',' + (dy + 1))) {
        ctx.moveTo(x0, y1);
        ctx.lineTo(x1, y1);
      }
      if (!has.has(dx - 1 + ',' + dy)) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0, y1);
      }
      if (!has.has(dx + 1 + ',' + dy)) {
        ctx.moveTo(x1, y0);
        ctx.lineTo(x1, y1);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawHint(now) {
    if (!hint || game.need[hint.k] <= 0) return;
    const cells = game.holeCells(hint.k);
    const c = centroid(cells);
    const o = holeOrigin(hint.k);
    const pts = [[o.x + c.x, o.y + c.y], ...hint.path.map(([x, y]) => [x + c.x, y + c.y])];
    const a = 0.65 + 0.35 * Math.sin(now / 160);
    ctx.save();
    // Pulsing outline around the hole to move (its number stays readable).
    outline(cells, o.x, o.y, '#FFFFFF', 0.55 + 0.4 * Math.sin(now / 140));
    // Marching dots along the path, then an arrow head.
    ctx.globalAlpha = a;
    const r = Math.max(2.5, L.cell * 0.08);
    const step = L.cell * 0.32;
    const shift = ((now / 22) % step + step) % step;
    for (let s = 0; s + 1 < pts.length; s++) {
      const [x0, y0] = pts[s];
      const [x1, y1] = pts[s + 1];
      const len = Math.hypot(x1 - x0, y1 - y0) * L.cell;
      for (let d = s === 0 ? shift + L.cell * 0.42 : shift % step; d < len; d += step) {
        const t = d / len;
        ctx.beginPath();
        ctx.arc(px(x0 + (x1 - x0) * t), py(y0 + (y1 - y0) * t), r, 0, TAU);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(60,30,90,.45)';
        ctx.stroke();
      }
    }
    if (pts.length > 1) {
      const [x0, y0] = pts[pts.length - 2];
      const [x1, y1] = pts[pts.length - 1];
      const ang = Math.atan2(y1 - y0, x1 - x0);
      ctx.translate(px(x1), py(y1));
      ctx.rotate(ang);
      ctx.beginPath();
      const s = L.cell * 0.22;
      ctx.moveTo(s, 0);
      ctx.lineTo(-s * 0.8, -s * 0.8);
      ctx.lineTo(-s * 0.8, s * 0.8);
      ctx.closePath();
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(60,30,90,.5)';
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFalling(now) {
    const keep = [];
    for (const f of falling) {
      const age = now - f.t0;
      const total = (f.fly ? FLY_MS : 0) + FALL_MS;
      if (age >= total) continue;
      keep.push(f);
      let origin = null;
      if (game.need[f.k] > 0) origin = holeOrigin(f.k);
      else {
        const ghost = closing.find((g) => g.k === f.k);
        origin = ghost ? ghost : { x: f.hx, y: f.hy };
      }
      const cells = game.holeCells(f.k);
      const cen = centroid(cells);
      const seedDir = f.seed % 2 ? 1 : -1;
      if (f.fly && age < FLY_MS) {
        // Treat: the cat leaps to the hole along an arc, then drops in.
        const p = ease.inOutSine(age / FLY_MS);
        const x0 = f.x + 0.5;
        const y0 = f.y + 0.5;
        const x1 = origin.x + cen.x;
        const y1 = origin.y + cen.y;
        const lift = 1.4 + 0.1 * Math.hypot(x1 - x0, y1 - y0);
        const cx = x0 + (x1 - x0) * p;
        const cy = y0 + (y1 - y0) * p - Math.sin(p * Math.PI) * lift;
        art.drawCat(ctx, px(cx), py(cy), f.c, { t: now / 1000, seed: f.seed, mood: 'happy', scale: 1 - 0.15 * p, rot: seedDir * p * 0.8, key: f.key });
        continue;
      }
      const p = ease.clamp01((age - (f.fly ? FLY_MS : 0)) / FALL_MS);
      const at = f.fly ? { x: origin.x + cen.x, y: origin.y + cen.y } : { x: f.x + 0.5, y: f.y + 0.5 };
      ctx.save();
      art.clipHole(ctx, cells, px(origin.x), py(origin.y));
      art.drawCat(ctx, px(at.x), py(at.y + 0.12 * p), f.c, {
        t: now / 1000, seed: f.seed, mood: 'surprised', scale: 1 - 0.8 * ease.inQuad(p), tint: p,
        rot: seedDir * 0.7 * p, key: f.key, alpha: 1 - 0.3 * p,
      });
      ctx.restore();
    }
    falling = keep;
  }

  // Numbers go on top of everything on the board, so falling or standing cats never hide them.
  function drawBadges(now) {
    for (let k = 0; k < game.holeCount; k++) {
      if (game.need[k] <= 0) continue;
      const v = views[k];
      const pa = (now - pulses[k]) / PULSE_MS;
      art.drawHoleBadge(ctx, game.holeCells(k), px(v.x), py(v.y), game.holeColor(k), game.need[k], { pulse: pa < 1 ? 1 - pa : 0 });
    }
  }

  function prewarm() {
    if (!game || !L) return;
    const holes = [];
    for (let k = 0; k < game.holeCount; k++) {
      holes.push({ cells: game.holeCells(k), c: game.holeColor(k), axis: game.holeAxis(k), need: game.L.hole0.need[k] });
    }
    art.prewarm({ colors: game.L.colors, holes });
  }

  function drawCats(now) {
    const t = now / 1000;
    const { w } = game;
    const happyColor = drag ? game.holeColor(drag.k) : -1;
    for (const i of game.L.catCells) {
      const c = game.color[i];
      const e = fx.get(i);
      const x = i % w;
      const y = (i - x) / w;
      const cx = px(x + 0.5);
      const cy = py(y + 0.5);
      if (c === -1) {
        if (e && e.melt !== undefined && now - e.melt < MELT_MS) fx.delete(i);
        continue;
      }
      let scale = 1;
      if (e && e.appear !== undefined) {
        const p = (now - e.appear) / APPEAR_MS;
        if (p < 0) continue;
        if (p < 1) scale = Math.max(0.01, ease.outBack(p));
        else delete e.appear;
      }
      if (game.flags[i] & 1) {
        art.drawBox(ctx, cx, cy, { t, seed: i, open: 0 });
        continue;
      }
      let hop = 0;
      if (e && e.reveal !== undefined) {
        const p = (now - e.reveal) / REVEAL_MS;
        if (p < 0.45) {
          art.drawBox(ctx, cx, cy, { t, seed: i, open: p / 0.45 });
          continue;
        }
        if (p < 1) {
          hop = (p - 0.45) / 0.55;
          scale *= ease.outBack(Math.min(1, (p - 0.45) / 0.3));
        } else delete e.reveal;
      }
      if (e && e.hop !== undefined) {
        const p = (now - e.hop) / HOP_MS;
        if (p < 1) hop = p;
        else delete e.hop;
      }
      const frozen = game.ice[i] > 0;
      const mood = !frozen && c === happyColor ? 'happy' : 'idle';
      art.drawCat(ctx, cx, cy, c, { t, seed: i, mood, hop, scale, key: (game.flags[i] & 2) !== 0 });
      if (frozen) {
        let crack = 0;
        if (e && e.crack !== undefined) {
          const p = (now - e.crack) / CRACK_MS;
          if (p < 1) crack = 1 - p;
          else delete e.crack;
        }
        art.drawIce(ctx, cx, cy, game.ice[i], { crack, t });
      } else if (e && e.melt !== undefined) {
        const p = (now - e.melt) / MELT_MS;
        if (p < 1) art.drawIce(ctx, cx, cy, 0, { shatter: p, t });
        else delete e.melt;
      }
    }
  }

  function drawCrates(now) {
    if (!game.L.hasLocks) return;
    let open = 0;
    if (!game.locked) {
      if (unlockT0 < 0) return;
      open = (now - unlockT0) / UNLOCK_MS;
      if (open >= 1) return;
    }
    const { w, n, ground } = game.L;
    for (let i = 0; i < n; i++) {
      if (ground[i] !== LOCK) continue;
      const x = i % w;
      const y = (i - x) / w;
      art.drawCrate(ctx, px(x), py(y), { open: Math.max(0, open), t: now / 1000 });
    }
  }

  function drawHoles(now, dt) {
    const t = now / 1000;
    const k1 = 1 - Math.exp(-dt / 45);
    const order = [];
    for (let k = 0; k < game.holeCount; k++) if (game.need[k] > 0) order.push(k);
    if (drag) order.sort((a, b) => (a === drag.k) - (b === drag.k));
    for (const k of order) {
      const v = views[k];
      const dragging = drag && drag.k === k;
      if (dragging) {
        v.x = drag.x;
        v.y = drag.y;
      } else {
        v.x += (game.hx[k] - v.x) * k1;
        v.y += (game.hy[k] - v.y) * k1;
        if (Math.abs(game.hx[k] - v.x) < 0.002) v.x = game.hx[k];
        if (Math.abs(game.hy[k] - v.y) < 0.002) v.y = game.hy[k];
      }
      v.lift += ((dragging ? 1 : 0) - v.lift) * (1 - Math.exp(-dt / 60));
      const pa = (now - pulses[k]) / PULSE_MS;
      art.drawHole(ctx, game.holeCells(k), px(v.x), py(v.y), game.holeColor(k), {
        need: game.need[k], lifted: v.lift, axis: game.holeAxis(k), closing: 0, pulse: pa < 1 ? 1 - pa : 0, t, badge: false,
      });
      if (highlight) outline(game.holeCells(k), v.x, v.y, '#FFE45C', 0.6 + 0.4 * Math.sin(now / 150));
    }
    const keep = [];
    for (const g of closing) {
      const p = (now - g.t0) / CLOSE_MS;
      if (p >= 1) continue;
      keep.push(g);
      const s = ease.outCubic(Math.min(1, p * 2.5));
      const x = g.x0 + (g.tx - g.x0) * s;
      const y = g.y0 + (g.ty - g.y0) * s;
      g.x = x;
      g.y = y;
      art.drawHole(ctx, game.holeCells(g.k), px(x), py(y), game.holeColor(g.k), {
        need: 0, lifted: 0, axis: game.holeAxis(g.k), closing: p, pulse: 0, t,
      });
    }
    closing = keep;
  }

  return {
    particles,
    /** Starts showing a new game (level start / restart). */
    setGame(g) {
      reset(g);
      prewarm();
    },
    get game() {
      return game;
    },
    get layout() {
      return L;
    },
    /** layout: { width, height, dpr, cell, x, y, w, h } (cell area rect in CSS px). */
    resize(layout) {
      L = layout;
      const bw = Math.max(1, Math.round(layout.width * layout.dpr));
      const bh = Math.max(1, Math.round(layout.height * layout.dpr));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      art.setMetrics({ cell: layout.cell, dpr: layout.dpr });
      board = null;
      prewarm();
    },
    /** Game events from Game.step / treat (see rules.js). */
    handle,
    /** The hole being dragged and its visual position (cells), or null. */
    setDrag(d) {
      drag = d;
    },
    setHint(h) {
      hint = h;
    },
    get hint() {
      return hint;
    },
    /** Glow every open hole (treat booster: "tap a hole"). */
    setHighlight(on) {
      highlight = !!on;
    },
    /** A cat hops (tapped). */
    hop(x, y, now) {
      fxOf(y * game.w + x).hop = now;
    },
    /** Level intro: every cat pops in, in a diagonal wave. */
    intro(now) {
      const { w } = game;
      for (const i of game.L.catCells) {
        if (game.color[i] === -1) continue;
        const x = i % w;
        const y = (i - x) / w;
        fxOf(i).appear = now + 80 + (x + y) * 34;
      }
    },
    /**
     * After undo / restart: holes jump or glide to the game positions, cats that came back pop in.
     * @param {number} now
     * @param {{ stagger?: boolean }} [opts] stagger: cats pop in one after another (restart)
     */
    sync(now, opts = {}) {
      falling = [];
      closing = [];
      hint = null;
      drag = null;
      unlockT0 = -1;
      const { w } = game;
      let order = 0;
      for (const i of game.L.catCells) {
        const back = game.color[i] !== -1 && shown && shown[i] === -1;
        const e = fx.get(i);
        if (e) {
          delete e.reveal;
          delete e.melt;
          delete e.crack;
        }
        if (back) {
          const x = i % w;
          const y = (i - x) / w;
          fxOf(i).appear = now + (opts.stagger ? (x + y) * 28 + (order++ % 3) * 10 : 0);
        }
      }
      shown = game.color.slice();
      for (let k = 0; k < game.holeCount; k++) {
        if (opts.instant || !views[k]) views[k] = { x: game.hx[k], y: game.hy[k], lift: 0 };
      }
    },
    /** Cell coordinates (fractional) of a point in CSS px. */
    toCell(x, y) {
      return { x: (x - L.x) / L.cell, y: (y - L.y) / L.cell };
    },
    /** Hole under a point (cells), with a little forgiveness around its cells; -1 if none. */
    holeAt(cx, cy, slack = 0.35) {
      if (!game) return -1;
      let best = -1;
      let bestD = Infinity;
      // Both where the hole is drawn and where it really is (they differ while it glides after undo).
      for (let k = 0; k < game.holeCount; k++) {
        if (game.need[k] <= 0) continue;
        for (const o of [views[k], { x: game.hx[k], y: game.hy[k] }]) {
          for (const [dx, dy] of game.holeCells(k)) {
            const ddx = Math.max(o.x + dx - cx, 0, cx - (o.x + dx + 1));
            const ddy = Math.max(o.y + dy - cy, 0, cy - (o.y + dy + 1));
            const d = Math.hypot(ddx, ddy);
            if (d <= slack && d < bestD) {
              bestD = d;
              best = k;
            }
          }
        }
      }
      return best;
    },
    /** True while something is still animating (falling cats, closing holes, particles). */
    busy() {
      return falling.length > 0 || closing.length > 0 || particles.count > 0;
    },
    frame(now) {
      const dt = lastNow ? Math.min(64, Math.max(0, now - lastNow)) : 16;
      lastNow = now;
      if (!L) return;
      ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
      ctx.clearRect(0, 0, L.width, L.height);
      if (!game) return;
      if (!board) board = art.renderBoard({ w: game.w, h: game.h, ground: game.L.ground });
      const m = art.boardMargin;
      ctx.drawImage(board, L.x - m, L.y - m, game.w * L.cell + 2 * m, game.h * L.cell + 2 * m);
      drawCrates(now);
      drawHoles(now, dt);
      drawFalling(now);
      drawCats(now);
      drawBadges(now);
      drawHint(now);
      particles.draw(ctx, now, dt);
    },
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
