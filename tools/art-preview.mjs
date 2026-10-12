// Screenshots the art showcase (tools/art-preview.html) with the installed Chrome and reports drawing speed.
// Usage: node tools/art-preview.mjs [--cells 32,44,56,72] [--dprs 2,3] [--scenes board,sheet,zoom]
//                                   [--rows fall,closing] [--t 1.3] [--marks] [--no-bench] [--bench-only] [--no-icon] [--port 8123]
// Output: tests/e2e/out/art/<scene>-<cell>@<dpr>x.png, icon.png (home-screen look, maskable-zone crop, favicon size)
// and perf numbers on stdout.
// Starts tools/serve.mjs itself (ES modules need http) and stops it when done.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'tests/e2e/out/art');
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const list = (name, def) => opt(name, def).split(',').map((s) => s.trim()).filter(Boolean);
const cells = list('--cells', '32,44,56,72').map(Number);
const dprs = list('--dprs', '2,3').map(Number);
const scenes = args.includes('--bench-only') ? [] : list('--scenes', 'board,sheet');
const rows = opt('--rows', '');
const T = opt('--t', '');
const marks = args.includes('--marks');
const bench = !args.includes('--no-bench');
const port = Number(opt('--port', '8123'));

function startServer() {
  const child = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('serve.mjs did not start in 10 s')), 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/localhost:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve({ child, base: `http://localhost:${m[1]}/` });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve.mjs exited (${code})`));
    });
  });
}

async function open(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true || !!window.__error, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error(`${url}\n${err}`);
}

const { child, base } = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  await fs.mkdir(outDir, { recursive: true });
  for (const dpr of dprs) {
    const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1000, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    for (const cell of cells) {
      for (const scene of scenes) {
        const q = `scene=${scene}&cell=${cell}${rows ? `&rows=${rows}` : ''}${T ? `&t=${T}` : ''}${marks ? '&marks=1' : ''}`;
        await open(page, `${base}tools/art-preview.html?${q}`);
        const file = path.join(outDir, `${scene}${rows ? '-' + rows.replace(/,/g, '+') : ''}${marks ? '-marks' : ''}-${cell}@${dpr}x.png`);
        await page.locator('#root').screenshot({ path: file });
        console.log(`art-preview: ${path.relative(root, file)}`);
      }
    }
    if (bench) {
      for (const cell of [44, 56]) {
        await open(page, `${base}tools/art-preview.html?scene=bench&cell=${cell}`);
        const r = await page.evaluate(() => window.__bench);
        console.log(`bench cell ${r.cell}px @${r.dpr}x (8×10 board, ${r.cats} cats, ${r.holes} holes): ` +
          `JS ${r.jsMs} ms/frame, GPU canvas ${r.gpuMs} ms/frame, software canvas ${r.cpuMs} ms/frame; ` +
          `first frame (paints every sprite) ${r.coldFrameMs} ms, renderBoard ${r.renderBoardMs} ms, sprite cache ${r.cacheMPx} Mpx`);
      }
    }
    await context.close();
  }
  if (!args.includes('--bench-only') && !args.includes('--no-icon')) {
    // App icon as the launcher would show it, plus a circle-masked check of the maskable safe zone.
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1120, height: 540 } });
    const svg = await fs.readFile(path.join(root, 'icons/icon.svg'), 'utf8').catch(() => null);
    if (svg) {
      const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      // left: as an iOS home-screen icon (rounded corners); middle: maskable safe zone (centre 80% circle);
      // right: favicon size.
      await page.setContent(`<style>body{margin:0;display:flex;gap:20px;padding:10px;background:#EEE;align-items:center}
        img{display:block}.r{width:512px;height:512px;border-radius:22.5%}
        .m{width:410px;height:410px;border-radius:50%;overflow:hidden;position:relative;margin:51px;outline:2px dashed #888;outline-offset:51px}
        .m img{position:absolute;left:-51px;top:-51px;width:512px;height:512px}.f{width:32px;height:32px}</style>
        <img class="r" src="${url}"><div class="m"><img src="${url}"></div><img class="f" src="${url}">`);
      await page.locator('img').first().evaluate((img) => img.decode());
      const file = path.join(outDir, 'icon.png');
      await page.screenshot({ path: file });
      console.log(`art-preview: ${path.relative(root, file)}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  child.kill();
}
if (errors.length) {
  console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '));
  process.exitCode = 1;
}
