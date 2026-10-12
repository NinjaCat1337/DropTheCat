// Meow Drop: procedural game art. Canvas 2D only (no image files, no libraries), pure drawing (no game
// logic), no DOM access at import time. Everything is painted once into per-size sprite caches (canvases at
// cell × dpr resolution) and composited with drawImage + transforms every frame.
//
// ──────────────────────────────────────────── USAGE ────────────────────────────────────────────
//   import { createArt, PALETTE } from './art.js';
//   const art = createArt();
//   art.setMetrics({ cell, dpr });          // on resize: cell = CSS px per board cell, dpr = devicePixelRatio
//   const board = art.renderBoard(level);   // once per level and after every setMetrics()
//   // every frame, with ctx.setTransform(dpr, 0, 0, dpr, 0, 0) and the board's cell (0,0) at (bx, by):
//   const m = art.boardMargin;
//   ctx.drawImage(board, bx - m, by - m, level.w * cell + 2 * m, level.h * cell + 2 * m);
//
// Conventions
//   • All coordinates are CSS px; the caller's transform is restored after every call.
//   • Draw order (each layer over the previous one): CSS background → board canvas → crates → holes
//     (pit + rim + badge) → falling cats, each one inside ctx.save(); art.clipHole(...); art.drawCat(...);
//     ctx.restore() → standing cats in row order, top row first (cats overlap the row above a little; a box
//     or ice block is drawn right after its cat) → particles → (optional) badges drawn last, see drawHole.
//   • Integer cell sizes keep tile edges crisp (fractional ones work, just slightly softer).
//   • pulse (holes) and crack (ice) are intensities: 1 at the event, decaying to 0. hop / open / closing /
//     shatter are progress values 0 → 1.
//   • The board canvas never changes during a level: it can also live in its own <canvas> under the
//     animated one, so it is composited instead of redrawn every frame.
//
// ──────────────────────────────────────────── API ──────────────────────────────────────────────
// PALETTE[c] (c = colour id 0..7: red, orange, yellow, green, cyan, blue, purple, pink)
//   { name, main, light, dark, outline, deep }: hex strings. main = fur / rim, light = muzzle / highlights,
//   dark = shading, outline = line colour, deep = pit interior.
//
// createArt() → art
//   art.setMetrics({ cell, dpr })  Sets the cell size (CSS px) and pixel ratio and drops every cached sprite
//       (no-op when both are unchanged); sprites are painted lazily on first use (~1 ms each; see prewarm).
//   art.cell, art.dpr              Current metrics.
//   art.boardMargin                CSS px the board canvas extends beyond the cell area on every side
//                                  (frame + side face + drop shadow). Integer.
//   art.frameWidth                 CSS px of visible frame beyond the cells (left / top / right).
//   art.frameBottom                CSS px of visible frame below the last row (frame + its side face).
//   art.ready                      Promise, resolves once the number font is loaded (text sprites refresh
//                                  by themselves; nothing to do).
//   art.prewarm({ colors?, holes? })   Paints sprites now instead of on first use, e.g. during a level
//       transition: colors = colour ids (default all 8), holes = [{ cells, c, axis, need }].
//   art.setMarks(on), art.marks    Colour-blind mode (off by default): a per-colour symbol (♥ ▲ ★ ✚ drop ◆
//       moon ●) on every cat's belly and as a faint emblem in every cell of the matching pits.
//   art.clear()                    Drops every cached sprite (they are painted again on demand).
//   art.cachePixels                Device px held by the sprite caches (diagnostics; capped at ~20 M).
//
//   art.renderBoard(level, into?) → canvas   Static board image: frame, floor tiles, walls (not crates,
//       holes or cats). level = { w, h, ground: Uint8Array(w*h) } with 0 void, 1 floor, 2 wall,
//       3 locked-crate cell (floor is drawn under it). The frame follows the outline of the non-void cells
//       (inner corners included) and also fills void gaps only one cell wide. Adjacent walls merge into one
//       block. The canvas has extra props cssWidth / cssHeight (= w*cell + 2*boardMargin,
//       h*cell + 2*boardMargin) and margin. Pass the previous canvas as `into` to reuse its memory.
//
//   art.drawCrate(ctx, x, y, o)    Locked crate on the cell whose top-left is (x, y). o: { open = 0 (0..1:
//       padlock shakes, pops open and flies off; crate shrinks and fades; nothing drawn at 1), t = seconds }.
//
//   art.drawHole(ctx, cells, x, y, colour, o)   Hole = pit with a rim, cells merged into one outline.
//       cells = normalized [[dx,dy],...] (min 0; the same array object every frame is fastest);
//       x, y = top-left CSS px of the shape origin cell (0,0) (fractional while sliding is fine).
//       o: { need (badge number; no badge when ≤ 0),
//            lifted = 0 (0..1 while dragged: coloured glow, brighter rim, 3.5% bigger),
//            axis = null | 'h' | 'v' (chevrons at both ends of the pit, on the rim for 1-cell runs),
//            closing = 0 (0..1: iris lid closes with a paw stamp, sparkles, then pops and shrinks away;
//                         nothing drawn at 1; the badge fades out in the first 12%),
//            pulse = 0 (1 right when a cat drops in, decaying to 0: jelly wobble + flash + badge pop),
//            t = seconds, badge = true (false skips the badge: draw it later with drawHoleBadge, e.g. after
//            the falling cats so they do not cover the number) }.
//   art.clipHole(ctx, cells, x, y, up = 0.65)   Intersects the clip with the pit interior plus the area
//       straight above it (up = cells), so a falling cat sinks behind the near (lower) rim while its head
//       may still stick out above the pit. Leaves the transform unchanged; wrap in ctx.save()/restore().
//   art.drawHoleBadge(ctx, cells, x, y, colour, need, o?)   Only the number badge. o: { pulse, scale }.
//   art.holeCenter(cells) → [cx, cy]   Badge / visual centre in cells relative to the origin (centre of mass,
//       snapped to the nearest cell centre when the badge would not fit there).
//
//   art.drawCat(ctx, cx, cy, colour, o)   cx, cy = cell centre. o: {
//       t = seconds (drives blink every 2–6 s, ear twitch, tail sway, breathing), seed = int (look + timing:
//       fur pattern of 6, eye size, ear tilt, tail side and tip),
//       mood = 'idle' | 'happy' (^ ^ eyes, open smile, wagging tail) | 'surprised' (wide eyes, O mouth),
//       blink = false (force closed eyes), hop = 0 (0..1 jump with squash & stretch; an idle cat looks happy
//       while hopping), scale = 1, alpha = 1, rot = 0 (radians, about the cell centre),
//       tint = 0 (0..1 darkens toward the colour's deep pit shade; the floor shadow fades with it),
//       key = false (navy collar with a golden key charm), size = cell (draw as if the cell were this big),
//       shadow = true (soft floor shadow) }.
//   art.drawFallingCat(ctx, cells, hx, hy, cx, cy, colour, p, o?)   Convenience: clip + surprised hop, sink,
//       shrink, tint and spin for progress p 0..1 (o: { t, seed, key }). drawCat inside clipHole works too.
//   art.drawBox(ctx, cx, cy, o)    Cardboard box hiding a cat (neutral ears peek out, eyes glint, wiggles
//       now and then). o: { t, seed, open = 0 (0..1: squash, flaps burst open, box fades; gone at 1, so draw
//       the revealed cat with hop from there) }.
//   art.drawIce(ctx, cx, cy, left, o)   Ice block drawn OVER the cat. left = remaining count (number shown
//       when > 0; persistent cracks at 2 and 1). o: { crack = 0 (hit intensity: shake, crack flash, number
//       pop), shatter = 0 (0..1: flash, shards burst out and fade), t }.
//   art.drawKey(ctx, cx, cy, o?)   The key charm alone, e.g. flying to a crate (o: { size = cell, rot, alpha }).
//   art.drawSparkle(ctx, x, y, size, o?)   White 4-point star with a soft glow (size = CSS px; o: { rot, alpha }).
//
// Performance (tools/art-preview.mjs): a cat is 6 drawImage calls (shadow, tail, 2 ears, body+head, face),
// +2 with a key; a hole is 1 plus its badge (+1–3 while lifted / pulsing / closing). Nothing is stroked per
// frame except the closing iris. 8×10 board with 70 cats + 10 holes: ~0.5 ms JS and ~2 ms to rasterize per
// frame in desktop headless Chrome.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const EMPTY = Object.freeze({});

/** Colour ids 0..7. Shades: light (muzzle, gloss), dark (shading), outline (lines), deep (pit interior). */
export const PALETTE = Object.freeze([
  Object.freeze({ name: 'red', main: '#FF4D5E', light: '#FFA3AC', dark: '#DE2C47', outline: '#9D1534', deep: '#4A0A1E' }),
  Object.freeze({ name: 'orange', main: '#FF9A2E', light: '#FFCB8A', dark: '#E8701A', outline: '#A3460C', deep: '#561A06' }),
  Object.freeze({ name: 'yellow', main: '#FFD23F', light: '#FFEC9E', dark: '#F2AA1E', outline: '#A86A0C', deep: '#4D3A05' }),
  Object.freeze({ name: 'green', main: '#46D16B', light: '#A6EEB6', dark: '#22AA4E', outline: '#127238', deep: '#09381C' }),
  Object.freeze({ name: 'cyan', main: '#2EC4E6', light: '#98E6F7', dark: '#1499C4', outline: '#0A658B', deep: '#053249' }),
  Object.freeze({ name: 'blue', main: '#3D7BFF', light: '#A0C0FF', dark: '#2754DA', outline: '#17329A', deep: '#0B174F' }),
  Object.freeze({ name: 'purple', main: '#A35CFF', light: '#D4B0FF', dark: '#7E3AE0', outline: '#521FA1', deep: '#280C54' }),
  Object.freeze({ name: 'pink', main: '#FF6FC8', light: '#FFB6E4', dark: '#EA449F', outline: '#A41D6E', deep: '#4C0A34' }),
]);

// ───────── shared constants (cell units unless noted) ─────────
const INK = '#33203F'; // face lines
const BLUSH = 'rgba(255, 102, 140, 0.42)';
const NOSE = '#FF86A6';
const NOSE_LINE = '#C24A72';
const GOLD = { light: '#FFF2A8', main: '#FFC93C', dark: '#E39612', outline: '#8A5406' };
const COLLAR = { main: '#4B3A7A', light: '#7E6BB8', outline: '#241838' }; // neutral: never competes with fur colours
const KRAFT = { light: '#F6CD94', main: '#E3A762', dark: '#C4833F', outline: '#7A461C', inside: '#5A3316', tape: '#F2D9A8' };
const WOOD = { light: '#EDBB7C', main: '#D39556', dark: '#AE6E35', outline: '#6A3D16', grain: '#B97A3F' };
const STEEL = { main: '#A9B4CC', dark: '#6E7894', outline: '#454D66' };
const FRAME = { top1: '#FFD596', top2: '#F3AE5E', side: '#CF8040', side2: '#B76A2E', outline: '#8C4E20', lip: '#C47A38' };
const FLOOR_A = '#FFF4E4';
const FLOOR_B = '#FBE7CC';
const WALL = { top1: '#EEEAFC', top2: '#D6CEF2', side: '#ADA1DC', side2: '#9184C8', outline: '#6C5FA6' };
const SHADOW_RGB = '74, 40, 110';

const FONT_NAME = 'MeowDropNum';
const FONT_STACK = `${FONT_NAME}, Nunito, "Arial Rounded MT Bold", ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
const FONT_URL = '../../fonts/nunito-latin-900-normal.woff2';

// Cat layout (origin = cell centre).
const EAR_X = 0.195;
const EAR_Y = -0.262;
const EAR_ROT = 0.4;
const TAIL_X = 0.17;
const TAIL_Y = 0.335;
const FOOT = 0.45;
const SHADOW_Y = 0.43;
const KEY_Y = 0.217; // key ring hangs from the collar here
const HOP_H = 0.36;
const NV = 6; // base (fur pattern) variants

// Hole geometry.
const H_IN = 0.04; // gap between the cell edge and the rim
const H_RIM = 0.135; // rim width
const H_R = 0.26; // outer convex corner radius
const H_r = 0.1; // outer concave corner radius
const H_RI = 0.15; // pit convex radius
const H_rI = 0.22; // pit concave radius
const H_PAD = 0.3; // sprite padding (shadow / glow)

// Board.
const FRAME_W = 0.34;
const FRAME_D = 0.12;
const FLOOR_R = 0.2;

// ───────── small helpers ─────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => {
  const x = clamp01((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};
const easeOutBack = (x) => {
  const c = 1.9;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
};
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

function hexRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const c255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
function mix(a, b, t) {
  const A = hexRgb(a);
  const B = hexRgb(b);
  const r = c255(A[0] + (B[0] - A[0]) * t);
  const g = c255(A[1] + (B[1] - A[1]) * t);
  const bl = c255(A[2] + (B[2] - A[2]) * t);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}
function rgba(h, a) {
  const [r, g, b] = hexRgb(h);
  return `rgba(${r},${g},${b},${a})`;
}

/** Deterministic float in [0, 1) from (seed, k). */
function hash01(seed, k) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function ell(p, x, y, rx, ry, rot = 0) {
  p.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot));
  p.ellipse(x, y, rx, ry, rot, 0, TAU);
}

/** Clockwise rounded rectangle with per-corner radii (0 = sharp). */
function rrect(p, x, y, w, h, tl, tr = tl, br = tl, bl = tl) {
  p.moveTo(x + tl, y);
  p.lineTo(x + w - tr, y);
  if (tr) p.arcTo(x + w, y, x + w, y + tr, tr);
  else p.lineTo(x + w, y);
  p.lineTo(x + w, y + h - br);
  if (br) p.arcTo(x + w, y + h, x + w - br, y + h, br);
  else p.lineTo(x + w, y + h);
  p.lineTo(x + bl, y + h);
  if (bl) p.arcTo(x, y + h, x, y + h - bl, bl);
  else p.lineTo(x, y + h);
  p.lineTo(x, y + tl);
  if (tl) p.arcTo(x, y, x + tl, y, tl);
  else p.lineTo(x, y);
  p.closePath();
}

/** Small concave patch that rounds an inner corner at (cx, cy); (sx, sy) points into the empty quadrant. */
function fillet(p, cx, cy, sx, sy, r) {
  const ax = cx + r * sx;
  const by = cy + r * sy;
  p.moveTo(cx, cy);
  if (sx * sy > 0) {
    p.lineTo(ax, cy);
    p.arcTo(cx, cy, cx, by, r);
  } else {
    p.lineTo(cx, by);
    p.arcTo(cx, cy, ax, cy, r);
  }
  p.closePath();
}

/**
 * Union of the cells where isIn(x, y), grown by e, with convex corners rounded by R and inner corners
 * filleted by rf (e ≥ 0). One clockwise sub-path per cell: fill / clip with the nonzero rule.
 */
function regionPath(isIn, w, h, e, R, rf) {
  const p = new Path2D();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isIn(x, y)) continue;
      const n = isIn(x, y - 1);
      const s = isIn(x, y + 1);
      const wv = isIn(x - 1, y);
      const ev = isIn(x + 1, y);
      rrect(p, x - e, y - e, 1 + 2 * e, 1 + 2 * e, !n && !wv ? R : 0, !n && !ev ? R : 0, !s && !ev ? R : 0, !s && !wv ? R : 0);
    }
  }
  if (rf > 0) {
    for (let vy = 0; vy <= h; vy++) {
      for (let vx = 0; vx <= w; vx++) {
        const a = isIn(vx - 1, vy - 1);
        const b = isIn(vx, vy - 1);
        const c = isIn(vx - 1, vy);
        const d = isIn(vx, vy);
        if (a + b + c + d !== 3) continue;
        const sx = !b || !d ? 1 : -1;
        const sy = !c || !d ? 1 : -1;
        fillet(p, vx + sx * e, vy + sy * e, sx, sy, rf);
      }
    }
  }
  return p;
}

/** Boundary loops of a cell set (interior on the right = clockwise on screen), collinear points merged. */
function traceLoops(cells) {
  const has = new Set();
  for (const [x, y] of cells) has.add(x * 4096 + y);
  const inSet = (x, y) => has.has(x * 4096 + y);
  const edges = [];
  for (const [x, y] of cells) {
    if (!inSet(x, y - 1)) edges.push([x, y, x + 1, y]);
    if (!inSet(x + 1, y)) edges.push([x + 1, y, x + 1, y + 1]);
    if (!inSet(x, y + 1)) edges.push([x + 1, y + 1, x, y + 1]);
    if (!inSet(x - 1, y)) edges.push([x, y + 1, x, y]);
  }
  const byStart = new Map();
  edges.forEach((e, i) => {
    const k = e[0] * 4096 + e[1];
    const list = byStart.get(k);
    if (list) list.push(i);
    else byStart.set(k, [i]);
  });
  const used = new Uint8Array(edges.length);
  const loops = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    const pts = [];
    let cur = i;
    while (cur >= 0 && !used[cur]) {
      used[cur] = 1;
      const e = edges[cur];
      pts.push([e[0], e[1]]);
      const cands = (byStart.get(e[2] * 4096 + e[3]) || []).filter((j) => !used[j]);
      if (!cands.length) break;
      if (cands.length === 1) cur = cands[0];
      else {
        // Pinch point: turn right so diagonal neighbours stay separate loops.
        const dx = e[2] - e[0];
        const dy = e[3] - e[1];
        const right = cands.find((j) => {
          const f = edges[j];
          return dx * (f[3] - f[1]) - dy * (f[2] - f[0]) > 0;
        });
        cur = right === undefined ? cands[0] : right;
      }
    }
    const n = pts.length;
    const out = [];
    for (let k = 0; k < n; k++) {
      const a = pts[(k - 1 + n) % n];
      const b = pts[k];
      const c = pts[(k + 1) % n];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
    }
    if (out.length >= 4) loops.push(out);
  }
  return loops;
}

/** Adds a loop inset by d (rectilinear offset), corners rounded: convex by rc, concave by rv. */
function loopPath(p, pts, d, rc, rv) {
  const n = pts.length;
  const q = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const d1x = Math.sign(b[0] - a[0]);
    const d1y = Math.sign(b[1] - a[1]);
    const d2x = Math.sign(c[0] - b[0]);
    const d2y = Math.sign(c[1] - b[1]);
    const convex = d1x * d2y - d1y * d2x > 0;
    q[i] = [b[0] + d * (-d1y - d2y), b[1] + d * (d1x + d2x), convex ? rc : rv];
  }
  const len = (i, j) => Math.abs(q[i][0] - q[j][0]) + Math.abs(q[i][1] - q[j][1]);
  for (let i = 0; i < n; i++) {
    const r = Math.min(q[i][2], len(i, (i - 1 + n) % n) / 2, len(i, (i + 1) % n) / 2);
    q[i][2] = Math.max(0, r);
  }
  const l = q[n - 1];
  p.moveTo((l[0] + q[0][0]) / 2, (l[1] + q[0][1]) / 2);
  for (let i = 0; i < n; i++) {
    const b = q[i];
    const c = q[(i + 1) % n];
    p.arcTo(b[0], b[1], c[0], c[1], b[2]);
  }
  p.closePath();
}

function cellsPath(cells, d, rc, rv) {
  const p = new Path2D();
  for (const loop of traceLoops(cells)) loopPath(p, loop, d, rc, rv);
  return p;
}

/** Path2D of everything except `path` (inside a big rect); fill / clip with 'evenodd'. */
function inverse(path, x0, y0, x1, y1) {
  const p = new Path2D();
  p.rect(x0, y0, x1 - x0, y1 - y0);
  p.addPath(path);
  return p;
}

/**
 * Colour-blind marks: one simple symbol per colour id (heart, triangle, star, plus, drop, diamond, moon,
 * dot), centred at (x, y), about s across. Adds a fillable sub-path to p (fill with 'evenodd' for the moon).
 */
function symbolPath(p, k, x, y, s) {
  const r = s / 2;
  switch (k & 7) {
    case 0: // heart
      p.moveTo(x, y + r * 0.9);
      p.bezierCurveTo(x - r * 1.25, y + r * 0.05, x - r * 0.75, y - r * 1.05, x, y - r * 0.35);
      p.bezierCurveTo(x + r * 0.75, y - r * 1.05, x + r * 1.25, y + r * 0.05, x, y + r * 0.9);
      break;
    case 1: // triangle
      p.moveTo(x, y - r * 0.95);
      p.lineTo(x + r * 0.98, y + r * 0.75);
      p.lineTo(x - r * 0.98, y + r * 0.75);
      break;
    case 2: // star
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.45 : r * 1.05;
        if (i) p.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
        else p.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
      }
      break;
    case 3: { // plus
      const a = r * 0.36;
      const b = r * 0.95;
      p.moveTo(x - a, y - b);
      p.lineTo(x + a, y - b);
      p.lineTo(x + a, y - a);
      p.lineTo(x + b, y - a);
      p.lineTo(x + b, y + a);
      p.lineTo(x + a, y + a);
      p.lineTo(x + a, y + b);
      p.lineTo(x - a, y + b);
      p.lineTo(x - a, y + a);
      p.lineTo(x - b, y + a);
      p.lineTo(x - b, y - a);
      p.lineTo(x - a, y - a);
      break;
    }
    case 4: // drop
      p.moveTo(x, y - r * 1.05);
      p.bezierCurveTo(x + r * 0.35, y - r * 0.45, x + r * 0.8, y - r * 0.05, x + r * 0.8, y + r * 0.3);
      p.arc(x, y + r * 0.3, r * 0.8, 0, Math.PI);
      p.bezierCurveTo(x - r * 0.8, y - r * 0.05, x - r * 0.35, y - r * 0.45, x, y - r * 1.05);
      break;
    case 5: // diamond
      p.moveTo(x, y - r);
      p.lineTo(x + r * 0.78, y);
      p.lineTo(x, y + r);
      p.lineTo(x - r * 0.78, y);
      break;
    case 6: // crescent moon
      p.moveTo(x + r * 0.95, y);
      p.arc(x, y, r * 0.95, 0, TAU);
      p.moveTo(x + r * 1.25, y - r * 0.3);
      p.arc(x + r * 0.45, y - r * 0.3, r * 0.8, 0, TAU);
      break;
    default: // dot
      p.moveTo(x + r * 0.8, y);
      p.arc(x, y, r * 0.8, 0, TAU);
  }
  p.closePath();
}

// ───────── number font (shared by every art instance) ─────────
let fontPromise = null;
function loadFont() {
  if (fontPromise) return fontPromise;
  try {
    if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) {
      fontPromise = Promise.resolve(false);
    } else {
      const url = new URL(FONT_URL, import.meta.url).href;
      const face = new FontFace(FONT_NAME, `url("${url}") format("woff2")`, { weight: '900', style: 'normal' });
      fontPromise = face.load().then(
        (f) => {
          document.fonts.add(f);
          return true;
        },
        () => false,
      );
    }
  } catch {
    fontPromise = Promise.resolve(false);
  }
  return fontPromise;
}

// ───────── per-cat look and timing from its seed ─────────
const paramCache = new Map();
function catParams(seed) {
  let p = paramCache.get(seed);
  if (p) return p;
  const s = Number.isInteger(seed) ? seed | 0 : Math.floor((seed || 0) * 1e6) | 0;
  const r = (k) => hash01(s, k);
  p = {
    v: Math.floor(r(1) * NV),
    big: r(2) < 0.45 ? 1 : 0,
    side: r(3) < 0.5 ? 1 : -1,
    tip: r(4) < 0.4 ? 1 : 0,
    el: (r(5) - 0.5) * 0.24,
    er: (r(6) - 0.5) * 0.24,
    blinkP: 2.2 + r(7) * 3.8,
    blinkO: r(8) * 7,
    dbl: r(9) < 0.3,
    bw: TAU / (2.3 + r(10) * 1.1),
    bp: r(11) * TAU,
    tw: TAU / (2.1 + r(12) * 1.5),
    tp: r(13) * TAU,
    ta: 0.1 + r(14) * 0.08,
    twP: 5.5 + r(15) * 7,
    twO: r(16) * 12,
    twS: r(17) < 0.5 ? 0 : 1,
    kp: r(18) * TAU,
    wig: 3.5 + r(19) * 4,
  };
  if (paramCache.size > 4000) paramCache.clear();
  paramCache.set(seed, p);
  return p;
}

const FACE_OPEN = 0;
const FACE_CLOSED = 1;
const FACE_HAPPY = 2;
const FACE_SURPRISED = 3;

// ═════════════════════════════════════════ createArt ═════════════════════════════════════════
export function createArt() {
  let cell = 44;
  let dpr = 1;
  let S = 44; // device px per cell
  let lw = 0.034; // outline width (cells)
  let used = 0; // device px held by caches
  const BUDGET = 20e6; // ~80 MB of sprite pixels at most
  let marks = false; // colour-blind symbols on cats and in pits

  let catSp = []; // [kind][...] see getters
  let holeC = new Map();
  let textC = new Map();
  let misc = {};
  const geoC = new Map(); // shape key → geometry (size independent)
  const keyOf = new WeakMap(); // cells array → shape key
  let scratch = null;

  // ───────── canvases & sprites ─────────
  function newCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  function free(sp) {
    if (!sp || !sp.c) return;
    used -= sp.c.width * sp.c.height;
    sp.c.width = 0;
    sp.c.height = 0;
    if (sp.sil) free(sp.sil);
  }

  /**
   * Paints a sprite covering [x0, x1] × [y0, y1] cells around its anchor (0, 0); paint(g) draws in cell
   * units. Returns { c, ox, oy, w, h } in CSS px: blit at (ax - ox, ay - oy, w, h).
   */
  function sprite(x0, y0, x1, y1, paint) {
    const ox = Math.ceil(-x0 * S);
    const oy = Math.ceil(-y0 * S);
    const W = ox + Math.ceil(x1 * S);
    const H = oy + Math.ceil(y1 * S);
    const c = newCanvas(W, H);
    const g = c.getContext('2d');
    g.setTransform(S, 0, 0, S, ox, oy);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    paint(g);
    used += c.width * c.height;
    return { c, ox: ox / dpr, oy: oy / dpr, w: c.width / dpr, h: c.height / dpr, sil: null };
  }

  /** Same sprite flattened to one colour (for tinting falling cats). */
  function silOf(sp, colour) {
    if (sp.sil) return sp.sil;
    const c = newCanvas(sp.c.width, sp.c.height);
    const g = c.getContext('2d');
    g.drawImage(sp.c, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = colour;
    g.fillRect(0, 0, c.width, c.height);
    used += c.width * c.height;
    sp.sil = { c, ox: sp.ox, oy: sp.oy, w: sp.w, h: sp.h, sil: null };
    return sp.sil;
  }

  function blit(ctx, sp, x, y) {
    ctx.drawImage(sp.c, x - sp.ox, y - sp.oy, sp.w, sp.h);
  }

  function clear() {
    for (const list of catSp) if (list) for (const sp of list) free(sp);
    for (const e of holeC.values()) freeHole(e);
    for (const sp of textC.values()) free(sp);
    for (const k of Object.keys(misc)) {
      const v = misc[k];
      if (Array.isArray(v)) v.forEach(free);
      else free(v);
    }
    catSp = [[], [], [], [], [], []];
    holeC = new Map();
    textC = new Map();
    misc = {};
    used = 0;
  }

  function freeHole(e) {
    free(e.base);
    free(e.glow);
    free(e.white);
    free(e.flash);
    free(e.lid);
  }

  /** Keeps the caches under budget by dropping the oldest holes / text sprites first. */
  function trim() {
    if (used <= BUDGET) return;
    for (const [k, e] of holeC) {
      if (used <= BUDGET * 0.75) break;
      freeHole(e);
      holeC.delete(k);
    }
    for (const [k, sp] of textC) {
      if (used <= BUDGET * 0.75) break;
      free(sp);
      textC.delete(k);
    }
  }

  // ───────── text ─────────
  function font(px) {
    return `900 ${px.toFixed(2)}px ${FONT_STACK}`;
  }

  /** Text at (x, y) cells (centre), size in cells, painted in device px for crisp glyphs. */
  function paintText(g, str, x, y, size, fill, stroke, strokeW, shadow) {
    const m = g.getTransform();
    const px = size * m.a;
    g.save();
    g.setTransform(1, 0, 0, 1, m.e + x * m.a, m.f + y * m.d);
    g.font = font(px);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const tm = g.measureText(str);
    const asc = tm.actualBoundingBoxAscent || px * 0.71;
    const desc = tm.actualBoundingBoxDescent || 0;
    const base = (asc - desc) / 2;
    g.lineJoin = 'round';
    g.miterLimit = 2;
    if (shadow) {
      g.lineWidth = strokeW * px * 2;
      g.strokeStyle = shadow;
      g.fillStyle = shadow;
      g.strokeText(str, 0, base + px * 0.075);
      g.fillText(str, 0, base + px * 0.075);
    }
    if (stroke) {
      g.lineWidth = strokeW * px * 2;
      g.strokeStyle = stroke;
      g.strokeText(str, 0, base);
    }
    if (typeof fill === 'string') g.fillStyle = fill;
    else {
      const gr = g.createLinearGradient(0, base - asc, 0, base);
      gr.addColorStop(0, fill[0]);
      gr.addColorStop(1, fill[1]);
      g.fillStyle = gr;
    }
    g.fillText(str, 0, base);
    g.restore();
  }

  function measureCells(str, size) {
    if (!scratch) scratch = newCanvas(4, 4).getContext('2d');
    scratch.font = font(size * S);
    return scratch.measureText(str).width / S;
  }

  /** Cached number badge for a hole of colour c. */
  function badgeSp(n, c) {
    const key = 'b' + n + '|' + c;
    let sp = textC.get(key);
    if (sp) return sp;
    const str = String(n);
    const size = str.length === 1 ? 0.47 : str.length === 2 ? 0.4 : 0.31;
    const w = measureCells(str, size) / 2 + size * 0.3;
    const P = PALETTE[c];
    trim(); // before creating: never evicts the sprite we are about to return
    sp = sprite(-w, -size * 0.75, w, size * 0.8, (g) =>
      paintText(g, str, 0, 0, size, ['#FFFFFF', mix(P.light, '#FFFFFF', 0.55)], P.outline, 0.13, rgba(P.deep, 0.9)));
    textC.set(key, sp);
    return sp;
  }

  function iceNumSp(n) {
    const key = 'i' + n;
    let sp = textC.get(key);
    if (sp) return sp;
    const str = String(n);
    const size = str.length === 1 ? 0.36 : 0.3;
    const w = measureCells(str, size) / 2 + size * 0.3;
    sp = sprite(-w, -size * 0.75, w, size * 0.8, (g) =>
      paintText(g, str, 0, 0, size, ['#FFFFFF', '#E3F6FF'], '#2B78B8', 0.14, 'rgba(22, 70, 125, 0.85)'));
    textC.set(key, sp);
    return sp;
  }

  // ═════════════════════════════════════════ cats ═════════════════════════════════════════
  function headPath() {
    const p = new Path2D();
    p.moveTo(0, -0.365);
    p.bezierCurveTo(0.215, -0.365, 0.36, -0.24, 0.36, -0.05);
    p.bezierCurveTo(0.36, 0.115, 0.215, 0.192, 0, 0.192);
    p.bezierCurveTo(-0.215, 0.192, -0.36, 0.115, -0.36, -0.05);
    p.bezierCurveTo(-0.36, -0.24, -0.215, -0.365, 0, -0.365);
    p.closePath();
    return p;
  }

  function paintBase(g, P, v) {
    const L = lw;
    const tabby = v === 1 || v === 5;
    const socks = v === 4 || v === 5;
    const patch = v === 2 ? -1 : v === 3 ? 1 : 0;
    const blaze = v === 4;
    const fine = S >= 96;

    // Body and haunches (one silhouette, outlined together).
    const body = new Path2D();
    body.moveTo(-0.165, 0.03);
    body.bezierCurveTo(-0.235, 0.12, -0.268, 0.3, -0.22, 0.395);
    body.quadraticCurveTo(-0.165, 0.455, 0, 0.455);
    body.quadraticCurveTo(0.165, 0.455, 0.22, 0.395);
    body.bezierCurveTo(0.268, 0.3, 0.235, 0.12, 0.165, 0.03);
    body.closePath();
    const hl = new Path2D();
    ell(hl, -0.205, 0.372, 0.098, 0.083);
    const hr = new Path2D();
    ell(hr, 0.205, 0.372, 0.098, 0.083);
    g.lineWidth = 2 * L;
    g.strokeStyle = P.outline;
    g.stroke(body);
    g.stroke(hl);
    g.stroke(hr);
    const bg = g.createLinearGradient(0, 0.06, 0, 0.46);
    bg.addColorStop(0, P.main);
    bg.addColorStop(1, mix(P.main, P.dark, 0.6));
    g.fillStyle = bg;
    g.fill(body);
    g.fill(hl);
    g.fill(hr);
    // haunch creases
    g.strokeStyle = rgba(P.outline, 0.4);
    g.lineWidth = L * 0.75;
    g.beginPath();
    g.arc(-0.205, 0.372, 0.07, -2.5, -1.0);
    g.moveTo(0.205 + 0.07 * Math.cos(-2.14), 0.372 + 0.07 * Math.sin(-2.14));
    g.arc(0.205, 0.372, 0.07, -2.14, -0.64);
    g.stroke();
    // belly
    g.fillStyle = P.light;
    g.beginPath();
    ell(g, 0, 0.318, 0.112, 0.098);
    g.fill();
    if (marks) {
      const sp = new Path2D();
      symbolPath(sp, PALETTE.indexOf(P), 0, 0.293, 0.13);
      g.fillStyle = P.dark;
      g.fill(sp, 'evenodd');
    }
    // chin shadow
    g.fillStyle = rgba(P.outline, 0.22);
    g.beginPath();
    ell(g, 0, 0.205, 0.19, 0.05);
    g.fill();
    // front paws
    for (const s of [-1, 1]) {
      const pp = new Path2D();
      ell(pp, s * 0.088, 0.412, 0.073, 0.054);
      g.lineWidth = 2 * L;
      g.strokeStyle = P.outline;
      g.stroke(pp);
      g.fillStyle = socks ? P.light : mix(P.main, P.light, 0.3);
      g.fill(pp);
      if (fine) {
        g.strokeStyle = rgba(P.outline, 0.45);
        g.lineWidth = L * 0.6;
        g.beginPath();
        g.moveTo(s * 0.088 - 0.022, 0.43);
        g.lineTo(s * 0.088 - 0.022, 0.452);
        g.moveTo(s * 0.088 + 0.022, 0.43);
        g.lineTo(s * 0.088 + 0.022, 0.452);
        g.stroke();
      }
    }

    // Head.
    const head = headPath();
    g.lineWidth = 2 * L;
    g.strokeStyle = P.outline;
    g.stroke(head);
    const hg = g.createRadialGradient(-0.1, -0.2, 0.02, 0, -0.06, 0.43);
    hg.addColorStop(0, mix(P.main, P.light, 0.5));
    hg.addColorStop(0.5, P.main);
    hg.addColorStop(1, mix(P.main, P.dark, 0.55));
    g.fillStyle = hg;
    g.fill(head);
    g.save();
    g.clip(head);
    if (patch) {
      g.fillStyle = P.light;
      g.beginPath();
      ell(g, patch * 0.17, -0.12, 0.16, 0.15, patch * 0.35);
      g.fill();
    }
    if (blaze) {
      g.fillStyle = P.light;
      g.beginPath();
      g.moveTo(0, -0.37);
      g.bezierCurveTo(0.05, -0.25, 0.04, -0.12, 0.075, 0.0);
      g.lineTo(-0.075, 0.0);
      g.bezierCurveTo(-0.04, -0.12, -0.05, -0.25, 0, -0.37);
      g.fill();
    }
    if (tabby) {
      g.strokeStyle = mix(P.dark, P.outline, 0.35);
      g.lineWidth = 0.034;
      g.beginPath();
      g.moveTo(0, -0.37);
      g.lineTo(0, -0.27);
      g.moveTo(-0.075, -0.36);
      g.lineTo(-0.064, -0.29);
      g.moveTo(0.075, -0.36);
      g.lineTo(0.064, -0.29);
      // cheek stripes
      g.moveTo(-0.37, -0.06);
      g.lineTo(-0.3, -0.05);
      g.moveTo(-0.37, 0.0);
      g.lineTo(-0.31, 0.005);
      g.moveTo(0.37, -0.06);
      g.lineTo(0.3, -0.05);
      g.moveTo(0.37, 0.0);
      g.lineTo(0.31, 0.005);
      g.stroke();
    }
    // muzzle
    g.fillStyle = P.light;
    g.beginPath();
    ell(g, -0.068, 0.078, 0.094, 0.07);
    ell(g, 0.068, 0.078, 0.094, 0.07);
    ell(g, 0, 0.115, 0.07, 0.05);
    g.fill();
    // lower-face shade + top light
    const sg = g.createLinearGradient(0, -0.37, 0, 0.2);
    sg.addColorStop(0, 'rgba(255,255,255,0.16)');
    sg.addColorStop(0.35, 'rgba(255,255,255,0)');
    sg.addColorStop(0.8, rgba(P.dark, 0));
    sg.addColorStop(1, rgba(P.dark, 0.28));
    g.fillStyle = sg;
    g.fillRect(-0.4, -0.4, 0.8, 0.62);
    g.restore();
    // whiskers
    g.strokeStyle = rgba(P.outline, 0.72);
    g.lineWidth = L * 0.72;
    g.beginPath();
    for (const s of [-1, 1]) {
      g.moveTo(s * 0.24, 0.05);
      g.quadraticCurveTo(s * 0.33, 0.025, s * 0.405, 0.022);
      g.moveTo(s * 0.245, 0.09);
      g.quadraticCurveTo(s * 0.33, 0.095, s * 0.4, 0.112);
    }
    g.stroke();
    // gloss
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.beginPath();
    ell(g, -0.17, -0.245, 0.078, 0.038, -0.55);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.beginPath();
    ell(g, -0.255, -0.16, 0.02, 0.02);
    g.fill();
  }

  function paintEar(g, P) {
    const L = lw;
    const ear = new Path2D();
    ear.moveTo(-0.13, 0.075);
    ear.arcTo(0, -0.235, 0.13, 0.075, 0.045);
    ear.lineTo(0.13, 0.075);
    ear.closePath();
    g.lineWidth = 2 * L;
    g.strokeStyle = P.outline;
    g.stroke(ear);
    const eg = g.createLinearGradient(0, -0.17, 0, 0.07);
    eg.addColorStop(0, mix(P.main, P.dark, 0.25));
    eg.addColorStop(1, P.main);
    g.fillStyle = eg;
    g.fill(ear);
    const inner = new Path2D();
    inner.moveTo(-0.074, 0.06);
    inner.arcTo(0, -0.15, 0.074, 0.06, 0.026);
    inner.lineTo(0.074, 0.06);
    inner.closePath();
    const ig = g.createLinearGradient(0, -0.1, 0, 0.06);
    ig.addColorStop(0, '#FF8FB2');
    ig.addColorStop(1, '#FFC4D6');
    g.fillStyle = ig;
    g.fill(inner);
  }

  function paintTail(g, P, tip) {
    const L = lw;
    const W = 0.088;
    const t = new Path2D();
    t.moveTo(-0.03, 0.025);
    t.bezierCurveTo(0.11, 0.055, 0.245, -0.02, 0.238, -0.15);
    t.bezierCurveTo(0.233, -0.24, 0.16, -0.28, 0.12, -0.235);
    g.strokeStyle = P.outline;
    g.lineWidth = W + 2 * L;
    g.stroke(t);
    g.strokeStyle = P.main;
    g.lineWidth = W;
    g.stroke(t);
    if (tip) {
      const tp = new Path2D();
      tp.moveTo(0.228, -0.205);
      tp.bezierCurveTo(0.212, -0.25, 0.16, -0.275, 0.12, -0.235);
      g.strokeStyle = P.light;
      g.stroke(tp);
    }
    g.save();
    g.translate(-0.014, -0.012);
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    g.lineWidth = W * 0.28;
    const hl = new Path2D();
    hl.moveTo(0.06, 0.035);
    hl.bezierCurveTo(0.15, 0.04, 0.235, -0.03, 0.232, -0.13);
    g.stroke(hl);
    g.restore();
  }

  function paintFace(g, big, state) {
    const L = lw;
    const ex = 0.135;
    const ey = -0.035;
    const rx = big ? 0.072 : 0.064;
    const ry = big ? 0.088 : 0.079;
    g.fillStyle = BLUSH;
    g.beginPath();
    ell(g, -0.218, 0.062, 0.056, 0.033);
    ell(g, 0.218, 0.062, 0.056, 0.033);
    g.fill();
    g.strokeStyle = INK;
    g.fillStyle = INK;
    for (const s of [-1, 1]) {
      const x = s * ex;
      if (state === FACE_OPEN) {
        const eg = g.createLinearGradient(0, ey - ry, 0, ey + ry);
        eg.addColorStop(0, '#24142F');
        eg.addColorStop(0.55, '#36204A');
        eg.addColorStop(1, '#6B4FA0');
        g.fillStyle = eg;
        g.beginPath();
        ell(g, x, ey, rx, ry);
        g.fill();
        g.fillStyle = '#FFFFFF';
        g.beginPath();
        ell(g, x - rx * 0.28, ey - ry * 0.36, rx * 0.44, rx * 0.44);
        g.fill();
        g.beginPath();
        ell(g, x + rx * 0.4, ey + ry * 0.42, rx * 0.18, rx * 0.18);
        g.fill();
      } else if (state === FACE_CLOSED) {
        g.lineWidth = L * 1.25;
        g.beginPath();
        g.moveTo(x - rx * 1.05, ey + 0.01);
        g.quadraticCurveTo(x, ey + 0.065, x + rx * 1.05, ey + 0.01);
        g.stroke();
      } else if (state === FACE_HAPPY) {
        g.lineWidth = L * 1.45;
        g.beginPath();
        g.moveTo(x - rx * 1.0, ey + 0.03);
        g.quadraticCurveTo(x, ey - 0.07, x + rx * 1.0, ey + 0.03);
        g.stroke();
      } else {
        const r = ry * 1.02;
        g.fillStyle = '#FFFFFF';
        g.lineWidth = L * 0.9;
        g.beginPath();
        ell(g, x, ey, r * 0.92, r);
        g.fill();
        g.stroke();
        g.fillStyle = '#24142F';
        g.beginPath();
        ell(g, x, ey + 0.006, r * 0.5, r * 0.55);
        g.fill();
        g.fillStyle = '#FFFFFF';
        g.beginPath();
        ell(g, x - r * 0.18, ey - r * 0.2, r * 0.17, r * 0.17);
        g.fill();
      }
    }
    // nose
    g.fillStyle = NOSE;
    g.strokeStyle = NOSE_LINE;
    g.lineWidth = L * 0.55;
    g.beginPath();
    g.moveTo(-0.03, 0.025);
    g.quadraticCurveTo(0, 0.017, 0.03, 0.025);
    g.quadraticCurveTo(0.012, 0.055, 0, 0.056);
    g.quadraticCurveTo(-0.012, 0.055, -0.03, 0.025);
    g.closePath();
    g.fill();
    g.stroke();
    // mouth
    g.strokeStyle = INK;
    g.lineWidth = L * 0.85;
    if (state === FACE_HAPPY) {
      g.fillStyle = '#7A2342';
      g.beginPath();
      g.moveTo(-0.055, 0.066);
      g.quadraticCurveTo(0, 0.078, 0.055, 0.066);
      g.quadraticCurveTo(0.05, 0.135, 0, 0.138);
      g.quadraticCurveTo(-0.05, 0.135, -0.055, 0.066);
      g.closePath();
      g.fill();
      g.save();
      g.clip();
      g.fillStyle = '#FF8DAA';
      g.beginPath();
      ell(g, 0, 0.13, 0.034, 0.025);
      g.fill();
      g.restore();
      g.stroke();
    } else if (state === FACE_SURPRISED) {
      g.fillStyle = '#7A2342';
      g.beginPath();
      ell(g, 0, 0.096, 0.026, 0.032);
      g.fill();
      g.stroke();
    } else {
      g.beginPath();
      g.moveTo(0, 0.054);
      g.lineTo(0, 0.068);
      g.moveTo(-0.055, 0.062);
      g.quadraticCurveTo(-0.027, 0.096, 0, 0.068);
      g.quadraticCurveTo(0.027, 0.096, 0.055, 0.062);
      g.stroke();
    }
  }

  function paintKey(g) {
    const L = lw * 0.9;
    const bow = new Path2D();
    bow.arc(0, 0.062, 0.054, 0, TAU);
    bow.closePath();
    bow.moveTo(0.021, 0.062);
    bow.arc(0, 0.062, 0.021, 0, TAU, true);
    const stem = new Path2D();
    rrect(stem, -0.019, 0.098, 0.038, 0.135, 0.016);
    rrect(stem, 0.0, 0.17, 0.058, 0.026, 0.01);
    rrect(stem, 0.0, 0.205, 0.046, 0.026, 0.01);
    const ring = new Path2D();
    ring.arc(0, 0.0, 0.016, 0, TAU);
    g.lineWidth = 2 * L;
    g.strokeStyle = GOLD.outline;
    g.stroke(stem);
    g.stroke(bow);
    g.lineWidth = L * 1.2;
    g.stroke(ring);
    const gg = g.createLinearGradient(-0.05, 0, 0.06, 0.24);
    gg.addColorStop(0, GOLD.light);
    gg.addColorStop(0.45, GOLD.main);
    gg.addColorStop(1, GOLD.dark);
    g.fillStyle = gg;
    g.fill(stem);
    g.fill(bow, 'evenodd');
    g.strokeStyle = GOLD.main;
    g.lineWidth = L * 0.6;
    g.stroke(ring);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    ell(g, -0.026, 0.04, 0.014, 0.01, -0.7);
    g.fill();
  }

  function paintShadow(g) {
    g.save();
    g.scale(1, 0.3);
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, 0.31);
    rg.addColorStop(0, `rgba(${SHADOW_RGB},0.32)`);
    rg.addColorStop(0.6, `rgba(${SHADOW_RGB},0.22)`);
    rg.addColorStop(1, `rgba(${SHADOW_RGB},0)`);
    g.fillStyle = rg;
    g.beginPath();
    g.arc(0, 0, 0.31, 0, TAU);
    g.fill();
    g.restore();
  }

  // sprite getters (catSp: 0 base, 1 ear, 2 tail, 3 face, 4 shadow/key/etc)
  function baseSp(c, v) {
    const i = c * NV + v;
    return catSp[0][i] || (catSp[0][i] = sprite(-0.47, -0.42, 0.47, 0.5, (g) => paintBase(g, PALETTE[c], v)));
  }
  function earSp(c) {
    return catSp[1][c] || (catSp[1][c] = sprite(-0.17, -0.24, 0.17, 0.12, (g) => paintEar(g, PALETTE[c])));
  }
  function tailSp(c, tip) {
    const i = c * 2 + tip;
    return catSp[2][i] || (catSp[2][i] = sprite(-0.09, -0.34, 0.32, 0.1, (g) => paintTail(g, PALETTE[c], tip)));
  }
  function faceSp(big, state) {
    const i = big * 4 + state;
    return catSp[3][i] || (catSp[3][i] = sprite(-0.3, -0.16, 0.3, 0.17, (g) => paintFace(g, big, state)));
  }
  function shadowSp() {
    return catSp[4][0] || (catSp[4][0] = sprite(-0.33, -0.11, 0.33, 0.11, paintShadow));
  }
  function paintCollar(g) {
    const band = new Path2D();
    band.moveTo(-0.165, 0.17);
    band.quadraticCurveTo(0, 0.268, 0.165, 0.17);
    g.lineCap = 'round';
    g.strokeStyle = COLLAR.outline;
    g.lineWidth = 0.05 + 1.6 * lw;
    g.stroke(band);
    g.strokeStyle = COLLAR.main;
    g.lineWidth = 0.05;
    g.stroke(band);
    g.strokeStyle = rgba(COLLAR.light, 0.9);
    g.lineWidth = 0.014;
    g.beginPath();
    g.moveTo(-0.12, 0.176);
    g.quadraticCurveTo(-0.05, 0.208, -0.02, 0.212);
    g.stroke();
  }
  function collarSp() {
    return catSp[4][2] || (catSp[4][2] = sprite(-0.21, 0.11, 0.21, 0.27, paintCollar));
  }
  function keySp() {
    return catSp[4][1] || (catSp[4][1] = sprite(-0.085, -0.03, 0.095, 0.26, paintKey));
  }

  function isBlink(t, p) {
    let u = (t + p.blinkO) % p.blinkP;
    if (u < 0) u += p.blinkP;
    return u < 0.12 || (p.dbl && u > 0.24 && u < 0.35);
  }

  function drawCat(ctx, cx, cy, colour, o) {
    if (!o) o = EMPTY;
    const c = colour & 7;
    const alpha = o.alpha === undefined ? 1 : o.alpha;
    const k = (o.size > 0 ? o.size / cell : 1) * (o.scale === undefined ? 1 : o.scale);
    if (!(alpha > 0.003) || !(k > 0.003)) return;
    const t = o.t || 0;
    const p = catParams(o.seed || 0);
    const tint = o.tint > 0 ? (o.tint < 1 ? o.tint : 1) : 0;
    const hop = o.hop > 0 && o.hop < 1 ? o.hop : 0;
    let mood = o.mood === 'happy' ? 1 : o.mood === 'surprised' ? 2 : 0;
    if (hop && mood === 0) mood = 1;
    const P = PALETTE[c];

    const br = Math.sin(t * p.bw + p.bp);
    let sx = 1 - 0.012 * br;
    let sy = 1 + 0.02 * br;
    let lift = 0;
    if (hop) {
      if (hop < 0.16) {
        const s = Math.sin((hop / 0.16) * Math.PI);
        sx *= 1 + 0.15 * s;
        sy *= 1 - 0.17 * s;
      } else if (hop < 0.84) {
        const u = (hop - 0.16) / 0.68;
        lift = 4 * u * (1 - u);
        const st = Math.abs(Math.cos(u * Math.PI));
        sy *= 1 + 0.12 * st;
        sx *= 1 - 0.08 * st;
      } else {
        const s = Math.sin(((hop - 0.84) / 0.16) * Math.PI);
        sx *= 1 + 0.13 * s;
        sy *= 1 - 0.14 * s;
      }
    }
    const ga = ctx.globalAlpha;
    const C = cell * k;
    if (o.shadow !== false && tint < 1) {
      const sh = shadowSp();
      const f = 1 - 0.45 * lift;
      ctx.globalAlpha = ga * alpha * (1 - tint) * (0.55 + 0.45 * f);
      const kk = k * f;
      ctx.drawImage(sh.c, cx - sh.ox * kk, cy + SHADOW_Y * C - sh.oy * kk, sh.w * kk, sh.h * kk);
    }
    const a1 = ga * alpha;
    const at = a1 * tint;
    ctx.globalAlpha = a1;
    ctx.save();
    ctx.translate(cx, cy - lift * HOP_H * C);
    if (o.rot) ctx.rotate(o.rot);
    const fy = FOOT * cell;
    ctx.translate(0, fy * k);
    ctx.scale(k * sx, k * sy);
    ctx.translate(0, -fy);

    // tail
    const tail = tailSp(c, p.tip);
    const ta = mood === 1 ? Math.sin(t * p.tw * 2.6 + p.tp) * (p.ta + 0.12) : Math.sin(t * p.tw + p.tp) * p.ta;
    ctx.save();
    ctx.translate(p.side * TAIL_X * cell, TAIL_Y * cell);
    ctx.scale(p.side, 1);
    ctx.rotate(ta);
    blit(ctx, tail, 0, 0);
    if (at > 0) {
      ctx.globalAlpha = at;
      blit(ctx, silOf(tail, P.deep), 0, 0);
      ctx.globalAlpha = a1;
    }
    ctx.restore();

    // ears
    const ear = earSp(c);
    let tw = 0;
    let u = (t + p.twO) % p.twP;
    if (u < 0) u += p.twP;
    if (u < 0.34) tw = 0.32 * Math.abs(Math.sin((u / 0.17) * Math.PI));
    const er = EAR_ROT + (mood === 2 ? -0.14 : mood === 1 ? 0.05 : 0);
    const earSil = at > 0 ? silOf(ear, P.deep) : null;
    ctx.save();
    ctx.translate(-EAR_X * cell, EAR_Y * cell);
    ctx.rotate(-(er + p.el + (p.twS ? 0 : tw)));
    blit(ctx, ear, 0, 0);
    if (earSil) {
      ctx.globalAlpha = at;
      blit(ctx, earSil, 0, 0);
      ctx.globalAlpha = a1;
    }
    ctx.restore();
    ctx.save();
    ctx.translate(EAR_X * cell, EAR_Y * cell);
    ctx.rotate(er + p.er + (p.twS ? tw : 0));
    ctx.scale(-1, 1);
    blit(ctx, ear, 0, 0);
    if (earSil) {
      ctx.globalAlpha = at;
      blit(ctx, earSil, 0, 0);
      ctx.globalAlpha = a1;
    }
    ctx.restore();

    // body + head, face
    const base = baseSp(c, p.v);
    blit(ctx, base, 0, 0);
    const state = mood === 1 ? FACE_HAPPY : mood === 2 ? FACE_SURPRISED : o.blink || isBlink(t, p) ? FACE_CLOSED : FACE_OPEN;
    blit(ctx, faceSp(p.big, state), 0, 0);
    if (at > 0) {
      ctx.globalAlpha = at;
      blit(ctx, silOf(base, P.deep), 0, 0);
      ctx.globalAlpha = a1;
    }
    if (o.key) {
      const ks = keySp();
      ctx.globalAlpha = a1 * (1 - tint);
      blit(ctx, collarSp(), 0, 0);
      ctx.translate(0, KEY_Y * cell);
      ctx.rotate(0.13 * Math.sin(t * 2.3 + p.kp) + (hop ? 0.25 * Math.sin(hop * TAU) : 0));
      blit(ctx, ks, 0, 0);
    }
    ctx.restore();
    ctx.globalAlpha = ga;
  }

  function drawKey(ctx, cx, cy, o) {
    if (!o) o = EMPTY;
    const k = o.size > 0 ? o.size / cell : 1;
    const ks = keySp();
    const ga = ctx.globalAlpha;
    if (o.alpha !== undefined) ctx.globalAlpha = ga * o.alpha;
    ctx.save();
    ctx.translate(cx, cy);
    if (o.rot) ctx.rotate(o.rot);
    ctx.scale(k * 1.6, k * 1.6);
    ctx.translate(0, -0.12 * cell);
    blit(ctx, ks, 0, 0);
    ctx.restore();
    ctx.globalAlpha = ga;
  }

  // ═════════════════════════════════════════ sparkle ═════════════════════════════════════════
  function sparkSp() {
    return (misc.spark ||= sprite(-0.5, -0.5, 0.5, 0.5, (g) => {
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, 0.5);
      rg.addColorStop(0, 'rgba(255,255,240,0.7)');
      rg.addColorStop(0.22, 'rgba(255,250,220,0.22)');
      rg.addColorStop(0.5, 'rgba(255,250,220,0)');
      g.fillStyle = rg;
      g.fillRect(-0.5, -0.5, 1, 1);
      g.fillStyle = '#FFFFFF';
      g.beginPath();
      g.moveTo(0, -0.48);
      g.quadraticCurveTo(0.03, -0.03, 0.48, 0);
      g.quadraticCurveTo(0.03, 0.03, 0, 0.48);
      g.quadraticCurveTo(-0.03, 0.03, -0.48, 0);
      g.quadraticCurveTo(-0.03, -0.03, 0, -0.48);
      g.fill();
    }));
  }

  function drawSparkle(ctx, x, y, size, o) {
    if (!o) o = EMPTY;
    if (!(size > 0)) return;
    const sp = sparkSp();
    const ga = ctx.globalAlpha;
    if (o.alpha !== undefined) ctx.globalAlpha = ga * o.alpha;
    const k = size / cell;
    if (o.rot) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(o.rot);
      ctx.drawImage(sp.c, -sp.ox * k, -sp.oy * k, sp.w * k, sp.h * k);
      ctx.restore();
    } else ctx.drawImage(sp.c, x - sp.ox * k, y - sp.oy * k, sp.w * k, sp.h * k);
    ctx.globalAlpha = ga;
  }

  // ═════════════════════════════════════════ holes ═════════════════════════════════════════
  function shapeKey(cells) {
    let k = keyOf.get(cells);
    if (k) return k;
    k = cells.map((p) => p[0] + ',' + p[1]).sort().join(';');
    if (cells && typeof cells === 'object') keyOf.set(cells, k);
    return k;
  }

  function geom(cells) {
    const key = shapeKey(cells);
    let G = geoC.get(key);
    if (G) return G;
    const list = cells.map((p) => [p[0], p[1]]);
    const has = new Set(list.map(([x, y]) => x * 4096 + y));
    const inSet = (x, y) => has.has(x * 4096 + y);
    let bw = 0;
    let bh = 0;
    let sx = 0;
    let sy = 0;
    for (const [x, y] of list) {
      bw = Math.max(bw, x + 1);
      bh = Math.max(bh, y + 1);
      sx += x + 0.5;
      sy += y + 0.5;
    }
    let bx = sx / list.length;
    let by = sy / list.length;
    let fits = inSet(Math.floor(bx), Math.floor(by));
    for (let i = 0; fits && i < 12; i++) {
      const a = (i * TAU) / 12;
      fits = inSet(Math.floor(bx + 0.3 * Math.cos(a)), Math.floor(by + 0.3 * Math.sin(a)));
    }
    if (!fits) {
      let best = Infinity;
      let nx = 0.5;
      let ny = 0.5;
      for (const [x, y] of list) {
        const d = (x + 0.5 - bx) ** 2 + (y + 0.5 - by) ** 2;
        if (d < best - 1e-9) {
          best = d;
          nx = x + 0.5;
          ny = y + 0.5;
        }
      }
      bx = nx;
      by = ny;
    }
    let rmax = 0;
    let irisR = 0;
    const ii = H_IN + H_RIM;
    const cut = H_RI * (Math.SQRT2 - 1);
    for (const [x, y] of list) {
      for (const [qx, qy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) rmax = Math.max(rmax, Math.hypot(qx - bx, qy - by));
      // farthest visible pit point (rounded corners trimmed)
      for (const [qx, qy] of [[x + ii, y + ii], [x + 1 - ii, y + ii], [x + ii, y + 1 - ii], [x + 1 - ii, y + 1 - ii]]) {
        irisR = Math.max(irisR, Math.hypot(qx - bx, qy - by) - cut);
      }
    }
    const loops = traceLoops(list);
    const outer = new Path2D();
    const inner = new Path2D();
    const gloss = new Path2D();
    for (const lp of loops) {
      loopPath(outer, lp, H_IN, H_R, H_r);
      loopPath(inner, lp, H_IN + H_RIM, H_RI, H_rI);
      loopPath(gloss, lp, H_IN + 0.04, H_R - 0.04, H_r + 0.04);
    }
    // Falling-cat clip: pit + a column above every top cell.
    const ins = H_IN + H_RIM;
    const clipFor = (up) => {
      const p = new Path2D();
      p.addPath(inner);
      for (const [x, y] of list) {
        if (inSet(x, y - 1)) continue;
        const l = inSet(x - 1, y) && !inSet(x - 1, y - 1) ? x : x + ins;
        const r = inSet(x + 1, y) && !inSet(x + 1, y - 1) ? x + 1 : x + 1 - ins;
        p.rect(l, y - up, r - l, up + ins + H_RI + 0.02);
      }
      return p;
    };
    // Chevron anchors for axis-locked holes: ends of the run through the badge.
    const ry = Math.min(bh - 1, Math.floor(by));
    const rx = Math.min(bw - 1, Math.floor(bx));
    let x0 = rx;
    let x1 = rx;
    while (inSet(x0 - 1, ry)) x0--;
    while (inSet(x1 + 1, ry)) x1++;
    let y0 = ry;
    let y1 = ry;
    while (inSet(rx, y0 - 1)) y0--;
    while (inSet(rx, y1 + 1)) y1++;
    G = {
      key, cells: list, bw, bh, bx, by, rmax, outer, inner, gloss, clipFor, clips: new Map(),
      outerInv: inverse(outer, -2, -2, bw + 2, bh + 2),
      innerInv: inverse(inner, -2, -2, bw + 2, bh + 2),
      chevH: [x0 + ins + 0.085, x1 + 1 - ins - 0.085, by, x1 - x0 + 1],
      chevV: [y0 + ins + 0.085, y1 + 1 - ins - 0.085, bx, y1 - y0 + 1],
      rIris: irisR,
    };
    geoC.set(key, G);
    return G;
  }

  function holeSprite(G, paint) {
    return sprite(-H_PAD, -H_PAD, G.bw + H_PAD, G.bh + H_PAD, paint);
  }

  /** Fills the band of `region` that is NOT covered by `path` shifted by (dx, dy). */
  function band(g, inv, dx, dy, style) {
    g.save();
    g.translate(dx, dy);
    g.fillStyle = style;
    g.fill(inv, 'evenodd');
    g.restore();
  }

  function chevron(g, x, y, dir, vertical, size) {
    // dir: -1 points left/up, +1 right/down
    g.beginPath();
    if (!vertical) {
      g.moveTo(x - dir * size * 0.35, y - size * 0.62);
      g.lineTo(x + dir * size * 0.45, y);
      g.lineTo(x - dir * size * 0.35, y + size * 0.62);
    } else {
      g.moveTo(x - size * 0.62, y - dir * size * 0.35);
      g.lineTo(x, y + dir * size * 0.45);
      g.lineTo(x + size * 0.62, y - dir * size * 0.35);
    }
    g.stroke();
  }

  function paintHole(g, G, P, axis) {
    const L = lw;
    // contact shadow on the floor
    g.save();
    g.shadowColor = `rgba(${SHADOW_RGB},0.38)`;
    g.shadowBlur = 0.09 * S;
    g.shadowOffsetY = 0.05 * S;
    g.fillStyle = P.dark;
    g.fill(G.outer);
    g.restore();
    // rim body + bevel
    const rg = g.createLinearGradient(0, 0, 0, G.bh);
    rg.addColorStop(0, mix(P.main, P.light, 0.15));
    rg.addColorStop(1, mix(P.main, P.dark, 0.2));
    g.fillStyle = rg;
    g.fill(G.outer);
    g.save();
    g.clip(G.outer);
    band(g, G.outerInv, 0.03, 0.05, mix(P.light, P.main, 0.15));
    band(g, G.outerInv, -0.025, -0.045, P.dark);
    g.save();
    g.translate(-0.022, -0.04);
    g.fillStyle = mix(P.main, P.dark, 0.65);
    g.fill(G.inner);
    g.restore();
    g.save();
    g.translate(0.018, 0.032);
    g.fillStyle = mix(P.main, P.light, 0.55);
    g.fill(G.inner);
    g.restore();
    // gloss streak along the top
    g.save();
    g.translate(0, 0.085);
    g.clip(G.outerInv, 'evenodd');
    g.translate(0, -0.085);
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 0.032;
    g.stroke(G.gloss);
    g.restore();
    g.restore();
    // outlines
    g.lineWidth = L;
    g.strokeStyle = P.outline;
    g.stroke(G.outer);
    // pit
    const pg = g.createLinearGradient(0, 0, 0, G.bh);
    pg.addColorStop(0, mix(P.deep, '#000000', 0.18));
    pg.addColorStop(0.55, P.deep);
    pg.addColorStop(1, mix(P.deep, P.main, 0.2));
    g.fillStyle = pg;
    g.fill(G.inner);
    g.save();
    g.clip(G.inner);
    g.shadowColor = 'rgba(0,0,0,0.75)';
    g.shadowBlur = 0.11 * S;
    g.shadowOffsetY = 0.075 * S;
    g.fillStyle = '#000';
    g.fill(G.innerInv, 'evenodd');
    g.restore();
    g.lineWidth = L * 0.9;
    g.strokeStyle = P.outline;
    g.stroke(G.inner);
    if (marks) {
      // faint emblem in every pit cell (behind the badge): the shape reads around the number
      const sp = new Path2D();
      const size = G.cells.length === 1 ? 0.64 : 0.5;
      for (const [x, y] of G.cells) symbolPath(sp, PALETTE.indexOf(P), x + 0.5, y + 0.5, size);
      g.save();
      g.clip(G.inner);
      g.fillStyle = rgba(P.main, 0.42);
      g.fill(sp, 'evenodd');
      g.restore();
    }
    // axis chevrons: inside the pit at both ends of the run through the badge, or on the rim when
    // the run is a single cell (no room next to the number)
    if (axis === 'h' || axis === 'v') {
      const v = axis === 'v';
      const [a, b, o, n] = v ? G.chevV : G.chevH;
      if (n > 1) {
        g.strokeStyle = rgba(P.light, 0.9);
        g.lineWidth = 0.04;
        chevron(g, v ? o : a, v ? a : o, -1, v, 0.13);
        chevron(g, v ? o : b, v ? b : o, 1, v, 0.13);
      } else {
        const ra = a - 0.085 - H_RIM / 2 - 0.008;
        const rb = b + 0.085 + H_RIM / 2 + 0.008;
        for (const [w, style] of [[0.075, rgba(P.outline, 0.85)], [0.036, '#FFFFFF']]) {
          g.strokeStyle = style;
          g.lineWidth = w;
          chevron(g, v ? o : ra, v ? ra : o, -1, v, 0.085);
          chevron(g, v ? o : rb, v ? rb : o, 1, v, 0.085);
        }
      }
    }
  }

  function paintGlow(g, G, P) {
    g.save();
    g.shadowColor = rgba(P.main, 0.95);
    g.shadowBlur = 0.24 * S;
    g.fillStyle = P.main;
    g.fill(G.outer);
    g.fill(G.outer);
    g.shadowColor = '#FFFFFF';
    g.shadowBlur = 0.07 * S;
    g.fill(G.outer);
    g.restore();
    g.globalCompositeOperation = 'destination-out';
    g.fill(G.outer);
    g.globalCompositeOperation = 'source-over';
    g.lineWidth = 0.035;
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.stroke(G.outer);
  }

  function paintWhite(g, G) {
    g.fillStyle = '#FFFFFF';
    g.fill(G.outer);
    g.globalCompositeOperation = 'destination-out';
    g.fill(G.inner);
  }

  function paintFlash(g, G, P) {
    g.save();
    g.clip(G.inner);
    const rg = g.createRadialGradient(G.bx, G.by, 0, G.bx, G.by, Math.max(0.45, G.rIris));
    rg.addColorStop(0, rgba(P.light, 0.8));
    rg.addColorStop(0.45, rgba(P.main, 0.42));
    rg.addColorStop(1, rgba(P.main, 0));
    g.fillStyle = rg;
    g.fillRect(-1, -1, G.bw + 2, G.bh + 2);
    g.restore();
  }

  function paintLid(g, G, P) {
    g.save();
    g.clip(G.inner);
    const rg = g.createRadialGradient(G.bx - 0.12, G.by - 0.15, 0.02, G.bx, G.by, Math.max(0.6, G.rmax));
    rg.addColorStop(0, mix(P.light, '#FFFFFF', 0.25));
    rg.addColorStop(0.55, mix(P.main, P.light, 0.35));
    rg.addColorStop(1, P.main);
    g.fillStyle = rg;
    g.fillRect(-1, -1, G.bw + 2, G.bh + 2);
    // paw stamp
    g.fillStyle = rgba('#FFFFFF', 0.92);
    g.beginPath();
    const x = G.bx;
    const y = G.by + 0.04;
    ell(g, x, y + 0.03, 0.105, 0.085);
    ell(g, x - 0.115, y - 0.075, 0.042, 0.052, -0.35);
    ell(g, x - 0.042, y - 0.13, 0.042, 0.054, -0.1);
    ell(g, x + 0.042, y - 0.13, 0.042, 0.054, 0.1);
    ell(g, x + 0.115, y - 0.075, 0.042, 0.052, 0.35);
    g.fill();
    g.restore();
    g.lineWidth = lw * 0.9;
    g.strokeStyle = P.outline;
    g.stroke(G.inner);
  }

  function holeEntry(cells, c, axis) {
    const G = geom(cells);
    const key = G.key + '|' + c + '|' + (axis || '');
    let e = holeC.get(key);
    if (e) return e;
    trim();
    e = { G, c, axis, base: null, glow: null, white: null, flash: null, lid: null };
    e.base = holeSprite(G, (g) => paintHole(g, G, PALETTE[c], axis));
    holeC.set(key, e);
    return e;
  }

  function drawBadgeAt(ctx, x, y, n, c, s) {
    const sp = badgeSp(n, c);
    if (s === 1) blit(ctx, sp, x, y);
    else ctx.drawImage(sp.c, x - sp.ox * s, y - sp.oy * s, sp.w * s, sp.h * s);
  }

  function drawHole(ctx, cells, x, y, colour, o) {
    if (!o) o = EMPTY;
    const closing = o.closing > 0 ? o.closing : 0;
    if (closing >= 1 || !cells || !cells.length) return;
    const c = colour & 7;
    const P = PALETTE[c];
    const e = holeEntry(cells, c, o.axis === 'h' || o.axis === 'v' ? o.axis : null);
    const G = e.G;
    const lifted = o.lifted > 0 ? (o.lifted < 1 ? o.lifted : 1) : 0;
    const pulse = o.pulse > 0 ? (o.pulse < 1 ? o.pulse : 1) : 0;
    const bx = x + G.bx * cell;
    const by = y + G.by * cell;
    let s = 1 + 0.035 * lifted;
    let sxk = 1;
    let syk = 1;
    if (pulse) {
      const w = Math.cos((1 - pulse) * Math.PI * 2.4) * pulse;
      sxk = 1 + 0.085 * w;
      syk = 1 + 0.06 * w;
    }
    let a = 1;
    if (closing > 0.62) {
      const u = (closing - 0.62) / 0.38;
      const pop = u < 0.28 ? Math.sin((u / 0.28) * Math.PI * 0.5) : 1;
      const shrink = u < 0.28 ? 0 : (u - 0.28) / 0.72;
      s *= (1 + 0.1 * pop) * (1 - shrink * shrink * (3 - 2 * shrink) * 0.92);
      a = 1 - smooth(0.45, 1, u);
    }
    const ga = ctx.globalAlpha;
    ctx.save();
    if (s !== 1 || sxk !== 1) {
      ctx.translate(bx, by);
      ctx.scale(s * sxk, s * syk);
      ctx.translate(-bx, -by);
    }
    if (lifted > 0.01) {
      ctx.globalAlpha = ga * a * lifted;
      blit(ctx, (e.glow ||= holeSprite(G, (g) => paintGlow(g, G, P))), x, y);
    }
    ctx.globalAlpha = ga * a;
    blit(ctx, e.base, x, y);
    const wa = 0.26 * lifted + 0.45 * pulse * pulse;
    if (wa > 0.01) {
      ctx.globalAlpha = ga * a * wa;
      blit(ctx, (e.white ||= holeSprite(G, (g) => paintWhite(g, G))), x, y);
    }
    if (pulse > 0.01) {
      ctx.globalAlpha = ga * a * pulse;
      blit(ctx, (e.flash ||= holeSprite(G, (g) => paintFlash(g, G, P))), x, y);
    }
    if (closing > 0) {
      ctx.globalAlpha = ga * a;
      drawIris(ctx, e, x, y, closing);
      // sparkles once the lid is shut
      if (closing > 0.3 && closing < 0.78) {
        const u = (closing - 0.3) / 0.48;
        drawSparkle(ctx, bx + cell * 0.2, by - cell * 0.2, Math.sin(u * Math.PI) * cell * 0.62, { rot: u * 1.2 });
        const u2 = clamp01((closing - 0.38) / 0.36);
        if (u2 > 0 && u2 < 1) drawSparkle(ctx, bx - cell * 0.24, by + cell * 0.14, Math.sin(u2 * Math.PI) * cell * 0.36, { rot: -u2 });
      }
      const ba = 1 - closing / 0.12;
      if (o.need > 0 && ba > 0 && o.badge !== false) {
        ctx.globalAlpha = ga * ba;
        drawBadgeAt(ctx, bx, by, o.need, c, 1);
      }
    } else if (o.need > 0 && o.badge !== false) {
      ctx.globalAlpha = ga * a;
      const bs = 1 + 0.32 * pulse * pulse;
      drawBadgeAt(ctx, bx, by, o.need, c, bs);
    }
    ctx.restore();
    ctx.globalAlpha = ga;
  }

  function drawIris(ctx, e, x, y, closing) {
    const G = e.G;
    const P = PALETTE[e.c];
    const lid = (e.lid ||= holeSprite(G, (g) => paintLid(g, G, P)));
    const k = easeInOut(clamp01(closing / 0.36));
    const rho = (G.rIris + 0.02) * (1 - k);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(cell, cell);
    if (rho > 0.004) {
      ctx.beginPath();
      ctx.rect(-H_PAD, -H_PAD, G.bw + 2 * H_PAD, G.bh + 2 * H_PAD);
      ctx.moveTo(G.bx + rho, G.by);
      ctx.arc(G.bx, G.by, rho, 0, TAU, true);
      ctx.clip('evenodd');
    }
    ctx.drawImage(lid.c, -lid.ox / cell, -lid.oy / cell, lid.w / cell, lid.h / cell);
    if (rho > 0.004) {
      ctx.clip(G.inner);
      // shutter blades
      ctx.strokeStyle = rgba(P.outline, 0.5 * (1 - k));
      ctx.lineWidth = lw * 0.8;
      ctx.beginPath();
      const rot = k * 2.2;
      for (let i = 0; i < 6; i++) {
        const a0 = rot + (i * TAU) / 6;
        const r1 = rho + G.rmax * 1.2;
        ctx.moveTo(G.bx + rho * Math.cos(a0), G.by + rho * Math.sin(a0));
        ctx.quadraticCurveTo(
          G.bx + (rho + r1) * 0.5 * Math.cos(a0 + 0.5), G.by + (rho + r1) * 0.5 * Math.sin(a0 + 0.5),
          G.bx + r1 * Math.cos(a0 + 1.4), G.by + r1 * Math.sin(a0 + 1.4));
      }
      ctx.stroke();
      ctx.strokeStyle = P.outline;
      ctx.lineWidth = lw * 1.5;
      ctx.beginPath();
      ctx.arc(G.bx, G.by, rho, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHoleBadge(ctx, cells, x, y, colour, need, o) {
    if (!(need > 0) || !cells || !cells.length) return;
    if (!o) o = EMPTY;
    const G = geom(cells);
    const pulse = o.pulse > 0 ? Math.min(1, o.pulse) : 0;
    const s = (o.scale > 0 ? o.scale : 1) * (1 + 0.32 * pulse * pulse);
    drawBadgeAt(ctx, x + G.bx * cell, y + G.by * cell, need, colour & 7, s);
  }

  function holeCenter(cells) {
    const G = geom(cells);
    return [G.bx, G.by];
  }

  function clipHole(ctx, cells, x, y, up) {
    if (!cells || !cells.length) return;
    const G = geom(cells);
    const u = up === undefined ? 0.65 : Math.max(0, up);
    const k = Math.round(u * 100);
    let p = G.clips.get(k);
    if (!p) {
      p = G.clipFor(k / 100);
      G.clips.set(k, p);
    }
    const m = ctx.getTransform();
    ctx.translate(x, y);
    ctx.scale(cell, cell);
    ctx.clip(p);
    ctx.setTransform(m);
  }

  function drawFallingCat(ctx, cells, hx, hy, cx, cy, colour, p, o) {
    if (!o) o = EMPTY;
    const q = clamp01(p);
    if (q >= 1) return;
    let lift = 0;
    let scale = 1;
    let tint = 0;
    let rot = 0;
    let dy = 0;
    if (q < 0.22) lift = Math.sin((q / 0.22) * Math.PI) * 0.1;
    else {
      const u = (q - 0.22) / 0.78;
      scale = 1 - 0.8 * u * u;
      tint = Math.min(1, u * 1.3);
      rot = ((o.seed || 0) % 2 ? 1 : -1) * 0.8 * u;
      dy = 0.14 * u;
    }
    ctx.save();
    clipHole(ctx, cells, hx, hy);
    drawCat(ctx, cx, cy + (dy - lift) * cell, colour, {
      t: o.t || 0, seed: o.seed || 0, mood: 'surprised', scale, tint, rot, key: o.key, alpha: 1 - smooth(0.82, 1, q), shadow: false,
    });
    ctx.restore();
  }

  // ═════════════════════════════════════════ crate ═════════════════════════════════════════
  function paintCrate(g) {
    const L = lw;
    const x0 = -0.43;
    const y0 = -0.43;
    const w = 0.86;
    // side face (thickness at the bottom)
    const side = new Path2D();
    rrect(side, x0, y0 + 0.08, w, 0.86, 0.1);
    g.lineWidth = 2 * L;
    g.strokeStyle = WOOD.outline;
    g.stroke(side);
    g.fillStyle = WOOD.dark;
    g.fill(side);
    const front = new Path2D();
    rrect(front, x0, y0, w, 0.79, 0.1);
    g.stroke(front);
    const fg = g.createLinearGradient(0, y0, 0, y0 + 0.79);
    fg.addColorStop(0, WOOD.light);
    fg.addColorStop(1, WOOD.main);
    g.fillStyle = fg;
    g.fill(front);
    g.save();
    g.clip(front);
    // planks
    g.strokeStyle = rgba(WOOD.outline, 0.55);
    g.lineWidth = L * 0.8;
    g.beginPath();
    for (const yy of [y0 + 0.27, y0 + 0.53]) {
      g.moveTo(x0, yy);
      g.lineTo(x0 + w, yy);
    }
    g.stroke();
    // grain
    g.strokeStyle = rgba(WOOD.grain, 0.45);
    g.lineWidth = L * 0.55;
    g.beginPath();
    g.moveTo(x0 + 0.2, y0 + 0.13);
    g.quadraticCurveTo(x0 + 0.35, y0 + 0.1, x0 + 0.5, y0 + 0.14);
    g.moveTo(x0 + 0.45, y0 + 0.66);
    g.quadraticCurveTo(x0 + 0.58, y0 + 0.62, x0 + 0.72, y0 + 0.66);
    g.stroke();
    // border boards + diagonal brace
    const bw = 0.1;
    g.lineWidth = bw;
    g.strokeStyle = WOOD.main;
    g.beginPath();
    g.moveTo(x0 + bw * 1.1, y0 + 0.79 - bw * 1.1);
    g.lineTo(x0 + w - bw * 1.1, y0 + bw * 1.1);
    g.stroke();
    g.lineWidth = L * 0.8;
    g.strokeStyle = rgba(WOOD.outline, 0.6);
    g.beginPath();
    const dxn = 0.035;
    g.moveTo(x0 + bw * 1.1 - dxn, y0 + 0.79 - bw * 1.1 - dxn);
    g.lineTo(x0 + w - bw * 1.1 - dxn, y0 + bw * 1.1 - dxn);
    g.moveTo(x0 + bw * 1.1 + dxn, y0 + 0.79 - bw * 1.1 + dxn);
    g.lineTo(x0 + w - bw * 1.1 + dxn, y0 + bw * 1.1 + dxn);
    g.stroke();
    const border = new Path2D();
    rrect(border, x0 + bw / 2, y0 + bw / 2, w - bw, 0.79 - bw, 0.06);
    g.lineWidth = bw;
    g.strokeStyle = mix(WOOD.main, WOOD.dark, 0.35);
    g.stroke(border);
    g.lineWidth = L * 0.8;
    g.strokeStyle = rgba(WOOD.outline, 0.6);
    const bin = new Path2D();
    rrect(bin, x0 + bw, y0 + bw, w - 2 * bw, 0.79 - 2 * bw, 0.03);
    g.stroke(bin);
    // top highlight
    g.strokeStyle = 'rgba(255,240,210,0.7)';
    g.lineWidth = 0.025;
    g.beginPath();
    g.moveTo(x0 + 0.1, y0 + 0.03);
    g.lineTo(x0 + w - 0.1, y0 + 0.03);
    g.stroke();
    g.restore();
    // nails
    g.fillStyle = '#6E5A4A';
    for (const [nx, ny] of [[x0 + 0.05, y0 + 0.05], [x0 + w - 0.05, y0 + 0.05], [x0 + 0.05, y0 + 0.74], [x0 + w - 0.05, y0 + 0.74]]) {
      g.beginPath();
      ell(g, nx, ny, 0.017, 0.017);
      g.fill();
    }
  }

  function paintLock(g, open) {
    const L = lw;
    // shackle
    const sh = new Path2D();
    const lift = open ? 0.07 : 0;
    sh.moveTo(-0.068, -0.02 - lift * 0.2);
    sh.lineTo(-0.068, -0.075 - lift);
    sh.arc(0, -0.075 - lift, 0.068, Math.PI, 0);
    sh.lineTo(0.068, open ? -0.02 - lift : -0.02);
    g.lineCap = 'round';
    g.strokeStyle = STEEL.outline;
    g.lineWidth = 0.042 + 2 * L;
    g.stroke(sh);
    g.strokeStyle = STEEL.main;
    g.lineWidth = 0.042;
    g.stroke(sh);
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.lineWidth = 0.012;
    g.beginPath();
    g.arc(0, -0.075 - lift, 0.068, Math.PI * 1.1, Math.PI * 1.45);
    g.stroke();
    // body
    const body = new Path2D();
    rrect(body, -0.118, -0.04, 0.236, 0.185, 0.05);
    g.lineWidth = 2 * L;
    g.strokeStyle = GOLD.outline;
    g.stroke(body);
    const bg = g.createLinearGradient(0, -0.04, 0, 0.145);
    bg.addColorStop(0, GOLD.light);
    bg.addColorStop(0.5, GOLD.main);
    bg.addColorStop(1, GOLD.dark);
    g.fillStyle = bg;
    g.fill(body);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.beginPath();
    rrect(g, -0.09, -0.022, 0.07, 0.022, 0.011);
    g.fill();
    // keyhole
    g.fillStyle = '#5B3608';
    g.beginPath();
    ell(g, 0, 0.042, 0.026, 0.026);
    g.moveTo(-0.014, 0.05);
    g.lineTo(0.014, 0.05);
    g.lineTo(0.02, 0.105);
    g.lineTo(-0.02, 0.105);
    g.closePath();
    g.fill();
  }

  function drawCrate(ctx, x, y, o) {
    if (!o) o = EMPTY;
    const op = o.open > 0 ? o.open : 0;
    if (op >= 1) return;
    const t = o.t || 0;
    const cx = x + cell / 2;
    const cy = y + cell / 2;
    const crate = (misc.crate ||= sprite(-0.5, -0.5, 0.5, 0.5, paintCrate));
    const ga = ctx.globalAlpha;
    let s = 1;
    let a = 1;
    if (op > 0.32) {
      const u = (op - 0.32) / 0.68;
      s = 1 - 0.3 * u * u;
      a = 1 - smooth(0.1, 1, u);
    } else if (op > 0) s = 1 + 0.06 * Math.sin((op / 0.32) * Math.PI);
    ctx.globalAlpha = ga * a;
    if (s === 1) blit(ctx, crate, cx, cy);
    else ctx.drawImage(crate.c, cx - crate.ox * s, cy - crate.oy * s, crate.w * s, crate.h * s);
    // padlock
    if (op < 0.75) {
      const lockC = (misc.lock ||= sprite(-0.16, -0.2, 0.16, 0.17, (g) => paintLock(g, false)));
      const lockO = (misc.lockOpen ||= sprite(-0.16, -0.27, 0.16, 0.17, (g) => paintLock(g, true)));
      let rot = 0.05 * Math.sin(t * 2.4);
      let ly = cy + 0.0 * cell;
      let la = 1;
      let sp = lockC;
      if (op > 0 && op < 0.18) rot = Math.sin(op * 90) * 0.22 * (1 - op / 0.18);
      else if (op >= 0.18) {
        const u = (op - 0.18) / 0.57;
        sp = lockO;
        ly -= Math.sin(Math.min(1, u * 1.4) * Math.PI * 0.5) * 0.4 * cell;
        rot = u * 0.6;
        la = 1 - smooth(0.35, 1, u);
      }
      ctx.globalAlpha = ga * la;
      ctx.save();
      ctx.translate(cx, ly - 0.02 * cell);
      ctx.rotate(rot);
      blit(ctx, sp, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = ga;
  }

  // ═════════════════════════════════════════ box ═════════════════════════════════════════
  function paintBoxBack(g) {
    // inner back wall, seen between the flaps (drawn before the peeking cat)
    const p = new Path2D();
    p.moveTo(-0.355, -0.1);
    p.lineTo(-0.3, -0.255);
    p.lineTo(0.3, -0.255);
    p.lineTo(0.355, -0.1);
    p.closePath();
    g.lineWidth = 2 * lw;
    g.strokeStyle = KRAFT.outline;
    g.stroke(p);
    const bg = g.createLinearGradient(0, -0.255, 0, -0.1);
    bg.addColorStop(0, mix(KRAFT.dark, KRAFT.inside, 0.35));
    bg.addColorStop(1, KRAFT.inside);
    g.fillStyle = bg;
    g.fill(p);
  }

  function paintBox(g) {
    const L = lw;
    // front face
    const front = new Path2D();
    rrect(front, -0.375, -0.12, 0.75, 0.56, 0.07);
    g.lineWidth = 2 * L;
    g.strokeStyle = KRAFT.outline;
    g.stroke(front);
    const fg = g.createLinearGradient(0, -0.12, 0, 0.44);
    fg.addColorStop(0, KRAFT.light);
    fg.addColorStop(0.5, KRAFT.main);
    fg.addColorStop(1, KRAFT.dark);
    g.fillStyle = fg;
    g.fill(front);
    g.save();
    g.clip(front);
    // tape
    g.fillStyle = rgba(KRAFT.tape, 0.85);
    g.fillRect(-0.06, -0.12, 0.12, 0.13);
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 0.022;
    g.beginPath();
    g.moveTo(-0.33, -0.085);
    g.lineTo(0.33, -0.085);
    g.stroke();
    // side shading
    const sg = g.createLinearGradient(-0.375, 0, 0.375, 0);
    sg.addColorStop(0, 'rgba(255,255,255,0.12)');
    sg.addColorStop(0.75, 'rgba(0,0,0,0)');
    sg.addColorStop(1, rgba(KRAFT.outline, 0.22));
    g.fillStyle = sg;
    g.fillRect(-0.4, -0.15, 0.8, 0.6);
    g.restore();
    paintText(g, '?', 0, 0.165, 0.4, ['#FFFFFF', '#FFF1DC'], KRAFT.outline, 0.12, rgba(KRAFT.outline, 0.55));
  }

  function paintFlap(g) {
    // anchored at its hinge (outer top corner of the box front); lies flat toward +x when closed
    const L = lw;
    const p = new Path2D();
    p.moveTo(0, 0);
    p.lineTo(0.37, 0);
    p.lineTo(0.36, -0.13);
    p.lineTo(0.06, -0.13);
    p.closePath();
    g.lineWidth = 2 * L;
    g.strokeStyle = KRAFT.outline;
    g.stroke(p);
    const fg = g.createLinearGradient(0, -0.13, 0, 0);
    fg.addColorStop(0, mix(KRAFT.light, '#FFFFFF', 0.2));
    fg.addColorStop(1, KRAFT.main);
    g.fillStyle = fg;
    g.fill(p);
    g.strokeStyle = rgba(KRAFT.outline, 0.35);
    g.lineWidth = L * 0.7;
    g.beginPath();
    g.moveTo(0.05, -0.02);
    g.lineTo(0.34, -0.02);
    g.stroke();
  }

  function paintPeek(g) {
    // two ears of the hidden cat (neutral colour: the box hides it) poking out between the flaps
    const L = lw;
    for (const s of [-1, 1]) {
      g.save();
      g.translate(s * 0.11, -0.24);
      g.rotate(s * 0.2);
      const e = new Path2D();
      e.moveTo(-0.09, 0.03);
      e.arcTo(0, -0.29, 0.09, 0.03, 0.03);
      e.lineTo(0.09, 0.03);
      e.closePath();
      g.lineWidth = 2 * L;
      g.strokeStyle = '#3A2B4C';
      g.stroke(e);
      g.fillStyle = '#6A5782';
      g.fill(e);
      g.fillStyle = '#A48FC0';
      g.beginPath();
      g.moveTo(-0.045, 0.01);
      g.arcTo(0, -0.2, 0.045, 0.01, 0.02);
      g.lineTo(0.045, 0.01);
      g.closePath();
      g.fill();
      g.restore();
    }
  }

  function drawBox(ctx, cx, cy, o) {
    if (!o) o = EMPTY;
    const op = o.open > 0 ? o.open : 0;
    if (op >= 1) return;
    const t = o.t || 0;
    const p = catParams(o.seed || 0);
    const box = (misc.box ||= sprite(-0.44, -0.3, 0.44, 0.5, paintBox));
    const flap = (misc.flap ||= sprite(-0.04, -0.2, 0.41, 0.05, paintFlap));
    const peek = (misc.peek ||= sprite(-0.27, -0.56, 0.27, -0.1, paintPeek));
    const back = (misc.boxBack ||= sprite(-0.4, -0.3, 0.4, -0.06, paintBoxBack));
    const ga = ctx.globalAlpha;
    // idle wiggle
    let rot = 0;
    let sx = 1;
    let sy = 1;
    let jump = 0;
    let fl = 0.2 + 0.025 * Math.sin(t * 2 + p.bp); // flaps ajar
    let u = (t + p.blinkO) % p.wig;
    if (u < 0) u += p.wig;
    if (!op && u < 0.5) {
      const env = 1 - u / 0.5;
      rot = Math.sin(u * 34) * 0.075 * env;
      jump = Math.abs(Math.sin(u * 17)) * 0.03 * env;
      fl += Math.abs(Math.sin(u * 17)) * 0.2 * env;
    }
    let a = 1;
    let peekA = 1;
    if (op) {
      if (op < 0.22) {
        const s = Math.sin((op / 0.22) * Math.PI * 0.5);
        sx = 1 + 0.1 * s;
        sy = 1 - 0.12 * s;
        fl = 0.2 + 0.3 * s;
      } else {
        const v = (op - 0.22) / 0.78;
        sy = 1 + 0.12 * Math.sin(Math.min(1, v * 2.2) * Math.PI);
        sx = 1 - 0.05 * Math.sin(Math.min(1, v * 2.2) * Math.PI);
        fl = 0.5 + 1.9 * easeOutBack(Math.min(1, v * 2));
        a = 1 - smooth(0.3, 1, v);
        jump = 0.05 * Math.sin(Math.min(1, v * 2) * Math.PI);
        peekA = 1 - smooth(0, 0.35, v);
      }
    }
    // floor shadow
    const sh = shadowSp();
    ctx.globalAlpha = ga * a;
    ctx.drawImage(sh.c, cx - sh.ox * 1.3, cy + SHADOW_Y * cell - sh.oy, sh.w * 1.3, sh.h);
    ctx.save();
    ctx.translate(cx, cy + 0.44 * cell - jump * cell);
    ctx.rotate(rot);
    ctx.scale(sx, sy);
    ctx.translate(0, -0.44 * cell);
    blit(ctx, back, 0, 0);
    if (peekA > 0) {
      ctx.globalAlpha = ga * a * peekA;
      // peeking ears bob a little (and pop up when the box opens)
      const bob = (0.5 + 0.5 * Math.sin(t * 1.7 + p.tp)) * 0.03 * cell;
      blit(ctx, peek, 0, bob - (op ? 0.12 * cell * Math.min(1, op * 3) : 0));
      // glinting eyes in the gap under the flaps
      if (!isBlink(t * 0.8, p)) {
        ctx.fillStyle = '#FFF3B0';
        ctx.beginPath();
        ctx.ellipse(-0.07 * cell, -0.158 * cell, 0.028 * cell, 0.021 * cell, 0, 0, TAU);
        ctx.ellipse(0.07 * cell, -0.158 * cell, 0.028 * cell, 0.021 * cell, 0, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = ga * a;
    }
    blit(ctx, box, 0, 0);
    // flaps: left hinge at (-0.375, -0.12), right mirrored
    ctx.save();
    ctx.translate(-0.375 * cell, -0.12 * cell);
    ctx.rotate(-fl);
    blit(ctx, flap, 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(0.375 * cell, -0.12 * cell);
    ctx.scale(-1, 1);
    ctx.rotate(-fl);
    blit(ctx, flap, 0, 0);
    ctx.restore();
    ctx.restore();
    ctx.globalAlpha = ga;
  }

  // ═════════════════════════════════════════ ice ═════════════════════════════════════════
  const ICE = { x: -0.445, y: -0.47, w: 0.89, h: 0.945, r: 0.13 };

  function icePath() {
    const p = new Path2D();
    rrect(p, ICE.x, ICE.y, ICE.w, ICE.h, ICE.r);
    return p;
  }

  function paintIce(g) {
    const L = lw;
    const body = icePath();
    const fg = g.createLinearGradient(ICE.x, ICE.y, ICE.x + ICE.w, ICE.y + ICE.h);
    fg.addColorStop(0, 'rgba(244, 252, 255, 0.66)');
    fg.addColorStop(0.45, 'rgba(214, 240, 255, 0.38)');
    fg.addColorStop(1, 'rgba(170, 220, 252, 0.52)');
    g.fillStyle = fg;
    g.fill(body);
    g.save();
    g.clip(body);
    // top face
    g.fillStyle = 'rgba(255,255,255,0.42)';
    g.fillRect(ICE.x, ICE.y, ICE.w, 0.13);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 0.016;
    g.beginPath();
    g.moveTo(ICE.x + 0.04, ICE.y + 0.13);
    g.lineTo(ICE.x + ICE.w - 0.04, ICE.y + 0.13);
    g.stroke();
    // bottom face darker
    g.fillStyle = 'rgba(120, 190, 240, 0.28)';
    g.fillRect(ICE.x, ICE.y + ICE.h - 0.1, ICE.w, 0.1);
    // inner frosty rim
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = 0.05;
    const inner = new Path2D();
    rrect(inner, ICE.x + 0.02, ICE.y + 0.02, ICE.w - 0.04, ICE.h - 0.04, ICE.r - 0.02);
    g.stroke(inner);
    // highlight streaks
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 0.05;
    g.beginPath();
    g.moveTo(-0.34, -0.05);
    g.lineTo(-0.1, -0.3);
    g.stroke();
    g.lineWidth = 0.028;
    g.beginPath();
    g.moveTo(-0.33, 0.08);
    g.lineTo(-0.02, -0.24);
    g.moveTo(0.18, 0.33);
    g.lineTo(0.33, 0.18);
    g.stroke();
    // frost specks
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (const [fx, fy, fr] of [[0.33, -0.37, 0.03], [0.27, -0.4, 0.02], [0.37, -0.29, 0.018], [-0.36, 0.36, 0.028], [-0.29, 0.39, 0.018], [-0.38, 0.28, 0.016]]) {
      g.beginPath();
      ell(g, fx, fy, fr, fr);
      g.fill();
    }
    g.restore();
    g.lineWidth = L * 1.05;
    g.strokeStyle = '#5DB4E6';
    g.stroke(body);
    // sparkle glint
    g.fillStyle = '#FFFFFF';
    g.beginPath();
    g.moveTo(0.3, -0.36);
    g.quadraticCurveTo(0.305, -0.305, 0.36, -0.3);
    g.quadraticCurveTo(0.305, -0.295, 0.3, -0.24);
    g.quadraticCurveTo(0.295, -0.295, 0.24, -0.3);
    g.quadraticCurveTo(0.295, -0.305, 0.3, -0.36);
    g.fill();
  }

  const CRACK_O = [0.1, -0.1];
  function crackLines(level) {
    // deterministic jagged cracks from CRACK_O
    const lines = [];
    const branches = level === 1
      ? [[-2.5, 0.3], [0.4, 0.28], [1.6, 0.25]]
      : [[-2.5, 0.38], [-1.3, 0.3], [0.4, 0.36], [1.6, 0.4], [2.6, 0.32], [-0.5, 0.3]];
    branches.forEach(([ang, len], i) => {
      const pts = [[CRACK_O[0], CRACK_O[1]]];
      let x = CRACK_O[0];
      let y = CRACK_O[1];
      const n = 3;
      for (let j = 1; j <= n; j++) {
        const a = ang + (hash01(i * 7 + level, j) - 0.5) * 0.9;
        x += Math.cos(a) * (len / n);
        y += Math.sin(a) * (len / n);
        pts.push([x, y]);
        if (level === 2 && j === 2 && i % 2 === 0) {
          const b = ang + 0.9;
          lines.push([[x, y], [x + Math.cos(b) * 0.1, y + Math.sin(b) * 0.1]]);
        }
      }
      lines.push(pts);
    });
    return lines;
  }

  function paintCracks(g, level) {
    const body = icePath();
    g.save();
    g.clip(body);
    const lines = crackLines(level);
    const stroke = (dx, dy, style, w) => {
      g.strokeStyle = style;
      g.lineWidth = w;
      g.beginPath();
      for (const pts of lines) {
        g.moveTo(pts[0][0] + dx, pts[0][1] + dy);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] + dx, pts[i][1] + dy);
      }
      g.stroke();
    };
    stroke(0.008, 0.01, 'rgba(40, 120, 190, 0.55)', 0.018);
    stroke(0, 0, 'rgba(255,255,255,0.95)', 0.02);
    g.restore();
  }

  const SHARDS = (() => {
    const cx = 0.04;
    const cy = -0.03;
    const ring = [[-0.445, -0.47], [-0.1, -0.47], [0.2, -0.47], [0.445, -0.47], [0.445, -0.1], [0.445, 0.2], [0.445, 0.475], [0.1, 0.475], [-0.2, 0.475], [-0.445, 0.475], [-0.445, 0.12], [-0.445, -0.18]];
    const list = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const pts = [[cx, cy], a, b];
      const mx = (cx + a[0] + b[0]) / 3;
      const my = (cy + a[1] + b[1]) / 3;
      list.push({ pts, mx, my });
    }
    return list;
  })();

  function drawIce(ctx, cx, cy, left, o) {
    if (!o) o = EMPTY;
    const shatter = o.shatter > 0 ? o.shatter : 0;
    if (shatter >= 1) return;
    const crack = o.crack > 0 ? Math.min(1, o.crack) : 0;
    const ice = (misc.ice ||= sprite(-0.48, -0.5, 0.48, 0.5, paintIce));
    const ga = ctx.globalAlpha;
    if (shatter > 0) {
      const u = shatter;
      const out = 1 - (1 - u) ** 3;
      // flash
      if (u < 0.3) {
        ctx.globalAlpha = ga * (1 - u / 0.3) * 0.8;
        blit(ctx, (misc.iceWhite ||= silOf(ice, '#FFFFFF')), cx, cy);
        ctx.globalAlpha = ga;
        drawSparkle(ctx, cx, cy, cell * (0.6 + u * 2), { alpha: 1 - u / 0.3 });
      }
      ctx.globalAlpha = ga * (1 - u) ** 1.5;
      for (let i = 0; i < SHARDS.length; i++) {
        const sh = SHARDS[i];
        const d = Math.hypot(sh.mx, sh.my) || 1;
        const dist = (0.25 + 0.3 * hash01(i, 3)) * out;
        const sx = cx + (sh.mx + (sh.mx / d) * dist) * cell;
        const sy = cy + (sh.my + (sh.my / d) * dist + 0.35 * u * u) * cell;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate((i % 2 ? 1 : -1) * u * (1 + hash01(i, 5)));
        const sc = 1 - 0.35 * u;
        ctx.scale(sc, sc);
        ctx.beginPath();
        ctx.moveTo((sh.pts[0][0] - sh.mx) * cell, (sh.pts[0][1] - sh.my) * cell);
        ctx.lineTo((sh.pts[1][0] - sh.mx) * cell, (sh.pts[1][1] - sh.my) * cell);
        ctx.lineTo((sh.pts[2][0] - sh.mx) * cell, (sh.pts[2][1] - sh.my) * cell);
        ctx.closePath();
        ctx.clip();
        blit(ctx, ice, -sh.mx * cell, -sh.my * cell);
        ctx.restore();
      }
      ctx.globalAlpha = ga;
      return;
    }
    let dx = 0;
    let s = 1;
    if (crack > 0) {
      dx = Math.sin(crack * 46) * crack * 0.045 * cell;
      s = 1 + 0.05 * crack;
    }
    const x = cx + dx;
    const put = (sp) => ctx.drawImage(sp.c, x - sp.ox * s, cy - sp.oy * s, sp.w * s, sp.h * s);
    put(ice);
    const level = left === 1 ? 2 : left === 2 ? 1 : 0;
    if (level || crack > 0) {
      const lv = level || 1;
      const ck = (misc['crack' + lv] ||= sprite(-0.48, -0.5, 0.48, 0.5, (g) => paintCracks(g, lv)));
      ctx.globalAlpha = ga * (level ? 1 : crack);
      put(ck);
      ctx.globalAlpha = ga;
    }
    if (crack > 0) {
      ctx.globalAlpha = ga * crack * 0.55;
      put((misc.iceWhite ||= silOf(ice, '#FFFFFF')));
      ctx.globalAlpha = ga;
    }
    if (left > 0) {
      const ns = iceNumSp(left);
      const bs = 1 + 0.35 * crack;
      ctx.drawImage(ns.c, x - ns.ox * bs, cy + 0.2 * cell - ns.oy * bs, ns.w * bs, ns.h * bs);
    }
  }

  // ═════════════════════════════════════════ board ═════════════════════════════════════════
  function renderBoard(level, into) {
    const { w, h, ground } = level;
    const M = art.boardMargin;
    const Wc = w * cell + 2 * M;
    const Hc = h * cell + 2 * M;
    const c = into || newCanvas(1, 1);
    c.width = Math.max(1, Math.round(Wc * dpr));
    c.height = Math.max(1, Math.round(Hc * dpr));
    c.cssWidth = Wc;
    c.cssHeight = Hc;
    c.margin = M;
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(S, 0, 0, S, M * dpr, M * dpr);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : ground[y * w + x]);
    const isB = (x, y) => at(x, y) !== 0;
    const L = lw;
    // The frame also fills void gaps only one cell wide (board on both sides): the frame bands from both
    // sides would almost meet there and leave an odd sliver of background.
    const solid = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) solid[i] = ground[i] !== 0 ? 1 : 0;
    const isS = (x, y) => x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x] === 1;
    for (let pass = 0, changed = true; changed && pass < 8; pass++) {
      changed = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (solid[y * w + x]) continue;
          if ((isS(x - 1, y) && isS(x + 1, y)) || (isS(x, y - 1) && isS(x, y + 1))) {
            solid[y * w + x] = 2;
            changed = true;
          }
        }
      }
      for (let i = 0; i < w * h; i++) if (solid[i] === 2) solid[i] = 1;
    }
    const frame = regionPath(isS, w, h, FRAME_W, FLOOR_R + FRAME_W, 0.16);
    const floor = regionPath(isB, w, h, 0, FLOOR_R, 0.1);

    // drop shadow on the page
    g.save();
    g.shadowColor = 'rgba(60, 30, 120, 0.34)';
    g.shadowBlur = 0.32 * S;
    g.shadowOffsetY = 0.16 * S;
    g.translate(0, FRAME_D);
    g.fillStyle = FRAME.side2;
    g.fill(frame);
    g.restore();
    // side face
    g.save();
    g.translate(0, FRAME_D);
    g.lineWidth = 2 * L;
    g.strokeStyle = FRAME.outline;
    g.stroke(frame);
    const sg = g.createLinearGradient(0, h - 1, 0, h + FRAME_W + FRAME_D);
    sg.addColorStop(0, FRAME.side);
    sg.addColorStop(1, FRAME.side2);
    g.fillStyle = sg;
    g.fill(frame);
    g.restore();
    // top face: shaded lower lip, glossy upper lip, gradient in between. The frame is a union of
    // overlapping sub-paths, so the bands come from clipping with shifted copies (no even-odd inverse).
    g.lineWidth = 2 * L;
    g.strokeStyle = FRAME.outline;
    g.stroke(frame);
    g.save();
    g.clip(frame);
    g.fillStyle = mix(FRAME.top2, FRAME.side, 0.45);
    g.fillRect(-2, -2, w + 4, h + 4);
    g.translate(0, -0.06);
    g.clip(frame);
    g.fillStyle = '#FFF3DA';
    g.fillRect(-2, -2, w + 4, h + 4);
    g.translate(0, 0.13);
    const tg = g.createLinearGradient(0, -FRAME_W, 0, h + FRAME_W);
    tg.addColorStop(0, FRAME.top1);
    tg.addColorStop(1, FRAME.top2);
    g.fillStyle = tg;
    g.fill(frame);
    g.restore();
    // floor: lip outline, base, checker
    g.lineWidth = 2 * L;
    g.strokeStyle = FRAME.lip;
    g.stroke(floor);
    g.fillStyle = FLOOR_B;
    g.fill(floor);
    g.save();
    g.clip(floor);
    g.fillStyle = FLOOR_A;
    g.beginPath();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isB(x, y) && (x + y) % 2 === 0) g.rect(x, y, 1, 1);
    g.fill();
    // soft tile bevel
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 0.025;
    g.beginPath();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isB(x, y)) continue;
        g.moveTo(x + 0.06, y + 0.035);
        g.lineTo(x + 0.94, y + 0.035);
      }
    }
    g.stroke();
    // inner shadow cast by the frame
    g.shadowColor = 'rgba(140, 80, 30, 0.42)';
    g.shadowBlur = 0.14 * S;
    g.shadowOffsetY = 0.06 * S;
    g.fillStyle = '#000';
    g.fill(inverse(floor, -2, -2, w + 2, h + 2), 'evenodd');
    g.restore();

    // walls
    const wallCells = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (at(x, y) === 2) wallCells.push([x, y]);
    if (wallCells.length) paintWalls(g, wallCells, w, h);
    return c;
  }

  function paintWalls(g, cells, w, h) {
    const L = lw;
    const D = 0.13;
    const path = cellsPath(cells, 0.035, 0.2, 0.08);
    g.save();
    g.shadowColor = 'rgba(70, 50, 120, 0.4)';
    g.shadowBlur = 0.1 * S;
    g.shadowOffsetY = 0.05 * S;
    g.fillStyle = WALL.side2;
    g.fill(path);
    g.restore();
    g.lineWidth = 2 * L;
    g.strokeStyle = WALL.outline;
    g.stroke(path);
    const sg = g.createLinearGradient(0, 0, 0, h);
    sg.addColorStop(0, WALL.side);
    sg.addColorStop(1, WALL.side2);
    g.fillStyle = sg;
    g.fill(path);
    g.save();
    g.clip(path);
    g.translate(0, -D);
    g.lineWidth = 2 * L * 0.8;
    g.strokeStyle = rgba(WALL.outline, 0.8);
    g.stroke(path);
    const tg = g.createLinearGradient(0, 0, 0, h);
    tg.addColorStop(0, WALL.top1);
    tg.addColorStop(1, WALL.top2);
    g.fillStyle = tg;
    g.fill(path);
    // top-face gloss, then one tufted button per cell (a soft lavender cushion block)
    g.save();
    g.clip(path);
    band(g, inverse(path, -2, -2, w + 2, h + 2), 0.03, 0.05, 'rgba(255,255,255,0.75)');
    for (const [x, y] of cells) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      // puffy quadrants: light on the upper-left of each, crease toward the corners
      g.strokeStyle = rgba(WALL.outline, 0.28);
      g.lineWidth = lw * 0.8;
      g.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        g.moveTo(cx + dx * 0.06, cy + dy * 0.06);
        g.quadraticCurveTo(cx + dx * 0.15, cy + dy * 0.12, cx + dx * 0.23, cy + dy * 0.23);
      }
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.beginPath();
      ell(g, cx - 0.17, cy - 0.2, 0.08, 0.04, -0.5);
      g.fill();
      g.fillStyle = WALL.side;
      g.strokeStyle = WALL.outline;
      g.lineWidth = lw * 0.7;
      g.beginPath();
      ell(g, cx, cy, 0.055, 0.05);
      g.fill();
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.beginPath();
      ell(g, cx - 0.017, cy - 0.016, 0.017, 0.013);
      g.fill();
    }
    g.restore();
    g.restore();
  }

  // ═════════════════════════════════════════ public object ═════════════════════════════════════════
  const art = {
    PALETTE,
    cell,
    dpr,
    boardMargin: 0,
    frameWidth: 0,
    frameBottom: 0,
    ready: null,
    setMetrics({ cell: c, dpr: d } = {}) {
      const nc = c > 0 ? c : cell;
      const nd = d > 0 ? d : 1;
      if (nc === cell && nd === dpr && art.boardMargin) return; // unchanged: keep the caches
      clear();
      cell = nc;
      dpr = nd;
      S = cell * dpr;
      lw = Math.max(0.034, 1.15 / cell);
      art.cell = cell;
      art.dpr = dpr;
      art.boardMargin = Math.ceil(cell * (FRAME_W + FRAME_D + 0.42));
      art.frameWidth = cell * FRAME_W;
      art.frameBottom = cell * (FRAME_W + FRAME_D);
    },
    renderBoard,
    drawCrate,
    drawHole,
    drawHoleBadge,
    holeCenter,
    clipHole,
    drawCat,
    drawFallingCat,
    drawBox,
    drawIce,
    drawKey,
    drawSparkle,
    clear,
    /**
     * Paints sprites ahead of time (they are otherwise painted on first use, ~1 ms each), e.g. while a
     * level fades in. o: { colors = all 8, holes = [{ cells, c, axis, need }] }.
     */
    prewarm(o = EMPTY) {
      const colors = o.colors || [0, 1, 2, 3, 4, 5, 6, 7];
      for (const c of colors) {
        for (let v = 0; v < NV; v++) baseSp(c & 7, v);
        earSp(c & 7);
        tailSp(c & 7, 0);
        tailSp(c & 7, 1);
      }
      for (let big = 0; big < 2; big++) for (let st = 0; st < 4; st++) faceSp(big, st);
      shadowSp();
      keySp();
      collarSp();
      for (const h of o.holes || []) {
        holeEntry(h.cells, h.c & 7, h.axis === 'h' || h.axis === 'v' ? h.axis : null);
        if (h.need > 0) badgeSp(h.need, h.c & 7);
      }
    },
    /** Colour-blind marks: a small per-colour symbol on each cat's belly and in each pit. Off by default. */
    setMarks(on) {
      if (!!on === marks) return;
      marks = !!on;
      clear();
    },
    get marks() {
      return marks;
    },
    /** Device px currently held by the sprite caches (diagnostics). */
    get cachePixels() {
      return used;
    },
  };
  catSp = [[], [], [], [], [], []];
  art.setMetrics({ cell: 44, dpr: 1 });
  art.ready = loadFont().then((ok) => {
    if (ok) {
      // Text sprites drawn with a fallback font: drop them so they repaint with the real one.
      for (const sp of textC.values()) free(sp);
      textC = new Map();
      if (misc.box) {
        free(misc.box);
        misc.box = null;
      }
    }
    return ok;
  });
  return art;
}
