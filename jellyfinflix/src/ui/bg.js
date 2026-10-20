// Full-screen backdrop behind every screen: two images that cross-fade (opacity only).
import { el } from '../util.js';

let a, b, cur = '', front = null;

export function initBg(host) {
  const box = el('div', 'bg', host);
  a = el('img', 'bgi', box); b = el('img', 'bgi', box);
  a.alt = b.alt = '';
  el('div', 'bgshade', box);
  for (const im of [a, b]) im.onload = function () { if (this._want === cur) { this.classList.add('on'); const o = this === a ? b : a; o.classList.remove('on'); front = this; } };
}

export function setBg(url) {
  if (url === cur) return;
  cur = url;
  if (!url) { a.classList.remove('on'); b.classList.remove('on'); return; }
  const back = front === a ? b : a;
  back._want = url;
  if (back.src === url && back.complete) back.onload();
  else back.src = url;
}

export function bgUrl() { return cur; }
