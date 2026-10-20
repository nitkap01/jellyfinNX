// JellyfinFlix boot: show the shell at once, jump straight to Home when a profile is remembered.
import { mark } from './util.js';
import { app } from './app.js';
import { store } from './store.js';
import { S, useLogin, get, setAuthLost, slim } from './api.js';
import { registerTvKeys } from './keys.js';
import { initBg } from './ui/bg.js';
import { initRail, railUser } from './ui/rail.js';
import { initDialogs, dialog, toast } from './ui/dialog.js';
import { initTextEntry } from './screens/textentry.js';
import { initDetails, openDetails } from './screens/details.js';
import { initPlayer, playerState } from './player/player.js';
import { loadWebapis } from './player/engines.js';
import { profilesScreen } from './screens/profiles.js';
import { browseScreen } from './screens/browse.js';
import { searchScreen } from './screens/search.js';
import { homeDefs, moviesDefs, showsDefs, myListDefs } from './data.js';

mark('jsStart');
const $ = (id) => document.getElementById(id);
const screensHost = $('screens');
initBg($('bgh'));
initRail($('railh'));
initDialogs($('dlg'));
initTextEntry($('ov'));
initDetails($('ov'));
initPlayer($('pl'));

const USER_SCREENS = ['home', 'shows', 'movies', 'mylist', 'search'];
app.register('profiles', () => profilesScreen(screensHost, signIn, exitPrompt));
app.register('home', () => browseScreen(screensHost, { name: 'home', hero: true, defs: homeDefs, exitPrompt }));
app.register('shows', () => browseScreen(screensHost, { name: 'shows', hero: true, defs: showsDefs, exitPrompt }));
app.register('movies', () => browseScreen(screensHost, { name: 'movies', hero: true, defs: moviesDefs, exitPrompt }));
app.register('mylist', () => browseScreen(screensHost, { name: 'mylist', title: 'My List', defs: myListDefs, exitPrompt }));
app.register('search', () => searchScreen(screensHost));
app.on('screen', (n) => { document.body.setAttribute('data-screen', n); });

async function signIn(login) {
  store.remember(login);
  useLogin(login);
  for (const n of USER_SCREENS) app.drop(n);
  railUser();
  app.go('home');
}

let exiting = false;
function exitPrompt() {
  if (exiting) return;
  exiting = true;
  dialog({ title: 'Exit JellyfinFlix?', buttons: [{ label: 'Exit', value: 1 }, { label: 'Cancel', value: 0 }], focus: 1 }).then((v) => {
    exiting = false;
    if (!v) return;
    try { window.tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
  });
}

let lost = false;
setAuthLost(() => {
  if (lost) return;
  lost = true;
  if (S.userId) store.forget(S.userId);
  S.token = '';
  toast('Please sign in again.');
  app.go('profiles');
  setTimeout(() => { lost = false; }, 3000);
});

const last = store.last && store.logins[store.last];
if (last) {
  useLogin(last);
  railUser();
  app.go('home');
  setTimeout(() => get('/Users/Me', {}, 0).then((u) => {
    // keep admin flag and avatar fresh
    const l = store.logins[u.Id];
    if (l) { l.admin = !!(u.Policy && u.Policy.IsAdministrator); l.img = u.PrimaryImageTag || ''; store.remember(l); S.admin = l.admin; }
  }).catch(() => {}), 3000);
} else {
  app.go('profiles');
}
mark('shell');
// Test hooks (used by the CDP scripts in test/): reset to Home top.
window.__jfApp = app;
window.__jfOpen = (id) => get('/Users/{U}/Items/' + id, {}, 0).then((it) => { openDetails(slim(it)); return it.Name; });
window.__jfPlayer = playerState;
window.__jfReset = () => { app.go('home'); const s = app.screen('home'); if (s.reenter) s.reenter(); return app.currentName; };
requestAnimationFrame(() => setTimeout(() => {
  registerTvKeys();
  setTimeout(loadWebapis, 2500);
}, 0));
