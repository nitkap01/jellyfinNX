// Full-screen player: Samsung AVPlay, Netflix-style controls, Skip Intro, next-episode countdown,
// resume position and playback reporting so Continue Watching stays right.
import { el, fmtClock, epLabel, metrics } from '../util.js';
import { app } from '../app.js';
import { S, get, send, COMMON, slim } from '../api.js';
import { store } from '../store.js';
import { ICON } from '../icons.js';
import { toast, alertBox } from '../ui/dialog.js';
import { deviceProfile, AUDIO_OK } from './profile.js';
import { loadWebapis, avplayEngine, html5Engine } from './engines.js';
import { runMediaFix, canMediaFix, fetchFixStatus } from '../mediafix.js';
import { log, warn, error } from '../log.js';

const TICKS = 10000; // ticks per ms
const UI_HIDE_MS = 3500;
let host, root, U, eng = null;
let st = null; // per-playback state
const pre = new Map(); // itemId -> { t, p } prefetched PlaybackInfo

export function initPlayer(h) {
  host = h;
  // TV home button / app switch: stop cleanly so the position is saved.
  document.addEventListener('visibilitychange', () => { if (document.hidden && st) close(); });
  // Hold detection that works with every remote: some Samsung remotes repeat keydown without e.repeat (and some
  // send keyup between repeats). A key counts as held if it is pressed again before its keyup, or within 300 ms.
  const SEEK_KEYS = { 37: 1, 39: 1, 412: 1, 417: 1 };
  // on window (capture) so this runs before the app's own key handler on document
  window.addEventListener('keydown', (e) => {
    if (!SEEK_KEYS[e.keyCode]) return;
    const now = Date.now();
    held.on = held.code === e.keyCode && (held.down || e.repeat || now - held.last < 300);
    held.code = e.keyCode; held.down = true; held.last = now; if (e.repeat) held.sawRepeat = true;
  }, true);
  window.addEventListener('keyup', (e) => { if (SEEK_KEYS[e.keyCode]) { held.down = false; held.ups++; } }, true);
}
const held = { code: 0, down: false, on: false, last: 0, ups: 0, sawRepeat: false };

function playbackInfo(item, o) {
  o = o || {};
  const body = {
    UserId: S.userId, DeviceProfile: deviceProfile({ maxBitrate: o.maxBitrate, burnIn: o.burn }), MaxStreamingBitrate: o.maxBitrate || 120000000, StartTimeTicks: o.startTicks || 0,
    IsPlayback: true, AutoOpenLiveStream: true, EnableDirectPlay: !o.noDirect, EnableDirectStream: !o.noDirect, EnableTranscoding: true,
    AllowVideoStreamCopy: true, AllowAudioStreamCopy: true,
  };
  if (o.audio != null) body.AudioStreamIndex = o.audio;
  if (o.sub != null) body.SubtitleStreamIndex = o.sub;
  if (o.mediaSourceId) body.MediaSourceId = o.mediaSourceId;
  return send('POST', '/Items/' + item.Id + '/PlaybackInfo', body, { UserId: S.userId });
}

export function prefetchPlayback(item) {
  if (!item || !item.Id || item.Type === 'Series') return;
  const c = pre.get(item.Id);
  if (c && Date.now() - c.t < 60000) return;
  const p = playbackInfo(item);
  p.catch(() => pre.delete(item.Id));
  pre.set(item.Id, { t: Date.now(), p });
  loadWebapis();
}

function takePrefetched(item) {
  const c = pre.get(item.Id);
  pre.delete(item.Id);
  return c && Date.now() - c.t < 60000 ? c.p : null;
}

// ---------- entry ----------
export async function playItem(item, opts) {
  opts = opts || {};
  if (!item) return;
  try {
    if (item.Type === 'Series' || item.Type === 'Season') {
      const sid = item.Type === 'Series' ? item.Id : item.SeriesId;
      let ep = (await get('/Shows/NextUp', Object.assign({}, COMMON, { UserId: '{U}', SeriesId: sid, Limit: 1, EnableResumable: true }), 0)).Items[0];
      if (!ep) ep = (await get('/Shows/' + sid + '/Episodes', Object.assign({}, COMMON, { UserId: '{U}', SeasonId: item.Type === 'Season' ? item.Id : undefined, Limit: 1 }), 0)).Items[0];
      if (!ep) { toast('No episodes to play'); return; }
      item = slim(ep);
    }
  } catch (e) { error('play: could not start', e.message); toast('Could not start: ' + e.message); return; }
  log('play', { name: item.Name, id: item.Id, type: item.Type, resume: !!(opts && opts.resume) });
  start(item, opts);
}

function build() {
  root = el('div', 'layer player', host);
  U = {};
  U.subs = el('div', 'p-subs', root);
  U.spin = el('div', 'p-spin', root);
  U.ui = el('div', 'p-ui', root);
  const top = el('div', 'p-top', U.ui);
  U.title = el('b', '', top); U.sub = el('span', '', top);
  U.bar = el('div', 'p-bar', U.ui);
  U.fill = el('div', 'p-fill', U.bar);
  U.knob = el('div', 'p-knob', U.bar);
  U.tip = el('div', 'p-tip', U.bar);
  U.thumb = el('div', 'p-thumb', U.bar);
  const times = el('div', 'p-times', U.ui);
  U.tcur = el('span', '', times); U.tleft = el('span', '', times);
  U.ctrls = el('div', 'p-ctrls', U.ui);
  U.skip = el('div', 'p-skip btn btn-w', root, 'Skip Intro');
  U.next = el('div', 'p-next', root);
  U.menu = el('div', 'p-menu', root);
  U.pauseIco = el('div', 'p-big', root);
}

function ctrlDefs() {
  const c = [
    { id: 'pp', label: st && st.paused ? 'Play' : 'Pause', icon: st && st.paused ? 'play' : 'pause' },
    { id: 'back10', label: '', icon: 'rew10' },
    { id: 'fwd10', label: '', icon: 'fwd10' },
    { id: 'menu', label: 'Audio & Subtitles', icon: 'audio' },
  ];
  if (st && st.nextEp) c.push({ id: 'next', label: 'Next Episode', icon: 'next' });
  return c;
}

function drawCtrls() {
  U.ctrls.textContent = '';
  st.ctrls = ctrlDefs();
  if (st.ci >= st.ctrls.length) st.ci = 0;
  st.ctrlEls = st.ctrls.map((c, i) => {
    const b = el('div', 'pc' + (st.zone === 'ctrls' && i === st.ci ? ' f' : ''), U.ctrls);
    if (c.icon) el('span', 'ic', b).innerHTML = ICON[c.icon];
    el('span', 'lb', b, c.label);
    return b;
  });
}

function newState(item, t0) {
  return {
    item, t0, pos: 0, dur: (item.RunTimeTicks || 0) / TICKS, paused: false, zone: 'none', ci: 0, target: null, seekN: 0, lastSeek: 0,
    segs: [], nextEp: null, countdown: null, dismissedNext: false, cues: null, cueIdx: 0, reported: false, alive: true, method: 'DirectPlay',
    audio: null, sub: -1, retried: false,
  };
}
const resumeMs = (item, opts) => (opts.restart ? 0 : opts.startMs != null ? opts.startMs : ((item.UserData && item.UserData.PlaybackPositionTicks) || 0) / TICKS);

// ---------- warm start: prepare the player while the details page is open, so Play starts at once ----------
let warm = null; // { item, startMs, my, promise }
export function warmUp(item) {
  metrics.marks.warm = 'asked';
  if (!item || !item.Id || item.Type === 'Series' || st) return;
  const startMs = resumeMs(item, {});
  if (warm && warm.item.Id === item.Id && warm.startMs === startMs) return;
  coolDown();
  if (!root) build();
  const my = newState(item, performance.now());
  const w = warm = { item, startMs, my };
  w.promise = (async () => {
    if (!(await loadWebapis()) || warm !== w) return false;
    const info = await (takePrefetched(item) || playbackInfo(item, { startTicks: startMs * TICKS }));
    if (warm !== w || st) return false;
    if (!eng || eng.name !== 'avplay') eng = avplayEngine(root);
    my.info = info;
    await prepareSource(my, info, startMs, () => warm === w);
    metrics.marks.warm = warm === w ? 'ready' : 'dropped';
    return warm === w;
  })().catch(() => false);
}
export function coolDown() {
  const w = warm;
  if (!w) return;
  warm = null;
  // Wait for a pending prepare, then release the player (unless that session went on to play).
  w.promise.then(() => afterPaint(() => { if (eng && !st && !warm) eng.stop(); }));
}

// Run slow TV player calls only after the next screen update has been drawn.
function afterPaint(fn) { requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(fn, 0))); }

async function start(item, opts) {
  if (!root) build();
  if (st) await stopPlayback(true);
  const t0 = performance.now();
  metrics.marks.playPress = Math.round(t0);
  delete metrics.marks.playMs; delete metrics.marks.playEngine; delete metrics.marks.playSteps;
  const startMs = resumeMs(item, opts);
  const w = warm && warm.item.Id === item.Id && Math.abs(warm.startMs - startMs) < 2000 ? warm : null;
  metrics.marks.warmUsed = !!w;
  if (w) warm = null; else coolDown();
  st = w ? w.my : newState(item, t0);
  const my = st;
  my.t0 = t0;
  U.title.textContent = item.Type === 'Episode' ? item.SeriesName || item.Name : item.Name;
  U.sub.textContent = item.Type === 'Episode' ? epLabel(item) + '  “' + item.Name + '”' : '';
  U.subs.textContent = ''; U.next.classList.remove('on'); U.skip.classList.remove('on'); U.menu.classList.remove('on');
  U.spin.classList.add('on');
  showUi(false);
  drawBar();
  document.body.classList.add('playing');
  if (!app.isTop(layer)) app.push(layer);

  try {
    if (w && (await w.promise) && my === st && my.prepared) {
      my.steps = { warm: 1 };
      beginPlayback(my, w.startMs);
    } else {
      if (my !== st) return;
      if (w) { st = null; return start(item, opts); } // warm start failed: do it the normal way
      const [hasAv, info] = await Promise.all([loadWebapis(), takePrefetched(item) || playbackInfo(item, { startTicks: startMs * TICKS })]);
      if (my !== st) return;
      if (!eng || (hasAv && eng.name !== 'avplay')) eng = hasAv ? avplayEngine(root) : html5Engine(root);
      my.info = info;
      my.steps = { info: Math.round(performance.now() - my.t0) };
      await openSource(my, info, startMs);
    }
  } catch (e) {
    if (my !== st) return;
    await fail(my, e);
  }
  if (my !== st) return;
  if (item.Type === 'Episode' && item.SeriesId) {
    get('/Shows/' + item.SeriesId + '/Episodes', Object.assign({}, COMMON, { UserId: '{U}', StartItemId: item.Id, Limit: 2 }), 30000)
      .then((r) => { const n = (r.Items || [])[1]; if (my === st && n) { my.nextEp = slim(n); drawCtrls(); } }).catch(() => {});
  }
  get('/Users/{U}/Items/' + item.Id, { Fields: 'Trickplay' }, 600000).then((f) => {
    if (my !== st || !f.Trickplay || !my.ms) return;
    const byWidth = f.Trickplay[my.ms.Id] || f.Trickplay[Object.keys(f.Trickplay)[0]];
    if (!byWidth) return;
    const ws = Object.keys(byWidth).map(Number).sort((a, b) => a - b);
    const w2 = ws.find((x) => x >= 240) || ws[ws.length - 1];
    if (w2) my.tp = byWidth[w2];
  }).catch(() => {});
  get('/MediaSegments/' + item.Id, {}, 600000).then((r) => { if (my === st) my.segs = (r.Items || []).map((s) => ({ type: s.Type, s: s.StartTicks / TICKS, e: s.EndTicks / TICKS })); }).catch(() => {});
}

function pickUrl(my, ms) {
  const direct = ms.SupportsDirectPlay || (ms.SupportsDirectStream && !ms.TranscodingUrl);
  if (direct && !my.forceTranscode) {
    my.method = 'DirectPlay';
    const ext = (ms.Container || '').split(',')[0];
    return S.server + '/Videos/' + my.item.Id + '/stream' + (ext ? '.' + ext : '') + '?static=true&mediaSourceId=' + encodeURIComponent(ms.Id) +
      '&PlaySessionId=' + encodeURIComponent(my.info.PlaySessionId || '') + '&DeviceId=' + encodeURIComponent(store.deviceId) + '&api_key=' + S.token + (ms.ETag ? '&Tag=' + ms.ETag : '');
  }
  if (ms.TranscodingUrl) {
    my.method = 'Transcode';
    let u = S.server + ms.TranscodingUrl;
    if (!/api_key=|ApiKey=/i.test(u)) u += '&api_key=' + S.token;
    return u;
  }
  throw new Error('The server offered no way to play this file.');
}

// Open + prepare (+ seek to the resume point). alive() says whether this session is still wanted.
async function prepareSource(my, info, startMs, alive) {
  const ms = (info.MediaSources || [])[0];
  if (!ms) throw new Error('No playable media found.');
  my.ms = ms;
  my.streams = ms.MediaStreams || [];
  if (my.audio == null) my.audio = ms.DefaultAudioStreamIndex != null ? ms.DefaultAudioStreamIndex : (my.streams.find((s) => s.Type === 'Audio') || {}).Index;
  if (my.subWanted === undefined) my.subWanted = ms.DefaultSubtitleStreamIndex != null ? ms.DefaultSubtitleStreamIndex : -1;
  const url = pickUrl(my, ms);
  log('open source', { method: my.method, container: ms.Container, size: ms.Size, video: (my.streams.find((s) => s.Type === 'Video') || {}).Codec,
    audio: my.audio, sub: my.subWanted, start: startMs, hls: url.indexOf('.m3u8') > 0, reasons: ms.TranscodeReasons });
  const step = (n) => { if (my.steps) my.steps[n] = Math.round(performance.now() - my.t0); };
  my.prepared = false;
  await eng.open(url, {
    onTime: (ms2) => onTime(my, ms2),
    onBuffering: (b) => { if (my === st) U.spin.classList.toggle('on', b && my.started); },
    onEnd: () => { if (my === st) ended(my); },
    onError: (m) => { error('player error', { m, method: my.method, pos: my.pos, active: my === st }); if (my === st) fail(my, new Error(m)); else my.prepared = false; },
    onSubtitle: (text, dur) => {
      metrics.subEvents = (metrics.subEvents || 0) + 1;
      if (my !== st || my.cues || my.sub < 0) return;
      U.subs.textContent = clean(text);
      clearTimeout(my.subT);
      my.subT = setTimeout(() => { if (my === st && !my.cues) U.subs.textContent = ''; }, Math.max(800, +dur || 3000));
    },
  });
  if (!alive()) return;
  const d = eng.duration();
  if (d) my.dur = d;
  eng.silentSubs(true);
  step('prepared');
  if (startMs > 1000) { await eng.seek(startMs); step('seeked'); }
  my.pos = startMs || 0;
  my.prepared = true;
}

function beginPlayback(my, startMs) {
  metrics.marks.playEngine = eng.name + ' ' + my.method + (my.steps && my.steps.warm ? ' (warm)' : '');
  my.pos = startMs || my.pos || 0;
  eng.play();
  my.started = true;
  // Apply default audio (if not the first) and default subtitle.
  const auds = my.streams.filter((s) => s.Type === 'Audio' && !s.IsExternal);
  if (my.method === 'DirectPlay' && auds.length > 1 && auds[0].Index !== my.audio) selectAudio(my, my.audio, true);
  if (my.subWanted >= 0) selectSub(my, my.subWanted, true);
  report(my, 'start');
  log('playing', { engine: eng.name, method: my.method, audio: my.audio, sub: my.subWanted, steps: my.steps });
  clearInterval(my.progressT);
  my.progressT = setInterval(() => report(my, 'progress'), 10000);
  applyPlayerPrefs(my);
}

async function openSource(my, info, startMs) {
  await prepareSource(my, info, startMs, () => my === st);
  if (my !== st) return;
  beginPlayback(my, startMs);
}

function onTime(my, ms) {
  if (my !== st) return;
  if (!my.firstFrame && ms > 0) {
    my.firstFrame = true;
    metrics.marks.playMs = Math.round(performance.now() - my.t0);
    if (my.steps) { my.steps.firstTime = metrics.marks.playMs; metrics.marks.playSteps = JSON.stringify(my.steps); }
    U.spin.classList.remove('on');
  }
  my.pos = ms;
  if (my.target == null && my.zone !== 'none') drawBar();
  // Skip Intro
  const intro = my.segs.find((s) => s.type === 'Intro' && ms >= s.s && ms < s.e - 1000);
  if (!!intro !== U.skip.classList.contains('on')) { U.skip.classList.toggle('on', !!intro); my.intro = intro || null; if (!intro && my.zone === 'skip') setZone('none'); }
  // Next episode countdown
  if (my.nextEp && !my.dismissedNext && !my.countdown && my.dur && store.prefs.autoplay !== false && !my.repeat) {
    const outro = my.segs.find((s) => s.type === 'Outro');
    const at = outro ? outro.s : my.dur - 30000;
    if (ms >= at && ms < my.dur - 1500) startCountdown(my);
  }
  // External subtitles drawn by us
  if (my.cues) drawCue(my, ms - (my.subDelay || 0));
}

function drawBar() {
  if (!st) return;
  const dur = st.dur || 1;
  const p = st.target != null ? st.target : st.pos;
  const f = Math.max(0, Math.min(1, p / dur));
  U.fill.style.transform = 'scaleX(' + f + ')';
  U.knob.style.transform = 'translate3d(' + Math.round(f * 1760) + 'px,0,0)';
  U.tcur.textContent = fmtClock(p / 1000);
  U.tleft.textContent = '-' + fmtClock((dur - p) / 1000);
  U.tip.textContent = st.target != null ? fmtClock(st.target / 1000) : '';
  if (st.target != null && st.seekMul > 1) {
    U.tip.appendChild(el('span', 'p-mul' + (st.seekDir < 0 ? ' rw' : ''))).innerHTML = ICON.ff + st.seekMul + '×';
  }
  U.tip.style.transform = U.knob.style.transform;
  U.tip.classList.toggle('on', st.target != null);
  drawThumb(f);
}

// Trickplay preview (Jellyfin 10.9+ tile sheets), shown while scrubbing if the server made them.
function drawThumb(f) {
  const tp = st.tp;
  const on = !!(tp && st.target != null);
  U.thumb.classList.toggle('on', on);
  if (!on) return;
  const per = tp.TileWidth * tp.TileHeight;
  const i = Math.min(tp.ThumbnailCount - 1, Math.floor(st.target / tp.Interval));
  const sheet = Math.floor(i / per), w = i % per;
  const url = S.server + '/Videos/' + st.item.Id + '/Trickplay/' + tp.Width + '/' + sheet + '.jpg?MediaSourceId=' + st.ms.Id + '&api_key=' + S.token;
  if (U.thumb._u !== url) { U.thumb._u = url; U.thumb.style.backgroundImage = 'url("' + url + '")'; new Image().src = url.replace('/' + sheet + '.jpg', '/' + (sheet + 1) + '.jpg'); }
  U.thumb.style.width = tp.Width + 'px'; U.thumb.style.height = tp.Height + 'px';
  U.thumb.style.backgroundPosition = -(w % tp.TileWidth) * tp.Width + 'px ' + -Math.floor(w / tp.TileWidth) * tp.Height + 'px';
  const x = Math.max(tp.Width / 2, Math.min(1760 - tp.Width / 2, f * 1760));
  U.thumb.style.transform = 'translate3d(' + Math.round(x - tp.Width / 2) + 'px,' + -(tp.Height + 90) + 'px,0)';
}

// ---------- controls ----------
let hideT = 0;
function showUi(on) {
  U.ui.classList.toggle('on', on);
  clearTimeout(hideT);
  if (on) { drawBar(); drawCtrls(); hideT = setTimeout(autoHide, UI_HIDE_MS); }
}
function autoHide() { if (st && !st.paused && st.target == null && st.zone !== 'menu') { setZone('none'); } else if (st) hideT = setTimeout(autoHide, UI_HIDE_MS); }
function poke() { clearTimeout(hideT); hideT = setTimeout(autoHide, UI_HIDE_MS); }

function setZone(z) {
  st.zone = z;
  U.bar.classList.toggle('f', z === 'bar');
  U.skip.classList.toggle('f', z === 'skip');
  if (z === 'none') { showUi(false); U.skip.classList.remove('f'); return; }
  if (z === 'menu') return;
  if (!U.ui.classList.contains('on')) showUi(true); else { drawCtrls(); poke(); }
}

function togglePause() {
  if (!st || !st.started) return;
  if (st.paused) { eng.play(); st.paused = false; } else { eng.pause(); st.paused = true; }
  U.pauseIco.innerHTML = st.paused ? ICON.pause : ICON.play;
  U.pauseIco.classList.remove('on'); void U.pauseIco.offsetWidth; U.pauseIco.classList.add('on'); // eslint-disable-line no-void
  report(st, 'progress', st.paused ? 'Pause' : 'Unpause');
  if (st.zone === 'ctrls' || st.zone === 'bar') drawCtrls();
}

function seekStep(dir, repeat) {
  if (!st || !st.started) return;
  repeat = repeat || held.on;
  // Single tap = 10 s. While the key is held, the step doubles every 0.5 s: 10, 20, 40, 80, 160 s...
  // capped at 2% of the runtime (at least 1 min, at most 5 min).
  const now = Date.now();
  if (!repeat || now - st.lastSeek > 600 || st.seekDir !== dir) {
    if (st.holdSteps > 1) log('seek hold', { steps: st.holdSteps, maxStep_s: st.holdMax / 1000, held_ms: st.lastSeek - st.holdStart, eRepeat: held.sawRepeat, keyups: held.ups });
    st.holdStart = now; st.seekDir = dir; st.lastStep = 0; st.holdSteps = 0; st.holdMax = 0; held.ups = 0; held.sawRepeat = false;
  }
  st.lastSeek = now;
  // the remote repeats ~10-20 times a second; take one step per 250 ms so the ramp is the same on every remote
  if (repeat && now - st.lastStep < 240) { poke(); clearTimeout(st.seekT); const m = st; st.seekT = setTimeout(() => commitSeek(m), 400); return; }
  st.lastStep = now;
  const cap = Math.min(300000, Math.max(60000, (st.dur || 0) * 0.02));
  const step = Math.min(cap, 10000 * Math.pow(2, Math.floor((now - st.holdStart) / 500)));
  st.seekMul = Math.round(step / 10000);
  st.holdSteps = (st.holdSteps || 0) + 1; st.holdMax = Math.max(st.holdMax || 0, step);
  const base = st.target != null ? st.target : st.pos;
  st.target = Math.max(0, Math.min((st.dur || 1e12) - 3000, base + dir * step));
  drawBar();
  clearTimeout(st.seekT);
  const my = st;
  st.seekT = setTimeout(() => commitSeek(my), 400);
}

function seekBy(ms) {
  if (st) st.seekMul = 1; if (!st) return; st.target = Math.max(0, Math.min((st.dur || 1e12) - 3000, (st.target != null ? st.target : st.pos) + ms)); drawBar(); clearTimeout(st.seekT); const my = st; st.seekT = setTimeout(() => commitSeek(my), 300); }

function commitSeek(my) {
  if (my !== st || my.target == null) return;
  const t = my.target;
  U.spin.classList.add('on');
  eng.seek(t).then(() => {
    if (my !== st) return;
    my.pos = t; my.target = null; my.cueIdx = 0;
    U.spin.classList.remove('on');
    drawBar();
    report(my, 'progress', 'TimeUpdate');
  });
}

// ---------- next episode ----------
function startCountdown(my) {
  my.countdown = { n: 10 };
  const n = my.nextEp;
  U.next.innerHTML = '';
  el('div', 'pn-h', U.next, 'Next Episode');
  el('div', 'pn-t', U.next, epLabel(n) + '  ' + n.Name);
  const c = el('div', 'pn-c btn btn-w f', U.next);
  const lb = el('span', '', c, 'Play now · 10');
  el('div', 'pn-hint', U.next, 'Back to keep watching the credits');
  U.next.classList.add('on');
  my.countdown.t = setInterval(() => {
    if (my !== st) return;
    my.countdown.n--;
    lb.textContent = 'Play now · ' + my.countdown.n;
    if (my.countdown.n <= 0) playNext(my);
  }, 1000);
}
function cancelCountdown(my) { if (my.countdown) { clearInterval(my.countdown.t); my.countdown = null; } U.next.classList.remove('on'); }
function playNext(my) {
  if (!my.nextEp) return;
  cancelCountdown(my);
  const n = my.nextEp;
  start(n, { restart: !(n.UserData && n.UserData.PlaybackPositionTicks) });
}
function ended(my) {
  log('playback ended', { item: my.item && my.item.Name });
  if (my.repeat) { my.target = 0; commitSeek(my); eng.play(); return; }
  if (my.nextEp && !my.dismissedNext && store.prefs.autoplay !== false) playNext(my); else close();
}

// ---------- audio & subtitles ----------
function audioList(my) { return my.streams.filter((s) => s.Type === 'Audio'); }
function subList(my) { return my.streams.filter((s) => s.Type === 'Subtitle'); }
const LANG = { eng: 'English', en: 'English', hin: 'Hindi', hi: 'Hindi', ita: 'Italian', fre: 'French', fra: 'French', ger: 'German', deu: 'German', spa: 'Spanish', jpn: 'Japanese',
  kor: 'Korean', chi: 'Chinese', zho: 'Chinese', rus: 'Russian', por: 'Portuguese', ara: 'Arabic', tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam', ben: 'Bengali', pun: 'Punjabi',
  urd: 'Urdu', mar: 'Marathi', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', pol: 'Polish', tur: 'Turkish', gre: 'Greek', heb: 'Hebrew' };
function streamLabel(s) {
  const lang = s.Language && s.Language.toLowerCase() !== 'und' ? LANG[s.Language.toLowerCase()] || s.Language.toUpperCase() : 'Unknown language';
  const parts = [lang];
  if (s.Title && !/^(undefined|und)$/i.test(s.Title) && s.Title.toLowerCase() !== lang.toLowerCase()) parts.push(s.Title);
  if (s.Type === 'Audio') {
    parts.push((s.Codec || '').toUpperCase() + (s.ChannelLayout ? ' ' + s.ChannelLayout : s.Channels ? ' ' + s.Channels + 'ch' : ''));
  } else {
    parts.push((s.Codec || '').toUpperCase().replace('SUBRIP', 'SRT').replace('PGSSUB', 'PGS'));
    if (s.IsForced) parts.push('Forced');
  }
  if (s.IsExternal) parts.push('External');
  if (s.IsDefault) parts.push('Default');
  return parts.filter(Boolean).join(' · ');
}

function selectAudio(my, index, quiet) {
  const s = my.streams.find((x) => x.Index === index);
  if (!s) { warn('audio change: stream not found', index); return; }
  if (!quiet && index === my.audio) { log('audio change: already on this track', index); return; }
  log('audio change', { from: my.audio, to: index, codec: s.Codec, ch: s.Channels, lang: s.Language, method: my.method, quiet: !!quiet });
  const auds = audioList(my).filter((x) => !x.IsExternal);
  const nth = auds.indexOf(s);
  const ok = AUDIO_OK.indexOf((s.Codec || '').toLowerCase()) >= 0;
  if (my.method === 'DirectPlay' && ok && nth >= 0 && eng.name === 'avplay') {
    const tr = eng.tracks().filter((t) => t.type === 'AUDIO');
    if (!tr[nth]) warn('audio change: TV track list has no entry', { nth, tracks: tr.length });
    if (tr[nth] && eng.select('AUDIO', tr[nth].index)) { log('audio change: switched on the TV', tr[nth].index); my.audio = index; if (!quiet) toast('Audio: ' + streamLabel(s), 2000); report(my, 'progress', 'AudioTrackChange'); return; }
  }
  // Needs the server: restart from here with that audio track (transcoded audio).
  log('audio change: restarting through the server', { codecOk: ok, nth });
  my.audio = index;
  reload(my, { audio: index });
}

async function reload(my, o) {
  // One restart at a time: a second change while the stream restarts waits and is merged (avoids two AVPlay opens at once).
  if (my.reloading) { my.pendingReload = Object.assign(my.pendingReload || {}, o); log('reload queued (another restart running)', o); return; }
  my.reloading = true;
  const t0 = performance.now();
  const pos = my.pos;
  log('reload start', Object.assign({ pos }, o));
  U.spin.classList.add('on');
  try {
    clearInterval(my.progressT);
    const opts = Object.assign({ startTicks: pos * TICKS, sub: my.sub, audio: my.audio, maxBitrate: my.maxBitrate, burn: my.burn }, o);
    my.forceTranscode = !!(opts.maxBitrate || opts.burn || opts.noDirect);
    opts.noDirect = my.forceTranscode;
    const info = await playbackInfo(my.item, opts);
    if (my !== st) return;
    if (my.method === 'Transcode' && my.info) send('DELETE', '/Videos/ActiveEncodings', null, { DeviceId: store.deviceId, PlaySessionId: my.info.PlaySessionId }).catch(() => {});
    my.info = info; my.started = false; my.firstFrame = false;
    my.subWanted = my.sub;
    clearInterval(my.progressT);
    await openSource(my, info, pos);
    log('reload done', { ms: Math.round(performance.now() - t0), method: my.method });
  } catch (e) { error('reload failed', { m: e && e.message, ms: Math.round(performance.now() - t0) }); if (my === st) fail(my, e); } finally {
    my.reloading = false;
    if (my.pendingReload && my === st) { const p = my.pendingReload; my.pendingReload = null; reload(my, p); }
  }
}

async function selectSub(my, index, quiet) {
  log('subtitle change', { from: my.sub, to: index, quiet: !!quiet, method: my.method });
  my.cues = null; my.cueIdx = 0; U.subs.textContent = '';
  if (index < 0) {
    my.sub = -1; eng.silentSubs(true); if (!quiet) toast('Subtitles off', 1500); report(my, 'progress', 'SubtitleTrackChange');
    if (my.burn) { my.burn = false; reload(my, { sub: -1, burn: false }); }
    return;
  }
  const s = my.streams.find((x) => x.Index === index);
  if (!s) return;
  if (s.IsTextSubtitleStream === false) {
    // Picture subtitles (PGS/VobSub): ask the server to burn them into the picture.
    if (quiet) return;
    my.sub = index; my.burn = true;
    toast('Subtitles: ' + streamLabel(s) + ' (drawn by the server)', 2500);
    reload(my, { sub: index, burn: true });
    return;
  }
  if (my.burn) { my.burn = false; my.sub = index; reload(my, { sub: index, burn: false }); return; }
  my.sub = index;
  report(my, 'progress', 'SubtitleTrackChange');
  // Embedded text track during direct play: let AVPlay decode it (no server work).
  if (!s.IsExternal && my.method === 'DirectPlay' && eng.name === 'avplay') {
    const embedded = subList(my).filter((x) => !x.IsExternal);
    const nth = embedded.indexOf(s);
    const tr = eng.tracks().filter((t) => t.type === 'TEXT' || t.type === 'SUBTITLE');
    if (tr[nth] && eng.select('TEXT', tr[nth].index)) { eng.silentSubs(false); if (!quiet) toast('Subtitles: ' + streamLabel(s), 2000); return; }
  }
  // Otherwise fetch it from the server as WebVTT and draw it ourselves.
  eng.silentSubs(true);
  const path = s.DeliveryUrl && s.DeliveryMethod === 'External' ? s.DeliveryUrl : '/Videos/' + my.item.Id + '/' + my.ms.Id + '/Subtitles/' + index + '/0/Stream.vtt';
  try {
    const u = S.server + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + S.token;
    const r = await fetch(u.replace(/\/Stream\.\w+(\?|$)/, '/Stream.vtt$1'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    if (my !== st || my.sub !== index) return;
    my.cues = parseVtt(txt);
    if (!quiet) toast('Subtitles: ' + streamLabel(s), 2000);
  } catch (e) { toast('Could not load subtitles: ' + e.message); }
}

function parseVtt(t) {
  const ts = (x) => { const p = x.trim().split(' ')[0].split(':').map(parseFloat); while (p.length < 3) p.unshift(0); return ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000; };
  const out = [];
  for (const b of t.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.indexOf('-->') >= 0);
    if (i < 0) continue;
    const [a, c] = lines[i].split('-->');
    out.push({ s: ts(a), e: ts(c), t: clean(lines.slice(i + 1).join('\n')) });
  }
  return out.sort((x, y) => x.s - y.s);
}
function clean(t) { return String(t || '').replace(/[\r\u0000]/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\\N/g, '\n').trim(); }
function drawCue(my, ms) {
  const c = my.cues;
  let i = my.cueIdx;
  if (i >= c.length || c[i].s > ms) i = 0;
  while (i < c.length && c[i].e <= ms) i++;
  my.cueIdx = i;
  const txt = i < c.length && c[i].s <= ms && c[i].e > ms ? c[i].t : '';
  if (U.subs.textContent !== txt) U.subs.textContent = txt;
}

// ---------- settings panel (Netflix-style: categories on the left, choices on the right) ----------
const QUALITY = [
  { label: 'Original (direct play)', bps: 0 },
  { label: '1080p · 20 Mbps', bps: 20000000 },
  { label: '720p · 8 Mbps', bps: 8000000 },
  { label: '480p · 3 Mbps', bps: 3000000 },
  { label: '360p · 1.5 Mbps', bps: 1500000 },
];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ZOOMS = [
  { label: 'Fit (whole picture)', mode: 'PLAYER_DISPLAY_MODE_LETTER_BOX' },
  { label: 'Fill screen (crop edges)', mode: 'PLAYER_DISPLAY_MODE_CROPPED_FULL' },
  { label: 'Stretch', mode: 'PLAYER_DISPLAY_MODE_FULL_SCREEN' },
  { label: 'Original size', mode: 'PLAYER_DISPLAY_MODE_ORIGIN_OR_LETTER' },
];
const SUB_SIZES = [['Small', 's'], ['Medium', 'm'], ['Large', 'l'], ['Extra large', 'xl']];
const SUB_POS = [['Low', 'low'], ['Middle', 'mid'], ['High', 'high']];
const SUB_BG = [['Shadow', 'shadow'], ['Dark box', 'box'], ['None', 'none']];
const prefs = () => store.prefs;

function applySubStyle() {
  const pr = prefs();
  U.subs.className = 'p-subs ss-' + (pr.subSize || 'm') + ' sp-' + (pr.subPos || 'low') + ' sb-' + (pr.subBg || 'shadow');
}
function applyPlayerPrefs(my) {
  const pr = prefs();
  applySubStyle();
  if (pr.zoom && pr.zoom !== ZOOMS[0].mode && eng.zoom) eng.zoom(pr.zoom);
  if (my.speed && my.speed !== 1 && eng.speed) eng.speed(my.speed);
  if (my.subDelay && eng.subDelay) eng.subDelay(my.subDelay);
}

function mediaInfoLines(my) {
  const ms = my.ms || {};
  const v = (my.streams || []).find((s) => s.Type === 'Video') || {};
  const a = (my.streams || []).find((s) => s.Index === my.audio) || {};
  const lines = [];
  lines.push('Playing: ' + (my.method === 'DirectPlay' ? 'Direct play (the TV reads the file itself)' : 'Transcode (the server converts it)'));
  const reasons = /TranscodeReasons=([^&]+)/.exec(ms.TranscodingUrl || '');
  if (my.method !== 'DirectPlay') lines.push('Why: ' + (my.maxBitrate ? 'lower quality chosen' : my.burn ? 'picture subtitles burned in' : reasons ? decodeURIComponent(reasons[1]).replace(/,/g, ', ') : 'not playable directly'));
  lines.push('Player: ' + (eng ? (eng.name === 'avplay' ? 'Samsung AVPlay' : 'HTML5 video') : '?'));
  lines.push('File: ' + (ms.Container || '?') + (ms.Size ? ' · ' + (ms.Size / 1e9).toFixed(1) + ' GB' : '') + (ms.Bitrate ? ' · ' + (ms.Bitrate / 1e6).toFixed(1) + ' Mbps' : ''));
  lines.push('Video: ' + [v.Codec && v.Codec.toUpperCase(), v.Width && v.Width + '×' + v.Height, v.VideoRangeType, v.BitRate && (v.BitRate / 1e6).toFixed(1) + ' Mbps', v.RealFrameRate && Math.round(v.RealFrameRate * 100) / 100 + ' fps'].filter(Boolean).join(' · '));
  lines.push('Audio: ' + [a.Codec && a.Codec.toUpperCase(), a.ChannelLayout || (a.Channels && a.Channels + ' ch'), a.Language, a.BitRate && Math.round(a.BitRate / 1000) + ' kbps'].filter(Boolean).join(' · '));
  if (my.quality) lines.push('Quality limit: ' + my.quality);
  if (my.speed && my.speed !== 1) lines.push('Speed: ' + my.speed + '×');
  lines.push('Position: ' + fmtClock(my.pos / 1000) + ' / ' + fmtClock((my.dur || 0) / 1000));
  return lines;
}

function menuCategories(my) {
  const pr = prefs();
  const cats = [];
  cats.push({ title: 'Audio', items: audioList(my).map((s) => ({ label: streamLabel(s), on: s.Index === my.audio, act: () => selectAudio(my, s.Index) })) });
  cats.push({ title: 'Subtitles', items: [{ label: 'Off', on: my.sub < 0, act: () => selectSub(my, -1) }].concat(subList(my).map((s) => ({
    label: streamLabel(s) + (s.IsTextSubtitleStream === false ? ' · burned in by server' : ''), on: s.Index === my.sub, act: () => selectSub(my, s.Index) }))) });
  cats.push({ title: 'Subtitle style', items: [].concat(
    SUB_SIZES.map(([l, v]) => ({ label: 'Size: ' + l, on: (pr.subSize || 'm') === v, keep: true, act: () => { store.setPref('subSize', v); applySubStyle(); } })),
    SUB_POS.map(([l, v]) => ({ label: 'Position: ' + l, on: (pr.subPos || 'low') === v, keep: true, act: () => { store.setPref('subPos', v); applySubStyle(); } })),
    SUB_BG.map(([l, v]) => ({ label: 'Background: ' + l, on: (pr.subBg || 'shadow') === v, keep: true, act: () => { store.setPref('subBg', v); applySubStyle(); } })),
  ) });
  const d = my.subDelay || 0;
  cats.push({ title: 'Subtitle sync', items: [-2000, -1000, -500, -250, 0, 250, 500, 1000, 2000].map((x) => ({
    label: (x === 0 ? 'In sync (0 s)' : (x > 0 ? 'Show later +' : 'Show earlier ') + (x / 1000) + ' s'), on: d === x, keep: true, act: () => setSubDelay(my, x) })) });
  cats.push({ title: 'Quality', items: QUALITY.map((q) => ({ label: q.label, on: (my.maxBitrate || 0) === q.bps, act: () => setQuality(my, q) })) });
  // Samsung AVPlay's setSpeed is trick-play (fast-forward picture, no sound), not real speed playback, so only offer it with HTML5.
  if (eng && eng.name !== 'avplay') cats.push({ title: 'Speed', items: SPEEDS.map((x) => ({ label: x === 1 ? 'Normal (1×)' : x + '×', on: (my.speed || 1) === x, keep: true, act: () => setSpeed(my, x) })) });
  else cats.push({ title: 'Speed', info: true, items: [{ label: 'Normal speed only: the TV\'s built-in player (AVPlay) cannot play faster or slower with sound.', info: true }] });
  cats.push({ title: 'Zoom', items: ZOOMS.map((z) => ({ label: z.label, on: (pr.zoom || ZOOMS[0].mode) === z.mode, keep: true, act: () => { store.setPref('zoom', z.mode); if (eng.zoom) eng.zoom(z.mode); } })) });
  cats.push({ title: 'Autoplay & repeat', items: [
    { label: 'Next episode autoplay: On', on: pr.autoplay !== false, keep: true, act: () => store.setPref('autoplay', true) },
    { label: 'Next episode autoplay: Off', on: pr.autoplay === false, keep: true, act: () => store.setPref('autoplay', false) },
    { label: 'Repeat this video: Off', on: !my.repeat, keep: true, act: () => { my.repeat = false; } },
    { label: 'Repeat this video: On', on: !!my.repeat, keep: true, act: () => { my.repeat = true; } },
  ] });
  cats.push({ title: 'Playback info', info: true, items: mediaInfoLines(my).map((l) => ({ label: l, info: true })) });
  const full = Object.assign({}, my.item, { Path: my.ms && my.ms.Path, LocationType: 'FileSystem' });
  if (S.admin && canMediaFix(full)) {
    const fixItem = { label: 'Fix Audio', badge: null, act: () => runMediaFix('fix-audio', full) };
    let asked = false;
    cats.push({ title: 'Fix Audio & Subtitle', items: [fixItem, { label: 'Fetch Subtitle', act: () => runMediaFix('fix-subtitle', full) }], onShow: (redraw) => {
      if (asked) return;
      asked = true;
      fixStatus(full.Path).then((s) => { if (s) { fixItem.badge = s; redraw(); } });
    } });
  }
  return cats;
}

function setSubDelay(my, ms) {
  my.subDelay = ms;
  if (!my.cues && eng.subDelay) eng.subDelay(ms);
  toast(ms ? 'Subtitles ' + (ms > 0 ? 'later' : 'earlier') + ' by ' + Math.abs(ms / 1000) + ' s' : 'Subtitles in sync', 1500);
}
function setSpeed(my, x) {
  if (!eng.speed || !eng.speed(x)) { toast('This speed is not supported by the TV player for this file.'); return; }
  my.speed = x;
  toast('Speed ' + x + '×', 1500);
}
function setQuality(my, q) {
  if ((my.maxBitrate || 0) === q.bps) return;
  log('quality change', { from: my.maxBitrate || 'original', to: q.label });
  my.maxBitrate = q.bps || 0;
  my.quality = q.bps ? q.label : '';
  toast('Quality: ' + q.label, 2000);
  reload(my, { maxBitrate: q.bps || undefined });
}

function openMenu() {
  const my = st;
  const cats = menuCategories(my);
  my.menu = { cats, c: 0, side: 'cats' };
  my.menu.oi = cats.map((c) => Math.max(0, c.items.findIndex((x) => x.on)));
  drawMenu();
  U.menu.classList.add('on');
  showUi(false);
  my.zone = 'menu';
}
function drawMenu() {
  const m = st.menu;
  U.menu.textContent = '';
  const left = el('div', 'pm-cats', U.menu);
  m.cats.forEach((c, ci) => el('div', 'pm-c' + (ci === m.c ? ' sel' : '') + (m.side === 'cats' && ci === m.c ? ' f' : ''), left, c.title));
  const right = el('div', 'pm-opts', U.menu);
  const cat = m.cats[m.c];
  el('div', 'pm-h', right, cat.title);
  const list = el('div', 'pm-list', right);
  const oi = m.oi[m.c];
  const first = Math.max(0, Math.min(oi - 5, cat.items.length - 11));
  cat.items.slice(first, first + 11).forEach((it, k) => {
    const ii = first + k;
    const row = el('div', 'pm-i' + (it.on ? ' on' : '') + (it.info ? ' info' : '') + (m.side === 'opts' && ii === oi && !it.info ? ' f' : ''), list, it.label);
    if (it.badge) { const b = el('span', 'pm-badge ' + (it.badge.cls || ''), row); if (it.badge.cls === 'ok') el('span', 'ic', b).innerHTML = ICON.check; el('span', '', b, it.badge.text); }
  });
  if (cat.onShow) cat.onShow(() => { if (st && st.menu === m) drawMenu(); });
}
function menuKey(k) {
  const m = st.menu;
  const cat = m.cats[m.c];
  if (k === 'back') { if (m.side === 'opts') { m.side = 'cats'; drawMenu(); } else closeMenu(); return; }
  if (m.side === 'cats') {
    if (k === 'up' && m.c > 0) m.c--;
    else if (k === 'down' && m.c < m.cats.length - 1) m.c++;
    else if ((k === 'right' || k === 'ok') && cat.items.length && !cat.info) m.side = 'opts';
    else return;
  } else {
    if (k === 'left') m.side = 'cats';
    else if (k === 'up' && m.oi[m.c] > 0) m.oi[m.c]--;
    else if (k === 'down' && m.oi[m.c] < cat.items.length - 1) m.oi[m.c]++;
    else if (k === 'ok') {
      const it = cat.items[m.oi[m.c]];
      if (!it || !it.act) return;
      if (!it.keep) { closeMenu(); it.act(); return; }
      it.act();
      // refresh ticks, keep the categories' own state (e.g. a loaded badge)
      const fresh = menuCategories(st);
      fresh.forEach((c, ci) => { if (m.cats[ci] && m.cats[ci].onShow) fresh[ci] = m.cats[ci]; });
      m.cats = fresh;
    } else return;
  }
  drawMenu();
}
function closeMenu() { U.menu.classList.remove('on'); st.menu = null; st.zone = 'none'; setZone('ctrls'); }

// Audio-fix state for the player menu badge (same helper /status call as the details page).
function fixStatus(path) {
  return fetchFixStatus(path).then((d) => {
    if (!d) return null;
    if (d.state === 'running') return { text: 'fixing… ' + (d.progressPercent != null ? d.progressPercent + '%' : ''), cls: 'run' };
    if (d.fixed) return { text: 'Audio fixed', cls: 'ok' };
    if (d.lastResultStatus && !/^(OK|DRYRUN)/.test(d.lastResultStatus)) return { text: 'last fix failed', cls: 'bad' };
    return null;
  });
}

// ---------- reporting ----------
function report(my, kind, ev) {
  if (!my.ms) return null;
  const body = {
    ItemId: my.item.Id, MediaSourceId: my.ms.Id, PlaySessionId: my.info && my.info.PlaySessionId, PositionTicks: Math.round((my.target != null ? my.target : my.pos) * TICKS),
    IsPaused: !!my.paused, IsMuted: false, VolumeLevel: 100, PlayMethod: my.method, CanSeek: true, RepeatMode: 'RepeatNone',
    AudioStreamIndex: my.audio, SubtitleStreamIndex: my.sub, EventName: ev || undefined,
  };
  const path = kind === 'start' ? '/Sessions/Playing' : kind === 'stop' ? '/Sessions/Playing/Stopped' : '/Sessions/Playing/Progress';
  return send('POST', path, body).catch(() => {});
}

async function stopPlayback(switching) {
  const my = st;
  if (!my) return;
  my.alive = false;
  clearInterval(my.progressT); clearTimeout(my.seekT); cancelCountdown(my);
  if (eng && my.started) { const t = eng.time(); if (t) my.pos = t; }
  if (eng) eng.stop();
  st = null;
  const p = report(my, 'stop');
  if (my.method === 'Transcode' && my.info) send('DELETE', '/Videos/ActiveEncodings', null, { DeviceId: store.deviceId, PlaySessionId: my.info.PlaySessionId }).catch(() => {});
  if (!switching) { await Promise.race([p, new Promise((r) => setTimeout(r, 1500))]); }
}

async function fail(my, e) {
  error('playback failed', { m: e && e.message, method: my.method, retried: !!my.retried, pos: my.pos, item: my.item && my.item.Name });
  // Direct play failed on the TV: try once more through the server (transcode).
  if (!my.retried && my.method === 'DirectPlay') {
    my.retried = true; my.forceTranscode = true;
    try {
      const info = await playbackInfo(my.item, { startTicks: my.pos * TICKS, noDirect: true });
      if (my !== st) return;
      my.info = info; my.started = false;
      await openSource(my, info, my.pos);
      return;
    } catch (e2) { e = e2; }
  }
  if (my !== st) return;
  close();
  alertBox(e.message || String(e), 'Playback problem');
}

function close() {
  const was = st;
  if (was) log('player close', { item: was.item && was.item.Name, pos: was.pos, dur: was.dur, method: was.method });
  // Hide first so Back feels instant; stop the TV player right after the screen has switched.
  document.body.classList.remove('playing');
  if (app.isTop(layer)) app.pop(layer);
  if (was) { was.alive = false; clearInterval(was.progressT); }
  afterPaint(() => { stopPlayback().then(() => { app.emit('played', was && was.item); }); });
}

const layer = {
  overlay: true,
  key(k, e) {
    if (!st) { if (k === 'back') close(); return true; }
    const z = st.zone;
    if (z === 'menu') { menuKey(k); return true; }
    if (k === 'back') {
      if (st.countdown) { st.dismissedNext = true; cancelCountdown(st); return true; }
      close();
      return true;
    }
    if (k === 'stop') { close(); return true; }
    if (k === 'play' || k === 'pause' || k === 'playpause') { if (k === 'playpause' || (k === 'play') === st.paused) togglePause(); setZone(z === 'none' ? 'ctrls' : z); return true; }
    if (k === 'ff' || k === 'rw') { if (z === 'none' || z === 'ctrls') setZone('bar'); seekStep(k === 'ff' ? 1 : -1, e && e.repeat); return true; }
    if (k === 'next') { if (st.nextEp) playNext(st); return true; }
    if (st.countdown && k === 'ok') { playNext(st); return true; }
    if (z === 'none') {
      if (k === 'left' || k === 'right') { setZone('bar'); seekStep(k === 'right' ? 1 : -1, e && e.repeat); return true; }
      if (k === 'ok') { if (st.intro) { skipIntro(); return true; } togglePause(); st.ci = 0; setZone('ctrls'); return true; }
      if (k === 'up' && st.intro) { setZone('skip'); return true; }
      setZone('ctrls');
      return true;
    }
    poke();
    if (z === 'skip') {
      if (k === 'ok') skipIntro();
      else if (k === 'down') setZone('bar');
      return true;
    }
    if (z === 'bar') {
      if (k === 'left' || k === 'right') seekStep(k === 'right' ? 1 : -1, e && e.repeat);
      else if (k === 'ok') togglePause();
      else if (k === 'down') setZone('ctrls');
      else if (k === 'up' && st.intro) setZone('skip');
      return true;
    }
    if (z === 'ctrls') {
      if (k === 'left' && st.ci > 0) { st.ci--; drawCtrls(); } else if (k === 'right' && st.ci < st.ctrls.length - 1) { st.ci++; drawCtrls(); } else if (k === 'up') setZone('bar');
      else if (k === 'ok') {
        const id = st.ctrls[st.ci].id;
        if (id === 'pp') togglePause();
        else if (id === 'back10') seekBy(-10000);
        else if (id === 'fwd10') seekBy(10000);
        else if (id === 'menu') openMenu();
        else if (id === 'next') playNext(st);
      }
      return true;
    }
    return true;
  },
  hide() { clearTimeout(hideT); document.body.classList.remove('playing'); },
};

function skipIntro() {
  if (!st || !st.intro) return;
  st.target = st.intro.e;
  U.skip.classList.remove('on');
  st.intro = null;
  commitSeek(st);
  setZone('none');
}

// For the test scripts: a snapshot of the current playback.
export function playerState() {
  if (!st) return null;
  return {
    item: st.item.Name, method: st.method, engine: eng && eng.name, pos: Math.round(st.pos), dur: Math.round(st.dur), paused: st.paused,
    audio: st.audio, sub: st.sub, extCues: st.cues ? st.cues.length : 0, subText: U.subs.textContent, zone: st.zone,
    menu: U.menu.classList.contains('on') ? U.menu.textContent.slice(0, 300) : '', intro: !!st.intro, nextEp: st.nextEp && st.nextEp.Name,
    tracks: eng && eng.tracks ? eng.tracks().map((t) => t.type + ':' + t.index) : [],
  };
}
export function testSeek(ms) { if (st && st.started) { st.target = Math.max(0, ms < 0 ? st.dur + ms : ms); commitSeek(st); } }
