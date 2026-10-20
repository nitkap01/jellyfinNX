// In-player Episodes panel (Netflix-style): seasons on the left, the season's episodes on the right, over the
// dimmed video that keeps playing. Data is fetched in the background as soon as an episode starts and kept here,
// so opening the panel only builds a few elements (no network wait).
// Speed rules: fixed row heights, only the rows near the focus exist, focus moves change classes + one transform,
// thumbnails are requested at exactly the drawn size and only for the rows that exist.
import { el, fmtRuntime, progressPct, onIdle, metrics } from '../util.js';
import { get, COMMON, slim, cardImg } from '../api.js';
import { ICON } from '../icons.js';
import { log, warn } from '../log.js';

const ROW_H = 212; // one episode row (196 + 16 gap)
const SEASON_H = 66;
const LIST_H = 860; // visible height of the episode list
const VISIBLE = Math.floor(LIST_H / ROW_H); // 4 full rows
const TH_W = 304, TH_H = 171; // thumbnail size (server is asked for exactly this)
const SEASONS_VISIBLE = 12;

const seasonsBy = new Map(); // seriesId -> { t, list:[{Id,Name,IndexNumber}] }
const epsBy = new Map(); // seasonId -> { t, list:[slim episodes] }
const FRESH = 10 * 60000;

const seasonsReq = (sid) => get('/Shows/' + sid + '/Seasons', { UserId: '{U}', EnableImageTypes: 'Primary', ImageTypeLimit: 1 }, FRESH);
// Same URL as the details page, so its cached answer is reused when the player was started from there.
const epsReq = (sid, seasonId) => get('/Shows/' + sid + '/Episodes', Object.assign({}, COMMON, { UserId: '{U}', SeasonId: seasonId, EnableImageTypes: 'Primary,Thumb' }), FRESH);

function loadSeasons(sid) {
  const c = seasonsBy.get(sid);
  if (c && (c.list || c.p) && Date.now() - c.t < FRESH) return c.p;
  const e = { t: Date.now(), list: null };
  e.p = seasonsReq(sid).then((r) => { e.list = (r.Items || []).map((s) => ({ Id: s.Id, Name: s.Name, IndexNumber: s.IndexNumber })); return e.list; });
  e.p.catch(() => seasonsBy.delete(sid));
  seasonsBy.set(sid, e);
  return e.p;
}
function loadEps(sid, seasonId) {
  const c = epsBy.get(seasonId);
  if (c && Date.now() - c.t < FRESH) return c.p;
  const e = { t: Date.now(), list: null };
  e.p = epsReq(sid, seasonId).then((r) => { e.list = (r.Items || []).map(slim); return e.list; });
  e.p.catch(() => epsBy.delete(seasonId));
  epsBy.set(seasonId, e);
  return e.p;
}

// cb: { choose(ep), closed(), hover(ep) } — hover: an episode stayed focused a moment (the player prefetches it)
export function episodesPanel(host, cb) {
  const root = el('div', 'p-eps', host);
  const head = el('div', 'pe-head', root);
  const hSeries = el('div', 'pe-series', head);
  const hTitle = el('div', 'pe-title', head, 'Episodes');
  const sCol = el('div', 'pe-scol', root);
  const sList = el('div', 'pe-slist', sCol);
  const eCol = el('div', 'pe-ecol', root);
  const eList = el('div', 'pe-elist', eCol);
  const msg = el('div', 'pe-msg', eCol);
  let P = null; // open state

  // Background fetch for the playing episode's series (called when an episode starts playing).
  function prefetch(item) {
    if (!item || item.Type !== 'Episode' || !item.SeriesId) return;
    const sid = item.SeriesId;
    loadSeasons(sid).then((ss) => {
      const sea = item.SeasonId || (ss.find((s) => s.IndexNumber === item.ParentIndexNumber) || {}).Id;
      return sea ? loadEps(sid, sea) : null;
    }).then((eps) => {
      if (!eps) return;
      // warm the image cache for the thumbnails around the playing episode
      const i = Math.max(0, eps.findIndex((e) => e.Id === item.Id));
      onIdle(() => eps.slice(Math.max(0, i - 1), i + VISIBLE + 2).forEach((e) => { const [u] = cardImg(e, TH_W, TH_H); if (u) new Image().src = u; }), 4000);
    }).catch((e) => warn('episodes prefetch failed', e && e.message));
  }

  // The player tells us when an episode stopped, so its progress bar is right next time without a refetch.
  function noteProgress(item, posMs, durMs) {
    if (!item || !item.SeasonId) return;
    const c = epsBy.get(item.SeasonId);
    const e = c && c.list && c.list.find((x) => x.Id === item.Id);
    if (!e) return;
    const pct = durMs ? (100 * posMs) / durMs : 0;
    // same rules as the server's defaults: under 5 % keeps no resume point, over 90 % counts as watched
    const played = pct >= 90 ? true : !!(e.UserData && e.UserData.Played);
    const keep = pct >= 5 && pct < 90;
    e.UserData = Object.assign({}, e.UserData, { PlaybackPositionTicks: keep ? Math.round(posMs * 10000) : 0, PlayedPercentage: keep ? pct : 0, Played: played });
  }

  function open(item) {
    const t0 = performance.now();
    const sid = item.SeriesId;
    P = { item, sid, side: 'eps', seasons: [], si: 0, eps: null, ei: 0, rows: new Map(), sTop: -1, eTop: -1, seasonId: item.SeasonId, t0 };
    hSeries.textContent = item.SeriesName || '';
    root.classList.add('on');
    const sc = seasonsBy.get(sid);
    const cached = !!(sc && sc.list && epsBy.get(item.SeasonId) && epsBy.get(item.SeasonId).list);
    if (sc && sc.list) setSeasons(sc.list); else { drawSeasons(); loadSeasons(sid).then((ss) => { if (P && P.item === item) { setSeasons(ss); showSeason(true); } }).catch(() => {}); }
    showSeason(true);
    const my = P;
    requestAnimationFrame(() => setTimeout(() => {
      const ms = Math.round(performance.now() - t0);
      metrics.marks.epsOpenMs = ms;
      log('episodes open', { series: item.SeriesName, season: item.ParentIndexNumber, ep: item.IndexNumber, cached, ms, seasons: my.seasons.length, eps: my.eps ? my.eps.length : 0 });
    }, 0));
  }

  function setSeasons(ss) {
    P.seasons = ss;
    let i = ss.findIndex((s) => s.Id === P.seasonId);
    if (i < 0) i = ss.findIndex((s) => s.IndexNumber === P.item.ParentIndexNumber);
    P.si = Math.max(0, i);
    if (!P.seasonId && ss[P.si]) P.seasonId = ss[P.si].Id;
    drawSeasons();
  }

  function drawSeasons() {
    sList.textContent = '';
    P.sEls = P.seasons.map((s, i) => el('div', 'pe-s', sList, s.Name || ('Season ' + s.IndexNumber)));
    P.sTop = -1;
    focusSeason();
  }
  function focusSeason() {
    if (!P.sEls) return;
    P.sEls.forEach((e, i) => { e.className = 'pe-s' + (i === P.si ? ' sel' : '') + (P.side === 'seasons' && i === P.si ? ' f' : ''); });
    const top = Math.max(0, Math.min(P.si - 5, P.seasons.length - SEASONS_VISIBLE));
    if (top !== P.sTop) { P.sTop = top; sList.style.transform = 'translate3d(0,' + -top * SEASON_H + 'px,0)'; }
  }

  // Show the episodes of the selected season (P.seasonId). first: focus the playing episode.
  function showSeason(first) {
    const seasonId = P.seasonId;
    const c = seasonId && epsBy.get(seasonId);
    if (c && c.list) { setEps(c.list, first); return; }
    clearRows(); P.eps = null; msg.textContent = seasonId ? 'Loading episodes' : '';
    if (!seasonId) return;
    const my = P;
    clearTimeout(P.loadT);
    // a short wait while the remote moves through seasons, so we do not fetch every season passed over
    P.loadT = setTimeout(() => {
      loadEps(my.sid, seasonId).then((eps) => { if (P === my && my.seasonId === seasonId) setEps(eps, first); })
        .catch((e) => { if (P === my && my.seasonId === seasonId) msg.textContent = 'Could not load episodes (' + e.message + ')'; });
    }, first ? 0 : 200);
  }

  function setEps(eps, first) {
    clearRows();
    P.eps = eps;
    msg.textContent = eps.length ? '' : 'No episodes';
    const now = eps.findIndex((e) => e.Id === P.item.Id);
    P.ei = now >= 0 ? now : 0;
    if (!first && now < 0) P.ei = 0;
    drawEps();
  }
  function clearRows() { eList.textContent = ''; P.rows = new Map(); P.eTop = -1; }

  function makeRow(i) {
    const e = P.eps[i];
    const r = el('div', 'pe-e' + (e.Id === P.item.Id ? ' now' : ''));
    r.style.transform = 'translate3d(0,' + i * ROW_H + 'px,0)';
    const th = el('div', 'pe-th', r);
    el('div', 'ph', th, e.IndexNumber != null ? 'E' + e.IndexNumber : '');
    const [src] = cardImg(e, TH_W, TH_H);
    if (src) { const im = el('img', '', th); im.alt = ''; im.width = TH_W; im.height = TH_H; im.src = src; }
    const p = progressPct(e);
    if (p > 0 && p < 99 && e.Id !== P.item.Id) el('i', '', el('div', 'pb', th)).style.transform = 'scaleX(' + p / 100 + ')';
    if (e.UserData && e.UserData.Played && e.Id !== P.item.Id) el('div', 'seen', th).innerHTML = ICON.check;
    const tx = el('div', 'pe-tx', r);
    el('div', 'pe-t', tx, (e.IndexNumber != null ? e.IndexNumber + '. ' : '') + e.Name);
    const m = el('div', 'pe-m', tx);
    if (e.Id === P.item.Id) { const n = el('span', 'pe-now', m); el('span', 'ic', n).innerHTML = ICON.play; el('span', '', n, 'Now playing'); }
    const part = p > 0 && p < 99 && e.RunTimeTicks && e.Id !== P.item.Id;
    el('span', '', m, part ? Math.max(1, Math.round(((100 - p) / 100) * e.RunTimeTicks / 6e8)) + ' min left' : fmtRuntime(e.RunTimeTicks));
    el('div', 'pe-ov', tx, e.Overview || '');
    eList.appendChild(r);
    return r;
  }

  function drawEps() {
    const n = P.eps ? P.eps.length : 0;
    if (!n) return;
    const top = Math.max(0, Math.min(P.ei - 1, n - VISIBLE));
    if (top !== P.eTop) {
      P.eTop = top;
      eList.style.transform = 'translate3d(0,' + -top * ROW_H + 'px,0)';
      // keep only the rows on screen plus one either side
      const lo = Math.max(0, top - 1), hi = Math.min(n - 1, top + VISIBLE + 1);
      P.rows.forEach((r, i) => { if (i < lo || i > hi) { r.remove(); P.rows.delete(i); } });
      for (let i = lo; i <= hi; i++) if (!P.rows.has(i)) P.rows.set(i, makeRow(i));
    }
    P.rows.forEach((r, i) => r.classList.toggle('f', P.side === 'eps' && i === P.ei));
    clearTimeout(P.hoverT);
    const e = P.side === 'eps' && P.eps[P.ei];
    if (e && e.Id !== P.item.Id && cb.hover) P.hoverT = setTimeout(() => cb.hover(e), 600);
  }

  function close(quiet) {
    if (!P) return;
    clearTimeout(P.loadT); clearTimeout(P.hoverT);
    if (!quiet) log('episodes close', { ms_open: Math.round(performance.now() - P.t0) });
    P = null;
    root.classList.remove('on');
    eList.textContent = ''; sList.textContent = '';
  }

  function key(k) {
    if (!P) return false;
    if (k === 'back') { close(); cb.closed(); return true; }
    if (P.side === 'seasons') {
      if ((k === 'up' && P.si > 0) || (k === 'down' && P.si < P.seasons.length - 1)) {
        P.si += k === 'up' ? -1 : 1;
        P.seasonId = P.seasons[P.si].Id;
        focusSeason();
        showSeason(false);
      } else if ((k === 'right' || k === 'ok') && P.eps && P.eps.length) { P.side = 'eps'; focusSeason(); drawEps(); }
      return true;
    }
    // episode list
    if (k === 'left' || (k === 'up' && (!P.eps || P.ei === 0) && P.seasons.length > 1)) {
      if (P.seasons.length) { P.side = 'seasons'; focusSeason(); drawEps(); }
    } else if (k === 'up' && P.eps && P.ei > 0) { P.ei--; drawEps(); } else if (k === 'down' && P.eps && P.ei < P.eps.length - 1) { P.ei++; drawEps(); } else if (k === 'ok' && P.eps && P.eps[P.ei]) {
      const e = P.eps[P.ei];
      const same = e.Id === P.item.Id;
      log('episodes choose', { ep: e.Name, s: e.ParentIndexNumber, e: e.IndexNumber, same, resumeAt: Math.round(((e.UserData && e.UserData.PlaybackPositionTicks) || 0) / 1e7) });
      close(true);
      if (same) cb.closed(); else cb.choose(e);
    }
    return true;
  }

  return { prefetch, noteProgress, open, close, key, get isOpen() { return !!P; }, focused: () => (P && P.eps && P.eps[P.ei] ? P.eps[P.ei].Name : null), side: () => P && P.side };
}
