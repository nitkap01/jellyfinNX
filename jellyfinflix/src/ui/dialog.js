// Modal dialog (exit prompt, confirmations, messages) and toasts.
import { el } from '../util.js';
import { app } from '../app.js';

let host;
export function initDialogs(h) { host = h; }

export function dialog(o) {
  // o: { title, text, buttons: [{ label, value }], focus }
  return new Promise((resolve) => {
    const box = el('div', 'layer dlg', host);
    const card = el('div', 'dlg-card', box);
    if (o.title) el('div', 'dlg-title', card, o.title);
    if (o.text) el('div', 'dlg-text', card, o.text);
    const row = el('div', 'dlg-btns', card);
    const btns = (o.buttons || [{ label: 'OK', value: true }]).map((b) => el('div', 'btn', row, b.label));
    let i = o.focus || 0;
    const f = () => btns.forEach((b, j) => b.classList.toggle('f', j === i));
    f();
    const layer = {
      overlay: true,
      key(k) {
        if (k === 'left' && i > 0) { i--; f(); } else if (k === 'right' && i < btns.length - 1) { i++; f(); } else if (k === 'ok') { done(o.buttons ? o.buttons[i].value : true); } else if (k === 'back') { done(null); }
        return true;
      },
      hide() { box.remove(); },
    };
    function done(v) { app.pop(layer); resolve(v); }
    requestAnimationFrame(() => box.classList.add('on'));
    app.push(layer);
  });
}

export const alertBox = (text, title) => dialog({ title, text, buttons: [{ label: 'OK', value: true }] });

let toastEl, toastT;
export function toast(text, ms) {
  if (!toastEl) toastEl = el('div', 'toast', host);
  toastEl.textContent = text;
  toastEl.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('on'), ms || 3500);
}
