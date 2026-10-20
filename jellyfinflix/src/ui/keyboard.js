// On-screen keyboard (letter grid) for search, passwords and the server address.
import { el } from '../util.js';

const LAYOUTS = {
  abc: ['abcdef', 'ghijkl', 'mnopqr', 'stuvwx', 'yz1234', '567890'],
  ABC: ['ABCDEF', 'GHIJKL', 'MNOPQR', 'STUVWX', 'YZ1234', '567890'],
  sym: ['.:/-_@', '!#$%&*', '()+=?,', ';\'"<>[', ']{}|\\~', '^`€£ 0'],
};

export class Keyboard {
  // o: { full: bool, onChange(text), onDone(text), onExitRight, onExitLeft, value }
  constructor(host, o) {
    this.o = o;
    this.text = o.value || '';
    this.layout = 'abc';
    this.el = el('div', 'kb' + (o.full ? ' kb-full' : ''), host);
    this.grid = el('div', 'kb-grid', this.el);
    this.special = o.full
      ? [{ k: 'shift', l: 'aA' }, { k: 'sym', l: '#+=' }, { k: ' ', l: 'Space' }, { k: 'del', l: '⌫' }, { k: 'done', l: 'Done' }]
      : [{ k: ' ', l: 'Space' }, { k: 'del', l: '⌫' }, { k: 'clear', l: 'Clear' }];
    this.r = 0; this.c = 0;
    this.render();
  }

  render() {
    this.grid.textContent = '';
    this.keys = LAYOUTS[this.layout].map((row) => row.split('').map((ch) => {
      const k = el('div', 'kk', this.grid, ch);
      k._ch = ch;
      return k;
    }));
    const sp = el('div', 'kb-sp', this.grid);
    this.keys.push(this.special.map((s) => { const k = el('div', 'kk ks', sp, s.l); k._ch = s.k; return k; }));
    this.paint();
  }

  paint() {
    if (this.fk) this.fk.classList.remove('f');
    if (!this.active) return;
    this.fk = this.keys[this.r][this.c];
    this.fk.classList.add('f');
  }

  focus() { this.active = true; this.paint(); }
  blur() { this.active = false; this.paint(); }

  key(k) {
    const rows = this.keys;
    if (k === 'left') { if (this.c > 0) this.c--; else if (this.o.onExitLeft) { this.o.onExitLeft(); return true; } }
    else if (k === 'right') { if (this.c < rows[this.r].length - 1) this.c++; else if (this.o.onExitRight) { this.o.onExitRight(); return true; } }
    else if (k === 'up' && this.r > 0) { const w = rows[this.r].length; this.r--; this.c = Math.min(rows[this.r].length - 1, Math.round(this.c * rows[this.r].length / w)); }
    else if (k === 'down' && this.r < rows.length - 1) { const w = rows[this.r].length; this.r++; this.c = Math.min(rows[this.r].length - 1, Math.floor(this.c * rows[this.r].length / w)); }
    else if (k === 'ok') { this.press(rows[this.r][this.c]._ch); return true; }
    else if (k === 'back') return false;
    this.paint();
    return true;
  }

  press(ch) {
    if (ch === 'del') this.text = this.text.slice(0, -1);
    else if (ch === 'clear') this.text = '';
    else if (ch === 'shift') { this.layout = this.layout === 'abc' ? 'ABC' : 'abc'; this.render(); return; }
    else if (ch === 'sym') { this.layout = this.layout === 'sym' ? 'abc' : 'sym'; this.render(); return; }
    else if (ch === 'done') { if (this.o.onDone) this.o.onDone(this.text); return; }
    else this.text += ch;
    if (this.o.onChange) this.o.onChange(this.text);
  }
}
