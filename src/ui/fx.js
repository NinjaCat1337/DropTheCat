// Easing curves and a tiny particle system (puffs, stars, confetti). Pure canvas drawing; no DOM at import.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const ease = {
  clamp01,
  linear: (t) => clamp01(t),
  inQuad: (t) => clamp01(t) ** 2,
  outQuad: (t) => 1 - (1 - clamp01(t)) ** 2,
  outCubic: (t) => 1 - (1 - clamp01(t)) ** 3,
  inCubic: (t) => clamp01(t) ** 3,
  inOutSine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t)),
  outBack: (t) => {
    const x = clamp01(t) - 1;
    return 1 + 2.70158 * x * x * x + 1.70158 * x * x;
  },
  inBack: (t) => {
    const x = clamp01(t);
    return 2.70158 * x * x * x - 1.70158 * x * x;
  },
};

const TAU = Math.PI * 2;

function star(ctx, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    if (i) ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

function heart(ctx, r) {
  ctx.beginPath();
  ctx.moveTo(0, r * 0.9);
  ctx.bezierCurveTo(-r * 1.4, -r * 0.1, -r * 0.6, -r * 1.2, 0, -r * 0.45);
  ctx.bezierCurveTo(r * 0.6, -r * 1.2, r * 1.4, -r * 0.1, 0, r * 0.9);
  ctx.fill();
}

/**
 * Particles live in CSS px; times are in ms (performance.now()).
 * kinds: 'dot' (soft puff), 'star', 'confetti' (spinning rectangle), 'heart', 'ring' (expanding circle).
 */
export function createParticles() {
  let list = [];

  function add(p) {
    list.push({ vx: 0, vy: 0, g: 0, drag: 0, rot: 0, vr: 0, size: 6, life: 600, color: '#fff', kind: 'dot', ...p });
  }

  return {
    get count() {
      return list.length;
    },
    clear() {
      list = [];
    },
    /** Small puff of dots, e.g. where a cat dropped. */
    puff(x, y, color, now, size = 1) {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + Math.random() * 0.6;
        const sp = (0.06 + Math.random() * 0.08) * size;
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.03 * size, drag: 0.004, life: 380 + Math.random() * 180,
          t0: now, size: (3 + Math.random() * 3) * size, color, kind: 'dot' });
      }
      add({ x, y, t0: now, life: 360, size: 18 * size, color, kind: 'ring' });
    },
    /** Star burst, e.g. when a hole closes. */
    burst(x, y, colors, now, size = 1, n = 14) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + Math.random() * 0.4;
        const sp = (0.12 + Math.random() * 0.18) * size;
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.08 * size, g: 0.00045 * size, drag: 0.002,
          life: 650 + Math.random() * 350, t0: now, size: (5 + Math.random() * 5) * size,
          color: colors[i % colors.length], kind: i % 3 === 0 ? 'heart' : 'star', rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.01 });
      }
      add({ x, y, t0: now, life: 520, size: 46 * size, color: colors[0], kind: 'ring' });
    },
    /** Confetti rain from the top of the screen. */
    confetti(width, colors, now, n = 70) {
      for (let i = 0; i < n; i++) {
        add({ x: Math.random() * width, y: -20 - Math.random() * 120, vx: (Math.random() - 0.5) * 0.12,
          vy: 0.12 + Math.random() * 0.18, g: 0.00012, drag: 0.0006, life: 2600 + Math.random() * 1200,
          t0: now + Math.random() * 400, size: 6 + Math.random() * 6, color: colors[i % colors.length],
          kind: 'confetti', rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.02 });
      }
    },
    /** Advances and draws every particle (call once per frame, after the scene). */
    draw(ctx, now, dt) {
      if (!list.length) return;
      const keep = [];
      for (const p of list) {
        const age = now - p.t0;
        if (age < 0) {
          keep.push(p);
          continue;
        }
        if (age > p.life) continue;
        keep.push(p);
        const k = Math.min(dt, 50);
        p.vx *= 1 - p.drag * k;
        p.vy = p.vy * (1 - p.drag * k) + p.g * k;
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.rot += p.vr * k;
        const life = age / p.life;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.fillStyle = p.color;
        if (p.kind === 'ring') {
          ctx.globalAlpha = 0.55 * (1 - life);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, 4 * (1 - life));
          ctx.beginPath();
          ctx.arc(0, 0, p.size * ease.outCubic(life), 0, TAU);
          ctx.stroke();
        } else if (p.kind === 'confetti') {
          ctx.globalAlpha = life > 0.8 ? (1 - life) * 5 : 1;
          ctx.rotate(p.rot);
          ctx.scale(1, Math.cos(p.rot * 3));
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else {
          ctx.globalAlpha = life > 0.6 ? (1 - life) / 0.4 : 1;
          ctx.rotate(p.rot);
          const s = p.size * (p.kind === 'dot' ? 1 - life * 0.5 : 0.6 + 0.4 * Math.sin(Math.min(1, life * 3) * Math.PI / 2));
          if (p.kind === 'star') star(ctx, s);
          else if (p.kind === 'heart') heart(ctx, s * 0.8);
          else {
            ctx.beginPath();
            ctx.arc(0, 0, s, 0, TAU);
            ctx.fill();
          }
        }
        ctx.restore();
      }
      list = keep;
    },
  };
}
