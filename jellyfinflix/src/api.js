// Jellyfin API: tiny fetch wrapper with an in-memory cache and image URL helpers.
// GETs carry the token as api_key in the query, so they are "simple" requests (no CORS preflight).
import { store } from './store.js';
import { warn } from './log.js';

export const VERSION = '0.1.1';
export const S = { server: '', userId: '', token: '', name: '', admin: false, img: '' };
export let onAuthLost = () => {};
export function setAuthLost(fn) { onAuthLost = fn; }

export const COMMON = { Fields: 'Overview,Path', EnableImageTypes: 'Primary,Backdrop,Thumb,Logo', ImageTypeLimit: 1, EnableTotalRecordCount: false };

export function authHeader(token) {
  let h = 'MediaBrowser Client="JellyfinFlix", Device="Samsung TV", DeviceId="' + store.deviceId + '", Version="' + VERSION + '"';
  if (token) h += ', Token="' + token + '"';
  return h;
}

export function qs(p) {
  const a = [];
  for (const k in p) {
    const v = p[k];
    if (v !== undefined && v !== null && v !== '') a.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return a.join('&');
}

export function useLogin(l) {
  S.server = l.server || store.server; S.userId = l.Id; S.token = l.token; S.name = l.Name; S.admin = !!l.admin; S.img = l.img || '';
  mem.clear();
}

export function apiUrl(path, params) {
  const p = Object.assign({}, params || {});
  for (const k in p) if (p[k] === '{U}') p[k] = S.userId;
  if (S.token) p.api_key = S.token;
  return S.server + path.replace('{U}', S.userId) + '?' + qs(p);
}

const mem = new Map(); // url -> { t, p }

export function get(path, params, ttl) {
  const u = apiUrl(path, params);
  const c = mem.get(u);
  if (c && Date.now() - c.t < (ttl == null ? 120000 : ttl)) return c.p;
  const p = fetch(u).then((r) => {
    if (r.status === 401) { warn('api 401 (signed out)', path); onAuthLost(); throw new Error('Signed out'); }
    if (!r.ok) { warn('api GET failed', { path, status: r.status }); throw new Error('HTTP ' + r.status); }
    return r.json();
  });
  mem.set(u, { t: Date.now(), p });
  p.catch(() => mem.delete(u));
  return p;
}

// Drop cached responses whose URL contains any of the given fragments.
export function invalidate(...parts) {
  for (const k of Array.from(mem.keys())) if (parts.some((p) => k.indexOf(p) >= 0)) mem.delete(k);
}

export async function send(method, path, body, params) {
  const r = await fetch(apiUrl(path, params), {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': authHeader(S.token) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { warn('api 401 (signed out)', path); onAuthLost(); throw new Error('Signed out'); }
  if (!r.ok) { warn('api ' + method + ' failed', { path, status: r.status }); throw new Error('HTTP ' + r.status); }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

export async function login(server, username, pw) {
  const r = await fetch(server + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': authHeader() },
    body: JSON.stringify({ Username: username, Pw: pw || '' }),
  });
  if (r.status === 401) throw new Error('Wrong password');
  if (!r.ok) throw new Error('Sign-in failed (HTTP ' + r.status + ')');
  const j = await r.json();
  return {
    Id: j.User.Id, Name: j.User.Name, token: j.AccessToken, server,
    admin: !!(j.User.Policy && j.User.Policy.IsAdministrator), img: j.User.PrimaryImageTag || '',
  };
}

export async function publicUsers(server) {
  const r = await fetch(server + '/Users/Public');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---- images ----
export function img(id, type, tag, w, h, q) {
  if (!id || !tag) return '';
  return S.server + '/Items/' + id + '/Images/' + type + '?fillWidth=' + w + (h ? '&fillHeight=' + h : '') + '&quality=' + (q || 80) + '&tag=' + tag;
}

// Landscape card art. Returns [url, hasTitleInArt].
export function cardImg(it, w, h) {
  const T = it.ImageTags || {};
  if (it.Type === 'Episode' && T.Primary) return [img(it.Id, 'Primary', T.Primary, w, h), false];
  if (T.Thumb) return [img(it.Id, 'Thumb', T.Thumb, w, h), true];
  if (it.ParentThumbItemId && it.ParentThumbImageTag && it.Type === 'Episode') return [img(it.ParentThumbItemId, 'Thumb', it.ParentThumbImageTag, w, h), true];
  if (it.BackdropImageTags && it.BackdropImageTags[0]) return [img(it.Id, 'Backdrop', it.BackdropImageTags[0], w, h), false];
  if (it.ParentBackdropItemId && it.ParentBackdropImageTags && it.ParentBackdropImageTags[0]) return [img(it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags[0], w, h), false];
  if (T.Primary) return [img(it.Id, 'Primary', T.Primary, w, h), false];
  return ['', false];
}

// Portrait poster art. Returns [url, hasTitleInArt].
export function posterImg(it, w, h) {
  const T = it.ImageTags || {};
  if (it.Type === 'Episode' && it.SeriesId && it.SeriesPrimaryImageTag) return [img(it.SeriesId, 'Primary', it.SeriesPrimaryImageTag, w, h), true];
  if (T.Primary) return [img(it.Id, 'Primary', T.Primary, w, h), true];
  return cardImg(it, w, h);
}

export function backdropImg(it, w) {
  if (it.BackdropImageTags && it.BackdropImageTags[0]) return img(it.Id, 'Backdrop', it.BackdropImageTags[0], w, 0, 70);
  if (it.ParentBackdropItemId && it.ParentBackdropImageTags && it.ParentBackdropImageTags[0]) return img(it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags[0], w, 0, 70);
  const T = it.ImageTags || {};
  if (T.Thumb) return img(it.Id, 'Thumb', T.Thumb, w, 0, 70);
  if (it.Type === 'Episode' && T.Primary) return img(it.Id, 'Primary', T.Primary, w, 0, 70);
  return '';
}

export function logoImg(it) {
  const T = it.ImageTags || {};
  let id = '', tag = '';
  if (T.Logo) { id = it.Id; tag = T.Logo; } else if (it.ParentLogoItemId && it.ParentLogoImageTag) { id = it.ParentLogoItemId; tag = it.ParentLogoImageTag; }
  if (!id) return '';
  return S.server + '/Items/' + id + '/Images/Logo?maxWidth=640&maxHeight=240&quality=90&tag=' + tag;
}

export function userImg(u, size) {
  if (!u.img) return '';
  return (u.server || S.server || store.server) + '/Users/' + u.Id + '/Images/Primary?fillWidth=' + size + '&fillHeight=' + size + '&quality=85&tag=' + u.img;
}

// Keep only the fields the UI uses, so cached rows stay small.
export function slim(it) {
  const o = { Id: it.Id, Name: it.Name, Type: it.Type };
  const keys = ['SeriesId', 'SeriesName', 'SeasonId', 'ParentIndexNumber', 'IndexNumber', 'ProductionYear', 'OfficialRating',
    'CommunityRating', 'RunTimeTicks', 'ParentBackdropItemId', 'ParentThumbItemId', 'ParentThumbImageTag', 'ParentLogoItemId',
    'ParentLogoImageTag', 'SeriesPrimaryImageTag', 'MediaType', 'ChildCount'];
  for (const k of keys) if (it[k] != null) o[k] = it[k];
  if (it.Path && (it.Type === 'Movie' || it.Type === 'Episode')) o.Path = it.Path;
  if (it.Overview) o.Overview = it.Overview.length > 400 ? it.Overview.slice(0, 400) + '…' : it.Overview;
  if (it.ImageTags) { o.ImageTags = {}; for (const k of ['Primary', 'Thumb', 'Logo']) if (it.ImageTags[k]) o.ImageTags[k] = it.ImageTags[k]; }
  if (it.BackdropImageTags && it.BackdropImageTags[0]) o.BackdropImageTags = [it.BackdropImageTags[0]];
  if (it.ParentBackdropImageTags && it.ParentBackdropImageTags[0]) o.ParentBackdropImageTags = [it.ParentBackdropImageTags[0]];
  const u = it.UserData;
  if (u) o.UserData = { PlaybackPositionTicks: u.PlaybackPositionTicks || 0, PlayedPercentage: u.PlayedPercentage || 0, IsFavorite: !!u.IsFavorite, Played: !!u.Played, UnplayedItemCount: u.UnplayedItemCount };
  return o;
}
