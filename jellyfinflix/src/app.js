// Screen + overlay stack and the single key dispatcher.
import { keyName } from './keys.js';
import { metrics } from './util.js';

const stack = [];
const factories = {};
const screens = {};
const listeners = {};

export const app = {
  current: null, currentName: '',
  register(name, f) { factories[name] = f; },
  screen(name) { return screens[name] || (screens[name] = factories[name]()); },
  has(name) { return !!screens[name]; },
  drop(name) { const s = screens[name]; if (!s) return; if (app.current === s) app.current = null; if (s.el) s.el.remove(); delete screens[name]; },
  go(name, opts) {
    while (stack.length > 1) popTop();
    const s = app.screen(name);
    if (app.current === s) { s.reenter && s.reenter(opts); return; }
    if (app.current) app.current.hide();
    app.current = s; app.currentName = name;
    stack[0] = s;
    s.show(opts);
    emit('screen', name);
  },
  push(layer) { stack.push(layer); if (layer.show) layer.show(); },
  pop(layer) {
    const i = stack.lastIndexOf(layer);
    if (i <= 0) return;
    stack.splice(i, 1);
    if (layer.hide) layer.hide();
    const t = stack[stack.length - 1];
    if (t && t.resume) t.resume();
  },
  top() { return stack[stack.length - 1]; },
  isTop(layer) { return stack[stack.length - 1] === layer; },
  on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
  emit,
};

function emit(ev, a) { (listeners[ev] || []).forEach((f) => { try { f(a); } catch (e) { console.error(e); } }); }
function popTop() { const l = stack.pop(); if (l && l.hide) l.hide(); }

let framePending = false;
document.addEventListener('keydown', (e) => {
  const k = keyName(e);
  if (!k) return;
  e.preventDefault();
  // Held key: if the last move has not reached the screen yet, drop this repeat (no queued moves, no lag).
  if (e.repeat && framePending) return;
  framePending = true;
  const t0 = performance.now();
  metrics.lastKey = t0;
  const L = app.top();
  if (!L) return;
  let done = false;
  try { done = L.key(k, e); } catch (err) { console.error(err); }
  if (!done && k === 'back' && L.overlay) app.pop(L);
  else if (!done && k === 'back' && app.currentName !== 'home' && app.currentName !== 'profiles') app.go('home');
  const dt = performance.now() - t0;
  if (metrics.keys.length > 300) metrics.keys.length = 0;
  metrics.keys.push(Math.round(dt * 10) / 10);
  requestAnimationFrame(() => setTimeout(() => {
    framePending = false;
    if (metrics.frames.length > 300) metrics.frames.length = 0;
    metrics.frames.push(Math.round(performance.now() - t0));
  }, 0));
}, true);

document.addEventListener('keyup', (e) => {
  const L = app.top();
  const k = keyName(e);
  if (L && L.keyup && k) L.keyup(k, e);
}, true);
