// Press a key sequence on the TV page and report long tasks with timing per key.
//   node test/tv-keys.mjs <ws> 'Back,Down,Right*14,Down*5' [gapMs]
const [, , ws, seqArg, gapArg = '300'] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009 };
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
sock.onopen = async () => {
  await ev(`(()=>{window.__lt2=[];window.__kt=[];__jf.keys.length=0;__jf.frames.length=0;if(!window.__lto){window.__lto=new PerformanceObserver(l=>l.getEntries().forEach(e=>(window.__lt2||[]).push([Math.round(e.startTime),Math.round(e.duration)])));window.__lto.observe({entryTypes:['longtask']});}return 1})()`);
  const seq = [];
  for (const p of seqArg.split(',')) { const [n, c] = p.split('*'); for (let i = 0; i < (+c || 1); i++) seq.push(n); }
  for (const k of seq) {
    await ev(`__kt.push(['${k}',Math.round(performance.now())])`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] });
    await sleep(+gapArg);
  }
  await sleep(800);
  const r = await ev(`(()=>{const kt=__kt,lt=__lt2;return {keys:__jf.keys,frames:__jf.frames,long:lt.map(([s,d])=>{let k='';for(const [n,t] of kt) if(t<=s) k=n+'@'+t;return k+' +'+(s-(+k.split('@')[1]||0))+'ms: '+d+'ms'})}})()`);
  console.log(JSON.stringify(r));
  sock.close(); process.exit(0);
};
