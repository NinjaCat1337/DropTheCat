// Browser checks with the installed Chrome: real touch drags that replay stored level solutions, undo /
// restart, stuck-free play, responsive layouts, settings and the offline PWA.
// Usage: npm run test:e2e   (DROPCAT_URL=http://host:port to test an already running server)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../../tools/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'tests/e2e/out');
await fs.mkdir(out, { recursive: true });
let server = null;
let browser = null;
let base = process.env.DROPCAT_URL;
const errors = [];

function watch(page) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
}

async function open(page, query = '?debug=1&nosave=1') {
  await page.goto(`${base}/${query}`);
  await page.waitForFunction(() => window.__dropcat && window.__dropcat.screen);
  await page.evaluate(() => document.fonts.ready);
}

async function play(page, n) {
  await page.evaluate((lvl) => window.__dropcat.startLevel(lvl, { resume: false }), n);
  await page.waitForFunction(() => window.__dropcat.scene.layout && window.__dropcat.scene.layout.cell > 0);
  await page.waitForTimeout(150);
}

/** Drags hole k along a path string (R/L/U/D) with real touch input, cell by cell. */
async function dragPath(page, k, moves, cdp) {
  const start = await page.evaluate((hole) => {
    const app = window.__dropcat;
    const g = app.game;
    const [dx, dy] = g.holeCells(hole)[0];
    return app.cellCenter(g.hx[hole] + dx, g.hy[hole] + dy);
  }, k);
  let { x, y } = start;
  const step = start.cell;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const ch of moves) {
    const tx = x + (ch === 'R' ? step : ch === 'L' ? -step : 0);
    const ty = y + (ch === 'D' ? step : ch === 'U' ? -step : 0);
    for (let i = 1; i <= 4; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + ((tx - x) * i) / 4, y: y + ((ty - y) * i) / 4 }] });
    }
    x = tx;
    y = ty;
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(40);
}

async function replaySolution(page, cdp) {
  const solution = await page.evaluate(() => window.__dropcat.def.solution);
  assert.ok(Array.isArray(solution) && solution.length, 'level has a stored solution');
  for (const [k, moves] of solution) await dragPath(page, k, moves, cdp);
}

try {
  if (!base) {
    server = spawn(process.execPath, ['tools/serve.mjs', '--port', '8096'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Local server did not start')), 10000);
      server.once('error', reject);
      server.stdout.on('data', (data) => {
        const match = String(data).match(/http:\/\/localhost:\d+\//);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0].replace(/\/$/, ''));
        }
      });
    });
  }
  base = base.replace(/\/$/, '');
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  watch(page);
  await open(page);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.title(), 'Meow Drop · DropTheCat');
  assert.doesNotMatch(await page.locator('body').textContent(), /[А-Яа-яЁё]/);
  await page.screenshot({ path: path.join(out, 'home.png') });

  // Level 1 from the home screen, solved with real touch drags; the win card leads to level 2.
  await page.locator('#btn-play').click({ force: true });
  await page.waitForFunction(() => window.__dropcat.screen === 'game' && window.__dropcat.scene.layout);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, 'level-1.png') });
  const cdp = await context.newCDPSession(page);
  await replaySolution(page, cdp);
  await page.locator('#win.open').waitFor();
  let st = await page.evaluate(() => window.__dropcat.state());
  assert.equal(st.won, true);
  assert.equal(st.catsLeft, 0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'win.png') });
  await page.locator('#btn-next').click({ force: true });
  await page.waitForFunction(() => window.__dropcat.state().level === 2 && !window.__dropcat.state().won);
  console.log('PASS level 1 by touch, win card, next level');

  // Every stored solution of the first levels wins through the real input path.
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18, 28, 50]) {
    await play(page, n);
    await replaySolution(page, cdp);
    await page.waitForFunction(() => window.__dropcat.state().won, null, { timeout: 5000 });
    const w = await page.evaluate(() => window.__dropcat.state());
    if (w.par) assert.equal(w.lastWin.stars, 3, `level ${n}: the stored solution (${w.lastWin.moves} drags) earns 3 stars (par ${w.par})`);
    if (n === 12) await page.screenshot({ path: path.join(out, 'level-12-won.png') });
  }
  console.log('PASS levels 2–12, 18, 28, 50 replayed by touch, each for 3 stars');

  // Tapping something on the board explains it.
  await play(page, 18);
  const gateAt = await page.evaluate(() => {
    const [x, y] = window.__dropcat.def.gates[0];
    return window.__dropcat.cellCenter(x, y);
  });
  await page.mouse.click(gateAt.x, gateAt.y);
  await page.waitForFunction(() => {
    const tip = document.querySelector('#tip');
    return !tip.hidden && /only the \w+ hole can pass/.test(tip.textContent);
  });
  console.log('PASS tapping a gate explains it');

  // Undo and restart.
  await play(page, 6);
  const fresh = await page.evaluate(() => window.__dropcat.game.stateKey());
  const solution = await page.evaluate(() => window.__dropcat.def.solution);
  await dragPath(page, solution[0][0], solution[0][1], cdp);
  st = await page.evaluate(() => window.__dropcat.state());
  assert.equal(st.undo, 1);
  await page.locator('#btn-undo').click({ force: true });
  assert.equal(await page.evaluate(() => window.__dropcat.game.stateKey()), fresh);
  await dragPath(page, solution[0][0], solution[0][1], cdp);
  await page.locator('#btn-restart').click({ force: true });
  assert.equal(await page.evaluate(() => window.__dropcat.game.stateKey()), fresh);
  await page.locator('#btn-undo').click({ force: true });
  assert.notEqual(await page.evaluate(() => window.__dropcat.game.stateKey()), fresh, 'undo brings back the pre-restart board');
  console.log('PASS undo, restart, undo after restart');

  // Hint booster: shows a path and costs one hint.
  const hintsBefore = (await page.evaluate(() => window.__dropcat.state())).boosters.hint;
  await page.locator('#btn-hint').click({ force: true });
  await page.waitForFunction(() => !!window.__dropcat.scene.hint);
  assert.equal((await page.evaluate(() => window.__dropcat.state())).boosters.hint, hintsBefore - 1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'hint.png') });
  console.log('PASS hint');

  // Layouts: the board and both bars fit inside the screen at common sizes.
  for (const [width, height] of [[390, 844], [375, 667], [320, 568], [430, 932], [844, 390], [1365, 900]]) {
    await page.setViewportSize({ width, height });
    for (const n of [1, 30, 80]) {
      await play(page, n);
      const g = await page.evaluate(() => {
        const L = window.__dropcat.scene.layout;
        const top = document.querySelector('#topbar').getBoundingClientRect();
        const tools = document.querySelector('#tools').getBoundingClientRect();
        const d = window.__dropcat.def;
        return { L, top: top.bottom, tools: { top: tools.top, left: tools.left, w: tools.width, h: tools.height }, w: d.w, h: d.h };
      });
      const { L } = g;
      assert.ok(L.x >= 0 && L.y >= g.top - 1, `${width}×${height} L${n}: board below the top bar`);
      assert.ok(L.x + L.w <= width && L.y + L.h <= height, `${width}×${height} L${n}: board on screen`);
      const side = g.tools.left > width * 0.55 && g.tools.h > g.tools.w;
      if (side) assert.ok(L.x + L.w <= g.tools.left + 1, `${width}×${height} L${n}: board left of the tools`);
      else assert.ok(L.y + L.h <= g.tools.top + 1, `${width}×${height} L${n}: board above the tools`);
      assert.ok(L.cell >= 24, `${width}×${height} L${n}: cells are touchable (${L.cell}px)`);
    }
    await page.screenshot({ path: path.join(out, `layout-${width}x${height}.png`) });
  }
  console.log('PASS layouts at six screen sizes');

  // Settings: sound toggle.
  await page.setViewportSize({ width: 390, height: 844 });
  await play(page, 3);
  await page.locator('#btn-settings-game').click({ force: true });
  await page.locator('#settings.open').waitFor();
  await page.locator('[data-toggle="sound"]').click({ force: true });
  assert.equal(await page.locator('[data-toggle="sound"]').getAttribute('aria-checked'), 'false');
  await page.locator('[data-toggle="sound"]').click({ force: true });
  await page.screenshot({ path: path.join(out, 'settings.png') });
  await page.locator('#btn-settings-close').click({ force: true });
  await page.locator('#settings').waitFor({ state: 'hidden' });
  console.log('PASS settings');

  // Sound comes back after the app was in the background (iOS can leave a silent "running" context):
  // the first tap afterwards builds a fresh AudioContext.
  await page.waitForFunction(() => window.__dropcat.state().audio === 'running');
  const gen0 = await page.evaluate(() => window.__dropcat.state().audioGen);
  await page.evaluate(() => {
    const set = (v) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    set('hidden');
    set('visible');
  });
  await page.locator('#btn-settings-game').click({ force: true });
  await page.locator('#settings.open').waitFor();
  await page.waitForFunction((g) => {
    const st = window.__dropcat.state();
    return st.audioGen === g + 1 && st.audio === 'running';
  }, gen0);
  await page.locator('#btn-settings-close').click({ force: true });
  await page.locator('#settings').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__dropcat.state().audioGen), gen0 + 1, 'one rebuild, not one per tap');
  console.log('PASS sound restarts after the app was in the background');
  await context.close();

  // Save & resume: a move survives a reload.
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const p2 = await ctx2.newPage();
  watch(p2);
  await open(p2, '?debug=1&level=5');
  await p2.locator('#btn-play').click({ force: true });
  await p2.waitForFunction(() => window.__dropcat.screen === 'game' && window.__dropcat.scene.layout);
  const cdp2 = await ctx2.newCDPSession(p2);
  const sol5 = await p2.evaluate(() => window.__dropcat.def.solution);
  await dragPath(p2, sol5[0][0], sol5[0][1], cdp2);
  const savedKey = await p2.evaluate(() => window.__dropcat.game.stateKey());
  await open(p2, '?debug=1');
  await p2.locator('#btn-play').click({ force: true });
  await p2.waitForFunction(() => window.__dropcat.screen === 'game' && window.__dropcat.game);
  assert.equal(await p2.evaluate(() => window.__dropcat.state().level), 5);
  assert.equal(await p2.evaluate(() => window.__dropcat.game.stateKey()), savedKey);
  assert.equal(await p2.evaluate(() => window.__dropcat.undoCount), 1);
  await ctx2.close();
  console.log('PASS save and resume mid-level');

  // Offline: install the service worker, then reload without network.
  const offline = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p3 = await offline.newPage();
  watch(p3);
  await open(p3, '?debug=1&nosave=1');
  await p3.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  await offline.setOffline(true);
  await p3.reload();
  await p3.waitForFunction(() => window.__dropcat && window.__dropcat.screen === 'home');
  await p3.locator('#btn-play').click({ force: true });
  await p3.waitForFunction(() => window.__dropcat.screen === 'game' && window.__dropcat.scene.layout);
  await offline.close();
  console.log('PASS offline PWA');

  assert.deepEqual(errors, []);
  console.log(`Browser checks passed. Screenshots: ${out}`);
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
