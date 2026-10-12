// Rewrites the generated block of sw.js (between `// <precache>` and `// </precache>`):
//   ASSETS  = './', index.html, css/**, src/**, fonts/*.woff2, icons/**, manifest.webmanifest
//             (only files that exist; dotfiles, node_modules, *.md, *.log, package*.json, OS junk skipped),
//             sorted by code point;
//   VERSION = first 10 hex chars of sha-256 over those files (path + bytes) and over sw.js itself with the
//             generated block left out, so any change to an asset or to the worker code yields a new version.
// Idempotent: running it again without changes leaves sw.js byte-identical.
// It also warns about things that break only on GitHub Pages / offline: upper-case paths, and relative
// imports / src / href / url() references whose target is missing, differs in case, or is not precached.
//
// Usage: node tools/stamp-sw.mjs [rootDir] [--check]
//   rootDir  defaults to the project root (the folder above tools/)
//   --check  do not write; exit with code 1 if sw.js is not up to date
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '// <precache>';
const END = '// </precache>';
const JUNK = new Set(['node_modules', 'thumbs.db', 'desktop.ini']);

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function skipped(name) {
  const n = name.toLowerCase();
  return n.startsWith('.') || JUNK.has(n) || n.endsWith('.md') || n.endsWith('.log') || /^package.*\.json$/.test(n);
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(root, rel, out) {
  for (const e of listDir(path.join(root, rel))) {
    if (skipped(e.name)) continue;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.push(r);
  }
}

/** Relative (posix) paths of every precached file, sorted. */
export function collectFiles(root) {
  const files = [];
  for (const rel of ['index.html', 'manifest.webmanifest']) {
    const st = fs.statSync(path.join(root, rel), { throwIfNoEntry: false });
    if (st && st.isFile()) files.push(rel);
  }
  walk(root, 'css', files);
  walk(root, 'src', files);
  walk(root, 'icons', files);
  for (const e of listDir(path.join(root, 'fonts'))) {
    if (e.isFile() && !skipped(e.name) && e.name.toLowerCase().endsWith('.woff2')) files.push(`fonts/${e.name}`);
  }
  return files.sort(byCodePoint);
}

function findBlock(src) {
  const a = src.indexOf(START);
  const b = a < 0 ? -1 : src.indexOf(END, a + START.length);
  return a < 0 || b < 0 ? null : { a, b: b + END.length };
}

const urlOf = (rel) => './' + rel.split('/').map(encodeURIComponent).join('/');
const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Computes the stamped sw.js text for `root`.
 * @returns {{ next: string, current: string, version: string, assets: string[], files: string[], bytes: number }}
 */
export function stamp(root) {
  const swPath = path.join(root, 'sw.js');
  const current = fs.readFileSync(swPath, 'utf8');
  const block = findBlock(current);
  if (!block) throw new Error(`sw.js has no "${START}" … "${END}" block`);
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const template = current.slice(0, block.a) + START + eol + END + current.slice(block.b);

  const files = collectFiles(root);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(root, rel));
    bytes += buf.length;
    hash.update(`${rel}\0${buf.length}\0`);
    hash.update(buf);
  }
  hash.update('sw.js\0');
  hash.update(template);
  const version = hash.digest('hex').slice(0, 10);

  const assets = (files.includes('index.html') ? ['./'] : []).concat(files.map(urlOf));
  const lines = [
    START,
    `const VERSION = '${version}';`,
    'const ASSETS = [',
    ...assets.map((u) => `  ${quote(u)},`),
    '];',
    END,
  ];
  const next = current.slice(0, block.a) + lines.join(eol) + current.slice(block.b);
  return { next, current, version, assets, files, bytes };
}

/** True when `rel` exists under root with exactly this letter case (GitHub Pages is case-sensitive). */
function existsExact(root, rel) {
  let dir = root;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const entry = listDir(dir).find((e) => e.name === parts[i]);
    if (!entry) return false;
    if (i < parts.length - 1 && !entry.isDirectory()) return false;
    dir = path.join(dir, parts[i]);
  }
  return true;
}

const REF_PATTERNS = {
  '.js': /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\1/g,
  '.html': /\b(?:src|href)\s*=\s*(['"])([^'"\n]*)\1/g,
  '.css': /url\(\s*(['"]?)([^'")\n]+)\1\s*\)/g,
};

/** Human-readable problems that would only show up after deploying (or offline). */
export function lint(root, files) {
  const warnings = [];
  const set = new Set(files);
  for (const rel of files) {
    if (/[A-Z]/.test(rel)) warnings.push(`${rel}: upper-case letters in a path (keep file names lower-case)`);
    if (/[^A-Za-z0-9._\-/]/.test(rel)) warnings.push(`${rel}: unusual characters in a path`);
    const pattern = REF_PATTERNS[path.extname(rel).toLowerCase()];
    if (!pattern) continue;
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of text.matchAll(pattern)) {
      const spec = m[2].trim();
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(spec)) continue; // absolute URL, data:, fragment
      if (spec.startsWith('/')) {
        warnings.push(`${rel}: "${spec}" starts with "/" (breaks under the /DropTheCat/ sub-path; use "./")`);
        continue;
      }
      if (rel.endsWith('.js') && !spec.startsWith('.')) continue; // bare specifier: not ours to judge
      let clean = spec.split(/[?#]/)[0];
      try {
        clean = decodeURI(clean);
      } catch {
        // keep it encoded
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), clean)).replace(/\/$/, '');
      if (target === '.' || target === '' || target === 'index.html') continue;
      if (target.startsWith('..')) {
        warnings.push(`${rel}: "${spec}" points outside the app folder`);
      } else if (!set.has(target)) {
        const why = existsExact(root, target) ? 'is not precached (fails offline)'
          : fs.existsSync(path.join(root, target)) ? 'differs in letter case from the file on disk (404 on GitHub Pages)'
            : 'does not exist';
        warnings.push(`${rel}: "${spec}" ${why}`);
      } else if (!existsExact(root, target)) {
        warnings.push(`${rel}: "${spec}" differs in letter case from the file on disk (404 on GitHub Pages)`);
      }
    }
  }
  return warnings;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const rootArg = args.find((a) => !a.startsWith('--'));
  const root = path.resolve(rootArg || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  let result;
  try {
    result = stamp(root);
  } catch (err) {
    console.error(`stamp-sw: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const { next, current, version, assets, files, bytes } = result;
  for (const w of lint(root, files)) console.warn(`stamp-sw: warning: ${w}`);
  if (!files.includes('index.html')) console.warn('stamp-sw: note: index.html does not exist yet (re-run after it is added)');
  const changed = next !== current;
  const summary = `VERSION ${version}, ${assets.length} URLs, ${files.length} files, ${(bytes / 1024).toFixed(1)} KB`;
  if (check) {
    console.log(`stamp-sw: ${summary} — ${changed ? 'OUT OF DATE (run npm run stamp)' : 'up to date'}`);
    if (changed) process.exitCode = 1;
    return;
  }
  if (changed) fs.writeFileSync(path.join(root, 'sw.js'), next);
  console.log(`stamp-sw: ${summary} — sw.js ${changed ? 'updated' : 'unchanged'}`);
}

function isMain() {
  try {
    const norm = (p) => {
      const real = fs.realpathSync(p);
      return process.platform === 'win32' ? real.toLowerCase() : real;
    };
    return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
