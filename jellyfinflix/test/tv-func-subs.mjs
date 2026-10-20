// Subtitle check on the TV: open a movie, Resume, pick subtitle #N in the menu, watch for subtitle text.
//   node test/tv-func-subs.mjs <ws> <itemId> <subtitleRow (1 = first after Off)>
const [, , ws, itemId, subRow = '1'] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009 };
async function press(k) { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] }); }
async function keys(seq, gap = 350) { for (const p of seq.split(',')) { const [n, c] = p.split('*'); for (let i = 0; i < (+c || 1); i++) { await press(n); await sleep(gap); } } }
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value; };
sock.onopen = async () => {
  await ev('__jfReset()');
  console.log('open', await ev(`__jfOpen('${itemId}')`));
  await sleep(2500);
  await press('Enter');
  await sleep(5000);
  await keys('Down,Right*3,Enter');
  await sleep(400);
  await keys('Right' + ',Down*' + subRow + ',Enter');
  const texts = new Set();
  for (let i = 0; i < 40; i++) { await sleep(1000); const t = await ev('__jfPlayer().subText'); if (t) texts.add(t.slice(0, 60)); }
  console.log('state', await ev('JSON.stringify((({sub,extCues,pos,method})=>({sub,extCues,pos,method}))(__jfPlayer()))'));
  console.log('subtitle lines seen in 40 s:', texts.size, [...texts].slice(0, 4));
  await press('Back'); await sleep(3000); await press('Back'); await sleep(1000);
  sock.close(); process.exit(0);
};
