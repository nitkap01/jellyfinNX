// Full QA round on the TV (no player deep-dive; see tv-func-player/settings/avstress/episodes/next/seekhold for that).
//   node test/tv-func-qa.mjs <ws> [sections]      sections: launch,billboard,rows,details,search (default all)
// Keys are plain keydowns like the real remote (test/lib.mjs). Changes nothing on the server except a My List
// toggle that is put back, and a few seconds of playback (Play key test) — restore with tools/testdata.py.
// Fix Audio / Fetch Subtitle are NOT run: the page's fetch is wrapped so the helper's POST /jobs is only recorded.
import { connect, sleep, REC, READ } from './lib.mjs';

const [, , ws, only = 'launch,billboard,rows,details,search'] = process.argv;
const DEATH_RACE = '10afc9b9da49c570dfe11dc2a92d3b37'; // audio fixed (known)
const SERIES = 'c19aeb79962eb8c4fe08da74ea4a3396'; // That '70s Show, 8 seasons
const T = await connect(ws);
const { ev, keys, press, hold, waitFor, check, note } = T;
const want = (s) => only.split(',').includes(s);
const scr = () => ev('document.body.dataset.screen');
const topIsScreen = () => ev('__jfApp.top()===__jfApp.current');
const railOpen = () => ev(`!!document.querySelector('.rail.open')`);
const heroBtns = () => ev(`[...document.querySelectorAll('.screen.on .h-btns .btn')].map(b=>(b.classList.contains('f')?'*':'')+b.textContent).join(' | ')`);
const home = (x) => ev(`(()=>{const s=__jfApp.screen('home');return ${x}})()`);
async function reset() { await ev('__jfReset()'); await sleep(400); }
async function gotoRow(re) { await reset(); const i = await home(`s.rows.list.findIndex(r=>${re}.test(r.def.title||''))`); if (i < 0) return -1; await keys('Down*' + (i + 1), 220); await sleep(500); return i; }

try {
  // ---------------- 1. launch, profiles, rail, back/exit ----------------
  if (want('launch')) {
    await T.send('Page.reload', { ignoreCache: false });
    await sleep(600);
    const m = await waitFor(`window.__jf&&__jf.marks.firstRowDom?JSON.stringify(__jf.marks):null`, 15000);
    const mk = m && JSON.parse(m);
    check('launch: first row on screen', mk && mk.firstRowDom < 1500, mk && { firstRowDom: mk.firstRowDom, shell: mk.shell });
    await sleep(5000);
    check('launch: opens on Home', (await scr()) === 'home');
    // Profile via rail
    await reset(); await keys('Down,Left'); await sleep(300);
    check('rail opens with Left from first card', await railOpen());
    await keys('Up*2,Enter'); await sleep(1500);
    check('rail -> Who\'s watching', (await scr()) === 'profiles', await ev(`[...document.querySelectorAll('.pr-tile')].map(t=>(t.classList.contains('f')?'*':'')+t.textContent).join(' | ')`));
    const f = await ev(`(document.querySelector('.pr-tile.f .pr-name')||{}).textContent`);
    if (f === 'admin') { await press('Enter'); await sleep(3000); } else { await press('Back'); await sleep(2000); }
    check('profile pick -> Home', (await scr()) === 'home', f);
    const screens = [['Shows', 'Down', 'shows'], ['Movies', 'Down*2', 'movies'], ['My List', 'Down*3', 'mylist'], ['Search', 'Up', 'search'], ['Home', '', 'home']];
    for (const [label, mv, id] of screens) {
      await reset(); await keys('Down,Left'); if (mv) await keys(mv); await keys('Enter'); await sleep(2500);
      const s = await scr();
      const info = await ev(`[...document.querySelectorAll('.screen.on .row-title, .screen.on .s-head, .screen.on .scr-title')].slice(0,3).map(e=>e.textContent).join(', ') + ' | cards ' + document.querySelectorAll('.screen.on .card').length`);
      check('rail -> ' + label, s === id && (await topIsScreen()) && !/cards 0$/.test(info), info);
      if (id === 'shows' || id === 'movies') {
        await keys('Down'); await sleep(300);
        const i0 = await ev(`__jfApp.screen('${id}').rows.row.idx`); // rows remember their position
        await keys('Right*2'); await sleep(400);
        check(label + ': rows move', (await ev(`(()=>{const r=__jfApp.screen('${id}').rows.row;return r.idx===Math.min(${i0}+2,r.items.length-1)})()`)));
        await keys('Back'); await sleep(300); // rows -> billboard
        await keys('Back'); await sleep(800); // billboard -> Home
        check(label + ': Back goes Home', (await scr()) === 'home');
      }
      if (id === 'mylist') {
        await keys('Right,Down'); await sleep(300);
        check('My List grid: Right/Down move', (await ev(`(()=>{const r=__jfApp.screen('mylist').rows;return r.r+':'+r.row.idx})()`)) === '1:1' || (await ev(`__jfApp.screen('mylist').rows.list.length`)) < 2);
        await keys('Back'); await sleep(300); await keys('Back'); await sleep(800);
        check('My List: Back goes Home', (await scr()) === 'home');
      }
    }
    // exit prompt from Home top: centred, Cancel focused, Back closes it
    await reset(); await press('Back'); await sleep(500);
    const d = await ev(`(()=>{const c=document.querySelector('.dlg-card');if(!c)return null;const r=c.getBoundingClientRect();const b=[...c.querySelectorAll('.btn')].map(x=>{const q=x.getBoundingClientRect();return [x.textContent,x.classList.contains('f'),Math.round(q.left+q.width/2)]});return {title:c.querySelector('.dlg-title').textContent,cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),b}})()`);
    check('exit prompt shown, centred', d && Math.abs(d.cx - 960) <= 4 && Math.abs(d.cy - 540) <= 4 && /Exit/.test(d.title), d);
    check('exit prompt: Cancel focused, buttons centred', d && d.b[1][1] && Math.abs((d.b[0][2] + d.b[1][2]) / 2 - 960) <= 4);
    await press('Back'); await sleep(400);
    check('exit prompt: Back cancels', !(await ev(`!!document.querySelector('.dlg')`)) && (await scr()) === 'home');
    // Back from rows: first back = billboard, then exit prompt
    await reset(); await keys('Down*3'); await press('Back'); await sleep(400);
    check('Back from a lower row -> billboard', (await ev(`document.querySelector('.screen.on').classList.contains('top')`)) && !(await ev(`!!document.querySelector('.dlg')`)));
  }

  // ---------------- 2. billboard ----------------
  if (want('billboard')) {
    await reset(); await sleep(300);
    const b0 = await heroBtns();
    check('billboard buttons (featured)', /^\*Play \| More Info$|^\*Resume · .+ left \| Start Over \| More Info$/.test(b0), b0);
    const cw = await home(`s.rows.list[0].def.title`);
    check('first row is Continue Watching', /^Continue Watching/.test(cw), cw);
    await keys('Down'); await sleep(500);
    for (let i = 0; i < 3; i++) {
      const it = JSON.parse(await home(`JSON.stringify((({Name,Type,SeriesName,RunTimeTicks,UserData})=>({Name,Type,SeriesName,RunTimeTicks,pos:UserData&&UserData.PlaybackPositionTicks}))(s.rows.item))`));
      const left = Math.max(1, Math.round((it.RunTimeTicks - it.pos) / 6e8));
      const lt = left >= 60 ? Math.floor(left / 60) + 'h ' + (left % 60) + 'm' : left + 'm';
      const st = await ev(`(()=>{const h=document.querySelector('.screen.on .h-btns');return {op:getComputedStyle(h).opacity,title:document.querySelector('.screen.on .h-title').textContent,btns:[...h.querySelectorAll('.btn')].map(b=>b.textContent).join(' | ')}})()`);
      check(`CW card ${i + 1}: billboard buttons visible + right`, st.op === '1' && st.btns === `Resume · ${lt} left | Start Over | More Info` && st.title === (it.Type === 'Episode' ? it.SeriesName : it.Name), { item: it.Name, ...st });
      if (i < 2) { await keys('Right'); await sleep(450); }
    }
    // Up selects the buttons for the focused card
    const card = await home(`s.rows.item.Name`);
    await keys('Up'); await sleep(400);
    const hb = await heroBtns();
    check('Up from CW card: Resume focused, same title', /^\*Resume · /.test(hb), hb);
    await keys('Right*2,Enter'); await sleep(1500);
    const dt = await ev(`document.querySelector('.details.on')?(document.querySelector('.d-sub').textContent+' / '+document.querySelector('.d-title').textContent):null`);
    check('More Info opens that card', dt && dt.indexOf(card) >= 0, dt);
    await press('Back'); await sleep(600);
    check('Back from details -> billboard, More Info still focused', (await heroBtns()).indexOf('*More Info') >= 0 && (await topIsScreen()));
    // OK on cards opens details (never plays) in several rows
    for (const re of ['/Continue Watching/', '/Next Up|My List/', '/Recently Added/', '/Top Rated/']) {
      const i = await gotoRow(re);
      if (i < 0) { note('row not found', re); continue; }
      const name = await home(`s.rows.item.Name`);
      await press('Enter'); await sleep(1200);
      const ok = await ev(`!!document.querySelector('.details.on') && !__jfPlayer()`);
      check('OK on card opens details, no playback: ' + re, ok, name);
      await press('Back'); await sleep(600);
      check('Back restores the row focus: ' + re, (await topIsScreen()) && (await home('s.rows.r')) === i && (await home('s.rows.item.Name')) === name);
    }
    // Play key on a card plays it; Back returns with focus restored
    await gotoRow('/Continue Watching/'); await keys('Right'); await sleep(300);
    const pn = await home(`s.rows.item.Name`);
    await ev('delete __jf.marks.playMs');
    await press('Play');
    const pm = await waitFor('__jf.marks.playMs', 30000);
    const ps = await T.P();
    check('Play key on a card plays it', ps && ps.item === pn && pm, { item: ps && ps.item, firstFrameMs: pm, method: ps && ps.method });
    await sleep(1500);
    await press('Back'); await sleep(2500);
    check('Back from player -> same card focused', (await topIsScreen()) && (await home('s.rows.r')) === 0 && (await home('s.rows.item.Name')) === pn);
  }

  // ---------------- 3. rows ----------------
  if (want('rows')) {
    const gi = await gotoRow('/Top Rated/');
    const n = await home('s.rows.row.items.length');
    await keys('Right*' + (n + 2), 160); await sleep(400);
    check('row end: Right stops at the last card', (await home('s.rows.row.idx')) === n - 1 && !(await railOpen()), { n });
    await ev(REC);
    await hold('Left', Math.max(3500, n * 140));
    await sleep(600);
    const r1 = await ev(READ);
    check('hold Left to the row start: stops, no rail', (await home('s.rows.row.idx')) === 0 && !(await railOpen()), r1);
    await press('Left'); await sleep(400);
    check('one more Left at the start opens the rail', await railOpen());
    await press('Right'); await sleep(300);
    check('Right closes the rail, focus back in the row', !(await railOpen()) && (await topIsScreen()) && (await home('s.rows.row.idx')) === 0);
    await ev(REC);
    const i0 = await home('s.rows.row.idx');
    await hold('Right', 2000);
    await sleep(700);
    const r2 = await ev(READ);
    const moved = (await home('s.rows.row.idx')) - i0;
    check('hold Right 2 s: moves, no long freeze', moved >= 8 && r2.keyToFrameMax < 250, { moved, ...r2 });
    // vertical: to the last row and back by holding Up
    await gotoRow('/Continue Watching/');
    const rowsN = await home('s.rows.list.length');
    await ev(REC);
    await keys('Down*' + (rowsN + 1), 250);
    await sleep(400);
    const r3 = await ev(READ);
    check('Down to the last row (stops there)', (await home('s.rows.r')) === rowsN - 1, { rows: rowsN, ...r3 });
    await hold('Up', 3500);
    await sleep(600);
    check('hold Up to the first row: stops, billboard not taken', (await home('s.rows.r')) === 0 && !(await ev(`document.querySelector('.screen.on').classList.contains('top')`)));
    await press('Up'); await sleep(400);
    check('one more Up selects the billboard', await ev(`document.querySelector('.screen.on').classList.contains('top')`));
    // no double text on focused cards; missing artwork shows the name placeholder
    const kinds = await home(`[...new Set(s.rows.list.map(r=>r.kind))].join(',')`);
    for (const re of ['/Continue Watching/', '/Next Up/', '/Recently Added/', '/Top Rated/']) {
      if ((await gotoRow(re)) < 0) continue;
      await sleep(900);
      const fx = await ev(`(()=>{const f=document.querySelector('.screen.on .fx.on');if(!f)return null;const vis=[...f.querySelectorAll('.ph,.ttl,.ept,.epm')].filter(e=>getComputedStyle(e).display!=='none'&&e.textContent);const im=f.querySelector('img');
        const imgOk=!!(im&&im.complete&&im.naturalWidth);return {imgOk,texts:vis.filter(e=>!(e.classList.contains('ph')&&imgOk)).map(e=>e.className+':'+e.textContent.slice(0,30))}})()`);
      check('focused card has one title at most: ' + re, fx && fx.texts.filter((t) => /^(ttl|ph|ept)/.test(t)).length <= 1, fx);
    }
    await reset();
    const art = await ev(`(()=>{let cards=0,noImg=0,broken=0,noName=0,double=0;for(const r of __jfApp.screen('home').rows.list){if(!r.built)continue;for(const c of r.cards){if(!c)continue;cards++;const im=c.querySelector('img');const ph=c.querySelector('.ph');
        if(!im)noImg++;else if(im.complete&&!im.naturalWidth)broken++;if((!im||(im.complete&&!im.naturalWidth))&&!(ph&&ph.textContent))noName++;if(im&&im.complete&&!im.naturalWidth&&c.querySelector('.ttl'))double++;}}return {cards,noImg,broken,noName,double}})()`);
    check('cards without artwork show their name, no double text', art.noName === 0 && art.double === 0, { kinds, ...art });
  }

  // ---------------- 4. details ----------------
  if (want('details')) {
    await reset();
    await ev('delete __jf.marks.detailsMs');
    await ev(`__jfOpen('${DEATH_RACE}')`);
    const dms = await waitFor('__jf.marks.detailsMs', 5000);
    await sleep(3000);
    const D = await ev(`(()=>{const q=(s)=>document.querySelector('.details '+s);return {btns:[...document.querySelectorAll('.details .row-btn .btn')].map(b=>b.textContent).join(' | '),meta:q('.d-meta').textContent,metaH:q('.d-meta').offsetHeight,chip:q('.d-chip').className+':'+q('.d-chip').textContent,extra:!!q('.d-extra'),prog:q('.d-prog').textContent,ovLines:Math.round(q('.d-ov').offsetHeight/35),btnH:q('.btn').offsetHeight,btnFont:getComputedStyle(q('.btn')).fontSize,oneLine:new Set([...document.querySelectorAll('.details .row-btn .btn')].map(b=>b.offsetTop)).size===1}})()`);
    check('details (movie) opens fast', dms && dms < 100, { ms: dms });
    check('movie buttons: Resume · Start Over · My List · More', D.btns === 'Resume | Start Over | My List | More', D.btns);
    check('buttons: pills 64 px, 25 px text, one line', D.btnH === 64 && D.btnFont === '25px' && D.oneLine, D);
    check('one meta line + green Audio fixed chip', D.metaH <= 40 && /d-chip ok:Audio fixed/.test(D.chip), D.meta + ' / ' + D.chip);
    check('genres/cast off the main view; min left shown', !D.extra && / min left$/.test(D.prog) && D.ovLines <= 3, D.prog);
    // More popup
    await keys('Right*3'); await ev(REC); await press('Enter'); await sleep(400);
    const mr = await ev(READ);
    const M = await ev(`(()=>{const m=document.querySelector('.d-more.on');if(!m)return null;const r=m.getBoundingClientRect(),b=document.querySelector('.details .btn.f').getBoundingClientRect();return {items:[...m.querySelectorAll('.dm-i')].map(e=>(e.classList.contains('f')?'*':'')+e.textContent).join(' | '),details:[...m.querySelectorAll('.dm-l')].map(e=>e.textContent.slice(0,40)),above:r.bottom<=b.top,left:Math.round(r.left)===Math.round(b.left),icon:!!document.querySelector('.details .btn.f svg circle')}})()`);
    check('More opens a popup above the button', M && M.above && M.left && M.icon, { keyToScreen: mr.keyToFrameMax, ...M });
    check('More: Fix Audio (Audio fixed) + Fetch Subtitle + Details', M && M.items === '*Fix AudioAudio fixed | Fetch Subtitle' && M.details.some((x) => /^Genres:/.test(x)) && M.details.some((x) => /^Cast:/.test(x)), M);
    await press('Down'); await sleep(200);
    check('More: Down moves to Fetch Subtitle', /^\*Fetch Subtitle/.test((await ev(`[...document.querySelectorAll('.d-more .dm-i')].map(e=>(e.classList.contains('f')?'*':'')+e.textContent)`))[1]));
    await press('Back'); await sleep(300);
    check('More: Back closes it, focus stays on More', !(await ev(`!!document.querySelector('.d-more.on')`)) && (await ev(`document.querySelector('.details .btn.f').textContent`)) === 'More');
    // Fix Audio: confirm dialog, Cancel = nothing sent
    await ev(`(()=>{window.__realFetch=window.__realFetch||window.fetch;window.__cap=[];window.__fakeStatus=null;window.fetch=function(u,o){const s=String(u);
      if(s.indexOf(':8099/jobs')>0&&o&&o.method==='POST'){__cap.push(o.body);return Promise.resolve(new Response(JSON.stringify({detail:'test'}),{status:409}));}
      if(s.indexOf(':8099/status')>0&&__fakeStatus)return Promise.resolve(new Response(JSON.stringify(__fakeStatus),{status:200}));return __realFetch.apply(this,arguments);};return 1})()`);
    await press('Enter'); await sleep(300); await press('Enter'); await sleep(500);
    const dlg = await ev(`(document.querySelector('.dlg')||{}).textContent||''`);
    check('Fix Audio asks first (Start / Cancel)', /Fix Audio.*StartCancel/.test(dlg), dlg.slice(0, 60));
    await press('Back'); await sleep(400);
    check('Fix Audio cancelled: nothing sent', (await ev('__cap.length')) === 0 && !(await ev(`!!document.querySelector('.dlg')`)));
    // Start (fake helper answers 409): request is right, message shown
    await keys('Enter'); await sleep(300); await keys('Enter'); await sleep(300); await press('Enter'); await sleep(800);
    const capA = await ev('__cap.slice()');
    const msgA = await ev(`(document.querySelector('.dlg-text')||{}).textContent||''`);
    check('Fix Audio request: {action:fix-audio, path:/MEDIA/…}', capA.length === 1 && /"action":"fix-audio","path":"\/MEDIA\/Eng_Movies\/[^"]*Death Race/i.test(capA[0]), capA[0]);
    check('helper busy -> clear message', /already running/.test(msgA), msgA);
    await press('Enter'); await sleep(400);
    await keys('Enter'); await sleep(300); await keys('Down,Enter'); await sleep(800);
    const capS = await ev('__cap.slice()');
    check('Fetch Subtitle request: {action:fix-subtitle, same path}', capS.length === 2 && /"action":"fix-subtitle","path":"\/MEDIA\//.test(capS[1]), capS[1]);
    await press('Enter'); await sleep(400);
    // running / failed states (fake helper status)
    await ev(`__fakeStatus={state:'running',fixed:false,progressPhase:'encoding',progressPercent:42}`);
    await sleep(4800);
    const chipR = await ev(`document.querySelector('.d-chip').textContent`);
    await keys('Enter'); await sleep(300);
    const runM = await ev(`[...document.querySelectorAll('.d-more .dm-i')].map(e=>e.textContent).join(' | ') + (document.querySelector('.d-more .dm-bar')?' [bar]':'')`);
    check('running fix: amber chip + "Running 42%" with bar', /Fixing audio 42%/.test(chipR) && /Running 42%.*\[bar\]/.test(runM), chipR + ' / ' + runM);
    await press('Back'); await sleep(200);
    await ev(`__fakeStatus={state:'idle',fixed:false,lastResultStatus:'FAIL_VERIFY'}`);
    await sleep(4800);
    await keys('Enter'); await sleep(300);
    const badM = await ev(`[...document.querySelectorAll('.d-more .dm-i, .d-more .dm-l')].map(e=>e.textContent).join(' | ')`);
    const chipB = await ev(`document.querySelector('.d-chip').className`);
    check('failed fix: "Failed" badge, reason in Details, no green chip', /Fix AudioFailed/.test(badM) && /Last fix failed \(FAIL_VERIFY\)/.test(badM) && !/ok/.test(chipB), badM);
    await press('Back'); await sleep(200);
    await ev(`(()=>{window.fetch=window.__realFetch;delete window.__fakeStatus;return 1})()`);
    await sleep(4800);
    check('real status again: green chip back', /ok/.test(await ev(`document.querySelector('.d-chip').className`)));
    await press('Back'); await sleep(600);

    // series
    await reset();
    await ev('delete __jf.marks.detailsMs');
    await ev(`__jfOpen('${SERIES}')`);
    const sms = await waitFor('__jf.marks.detailsMs', 5000);
    await sleep(3500);
    const S1 = await ev(`(()=>({btns:[...document.querySelectorAll('.details .row-btn .btn')].map(b=>b.textContent).join(' | '),seasons:document.querySelectorAll('.details .pill').length,sel:(document.querySelector('.details .pill.sel')||{}).textContent,eps:__jfApp.top().key?document.querySelectorAll('.details .ep').length:0,meta:document.querySelector('.d-meta').textContent}))()`);
    check('series opens fast; buttons Play/Resume SxEy · (Start Over) · My List · More', sms < 100 && /^(Play|Resume) S\d+:E\d+ \| (Start Over \| )?My List \| More$/.test(S1.btns), { ms: sms, ...S1 });
    check('series: seasons + episodes shown', S1.seasons >= 2 && S1.eps > 0 && /Seasons/.test(S1.meta), S1);
    await keys('Down'); await sleep(200);
    const si = await ev(`[...document.querySelectorAll('.details .pill')].findIndex(p=>p.classList.contains('sel'))`);
    await keys(si > 0 ? 'Left' : 'Right'); await sleep(200); await press('Enter'); await sleep(1500);
    const S2 = await ev(`(()=>({sel:(document.querySelector('.details .pill.sel')||{}).textContent,first:(()=>{const st=document.querySelector('.details .row-ep .strip');const x=-parseFloat(st.style.transform.slice(12));const c=[...st.querySelectorAll('.ep')].find(e=>parseInt(e.style.left)===Math.round(x));return c?c.querySelector('.ept').textContent:'?'})(),eps:document.querySelectorAll('.details .ep').length}))()`);
    check('season switch loads that season from episode 1', S2.sel !== S1.sel && S2.eps > 0 && /^1\. /.test(S2.first), S2);
    await keys('Down,Right*2'); await sleep(500);
    const E = await ev(`(()=>{const f=document.querySelector('.details .fx.on');return {focused:(f&&f.querySelector('.ph')||{}).textContent,fxTitleHidden:f&&getComputedStyle(f.querySelector('.ept')).display==='none',under:document.querySelectorAll('.details .row-ep .ep .ept').length}})()`);
    check('episode focus: no double title on the zoomed card', E.fxTitleHidden && E.under > 0, E);
    // My List on and off (back to how it was)
    await keys('Up*3', 250); await keys('Left*5', 150);
    const fi = await ev(`[...document.querySelectorAll('.details .row-btn .btn')].findIndex(b=>/My List/.test(b.textContent))`);
    await keys('Right*' + fi, 250);
    const was = await ev(`document.querySelector('.details .btn.f').innerHTML.indexOf('M4.5 12.5')>=0`);
    await press('Enter'); await sleep(1500);
    const mid = await ev(`document.querySelector('.details .btn.f').innerHTML.indexOf('M4.5 12.5')>=0`);
    const t1 = await ev(`(document.querySelector('.toast.on')||{}).textContent||''`);
    await press('Enter'); await sleep(1500);
    const end = await ev(`document.querySelector('.details .btn.f').innerHTML.indexOf('M4.5 12.5')>=0`);
    check('My List toggles on/off and is restored', mid === !was && end === was && /My List/.test(t1), { was, mid, end, toast: t1 });
    await keys('Right'); await press('Enter'); await sleep(400);
    const SM = await ev(`(()=>{const m=document.querySelector('.d-more.on');return m?{items:m.querySelectorAll('.dm-i').length,lines:[...m.querySelectorAll('.dm-l')].map(e=>e.textContent.slice(0,30))}:null})()`);
    check('series More: details only (no fix items)', SM && SM.items === 0 && SM.lines.length > 0, SM);
    await press('Enter'); await sleep(300);
    check('More with no actions: OK closes it', !(await ev(`!!document.querySelector('.d-more.on')`)));
    await press('Back'); await sleep(600);
    // green tick on the card of a fixed title (Death Race in Continue Watching)
    await reset();
    const tick = await waitFor(`(()=>{const r=__jfApp.screen('home').rows.list[0];const i=r.items.findIndex(x=>x.Id==='${DEATH_RACE}');if(i<0)return 'not in row';const c=r.cards[i];return c?(c.querySelector('.fixok')?'tick':''):'not built'})()`, 8000);
    check('green tick on the Death Race card', tick === 'tick' || tick === 'not in row', tick);
  }

  // ---------------- 6. search ----------------
  if (want('search')) {
    await reset(); await keys('Down,Left,Up,Enter'); await sleep(1500);
    check('search screen', (await scr()) === 'search');
    // t (row 3 col 1), h (row 1 col 1), e (row 0 col 4) on the abc grid
    await keys('Down*3,Right,Enter,Up*2,Enter,Up,Right*3,Enter', 250);
    await sleep(1800);
    const q = await ev(`__jfApp.screen('search').query`);
    const res = await ev(`(()=>{const it=[].concat(...__jfApp.screen('search').rows.list.map(r=>r.items));return {n:it.length,types:it.map(x=>x.Type[0]).join(''),head:document.querySelector('.s-head').textContent}})()`);
    check('keyboard types "the"', q === 'the', q);
    check('results: movies/shows first, then episodes', res.n > 0 && /^[MS]+E*$/.test(res.types) && /E/.test(res.types), res);
    await keys('Right*6'); await sleep(400);
    check('Right moves into the results', await ev(`!!document.querySelector('.search .card.f, .search .fx.on')`));
    await press('Enter'); await sleep(1200);
    check('OK on a result opens details', await ev(`!!document.querySelector('.details.on')`));
    await press('Back'); await sleep(500); await press('Back'); await sleep(300);
    check('Back: results -> keyboard', await ev(`!!document.querySelector('.search .kk.f')`));
    await press('Back'); await sleep(800);
    check('Back from search -> Home', (await scr()) === 'home');
  }
} catch (e) { check('script ran without errors', false, e.message); }
await ev('__jfReset()').catch(() => {});
const failed = T.summary();
T.close();
process.exit(failed ? 1 : 0);
