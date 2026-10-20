// Full speed test of JellyfinFlix on the real TV over CDP.
//   node test/tv-perf.mjs <ws> [runs=2] [noplay]
// Measures (each run):
//  launch      page reload -> first row in DOM / first row posters loaded (ms since navigation start)
//  rowRight    20 presses Right inside a long row        rowLeft   20 presses Left back
//  vertical    20 presses Down/Up across rows (10 + 10)
//  holdRight   holding Right for 2 s (auto-repeat every 50 ms): long tasks, moves done vs repeats sent
//  details     OK on a movie -> overlay drawn (ms);  backDetails  Back -> Home drawn (ms)
//  play        Play -> first video frame (AVPlay first time update);  seek  5 presses Right in the player:
//              bar update per press (ms) and time until the video plays again;  ffrw  FF/RW keys;  backPlayer
const [, , ws, runsArg = '2', noplay] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009, FF: 417, RW: 412, PlayPause: 10252 };
async function down(name, repeat) { const c = KEYS[name]; await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: c, nativeVirtualKeyCode: c, autoRepeat: !!repeat }); }
async function up(name) { const c = KEYS[name]; await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: c, nativeVirtualKeyCode: c }); }
async function press(name) { await down(name); await up(name); }
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function waitFor(expr, ms = 20000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await ev(expr).catch(() => null); if (v) return v; await sleep(50); }
  return null;
}
const REC = `(()=>{window.__lt=[];__jf.keys.length=0;__jf.frames.length=0;if(!window.__lto){window.__lto=new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__lt&&window.__lt.push(Math.round(e.duration))));window.__lto.observe({entryTypes:['longtask']});}return 1})()`;
const READ = `(()=>{const k=__jf.keys.slice(),f=__jf.frames.slice(),lt=(window.__lt||[]).slice();const mx=a=>a.length?Math.max(...a):0;const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):0;
  return {handled:k.length,handlerMax:Math.round(mx(k)),keyToFrameAvg:avg(f),keyToFrameMax:mx(f),longTasks:lt.length,longTaskMs:lt.reduce((a,b)=>a+b,0),worst:lt.sort((a,b)=>b-a).slice(0,3)}})()`;
async function keysTest(seq, gap = 300) {
  await ev(REC);
  for (const k of seq) { await press(k); await sleep(gap); }
  await sleep(700);
  return ev(READ);
}
const reset = () => ev('__jfReset()');
const rowIndex = (re) => ev(`(()=>{const s=__jfApp.screen('home');return s.rows.list.findIndex(r=>${re}.test(r.def.title||''))})()`);
async function gotoRow(re) { await reset(); await sleep(400); const i = await rowIndex(re); for (let j = 0; j <= i; j++) { await press('Down'); await sleep(200); } await sleep(700); return i; }

sock.onopen = async () => {
  const out = [];
  for (let run = 0; run < +runsArg; run++) {
    const R = { run: run + 1 };
    await send('Page.reload', { ignoreCache: false });
    await sleep(800);
    const m = await waitFor(`(window.__jf&&__jf.marks.firstRowImgs)?JSON.stringify({dom:__jf.marks.firstRowDom,imgs:__jf.marks.firstRowImgs}):null`, 20000);
    R.launch = m && JSON.parse(m);
    await sleep(6000); // let the background refresh finish
    // long row: first genre / top rated row (30 items)
    const gi = await gotoRow('/Top Rated|Action|Drama|Comedy/');
    R.rowRight = await keysTest(Array(20).fill('Right'));
    R.rowLeft = await keysTest(Array(20).fill('Left'));
    await gotoRow('/Continue Watching/');
    R.vertical = await keysTest([...Array(10).fill('Down'), ...Array(10).fill('Up')]);
    // hold Right (auto-repeat)
    await gotoRow('/Top Rated|Action|Drama|Comedy/');
    await ev(REC);
    const idx0 = await ev(`__jfApp.screen('home').rows.row.idx`);
    await down('Right');
    let sent = 1;
    for (let t = 0; t < 2000; t += 50) { await sleep(50); await down('Right', true); sent++; }
    await up('Right');
    await sleep(700);
    const h = await ev(READ);
    h.repeatsSent = sent; h.moved = (await ev(`__jfApp.screen('home').rows.row.idx`)) - idx0;
    R.holdRight = h;
    R.genreRow = gi;
    // details + back
    await gotoRow('/Recently Added in Eng Movies/');
    await ev(`delete __jf.marks.detailsMs`);
    R.title = await ev(`(document.querySelector('.fx .ph')||{}).textContent`);
    await press('Enter');
    R.details = await waitFor(`__jf.marks.detailsMs`, 5000);
    await sleep(1500);
    if (!noplay) {
      await ev(`delete __jf.marks.playMs`);
      await press('Enter');
      R.play = await waitFor(`__jf.marks.playMs`, 30000);
      R.engine = await ev(`__jf.marks.playEngine`);
      R.playSteps = await ev(`__jf.marks.playSteps`);
      R.warm = await ev(`__jf.marks.warm + " used=" + __jf.marks.warmUsed`);
      await sleep(3000);
      // seek: 5 quick Right presses, then wait for playback to continue
      await ev(REC);
      for (let i = 0; i < 5; i++) { await press('Right'); await sleep(120); }
      const ts = Date.now();
      await ev(`window.__pt0=null`);
      const resumed = await waitFor(`(()=>{const b=document.querySelector('.p-spin');return b&&!b.classList.contains('on')&&!document.querySelector('.p-tip.on')})()`, 15000);
      R.seekPress = await ev(READ);
      R.seekResumeMs = resumed ? Date.now() - ts : null;
      await sleep(2500);
      await ev(REC);
      await press('FF'); await sleep(150); await press('FF'); await sleep(150); await press('RW');
      await sleep(1500);
      R.ffrw = await ev(READ);
      await sleep(1500);
      await ev(REC);
      await press('Back');
      await sleep(800);
      R.backPlayer = await ev(READ);
      await sleep(1500);
    }
    await ev(REC);
    await press('Back');
    await sleep(800);
    R.backDetails = await ev(READ);
    out.push(R);
  }
  console.log(JSON.stringify(out, null, 1));
  sock.close(); process.exit(0);
};
