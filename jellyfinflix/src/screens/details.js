// "More Info" overlay: artwork, facts, Play/Resume, My List, More (Fix Audio / Fetch Subtitle / genres + cast),
// seasons + episodes, More Like This. Kept calm on purpose: one meta line, a 3-line overview, one row of pill buttons.
import { el, debounce, fmtRuntime, epLabel, progressPct, metrics, setFlag } from '../util.js';
import { app } from '../app.js';
import { S, get, send, COMMON, slim, backdropImg, logoImg, invalidate } from '../api.js';
import { Rows } from '../ui/rows.js';
import { setBg } from '../ui/bg.js';
import { toast } from '../ui/dialog.js';
import { nextUpFor } from '../data.js';
import { playItem, prefetchPlayback, warmUp, coolDown } from '../player/player.js';
import { runMediaFix, canMediaFix, watchFixStatus } from '../mediafix.js';
import { ICON } from '../icons.js';
import { log } from '../log.js';

const P = (o) => Object.assign({}, COMMON, o);
const ROWS_TOP = 590;

let host, root, page, D, rows, cur, full, target, history = [], token = 0, stopFix = null, open = false, warmT = 0, quietResume = false;
// Prepare the player for the main Play target once the page has been open a moment.
function warmLater() { clearTimeout(warmT); warmT = setTimeout(() => { if (open && target && app.isTop(layer)) warmUp(target); }, 700); }

export function initDetails(h) { host = h; }

function build() {
  root = el('div', 'layer details', host);
  page = el('div', 'd-page', root);
  const info = el('div', 'd-info', page);
  D = { logoBox: el('div', 'd-logo', info) };
  D.logo = el('img', '', D.logoBox); D.logo.alt = '';
  D.logo.onload = () => D.logoBox.classList.add('has');
  D.logo.onerror = () => D.logoBox.classList.remove('has');
  D.title = el('div', 'd-title', D.logoBox);
  D.sub = el('div', 'd-sub', info);
  D.meta = el('div', 'd-meta', info);
  D.metaT = el('span', '', D.meta);
  D.chip = el('span', 'd-chip', D.meta); // small "Audio fixed" / "Fixing audio" chip next to the facts
  D.ov = el('div', 'd-ov', info);
  D.prog = el('div', 'd-prog', info);
  D.more = el('div', 'd-more', root);
  const rh = el('div', 'd-rows', page);
  rows = new Rows(rh, {
    target: page,
    offset: (r, row) => {
      const h = row.def.rowH || (row.kind === 'ep' ? 400 : row.kind === 'card' ? 286 : row.kind === 'pill' ? 92 : 104);
      const bottom = ROWS_TOP + row.top + h;
      return bottom > 1050 ? 1050 - bottom : 0;
    },
    onFocus: (it, row) => { if (row.def.id === 'seasons') seasonLater(it); },
  });
}

const layer = {
  overlay: true,
  key(k, e) {
    if (k === 'back') {
      if (history.length > 1) { history.pop(); render(history[history.length - 1]); return true; }
      close();
      return true;
    }
    if (k === 'play' || k === 'playpause') { if (target) playItem(target); return true; }
    if (k === 'left' && rows.row && rows.row.idx === 0) return true;
    return rows.key(k, e);
  },
  show() { root.classList.add('on'); setFlag('dt', true); },
  hide() { closeMore(); quietResume = false; root.classList.remove('on'); setFlag('dt', false); open = false; clearTimeout(warmT); coolDown(); if (stopFix) { stopFix(); stopFix = null; } },
  resume() { // back from the player: refresh progress
    if (!cur) return;
    if (quietResume) { quietResume = false; rows.focus(); return; } // the More menu closed: nothing changed
    setBg(backdropImg(cur, 1280));
    rows.focus();
    refresh();
    warmLater();
  },
};

function close() { app.pop(layer); }

export function openDetails(item) {
  if (!root) build();
  history = [item];
  render(item);
}

function render(item) {
  const t0 = performance.now();
  const my = ++token;
  cur = item; full = null; target = item.Type === 'Series' ? null : item;
  if (stopFix) { stopFix(); stopFix = null; }
  fillInfo(item);
  setBg(backdropImg(item, 1280));
  rows.clear();
  rows.upsert(btnDef(), buttons());
  rows.r = 0;
  if (!open) { open = true; app.push(layer); }
  rows.focus();
  requestAnimationFrame(() => setTimeout(() => { metrics.marks.detailsMs = Math.round(performance.now() - t0); }, 0));
  if (target) { prefetchPlayback(target); warmLater(); }

  get('/Users/{U}/Items/' + item.Id, {}, 60000).then((f) => {
    if (my !== token) return;
    full = f;
    Object.assign(cur, slim(f));
    fillInfo(cur, f);
    if (cur.Type !== 'Series') { target = cur; target._path = f.Path; }
    rows.upsert(btnDef(), buttons());
    if (canMediaFix(f) || (f.Path && f.Path.indexOf('/MEDIA/') === 0 && (f.Type === 'Movie' || f.Type === 'Episode'))) {
      stopFix = watchFixStatus(f.Path, (st) => { if (my === token) showFix(st); });
    }
  }).catch(() => {});

  if (item.Type === 'Series' || item.Type === 'Episode') loadSeries(my);
  get('/Items/' + (item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id) + '/Similar', P({ UserId: '{U}', Limit: 16 }), 600000)
    .then((r) => { if (my === token) rows.upsert({ id: 'similar', title: 'More Like This', kind: 'card', order: 40, onOk: (it) => { history.push(it); render(it); } }, (r.Items || []).map(slim)); })
    .catch(() => {});
}

function fillInfo(it, f) {
  const logo = logoImg(it);
  D.logoBox.classList.remove('has');
  if (logo) D.logo.src = logo; else D.logo.removeAttribute('src');
  D.title.textContent = it.Type === 'Episode' ? it.SeriesName || it.Name : it.Name;
  D.sub.textContent = it.Type === 'Episode' ? epLabel(it) + '  ' + it.Name : '';
  const m = [];
  if (it.ProductionYear) m.push(it.ProductionYear);
  if (it.OfficialRating) m.push(it.OfficialRating);
  if (it.Type !== 'Series' && it.RunTimeTicks) m.push(fmtRuntime(it.RunTimeTicks));
  if (it.Type === 'Series' && f && f.ChildCount) m.push(f.ChildCount + (f.ChildCount === 1 ? ' Season' : ' Seasons'));
  if (it.CommunityRating) m.push(it.CommunityRating.toFixed(1) + '/10');
  D.metaT.textContent = m.join('   ·   ');
  D.ov.textContent = it.Overview || '';
  const p = target ? progressPct(target) : 0;
  D.prog.textContent = p > 0 && p < 99 && target.RunTimeTicks ? Math.round(((100 - p) / 100) * target.RunTimeTicks / 6e8) + ' min left' : '';
  if (it !== fixFor) { fixFor = it; fix = { state: '' }; paintChip(); }
}

// Audio-fix state (mediafix-helper /status, polled while the page is open): a small chip next to the facts when fixed
// or running; the full state (fixed / running with progress / failed) is in the More menu.
let fix = { state: '' }, fixFor = null;
function showFix(s) {
  let n = { state: 'no', text: 'Not fixed yet' };
  if (s.state === 'running') {
    const pct = s.progressPercent;
    n = { state: 'run', pct: pct || 0, text: 'Fixing audio: ' + (s.progressPhase || 'starting') + (pct != null ? ' ' + pct + '%' : '') };
  } else if (s.fixed) n = { state: 'ok', text: 'Audio fixed' };
  else if (s.lastResultStatus && !/^(OK|DRYRUN)/.test(s.lastResultStatus)) n = { state: 'bad', text: 'Last fix failed (' + s.lastResultStatus + ')' };
  if (n.state === fix.state && n.text === fix.text) return;
  fix = n;
  paintChip();
  if (M) drawMore();
}
function paintChip() {
  D.chip.textContent = '';
  D.chip.className = 'd-chip' + (fix.state === 'ok' || fix.state === 'run' ? ' ' + fix.state : '');
  if (fix.state === 'ok') { el('span', 'ic', D.chip).innerHTML = ICON.check; el('span', '', D.chip, 'Audio fixed'); } else if (fix.state === 'run') el('span', '', D.chip, 'Fixing audio' + (fix.pct ? ' ' + fix.pct + '%' : ''));
}

// ---- "More" menu: a small popup over the page, above the More button ----
let M = null; // { items, i }
function moreItems() {
  const a = [];
  if (S.admin && full && canMediaFix(full)) {
    a.push({ act: 'fix-audio', icon: 'wrench', label: 'Fix Audio', badge: fix.state === 'ok' ? { text: 'Audio fixed', cls: 'ok' } : fix.state === 'run' ? { text: 'Running' + (fix.pct ? ' ' + fix.pct + '%' : ''), cls: 'run' } : fix.state === 'bad' ? { text: 'Failed', cls: 'bad' } : null });
    a.push({ act: 'fix-subtitle', icon: 'sub', label: 'Fetch Subtitle' });
  }
  return a;
}
function detailsLines() {
  const f = full;
  if (!f) return ['Loading details…'];
  const out = [];
  if (f.Genres && f.Genres.length) out.push(['Genres', f.Genres.slice(0, 5).join(', ')]);
  const cast = (f.People || []).filter((p) => p.Type === 'Actor').slice(0, 6).map((p) => p.Name);
  if (cast.length) out.push(['Cast', cast.join(', ')]);
  const dir = (f.People || []).filter((p) => p.Type === 'Director').slice(0, 2).map((p) => p.Name);
  if (dir.length) out.push(['Director', dir.join(', ')]);
  if (f.Studios && f.Studios.length) out.push(['Studio', f.Studios.slice(0, 2).map((x) => x.Name).join(', ')]);
  if (f.HasSubtitles) out.push(['Subtitles', 'Available']);
  if (fix.state === 'bad' || fix.state === 'run') out.push(['Audio', fix.text]);
  return out.length ? out : ['No more details for this title.'];
}
function openMore(btnEl) {
  M = { items: moreItems(), i: 0, btn: btnEl };
  drawMore();
  // anchor above the More button (one layout read, on OK only)
  const r = btnEl ? btnEl.getBoundingClientRect() : { left: 150, top: 600 };
  D.more.style.transform = 'translate3d(' + Math.round(Math.min(r.left, 1920 - 700)) + 'px,0,0)';
  D.more.style.bottom = Math.round(1080 - r.top + 18) + 'px';
  D.more.classList.add('on');
  app.push(moreLayer);
  log('details more menu', { items: M.items.map((x) => x.act), fix: fix.state });
}
function drawMore() {
  if (!M) return;
  const keep = M.items[M.i] && M.items[M.i].act;
  M.items = moreItems();
  const j = M.items.findIndex((x) => x.act === keep);
  M.i = j >= 0 ? j : Math.min(M.i, Math.max(0, M.items.length - 1));
  D.more.textContent = '';
  M.items.forEach((it, i) => {
    const b = el('div', 'dm-i' + (i === M.i ? ' f' : ''), D.more);
    el('span', 'ic', b).innerHTML = ICON[it.icon] || '';
    el('span', 'lb', b, it.label);
    if (it.badge) { const g = el('span', 'bbadge ' + it.badge.cls, b); if (it.badge.cls === 'ok') el('span', 'ic', g).innerHTML = ICON.check; el('span', '', g, it.badge.text); }
  });
  if (fix.state === 'run' && M.items.length) el('i', '', el('div', 'fixbar dm-bar', D.more)).style.transform = 'scaleX(' + (fix.pct || 0) / 100 + ')';
  const d = el('div', 'dm-d', D.more);
  el('div', 'dm-h', d, 'Details');
  for (const x of detailsLines()) {
    const l = el('div', 'dm-l', d);
    if (typeof x === 'string') l.textContent = x; else { el('b', '', l, x[0] + ': '); el('span', '', l, x[1]); }
  }
}
function closeMore() { if (M) app.pop(moreLayer); }
const moreLayer = {
  overlay: true,
  key(k) {
    if (!M) return true;
    if (k === 'back' || k === 'left' || k === 'right') { closeMore(); return true; }
    if (k === 'up' && M.i > 0) { M.i--; drawMore(); } else if (k === 'down' && M.i < M.items.length - 1) { M.i++; drawMore(); } else if (k === 'ok') {
      const it = M.items[M.i];
      closeMore();
      if (it) act(it.act);
    }
    return true;
  },
  hide() { M = null; D.more.classList.remove('on'); D.more.textContent = ''; quietResume = true; },
};

function btnDef() { return { id: 'btns', kind: 'btn', order: 0, onOk: (b, i, row) => (b.act === 'more' ? openMore(row.cards[i]) : act(b.act)) }; }

function buttons() {
  const b = [];
  const t = target;
  const p = t ? progressPct(t) : 0;
  const ep = t && t.Type === 'Episode' && cur.Type === 'Series' ? ' ' + epLabel(t) : '';
  if (cur.Type === 'Series' && !t) b.push({ label: 'Play', icon: 'play', act: 'play', cls: 'btn-w' });
  else b.push({ label: (p > 0 && p < 99 ? 'Resume' : 'Play') + ep, icon: 'play', act: 'play', cls: 'btn-w' });
  if (p > 0 && p < 99) b.push({ label: 'Start Over', icon: 'restart', act: 'restart' });
  const fav = cur.UserData && cur.UserData.IsFavorite;
  b.push({ label: 'My List', icon: fav ? 'check' : 'list', act: 'fav' });
  b.push({ label: 'More', icon: 'more', act: 'more' }); // Fix Audio, Fetch Subtitle, genres + cast
  return b;
}

async function act(a) {
  if (a === 'play' || a === 'restart') {
    if (!target && cur.Type === 'Series') { toast('Loading episodes…'); return; }
    playItem(target, { restart: a === 'restart' });
  } else if (a === 'fav') {
    const it = cur;
    const was = !!(it.UserData && it.UserData.IsFavorite);
    try {
      await send(was ? 'DELETE' : 'POST', '/Users/{U}/FavoriteItems/' + it.Id);
      it.UserData = Object.assign({}, it.UserData, { IsFavorite: !was });
      if (cur === it) rows.upsert(btnDef(), buttons());
      toast(was ? 'Removed from My List' : 'Added to My List', 2000);
      app.emit('favs');
    } catch (e) { toast('Could not update My List: ' + e.message); }
  } else if (a === 'fix-audio' || a === 'fix-subtitle') {
    runMediaFix(a, full || cur);
  }
}

// ---- series: seasons + episodes ----
let seasons = [], seasonId = '';
const seasonLater = debounce((s) => { if (s && s.Id !== seasonId) loadEpisodes(s.Id, token); }, 350);

async function loadSeries(my) {
  const sid = cur.Type === 'Series' ? cur.Id : cur.SeriesId;
  if (!sid) return;
  const [ss, nu] = await Promise.all([
    get('/Shows/' + sid + '/Seasons', { UserId: '{U}', EnableImageTypes: 'Primary', ImageTypeLimit: 1 }, 60000).catch(() => ({ Items: [] })),
    cur.Type === 'Series' ? nextUpFor(sid).catch(() => []) : Promise.resolve([]),
  ]);
  if (my !== token) return;
  seasons = (ss.Items || []).map((s) => ({ Id: s.Id, label: s.Name, IndexNumber: s.IndexNumber }));
  let want = cur.Type === 'Episode' ? cur.SeasonId : nu[0] && nu[0].SeasonId;
  if (!want && seasons[0]) want = seasons[0].Id;
  if (cur.Type === 'Series') {
    if (nu[0]) { target = nu[0]; prefetchPlayback(target); warmLater(); }
  }
  if (seasons.length > 1 || cur.Type === 'Series') {
    rows.upsert({ id: 'seasons', kind: 'pill', order: 10, onOk: (s) => loadEpisodes(s.Id, token) }, seasons);
    const row = rows.list.find((r) => r.def.id === 'seasons');
    if (row) { row.idx = Math.max(0, seasons.findIndex((s) => s.Id === want)); if (row.built) { row.cards.forEach((c, j) => c.classList.toggle('sel', j === row.idx)); rows.scroll(row, false); } }
  }
  if (want) await loadEpisodes(want, my);
  if (my === token && cur.Type === 'Series') {
    if (!target) {
      const row = rows.list.find((r) => r.def.id === 'eps');
      if (row && row.items[0]) { target = row.items[0]; prefetchPlayback(target); warmLater(); }
    }
    fillInfo(cur, full);
    rows.upsert(btnDef(), buttons());
  }
}

async function loadEpisodes(seasonIdWanted, my) {
  const changed = seasonId !== seasonIdWanted;
  seasonId = seasonIdWanted;
  const sid = cur.Type === 'Series' ? cur.Id : cur.SeriesId;
  try {
    const r = await get('/Shows/' + sid + '/Episodes', P({ UserId: '{U}', SeasonId: seasonIdWanted, EnableImageTypes: 'Primary,Thumb' }), 30000);
    if (my !== token) return;
    const eps = (r.Items || []).map(slim);
    rows.upsert({ id: 'eps', title: 'Episodes', kind: 'ep', order: 20, onOk: (e) => playItem(e) }, eps);
    const row = rows.list.find((x) => x.def.id === 'eps');
    if (row) {
      const focusId = target && target.Type === 'Episode' ? target.Id : null;
      const j = focusId ? eps.findIndex((e) => e.Id === focusId) : -1;
      // the episode to play is in this season: show it; another season: start at its first episode
      const k = j >= 0 ? j : changed ? 0 : -1;
      if (k >= 0 && rows.row !== row && row.idx !== k) { row.idx = k; if (row.built) { rows.ensureCards(row); rows.scroll(row, false); } }
    }
  } catch (e) { /* keep what we have */ }
}

function refresh() {
  const my = token;
  {
    invalidate('/Items/' + cur.Id, '/Episodes', '/NextUp');
    const id = target ? target.Id : cur.Id;
    get('/Users/{U}/Items/' + id, {}, 0).then((f) => {
      if (my !== token) return;
      if (target) Object.assign(target, slim(f), { _path: f.Path });
      if (cur.Id === f.Id) { Object.assign(cur, slim(f)); full = f; }
      fillInfo(cur, full);
      rows.upsert(btnDef(), buttons());
    }).catch(() => {});
    if (cur.Type === 'Series' || cur.Type === 'Episode') {
      if (cur.Type === 'Series') nextUpFor(cur.Id).then((nu) => { if (my === token && nu[0]) { target = nu[0]; rows.upsert(btnDef(), buttons()); } }).catch(() => {});
      if (seasonId) loadEpisodes(seasonId, my);
    }
  }
}
