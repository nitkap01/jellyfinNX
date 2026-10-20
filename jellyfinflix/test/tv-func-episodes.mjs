// In-player Episodes panel on the TV: open time, focus moves, season switch, Back, choose another episode.
//   node test/tv-func-episodes.mjs <ws> <episodeId>     (an episode in the middle of a season of a multi-season show)
// Each episode plays well under a minute, so Jellyfin does not save a resume point for it.
const [, , ws, epId] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009 };
async function press(k) { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] }); }
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, timeout: 60000 }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
async function waitFor(expr, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await ev(expr).catch(() => null); if (v) return v; await sleep(50); } return null; }
const keepAlive = setInterval(() => {}, 1000); // a lost TV connection must not end the script silently
sock.onclose = () => { console.log('TV connection closed'); process.exit(1); };
async function shot(file) {
  const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(8000).then(() => null)]);
  const fs = await import('fs');
  if (r && r.data) { fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; }
  // this TV gives no screenshots over CDP: save the panel's HTML instead (open it with the built CSS on a desktop)
  fs.writeFileSync(file.replace(/\.png$/, '.html'), await ev(`document.querySelector('.p-eps').outerHTML`));
  return 'saved panel HTML ' + file.replace(/\.png$/, '.html');
}
const out = (k, v) => console.log(k.padEnd(24), typeof v === 'string' ? v : JSON.stringify(v));
const REC = `(()=>{window.__lt=[];__jf.keys.length=0;__jf.frames.length=0;if(!window.__lto){window.__lto=new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__lt&&window.__lt.push(Math.round(e.duration))));window.__lto.observe({entryTypes:['longtask']});}return 1})()`;
const READ = `(()=>{const k=__jf.keys.slice(),f=__jf.frames.slice(),lt=(window.__lt||[]).slice();const mx=a=>a.length?Math.max(...a):0;const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):0;
  return {presses:k.length,handlerMax:Math.round(mx(k)),keyToFrameAvg:avg(f),keyToFrameMax:mx(f),longTasks:lt.length,worst:lt.sort((a,b)=>b-a).slice(0,3)}})()`;
const P = async () => JSON.parse(await ev('JSON.stringify(__jfPlayer())'));
const panel = `(()=>{const r=document.querySelector('.p-eps.on');if(!r)return null;const rows=[...r.querySelectorAll('.pe-e')];const f=r.querySelector('.pe-e.f');
  return {season:(r.querySelector('.pe-s.sel')||{}).textContent,seasonFocused:!!r.querySelector('.pe-s.f'),rows:rows.length,focused:f&&f.querySelector('.pe-t').textContent,
  focusedIsNow:!!(f&&f.classList.contains('now')),now:(r.querySelector('.pe-e.now .pe-t')||{}).textContent,imgs:r.querySelectorAll('.pe-th img').length,msg:r.querySelector('.pe-msg').textContent}})()`;

async function toEpisodesButton() {
  await press('Down'); await sleep(400); // controls on, first button focused
  const n = await ev(`[...document.querySelectorAll('.p-ctrls .pc')].findIndex(e=>e.textContent==='Episodes')`);
  const cur = await ev(`[...document.querySelectorAll('.p-ctrls .pc')].findIndex(e=>e.classList.contains('f'))`);
  for (let i = cur; i < n; i++) { await press('Right'); await sleep(250); }
  return n;
}

sock.onopen = async () => {
  try {
    await ev('__jfReset()');
    out('details', await ev(`__jfOpen('${epId}')`));
    await sleep(2500);
    await ev('delete __jf.marks.playMs');
    await press('Enter');
    out('play first frame ms', await waitFor('__jf.marks.playMs', 30000));
    await sleep(5000); // panel data is fetched 1.5 s after the start
    let s = await P();
    out('playing', { item: s.item, pos: s.pos });
    out('buttons', await ev(`[...document.querySelectorAll('.p-ctrls .pc')].map(e=>e.textContent||'(icon)').join(' | ')`));
    const bi = await toEpisodesButton();
    out('episodes button index', bi);

    // 1. open
    await ev(REC);
    await press('Enter');
    await sleep(600);
    out('open: panel', await ev(panel));
    out('open: build ms', await ev('__jf.marks.epsOpenMs'));
    out('open: key->screen', await ev(READ));
    s = await P();
    out('open: video', { pos: s.pos, paused: s.paused, zone: s.zone });
    await sleep(800);
    out('open: thumbnails', await ev(`[...document.querySelectorAll('.p-eps .pe-th img')].map(i=>i.naturalWidth+'x'+i.naturalHeight).join(' ')`));
    out('open: screenshot', await shot('/tmp/eps-open.png'));

    // 2. focus moves in the list
    await ev(REC);
    for (const k of ['Down', 'Down', 'Down', 'Down', 'Down', 'Down', 'Up', 'Up', 'Up', 'Up']) { await press(k); await sleep(300); }
    await sleep(500);
    out('moves: key->screen', await ev(READ));
    out('moves: panel', await ev(panel));

    // 3. season switch: Left to seasons, Down = next season (fetched), Up = back (cached)
    await press('Left'); await sleep(300);
    out('seasons: panel', await ev(panel));
    const before = (await ev(panel)).now;
    await ev(REC);
    await ev('window.__swT=performance.now()');
    await press('Down');
    const sw1 = await waitFor(`(()=>{const r=document.querySelector('.p-eps .pe-e');return r&&!document.querySelector('.p-eps .pe-e.now')?Math.round(performance.now()-__swT):0})()`, 8000);
    out('season next: rows ms', sw1);
    out('season next: panel', await ev(panel));
    await sleep(800);
    await ev('window.__swT=performance.now()');
    await press('Up');
    const sw2 = await waitFor(`(()=>document.querySelector('.p-eps .pe-e.now')?Math.round(performance.now()-__swT):0)()`, 8000);
    out('season back: rows ms', sw2);
    await sleep(500);
    out('season keys: key->screen', await ev(READ));
    out('seasons: screenshot', await shot('/tmp/eps-seasons.png'));
    await press('Right'); await sleep(300);
    out('back to list: panel', await ev(panel));

    // 4. Back closes the panel, video goes on (no restart)
    const p0 = (await P()).pos;
    await ev(REC);
    await press('Back');
    await sleep(500);
    out('back: key->screen', await ev(READ));
    await sleep(1500);
    s = await P();
    out('back: after', { panelOpen: !!(await ev(panel)), zone: s.zone, item: s.item, posBefore: p0, posAfter: s.pos, restarted: s.pos < p0 - 2000 });

    // 5. choose the next episode in the list
    await sleep(300);
    out('focused button', await ev(`(document.querySelector('.p-ctrls .pc.f')||{}).textContent`));
    await press('Enter'); await sleep(500);
    out('reopen: build ms', await ev('__jf.marks.epsOpenMs'));
    await press('Down'); await sleep(900); // stays focused > 600 ms -> its PlaybackInfo is prefetched
    const pick = (await ev(panel)).focused;
    await ev('delete __jf.marks.playMs; delete __jf.marks.epChoose');
    await ev(REC);
    await press('Enter');
    await sleep(400);
    out('choose: key->screen', await ev(READ));
    const pm = await waitFor('__jf.marks.playMs', 30000);
    const m = await ev('JSON.stringify({c:__jf.marks.epChoose,p:__jf.marks.playPress,ms:__jf.marks.playMs,steps:__jf.marks.playSteps,engine:__jf.marks.playEngine})');
    const mm = JSON.parse(m);
    out('choose: picked', pick);
    out('choose: first frame', { fromOkMs: pm ? mm.p + mm.ms - mm.c : null, startMs: mm.ms, engine: mm.engine, steps: mm.steps });
    await sleep(1500);
    s = await P();
    out('choose: playing', { item: s.item, pos: s.pos, method: s.method, panelOpen: !!(await ev(panel)) });

    // 5b. reopen: the episode just left shows its runtime (under 5 % watched = no resume point) and the new one is Now playing
    await toEpisodesButton(); await press('Enter'); await sleep(600);
    out('reopen: rows', await ev(`[...document.querySelectorAll('.p-eps .pe-e')].map(r=>r.querySelector('.pe-t').textContent.split(' ')[0]+' '+r.querySelector('.pe-m').textContent+(r.querySelector('.pb')?' [bar]':'')).join(' | ')`));
    await press('Back'); await sleep(500);

    // 6. Back out of the player and details
    await press('Back'); await sleep(2000);
    out('after back', { player: await P(), top: await ev(`__jfApp.top()===__jfApp.current?'screen':'overlay'`) });
    await press('Back'); await sleep(800);
    out('logs', await ev(`__jfLog.dump().filter(l=>/episodes/.test(l)).slice(-6).map(l=>l.slice(19,160))`));
  } catch (e) { console.log('FAILED', e.message); }
  clearInterval(keepAlive); sock.onclose = null; sock.close(); process.exit(0);
};
