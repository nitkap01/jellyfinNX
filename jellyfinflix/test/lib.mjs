// Shared helpers for the TV tests (CDP over the forwarded inspector port).
// Keys are sent the way the real Samsung remote sends them: plain keydowns (no autoRepeat flag); a held key is a
// stream of plain keydowns every ~100 ms followed by one keyup.
export const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009, Play: 415, Pause: 19, PlayPause: 10252, Stop: 413, FF: 417, RW: 412 };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const REC = `(()=>{window.__lt=[];__jf.keys.length=0;__jf.frames.length=0;if(!window.__lto){window.__lto=new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__lt&&window.__lt.push(Math.round(e.duration))));window.__lto.observe({entryTypes:['longtask']});}return 1})()`;
export const READ = `(()=>{const k=__jf.keys.slice(),f=__jf.frames.slice(),lt=(window.__lt||[]).slice();const mx=a=>a.length?Math.max(...a):0;const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):0;
  return {presses:k.length,handlerMax:Math.round(mx(k)),keyToFrameAvg:avg(f),keyToFrameMax:mx(f),longTasks:lt.length,worst:lt.sort((a,b)=>b-a).slice(0,3)}})()`;

export function connect(ws) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(ws);
    let id = 0; const pend = new Map();
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
    sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
    sock.onerror = reject;
    const keepAlive = setInterval(() => {}, 1000);
    sock.onclose = () => { if (!T.closing) { console.log('!! TV connection closed (app crashed or was restarted?)'); T.summary(); process.exit(2); } };
    const T = {
      send,
      closing: false,
      async ev(x) { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, timeout: 60000 }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; },
      async down(k) { const c = KEYS[k] || +k; await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: c, nativeVirtualKeyCode: c }); },
      async up(k) { const c = KEYS[k] || +k; await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: c, nativeVirtualKeyCode: c }); },
      async press(k) { await T.down(k); await T.up(k); },
      // 'Right*3,Down,Enter'
      async keys(seq, gap = 300) { for (const p of seq.split(',')) { const [n, c] = p.split('*'); for (let i = 0; i < (+c || 1); i++) { await T.press(n.trim()); await sleep(gap); } } },
      // hold like the real remote: plain keydowns every `every` ms, then one keyup
      async hold(k, ms, every = 100) { await T.down(k); for (let t = every; t < ms; t += every) { await sleep(every); await T.down(k); } await T.up(k); },
      async waitFor(expr, ms = 20000, step = 100) { const t = Date.now(); while (Date.now() - t < ms) { const v = await T.ev(expr).catch(() => null); if (v) return v; await sleep(step); } return null; },
      P: async () => JSON.parse(await T.ev('JSON.stringify(__jfPlayer())')),
      results: [],
      // record one check: pass = truthy
      check(name, pass, info) {
        T.results.push({ name, pass: !!pass, info });
        console.log((pass ? 'PASS ' : 'FAIL ') + name.padEnd(52) + (info === undefined ? '' : ' ' + (typeof info === 'string' ? info : JSON.stringify(info))));
        return !!pass;
      },
      note(name, info) { console.log('     ' + name.padEnd(52) + ' ' + (typeof info === 'string' ? info : JSON.stringify(info))); },
      summary() { const f = T.results.filter((r) => !r.pass); console.log(`\n== ${T.results.length - f.length}/${T.results.length} passed` + (f.length ? '; FAILED: ' + f.map((r) => r.name).join(' | ') : '')); return f.length; },
      close() { T.closing = true; clearInterval(keepAlive); sock.close(); },
    };
    sock.onopen = () => resolve(T);
  });
}
