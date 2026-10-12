// Bootstrap: reads the URL flags (?nosave, ?debug, ?level=N), starts the app and, only with ?debug=1,
// exposes window.__dropcat plus an on-screen error box.
import { createApp } from './ui/app.js';

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const nosave = params.get('nosave') === '1';
const levelRaw = Number(params.get('level'));
const firstLevel = Number.isInteger(levelRaw) && levelRaw >= 1 ? levelRaw : null;

function showError(text) {
  const box = document.getElementById('errors');
  if (!box) return;
  box.hidden = false;
  box.textContent += `${text}\n`;
}

if (debug) {
  window.addEventListener('error', (e) => {
    showError(`${e.message || 'error'}${e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : ''}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    showError(`unhandled rejection: ${r && (r.stack || r.message) ? r.stack || r.message : String(r)}`);
  });
}

function boot() {
  let app;
  try {
    app = createApp({ root: document.getElementById('app'), nosave, debug, firstLevel });
    app.start();
  } catch (err) {
    console.error(err);
    if (debug) showError(String(err && (err.stack || err.message)));
    return;
  }
  if (debug) window.__dropcat = app;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
