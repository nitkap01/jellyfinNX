// Player basics with single key taps (plain keydown + keyup, like the real remote):
// Right/Left/FF/RW taps = 10 s each, OK pause/play, Play/Pause keys, Back restores the details focus.
//   node test/tv-func-taps.mjs <ws> <movieId>
import { connect, sleep } from './lib.mjs';

const [, , ws, id] = process.argv;
const T = await connect(ws);
const { ev, press, check, waitFor } = T;
const tip = () => ev(`(document.querySelector('.p-tip.on')||{}).textContent||''`);
async function settled() { await waitFor(`(()=>{const s=__jfPlayer();return s&&!document.querySelector('.p-spin.on')&&!document.querySelector('.p-tip.on')})()`, 15000); await sleep(400); return T.P(); }

await ev('__jfReset()'); await sleep(300);
await ev(`__jfOpen('${id}')`); await sleep(2500);
await ev('delete __jf.marks.playMs');
await press('Enter');
const ms = await waitFor('__jf.marks.playMs', 30000);
check('starts (direct play)', ms, { firstFrameMs: ms, engine: await ev('__jf.marks.playEngine') });
await sleep(3000);
// Each tap must move the bar exactly 10 s from where the video is. (Where the video then really lands depends on
// the file's keyframes: AVPlay seeks to a keyframe, so the final position can differ by a few seconds.)
const clock = (t) => t.split(':').reduce((a, x) => a * 60 + +x, 0);
for (const [k, dir] of [['Right', 1], ['Left', -1], ['FF', 1], ['RW', -1]]) {
  const steps = [];
  for (let i = 0; i < 2; i++) {
    const a = await settled();
    await press(k); await sleep(120);
    const t = await tip();
    steps.push(clock(t.replace(/[^0-9:].*$/, '')) - Math.floor(a.pos / 1000));
    await sleep(300);
  }
  const b = await settled();
  check(`${k}: each tap moves the bar 10 s`, steps.every((x) => Math.abs(x - dir * 10) <= 1), { steps, landedAt: Math.round(b.pos / 1000) });
}
let s = await T.P();
await press('Enter'); await sleep(700);
s = await T.P();
check('OK pauses (controls shown)', s.paused && await ev(`!!document.querySelector('.p-ui.on')`));
const p0 = s.pos; await sleep(1500);
check('paused: position stays', Math.abs((await T.P()).pos - p0) < 300);
await press('Enter'); await sleep(1500);
check('OK plays again', !(await T.P()).paused);
await press('Pause'); await sleep(600);
check('Pause key pauses', (await T.P()).paused);
await press('Play'); await sleep(600);
check('Play key plays', !(await T.P()).paused);
await press('PlayPause'); await sleep(600);
const pp = (await T.P()).paused;
await press('PlayPause'); await sleep(600);
check('Play/Pause key toggles', pp && !(await T.P()).paused);
await sleep(1500);
await ev(REC2());
await press('Back'); await sleep(1500);
check('Back: player closed, details focused on Resume', !(await T.P()) && (await ev(`(document.querySelector('.details.on .btn.f')||{}).textContent`)) === 'Resume', { backMs: await ev('__jf.frames[0]') });
await sleep(1500);
await press('Back'); await sleep(1500);
const cw = await ev(`(()=>{const r=__jfApp.screen('home').rows.list[0];return r.items.findIndex(i=>i.Id==='${id}')})()`);
check('Continue Watching has it first', cw === 0, cw);
function REC2() { return '__jf.frames.length=0'; }
const f = T.summary(); T.close(); process.exit(f ? 1 : 0);
