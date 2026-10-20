// Player settings panel check on the TV (quality switch, speed, zoom, subtitle style/sync, info, picture-subtitle burn-in).
//   node test/tv-func-settings.mjs <ws> <itemId> [pgsItemId]
const [, , ws, itemId, pgsId] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009 };
async function press(k) { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] }); }
async function keys(seq, gap = 250) { for (const p of seq.split(',')) { const [n, c] = p.split('*'); for (let i = 0; i < (+c || 1); i++) { await press(n); await sleep(gap); } } }
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value; };
const P = async () => JSON.parse(await ev('JSON.stringify(__jfPlayer())'));
let lastMenuMs = 0;
const log = (k, v) => console.log(k.padEnd(26), typeof v === 'string' ? v : JSON.stringify(v));
async function openMenu() {
  await keys('Down'); await sleep(200);
  const n = await ev(`[...document.querySelectorAll('.pc')].findIndex(b=>/Audio/.test(b.textContent))`);
  await keys('Left*5'); await keys('Right*' + n);
  await ev('__jf.frames.length=0');
  await keys('Enter');
  await sleep(300);
  lastMenuMs = await ev('__jf.frames[__jf.frames.length-1]');
  return ev(`document.querySelector('.p-menu.on')?1:0`);
}
// pick option `opt` (0 = first) of category `cat`; keep = the menu stays open afterwards (style/sync/zoom choices)
async function pick(cat, opt, keep) {
  if (!(await openMenu())) return 'menu did not open';
  await keys('Down*' + cat); await keys('Right'); await keys('Up*12', 120); if (opt) await keys('Down*' + opt); await keys('Enter');
  await sleep(300);
  const label = await ev(`(document.querySelector('.pm-i.f')||{}).textContent||''`);
  if (keep) { await keys('Back*2'); }
  return label;
}
async function waitPlaying(ms = 25000) {
  const t = Date.now(); let p0 = ((await P()) || {}).pos || 0;
  while (Date.now() - t < ms) { await sleep(500); const p = await P(); if (!p) return 'player closed'; if (p.pos > p0 + 400 && !(await ev(`document.querySelector('.p-spin.on')?1:0`))) return Date.now() - t; p0 = p ? p.pos : p0; }
  return -1;
}
async function startItem(iid) {
  await ev('__jfReset()');
  log('open', await ev(`__jfOpen('${iid}')`));
  await sleep(2500);
  await press('Enter');
  log('first frame (ms)', await waitPlaying());
  return P();
}
sock.onopen = async () => {
  let s = await startItem(itemId);
  log('start', { method: s.method, audio: s.audio, sub: s.sub });
  // menu open speed
  await openMenu(); log('menu open: key to screen ms', lastMenuMs);
  log('categories', await ev(`[...document.querySelectorAll('.pm-c')].map(e=>e.textContent).join(' | ')`));
  await keys('Back'); await sleep(300);
  // quality 720p (cat 4, option 2)
  await pick(4, 2);
  log('720p: resumed after (ms)', await waitPlaying());
  s = await P(); log('720p state', { method: s.method, pos: s.pos });
  // info
  await openMenu(); await keys('Down*8'); await sleep(300);
  log('info', await ev(`[...document.querySelectorAll('.pm-i.info')].map(e=>e.textContent).join(' / ')`));
  await keys('Back'); await sleep(300);
  // back to original
  await pick(4, 0);
  log('original: resumed (ms)', await waitPlaying());
  s = await P(); log('original state', { method: s.method, pos: s.pos });
  // speed: AVPlay shows an explanation instead of choices
  await openMenu(); await keys('Down*5'); await sleep(300);
  log('speed', await ev(`[...document.querySelectorAll('.pm-i')].map(e=>e.textContent).join(' / ')`));
  await keys('Back'); await sleep(300);
  // zoom fill (cat 6, opt 1) then fit
  log('zoom pick', await pick(6, 1, true));
  log('zoom toast/err', await ev(`(document.querySelector('.toast.on')||{}).textContent||'ok'`));
  await pick(6, 0, true);
  // subtitle style: size large (cat 2, opt 2), sync +0.5 s (cat 3, opt 6)
  log('size pick', await pick(2, 2, true));
  log('sub class', await ev(`document.querySelector('.p-subs').className`));
  log('sync pick', await pick(3, 6, true));
  log('sub delay toast', await ev(`(document.querySelector('.toast.on')||{}).textContent||''`));
  await pick(2, 1, true); await pick(3, 4, true);
  log('prefs after test', await ev(`JSON.stringify(JSON.parse(localStorage.getItem('jflix.v1')).prefs)`));
  await press('Back'); await sleep(2500); await press('Back'); await sleep(1500);
  if (pgsId) {
    s = await startItem(pgsId);
    log('pgs movie start', { method: s.method, sub: s.sub });
    await pick(1, 1);
    log('burn-in: resumed after (ms)', await waitPlaying(40000));
    s = await P(); log('burn-in state', { method: s.method, sub: s.sub });
    await press('Back'); await sleep(2500); await press('Back'); await sleep(1000);
  }
  sock.close(); process.exit(0);
};
