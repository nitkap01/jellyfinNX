// A/B test CSS tweaks live on the TV: long tasks while pressing keys.
//   node test/css-exp.mjs <ws> 'Down*8,Up*8' <gapMs> 'name=css' 'name2=css2' ...
const [, , ws, seqArg, gapArg, ...variants] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40 };
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
async function press(k) { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] }); }
const seq = [];
for (const p of seqArg.split(',')) { const [n, c] = p.split('*'); for (let i = 0; i < (+c || 1); i++) seq.push(n); }
sock.onopen = async () => {
  for (const v of variants.concat(variants, variants)) {
    const i = v.indexOf('=');
    const name = v.slice(0, i), css = v.slice(i + 1);
    await ev(`(()=>{let s=document.getElementById('xp');if(!s){s=document.createElement('style');s.id='xp';document.head.appendChild(s)}s.textContent=${JSON.stringify(css)};return 1})()`);
    await ev('__jfReset()'); await sleep(500); await press('Down'); await sleep(900);
    await ev(`(()=>{window.__lt=[];__jf.frames.length=0;if(!window.__lto){window.__lto=new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__lt&&window.__lt.push(Math.round(e.duration))));window.__lto.observe({entryTypes:['longtask']});}return 1})()`);
    for (const k of seq) { await press(k); await sleep(+gapArg); }
    await sleep(800);
    const r = await ev(`({n:__lt.length,ms:__lt.reduce((a,b)=>a+b,0),fAvg:Math.round(__jf.frames.reduce((a,b)=>a+b,0)/__jf.frames.length),fMax:Math.max(...__jf.frames)})`);
    console.log(name.padEnd(28), JSON.stringify(r));
  }
  sock.close(); process.exit(0);
};
