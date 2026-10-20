// "Who's watching?" profile picker: Jellyfin public users + logins remembered on this TV.
import { el } from '../util.js';
import { app } from '../app.js';
import { store } from '../store.js';
import { login, publicUsers, userImg, S } from '../api.js';
import { askText } from './textentry.js';
import { dialog, alertBox, toast } from '../ui/dialog.js';
import { ICON } from '../icons.js';

export function profilesScreen(host, signIn, exitPrompt) {
  const root = el('div', 'screen profiles', host);
  el('div', 'pr-title', root, "Who's watching?");
  const row = el('div', 'pr-row', root);
  const foot = el('div', 'pr-foot', root);
  let tiles = [], i = 0, busy = false;

  async function render() {
    const server = store.server;
    foot.textContent = 'Server: ' + server;
    const users = [];
    const seen = {};
    for (const id in store.logins) {
      const l = store.logins[id];
      if ((l.server || server) !== server) continue;
      users.push({ Id: l.Id, Name: l.Name, img: l.img, saved: true, server }); seen[l.Id] = 1;
    }
    let pub = [];
    try { pub = await publicUsers(server); } catch (e) { toast('Server not reachable: ' + server); }
    for (const u of pub) {
      if (seen[u.Id]) continue;
      users.push({ Id: u.Id, Name: u.Name, img: u.PrimaryImageTag || '', HasPassword: u.HasPassword, server });
    }
    row.textContent = '';
    tiles = users.map((u) => tile(u.Name, userImg(u, 220), u));
    tiles.push(tile('Add profile', '', { add: true }, ICON.list));
    tiles.push(tile('Change server', '', { server: true }, ICON.shows));
    const last = tiles.findIndex((t) => t._u.Id && t._u.Id === store.last);
    i = last >= 0 ? last : 0;
    paint();
  }

  function tile(name, src, u, icon) {
    const t = el('div', 'pr-tile', row);
    const a = el('div', 'pr-av', t);
    if (src) { const im = el('img', '', a); im.src = src; im.alt = ''; } else if (icon) a.innerHTML = icon;
    else { a.textContent = name.slice(0, 1).toUpperCase(); a.style.background = color(name); }
    el('div', 'pr-name', t, name);
    t._u = u;
    return t;
  }

  function paint() { tiles.forEach((t, j) => t.classList.toggle('f', j === i)); }

  async function pick(u) {
    if (busy) return;
    busy = true;
    try {
      if (u.add) {
        const name = await askText({ title: 'Profile name', hint: 'Jellyfin user name' });
        if (!name) return;
        const pw = await askText({ title: 'Password for ' + name, secret: true, placeholder: '(leave empty if none)' });
        if (pw === null) return;
        await signIn(await login(store.server, name, pw));
        return;
      }
      if (u.saved) { await signIn(store.logins[u.Id]); return; }
      let pw = '';
      if (u.HasPassword) {
        pw = await askText({ title: 'Password for ' + u.Name, secret: true });
        if (pw === null) return;
      }
      await signIn(await login(store.server, u.Name, pw));
    } catch (e) {
      await alertBox(e.message || String(e), 'Could not sign in');
    } finally { busy = false; }
  }

  async function changeServer() {
    const v = await askText({ title: 'Jellyfin server address', value: store.server });
    if (!v) return;
    store.server = /^https?:\/\//.test(v) ? v : 'http://' + v;
    render();
  }

  return {
    el: root,
    show() { root.classList.add('on'); render(); },
    hide() { root.classList.remove('on'); },
    resume() { paint(); },
    key(k) {
      if (k === 'left' && i > 0) { i--; paint(); } else if (k === 'right' && i < tiles.length - 1) { i++; paint(); } else if (k === 'ok') {
        const u = tiles[i] && tiles[i]._u;
        if (!u) return true;
        if (u.server === true) changeServer();
        else if (u.Id && store.logins[u.Id] && !u.saved) pick(Object.assign({}, u, { saved: true }));
        else pick(u);
      } else if (k === 'red' || k === 'blue') {
        const u = tiles[i] && tiles[i]._u;
        if (u && u.saved) {
          dialog({ title: 'Forget ' + u.Name + ' on this TV?', buttons: [{ label: 'Forget', value: 1 }, { label: 'Cancel', value: 0 }], focus: 1 })
            .then((v) => { if (v) { store.forget(u.Id); render(); } });
        }
      } else if (k === 'back') {
        if (S.token) app.go('home'); else exitPrompt();
      }
      return true;
    },
  };
}

function color(s) {
  let h = 0;
  for (let j = 0; j < s.length; j++) h = (h * 31 + s.charCodeAt(j)) % 360;
  return 'hsl(' + h + ',45%,38%)';
}
