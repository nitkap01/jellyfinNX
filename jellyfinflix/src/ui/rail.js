// Left navigation rail: icons when collapsed, labels slide in when it has focus.
import { el } from '../util.js';
import { app } from '../app.js';
import { ICON } from '../icons.js';
import { S, userImg } from '../api.js';

const ITEMS = [
  { id: 'profiles', label: 'Profile', icon: 'user' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'shows', label: 'Shows', icon: 'shows' },
  { id: 'movies', label: 'Movies', icon: 'movies' },
  { id: 'mylist', label: 'My List', icon: 'list' },
];

let root, els = [], i = 2, nameEl, avatar;

export function initRail(host) {
  root = el('div', 'rail', host);
  el('div', 'rail-panel', root);
  const list = el('div', 'rail-list', root);
  els = ITEMS.map((it) => {
    const r = el('div', 'ri ri-' + it.id, list);
    const ic = el('span', 'ic', r); ic.innerHTML = ICON[it.icon];
    const lb = el('span', 'lb', r, it.label);
    if (it.id === 'profiles') { avatar = ic; nameEl = lb; }
    return r;
  });
  app.on('screen', (name) => {
    const j = ITEMS.findIndex((x) => x.id === name);
    els.forEach((e, k) => e.classList.toggle('cur', k === j));
    root.classList.toggle('hidden', name === 'profiles');
  });
}

export function railUser() {
  if (!nameEl) return;
  nameEl.textContent = S.name || 'Profile';
  const u = userImg({ Id: S.userId, img: S.img, server: S.server }, 64);
  avatar.innerHTML = u ? '<img src="' + u + '" alt="">' : '<b>' + (S.name || '?').slice(0, 1).toUpperCase() + '</b>';
}

const layer = {
  overlay: true,
  key(k) {
    if (k === 'up') { if (i > 0) i--; paint(); return true; }
    if (k === 'down') { if (i < ITEMS.length - 1) i++; paint(); return true; }
    if (k === 'right' || k === 'back') { app.pop(layer); return true; }
    if (k === 'ok') {
      const id = ITEMS[i].id;
      app.pop(layer);
      app.go(id);
      return true;
    }
    return true;
  },
  show() { root.classList.add('open'); paint(); },
  hide() { root.classList.remove('open'); els.forEach((e) => e.classList.remove('f')); },
};

function paint() { els.forEach((e, k) => e.classList.toggle('f', k === i)); }

export function openRail(screenId) {
  const j = ITEMS.findIndex((x) => x.id === screenId);
  i = j >= 0 ? j : 2;
  app.push(layer);
}
