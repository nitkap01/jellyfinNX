// Vertical list of horizontal rows, the core of every browse screen.
// Speed rules (measured on the TV): keep the number of elements/paint layers small.
//  - rows far from the focus are display:none ("off"),
//  - in scrolling rows only the cards near the focus exist (absolutely placed, created on demand),
//  - key presses only change classes and transforms.
import { el, progressPct, epLabel, fmtRuntime } from '../util.js';
import { cardImg, posterImg } from '../api.js';
import { ICON } from '../icons.js';
import { queueFixBadge } from '../mediafix.js';

export const KINDS = {
  card: { w: 330, h: 186, gap: 18, rowH: 300, scroll: 'stride' },
  poster: { w: 220, h: 330, gap: 18, rowH: 444, scroll: 'stride' },
  ep: { w: 420, h: 236, gap: 24, rowH: 400, scroll: 'stride', below: 90 },
  sgrid: { w: 240, h: 135, gap: 16, rowH: 168, scroll: false },
  grid: { w: 320, h: 180, gap: 18, rowH: 222, scroll: false },
  btn: { rowH: 104, scroll: false },
  pill: { rowH: 92, scroll: 'measure' },
};
const VIEW_W = 1720; // usable width right of the rail
const BEHIND = 2; // cards kept left of the focus
const AHEAD = 6; // extra cards kept right of the visible ones
const ROWS_BEFORE = 2, ROWS_AFTER = 3; // rows kept displayed around the focused row

export class Rows {
  // o: { target, offset(r,row), onFocus(item,row), onExitUp, onExitLeft, onExitRight, onExitDown, dim }
  constructor(host, o) {
    this.o = o || {};
    this.el = el('div', 'rows', host);
    this.target = this.o.target || this.el;
    this.list = [];
    this.r = 0;
    this.active = false;
    this.fEl = null;
    // One floating "focus card" for scrolling rows: it stays put and shows the focused item zoomed,
    // while the row slides underneath. Moving focus = swap its content + one transform (no layer churn).
    this.fx = el('div', 'fx', this.el);
    this.fxIn = el('div', 'fxi', this.fx);
    this.fxFor = null;
  }

  get row() { return this.list[this.r]; }
  get item() { const r = this.row; return r ? r.items[r.idx] : null; }

  clear() {
    for (const row of this.list) row.el.remove();
    this.list = []; this.r = 0; this.fEl = null; this.rowEl = null; this.hideFx();
  }

  showFx(row) {
    const c = row.cards[row.idx];
    if (!c) { this.hideFx(); return; }
    if (this.fxFor !== c) {
      this.fxFor = c;
      this.fx.className = 'fx on fx-' + row.kind;
      this.fxIn.textContent = '';
      for (let n = c.firstChild; n; n = n.nextSibling) this.fxIn.appendChild(n.cloneNode(true));
    }
    const y = row.top + (row.def.title ? 58 : 0) + 4;
    const t = 'translate3d(0,' + y + 'px,0)';
    if (this.fx.style.transform !== t) this.fx.style.transform = t;
  }

  hideFx() { if (this.fxFor) { this.fxFor = null; this.fx.className = 'fx'; } }

  // Insert or replace a row (by def.id), keeping rows in def.order.
  upsert(def, items) {
    const i = this.list.findIndex((x) => x.def.id === def.id);
    if (!items || !items.length) {
      if (i >= 0) this.remove(def.id);
      return;
    }
    if (i >= 0) {
      const row = this.list[i];
      if (same(row.items, items)) { row.def = def; return; }
      const focusedId = row.items[row.idx] && row.items[row.idx].Id;
      row.items = items; row.def = def;
      const ni = focusedId ? items.findIndex((x) => x.Id === focusedId) : -1;
      row.idx = ni >= 0 ? ni : Math.min(row.idx, items.length - 1);
      if (row.built) {
        if (this.fEl && row.cards.indexOf(this.fEl) >= 0) this.fEl = null;
        if (row.cards.indexOf(this.fxFor) >= 0) this.fxFor = null;
        row.built = false; row.el.textContent = ''; this.build(row);
      }
      if (i === this.r && this.active) this.focusCurrent(true);
      return;
    }
    const row = { def, items, kind: def.kind || 'card', idx: 0, built: false, top: 0, el: null, strip: null, cards: [] };
    row.onBadge = (c) => { if (this.fxFor === c) { this.fxFor = null; this.showFx(row); } };
    row.el = el('div', 'row row-' + row.kind);
    let at = this.list.length;
    for (let j = 0; j < this.list.length; j++) if ((this.list[j].def.order || 0) > (def.order || 0)) { at = j; break; }
    this.list.splice(at, 0, row);
    this.el.appendChild(row.el);
    if (at <= this.r && this.list.length > 1 && this.active) this.r++;
    this.relayout();
  }

  remove(id) {
    const i = this.list.findIndex((x) => x.def.id === id);
    if (i < 0) return;
    const [row] = this.list.splice(i, 1);
    if (row.cards.indexOf(this.fEl) >= 0) this.fEl = null;
    if (row.cards.indexOf(this.fxFor) >= 0) this.hideFx();
    if (this.rowEl === row.el) this.rowEl = null;
    row.el.remove();
    if (i < this.r || this.r >= this.list.length) this.r = Math.max(0, this.r - 1);
    this.relayout();
    if (this.active) this.focusCurrent();
  }

  relayout() {
    let y = 0;
    for (const row of this.list) {
      row.top = y;
      row.el.style.top = y + 'px';
      y += row.def.rowH || KINDS[row.kind].rowH;
    }
    this.height = y;
    this.place();
  }

  place() {
    const row = this.row;
    if (!row) return;
    for (let j = 0; j < this.list.length; j++) {
      const near = j >= this.r - ROWS_BEFORE && j <= this.r + ROWS_AFTER;
      const rj = this.list[j];
      if (near) this.build(rj);
      if (rj.off !== !near) { rj.off = !near; rj.el.style.display = near ? '' : 'none'; }
    }
    const y = this.o.offset ? this.o.offset(this.r, row) : -row.top;
    if (y !== this.lastY) { this.lastY = y; this.target.style.transform = 'translate3d(0,' + y + 'px,0)'; }
    this.paintDim();
  }

  paintDim() {
    if (!this.o.dim) return;
    for (let j = Math.max(0, this.r - ROWS_BEFORE - 1); j <= Math.min(this.list.length - 1, this.r + ROWS_AFTER + 1); j++) {
      const c = this.list[j].el.classList;
      c.toggle('gone', j < this.r - 1);
      c.toggle('dim', this.active && j !== this.r);
    }
  }

  build(row) {
    if (row.built) return;
    row.built = true;
    const K = KINDS[row.kind];
    if (row.def.title) el('div', 'row-title', row.el, row.def.title);
    row.strip = el('div', 'strip', row.el);
    row.cards = new Array(row.items.length);
    row.sx = 0;
    if (K.scroll === 'stride') {
      row.strip.style.height = (K.h + 8 + (K.below || 0)) + 'px';
      this.ensureCards(row);
      this.scroll(row, false);
    } else {
      for (let i = 0; i < row.items.length; i++) row.cards[i] = makeCard(row, i, false);
      if (K.scroll) this.scroll(row, false);
    }
  }

  // Create the cards around the focus for scrolling rows (others are made when you get near them).
  ensureCards(row) {
    const K = KINDS[row.kind];
    if (K.scroll !== 'stride') return;
    const vis = Math.ceil(VIEW_W / (K.w + K.gap));
    const from = Math.max(0, row.idx - BEHIND), to = Math.min(row.items.length - 1, row.idx + vis + AHEAD);
    for (let i = from; i <= to; i++) if (!row.cards[i]) row.cards[i] = makeCard(row, i, true);
  }

  scroll(row, anim) {
    const K = KINDS[row.kind];
    let x = 0;
    if (K.scroll === 'stride') x = row.idx * (K.w + K.gap);
    else if (K.scroll === 'measure') {
      const c = row.cards[row.idx];
      x = row.sx || 0;
      if (c) {
        const l = c.offsetLeft, r = l + c.offsetWidth;
        if (r - x > VIEW_W - 100) x = r - VIEW_W + 100;
        if (l < x) x = l;
      }
    }
    if (x === row.sx && row.strip.style.transform) return;
    row.sx = x;
    if (!anim) row.strip.style.transition = 'none';
    row.strip.style.transform = 'translate3d(' + -x + 'px,0,0)';
    if (!anim) { void row.strip.offsetWidth; row.strip.style.transition = ''; } // eslint-disable-line no-void
  }

  setFocusEl(c) {
    if (this.fEl === c) return;
    if (this.fEl) this.fEl.classList.remove('f');
    this.fEl = c;
    if (c) c.classList.add('f');
  }

  focus() { this.active = true; this.focusCurrent(); this.paintDim(); }
  blur() { this.active = false; this.setFocusEl(null); this.hideFx(); if (this.rowEl) this.rowEl.classList.remove('row-f'); this.rowEl = null; this.paintDim(); }

  focusCurrent(silent) {
    const row = this.row;
    if (!row) { this.setFocusEl(null); return; }
    this.build(row);
    if (this.rowEl !== row.el) {
      if (this.rowEl) this.rowEl.classList.remove('row-f');
      this.rowEl = row.el; row.el.classList.add('row-f');
    }
    if (row.idx >= row.items.length) row.idx = row.items.length - 1;
    this.ensureCards(row);
    if (row.kind === 'pill') row.cards.forEach((c, j) => c.classList.toggle('sel', j === row.idx));
    if (KINDS[row.kind].scroll === 'stride') { this.setFocusEl(null); this.showFx(row); } else { this.hideFx(); this.setFocusEl(row.cards[row.idx]); }
    if (KINDS[row.kind].scroll) this.scroll(row, true);
    if (!silent && this.o.onFocus) this.o.onFocus(row.items[row.idx], row);
  }

  setRow(n) {
    const prev = this.row, next = this.list[n];
    if (!next) return;
    if (prev && prev.kind === 'grid' && next.kind === 'grid') next.idx = Math.min(prev.idx, next.items.length - 1);
    if (prev && prev.kind === 'sgrid' && next.kind === 'sgrid') next.idx = Math.min(prev.idx, next.items.length - 1);
    this.r = n;
    this.place();
    this.focusCurrent();
  }

  setIdx(row, i) { row.idx = i; this.focusCurrent(); }

  key(k) {
    const row = this.row;
    if (!row) {
      if (k === 'left' && this.o.onExitLeft) { this.o.onExitLeft(); return true; }
      if (k === 'up' && this.o.onExitUp) { this.o.onExitUp(); return true; }
      return false;
    }
    switch (k) {
      case 'left':
        if (row.idx > 0) { this.setIdx(row, row.idx - 1); return true; }
        if (this.o.onExitLeft) { this.o.onExitLeft(); return true; }
        return true;
      case 'right':
        if (row.idx < row.items.length - 1) this.setIdx(row, row.idx + 1);
        else if (this.o.onExitRight) this.o.onExitRight();
        return true;
      case 'up':
        if (this.r > 0) { this.setRow(this.r - 1); return true; }
        if (this.o.onExitUp) { this.o.onExitUp(); return true; }
        return true;
      case 'down':
        if (this.r < this.list.length - 1) this.setRow(this.r + 1);
        else if (this.o.onExitDown) this.o.onExitDown();
        return true;
      case 'ok':
        if (row.def.onOk) row.def.onOk(row.items[row.idx], row.idx, row);
        return true;
    }
    return false;
  }
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].Id !== b[i].Id) return false;
    if (a[i].label !== b[i].label || a[i].icon !== b[i].icon) return false;
    if ((a[i].badge && a[i].badge.text) !== (b[i].badge && b[i].badge.text)) return false;
    if (Math.round(progressPct(a[i])) !== Math.round(progressPct(b[i]))) return false;
  }
  return true;
}

function makeCard(row, i, absolute) {
  const K = KINDS[row.kind];
  const it = row.items[i];
  let c;
  if (row.kind === 'btn' || row.kind === 'pill') {
    c = el('div', row.kind === 'btn' ? 'btn' : 'pill');
    if (it.cls) c.className += ' ' + it.cls;
    if (it.icon) el('span', 'ic', c).innerHTML = ICON[it.icon] || '';
    el('span', 'lb', c, it.label);
    if (it.badge) el('span', 'bbadge ' + (it.badge.cls || ''), c, it.badge.text);
  } else if (row.kind === 'ep') {
    c = el('div', 'ep');
    const box = el('div', 'epi', c);
    el('div', 'ph', box, epLabel(it));
    const [src] = cardImg(it, K.w, K.h);
    if (src) { const im = el('img', '', box); im.alt = ''; im.src = src; }
    const p = progressPct(it);
    if (p > 0 && p < 99) { const b = el('div', 'pb', box); el('i', '', b).style.transform = 'scaleX(' + p / 100 + ')'; }
    if (it.UserData && it.UserData.Played) el('div', 'seen', box, '✓');
    el('div', 'ept', c, (it.IndexNumber != null ? it.IndexNumber + '. ' : '') + it.Name);
    el('div', 'epm', c, fmtRuntime(it.RunTimeTicks));
  } else {
    c = el('div', 'card');
    const [src, titled] = row.kind === 'poster' ? posterImg(it, K.w, K.h) : cardImg(it, K.w, K.h);
    el('div', 'ph', c, it.Type === 'Episode' ? (it.SeriesName || it.Name) : it.Name);
    if (src) { const im = el('img', '', c); im.alt = ''; im.src = src; }
    if (!titled) {
      const t = el('div', 'ttl', c, it.Type === 'Episode' ? (it.SeriesName || '') : it.Name);
      if (it.Type === 'Episode') el('div', 'sttl', t, epLabel(it) + ' ' + it.Name);
    }
    const p = progressPct(it);
    if (p > 0 && p < 99) { const b = el('div', 'pb', c); el('i', '', b).style.transform = 'scaleX(' + p / 100 + ')'; }
  }
  if (it.Path) {
    // green tick when the mediafix-helper says this file's audio was fixed
    queueFixBadge(it.Path, (d) => {
      if (!d.fixed || c._fix) return;
      c._fix = true;
      el('div', 'fixok', row.kind === 'ep' ? c.firstChild : c, '✓');
      if (row.onBadge) row.onBadge(c);
    });
  }
  if (absolute) { c.style.position = 'absolute'; c.style.left = i * (K.w + K.gap) + 'px'; c.style.top = '4px'; }
  row.strip.appendChild(c);
  return c;
}
