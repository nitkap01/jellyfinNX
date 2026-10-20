// Everything JellyfinFlix remembers on the TV (localStorage). Never throws.
export const DEFAULT_SERVER = 'http://192.168.0.154:8097';
const KEY = 'jflix.v1';

function read(k, def) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; }
}
function write(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ }
}

const data = read(KEY, {});
if (!data.server) data.server = DEFAULT_SERVER;
if (!data.deviceId) data.deviceId = 'jflix-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
if (!data.logins) data.logins = {}; // userId -> { Id, Name, token, admin, img, server }

export const store = {
  get server() { return data.server; },
  set server(v) { data.server = v.replace(/\/+$/, ''); save(); },
  get deviceId() { return data.deviceId; },
  get logins() { return data.logins; },
  get last() { return data.last; },
  set last(id) { data.last = id; save(); },
  remember(login) { data.logins[login.Id] = login; data.last = login.Id; save(); },
  forget(id) { delete data.logins[id]; if (data.last === id) data.last = null; save(); },
  // Viewer preferences (subtitle style, zoom, autoplay).
  get prefs() { return data.prefs || (data.prefs = {}); },
  setPref(k, v) { (data.prefs || (data.prefs = {}))[k] = v; save(); },
  // Cached screen data (rows) so the next launch can paint instantly.
  cacheGet(name) { return read('jflix.c.' + name, null); },
  cacheSet(name, v) { write('jflix.c.' + name, v); },
};

function save() { write(KEY, data); }
