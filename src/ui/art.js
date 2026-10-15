// Meow Drop: procedural game art. Canvas 2D only (no image files, no libraries), pure drawing (no game
// logic), no DOM access at import time. Everything is painted once into per-size sprite caches (canvases at
// cell × dpr resolution) and composited with drawImage + transforms every frame.
//
// Look: chubby "mochi" cats that fill their cell, holes with a flat rim in the hole colour and a deep
// gradient pit, a small number tag on the rim's bottom-right corner, warm peach floor tiles in a thick purple
// frame.
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
//   • Draw order (each layer over the previous one): CSS background → board canvas → gates → crates →
//     trails → holes (badge: false) → falling cats, each inside ctx.save(); art.clipHole(...);
//     art.drawCat(...); ctx.restore() → standing cats in row order, top row first (a box or ice block right
//     after its cat) → hole badges (drawHoleBadge) and hungry bubbles (drawHungry) → particles.
//   • Integer cell sizes keep tile edges crisp (fractional ones work, just slightly softer).
//   • pulse (holes) and crack (ice) are intensities: 1 at the event, decaying to 0. hop / open / closing /
//     shatter / change are progress values 0 → 1.
//   • The board canvas never changes during a level: it can also live in its own <canvas> under the
//     animated one, so it is composited instead of redrawn every frame.
//
// ──────────────────────────────────────────── API ──────────────────────────────────────────────
// PALETTE[c] (c = colour id 0..11: red, orange, yellow, lime, cyan, blue, purple, pink, white, navy, brown,
//   grey) { name, main, light, dark, outline, deep }: hex strings. main = fur / rim, light = bib / highlights,
//   dark = shading, outline = line colour, deep = pit interior. Colour ids outside 0..11 wrap around.
//
// createArt() → art
//   art.setMetrics({ cell, dpr })  Sets the cell size (CSS px) and pixel ratio and drops every cached sprite
//       (no-op when both are unchanged); sprites are painted lazily on first use (~1 ms each; see prewarm).
//   art.cell, art.dpr              Current metrics.
//   art.boardMargin                CSS px the board canvas extends beyond the cell area on every side
//                                  (frame + bottom face + drop shadow). Integer.
//   art.frameWidth                 CSS px of visible frame beyond the cells (left / top / right).
//   art.frameBottom                CSS px of visible frame below the last row (frame + its bottom face).
//   art.ready                      Promise, resolves once the number font is loaded (text sprites refresh
//                                  by themselves; nothing to do).
//   art.prewarm({ colors?, holes? })   Paints sprites now instead of on first use, e.g. during a level
//       transition: colors = colour ids (default all), holes = [{ cells, c, axis, need, next }].
//   art.setMarks(on), art.marks    Colour-blind mode (off by default): a per-colour symbol on every cat's
//       belly and as a faint emblem in every cell of the matching pits.
//   art.clear()                    Drops every cached sprite (they are painted again on demand).
//   art.cachePixels                Device px held by the sprite caches (diagnostics; capped at ~20 M).
//
//   art.renderBoard(level, into?) → canvas   Static board image: purple frame, floor tiles, walls (not
//       crates, holes or cats). level = { w, h, ground: Uint8Array(w*h) } with 0 void, 1 floor, 2 wall,
//       3 locked-crate cell (floor is drawn under it). The frame is a rounded slab around the whole w × h
//       area; void cells show the purple frame material. The canvas has extra props cssWidth / cssHeight
//       (= w*cell + 2*boardMargin, h*cell + 2*boardMargin) and margin. Pass the previous canvas as `into`
//       to reuse its memory.
//
//   art.drawCrate(ctx, x, y, o)    Locked crate on the cell whose top-left is (x, y). o: { open = 0 (0..1:
//       padlock shakes, pops open and flies off; crate shrinks and fades; nothing drawn at 1), t = seconds }.
//
//   art.drawTrail(ctx, x, y, colour, alpha = 1)   Soft tinted rounded square on the cell whose top-left is
//       (x, y): what a dragged hole leaves behind for a moment. Draw under the holes.
//   art.drawGate(ctx, x, y, colour, o)   Coloured gate on the cell whose top-left is (x, y): only a hole of
//       this colour may cover it. Recessed tinted tile, barrier stripes, chunky frame with studs, paw emblem
//       (the colour's symbol when setMarks is on), a shimmer now and then. o: { t, active = 0 (0..1 while a
//       hole of that colour is over it: stripes fade, tile brightens) }. Draw after the board, before
//       crates and holes.
//
//   art.drawHole(ctx, cells, x, y, colour, o)   Hole = pit with a rim, cells merged into one outline.
//       cells = normalized [[dx,dy],...] (min 0; the same array object every frame is fastest);
//       x, y = top-left CSS px of the shape origin cell (0,0) (fractional while sliding is fine).
//       o: { need (tag number; no tag when ≤ 0),
//            next = [] (colours of the layers still to come: one outer ring each, innermost = next one),
//            change = 0, prev (0..1 right after the hole switched from colour `prev` to `colour`: the new
//                         colour sweeps out from the tag over the old one, with a little pop),
//            lifted = 0 (0..1 while dragged: coloured glow, brighter rim, 3.5% bigger),
//            axis = null | 'h' | 'v' (chevrons at both ends of the pit, on the rim for 1-cell runs),
//            closing = 0 (0..1: iris lid closes with a paw stamp, sparkles, then pops and shrinks away;
//                         nothing drawn at 1; the tag fades out in the first 12%),
//            pulse = 0 (1 right when a cat drops in, decaying to 0: jelly wobble + flash + tag pop),
//            t = seconds, badge = true (false skips the tag: draw it later with drawHoleBadge, after the
//            cats, so nothing ever covers the number) }.
//   art.drawHoleBadge(ctx, cells, x, y, colour, need, o?)   Only the number tag: a rounded tag in the rim
//       colour on the bottom-right corner of the shape's last cell (max dx + dy, ties → max dx), white
//       number with a dark outline. o: { pulse, change (pops), scale, alpha }.
//   art.badgeAt(cells, need?) → [x, y]   Tag centre in cells relative to the shape origin.
//   art.holeCenter(cells) → [cx, cy]   Visual centre in cells relative to the origin (centre of mass,
//       snapped to the nearest cell centre when it falls outside the shape): aim particles / treats there.
//   art.clipHole(ctx, cells, x, y, up = 0.65)   Intersects the clip with the pit interior plus the area
//       straight above it (up = cells), so a falling cat sinks behind the near (lower) rim while its head
//       may still stick out above the pit. Leaves the transform unchanged; wrap in ctx.save()/restore().
//
//   art.drawCat(ctx, cx, cy, colour, o)   cx, cy = cell centre. o: {
//       t = seconds (blink every 2–6 s, breathing, a mochi wobble now and then), seed = int (timing, eye size),
//       mood = 'idle' | 'happy' (^ ^ eyes, open smile, little bounces) | 'surprised' (wide eyes, O mouth)
//              | 'hungry' (pleading eyes, worried brows, open mouth with drool, impatient sway)
//              | 'angry' (narrowed eyes, angry brows, frown, anger mark, trembling),
//       blink = false (force closed eyes), hop = 0 (0..1 jump with squash & stretch; an idle cat looks happy
//       while hopping), scale = 1, alpha = 1, rot = 0 (radians, about the cell centre),
//       tint = 0 (0..1 darkens toward the colour's deep pit shade; the floor shadow fades with it),
//       key = false (navy collar with a golden key charm), size = cell (draw as if the cell were this big),
//       shadow = true (soft floor shadow) }.
//     Each colour has its own little personality (purple: Siamese mask, white: fluffy with pale-blue
//     shading, navy: odd eyes and a light muzzle, grey: tuxedo, brown: ear patch, yellow / orange / blue:
//     tabby stripes, …).
//   art.drawHungry(ctx, cx, cy, left, o?)   Speech bubble at the top-right of the cat in cell (cx, cy) with a
//       fish and the moves left. o: { t, urgent = left ≤ 2 (red, pulsing), scale, size, alpha }. Draw after
//       all cats (with the hole badges), so neighbours never cover it.
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
// Performance (tools/art-preview.mjs): a cat is 3 drawImage calls (shadow, body, face), +2 with a key;
// a hole is 1 plus its tag (+1–3 while lifted / pulsing / closing / changing colour). Nothing is stroked
// per frame except the closing iris.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const EMPTY = Object.freeze({});

/** Colour ids 0..11. Shades: light (bib, gloss), dark (shading), outline (lines), deep (pit interior). */
export const PALETTE = Object.freeze([
  Object.freeze({ name: 'red', main: '#FF5466', light: '#FFD3CF', dark: '#DE3549', outline: '#8F1B30', deep: '#4E0C1A' }),
  Object.freeze({ name: 'orange', main: '#FF9933', light: '#FFE0B8', dark: '#EA7418', outline: '#984708', deep: '#4F2006' }),
  Object.freeze({ name: 'yellow', main: '#FFD43A', light: '#FFF5BE', dark: '#F0AC14', outline: '#916309', deep: '#4E3505' }),
  Object.freeze({ name: 'lime', main: '#86D62A', light: '#E7F8B4', dark: '#62B312', outline: '#2E6A0A', deep: '#183A06' }),
  Object.freeze({ name: 'cyan', main: '#36CBEA', light: '#D2F5FC', dark: '#17A2CB', outline: '#0A5E80', deep: '#06364C' }),
  Object.freeze({ name: 'blue', main: '#3F86F2', light: '#C6DDFF', dark: '#2A67CF', outline: '#153C88', deep: '#0C1F4A' }),
  Object.freeze({ name: 'purple', main: '#B377F5', light: '#EBD6FF', dark: '#9055DA', outline: '#4F2592', deep: '#2C1054' }),
  Object.freeze({ name: 'pink', main: '#FF6EC1', light: '#FFD0EA', dark: '#E8499F', outline: '#981C66', deep: '#520C36' }),
  Object.freeze({ name: 'white', main: '#FBFAFF', light: '#FFFFFF', dark: '#C8D5F2', outline: '#6A69A0', deep: '#394458' }),
  Object.freeze({ name: 'navy', main: '#4B47C4', light: '#A9A6F6', dark: '#36329F', outline: '#1B1757', deep: '#110F38' }),
  Object.freeze({ name: 'brown', main: '#C27B41', light: '#F7DFBF', dark: '#9F5D2A', outline: '#55300F', deep: '#2F1708' }),
  Object.freeze({ name: 'grey', main: '#737A8D', light: '#EEF1F6', dark: '#585E70', outline: '#2A2D3A', deep: '#1B1D25' }),
]);
const NC = PALETTE.length;
const col = (c) => ((((c | 0) % NC) + NC) % NC);

/**
 * Per-colour personality. bib: light front patch ('heart' | 'drop' | 'round' | 'muzzle' | 'tux' | 'none');
 * eyes: 0 dark, 1 blue, 2 pale (on a mask), 3 odd (gold + blue); ear: inner-ear colour.
 */
const LOOKS = [
  { bib: 'heart', eyes: 0 }, // red
  { bib: 'heart', eyes: 0, stripes: '#E06A10' }, // orange tabby
  { bib: 'round', eyes: 0, stripes: '#F09A1E' }, // yellow tabby
  { bib: 'heart', eyes: 0 }, // lime
  { bib: 'drop', eyes: 0, freckles: true }, // cyan
  { bib: 'drop', eyes: 0, stripes: '#2457B8' }, // blue tabby
  { bib: 'none', eyes: 2, mask: true }, // purple Siamese
  { bib: 'heart', eyes: 0, sheen: true }, // pink
  { bib: 'none', eyes: 1, fluffy: true, shade: '#CDDBF6' }, // white fluff
  { bib: 'muzzle', eyes: 3, ear: '#FFCF57' }, // navy, odd eyes
  { bib: 'heart', eyes: 0, patch: true }, // brown
  { bib: 'tux', eyes: 0, socks: true }, // grey tuxedo
];

// ───────── shared constants (cell units unless noted) ─────────
const INK = '#2E2340'; // face lines
const BLUSH = 'rgba(255, 105, 145, 0.42)';
const NOSE = '#FF7FA6';
const NOSE_LINE = '#C9476F';
const EAR_PINK = '#FF9FC2';
const GOLD = { light: '#FFF2A8', main: '#FFC93C', dark: '#E39612', outline: '#8A5406' };
const COLLAR = { main: '#3F3270', light: '#7E6BB8', outline: '#1E1636' }; // neutral: never competes with fur colours
const KRAFT = { light: '#F6CD94', main: '#E3A762', dark: '#C4833F', outline: '#7A461C', inside: '#5A3316', tape: '#F2D9A8' };
const WOOD = { light: '#EDBB7C', main: '#D39556', dark: '#AE6E35', outline: '#6A3D16', grain: '#B97A3F' };
const STEEL = { main: '#A9B4CC', dark: '#6E7894', outline: '#454D66' };
const FRAME = { top1: '#AC86F5', top2: '#8D5CE5', hi: '#D2BCFF', side1: '#6A3CC2', side2: '#50289D', outline: '#2F1468', inner: '#3D1B85', void: '#7C4BD6' };
const FLOOR = { a: '#F6D9C0', b: '#EFCDB1', grid: '#FBE9DA' };
const WALL = { top1: '#EDE3FF', top2: '#D2BFF8', side: '#A486E2', side2: '#8667CE', outline: '#45278E' };
const TAG_INK = '#2C2347'; // outline of the white tag numbers
const SHADOW_RGB = '74, 40, 110';

const FONT_NAME = 'MeowDropNum';
const FONT_STACK = `${FONT_NAME}, Nunito, "Arial Rounded MT Bold", ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
const FONT_URL = '../../fonts/nunito-latin-900-normal.woff2';

// Cat layout (origin = cell centre).
const FOOT = 0.46;
const SHADOW_Y = 0.455;
const KEY_Y = 0.045; // key ring hangs from the collar here
const HOP_H = 0.34;

// Hole geometry.
const H_IN = 0.035; // gap between the cell edge and the rim
const H_RIM = 0.1; // rim width
const H_R = 0.22; // outer convex corner radius
const H_r = 0.08; // outer concave corner radius
const H_RI = 0.12; // pit convex radius
const H_rI = 0.18; // pit concave radius
const H_PAD = 0.34; // sprite padding (rings / shadow / glow)
const RING = 0.055; // width of one "next layer" ring
const MAX_RINGS = 3;
const TAG_H = 0.36;
const TAG_W = [0.32, 0.42, 0.52];

// Board.
const FRAME_W = 0.32;
const FRAME_D = 0.16;
const FRAME_R = 0.4;

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

/** Paw print (one pad + four toes) centred at (x, y), about s across. */
function pawPath(p, x, y, s) {
  const k = s / 0.34;
  ell(p, x, y + 0.07 * k, 0.105 * k, 0.085 * k);
  ell(p, x - 0.115 * k, y - 0.035 * k, 0.042 * k, 0.052 * k, -0.35);
  ell(p, x - 0.042 * k, y - 0.09 * k, 0.042 * k, 0.054 * k, -0.1);
  ell(p, x + 0.042 * k, y - 0.09 * k, 0.042 * k, 0.054 * k, 0.1);
  ell(p, x + 0.115 * k, y - 0.035 * k, 0.042 * k, 0.052 * k, 0.35);
}

/** Path2D of everything except `path` (inside a big rect); fill / clip with 'evenodd'. */
function inverse(path, x0, y0, x1, y1) {
  const p = new Path2D();
  p.rect(x0, y0, x1 - x0, y1 - y0);
  p.addPath(path);
  return p;
}

/**
 * Colour-blind marks: one simple symbol per colour id (heart, triangle, star, plus, drop, diamond, moon, dot,
 * ring, square, hexagon, cross), centred at (x, y), about s across. Adds a fillable sub-path to p (fill with
 * 'evenodd': the moon and the ring are cut-outs).
 */
function symbolPath(p, k, x, y, s) {
  const r = s / 2;
  switch (col(k)) {
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
    case 7: // dot
      p.moveTo(x + r * 0.8, y);
      p.arc(x, y, r * 0.8, 0, TAU);
      break;
    case 8: // ring
      p.moveTo(x + r * 0.95, y);
      p.arc(x, y, r * 0.95, 0, TAU);
      p.moveTo(x + r * 0.5, y);
      p.arc(x, y, r * 0.5, 0, TAU);
      break;
    case 9: // square
      p.moveTo(x - r * 0.75, y - r * 0.75);
      p.lineTo(x + r * 0.75, y - r * 0.75);
      p.lineTo(x + r * 0.75, y + r * 0.75);
      p.lineTo(x - r * 0.75, y + r * 0.75);
      break;
    case 10: // hexagon
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        if (i) p.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
        else p.moveTo(x + r, y);
      }
      break;
    default: { // cross
      const a = r * 0.3;
      const b = r * 0.95;
      const q = Math.SQRT1_2;
      const pts = [[-a, -b], [a, -b], [a, -a], [b, -a], [b, a], [a, a], [a, b], [-a, b], [-a, a], [-b, a], [-b, -a], [-a, -a]];
      pts.forEach(([px, py], i) => {
        const rx = x + (px - py) * q;
        const ry = y + (px + py) * q;
        if (i) p.lineTo(rx, ry);
        else p.moveTo(rx, ry);
      });
    }
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

// ───────── per-cat timing (and eye size) from its seed ─────────
const paramCache = new Map();
function catParams(seed) {
  let p = paramCache.get(seed);
  if (p) return p;
  const s = Number.isInteger(seed) ? seed | 0 : Math.floor((seed || 0) * 1e6) | 0;
  const r = (k) => hash01(s, k);
  p = {
    big: r(2) < 0.45 ? 1 : 0,
    blinkP: 2.2 + r(7) * 3.8,
    blinkO: r(8) * 7,
    dbl: r(9) < 0.3,
    bw: TAU / (2.3 + r(10) * 1.1),
    bp: r(11) * TAU,
    kp: r(18) * TAU,
    wig: 4.5 + r(19) * 5, // mochi wobble period (s)
    wigO: r(20) * 9,
    hp: r(21) * TAU, // happy bounce phase
    tp: r(13) * TAU,
  };
  if (paramCache.size > 4000) paramCache.clear();
  paramCache.set(seed, p);
  return p;
}

const FACE_OPEN = 0;
const FACE_CLOSED = 1;
const FACE_HAPPY = 2;
const FACE_SURPRISED = 3;
const FACE_HUNGRY = 4;
const FACE_ANGRY = 5;
const FACE_STATES = 6;

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

  /** Width (cells) of the number tag for n. */
  function tagW(n) {
    return TAG_W[Math.min(3, String(n).length) - 1];
  }

  /** Cached number tag for a hole of colour c: a rim-coloured rounded tag, white number with a dark outline. */
  function badgeSp(n, c) {
    const key = 'b' + n + '|' + c;
    let sp = textC.get(key);
    if (sp) return sp;
    const str = String(n);
    const tw = tagW(n);
    const P = PALETTE[c];
    trim(); // before creating: never evicts the sprite we are about to return
    sp = sprite(-tw / 2 - 0.05, -TAG_H / 2 - 0.05, tw / 2 + 0.05, TAG_H / 2 + 0.07, (g) => {
      const p = new Path2D();
      rrect(p, -tw / 2, -TAG_H / 2, tw, TAG_H, 0.1);
      g.lineWidth = 2 * lw * 1.05;
      g.strokeStyle = P.outline;
      g.stroke(p);
      const tg = g.createLinearGradient(0, -TAG_H / 2, 0, TAG_H / 2);
      tg.addColorStop(0, mix(P.main, P.light, 0.4));
      tg.addColorStop(1, P.main);
      g.fillStyle = tg;
      g.fill(p);
      paintText(g, str, 0, 0.004, str.length >= 3 ? 0.22 : 0.27, '#FFFFFF', TAG_INK, 0.17, null);
    });
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
  // Mochi cats: one chubby loaf silhouette with the ears built in, filling ~90% of the cell. A body sprite
  // per colour (fur, bib, markings, legs, whiskers) and face sprites per eye style / eye size / state.

  /** Smooth closed outline through the midpoints of a control polygon (rounded, B-spline-like). */
  function smoothPath(p, pts) {
    const n = pts.length;
    const mx = (i) => (pts[i % n][0] + pts[(i + 1) % n][0]) / 2;
    const my = (i) => (pts[i % n][1] + pts[(i + 1) % n][1]) / 2;
    p.moveTo(mx(n - 1), my(n - 1));
    for (let i = 0; i < n; i++) p.quadraticCurveTo(pts[i][0], pts[i][1], mx(i), my(i));
    p.closePath();
  }

  // Right half of the loaf, clockwise from the top centre (the left half is mirrored).
  const LOAF = [
    [0, -0.372], [0.106, -0.37], [0.176, -0.382], [0.273, -0.462], [0.326, -0.497], [0.352, -0.44], [0.363, -0.3],
    [0.373, -0.17], [0.396, -0.085], [0.377, -0.045], [0.385, 0.1], [0.391, 0.27], [0.382, 0.405],
    [0.326, 0.465], [0.176, 0.47],
  ];
  const LOAF_FLUFFY = [
    [0, -0.372], [0.106, -0.37], [0.176, -0.382], [0.273, -0.462], [0.326, -0.497], [0.352, -0.44], [0.363, -0.3],
    [0.368, -0.215], [0.4, -0.17], [0.375, -0.13], [0.405, -0.08], [0.378, -0.04], [0.4, 0.01], [0.382, 0.06],
    [0.391, 0.27], [0.382, 0.405], [0.326, 0.465], [0.176, 0.47],
  ];
  function loafPath(fluffy) {
    const right = fluffy ? LOAF_FLUFFY : LOAF;
    const left = right.slice(1).reverse().map(([x, y]) => [-x, y]);
    const p = new Path2D();
    smoothPath(p, [...right, [0, 0.47], ...left]);
    return p;
  }

  function bibPath(kind) {
    const p = new Path2D();
    if (kind === 'heart' || kind === 'tux') {
      p.moveTo(0, -0.02);
      p.bezierCurveTo(-0.063, -0.125, -0.236, -0.105, -0.223, 0.045);
      p.bezierCurveTo(-0.212, 0.175, -0.077, 0.255, 0, 0.355);
      p.bezierCurveTo(0.077, 0.255, 0.212, 0.175, 0.223, 0.045);
      p.bezierCurveTo(0.236, -0.105, 0.063, -0.125, 0, -0.02);
      p.closePath();
    } else if (kind === 'drop') {
      p.moveTo(0, -0.085);
      p.bezierCurveTo(0.099, -0.01, 0.194, 0.12, 0.153, 0.245);
      p.quadraticCurveTo(0.09, 0.345, 0, 0.35);
      p.quadraticCurveTo(-0.09, 0.345, -0.153, 0.245);
      p.bezierCurveTo(-0.194, 0.12, -0.099, -0.01, 0, -0.085);
      p.closePath();
    } else if (kind === 'round') {
      ell(p, 0, 0.12, 0.212, 0.235);
      ell(p, 0, -0.04, 0.117, 0.08);
    } else if (kind === 'muzzle') {
      ell(p, 0, -0.045, 0.113, 0.07);
    }
    return p;
  }

  function paintBody(g, c) {
    const P = PALETTE[c];
    const look = LOOKS[c];
    const L = lw;
    const body = loafPath(look.fluffy);
    g.lineWidth = 2 * L;
    g.strokeStyle = P.outline;
    g.stroke(body);
    const fg = g.createLinearGradient(0, -0.5, 0, 0.47);
    fg.addColorStop(0, mix(P.main, P.light, 0.2));
    fg.addColorStop(0.5, P.main);
    fg.addColorStop(1, mix(P.main, P.dark, 0.3));
    g.fillStyle = fg;
    g.fill(body);
    g.save();
    g.clip(body);
    // inner ears
    g.fillStyle = look.ear || EAR_PINK;
    g.strokeStyle = look.ear || EAR_PINK;
    g.lineWidth = 0.03;
    g.beginPath();
    for (const s of [-1, 1]) {
      g.moveTo(s * 0.207, -0.372);
      g.lineTo(s * 0.31, -0.447);
      g.lineTo(s * 0.339, -0.318);
      g.closePath();
    }
    g.fill();
    g.stroke();
    // markings under the bib
    if (look.patch) {
      g.fillStyle = mix(P.dark, P.outline, 0.3);
      g.beginPath();
      ell(g, -0.23, -0.31, 0.2, 0.17, 0.35);
      g.fill();
    }
    if (look.sheen) {
      g.fillStyle = rgba(P.light, 0.4);
      g.beginPath();
      ell(g, -0.215, -0.08, 0.075, 0.2, 0.35);
      g.fill();
    }
    if (look.stripes) {
      g.strokeStyle = look.stripes;
      g.lineWidth = 0.034;
      g.beginPath();
      g.moveTo(0, -0.372);
      g.lineTo(0, -0.285);
      g.moveTo(-0.075, -0.366);
      g.lineTo(-0.062, -0.3);
      g.moveTo(0.075, -0.366);
      g.lineTo(0.062, -0.3);
      g.stroke();
    }
    if (look.mask) {
      g.fillStyle = mix(P.dark, P.outline, 0.5);
      g.beginPath();
      rrect(g, -0.262, -0.218, 0.524, 0.15, 0.075);
      g.fill();
    }
    // bib
    if (look.bib !== 'none') {
      g.fillStyle = look.bib === 'tux' ? '#F7F8FC' : P.light;
      g.fill(bibPath(look.bib));
      if (look.bib === 'tux') {
        g.fillStyle = P.light;
        g.fill(bibPath('muzzle'));
      }
    }
    if (look.freckles) {
      g.fillStyle = rgba(P.dark, 0.7);
      for (const [fx, fy] of [[-0.27, -0.015], [-0.3, 0.03], [-0.245, 0.04], [0.27, -0.015], [0.3, 0.03], [0.245, 0.04]]) {
        g.beginPath();
        ell(g, fx, fy, 0.012, 0.012);
        g.fill();
      }
    }
    // lower-body shade (pale blue on the white cat)
    const sh = g.createLinearGradient(0, look.shade ? 0.12 : 0.23, 0, 0.42);
    const shade = look.shade || P.dark;
    sh.addColorStop(0, rgba(shade, 0));
    sh.addColorStop(1, rgba(shade, look.shade ? 0.95 : 0.6));
    g.fillStyle = sh;
    g.fillRect(-0.5, 0.1, 1, 0.4);
    if (look.socks) {
      g.fillStyle = '#F7F8FC';
      g.beginPath();
      ell(g, -0.075, 0.43, 0.075, 0.055);
      ell(g, 0.075, 0.43, 0.075, 0.055);
      g.fill();
    }
    // legs: front paws meeting at the bottom centre, hind legs at the sides
    g.strokeStyle = P.outline;
    g.lineWidth = L * 0.9;
    g.beginPath();
    g.moveTo(-0.13, 0.3);
    g.quadraticCurveTo(-0.1, 0.41, -0.032, 0.462);
    g.moveTo(0.13, 0.3);
    g.quadraticCurveTo(0.1, 0.41, 0.032, 0.462);
    g.moveTo(-0.034, 0.46);
    g.lineTo(0, 0.432);
    g.lineTo(0.034, 0.46);
    g.moveTo(-0.28, 0.285);
    g.quadraticCurveTo(-0.265, 0.395, -0.205, 0.46);
    g.moveTo(0.28, 0.285);
    g.quadraticCurveTo(0.265, 0.395, 0.205, 0.46);
    g.stroke();
    if (marks) {
      const sp = new Path2D();
      symbolPath(sp, c, 0, 0.2, 0.15);
      g.fillStyle = c === 8 ? rgba(P.outline, 0.6) : look.bib === 'none' || look.bib === 'muzzle' ? rgba(P.light, 0.95) : P.dark;
      g.fill(sp, 'evenodd');
    }
    g.restore();
    // whiskers poke out a little
    g.strokeStyle = rgba(P.outline, 0.75);
    g.lineWidth = L * 0.65;
    g.beginPath();
    for (const s of [-1, 1]) {
      g.moveTo(s * 0.28, -0.085);
      g.lineTo(s * 0.43, -0.11);
      g.moveTo(s * 0.28, -0.05);
      g.lineTo(s * 0.432, -0.045);
    }
    g.stroke();
    // soft gloss
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.beginPath();
    ell(g, -0.22, -0.27, 0.055, 0.026, -0.55);
    g.fill();
  }

  const EYES = [
    { l: '#2A1F3D', r: '#2A1F3D', line: INK },
    { l: '#2C3B92', r: '#2C3B92', line: '#3B3F7A' },
    { l: '#C8F4FF', r: '#C8F4FF', line: '#E4DAFF', pupil: '#3C6FA8' },
    { l: '#FFD54A', r: '#7AD6FF', line: '#E8E2FF', pupil: '#221A3A' },
  ];

  function paintFace(g, style, big, state) {
    const L = lw;
    const E = EYES[style];
    const ex = 0.128;
    const ey = -0.13;
    const rx = big ? 0.054 : 0.048;
    const ry = big ? 0.064 : 0.057;
    g.fillStyle = BLUSH;
    g.beginPath();
    ell(g, -0.228, -0.05, 0.045, 0.026);
    ell(g, 0.228, -0.05, 0.045, 0.026);
    g.fill();
    for (const s of [-1, 1]) {
      const x = s * ex;
      if (state === FACE_OPEN) {
        g.fillStyle = s < 0 ? E.l : E.r;
        g.beginPath();
        ell(g, x, ey, rx, ry);
        g.fill();
        if (E.pupil) {
          g.fillStyle = E.pupil;
          g.beginPath();
          ell(g, x, ey + ry * 0.12, rx * 0.42, ry * 0.62);
          g.fill();
        }
        g.fillStyle = '#FFFFFF';
        g.beginPath();
        ell(g, x - rx * 0.3, ey - ry * 0.35, rx * 0.4, rx * 0.4);
        g.fill();
        g.beginPath();
        ell(g, x + rx * 0.38, ey + ry * 0.4, rx * 0.17, rx * 0.17);
        g.fill();
      } else if (state === FACE_CLOSED) {
        g.strokeStyle = E.line;
        g.lineWidth = L * 1.2;
        g.beginPath();
        g.moveTo(x - rx * 1.05, ey + 0.004);
        g.quadraticCurveTo(x, ey + 0.05, x + rx * 1.05, ey + 0.004);
        g.stroke();
      } else if (state === FACE_HAPPY) {
        g.strokeStyle = E.line;
        g.lineWidth = L * 1.35;
        g.beginPath();
        g.moveTo(x - rx * 1.0, ey + 0.025);
        g.quadraticCurveTo(x, ey - 0.06, x + rx * 1.0, ey + 0.025);
        g.stroke();
      } else if (state === FACE_HUNGRY) {
        // big pleading eyes, extra sparkles, worried brows (inner ends up)
        const r1 = rx * 1.2;
        const r2 = ry * 1.14;
        g.fillStyle = s < 0 ? E.l : E.r;
        g.beginPath();
        ell(g, x, ey + 0.004, r1, r2);
        g.fill();
        if (E.pupil) {
          g.fillStyle = E.pupil;
          g.beginPath();
          ell(g, x, ey + r2 * 0.15, r1 * 0.45, r2 * 0.6);
          g.fill();
        }
        g.fillStyle = '#FFFFFF';
        g.beginPath();
        ell(g, x - r1 * 0.26, ey - r2 * 0.3, r1 * 0.48, r1 * 0.48);
        ell(g, x + r1 * 0.34, ey + r2 * 0.34, r1 * 0.25, r1 * 0.25);
        ell(g, x - r1 * 0.48, ey + r2 * 0.46, r1 * 0.12, r1 * 0.12);
        g.fill();
        g.strokeStyle = E.line;
        g.lineWidth = L * 0.95;
        g.beginPath();
        g.moveTo(x + s * 0.055, ey - 0.083);
        g.lineTo(x - s * 0.045, ey - 0.108);
        g.stroke();
      } else if (state === FACE_ANGRY) {
        // narrowed eyes under angry brows (inner ends down)
        const d = -s; // toward the face centre
        g.save();
        g.beginPath();
        g.moveTo(x - d * rx * 1.5, ey - ry * 0.55);
        g.lineTo(x + d * rx * 1.5, ey + ry * 0.05);
        g.lineTo(x + d * rx * 1.5, ey + ry * 2);
        g.lineTo(x - d * rx * 1.5, ey + ry * 2);
        g.closePath();
        g.clip();
        g.fillStyle = s < 0 ? E.l : E.r;
        g.beginPath();
        ell(g, x, ey + 0.006, rx, ry * 0.9);
        g.fill();
        g.fillStyle = '#FFFFFF';
        g.beginPath();
        ell(g, x + d * rx * 0.2, ey + ry * 0.25, rx * 0.28, rx * 0.28);
        g.fill();
        g.restore();
        g.strokeStyle = E.line;
        g.lineWidth = L * 1.1;
        g.beginPath();
        g.moveTo(x - d * rx * 1.25, ey - ry * 0.5);
        g.lineTo(x + d * rx * 1.25, ey + ry * 0.02);
        g.moveTo(x - d * 0.062, ey - 0.098);
        g.lineTo(x + d * 0.052, ey - 0.062);
        g.stroke();
      } else {
        const r = ry * 1.05;
        g.fillStyle = '#FFFFFF';
        g.strokeStyle = INK;
        g.lineWidth = L * 0.85;
        g.beginPath();
        ell(g, x, ey, r * 0.9, r);
        g.fill();
        g.stroke();
        g.fillStyle = '#24182F';
        g.beginPath();
        ell(g, x, ey + 0.004, r * 0.46, r * 0.52);
        g.fill();
        g.fillStyle = '#FFFFFF';
        g.beginPath();
        ell(g, x - r * 0.16, ey - r * 0.2, r * 0.16, r * 0.16);
        g.fill();
      }
    }
    // nose
    g.fillStyle = NOSE;
    g.strokeStyle = NOSE_LINE;
    g.lineWidth = L * 0.5;
    g.beginPath();
    g.moveTo(-0.024, -0.075);
    g.quadraticCurveTo(0, -0.081, 0.024, -0.075);
    g.quadraticCurveTo(0.01, -0.052, 0, -0.051);
    g.quadraticCurveTo(-0.01, -0.052, -0.024, -0.075);
    g.closePath();
    g.fill();
    g.stroke();
    // mouth
    g.strokeStyle = INK;
    g.lineWidth = L * 0.8;
    if (state === FACE_HAPPY) {
      g.fillStyle = '#7A2342';
      g.beginPath();
      g.moveTo(-0.045, -0.04);
      g.quadraticCurveTo(0, -0.03, 0.045, -0.04);
      g.quadraticCurveTo(0.04, 0.018, 0, 0.02);
      g.quadraticCurveTo(-0.04, 0.018, -0.045, -0.04);
      g.closePath();
      g.fill();
      g.save();
      g.clip();
      g.fillStyle = '#FF8DAA';
      g.beginPath();
      ell(g, 0, 0.016, 0.028, 0.02);
      g.fill();
      g.restore();
      g.stroke();
    } else if (state === FACE_SURPRISED) {
      g.fillStyle = '#7A2342';
      g.beginPath();
      ell(g, 0, -0.012, 0.022, 0.028);
      g.fill();
      g.stroke();
    } else if (state === FACE_HUNGRY) {
      // open mouth, tongue, a drop of drool
      g.fillStyle = '#7A2342';
      g.beginPath();
      ell(g, 0, -0.016, 0.034, 0.03);
      g.fill();
      g.save();
      g.clip();
      g.fillStyle = '#FF8DAA';
      g.beginPath();
      ell(g, 0, 0.004, 0.026, 0.017);
      g.fill();
      g.restore();
      g.stroke();
      g.fillStyle = '#C9F0FF';
      g.strokeStyle = '#4E9FD2';
      g.lineWidth = L * 0.5;
      g.beginPath();
      g.moveTo(0.03, -0.004);
      g.quadraticCurveTo(0.05, 0.03, 0.033, 0.045);
      g.quadraticCurveTo(0.014, 0.034, 0.03, -0.004);
      g.closePath();
      g.fill();
      g.stroke();
    } else if (state === FACE_ANGRY) {
      g.lineWidth = L * 0.95;
      g.beginPath();
      g.moveTo(-0.042, -0.018);
      g.quadraticCurveTo(0, -0.05, 0.042, -0.018);
      g.stroke();
      // anger mark
      g.strokeStyle = '#FF3B55';
      g.lineWidth = L * 1.1;
      g.beginPath();
      const ax = 0.215;
      const ay = -0.285;
      for (const [qx, qy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        g.moveTo(ax + qx * 0.012, ay + qy * 0.048);
        g.quadraticCurveTo(ax + qx * 0.012, ay + qy * 0.012, ax + qx * 0.048, ay + qy * 0.012);
      }
      g.stroke();
    } else {
      g.beginPath();
      g.moveTo(0, -0.052);
      g.lineTo(0, -0.04);
      g.moveTo(-0.045, -0.044);
      g.quadraticCurveTo(-0.022, -0.016, 0, -0.04);
      g.quadraticCurveTo(0.022, -0.016, 0.045, -0.044);
      g.stroke();
    }
  }

  function paintCollar(g) {
    const band = new Path2D();
    band.moveTo(-0.24, -0.008);
    band.quadraticCurveTo(0, 0.085, 0.24, -0.008);
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
    g.moveTo(-0.18, 0.006);
    g.quadraticCurveTo(-0.1, 0.035, -0.03, 0.04);
    g.stroke();
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
    g.scale(1, 0.2);
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, 0.4);
    rg.addColorStop(0, `rgba(${SHADOW_RGB},0.3)`);
    rg.addColorStop(0.65, `rgba(${SHADOW_RGB},0.2)`);
    rg.addColorStop(1, `rgba(${SHADOW_RGB},0)`);
    g.fillStyle = rg;
    g.beginPath();
    g.arc(0, 0, 0.4, 0, TAU);
    g.fill();
    g.restore();
  }

  // sprite getters (catSp: 0 body per colour, 1 faces, 2 shadow / key / collar, 3 trails)
  function bodySp(c) {
    return catSp[0][c] || (catSp[0][c] = sprite(-0.46, -0.53, 0.46, 0.5, (g) => paintBody(g, c)));
  }
  function faceSp(style, big, state) {
    const i = (style * 2 + big) * FACE_STATES + state;
    return catSp[1][i] || (catSp[1][i] = sprite(-0.31, -0.35, 0.31, 0.07, (g) => paintFace(g, style, big, state)));
  }
  function shadowSp() {
    return catSp[2][0] || (catSp[2][0] = sprite(-0.42, -0.1, 0.42, 0.1, paintShadow));
  }
  function keySp() {
    return catSp[2][1] || (catSp[2][1] = sprite(-0.085, -0.03, 0.095, 0.26, paintKey));
  }
  function collarSp() {
    return catSp[2][2] || (catSp[2][2] = sprite(-0.29, -0.06, 0.29, 0.1, paintCollar));
  }

  function isBlink(t, p) {
    let u = (t + p.blinkO) % p.blinkP;
    if (u < 0) u += p.blinkP;
    return u < 0.12 || (p.dbl && u > 0.24 && u < 0.35);
  }

  function drawCat(ctx, cx, cy, colour, o) {
    if (!o) o = EMPTY;
    const c = col(colour);
    const alpha = o.alpha === undefined ? 1 : o.alpha;
    const k = (o.size > 0 ? o.size / cell : 1) * (o.scale === undefined ? 1 : o.scale);
    if (!(alpha > 0.003) || !(k > 0.003)) return;
    const t = o.t || 0;
    const p = catParams(o.seed || 0);
    const tint = o.tint > 0 ? (o.tint < 1 ? o.tint : 1) : 0;
    const hop = o.hop > 0 && o.hop < 1 ? o.hop : 0;
    const mo = o.mood;
    let mood = mo === 'happy' ? 1 : mo === 'surprised' ? 2 : mo === 'hungry' ? 3 : mo === 'angry' ? 4 : 0;
    if (hop && mood === 0) mood = 1;
    const P = PALETTE[c];

    // breathing + an occasional mochi wobble
    const br = Math.sin(t * p.bw + p.bp);
    let sx = 1 - 0.01 * br;
    let sy = 1 + 0.016 * br;
    let lift = 0;
    let u = (t + p.wigO) % p.wig;
    if (u < 0) u += p.wig;
    if (u < 0.6 && !hop) {
      const w = Math.sin(u * 24) * 0.05 * (1 - u / 0.6);
      sx *= 1 + w;
      sy *= 1 - w;
    }
    if (hop) {
      if (hop < 0.16) {
        const s = Math.sin((hop / 0.16) * Math.PI);
        sx *= 1 + 0.14 * s;
        sy *= 1 - 0.16 * s;
      } else if (hop < 0.84) {
        const v = (hop - 0.16) / 0.68;
        lift = 4 * v * (1 - v);
        const st = Math.abs(Math.cos(v * Math.PI));
        sy *= 1 + 0.1 * st;
        sx *= 1 - 0.07 * st;
      } else {
        const s = Math.sin(((hop - 0.84) / 0.16) * Math.PI);
        sx *= 1 + 0.12 * s;
        sy *= 1 - 0.13 * s;
      }
    } else if (mood === 1) {
      // excited little bounces (e.g. while a hole of its colour is dragged)
      const b = Math.abs(Math.sin(t * 7.5 + p.hp));
      lift = 0.12 * b;
      sy *= 1 + 0.03 * b;
      sx *= 1 - 0.02 * b;
    }
    let sway = 0;
    let shake = 0;
    if (mood === 3) sway = 0.05 * Math.sin(t * 5.2 + p.hp); // impatient side-to-side
    else if (mood === 4) shake = Math.sin(t * 47 + p.hp) * 0.018; // trembling with rage
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
    ctx.globalAlpha = a1;
    ctx.save();
    ctx.translate(cx + shake * C, cy - lift * HOP_H * C);
    if (o.rot) ctx.rotate(o.rot);
    const fy = FOOT * cell;
    ctx.translate(0, fy * k);
    if (sway) ctx.rotate(sway);
    ctx.scale(k * sx, k * sy);
    ctx.translate(0, -fy);
    const body = bodySp(c);
    blit(ctx, body, 0, 0);
    const state = mood === 1 ? FACE_HAPPY : mood === 2 ? FACE_SURPRISED : mood === 3 ? FACE_HUNGRY : mood === 4 ? FACE_ANGRY
      : o.blink || isBlink(t, p) ? FACE_CLOSED : FACE_OPEN;
    blit(ctx, faceSp(LOOKS[c].eyes, p.big, state), 0, 0);
    if (tint > 0) {
      ctx.globalAlpha = a1 * tint;
      blit(ctx, silOf(body, P.deep), 0, 0);
      ctx.globalAlpha = a1;
    }
    if (o.key) {
      ctx.globalAlpha = a1 * (1 - tint);
      blit(ctx, collarSp(), 0, 0);
      ctx.translate(0, KEY_Y * cell);
      ctx.rotate(0.13 * Math.sin(t * 2.3 + p.kp) + (hop ? 0.25 * Math.sin(hop * TAU) : 0));
      blit(ctx, keySp(), 0, 0);
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
    // tag cell: the last cell (max dx + dy, ties → max dx)
    let tcx = list[0][0];
    let tcy = list[0][1];
    for (const [x, y] of list) {
      bw = Math.max(bw, x + 1);
      bh = Math.max(bh, y + 1);
      sx += x + 0.5;
      sy += y + 0.5;
      if (x + y > tcx + tcy || (x + y === tcx + tcy && x > tcx)) {
        tcx = x;
        tcy = y;
      }
    }
    // visual centre: centre of mass, snapped to the nearest cell centre when a disc around it leaves the shape
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
    const tx = tcx + 1 - H_IN + 0.012; // tag right edge
    const ty = tcy + 1 - H_IN + 0.012; // tag bottom edge
    let rmax = 0;
    let irisR = 0;
    let rTag = 0;
    const ii = H_IN + H_RIM;
    const cut = H_RI * (Math.SQRT2 - 1);
    for (const [x, y] of list) {
      for (const [qx, qy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
        rmax = Math.max(rmax, Math.hypot(qx - bx, qy - by));
        rTag = Math.max(rTag, Math.hypot(qx - (tx - 0.16), qy - (ty - 0.18)));
      }
      // farthest visible pit point (rounded corners trimmed)
      for (const [qx, qy] of [[x + ii, y + ii], [x + 1 - ii, y + ii], [x + ii, y + 1 - ii], [x + 1 - ii, y + 1 - ii]]) {
        irisR = Math.max(irisR, Math.hypot(qx - bx, qy - by) - cut);
      }
    }
    const loops = traceLoops(list);
    const outer = new Path2D();
    const inner = new Path2D();
    const gloss = new Path2D();
    const rings = [];
    for (let k = 0; k < MAX_RINGS; k++) rings.push(new Path2D());
    for (const lp of loops) {
      loopPath(outer, lp, H_IN, H_R, H_r);
      loopPath(inner, lp, H_IN + H_RIM, H_RI, H_rI);
      loopPath(gloss, lp, H_IN + 0.03, H_R - 0.03, H_r + 0.03);
      for (let k = 0; k < MAX_RINGS; k++) loopPath(rings[k], lp, H_IN - RING * (k + 1), H_R + RING * (k + 1), Math.max(0.02, H_r - RING * (k + 1)));
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
    // Chevron anchors for axis-locked holes: ends of the run through the visual centre.
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
      key, cells: list, bw, bh, bx, by, tx, ty, rmax, rTag, outer, inner, gloss, rings, clipFor, clips: new Map(),
      outerInv: inverse(outer, -2, -2, bw + 2, bh + 2),
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

  function paintHole(g, G, c, axis, next) {
    const L = lw;
    const P = PALETTE[c];
    // contact shadow on the floor
    g.save();
    g.shadowColor = `rgba(${SHADOW_RGB},0.28)`;
    g.shadowBlur = 0.07 * S;
    g.shadowOffsetY = 0.035 * S;
    g.fillStyle = P.dark;
    g.fill(next.length ? G.rings[Math.min(MAX_RINGS, next.length) - 1] : G.outer);
    g.restore();
    // rings of the layers still to come, outermost first (the innermost is the next colour)
    for (let k = Math.min(MAX_RINGS, next.length); k >= 1; k--) {
      const Q = PALETTE[col(next[k - 1])];
      const rp = G.rings[k - 1];
      g.lineWidth = 2 * L;
      g.strokeStyle = Q.outline;
      g.stroke(rp);
      g.fillStyle = Q.main;
      g.fill(rp);
      g.save();
      g.clip(rp);
      g.lineWidth = 0.022;
      g.strokeStyle = rgba(Q.light, 0.7);
      g.translate(0, 0.012);
      g.stroke(rp);
      g.restore();
    }
    // rim: flat colour, a lit top edge, a shaded bottom edge, dark outline
    g.lineWidth = 2 * L;
    g.strokeStyle = P.outline;
    g.stroke(G.outer);
    g.fillStyle = P.main;
    g.fill(G.outer);
    g.save();
    g.clip(G.outer);
    band(g, G.outerInv, 0, 0.04, rgba(P.light, 0.55));
    band(g, G.outerInv, 0, -0.035, rgba(P.dark, 0.55));
    g.restore();
    // pit: lighter far wall at the top, deep at the bottom
    g.lineWidth = 2 * L * 0.8;
    g.strokeStyle = P.outline;
    g.stroke(G.inner);
    const pg = g.createLinearGradient(0, H_IN + H_RIM, 0, G.bh - H_IN - H_RIM);
    pg.addColorStop(0, c === 8 ? mix(P.dark, P.deep, 0.3) : mix(P.dark, P.deep, 0.4));
    pg.addColorStop(0.55, mix(P.dark, P.deep, 0.72));
    pg.addColorStop(1, mix(P.deep, '#000000', 0.12));
    g.fillStyle = pg;
    g.fill(G.inner);
    g.save();
    g.clip(G.inner);
    // soft shade along the near (lower) and side walls
    g.shadowColor = rgba(mix(P.deep, '#000000', 0.5), 0.55);
    g.shadowBlur = 0.12 * S;
    g.shadowOffsetY = -0.05 * S;
    g.fillStyle = '#000';
    g.fill(inverse(G.inner, -2, -2, G.bw + 2, G.bh + 2), 'evenodd');
    g.restore();
    if (marks) {
      // faint emblem in every pit cell: the shape reads around the number
      const sp = new Path2D();
      const size = G.cells.length === 1 ? 0.6 : 0.5;
      for (const [x, y] of G.cells) symbolPath(sp, c, x + 0.5, y + 0.5, size);
      g.save();
      g.clip(G.inner);
      g.fillStyle = rgba(P.main, 0.45);
      g.fill(sp, 'evenodd');
      g.restore();
    }
    // axis chevrons: inside the pit at both ends of the run, or on the rim when the run is a single cell
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
        for (const [w, style] of [[0.07, rgba(P.outline, 0.85)], [0.034, '#FFFFFF']]) {
          g.strokeStyle = style;
          g.lineWidth = w;
          chevron(g, v ? o : ra, v ? ra : o, -1, v, 0.08);
          chevron(g, v ? o : rb, v ? rb : o, 1, v, 0.08);
        }
      }
    }
  }

  function paintGlow(g, G, P) {
    g.save();
    g.shadowColor = rgba(P.main === '#FBFAFF' ? P.outline : P.main, 0.95);
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
    g.fillStyle = P.main === '#FBFAFF' ? rgba(P.dark, 0.95) : rgba('#FFFFFF', 0.92);
    g.beginPath();
    pawPath(g, G.bx, G.by, 0.34);
    g.fill();
    g.restore();
    g.lineWidth = lw * 0.9;
    g.strokeStyle = P.outline;
    g.stroke(G.inner);
  }

  function holeEntry(cells, c, axis, next) {
    const G = geom(cells);
    let nk = '';
    for (let i = 0; i < next.length && i < MAX_RINGS; i++) nk += ',' + col(next[i]);
    const key = G.key + '|' + c + '|' + (axis || '') + nk;
    let e = holeC.get(key);
    if (e) return e;
    trim();
    const nx = next.slice(0, MAX_RINGS).map(col);
    e = { G, c, axis, next: nx, base: null, glow: null, white: null, flash: null, lid: null };
    e.base = holeSprite(G, (g) => paintHole(g, G, c, axis, nx));
    holeC.set(key, e);
    return e;
  }

  function drawBadgeAt(ctx, x, y, n, c, s) {
    const sp = badgeSp(n, c);
    if (s === 1) blit(ctx, sp, x, y);
    else ctx.drawImage(sp.c, x - sp.ox * s, y - sp.oy * s, sp.w * s, sp.h * s);
  }

  /** Tag centre (cells, relative to the shape origin) for a number. */
  function tagPos(G, n) {
    return [G.tx - tagW(n) / 2, G.ty - TAG_H / 2];
  }

  const NO_NEXT = [];

  function drawHole(ctx, cells, x, y, colour, o) {
    if (!o) o = EMPTY;
    const closing = o.closing > 0 ? o.closing : 0;
    if (closing >= 1 || !cells || !cells.length) return;
    const c = col(colour);
    const P = PALETTE[c];
    const axis = o.axis === 'h' || o.axis === 'v' ? o.axis : null;
    const next = Array.isArray(o.next) && o.next.length ? o.next : NO_NEXT;
    const e = holeEntry(cells, c, axis, next);
    const G = e.G;
    const lifted = o.lifted > 0 ? (o.lifted < 1 ? o.lifted : 1) : 0;
    const pulse = o.pulse > 0 ? (o.pulse < 1 ? o.pulse : 1) : 0;
    const change = o.change > 0 && o.change < 1 && o.prev !== undefined && o.prev !== null ? o.change : 0;
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
    let prevE = null;
    if (change) {
      const pc = col(o.prev);
      if (pc !== c) prevE = holeEntry(cells, pc, axis, [c, ...next]);
      s *= 1 + 0.08 * Math.sin(Math.PI * change);
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
    if (prevE) drawSweep(ctx, G, prevE, x, y, change, o.need);
    const wa = 0.26 * lifted + 0.45 * pulse * pulse;
    if (wa > 0.01) {
      ctx.globalAlpha = ga * a * wa;
      blit(ctx, (e.white ||= holeSprite(G, (g) => paintWhite(g, G))), x, y);
    }
    if (pulse > 0.01) {
      ctx.globalAlpha = ga * a * pulse;
      blit(ctx, (e.flash ||= holeSprite(G, (g) => paintFlash(g, G, P))), x, y);
    }
    const [tcx, tcy] = o.need > 0 ? tagPos(G, o.need) : [0, 0];
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
        drawBadgeAt(ctx, x + tcx * cell, y + tcy * cell, o.need, c, 1);
      }
    } else if (o.need > 0 && o.badge !== false) {
      ctx.globalAlpha = ga * a;
      const bs = (1 + 0.3 * pulse * pulse) * (1 + 0.3 * Math.sin(Math.PI * change));
      drawBadgeAt(ctx, x + tcx * cell, y + tcy * cell, o.need, c, bs);
    }
    ctx.restore();
    ctx.globalAlpha = ga;
  }

  /** Layer change: the old colour (prevE) is swept away by a circle growing from the tag, with a bright edge. */
  function drawSweep(ctx, G, prevE, x, y, change, need) {
    const [tx, ty] = tagPos(G, need > 0 ? need : 1);
    const k = 1 - (1 - change) * (1 - change);
    const r = (G.rTag + 0.35) * k;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(cell, cell);
    ctx.beginPath();
    ctx.rect(-H_PAD - 1, -H_PAD - 1, G.bw + 2 * H_PAD + 2, G.bh + 2 * H_PAD + 2);
    ctx.moveTo(tx + r, ty);
    ctx.arc(tx, ty, r, 0, TAU, true);
    ctx.clip('evenodd');
    const sp = prevE.base;
    ctx.drawImage(sp.c, -sp.ox / cell, -sp.oy / cell, sp.w / cell, sp.h / cell);
    ctx.restore();
    // bright front of the sweep, clipped to the hole
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(cell, cell);
    ctx.clip(G.outer);
    ctx.globalAlpha *= 1 - change;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    ctx.arc(tx, ty, Math.max(0.01, r), 0, TAU);
    ctx.stroke();
    ctx.restore();
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
    const change = o.change > 0 && o.change < 1 ? o.change : 0;
    const s = (o.scale > 0 ? o.scale : 1) * (1 + 0.3 * pulse * pulse) * (1 + 0.32 * Math.sin(Math.PI * change));
    const [tx, ty] = tagPos(G, need);
    const ga = ctx.globalAlpha;
    if (o.alpha !== undefined) ctx.globalAlpha = ga * o.alpha;
    drawBadgeAt(ctx, x + tx * cell, y + ty * cell, need, col(colour), s);
    ctx.globalAlpha = ga;
  }

  function badgeAt(cells, need = 1) {
    return tagPos(geom(cells), need);
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

  // ═════════════════════════════════════════ trails ═════════════════════════════════════════
  function trailSp(c) {
    return catSp[3][c] || (catSp[3][c] = sprite(0, 0, 1, 1, (g) => {
      const P = PALETTE[c];
      const p = new Path2D();
      rrect(p, 0.05, 0.05, 0.9, 0.9, 0.15);
      g.fillStyle = rgba(c === 8 ? '#FFFFFF' : P.main, c === 8 ? 0.8 : 0.5);
      g.fill(p);
      g.lineWidth = 0.03;
      g.strokeStyle = rgba(c === 8 ? P.dark : P.main, 0.55);
      g.stroke(p);
    }));
  }

  // ═════════════════════════════════════════ gates ═════════════════════════════════════════
  // A floor cell only a hole of one colour may cover: a recessed tile tinted with the colour, barrier
  // stripes, a chunky frame with corner studs and a paw emblem (the colour's symbol in colour-blind mode).
  const GATE_TILE = new Path2D();
  rrect(GATE_TILE, 0.075, 0.075, 0.85, 0.85, 0.15);

  function paintGate(g, c, open) {
    const P = PALETTE[c];
    const L = lw;
    const white = c === 8;
    const tint = white ? mix(FLOOR.a, '#FFFFFF', 0.55) : mix(FLOOR.b, P.main, open ? 0.42 : 0.3);
    g.fillStyle = tint;
    g.fill(GATE_TILE);
    g.save();
    g.clip(GATE_TILE);
    if (!open) {
      g.strokeStyle = rgba(white ? P.dark : P.main, white ? 0.75 : 0.42);
      g.lineWidth = 0.085;
      g.beginPath();
      for (let i = -5; i <= 5; i++) {
        g.moveTo(i * 0.21, 1.1);
        g.lineTo(i * 0.21 + 1.2, -0.1);
      }
      g.stroke();
    }
    g.shadowColor = rgba(mix(P.deep, '#000000', 0.3), white ? 0.3 : 0.45);
    g.shadowBlur = 0.08 * S;
    g.shadowOffsetY = 0.04 * S;
    g.fillStyle = '#000';
    g.fill(inverse(GATE_TILE, -1, -1, 2, 2), 'evenodd');
    g.restore();
    // chunky frame
    g.lineWidth = 0.075 + 2 * L;
    g.strokeStyle = P.outline;
    g.stroke(GATE_TILE);
    g.lineWidth = 0.075;
    g.strokeStyle = P.main;
    g.stroke(GATE_TILE);
    g.save();
    g.translate(0, -0.014);
    g.lineWidth = 0.018;
    g.strokeStyle = rgba(P.light, 0.85);
    g.beginPath();
    g.moveTo(0.22, 0.075);
    g.lineTo(0.78, 0.075);
    g.stroke();
    g.restore();
    // corner studs
    for (const [sx, sy] of [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) {
      const st = new Path2D();
      ell(st, sx, sy, 0.058, 0.058);
      g.lineWidth = 2 * L;
      g.strokeStyle = P.outline;
      g.stroke(st);
      const sg = g.createRadialGradient(sx - 0.02, sy - 0.02, 0.005, sx, sy, 0.06);
      sg.addColorStop(0, white ? '#FFFFFF' : P.light);
      sg.addColorStop(1, white ? P.dark : P.main);
      g.fillStyle = sg;
      g.fill(st);
    }
    // emblem
    const em = new Path2D();
    if (marks) symbolPath(em, c, 0.5, 0.5, 0.34);
    else pawPath(em, 0.5, 0.49, open ? 0.36 : 0.32);
    g.lineWidth = 2 * L;
    g.strokeStyle = P.outline;
    g.stroke(em);
    g.fillStyle = white ? P.dark : '#FFFFFF';
    g.fill(em, 'evenodd');
  }

  function gateSp(c, open) {
    const key = 'gate' + c + (open ? 'o' : '');
    return (misc[key] ||= sprite(-0.02, -0.02, 1.02, 1.02, (g) => paintGate(g, c, open)));
  }

  function shineSp() {
    return (misc.shine ||= sprite(-0.6, -0.6, 0.6, 0.6, (g) => {
      g.rotate(-Math.PI / 4);
      const lg = g.createLinearGradient(-0.2, 0, 0.2, 0);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(0.5, 'rgba(255,255,255,0.55)');
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = lg;
      g.fillRect(-0.2, -0.9, 0.4, 1.8);
    }));
  }

  function drawGate(ctx, x, y, colour, o) {
    if (!o) o = EMPTY;
    const c = col(colour);
    const t = o.t || 0;
    const active = o.active > 0 ? (o.active < 1 ? o.active : 1) : 0;
    const ga = ctx.globalAlpha;
    if (active < 1) {
      ctx.globalAlpha = ga * (1 - active);
      blit(ctx, gateSp(c, false), x, y);
    }
    if (active > 0) {
      ctx.globalAlpha = ga * active;
      blit(ctx, gateSp(c, true), x, y);
    }
    ctx.globalAlpha = ga;
    // shimmer sweeping across now and then (each gate at its own time)
    const period = 3.2;
    let u = (t + ((x * 0.37 + y * 0.61) / cell) * 0.9) % period;
    if (u < 0) u += period;
    if (u < 0.9) {
      const sh = shineSp();
      const d = -0.75 + (u / 0.9) * 1.5;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(cell, cell);
      ctx.clip(GATE_TILE);
      ctx.globalAlpha = ga * (0.75 + 0.25 * active);
      ctx.drawImage(sh.c, 0.5 + d - sh.ox / cell, 0.5 + d - sh.oy / cell, sh.w / cell, sh.h / cell);
      ctx.restore();
    }
  }

  // ═════════════════════════════════════════ hungry cats ═════════════════════════════════════════
  function hungrySp(n, urgent) {
    const key = 'h' + n + (urgent ? 'u' : '');
    let sp = textC.get(key);
    if (sp) return sp;
    const str = String(n);
    const nw = measureCells(str, 0.2);
    const bw = 0.205 + nw + 0.075;
    const bh = 0.27;
    trim();
    sp = sprite(-bw / 2 - 0.06, -bh / 2 - 0.05, bw / 2 + 0.05, bh / 2 + 0.13, (g) => {
      const fill = urgent ? '#FF5A6E' : '#FFFFFF';
      const line = urgent ? '#8E1530' : '#6E5C9C';
      const bubble = new Path2D();
      rrect(bubble, -bw / 2, -bh / 2, bw, bh, bh / 2);
      const tail = new Path2D();
      tail.moveTo(-bw / 2 + 0.07, bh / 2 - 0.04);
      tail.lineTo(-bw / 2 - 0.005, bh / 2 + 0.095);
      tail.lineTo(-bw / 2 + 0.17, bh / 2 - 0.015);
      tail.closePath();
      g.lineWidth = 2 * lw;
      g.strokeStyle = line;
      g.stroke(bubble);
      g.stroke(tail);
      g.fillStyle = fill;
      g.fill(bubble);
      g.fill(tail);
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.beginPath();
      ell(g, -bw / 2 + 0.11, -bh / 2 + 0.06, 0.06, 0.022, -0.2);
      g.fill();
      // fish
      const fx = -bw / 2 + 0.125;
      const fy = 0.008;
      const fish = new Path2D();
      ell(fish, fx, fy, 0.064, 0.041);
      fish.moveTo(fx - 0.052, fy);
      fish.lineTo(fx - 0.1, fy - 0.042);
      fish.lineTo(fx - 0.092, fy);
      fish.lineTo(fx - 0.1, fy + 0.042);
      fish.closePath();
      g.lineWidth = lw * 1.4;
      g.strokeStyle = urgent ? '#8E1530' : '#22609A';
      g.stroke(fish);
      g.fillStyle = urgent ? '#FFFFFF' : '#5BB0EE';
      g.fill(fish);
      g.fillStyle = urgent ? '#8E1530' : '#183E66';
      g.beginPath();
      ell(g, fx + 0.03, fy - 0.009, 0.0095, 0.0095);
      g.fill();
      paintText(g, str, fx + 0.085 + nw / 2, 0.006, 0.2, urgent ? '#FFFFFF' : '#2C2347', urgent ? '#8E1530' : null, 0.15, null);
    });
    textC.set(key, sp);
    return sp;
  }

  function drawHungry(ctx, cx, cy, left, o) {
    if (!o) o = EMPTY;
    const n = Math.max(0, Math.floor(left) || 0);
    const urgent = o.urgent === undefined ? n <= 2 : !!o.urgent;
    const sp = hungrySp(n, urgent);
    const t = o.t || 0;
    const k = (o.size > 0 ? o.size / cell : 1) * (o.scale > 0 ? o.scale : 1);
    const s = k * (urgent ? 1 + 0.08 * (0.5 + 0.5 * Math.sin(t * 7)) : 1 + 0.02 * Math.sin(t * 2.4));
    const x = cx + 0.26 * cell * k;
    const y = cy - 0.4 * cell * k;
    const ga = ctx.globalAlpha;
    if (o.alpha !== undefined) ctx.globalAlpha = ga * o.alpha;
    ctx.drawImage(sp.c, x - sp.ox * s, y - sp.oy * s, sp.w * s, sp.h * s);
    ctx.globalAlpha = ga;
  }

  function drawTrail(ctx, x, y, colour, alpha) {
    const a = alpha === undefined ? 1 : alpha;
    if (!(a > 0.003)) return;
    const sp = trailSp(col(colour));
    const ga = ctx.globalAlpha;
    ctx.globalAlpha = ga * Math.min(1, a);
    ctx.drawImage(sp.c, x - sp.ox, y - sp.oy, sp.w, sp.h);
    ctx.globalAlpha = ga;
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
    // the frame: one rounded purple slab around the whole board, with a deeper bottom face
    const slab = new Path2D();
    rrect(slab, -FRAME_W, -FRAME_W, w + 2 * FRAME_W, h + 2 * FRAME_W, FRAME_R);
    const slabInv = inverse(slab, -2, -2, w + 2, h + 2);
    g.save();
    g.shadowColor = 'rgba(45, 18, 100, 0.4)';
    g.shadowBlur = 0.3 * S;
    g.shadowOffsetY = 0.14 * S;
    g.translate(0, FRAME_D);
    g.fillStyle = FRAME.side2;
    g.fill(slab);
    g.restore();
    g.save();
    g.translate(0, FRAME_D);
    g.lineWidth = 2 * L;
    g.strokeStyle = FRAME.outline;
    g.stroke(slab);
    const sg = g.createLinearGradient(0, h, 0, h + FRAME_W + FRAME_D);
    sg.addColorStop(0, FRAME.side1);
    sg.addColorStop(1, FRAME.side2);
    g.fillStyle = sg;
    g.fill(slab);
    g.restore();
    g.lineWidth = 2 * L;
    g.strokeStyle = FRAME.outline;
    g.stroke(slab);
    const tg = g.createLinearGradient(0, -FRAME_W, 0, h + FRAME_W);
    tg.addColorStop(0, FRAME.top1);
    tg.addColorStop(1, FRAME.top2);
    g.fillStyle = tg;
    g.fill(slab);
    g.save();
    g.clip(slab);
    band(g, slabInv, 0.045, 0.065, rgba(FRAME.hi, 0.85));
    band(g, slabInv, -0.035, -0.05, rgba(FRAME.side1, 0.55));
    g.restore();
    // void cells inside the frame: recessed purple panels
    const voids = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!isB(x, y)) voids.push([x, y]);
    if (voids.length) {
      const vp = cellsPath(voids, 0.07, 0.16, 0.07);
      g.fillStyle = FRAME.void;
      g.fill(vp);
      g.save();
      g.clip(vp);
      g.shadowColor = 'rgba(30, 10, 80, 0.55)';
      g.shadowBlur = 0.1 * S;
      g.shadowOffsetY = 0.05 * S;
      g.fillStyle = '#000';
      g.fill(inverse(vp, -2, -2, w + 2, h + 2), 'evenodd');
      g.restore();
      g.lineWidth = L * 0.9;
      g.strokeStyle = rgba(FRAME.outline, 0.7);
      g.stroke(vp);
    }
    // floor: dark inner outline, light grid colour, rounded tiles in two close tones
    const floor = regionPath(isB, w, h, 0, 0.1, 0.06);
    g.lineWidth = 2 * L * 1.15;
    g.strokeStyle = FRAME.inner;
    g.stroke(floor);
    g.fillStyle = FLOOR.grid;
    g.fill(floor);
    g.save();
    g.clip(floor);
    for (const [tone, odd] of [[FLOOR.a, 0], [FLOOR.b, 1]]) {
      g.fillStyle = tone;
      g.beginPath();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (isB(x, y) && (x + y) % 2 === odd) rrect(g, x + 0.028, y + 0.028, 0.944, 0.944, 0.075);
        }
      }
      g.fill();
    }
    // shade cast by the frame on the top edges of the floor
    g.shadowColor = 'rgba(80, 30, 120, 0.32)';
    g.shadowBlur = 0.12 * S;
    g.shadowOffsetY = 0.05 * S;
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
    g.shadowColor = 'rgba(60, 30, 120, 0.4)';
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
    // top-face gloss, then one tufted button per cell (a soft lilac cushion block)
    g.save();
    g.clip(path);
    band(g, inverse(path, -2, -2, w + 2, h + 2), 0.03, 0.05, 'rgba(255,255,255,0.75)');
    for (const [x, y] of cells) {
      const cx = x + 0.5;
      const cy = y + 0.5;
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
      lw = Math.max(0.032, 1.1 / cell);
      art.cell = cell;
      art.dpr = dpr;
      art.boardMargin = Math.ceil(cell * (FRAME_W + FRAME_D + 0.32));
      art.frameWidth = cell * FRAME_W;
      art.frameBottom = cell * (FRAME_W + FRAME_D);
    },
    renderBoard,
    drawCrate,
    drawTrail,
    drawGate,
    drawHungry,
    drawHole,
    drawHoleBadge,
    badgeAt,
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
     * level fades in. o: { colors = all, holes = [{ cells, c, axis, need, next }] }.
     */
    prewarm(o = EMPTY) {
      const colors = o.colors || PALETTE.map((_, i) => i);
      for (const c0 of colors) {
        const c = col(c0);
        bodySp(c);
        for (let big = 0; big < 2; big++) for (let st = 0; st < FACE_STATES; st++) faceSp(LOOKS[c].eyes, big, st);
        trailSp(c);
      }
      shadowSp();
      keySp();
      collarSp();
      for (const h of o.holes || []) {
        const c = col(h.c);
        holeEntry(h.cells, c, h.axis === 'h' || h.axis === 'v' ? h.axis : null, Array.isArray(h.next) ? h.next : NO_NEXT);
        if (h.need > 0) badgeSp(h.need, c);
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
