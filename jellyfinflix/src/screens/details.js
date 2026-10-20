// "More Info" overlay: artwork, facts, Play/Resume, My List, seasons + episodes, More Like This.
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

const P = (o) => Object.assign({}, COMMON, o);
const ROWS_TOP = 590;

let host, root, page, D, rows, cur, full, target, history = [], token = 0, stopFix = null, open = false, warmT = 0;
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
  D.ov = el('div', 'd-ov', info);
  D.extra = el('div', 'd-extra', info);
  D.prog = el('div', 'd-prog', info);
  D.fix = el('div', 'd-fix', info);
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
  hide() { root.classList.remove('on'); setFlag('dt', false); open = false; clearTimeout(warmT); coolDown(); if (stopFix) { stopFix(); stopFix = null; } },
  resume() { // back from the player: refresh progress
    if (!cur) return;
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
  if (f && f.HasSubtitles) m.push('CC');
  D.meta.textContent = m.join('   ·   ');
  D.ov.textContent = it.Overview || '';
  if (f) {
    const ex = [];
    if (f.Genres && f.Genres.length) ex.push('Genres: ' + f.Genres.slice(0, 4).join(', '));
    const cast = (f.People || []).filter((p) => p.Type === 'Actor').slice(0, 4).map((p) => p.Name);
    if (cast.length) ex.push('Cast: ' + cast.join(', '));
    D.extra.textContent = ex.join('   ·   ');
  } else D.extra.textContent = '';
  const p = target ? progressPct(target) : 0;
  D.prog.textContent = p > 0 && p < 99 && target.RunTimeTicks ? Math.round(((100 - p) / 100) * target.RunTimeTicks / 6e8) + ' min left' : '';
  D.fix.textContent = ''; D.fix.className = 'd-fix'; fixState = '';
}

// "Audio fixed" line: green tick when fixed, live progress bar while a fix runs (started anywhere), red note if it failed.
let fixState = '';
function showFix(s) {
  let state = 'no';
  D.fix.textContent = '';
  if (s.state === 'running') {
    state = 'run';
    D.fix.className = 'd-fix run';
    const pct = s.progressPercent;
    el('span', '', D.fix, 'Fixing audio: ' + (s.progressPhase || 'starting') + (pct != null ? ' ' + pct + '%' : ''));
    el('i', '', el('div', 'fixbar', D.fix)).style.transform = 'scaleX(' + (pct || 0) / 100 + ')';
  } else if (s.fixed) {
    state = 'ok'; D.fix.className = 'd-fix ok'; el('span', 'ic', D.fix).innerHTML = ICON.check; el('span', '', D.fix, 'Audio fixed');
  } else if (s.lastResultStatus && !/^(OK|DRYRUN)/.test(s.lastResultStatus)) {
    state = 'bad'; D.fix.className = 'd-fix bad'; D.fix.textContent = 'Last audio fix failed (' + s.lastResultStatus + ')';
  } else { D.fix.className = 'd-fix'; D.fix.textContent = 'Audio fixed: No'; }
  if (state !== fixState) { fixState = state; rows.upsert(btnDef(), buttons()); }
}

function btnDef() { return { id: 'btns', kind: 'btn', order: 0, onOk: (b) => act(b.act) }; }

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
  if (S.admin && full && canMediaFix(full)) {
    b.push({ label: 'Fix Audio', icon: 'wrench', act: 'fix-audio', badge: fixState === 'ok' ? { text: 'fixed', cls: 'ok' } : fixState === 'run' ? { text: 'running', cls: 'run' } : fixState === 'bad' ? { text: 'failed', cls: 'bad' } : null });
    b.push({ label: 'Fetch Subtitle', icon: 'sub', act: 'fix-subtitle' });
  }
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
      if (j >= 0 && rows.row !== row) { row.idx = j; if (row.built) { rows.ensureCards(row); rows.scroll(row, false); } }
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
