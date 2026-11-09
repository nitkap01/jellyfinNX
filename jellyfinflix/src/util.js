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

// JTV-27: the day an episode first aired, as "22nd September 1994" (Jellyfin's PremiereDate is the air date at UTC midnight)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function fmtAirDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const day = d.getUTCDate(), t = day % 100;
  const sfx = t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[day % 10] || 'th';
  return day + sfx + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}
/** "Aired 22nd September 1994" for an episode, "Released 22nd September 2006" for a movie (with a date), else '' */
export function airedLabel(it) {
  if (!it || (it.Type !== 'Episode' && it.Type !== 'Movie')) return '';
  const s = fmtAirDate(it.PremiereDate);
  return s ? (it.Type === 'Movie' ? 'Released ' : 'Aired ') + s : '';
}

/** JTV-27: how long ago an episode aired / a movie was released, in whole years ("32 years ago"), for the line under the facts */
export function agoLabel(it, now = Date.now()) {
  if (!it || (it.Type !== 'Episode' && it.Type !== 'Movie') || !it.PremiereDate) return '';
  const t = new Date(it.PremiereDate).getTime();
  if (isNaN(t) || t > now) return '';
  const y = Math.floor((now - t) / (365.2425 * 864e5));
  return y < 1 ? 'Less than a year ago' : y === 1 ? '1 year ago' : y + ' years ago';
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
