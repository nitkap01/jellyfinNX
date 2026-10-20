// Desktop check of the built UI (dist/) in headless Chromium at 1920x1080 against the real server.
// Signs in with ~/.secrets/jellyfin_admin.txt (never printed), presses keys, saves screenshots.
//   node test/desktop-shots.mjs <outDir> 'step1;step2;...'
// steps: keys:Right*3,Down | shot:name | wait:ms | eval:js
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire('/tmp/claude-1000/node_modules/');
const { chromium } = require('playwright-core');

const [, , outDir = '/tmp/claude-1000/jf/shots', steps = 'wait:2500;shot:home'] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const sec = Object.fromEntries(fs.readFileSync(process.env.HOME + '/.secrets/jellyfin_admin.txt', 'utf8').split('\n').filter(Boolean)
  .map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const exe = fs.readdirSync(process.env.HOME + '/.cache/ms-playwright').filter((d) => d.startsWith('chromium-'))[0];
const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/' + exe + '/chrome-linux64/chrome', args: ['--disable-web-security', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
const url = 'file://' + path.resolve(path.dirname(new URL(import.meta.url).pathname), '../dist/index.html');
await page.goto(url);
// sign in once (stored in localStorage like on the TV)
const signed = await page.evaluate(() => !!localStorage.getItem('jflix.v1') && JSON.parse(localStorage.getItem('jflix.v1')).last);
if (!signed) {
  await page.evaluate(async ([server, u, p]) => {
    const r = await fetch(server + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="JellyfinFlix", Device="Desktop test", DeviceId="jflix-desktop", Version="0.1.0"' }, body: JSON.stringify({ Username: u, Pw: p }) });
    const j = await r.json();
    const d = { server, deviceId: 'jflix-desktop', logins: {}, last: j.User.Id };
    d.logins[j.User.Id] = { Id: j.User.Id, Name: j.User.Name, token: j.AccessToken, server, admin: !!j.User.Policy.IsAdministrator, img: j.User.PrimaryImageTag || '' };
    localStorage.setItem('jflix.v1', JSON.stringify(d));
  }, [sec.server, sec.user, sec.pass]);
  await page.reload();
}
const KEY = { Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Enter: 'Enter', Back: 'Escape' };
for (const st of steps.split(';').filter(Boolean)) {
  const i = st.indexOf(':');
  const k = st.slice(0, i), v = st.slice(i + 1);
  if (k === 'wait') await page.waitForTimeout(+v);
  else if (k === 'shot') await page.screenshot({ path: path.join(outDir, v + '.png') });
  else if (k === 'eval') console.log(JSON.stringify(await page.evaluate(v)));
  else if (k === 'keys') {
    for (const part of v.split(',')) {
      const [n, c] = part.split('*');
      for (let j = 0; j < (+c || 1); j++) { await page.keyboard.press(KEY[n] || n); await page.waitForTimeout(250); }
    }
  }
}
if (errors.length) console.log(errors.slice(0, 20).join('\n'));
await browser.close();
