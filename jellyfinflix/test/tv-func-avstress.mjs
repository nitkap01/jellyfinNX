// Audio/subtitle switching stress test on the TV (the owner once saw a crash after changing subtitles then audio).
//   node test/tv-func-avstress.mjs <ws> [rounds=1] [ids]
// For each file: rapid subtitle -> audio -> subtitle -> audio changes through the real menu (plain key presses,
// 100 ms apart), then changes while the stream restarts (quality change), then checks: app alive, video playing,
// the last choices applied, no error dialog, no new E lines in the app log. Each file plays a few minutes from its
// resume point; restore the resume points afterwards with tools/testdata.py restore.
import { connect, sleep } from './lib.mjs';

const FILES = {
  '0448c6b8de3e39bf3fd01a6eed35be26': { name: 'Invaders from Mars (ita/eng AC3, srt)', audio: [2, 3], subs: [-1, 0, 4, 5, 6] },
  '53380bc84f207e35064080e6dc37680b': { name: 'Crystal Skull (3 AAC)', audio: [1, 2, 3], subs: [-1, 4] },
  'd807f3c5f449fa552fb43f3091397bc8': { name: 'Last Crusade (PGS + srt)', audio: [1], subs: [-1, 2, 3, 4] },
  '02adb852b13e0acf2e9d8f8dda2dd583': { name: 'Love Actually (EAC3/TrueHD/AC3, PGS)', audio: [1, 2, 3], subs: [-1, 4, 5, 6] },
};
const [, , ws, roundsArg = '1', idsArg] = process.argv;
const ids = idsArg ? idsArg.split(',') : Object.keys(FILES);
const T = await connect(ws);
const { ev, keys, press, check, note } = T;
const GAP = 100;

async function menuOpen() {
  const st = await ev(`(()=>{const f=document.querySelector('.p-ui.on .pc.f');return f?f.textContent:''})()`);
  if (st !== 'Audio & Subtitles') {
    await press('Down'); await sleep(250);
    const n = await ev(`[...document.querySelectorAll('.pc')].findIndex(b=>/Audio/.test(b.textContent))`);
    const cur = await ev(`[...document.querySelectorAll('.pc')].findIndex(b=>b.classList.contains('f'))`);
    for (let i = cur; i < n; i++) { await press('Right'); await sleep(GAP); }
    for (let i = cur; i > n; i--) { await press('Left'); await sleep(GAP); }
  }
  await press('Enter'); await sleep(150);
  return ev(`!!document.querySelector('.p-menu.on')`);
}
// cat 0 = Audio, 1 = Subtitles, 4 = Quality; opt = row in that list
async function pick(cat, opt) {
  if (!(await menuOpen())) return false;
  for (let i = 0; i < cat; i++) { await press('Down'); await sleep(GAP); }
  await press('Right'); await sleep(GAP);
  // focus starts on the active choice; short lists (<= 11) show every row, so move straight to the wanted one
  const L = await ev(`(()=>{const l=[...document.querySelectorAll('.pm-opts .pm-i')];return {n:l.length,f:l.findIndex(e=>e.classList.contains('f'))}})()`);
  if (L.n < 11 && L.f >= 0) {
    for (let i = L.f; i < opt; i++) { await press('Down'); await sleep(GAP); }
    for (let i = L.f; i > opt; i--) { await press('Up'); await sleep(GAP); }
  } else {
    for (let i = 0; i < 12; i++) { await press('Up'); await sleep(90); }
    for (let i = 0; i < opt; i++) { await press('Down'); await sleep(GAP); }
  }
  await press('Enter'); await sleep(GAP);
  return true;
}
async function settle(ms = 45000) {
  const t = Date.now(); let p0 = -1, ok = 0;
  while (Date.now() - t < ms) {
    await sleep(700);
    const s = await T.P();
    if (!s) return { closed: true, ms: Date.now() - t };
    const spin = await ev(`!!document.querySelector('.p-spin.on')`);
    if (p0 >= 0 && s.pos > p0 + 300 && !spin) { if (++ok >= 2) return { ms: Date.now() - t, s }; } else ok = 0;
    p0 = s.pos;
  }
  return { timeout: true, s: await T.P() };
}
const errLines = async () => ev(`__jfLog.dump().filter(l=>/ E /.test(l.slice(18,30))).length`);
const dlg = () => ev(`(document.querySelector('.dlg')||{}).textContent||''`);

for (let round = 0; round < +roundsArg; round++) {
  for (const id of ids) {
    const F = FILES[id];
    note('---- ' + F.name, 'round ' + (round + 1));
    await ev('__jfReset()'); await sleep(300);
    await ev(`__jfOpen('${id}')`); await sleep(2500);
    const e0 = await errLines();
    await press('Enter');
    let r = await settle(30000);
    check(F.name + ': starts', r.s, { ms: r.ms, method: r.s && r.s.method });
    if (!r.s) { await press('Back'); await sleep(2000); await press('Back'); continue; }
    // burst: sub, audio, sub, audio, sub off, audio last (as fast as the menu allows)
    const A = F.audio, Sx = F.subs;
    const seq = [[1, Math.min(1, Sx.length - 1)], [0, Math.min(1, A.length - 1)], [1, Math.min(2, Sx.length - 1)], [0, 0], [1, 0], [0, A.length - 1]];
    const t0 = Date.now();
    for (const [c, o] of seq) await pick(c, o);
    note('burst of 6 changes took', (Date.now() - t0) + ' ms');
    r = await settle();
    const s1 = r.s || {};
    check(F.name + ': alive + playing after the burst', !r.closed && !r.timeout && !/Playback problem/.test(await dlg()), { settleMs: r.ms, method: s1.method, audio: s1.audio, sub: s1.sub, pos: s1.pos });
    check(F.name + ': last choices applied (sub off, last audio)', s1.sub === -1 && s1.audio === A[A.length - 1], { audio: s1.audio, sub: s1.sub });
    // changes while the stream restarts: quality 720p, then at once subtitle 1 + audio 0, then Original
    await pick(4, 2);
    await pick(1, 1);
    await pick(0, 0);
    r = await settle();
    const s2 = r.s || {};
    check(F.name + ': changes during a restart applied', !r.closed && !r.timeout && s2.sub === Sx[1] && s2.audio === A[0], { settleMs: r.ms, method: s2.method, audio: s2.audio, sub: s2.sub });
    // and the other order: quality back to Original, then at once audio last + subtitles off
    await pick(4, 0);
    await pick(0, A.length - 1);
    await pick(1, 0);
    r = await settle();
    const s3 = r.s || {};
    check(F.name + ': back to Original + audio/subs changed during that restart', !r.closed && !r.timeout && s3.sub === -1 && s3.audio === A[A.length - 1], { settleMs: r.ms, method: s3.method, audio: s3.audio, sub: s3.sub });
    const e1 = await errLines();
    check(F.name + ': no new error lines in the app log', e1 === e0, e1 > e0 ? await ev(`__jfLog.dump().filter(l=>/ E /.test(l.slice(18,30))).slice(-3)`) : '');
    const d = await dlg();
    if (d) { note('dialog', d); await press('Enter'); await sleep(300); }
    await press('Back'); await sleep(2500);
    check(F.name + ': Back -> details', await ev(`!!document.querySelector('.details.on') && !__jfPlayer()`));
    await press('Back'); await sleep(800);
  }
}
const failed = T.summary();
T.close();
process.exit(failed ? 1 : 0);
