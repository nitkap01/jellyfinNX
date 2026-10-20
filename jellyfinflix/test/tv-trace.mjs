// Trace the TV page main thread while pressing keys; print where the time goes.
//   node test/tv-trace.mjs <ws> 'Down*5,Up*5' [gapMs]
const [, , ws, seqArg, gapArg = '400'] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map(); const events = [];
let done = null;
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); return; }
  if (m.method === 'Tracing.dataCollected') events.push(...m.params.value);
  if (m.method === 'Tracing.tracingComplete' && done) done();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009 };
sock.onopen = async () => {
  await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,gpu,v8', transferMode: 'ReportEvents' });
  for (const p of seqArg.split(',')) {
    const [n, c] = p.split('*');
    for (let i = 0; i < (+c || 1); i++) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: n, code: n, windowsVirtualKeyCode: KEYS[n], nativeVirtualKeyCode: KEYS[n] });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: n, code: n, windowsVirtualKeyCode: KEYS[n], nativeVirtualKeyCode: KEYS[n] });
      await sleep(+gapArg);
    }
  }
  await sleep(1000);
  const fin = new Promise((r) => { done = r; });
  await send('Tracing.end');
  await fin;
  const threads = {};
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threads[e.pid + ':' + e.tid] = e.args.name;
  const by = {};
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue;
    const th = threads[e.pid + ':' + e.tid] || '?';
    const k = th + ' | ' + e.name;
    by[k] = by[k] || { ms: 0, n: 0, max: 0 };
    by[k].ms += e.dur / 1000; by[k].n++; by[k].max = Math.max(by[k].max, e.dur / 1000);
  }
  const rows = Object.entries(by).sort((a, b) => b[1].ms - a[1].ms).slice(0, 30)
    .map(([k, v]) => k.padEnd(70) + ' ' + Math.round(v.ms).toString().padStart(6) + ' ms  n=' + v.n + '  max=' + Math.round(v.max));
  console.log(rows.join('\n'));
  if (process.env.DETAIL) {
    const t0 = Math.min(...events.filter((e) => e.ts).map((e) => e.ts));
    const main = events.filter((e) => e.ph === 'X' && e.dur > +process.env.DETAIL * 1000 && /Renderer|Main/.test(threads[e.pid + ':' + e.tid] || ''));
    console.log(main.sort((a, b) => a.ts - b.ts).map((e) => Math.round((e.ts - t0) / 1000) + 'ms ' + e.name + ' ' + Math.round(e.dur / 1000) + 'ms ' + JSON.stringify(e.args && (e.args.data || e.args.beginData) || {}).slice(0, 140)).join('\n'));
  }
  sock.close(); process.exit(0);
};
