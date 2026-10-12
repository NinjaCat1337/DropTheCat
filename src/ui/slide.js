// Continuous, grid-constrained sliding of one hole under the finger ("Pac-Man" movement). Pure: no DOM.
// The hole's visual position (px, py, in cells) is fractional on at most one axis at a time, so it can only
// turn where it is aligned with the grid; when the finger asks for a turn mid-cell, the hole first slides to
// whichever end of its current segment allows that turn (corner assist). The game position is always the
// nearest cell: crossing the half-way point steps the game, which is what drops cats. Both ends of the
// segment are always legal positions (cats only ever disappear and other holes stand still during a drag).

const EPS = 1e-6;

/**
 * @param {import('../core/rules.js').Game} game
 * @param {number} k hole index
 */
export function createSlide(game, k) {
  let px = game.hx[k];
  let py = game.hy[k];
  let steps = 0;
  let done = false;
  let events = [];
  const axis = game.holeAxis(k);
  const axisOk = (a) => !axis || (axis === 'h' ? a === 0 : a === 1);
  const fits = (x, y) => game.canPlace(k, x, y);

  // Sets the visual coordinate on axis a; steps the game when the nearest cell changes.
  function setAxis(a, v) {
    if (a === 0) px = v;
    else py = v;
    const g = a === 0 ? game.hx[k] : game.hy[k];
    const f = v - g;
    if (Math.abs(f) > 0.5 + EPS) {
      const s = Math.sign(f);
      const dx = a === 0 ? s : 0;
      const dy = a === 1 ? s : 0;
      if (!game.canStep(k, dx, dy)) {
        // Cannot happen while the invariant holds; stay on the legal cell instead of desyncing.
        if (a === 0) px = g;
        else py = g;
        return;
      }
      game.step(k, dx, dy, events);
      steps++;
      if (game.need[k] <= 0) done = true;
    }
  }

  /**
   * Moves the hole as far as possible toward the target (cell units, may be fractional).
   * @returns {object[]} game events produced by this call
   */
  function moveToward(tx, ty) {
    const t = [tx, ty];
    for (let iter = 0; iter < 400 && !done; iter++) {
      const g = [game.hx[k], game.hy[k]];
      const p = [px, py];
      const d = [t[0] - p[0], t[1] - p[1]];
      if (Math.abs(d[0]) < EPS && Math.abs(d[1]) < EPS) break;
      let ax = -1;
      if (Math.abs(p[0] - g[0]) > EPS) ax = 0;
      else if (Math.abs(p[1] - g[1]) > EPS) ax = 1;
      let progressed = false;
      if (ax >= 0) {
        // Mid-cell: only this axis may move, within the segment [g, other].
        const o = 1 - ax;
        const other = g[ax] + Math.sign(p[ax] - g[ax]);
        let goal = t[ax];
        if (axisOk(o) && Math.abs(d[o]) > 0.25 && Math.abs(d[o]) > Math.abs(d[ax])) {
          const s = Math.sign(d[o]);
          const canTurn = (v) => (ax === 0 ? fits(v, g[1] + s) : fits(g[0] + s, v));
          const a = canTurn(g[ax]);
          const b = canTurn(other);
          if (a && !b) goal = g[ax];
          else if (b && !a) goal = other;
          else goal = Math.abs(t[ax] - g[ax]) <= Math.abs(t[ax] - other) ? g[ax] : other;
        }
        const lo = Math.min(g[ax], other);
        const hi = Math.max(g[ax], other);
        const np = Math.min(hi, Math.max(lo, goal));
        if (Math.abs(np - p[ax]) > EPS) {
          setAxis(ax, np);
          progressed = true;
        }
      } else {
        // Aligned: head toward the finger along the dominant axis, else the other one.
        px = g[0];
        py = g[1];
        const order = Math.abs(d[0]) >= Math.abs(d[1]) ? [0, 1] : [1, 0];
        for (const a of order) {
          if (Math.abs(d[a]) < EPS || !axisOk(a)) continue;
          const s = Math.sign(d[a]);
          if (!(a === 0 ? fits(g[0] + s, g[1]) : fits(g[0], g[1] + s))) continue;
          setAxis(a, g[a] + s * Math.min(1, Math.abs(d[a])));
          progressed = true;
          break;
        }
      }
      if (!progressed) break;
    }
    const out = events;
    events = [];
    return out;
  }

  return {
    k,
    moveToward,
    /** Visual position in cells. */
    get x() {
      return px;
    },
    get y() {
      return py;
    },
    /** Cells stepped so far. */
    get steps() {
      return steps;
    },
    /** True once the hole has filled up (the drag is over). */
    get done() {
      return done;
    },
  };
}
