// App controller: screens (home, game, overlays), pointer input on the board, undo / restart / boosters,
// saving, sounds and haptics. The rules live in core/rules.js, the drawing in scene.js and art.js.
import { Game } from '../core/rules.js';
import { getLevel, isHardLevel } from '../core/levels.js';
import { hint as findHint } from '../core/solver.js';
import { newProgress, sanitizeProgress, completeLevel, useBooster, buyBooster, markTip, PRICES } from '../core/progress.js';
import { createArt, PALETTE } from './art.js';
import { createScene } from './scene.js';
import { createSlide } from './slide.js';
import { fitBoard, freeArea } from './layout.js';
import { createAudio } from '../platform/audio.js';
import { createHaptics } from '../platform/haptics.js';
import { installTouchGuards, onViewportChange, isIOS, isStandalone } from '../platform/device.js';
import { KEYS, loadJSON, saveJSON, removeKey, requestPersistence } from '../platform/storage.js';
import { initServiceWorker } from '../platform/pwa.js';

const VERSION = '1.0';
const UNDO_LIMIT = 80;
const SAVED_UNDO = 30;
const WIN_TITLES = ['Purrfect!', 'Meowvelous!', 'Pawsome!', 'Clawsome!', 'Fur-tastic!', 'Hiss-toric!', 'Meow-gical!'];
const TIP_MS = 6000;

// One-time tips, shown on the first level that needs them.
const TIPS = [
  { id: 'drag', test: (n) => n === 1, text: 'Drag the hole under the cats of its colour' },
  { id: 'two', test: (n) => n === 2, text: 'Each hole only takes cats of its own colour' },
  { id: 'order', test: (n) => n === 3, text: 'Other cats block the way — clear them first' },
  { id: 'ice', test: (n, d) => d.cats.some((c) => c[3] && c[3].ice), text: 'Frozen cats thaw as other cats drop — watch the number' },
  { id: 'box', test: (n, d) => d.cats.some((c) => c[3] && c[3].box), text: 'A box opens when a cat next to it drops' },
  { id: 'axis', test: (n, d) => d.holes.some((h) => h.axis), text: 'Holes with arrows slide only that way' },
  { id: 'lock', test: (n, d) => d.grid.some((r) => r.includes('L')), text: 'Drop the cat with the key to open the crates' },
  {
    id: 'twins',
    test: (n, d) => new Set(d.holes.map((h) => h.c)).size < d.holes.length,
    text: 'A hole closes when it is full — choose wisely which hole takes which cats',
  },
];

const snapToJSON = (s) => ({
  color: Array.from(s.color), flags: Array.from(s.flags), ice: Array.from(s.ice),
  hx: Array.from(s.hx), hy: Array.from(s.hy), need: Array.from(s.need), locked: s.locked, dropped: s.dropped,
});

/**
 * @param {{ root: HTMLElement, nosave?: boolean, debug?: boolean, firstLevel?: number | null }} opts
 *   firstLevel: debug override of the level to play next
 */
export function createApp({ root, nosave = false, debug = false, firstLevel = null }) {
  const $ = (sel) => root.querySelector(sel);
  const canvas = $('#game');
  const art = createArt();
  const scene = createScene(canvas, art);
  const homeArt = createArt();
  const winArt = createArt();
  const audio = createAudio();
  const haptics = createHaptics();
  const settings = { sound: true, haptics: true };
  const saved = nosave ? null : loadJSON(KEYS.settings, null);
  if (saved && typeof saved === 'object') {
    if (typeof saved.sound === 'boolean') settings.sound = saved.sound;
    if (typeof saved.haptics === 'boolean') settings.haptics = saved.haptics;
  }
  audio.muted = !settings.sound;
  haptics.enabled = settings.haptics;
  let progress = nosave ? newProgress() : sanitizeProgress(loadJSON(KEYS.progress, null));
  if (firstLevel) progress.level = firstLevel;

  let screen = 'home';
  let levelNo = progress.level;
  let def = null;
  let game = null;
  let initial = null;
  let undo = [];
  let drag = null;
  let tapCat = null;
  let treatMode = false;
  let won = false;
  let stuckTimer = 0;
  let tipTimer = 0;
  let tipSticky = false;
  let metrics = null;
  let raf = 0;
  let frameNo = 0;
  let streak = 0;
  let lastDropAt = -1e9;
  let haptic = 0;
  let interacted = false;
  let updater = null;
  let winAt = -1;
  let homeHop = [-1e9, -1e9, -1e9, -1e9, -1e9];
  let hintBusy = false;

  const now = () => performance.now();

  // ───────── persistence ─────────
  function saveProgress() {
    if (!nosave) saveJSON(KEYS.progress, progress);
  }

  function saveLevel() {
    if (nosave) return;
    if (!game || won) {
      removeKey(KEYS.level);
      return;
    }
    saveJSON(KEYS.level, { n: levelNo, game: game.toJSON(), undo: undo.slice(-SAVED_UNDO).map(snapToJSON) });
  }

  function persist() {
    saveProgress();
    saveLevel();
  }

  function restoreLevel(n, level) {
    if (nosave) return null;
    const data = loadJSON(KEYS.level, null);
    if (!data || data.n !== n) return null;
    const g = Game.fromJSON(level, data.game);
    if (!g || g.isWon()) return null;
    const stack = [];
    if (Array.isArray(data.undo)) {
      for (const j of data.undo) {
        const u = Game.fromJSON(level, { v: 1, ...j });
        if (u) stack.push(u.snapshot());
      }
    }
    return { game: g, undo: stack };
  }

  // ───────── HUD ─────────
  function setScreen(s) {
    screen = s;
    root.dataset.screen = s;
    if (s === 'home') renderHome();
    layout();
    wake();
  }

  function updateCoins() {
    for (const el of root.querySelectorAll('[data-coins]')) el.textContent = String(progress.coins);
  }

  function updateTools() {
    const badge = (kind) => {
      const el = root.querySelector(`[data-count="${kind}"]`);
      const n = progress.boosters[kind];
      el.textContent = n > 0 ? String(n) : '+';
      el.classList.toggle('plus', n <= 0);
    };
    badge('hint');
    badge('treat');
    $('#btn-undo').disabled = undo.length === 0;
    $('#btn-treat').classList.toggle('active', treatMode);
    updateCoins();
  }

  function showTip(text, { sticky = false, ms = TIP_MS } = {}) {
    const el = $('#tip');
    clearTimeout(tipTimer);
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('hide');
    tipSticky = sticky;
    if (!sticky) tipTimer = setTimeout(hideTip, ms);
  }

  function hideTip() {
    const el = $('#tip');
    clearTimeout(tipTimer);
    tipSticky = false;
    if (el.hidden) return;
    el.classList.add('hide');
    tipTimer = setTimeout(() => {
      el.hidden = true;
    }, 300);
  }

  // An overlay counts as open from openOverlay() until closeOverlay(), not while it fades out.
  function anyOverlay() {
    return ['#win', '#stuck', '#buy', '#settings'].some((id) => $(id).dataset.open === '1');
  }

  function openOverlay(id) {
    const el = $(id);
    el.hidden = false;
    el.dataset.open = '1';
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  }

  function closeOverlay(id) {
    const el = $(id);
    if (el.hidden) return;
    delete el.dataset.open;
    el.classList.remove('open');
    setTimeout(() => {
      if (!el.classList.contains('open')) el.hidden = true;
    }, 260);
  }

  // ───────── home ─────────
  function renderHome() {
    updateCoins();
    const n = progress.level;
    const trail = $('#trail');
    trail.textContent = '';
    const from = Math.max(1, n - 2);
    for (let i = from; i <= from + 4; i++) {
      if (i > from) {
        const paw = document.createElement('li');
        paw.className = 'paw';
        paw.setAttribute('aria-hidden', 'true');
        trail.appendChild(paw);
      }
      const li = document.createElement('li');
      li.className = 'node';
      if (i < n) li.classList.add('done');
      if (i === n) li.classList.add('current');
      if (isHardLevel(i) && i >= n) li.classList.add('hard');
      li.textContent = i < n ? '✓' : String(i);
      li.setAttribute('aria-label', `Level ${i}${i < n ? ', done' : i === n ? ', next' : ''}`);
      trail.appendChild(li);
    }
    const play = $('#btn-play');
    play.textContent = `Level ${n}`;
    play.classList.toggle('hard', isHardLevel(n));
  }

  function sizeCanvas(c, w, h, dpr) {
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
  }

  const HOME_COLORS = [0, 2, 5, 3, 7];

  function drawHome(t) {
    const c = $('#home-cats');
    const r = c.getBoundingClientRect();
    if (!r.width || !metrics) return;
    sizeCanvas(c, r.width, r.height, metrics.dpr);
    const cell = Math.min(r.width / 5.4, r.height * 0.82);
    if (homeArt.__cell !== cell) {
      homeArt.setMetrics({ cell, dpr: metrics.dpr });
      homeArt.__cell = cell;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const gap = r.width / 5;
    HOME_COLORS.forEach((col, i) => {
      const hp = (t - homeHop[i]) / 600;
      const bob = Math.sin(t / 700 + i * 1.3) * cell * 0.03;
      homeArt.drawCat(ctx, gap * (i + 0.5), r.height - cell * 0.55 + bob, col, {
        t: t / 1000, seed: 11 + i * 7, mood: hp >= 0 && hp < 1 ? 'happy' : 'idle', hop: hp >= 0 && hp < 1 ? hp : 0,
      });
    });
  }

  function drawWinCat(t) {
    const c = $('#win-cat');
    const r = c.getBoundingClientRect();
    if (!r.width || !metrics) return;
    sizeCanvas(c, r.width, r.height, metrics.dpr);
    const cell = Math.min(r.width, r.height) * 0.78;
    if (winArt.__cell !== cell) {
      winArt.setMetrics({ cell, dpr: metrics.dpr });
      winArt.__cell = cell;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const p = ((t - winAt) % 1300) / 1300;
    const color = def && def.holes.length ? def.holes[0].c : 1;
    winArt.drawCat(ctx, r.width / 2, r.height - cell * 0.55, color, { t: t / 1000, seed: 3, mood: 'happy', hop: p < 0.55 ? p / 0.55 : 0 });
  }

  // ───────── layout & loop ─────────
  function layout() {
    if (!metrics) return;
    if (screen !== 'game' || !def) return;
    const top = $('#topbar').getBoundingClientRect();
    const tools = $('#tools').getBoundingClientRect();
    const free = freeArea(metrics.width, metrics.height, top, tools);
    // Keep a band for tip banners under the top bar when that costs no board size (tall phones).
    let fit = fitBoard(free, def.w, def.h);
    const band = Math.min(64, free.h * 0.12);
    const banded = fitBoard({ ...free, y: free.y + band, h: free.h - band }, def.w, def.h);
    if (banded.cell >= fit.cell) fit = banded;
    // No room for the band (small phones): tips go into the top bar instead of over the board.
    const tipH = metrics.width < 420 ? 70 : 50;
    root.classList.toggle('tight', fit.y < top.bottom + 6 + tipH);
    scene.resize({ width: metrics.width, height: metrics.height, dpr: metrics.dpr, ...fit });
  }

  function frame(t) {
    raf = 0;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    frameNo++;
    const lively = drag || scene.busy() || treatMode || scene.hint;
    if (screen === 'game') {
      if (lively || frameNo % 2 === 0) scene.frame(t);
    } else if (frameNo % 2 === 0) drawHome(t);
    if (!$('#win').hidden) drawWinCat(t);
    raf = requestAnimationFrame(frame);
  }

  function wake() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  // ───────── levels ─────────
  function showLevelTip() {
    for (const tip of TIPS) {
      if (!tip.test(levelNo, def)) continue;
      if (!markTip(progress, tip.id)) continue;
      saveProgress();
      showTip(tip.text, { sticky: true });
      return;
    }
  }

  function startLevel(n, { resume = true } = {}) {
    clearTimeout(stuckTimer);
    closeOverlay('#win');
    closeOverlay('#stuck');
    levelNo = n;
    def = getLevel(n);
    const restored = resume ? restoreLevel(n, def) : null;
    game = restored ? restored.game : new Game(def);
    initial = new Game(game.L).snapshot();
    undo = restored ? restored.undo : [];
    won = false;
    drag = null;
    treatMode = false;
    scene.setHighlight(false);
    scene.setGame(game);
    $('#level-name').textContent = `Level ${n}`;
    $('#hard-badge').hidden = !isHardLevel(n);
    setScreen('game');
    scene.intro(now());
    hideTip();
    showLevelTip();
    if (n === 1 && !restored && def.solution && def.solution.length) showSolutionStep(def.solution[0]);
    updateTools();
    saveLevel();
    if (game.isStuck()) scheduleStuck();
  }

  function showSolutionStep([k, path]) {
    const cells = [];
    let x = game.hx[k];
    let y = game.hy[k];
    for (const ch of path) {
      if (ch === 'R') x++;
      else if (ch === 'L') x--;
      else if (ch === 'D') y++;
      else if (ch === 'U') y--;
      cells.push([x, y]);
    }
    scene.setHint({ k, path: cells });
  }

  // ───────── game events ─────────
  function rank(level) {
    return level === 'heavy' ? 3 : level === 'medium' ? 2 : level === 'light' ? 1 : 0;
  }

  function wantHaptic(level) {
    if (rank(level) > haptic) haptic = rank(level);
  }

  function flushHaptic() {
    if (haptic) haptics.impact(haptic === 3 ? 'heavy' : haptic === 2 ? 'medium' : 'light');
    haptic = 0;
  }

  function process(events) {
    if (!events.length) return;
    const t = now();
    scene.handle(events, t);
    let won1 = false;
    for (const e of events) {
      if (e.type === 'drop') {
        streak = t - lastDropAt < 900 ? streak + 1 : 0;
        lastDropAt = t;
        audio.play('drop', { n: streak });
        wantHaptic('light');
      } else if (e.type === 'reveal') {
        audio.play('reveal');
      } else if (e.type === 'ice') {
        audio.play('crack');
      } else if (e.type === 'melt') {
        audio.play('shatter');
      } else if (e.type === 'unlock') {
        audio.play('unlock');
        wantHaptic('medium');
      } else if (e.type === 'complete') {
        setTimeout(() => audio.play('complete'), 90);
        wantHaptic('medium');
      } else if (e.type === 'win') {
        won1 = true;
      }
    }
    if (won1) onWin();
    wake();
  }

  function onWin() {
    if (won) return;
    won = true;
    hideTip();
    scene.setHint(null);
    const hard = isHardLevel(levelNo);
    const reward = completeLevel(progress, levelNo, hard);
    removeKey(KEYS.level);
    saveProgress();
    wantHaptic('heavy');
    setTimeout(() => {
      if (screen !== 'game' || !won) return;
      const t = now();
      const colors = PALETTE.map((p) => p.main);
      scene.particles.confetti(metrics ? metrics.width : 400, colors, t);
      audio.play('win');
      $('#win-title').textContent = WIN_TITLES[(levelNo * 7) % WIN_TITLES.length];
      $('#win .win-sub').textContent = `Level ${levelNo} complete`;
      $('#win .reward').hidden = reward <= 0;
      $('#win .reward-value').textContent = `+${reward}`;
      winAt = t;
      openOverlay('#win');
      setTimeout(() => {
        if (!$('#win').hidden && reward > 0) audio.play('coin');
      }, 650);
      // Endless levels are generated on demand: build the next one while the player enjoys the win card.
      setTimeout(() => {
        try {
          getLevel(progress.level);
        } catch (err) {
          console.error(err);
        }
      }, 400);
      updateCoins();
      wake();
    }, 950);
  }

  function scheduleStuck() {
    clearTimeout(stuckTimer);
    stuckTimer = setTimeout(() => {
      if (screen !== 'game' || won || drag || !game.isStuck() || anyOverlay()) return;
      audio.play('stuck');
      openOverlay('#stuck');
    }, 900);
  }

  function afterMove() {
    updateTools();
    saveLevel();
    if (!won && game.isStuck()) scheduleStuck();
  }

  // ───────── input ─────────
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e) {
    interacted = true;
    if (screen !== 'game' || drag || won || anyOverlay() || !scene.layout) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = point(e);
    const c = scene.toCell(p.x, p.y);
    const k = scene.holeAt(c.x, c.y);
    if (treatMode) {
      if (k >= 0) applyTreat(k);
      else setTreatMode(false);
      return;
    }
    if (k < 0) {
      const cx = Math.floor(c.x);
      const cy = Math.floor(c.y);
      if (cx >= 0 && cy >= 0 && cx < game.w && cy < game.h && game.catAt(cx, cy) !== -1) {
        tapCat = { x: cx, y: cy, id: e.pointerId };
      }
      return;
    }
    if (!tipSticky) hideTip();
    scene.setHint(null);
    const slide = createSlide(game, k);
    drag = { id: e.pointerId, k, slide, gx: c.x - game.hx[k], gy: c.y - game.hy[k], before: game.snapshot() };
    scene.setDrag({ k, x: slide.x, y: slide.y });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events
    }
    audio.play('pick');
    wake();
  }

  function track(e) {
    const p = point(e);
    const c = scene.toCell(p.x, p.y);
    const events = drag.slide.moveToward(c.x - drag.gx, c.y - drag.gy);
    if (events.length) process(events);
    if (drag && !drag.slide.done) scene.setDrag({ k: drag.k, x: drag.slide.x, y: drag.slide.y });
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    if (list && list.length) {
      for (const ce of list) {
        if (!drag || drag.slide.done) break;
        track(ce);
      }
    } else track(e);
    if (drag && drag.slide.done) finishDrag();
  }

  function finishDrag() {
    const d = drag;
    if (!d) return;
    drag = null;
    scene.setDrag(null);
    try {
      if (canvas.hasPointerCapture(d.id)) canvas.releasePointerCapture(d.id);
    } catch {
      // ignore
    }
    if (d.slide.steps > 0) {
      undo.push(d.before);
      if (undo.length > UNDO_LIMIT) undo.shift();
      if (tipSticky && levelNo > 1) hideTip();
      else if (tipSticky && game.need[d.k] <= 0) hideTip();
    }
    afterMove();
  }

  function onUp(e) {
    if (tapCat && e.pointerId === tapCat.id) {
      const { x, y } = tapCat;
      tapCat = null;
      if (game && game.catAt(x, y) !== -1 && !game.isBoxed(x, y)) {
        scene.hop(x, y, now());
        audio.play('meow', { pitch: 0.8 + ((x * 7 + y * 3) % 9) * 0.06 });
        haptics.tick();
      }
    }
    if (drag && e.pointerId === drag.id) {
      const p = point(e);
      const c = scene.toCell(p.x, p.y);
      const events = drag.slide.moveToward(c.x - drag.gx, c.y - drag.gy);
      if (events.length) process(events);
      finishDrag();
    }
    flushHaptic();
  }

  function onCancel(e) {
    if (tapCat && e.pointerId === tapCat.id) tapCat = null;
    if (drag && e.pointerId === drag.id) finishDrag();
  }

  // ───────── tools ─────────
  function doUndo() {
    if (drag || !undo.length || !game) return;
    clearTimeout(stuckTimer);
    closeOverlay('#stuck');
    game.restore(undo.pop());
    won = false;
    scene.sync(now());
    audio.play('undo');
    afterMove();
    wake();
  }

  function doRestart() {
    if (drag || !game) return;
    clearTimeout(stuckTimer);
    closeOverlay('#stuck');
    const atStart = game.stateKey() === new Game(game.L).stateKey();
    if (atStart) {
      scene.intro(now());
      return;
    }
    undo.push(game.snapshot());
    if (undo.length > UNDO_LIMIT) undo.shift();
    game.restore(initial);
    won = false;
    setTreatMode(false);
    scene.sync(now(), { stagger: true });
    audio.play('undo');
    afterMove();
    wake();
  }

  function doHint() {
    if (drag || won || !game) return;
    setTreatMode(false);
    if (scene.hint) return;
    if (progress.boosters.hint <= 0) {
      openBuy('hint');
      return;
    }
    if (hintBusy) return;
    if (game.isStuck()) {
      scheduleStuck();
      return;
    }
    // The search can take a moment on a dead-end board: let the tip paint first.
    hintBusy = true;
    showTip('Thinking…', { sticky: true });
    const at = game.stateKey();
    setTimeout(() => {
      hintBusy = false;
      if (!game || won || game.stateKey() !== at) {
        hideTip();
        return;
      }
      const h = findHint(game, { maxNodes: 20000, timeMs: 1500 });
      if (!h) {
        audio.play('invalid');
        showTip('No way forward from here — try Undo or Restart', { ms: 4000 });
        return;
      }
      hideTip();
      useBooster(progress, 'hint');
      saveProgress();
      showSolutionStep([h.hole, h.path]);
      audio.play('click');
      updateTools();
      wake();
    }, 40);
  }

  function setTreatMode(on) {
    treatMode = !!on;
    scene.setHighlight(treatMode);
    if (treatMode) showTip('Tap a hole — its cats jump right in!', { sticky: true });
    else if (tipSticky) hideTip();
    updateTools();
    wake();
  }

  function doTreat() {
    if (drag || won || !game) return;
    if (treatMode) {
      setTreatMode(false);
      return;
    }
    if (progress.boosters.treat <= 0) {
      openBuy('treat');
      return;
    }
    scene.setHint(null);
    setTreatMode(true);
  }

  function applyTreat(k) {
    const before = game.snapshot();
    const events = game.treat(k);
    if (!events.some((e) => e.type === 'drop')) {
      audio.play('invalid');
      showTip('No free cats of that colour right now', { ms: 3000 });
      setTreatMode(false);
      return;
    }
    useBooster(progress, 'treat');
    undo.push(before);
    if (undo.length > UNDO_LIMIT) undo.shift();
    treatMode = false;
    scene.setHighlight(false);
    hideTip();
    audio.play('treat');
    process(events);
    saveProgress();
    afterMove();
  }

  let buyKind = 'hint';
  function openBuy(kind) {
    buyKind = kind;
    const price = PRICES[kind];
    const can = progress.coins >= price;
    $('#buy-title').textContent = kind === 'hint' ? 'Get a hint?' : 'Get a cat treat?';
    $('#buy .buy-text').textContent = (kind === 'hint'
      ? 'A hint shows a good next move.'
      : 'A treat calls the nearest cats of a hole’s colour right into it.') +
      ` It costs ${price} coins; you have ${progress.coins}.` + (can ? '' : ' Finish more levels to earn coins!');
    $('#btn-buy').disabled = !can;
    $('#btn-buy').textContent = `Buy · ${price}`;
    openOverlay('#buy');
  }

  // ───────── settings ─────────
  function syncToggles() {
    for (const el of root.querySelectorAll('[data-toggle]')) {
      el.setAttribute('aria-checked', String(!!settings[el.dataset.toggle]));
    }
  }

  function openSettings() {
    syncToggles();
    $('#settings .confirm').hidden = true;
    $('#btn-reset').hidden = false;
    $('#settings .version').textContent = `Meow Drop ${VERSION} · level ${progress.level}`;
    openOverlay('#settings');
  }

  // ───────── wiring ─────────
  function on(sel, fn) {
    $(sel).addEventListener('click', (e) => {
      interacted = true;
      audio.unlock();
      fn(e);
    });
  }

  function click() {
    audio.play('click');
    haptics.tick();
  }

  on('#btn-play', () => {
    click();
    startLevel(progress.level);
  });
  on('#btn-home', () => {
    click();
    if (drag) finishDrag();
    setTreatMode(false);
    hideTip();
    saveLevel();
    setScreen('home');
  });
  on('#btn-undo', () => {
    haptics.tick();
    doUndo();
  });
  on('#btn-restart', () => {
    haptics.tick();
    doRestart();
  });
  on('#btn-hint', () => {
    haptics.tick();
    doHint();
  });
  on('#btn-treat', () => {
    haptics.tick();
    doTreat();
  });
  on('#btn-next', () => {
    click();
    startLevel(progress.level, { resume: false });
  });
  on('#btn-stuck-undo', () => {
    click();
    closeOverlay('#stuck');
    doUndo();
  });
  on('#btn-stuck-restart', () => {
    click();
    closeOverlay('#stuck');
    doRestart();
  });
  on('#btn-buy', () => {
    if (buyBooster(progress, buyKind)) {
      audio.play('coin');
      haptics.impact('medium');
      saveProgress();
      updateTools();
      closeOverlay('#buy');
      if (buyKind === 'treat') setTreatMode(true);
      else doHint();
    } else {
      audio.play('invalid');
    }
  });
  on('#btn-buy-cancel', () => {
    click();
    closeOverlay('#buy');
  });
  on('#btn-settings', () => {
    click();
    openSettings();
  });
  on('#btn-settings-game', () => {
    click();
    openSettings();
  });
  on('#btn-settings-close', () => {
    click();
    closeOverlay('#settings');
  });
  on('#btn-reset', () => {
    click();
    $('#settings .confirm').hidden = false;
    $('#btn-reset').hidden = true;
  });
  on('#btn-reset-no', () => {
    click();
    $('#settings .confirm').hidden = true;
    $('#btn-reset').hidden = false;
  });
  on('#btn-reset-yes', () => {
    click();
    progress = newProgress();
    removeKey(KEYS.level);
    saveProgress();
    game = null;
    def = null;
    closeOverlay('#settings');
    setScreen('home');
  });
  for (const el of root.querySelectorAll('[data-toggle]')) {
    el.addEventListener('click', () => {
      const key = el.dataset.toggle;
      settings[key] = !settings[key];
      if (key === 'sound') audio.muted = !settings.sound;
      if (key === 'haptics') haptics.enabled = settings.haptics;
      if (!nosave) saveJSON(KEYS.settings, settings);
      syncToggles();
      click();
    });
  }
  // Backdrop taps close the dismissible dialogs.
  for (const id of ['#buy', '#settings']) {
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id)) closeOverlay(id);
    });
  }
  $('#home-cats').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(4, Math.floor(((e.clientX - r.left) / r.width) * 5)));
    homeHop[i] = now();
    audio.unlock();
    audio.play('meow', { pitch: 0.85 + i * 0.1 });
    haptics.tick();
  });

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('lostpointercapture', onCancel);
  window.addEventListener('keydown', (e) => {
    if (screen !== 'game' || anyOverlay()) return;
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey || !e.shiftKey)) doUndo();
    else if (e.key === 'r' || e.key === 'R') doRestart();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (drag) finishDrag();
      persist();
    } else wake();
  });
  window.addEventListener('pagehide', persist);

  installTouchGuards(canvas);
  onViewportChange(root, (m) => {
    metrics = m;
    layout();
    wake();
  });

  // Install hint (iOS Safari, not yet installed).
  const hints = nosave ? {} : loadJSON(KEYS.hints, {});
  if (isIOS() && !isStandalone() && !hints.install) {
    const box = $('#install-hint');
    box.hidden = false;
    box.querySelector('.install-close').addEventListener('click', () => {
      box.hidden = true;
      if (!nosave) saveJSON(KEYS.hints, { ...hints, install: true });
    });
  }

  return {
    start() {
      renderHome();
      updateTools();
      setScreen('home');
      requestPersistence();
      initServiceWorker({
        onUpdateReady(api) {
          updater = api;
          if (!interacted) {
            api.applyUpdate();
            return;
          }
          const pill = $('#update-pill');
          pill.hidden = false;
          pill.onclick = () => {
            persist();
            if (!api.applyUpdate()) pill.hidden = true;
          };
        },
        beforeReload: persist,
      });
    },
    // Debug / test helpers (exposed on window.__dropcat with ?debug=1).
    get game() {
      return game;
    },
    get scene() {
      return scene;
    },
    get progress() {
      return progress;
    },
    get screen() {
      return screen;
    },
    get undoCount() {
      return undo.length;
    },
    get def() {
      return def;
    },
    startLevel: (n, opts) => startLevel(n, opts),
    undo: doUndo,
    restart: doRestart,
    hint: doHint,
    state() {
      return {
        screen, level: levelNo, won, undo: undo.length, coins: progress.coins, boosters: { ...progress.boosters },
        audio: audio.state, catsLeft: game ? game.catsLeft() : 0, stuck: game ? game.isStuck() : false,
        overlay: ['#win', '#stuck', '#buy', '#settings'].filter((id) => $(id).dataset.open === '1'),
      };
    },
    /** Board geometry for tests: the CSS px centre of cell (x, y). */
    cellCenter(x, y) {
      const L = scene.layout;
      return L ? { x: L.x + (x + 0.5) * L.cell, y: L.y + (y + 0.5) * L.cell, cell: L.cell } : null;
    },
    get updater() {
      return updater;
    },
    debug,
  };
}
