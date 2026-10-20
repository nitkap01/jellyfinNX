// Detailed app log for the first week (until FULL_UNTIL), errors only after that.
// - Every entry goes into a ring buffer saved on the TV (localStorage), so it survives a crash.
// - The buffer is uploaded to the Jellyfin server (POST /ClientLog/Document → Dashboard > Logs, "upload_JellyfinFlix_*")
//   at start (this includes the previous session, so a crash is reported on the next launch), every 5 minutes,
//   a few seconds after any error, and when the app is hidden or exits.
// - A heartbeat marks the session as alive; if the next launch finds a session without a clean exit, it logs
//   "previous session ended unexpectedly" with that session's last steps.
// Read them on INDIE with: python3 tools/getlogs.py last
const FULL_UNTIL = Date.parse('2026-10-27T23:59:59+05:30');
const KEY = 'jf.log', SKEY = 'jf.log.sess', MAX = 1500;
const sid = Math.random().toString(36).slice(2, 8);
let buf = [], sent = 0, saveT = 0, upT = 0, uploader = null, lastErr = '';

const full = () => Date.now() < FULL_UNTIL;
const ts = () => { const d = new Date(); return d.toISOString().slice(5, 23).replace('T', ' '); };
const clean = (v) => {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return (s || '').replace(/(api_key|ApiKey|Token|token|Pw|password)("?\s*[=:]\s*"?)[^&",\s}]+/gi, '$1$2***').slice(0, 800);
  } catch (e) { return String(v).slice(0, 200); }
};

function load() { try { const o = JSON.parse(localStorage.getItem(KEY) || 'null'); if (o && o.b) { buf = o.b; sent = o.sent || 0; } } catch (e) { buf = []; } }
function save() { clearTimeout(saveT); saveT = 0; try { localStorage.setItem(KEY, JSON.stringify({ b: buf, sent })); } catch (e) { buf = buf.slice(-500); sent = Math.min(sent, buf.length); } }
function soon() { if (!saveT) saveT = setTimeout(save, 1500); }

// level: 'i' info, 'w' warning, 'e' error
export function log(event, data, level) {
  level = level || 'i';
  if (level === 'i' && !full()) return;
  buf.push(ts() + ' ' + sid + ' ' + level.toUpperCase() + ' ' + event + (data === undefined ? '' : ' ' + clean(data)));
  if (buf.length > MAX) { const cut = buf.length - MAX; buf = buf.slice(cut); sent = Math.max(0, sent - cut); }
  if (level === 'e') { save(); scheduleUpload(4000); } else soon();
}
export const warn = (e, d) => log(e, d, 'w');
export const error = (e, d) => log(e, d, 'e');

function scheduleUpload(ms) { clearTimeout(upT); upT = setTimeout(upload, ms); }
export function upload() {
  if (!uploader || sent >= buf.length) return Promise.resolve();
  const lines = buf.slice(sent), upto = buf.length;
  const head = 'JellyfinFlix log · device ' + (uploader.device || '?') + ' · ' + navigator.userAgent.slice(0, 90) + '\n';
  return uploader.post(head + lines.join('\n') + '\n').then(() => { sent = upto; save(); }).catch((e) => { warn('log upload failed', String(e && e.message || e)); });
}

// Call once at boot. post(text) → Promise (provided by main.js once a login exists).
export function initLog(opts) {
  const early = buf; load(); buf = buf.concat(early);   // keep anything logged before init
  // crash detection: was the previous session closed cleanly?
  try {
    const prev = JSON.parse(localStorage.getItem(SKEY) || 'null');
    if (prev && !prev.clean) {
      const tail = buf.filter((l) => l.indexOf(' ' + prev.sid + ' ') > 0).slice(-25);
      buf.push(ts() + ' ' + sid + ' E previous session ' + prev.sid + ' ended unexpectedly (app crashed or was killed) · last alive ' + new Date(prev.alive).toISOString() +
        ' · screen ' + (prev.screen || '?') + ' · last steps: ' + tail.map((l) => l.slice(22)).join(' | ').slice(0, 1500));
    }
  } catch (e) { /* first run */ }
  const sess = { sid, start: Date.now(), alive: Date.now(), clean: false, screen: '' };
  const beat = () => { sess.alive = Date.now(); try { localStorage.setItem(SKEY, JSON.stringify(sess)); } catch (e) { /* full */ } };
  beat(); setInterval(beat, 10000);
  log('app start', { v: opts.version, mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) + ' MB' : '?', full: full() });
  window.addEventListener('error', (e) => error('js error', (e.message || '') + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno + (e.error && e.error.stack ? ' · ' + e.error.stack.split('\n').slice(0, 4).join(' / ') : '')));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason || {}; error('unhandled promise', (r.message || String(r)) + (r.stack ? ' · ' + r.stack.split('\n').slice(0, 3).join(' / ') : '')); });
  const ce = console.error.bind(console);
  console.error = (...a) => { const m = a.map((x) => (x && x.message) || String(x)).join(' '); if (m !== lastErr) { lastErr = m; error('console.error', m); } ce(...a); };
  document.addEventListener('visibilitychange', () => { log(document.hidden ? 'app hidden' : 'app visible'); if (document.hidden) { save(); upload(); } });
  window.addEventListener('pagehide', () => { sess.clean = true; beat(); save(); });
  setInterval(() => { if (full()) log('heartbeat', { mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) + ' MB' : '?' }); upload(); }, 300000);
  return {
    screen(name) { sess.screen = name; beat(); log('screen', name); },
    cleanExit() { sess.clean = true; beat(); log('exit (user)'); save(); },
    setUploader(u) { uploader = u; scheduleUpload(3000); },
  };
}
window.__jfLog = { dump: () => buf.slice(-60), upload };
