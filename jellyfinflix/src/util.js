// Small helpers shared by every screen.
export function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test/measurement hooks (read by the CDP test scripts).
export const metrics = (window.__jf = window.__jf || { marks: {}, keys: [], frames: [] });
export function mark(name, force) {
  if (force || !(name in metrics.marks)) metrics.marks[name] = Math.round(performance.now());
}

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => (n < 10 ? '0' : '') + n;
  return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
}

export function fmtRuntime(ticks) {
  if (!ticks) return '';
  const min = Math.round(ticks / 6e8);
  if (min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
}

export function progressPct(it) {
  const u = it.UserData;
  if (!u) return 0;
  if (u.PlayedPercentage) return u.PlayedPercentage;
  if (u.PlaybackPositionTicks && it.RunTimeTicks) return (100 * u.PlaybackPositionTicks) / it.RunTimeTicks;
  return 0;
}

export function epLabel(it) {
  if (it.Type !== 'Episode') return '';
  const s = it.ParentIndexNumber, e = it.IndexNumber;
  return (s != null ? 'S' + s : '') + (e != null ? ':E' + e : '');
}

export function onIdle(fn, timeout) {
  if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: timeout || 1500 });
  else setTimeout(fn, 200);
}

// Page-level states without touching <body> classes (a body class change restyles every element).
const FLAG_TARGETS = { deep: ['bgh'], dt: ['screens', 'railh', 'brand'] };
export function setFlag(name, on) {
  for (const id of FLAG_TARGETS[name] || []) { const e = document.getElementById(id); if (e) e.classList.toggle(name, !!on); }
}
