// Builds src/core/level-data.js: 3 hand-made tutorials + levels 4..100 from the generator's campaign curve
// (levelParams). Every level is compiled, its stored solution replayed with the real rules and solved by the
// hint solver before it is written. Prints a summary table.
// Usage: npm run levels            (node tools/gen-levels.mjs [--only <n>] [--dry])
//   --only <n>  generate and print level n only (nothing is written)
//   --dry       print the table without writing the file
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLevel, levelParams, levelSeed, evaluateLevel, verifyDrags } from '../src/core/generator.js';
import { compileLevel } from '../src/core/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'core', 'level-data.js');
const COUNT = 100;

const blank = (w, h) => Array.from({ length: h }, () => '.'.repeat(w));

/**
 * Hand-made tutorials: tiny packed boards, one clear drag per hole (colours: 0 red, 1 orange, 2 yellow,
 * 3 lime, 4 cyan, 5 blue, 6 purple, 7 pink, 8 white, 9 navy, 10 brown, 11 grey).
 */
const TUTORIALS = [
  // 1: two square holes; pull each one straight up through its cats.
  {
    w: 4,
    h: 5,
    grid: blank(4, 5),
    cats: [[0, 0, 0], [3, 0, 3], [0, 1, 0], [1, 1, 0], [2, 1, 3], [1, 2, 0], [2, 2, 3], [3, 2, 3]],
    holes: [
      { x: 0, y: 3, c: 0, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], need: 4 },
      { x: 2, y: 3, c: 3, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], need: 4 },
    ],
    solution: [[0, 'UUU'], [1, 'UUU']],
  },
  // 2: three shapes, each with one straight drag in its own direction.
  {
    w: 4,
    h: 5,
    grid: blank(4, 5),
    cats: [[0, 0, 5], [1, 0, 5], [2, 0, 2], [1, 1, 5], [2, 1, 2], [2, 2, 2], [1, 4, 4], [2, 4, 4], [3, 4, 4]],
    holes: [
      { x: 0, y: 2, c: 5, cells: [[0, 0], [1, 0], [0, 1]], need: 3 },
      { x: 3, y: 0, c: 2, cells: [[0, 0], [0, 1], [0, 2]], need: 3 },
      { x: 1, y: 3, c: 4, cells: [[0, 0], [1, 0], [2, 0]], need: 3 },
    ],
    solution: [[0, 'UU'], [1, 'L'], [2, 'D']],
  },
  // 3: the first dependency: the cyan hole is walled in until the yellow one has eaten its way through.
  {
    w: 4,
    h: 6,
    grid: blank(4, 6),
    cats: [[1, 0, 4], [2, 0, 4], [1, 1, 2], [2, 1, 2], [2, 2, 2], [3, 2, 2], [3, 3, 4], [0, 4, 6], [3, 4, 4], [0, 5, 6]],
    holes: [
      { x: 0, y: 2, c: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], need: 4 },
      { x: 1, y: 4, c: 6, cells: [[0, 0], [0, 1]], need: 2 },
      { x: 2, y: 3, c: 4, cells: [[0, 0], [0, 1], [0, 2], [1, 2]], need: 4 },
    ],
    solution: [[0, 'URR'], [1, 'L'], [2, 'UUUL']],
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
    const def = { id: n, w: t.w, h: t.h, grid: t.grid, cats: t.cats, holes: t.holes, par: t.solution.length, solution: t.solution };
    const ev = evaluateLevel(def, { playouts: 32, seed: n });
    def.stats = {
      steps: ev.steps,
      difficulty: Math.round(ev.difficulty * 100) / 100,
      stalls: Math.round(ev.stalls * 100) / 100,
      startHoles: ev.startHoles,
    };
    return def;
  }
  return generateLevel(levelParams(n), levelSeed(n));
}

function check(def) {
  compileLevel(def);
  if (!verifyDrags(def, def.solution)) throw new Error(`level ${def.id}: stored solution does not win (with endMove after each drag)`);
  if (def.solution.length !== def.par) throw new Error(`level ${def.id}: ${def.solution.length} drags but par ${def.par}`);
  const ev = evaluateLevel(def, { playouts: 0, maxNodes: 50000 });
  if (!ev.solvable) throw new Error(`level ${def.id}: the solver found no solution`);
  if (!ev.startMoves) throw new Error(`level ${def.id}: no productive move at the start`);
  return ev;
}

function features(def) {
  const f = [];
  const mods = (k) => def.cats.filter((c) => c[3] && c[3][k]).length;
  const layered = def.holes.filter((h) => h.next && h.next.length);
  if (layered.length) f.push(`layers${layered.map((h) => h.next.length + 1).join('+')}`);
  if (mods('ice')) f.push(`ice${mods('ice')}`);
  if (mods('box')) f.push(`box${mods('box')}`);
  if (mods('hungry')) f.push(`hungry${mods('hungry')}`);
  if (def.gates && def.gates.length) f.push(`gates${def.gates.length}`);
  if (def.holes.some((h) => h.cells.length === 5)) f.push('penta');
  if (def.grid.some((r) => r.includes('L'))) f.push(`lock${def.grid.join('').split('L').length - 1}`);
  const ax = def.holes.filter((h) => h.axis).length;
  if (ax) f.push(`axis${ax}`);
  if (def.grid.some((r) => r.includes('#') || r.includes('_'))) f.push('shape');
  return f.join(' ');
}

const pad = (v, n) => String(v).padStart(n);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ids = args.only ? [args.only] : Array.from({ length: COUNT }, (_, i) => i + 1);
  const levels = [];
  console.log('  #  size col holes cats empty   par steps  diff stalls start mosaic nodes   ms  features');
  const t0 = Date.now();
  for (const n of ids) {
    const t1 = Date.now();
    const def = makeLevel(n);
    const ev = check(def);
    const ms = Date.now() - t1;
    levels.push(def);
    const st = def.stats;
    const cols = [
      pad(n, 3),
      pad(`${def.w}x${def.h}`, 5),
      pad(ev.colors, 3),
      pad(ev.holes, 5),
      pad(ev.cats, 4),
      pad(ev.empty - (def.gates ? def.gates.length : 0), 5), // free cells (gates are not free)
      pad(def.par, 5),
      pad(st.steps, 5),
      pad(st.difficulty.toFixed(2), 5),
      pad(st.stalls.toFixed(2), 6),
      pad(st.startHoles, 5),
      pad(ev.mosaic.toFixed(2), 6),
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
    '// One level per line: { id, w, h, hard?, grid, cats, holes, gates?, par, solution, stats } (format: rules.js\n' +
    '// compileLevel; solution = par drags [hole, path], one entry per drag).\n' +
    `export const LEVELS = [\n${lines.join(',\n')},\n];\n`;
  fs.writeFileSync(OUT, src);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${(Buffer.byteLength(src) / 1024).toFixed(1)} KB)`);
}

main();
