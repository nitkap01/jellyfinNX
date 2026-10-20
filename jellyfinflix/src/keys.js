// Remote control keys → short names.
const MAP = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 10009: 'back', 27: 'back', 8: 'back',
  415: 'play', 19: 'pause', 10252: 'playpause', 413: 'stop', 417: 'ff', 412: 'rw', 10233: 'next', 10232: 'prev',
  403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 457: 'info',
};

export function keyName(e) { return MAP[e.keyCode] || null; }

// Held-key detection that works with the real Samsung remote: it repeats plain keydowns (no e.repeat flag) and
// may send a keyup between repeats. A press counts as held when it comes before its keyup, or within 150 ms of
// the last press of the same key (faster than any human double tap).
const H = { code: 0, down: false, last: 0 };
export function noteKeyDown(e) {
  const now = Date.now();
  const held = !!e.repeat || (H.code === e.keyCode && (H.down || now - H.last < 150));
  H.code = e.keyCode; H.down = true; H.last = now;
  return held;
}
export function noteKeyUp(e) { if (e.keyCode === H.code) H.down = false; }

export function registerTvKeys() {
  const t = window.tizen && window.tizen.tvinputdevice;
  if (!t) return;
  const want = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
    'MediaTrackNext', 'MediaTrackPrevious', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info'];
  try {
    if (t.registerKeyBatch) { t.registerKeyBatch(want); return; }
  } catch (e) { /* fall back to one by one */ }
  for (const k of want) { try { t.registerKey(k); } catch (e) { /* key not on this remote */ } }
}
