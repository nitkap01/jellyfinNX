// Tiny CDP driver for the TV page (Chrome 76).
//   node cdp.mjs <ws> eval '<js expression, may return a promise>'
//   node cdp.mjs <ws> evalfile <file.js>
//   node cdp.mjs <ws> keys 'Right*5,Down,Enter' [gapMs]
//   node cdp.mjs <ws> shot <out.png>
//   node cdp.mjs <ws> reload [waitMs]      (reload, print console errors seen)
//   node cdp.mjs <ws> console [secs]       (print console messages / exceptions for N seconds)
import fs from 'fs';
const [, , ws, cmd, arg, arg2] = process.argv;
const sock = new WebSocket(ws);
let id = 0; const pend = new Map(); const logs = [];
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const KEYS = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 10009, Esc: 27, Play: 415, Pause: 19, PlayPause: 10252, Stop: 413, FF: 417, RW: 412 };
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function press(name, hold) {
  const code = KEYS[name] || +name;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  if (hold) await sleep(hold);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}
sock.onopen = async () => {
  if (cmd === 'console') await send('Runtime.enable');
  let out;
  if (cmd === 'eval' || cmd === 'evalfile') {
    const code = cmd === 'eval' ? arg : fs.readFileSync(arg, 'utf8');
    const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, timeout: 120000 });
    out = r.exceptionDetails ? { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text } : r.result?.value;
  } else if (cmd === 'keys') {
    const gap = +(arg2 || 350);
    for (const part of arg.split(',')) {
      const [name, n] = part.split('*');
      for (let i = 0; i < (+n || 1); i++) { await press(name.trim()); await sleep(gap); }
    }
    out = 'ok';
  } else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.data) { fs.writeFileSync(arg, Buffer.from(r.data, 'base64')); out = 'saved ' + arg; } else out = r;
  } else if (cmd === 'reload') {
    await send('Page.reload', { ignoreCache: false });
    await sleep(+(arg || 6000));
    out = 'reloaded';
  } else if (cmd === 'console') {
    await sleep(+(arg || 5) * 1000);
    out = 'done';
  }
  if (logs.length) console.log(logs.join('\n'));
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  sock.close(); process.exit(0);
};
