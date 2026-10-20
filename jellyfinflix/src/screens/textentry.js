// Full-screen text entry (password, user name, server address) with the on-screen keyboard.
import { el } from '../util.js';
import { app } from '../app.js';
import { Keyboard } from '../ui/keyboard.js';

let host;
export function initTextEntry(h) { host = h; }

export function askText(o) {
  // o: { title, hint, value, secret }
  return new Promise((resolve) => {
    const box = el('div', 'layer te', host);
    el('div', 'te-title', box, o.title || '');
    if (o.hint) el('div', 'te-hint', box, o.hint);
    const field = el('div', 'te-field', box);
    const show = (t) => { field.textContent = o.secret ? t.replace(/./g, '•') : t; field.classList.toggle('empty', !t); if (!t) field.textContent = o.placeholder || ''; };
    const kb = new Keyboard(box, { full: true, value: o.value || '', onChange: show, onDone: (t) => done(t) });
    show(kb.text);
    kb.focus();
    const layer = {
      overlay: true,
      key(k) {
        if (k === 'back') { done(null); return true; }
        return kb.key(k);
      },
      hide() { box.remove(); },
    };
    function done(v) { app.pop(layer); resolve(v); }
    app.push(layer);
  });
}
