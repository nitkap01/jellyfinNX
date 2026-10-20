// Hold Right for 5 s in the player (auto-repeat every 50 ms): how far it travels, long tasks, key-to-screen times.
//   node test/tv-func-seekhold.mjs <ws> <itemId>
const [, , ws, itemId] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Right: 39, Left: 37, Enter: 13, Back: 10009, FF: 417 };
const down = (k, rep) => send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k], autoRepeat: !!rep });
const up = (k) => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value; };
const REC = `(()=>{window.__lt=[];__jf.keys.length=0;__jf.frames.length=0;if(!window.__lto){window.__lto=new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__lt&&window.__lt.push(Math.round(e.duration))));window.__lto.observe({entryTypes:['longtask']});}return 1})()`;
async function hold(key, ms) {
  await ev(REC);
  const p0 = JSON.parse(await ev('JSON.stringify(__jfPlayer())')).pos;
  const tips = [];
  await down(key);
  let sent = 1;
  for (let t = 0; t < ms; t += 50) {
    await sleep(50); await down(key, true); sent++;
    if (t % 1000 === 950) tips.push(await ev(`(document.querySelector('.p-tip')||{}).textContent`));
  }
  await up(key);
  const tipEnd = await ev(`(document.querySelector('.p-tip')||{}).textContent`);
  await sleep(2500);
  const p1 = JSON.parse(await ev('JSON.stringify(__jfPlayer())')).pos;
  const r = await ev(`(()=>{const f=__jf.frames,lt=window.__lt||[];return {handled:__jf.keys.length,keyToFrameAvg:Math.round(f.reduce((a,b)=>a+b,0)/f.length),keyToFrameMax:Math.max(...f),longTasks:lt.length,worst:lt.sort((a,b)=>b-a).slice(0,3)}})()`);
  return Object.assign({ key, heldMs: ms, sent, travelledMin: ((p1 - p0) / 60000).toFixed(1), tipsEverySecond: tips, tipAtRelease: tipEnd }, r);
}
sock.onopen = async () => {
  await ev('__jfReset()');
  console.log('open', await ev(`__jfOpen('${itemId}')`));
  await sleep(2500);
  await down('Enter'); await up('Enter');
  await sleep(6000);
  await ev('__jfSeek(60000)'); await sleep(4000);
  console.log(JSON.stringify(await hold('Right', 5000), null, 1));
  await sleep(2000);
  console.log(JSON.stringify(await hold('FF', 3000), null, 1));
  await down('Back'); await up('Back'); await sleep(2500); await down('Back'); await up('Back');
  sock.close(); process.exit(0);
};
