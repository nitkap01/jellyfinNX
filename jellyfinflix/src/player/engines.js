// Playback engines with one small interface: Samsung AVPlay (primary) and HTML5 <video> (fallback / desktop testing).
import { log, warn, error } from '../log.js';
let webapisPromise = null;

// webapis.js is only needed for playback; load it after the UI is up so launch stays fast.
export function loadWebapis() {
  if (window.webapis && window.webapis.avplay) return Promise.resolve(true);
  if (!window.tizen) return Promise.resolve(false);
  if (!webapisPromise) {
    webapisPromise = new Promise((res) => {
      const s = document.createElement('script');
      s.src = '$WEBAPIS/webapis/webapis.js';
      s.onload = () => res(!!(window.webapis && window.webapis.avplay));
      s.onerror = () => res(false);
      document.head.appendChild(s);
    });
  }
  return webapisPromise;
}

export function avplayEngine(host) {
  const av = window.webapis.avplay;
  let obj = host.querySelector('object');
  if (!obj) {
    obj = document.createElement('object');
    obj.type = 'application/avplayer';
    obj.className = 'avp';
    host.insertBefore(obj, host.firstChild);
  }
  let cb = {};
  return {
    name: 'avplay',
    open(url, callbacks) {
      cb = callbacks;
      try { av.stop(); } catch (e) { /* idle */ }
      try { av.close(); } catch (e) { /* idle */ }
      log('avplay open', { hls: url.indexOf('.m3u8') > 0 });
      av.open(url);
      av.setDisplayRect(0, 0, 1920, 1080);
      // Start as soon as ~1 s is buffered (default is more), both at start and after a seek.
      try {
        av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', 1);
        av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', 1);
      } catch (e) { /* not supported on this firmware */ }
      try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) { /* older firmware */ }
      av.setListener({
        onbufferingstart: () => { log('avplay buffering'); if (cb.onBuffering) cb.onBuffering(true); },
        onbufferingprogress: () => {},
        onbufferingcomplete: () => { if (window.__jf) window.__jf.marks.bufDone = Math.round(performance.now()); if (cb.onBuffering) cb.onBuffering(false); },
        oncurrentplaytime: (ms) => cb.onTime && cb.onTime(ms),
        onstreamcompleted: () => { log('avplay stream completed'); if (cb.onEnd) cb.onEnd(); },
        onerror: (e) => { error('avplay onerror', String(e)); if (cb.onError) cb.onError(String(e)); },
        onevent: (type, data) => log('avplay event', { type, data }),
        onsubtitlechange: (dur, text) => cb.onSubtitle && cb.onSubtitle(text, dur),
        ondrmevent: () => {},
      });
      return new Promise((res, rej) => av.prepareAsync(res, (e) => { error('avplay prepare failed', (e && e.name) || String(e)); rej(new Error('AVPlay could not open the stream (' + (e && e.name || e) + ')')); }));
    },
    play() { try { av.play(); } catch (e) { /* state */ } },
    pause() { try { av.pause(); } catch (e) { /* state */ } },
    seek(ms) { return new Promise((res) => { try { av.seekTo(Math.max(0, Math.floor(ms)), res, res); } catch (e) { res(); } }); },
    time() { try { return av.getCurrentTime(); } catch (e) { return 0; } },
    duration() { try { return av.getDuration(); } catch (e) { return 0; } },
    paused() { try { return av.getState() === 'PAUSED'; } catch (e) { return false; } },
    tracks() { try { return av.getTotalTrackInfo() || []; } catch (e) { return []; } },
    select(type, index) { try { av.setSelectTrack(type, index); return true; } catch (e) { warn('avplay setSelectTrack failed', { type, index, e: (e && e.name) || String(e), state: (() => { try { return av.getState(); } catch (x) { return '?'; } })() }); return false; } },
    silentSubs(on) { try { av.setSilentSubtitle(on); } catch (e) { /* none */ } },
    zoom(mode) { try { av.setDisplayMethod(mode); return true; } catch (e) { return false; } },
    speed(x) { try { av.setSpeed(x); return true; } catch (e) { return false; } },
    subDelay(ms) { try { av.setSubtitlePosition(ms); return true; } catch (e) { return false; } },
    stop() { try { av.stop(); } catch (e) { /* idle */ } try { av.close(); } catch (e) { /* idle */ } },
  };
}

export function html5Engine(host) {
  let v = host.querySelector('video');
  if (!v) { v = document.createElement('video'); v.className = 'h5v'; host.insertBefore(v, host.firstChild); }
  let cb = {};
  const on = (n, f) => v.addEventListener(n, f);
  on('timeupdate', () => cb.onTime && cb.onTime(v.currentTime * 1000));
  on('waiting', () => cb.onBuffering && cb.onBuffering(true));
  on('playing', () => cb.onBuffering && cb.onBuffering(false));
  on('ended', () => cb.onEnd && cb.onEnd());
  on('error', () => cb.onError && cb.onError('video error ' + (v.error && v.error.code)));
  return {
    name: 'html5',
    open(url, callbacks) {
      cb = callbacks;
      v.src = url;
      return new Promise((res, rej) => {
        const ok = () => { v.removeEventListener('loadedmetadata', ok); res(); };
        v.addEventListener('loadedmetadata', ok);
        v.addEventListener('error', () => rej(new Error('This video cannot be played here')), { once: true });
        v.load();
      });
    },
    play() { const p = v.play(); if (p && p.catch) p.catch(() => {}); },
    pause() { v.pause(); },
    seek(ms) { v.currentTime = ms / 1000; return Promise.resolve(); },
    time() { return v.currentTime * 1000; },
    duration() { return (v.duration || 0) * 1000; },
    paused() { return v.paused; },
    tracks() { return []; },
    select() { return false; },
    silentSubs() {},
    zoom() { return false; },
    speed(x) { v.playbackRate = x; return true; },
    stop() { v.pause(); v.removeAttribute('src'); try { v.load(); } catch (e) { /* none */ } },
  };
}
