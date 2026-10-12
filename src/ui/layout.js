// Board placement: the largest cell size that fits the level inside the free area between the HUD bars,
// leaving room for the board frame. Pure; everything is in CSS px.

const MAX_CELL = 84;
const MIN_CELL = 18;
const FRAME = 0.34; // frame margin per side, in cells (the art draws its frame around the cell area)
const PAD = 8; // extra breathing room around the frame

/**
 * @param {{ x: number, y: number, w: number, h: number }} free area available for the board
 * @param {number} cols level width in cells
 * @param {number} rows level height in cells
 * @returns {{ cell: number, x: number, y: number, w: number, h: number }} cell size and the cell-area rect
 */
export function fitBoard(free, cols, rows) {
  const fw = Math.max(1, free.w - 2 * PAD);
  const fh = Math.max(1, free.h - 2 * PAD);
  let cell = Math.floor(Math.min(fw / (cols + 2 * FRAME), fh / (rows + 2 * FRAME)));
  cell = Math.max(MIN_CELL, Math.min(MAX_CELL, cell));
  const w = cols * cell;
  const h = rows * cell;
  return {
    cell,
    x: Math.round(free.x + (free.w - w) / 2),
    y: Math.round(free.y + (free.h - h) / 2),
    w,
    h,
  };
}

/**
 * Free area for the board given the viewport and the on-screen rects of the top bar and the tools bar.
 * The tools bar is either along the bottom (portrait) or along the right edge (short landscape screens).
 */
export function freeArea(width, height, top, tools) {
  const y0 = top ? Math.max(0, top.bottom) : 0;
  let x1 = width;
  let y1 = height;
  if (tools && tools.width > 0) {
    const atRight = tools.left > width * 0.55 && tools.height > tools.width;
    if (atRight) x1 = Math.min(x1, tools.left);
    else y1 = Math.min(y1, tools.top);
  }
  return { x: 0, y: y0, w: Math.max(1, x1), h: Math.max(1, y1 - y0) };
}
