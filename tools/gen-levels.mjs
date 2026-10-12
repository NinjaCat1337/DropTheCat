// Builds src/core/level-data.js: 3 hand-made tutorials + levels 4..100 from the generator's campaign curve
// (levelParams). Every level is compiled, its stored solution replayed with the real rules and solved by the
// hint solver before it is written. Prints a summary table.
// Usage: npm run levels            (node tools/gen-levels.mjs [--only <n>] [--dry])
//   --only <n>  generate and print level n only (nothing is written)
//   --dry       print the table without writing the file
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLevel, levelParams, levelSeed, evaluateLevel, verifySolution } from '../src/core/generator.js';
import { compileLevel } from '../src/core/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'core', 'level-data.js');
const COUNT = 100;

/** Hand-made tutorials (colours: 0 red, 1 orange, 2 yellow, 3 green, 4 cyan, 5 blue, 6 purple, 7 pink). */
const TUTORIALS = [
  // 1: one colour, one 1×1 hole, three cats right above it — just drag it up.
  {
    w: 5,
    h: 6,
    grid: ['.....', '.....', '.....', '.....', '.....', '.....'],
    cats: [[2, 2, 0], [2, 3, 0], [2, 4, 0]],
    holes: [{ x: 2, y: 5, c: 0, cells: [[0, 0]], need: 3 }],
    solution: [[0, 'UUU']],
  },
  // 2: two colours side by side, each with its own hole; the blue hole is two cells wide and eats two at once.
  {
    w: 5,
    h: 6,
    grid: ['.....', '.....', '.....', '.....', '.....', '.....'],
    cats: [[1, 1, 0], [1, 2, 0], [1, 3, 0], [3, 2, 5], [4, 2, 5], [3, 3, 5], [4, 3, 5]],
    holes: [
      { x: 1, y: 4, c: 0, cells: [[0, 0]], need: 3 },
      { x: 3, y: 4, c: 5, cells: [[0, 0], [1, 0]], need: 4 },
    ],
    solution: [[0, 'UUU'], [1, 'UU']],
  },
  // 3: the first dependency — a row of blue cats walls the red hole off from its cats; clear it first.
  {
    w: 5,
    h: 6,
    grid: ['.....', '.....', '.....', '.....', '.....', '.....'],
    cats: [[1, 1, 0], [2, 1, 0], [3, 1, 0], [0, 2, 5], [1, 2, 5], [2, 2, 5], [3, 2, 5], [4, 2, 5]],
    holes: [
      { x: 2, y: 5, c: 0, cells: [[0, 0]], need: 3 },
      { x: 0, y: 3, c: 5, cells: [[0, 0]], need: 5 },
    ],
    solution: [[1, 'URRRR'], [0, 'UUUULRR']],
  },
];

function parseArgs(argv) {
  const out = { only: 0, dry: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') out.only = Number(argv[++i]);
    else if (argv[i] === '--dry') out.dry = true;
  }
  return out;
}

function makeLevel(n) {
  if (n <= TUTORIALS.length) {
    const t = TUTORIALS[n - 1];
    const def = { id: n, w: t.w, h: t.h, grid: t.grid, cats: t.cats, holes: t.holes, solution: t.solution };
    const ev = evaluateLevel(def, { playouts: 32, seed: n });
    def.stats = { moves: def.solution.length, steps: ev.steps, trapRate: ev.trapRate, deepTrapRate: ev.smartTrapRate };
    return def;
  }
  const P = levelParams(n);
  const def = generateLevel(P, levelSeed(n));
  def.stats = {
    moves: def.stats.moves,
    steps: def.stats.steps,
    trapRate: def.stats.trapRate,
    deepTrapRate: def.stats.smartTrapRate,
  };
  return def;
}

function check(def) {
  compileLevel(def);
  if (!verifySolution(def, def.solution)) throw new Error(`level ${def.id}: stored solution does not win`);
  const ev = evaluateLevel(def, { playouts: 0, maxNodes: 50000 });
  if (!ev.solvable) throw new Error(`level ${def.id}: the solver found no solution`);
  if (!ev.startMoves) throw new Error(`level ${def.id}: no productive move at the start`);
  return ev;
}

function features(def) {
  const f = [];
  const mods = (k) => def.cats.filter((c) => c[3] && c[3][k]).length;
  if (mods('ice')) f.push(`ice${mods('ice')}`);
  if (mods('box')) f.push(`box${mods('box')}`);
  if (def.grid.some((r) => r.includes('L'))) f.push(`lock${def.grid.join('').split('L').length - 1}`);
  const ax = def.holes.filter((h) => h.axis).length;
  if (ax) f.push(`axis${ax}`);
  if (def.grid.some((r) => r.includes('#'))) f.push('walls');
  return f.join(' ');
}

const pad = (v, n) => String(v).padStart(n);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ids = args.only ? [args.only] : Array.from({ length: COUNT }, (_, i) => i + 1);
  const levels = [];
  console.log('  #  size  col holes cats need  mv steps trap deep start nodes   ms  features');
  const t0 = Date.now();
  for (const n of ids) {
    const t1 = Date.now();
    const def = makeLevel(n);
    const ev = check(def);
    const ms = Date.now() - t1;
    const maxNeed = Math.max(...def.holes.map((h) => h.need));
    levels.push(def);
    const st = def.stats;
    const cols = [
      pad(n, 3),
      pad(`${def.w}x${def.h}`, 5),
      pad(ev.colors, 4),
      pad(ev.holes, 5),
      pad(ev.cats, 4),
      pad(maxNeed, 4),
      pad(st.moves, 3),
      pad(st.steps, 5),
      pad(st.trapRate.toFixed(2), 4),
      pad(st.deepTrapRate.toFixed(2), 4),
      pad(ev.startHoles, 5),
      pad(ev.nodes, 5),
      pad(ms, 4),
    ];
    console.log(`${cols.join(' ')}  ${def.hard ? 'HARD ' : ''}${features(def)}`);
  }
  console.log(`generated ${levels.length} level(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (args.only || args.dry) return;
  const lines = levels.map((d) => JSON.stringify(d));
  const src =
    '// GENERATED by tools/gen-levels.mjs (npm run levels) — do not edit by hand.\n' +
    '// One level per line: { id, w, h, hard?, grid, cats, holes, solution, stats } (format: rules.js compileLevel).\n' +
    `export const LEVELS = [\n${lines.join(',\n')},\n];\n`;
  fs.writeFileSync(OUT, src);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${(Buffer.byteLength(src) / 1024).toFixed(1)} KB)`);
}

main();
