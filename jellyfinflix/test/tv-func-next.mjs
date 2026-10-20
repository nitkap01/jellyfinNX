// Next-episode countdown check on the TV: play an episode, jump to 40 s before the end, watch the countdown and autoplay.
//   node test/tv-func-next.mjs <ws> <episodeId>
const [, , ws, epId] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Enter: 13, Back: 10009 };
async function press(k) { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] }); }
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value; };
const log = (k, v) => console.log(k.padEnd(22), typeof v === 'string' ? v : JSON.stringify(v));
sock.onopen = async () => {
  await ev('__jfReset()');
  log('open', await ev(`__jfOpen('${epId}')`));
  await sleep(2500);
  await press('Enter');
  await sleep(6000);
  let s = JSON.parse(await ev('JSON.stringify(__jfPlayer())'));
  log('playing', { item: s.item, pos: s.pos, dur: s.dur, nextEp: s.nextEp });
  await ev('__jfSeek(-40000)');
  let seen = null;
  for (let i = 0; i < 30 && !seen; i++) { await sleep(1000); seen = await ev(`document.querySelector('.p-next.on') ? document.querySelector('.p-next').textContent : null`); }
  log('countdown card', seen || 'not shown');
  let next = null;
  for (let i = 0; i < 25 && !next; i++) { await sleep(1000); const p = JSON.parse(await ev('JSON.stringify(__jfPlayer())')); if (p && p.item !== s.item && p.pos > 0) next = p; }
  log('autoplayed', next ? { item: next.item, method: next.method } : 'no');
  await press('Back'); await sleep(2500); await press('Back'); await sleep(1000);
  sock.close(); process.exit(0);
};
