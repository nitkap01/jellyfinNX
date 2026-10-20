// Functional check of the player on the TV: play, audio/subtitle menu, seek, pause, back, Continue Watching.
//   node test/tv-func-player.mjs <ws> <itemId>
const [, , ws, itemId] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009 };
async function press(k, repeat) { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k], autoRepeat: !!repeat }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] }); }
async function keys(seq, gap = 350) { for (const p of seq.split(',')) { const [n, c] = p.split('*'); for (let i = 0; i < (+c || 1); i++) { await press(n); await sleep(gap); } } }
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value; };
const P = () => ev('JSON.stringify(__jfPlayer())');
const log = (k, v) => console.log(k.padEnd(22), typeof v === 'string' ? v : JSON.stringify(v));
sock.onopen = async () => {
  await ev('__jfReset()');
  log('open details', await ev(`__jfOpen('${itemId}')`));
  await sleep(2500);
  log('buttons', await ev(`[...document.querySelectorAll('.details .btn')].map(b=>b.textContent).join(' | ')`));
  await press('Enter');
  await sleep(6000);
  log('playing', await P());
  // menu: controls -> Audio & Subtitles
  await keys('Down'); await sleep(300);
  log('ctrls', await ev(`[...document.querySelectorAll('.pc')].map(b=>(b.classList.contains('f')?'*':'')+b.textContent).join(' | ')`));
  await keys('Right*3,Enter');
  await sleep(500);
  log('menu', await P());
  // subtitles column: first real subtitle
  await keys('Right,Down,Enter');
  await sleep(8000);
  const s1 = JSON.parse(await P());
  log('after sub select', { sub: s1.sub, extCues: s1.extCues, subText: s1.subText, tracks: s1.tracks });
  let seen = '';
  for (let i = 0; i < 20 && !seen; i++) { await sleep(1000); seen = await ev('__jfPlayer().subText'); }
  log('subtitle text seen', seen || '(none in 20 s)');
  // audio: second track
  await keys('Down'); await sleep(300); await keys('Right*3,Enter'); await sleep(500);
  await keys('Down,Enter');
  await sleep(5000);
  const a = JSON.parse(await P());
  log('after audio select', { audio: a.audio, method: a.method, pos: a.pos });
  // seek forward far (hold Right) so Jellyfin keeps a resume point
  const before = JSON.parse(await P()).pos;
  for (let i = 0; i < 30; i++) { await press('Right', i > 0); await sleep(60); }
  await sleep(4000);
  const after = JSON.parse(await P());
  log('seek', { before, after: after.pos, dur: after.dur });
  await press('Enter'); await sleep(800);
  log('paused?', (JSON.parse(await P())).paused);
  await press('Enter'); await sleep(1500);
  log('playing again?', !(JSON.parse(await P())).paused);
  await sleep(3000);
  await press('Back');
  await sleep(4000);
  await press('Back'); // close details
  await sleep(3000);
  log('home row 0', await ev(`(()=>{const r=__jfApp.screen('home').rows.list[0];return r.def.title+': '+r.items.slice(0,3).map(i=>i.Name+' '+Math.round((i.UserData&&i.UserData.PlayedPercentage)||0)+'%').join(', ')})()`));
  sock.close(); process.exit(0);
};
