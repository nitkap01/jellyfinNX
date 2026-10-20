// Navigation / screens check on the TV: rail to every screen, series details, My List toggle, search, exit prompt.
//   node test/tv-func-nav.mjs <ws> <seriesId>
const [, , ws, seriesId] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009 };
async function press(k) { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] }); }
async function keys(seq, gap = 300) { for (const p of seq.split(',')) { const [n, c] = p.split('*'); for (let i = 0; i < (+c || 1); i++) { await press(n); await sleep(gap); } } }
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value; };
const log = (k, v) => console.log(k.padEnd(24), typeof v === 'string' ? v : JSON.stringify(v));
const screen = () => ev(`document.body.dataset.screen + ' | rows: ' + [...document.querySelectorAll('.screen.on .row-title')].slice(0,4).map(e=>e.textContent).join(', ') + ' | focus: ' + ((document.querySelector('.screen.on .fx.on .ph, .screen.on .card.f .ph, .screen.on .kk.f')||{}).textContent||'')`);
async function viaRail(upDown) { await ev('__jfReset()'); await sleep(400); await keys('Down,Left'); await keys(upDown); await keys('Enter'); await sleep(2500); }
sock.onopen = async () => {
  await viaRail('Down'); log('rail -> Shows', await screen());
  await keys('Down,Right*2'); log('shows browse', await screen());
  await viaRail('Down*2'); log('rail -> Movies', await screen());
  await viaRail('Down*3'); log('rail -> My List', await screen());
  await keys('Right,Down'); log('my list grid move', await screen());
  await viaRail('Up'); log('rail -> Search', await screen());
  await keys('Down*2,Right*3,Enter'); await sleep(1500);
  log('search "p"', await ev(`document.querySelector('.s-head').textContent + ' -> ' + document.querySelectorAll('.search .card').length + ' cards'`));
  await keys('Right*6'); log('search results focus', await screen());
  // series details on the TV
  await ev('__jfReset()'); await sleep(300);
  log('open series', await ev(`__jfOpen('${seriesId}')`));
  await sleep(3000);
  log('series buttons', await ev(`[...document.querySelectorAll('.details .btn')].map(b=>b.textContent).join(' | ')`));
  log('seasons', await ev(`[...document.querySelectorAll('.details .pill')].length + ' pills, selected: ' + ((document.querySelector('.details .pill.sel')||{}).textContent||'-')`));
  await keys('Down,Right'); await sleep(1500);
  log('season change', await ev(`((document.querySelector('.details .pill.sel')||{}).textContent||'') + ' -> ' + document.querySelectorAll('.details .ep').length + ' episode cards'`));
  await keys('Down,Right*2'); log('episode focus', await ev(`(document.querySelector('.details .fx.on .ept')||{}).textContent||''`));
  // My List toggle twice (back to the original state)
  await keys('Up*2'); await keys('Right*3', 200); await keys('Left*3', 200);
  const favBtn = await ev(`[...document.querySelectorAll('.details .btn')].findIndex(b=>/My List/.test(b.textContent))`);
  await keys('Right*' + favBtn);
  const before = await ev(`document.querySelector('.details .btn.f').innerHTML.indexOf('M4.5 12.5')>=0`);
  await keys('Enter'); await sleep(1200);
  const mid = await ev(`document.querySelector('.details .btn.f').innerHTML.indexOf('M4.5 12.5')>=0`);
  log('My List toggle', { before, after: mid, toast: await ev(`(document.querySelector('.toast.on')||{}).textContent||''`) });
  await keys('Enter'); await sleep(1200);
  log('My List restored', await ev(`document.querySelector('.details .btn.f').innerHTML.indexOf('M4.5 12.5')>=0`) === before);
  // Back closes details, then exit prompt from Home top
  await ev('__jf.frames.length=0'); await keys('Back'); await sleep(500);
  log('back from details ms', await ev('__jf.frames[0]'));
  await ev('__jfReset()'); await sleep(400);
  await keys('Back'); await sleep(400);
  log('exit prompt', await ev(`(document.querySelector('.dlg')||{}).textContent||'none'`));
  await keys('Back'); await sleep(300);
  log('after cancel', await ev(`document.querySelector('.dlg')?'still open':'closed'`));
  sock.close(); process.exit(0);
};
