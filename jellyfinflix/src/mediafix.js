// "Fix Audio" / "Fetch Subtitle" (admin only) — same mediafix-helper calls as JellyfinNX.
// Helper API: POST /jobs {action, path} -> 202 {jobId}; GET /jobs/{id} -> {state, exitCode, resultStatus, output};
// GET /status?path= -> {state, fixed, progressPhase, progressPercent}.
import { S, send } from './api.js';
import { dialog, alertBox, toast } from './ui/dialog.js';
import { store } from './store.js';
import { metrics } from './util.js';
import { log } from './log.js';

export const HELPER_URL = 'http://192.168.0.154:8099';
const POLL = { 'fix-subtitle': 2000, 'fix-audio': 10000 };
const CAP = { 'fix-subtitle': 5 * 60 * 1000, 'fix-audio': 45 * 60 * 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function canMediaFix(it) {
  if (!S.admin || !it) return false;
  if (it.Type !== 'Movie' && it.Type !== 'Episode') return false;
  if (it.LocationType === 'Virtual') return false;
  return !!(it.Path && it.Path.indexOf('/MEDIA/') === 0);
}

// Messages taken from JellyfinNX's own strings (same helper, same exit codes).
const SUB_MSG = {
  1: "The subtitle tool isn't set up on the server (subliminal is missing).",
  2: "Couldn't work out which video file to use for this movie.",
  3: 'No matching English subtitle was found for this movie.',
  4: "Found a subtitle but couldn't save it to the NAS.",
  6: 'The NAS credentials file on the server is missing or has the wrong permissions.',
};
const AUDIO_MSG = {
  1: 'A tool the audio fixer needs is missing on the server.',
  3: "Couldn't read the audio track to measure it.",
  4: 'The re-encode failed. Nothing on the NAS was changed.',
  5: 'The new file failed its safety checks and was thrown away. Your movie is untouched.',
  6: 'NAS login problem. Nothing was changed.',
  7: "Couldn't write to the NAS. Your movie is untouched — safe to retry.",
  8: 'The movie may not be at its expected filename. Do not retry — every future Fix Audio will also fail this way until the leftover journal file on the server is cleared by hand.',
};

async function startJob(action, path) {
  let r;
  try {
    r = await fetch(HELPER_URL + '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, path }) });
  } catch (e) { throw new Error('The media fix helper is not reachable (' + HELPER_URL + ').'); }
  if (r.status === 202) return r.json();
  let body = {};
  try { body = await r.json(); } catch (e) { /* ignore */ }
  if (r.status === 409) throw new Error('A fix is already running for this file.');
  throw new Error(body.detail || body.error || 'HTTP ' + r.status);
}

async function pollJob(jobId, action) {
  const start = Date.now();
  let fails = 0;
  while (Date.now() - start < CAP[action]) {
    await sleep(POLL[action]);
    let r;
    try { r = await fetch(HELPER_URL + '/jobs/' + jobId, { cache: 'no-store' }); } catch (e) { if (++fails >= 3) return { lost: true }; continue; }
    if (!r.ok) { if (++fails >= 3) return { lost: true }; continue; }
    fails = 0;
    const job = await r.json();
    if (job.state !== 'running') return { job };
  }
  return { timedOut: true };
}

function refreshItem(id) {
  send('POST', '/Items/' + id + '/Refresh', null, { Recursive: false, ImageRefreshMode: 'Default', MetadataRefreshMode: 'Default', ReplaceAllImages: false, ReplaceAllMetadata: false }).catch(() => {});
}

export async function runMediaFix(action, item) {
  log('mediafix start', { action, item: item && item.Name });
  const path = item.Path;
  if (!canMediaFix(item)) { alertBox('This file is not under /MEDIA/, so it cannot be fixed from here.'); return; }
  if (action === 'fix-audio') {
    const ok = await dialog({ title: 'Fix Audio', text: 'Re-encode this movie\'s audio so dialogue is easier to hear? This runs on the server and can take a while. The original is kept until the fixed file is verified.', buttons: [{ label: 'Start', value: 1 }, { label: 'Cancel', value: 0 }] });
    if (!ok) return;
  }
  let start;
  try { start = await startJob(action, path); } catch (e) { alertBox(e.message, action === 'fix-audio' ? 'Fix Audio' : 'Fetch Subtitle'); return; }
  toast(action === 'fix-audio' ? 'Audio fix started — you can keep watching.' : 'Looking for an English subtitle…', 4000);
  const out = await pollJob(start.jobId, action);
  if (out.timedOut) { alertBox('Still running on the server (job ' + start.jobId + '). Check again later.'); return; }
  if (out.lost) { alertBox('Lost contact with the helper (job ' + start.jobId + ').'); return; }
  const job = out.job;
  if (action === 'fix-subtitle') {
    if (job.state === 'succeeded') { alertBox('Subtitle downloaded and saved next to the movie. Jellyfin has been asked to re-check this item.', 'Fetch Subtitle'); refreshItem(item.Id); return; }
    alertBox(SUB_MSG[job.exitCode] || ('The subtitle tool failed (exit ' + job.exitCode + ').\n' + (job.output || '').split('\n').slice(-6).join('\n')), 'Fetch Subtitle');
    return;
  }
  const st = job.resultStatus;
  if (st === 'OK_NOFIX') { alertBox('Audio is already fine — nothing was changed.', 'Fix Audio'); return; }
  if (st === 'OK_FIXED' || (job.exitCode === 0 && !st)) { alertBox('Audio fixed and verified. The original has been deleted automatically. Jellyfin has been asked to re-check this item.', 'Fix Audio'); refreshItem(item.Id); return; }
  if (st === 'OK_LOCAL_ONLY') { alertBox("Audio was fixed but the file isn't on the NAS, so the new copy was left on the server.", 'Fix Audio'); refreshItem(item.Id); return; }
  const o = job.output || '';
  let msg = AUDIO_MSG[job.exitCode];
  if (job.exitCode === 2) {
    msg = o.indexOf('Another run is already in progress') >= 0 ? 'Another audio fix is already running.'
      : o.indexOf('Already processed') >= 0 ? 'A leftover .pre-audiofix backup exists, likely from a previous fix whose auto-cleanup failed. Remove it by hand on the server before fixing this movie again.'
        : o.indexOf('Ambiguous') >= 0 ? 'That folder has more than one video file. Open the exact file and try again.'
          : o.indexOf('Not enough') >= 0 ? 'Not enough free space.' : "Couldn't start the audio fix.\n" + o.split('\n').slice(-6).join('\n');
  }
  alertBox(msg || ('The audio fixer failed (exit ' + job.exitCode + ').'), job.exitCode === 8 ? 'Needs a human' : 'Fix Audio');
}

// One /status read (cached 10 min for idle results). Returns the helper's JSON or null.
const statusCache = new Map();
export function fetchFixStatus(path, fresh) {
  if (!path || path.indexOf('/MEDIA/') !== 0) return Promise.resolve(null);
  const c = statusCache.get(path);
  if (!fresh && c && Date.now() - c.t < 600000) return c.p;
  const p = fetch(HELPER_URL + '/status?path=' + encodeURIComponent(path), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  statusCache.set(path, { t: Date.now(), p });
  p.then((d) => { if (d && d.state === 'running') statusCache.delete(path); });
  return p;
}

// Poll the helper's /status for the details page "Audio fixed" line. Returns a stop function.
export function watchFixStatus(path, cb) {
  let stop = false, t = 0;
  async function tick() {
    if (stop) return;
    try {
      const d = await fetchFixStatus(path, true);
      if (d && !stop) cb(d);
    } catch (e) { /* keep last */ }
    if (!stop) t = setTimeout(tick, 4000);
  }
  tick();
  return () => { stop = true; clearTimeout(t); };
}

// ---- "audio fixed" badges on cards: a slow background queue that never competes with key presses ----
const known = store.cacheGet('fixed') || {}; // path -> 1 for files the helper reported as fixed
const queue = [];
let busy = false;
export function knownFixed(path) { return !!known[path]; }
export function queueFixBadge(path, cb) {
  if (!path || path.indexOf('/MEDIA/') !== 0) return;
  if (known[path]) { cb({ fixed: true }); return; }
  const c = statusCache.get(path);
  if (c && Date.now() - c.t < 600000) { c.p.then((d) => d && cb(d)); return; }
  queue.push([path, cb]);
  pump();
}
function pump() {
  if (busy || !queue.length) return;
  const idle = performance.now() - (metrics.lastKey || 0);
  if (idle < 700) { busy = true; setTimeout(() => { busy = false; pump(); }, 700 - idle + 50); return; }
  busy = true;
  const [path, cb] = queue.shift();
  fetchFixStatus(path).then((d) => {
    if (d && d.fixed && !known[path]) { known[path] = 1; store.cacheSet('fixed', known); }
    if (d) cb(d);
  }).finally(() => { setTimeout(() => { busy = false; pump(); }, 120); });
}
