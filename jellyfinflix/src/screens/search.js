// Search: letter grid on the left, results on the right that update while you type.
import { el, debounce } from '../util.js';
import { get, COMMON, slim, backdropImg } from '../api.js';
import { Keyboard } from '../ui/keyboard.js';
import { Rows } from '../ui/rows.js';
import { openRail } from '../ui/rail.js';
import { setBg } from '../ui/bg.js';
import { openDetails } from './details.js';
import { search } from '../data.js';

const COLS = 4;

export function searchScreen(host) {
  const root = el('div', 'screen search', host);
  const left = el('div', 's-left', root);
  const q = el('div', 's-q', left);
  const qt = el('span', '', q); el('i', 'caret', q);
  const right = el('div', 's-right', root);
  const head = el('div', 's-head', right, 'Recently added');
  const none = el('div', 's-none', right, '');
  const rows = new Rows(el('div', 'rows-host', right), {
    offset: (r, row) => -Math.max(0, row.top - 520),
    onExitLeft: () => { rows.blur(); focus = 'kb'; kb.focus(); },
  });
  let focus = 'kb', seq = 0;
  const kb = new Keyboard(left, {
    onChange: (t) => { qt.textContent = t; later(t); },
    onExitRight: () => { if (rows.list.length) { kb.blur(); focus = 'res'; rows.focus(); } },
    onExitLeft: () => { kb.blur(); openRail('search'); },
  });

  function show(items, title) {
    head.textContent = title;
    none.textContent = items.length ? '' : 'No matches. Try fewer letters.';
    const old = rows.list.map((r) => r.def.id);
    const n = Math.ceil(items.length / COLS);
    for (let j = 0; j < n; j++) rows.upsert({ id: 'r' + j, kind: 'sgrid', order: j, onOk: (it) => openDetails(it) }, items.slice(j * COLS, (j + 1) * COLS));
    for (const id of old) if (+id.slice(1) >= n) rows.remove(id);
    if (!n && focus === 'res') { focus = 'kb'; rows.blur(); kb.focus(); }
  }

  const later = debounce(async (t) => {
    const my = ++seq;
    if (!t.trim()) { loadDefault(); return; }
    try { const items = await search(t.trim()); if (my === seq) show(items, 'Results for “' + t.trim() + '”'); } catch (e) { /* offline */ }
  }, 280);

  async function loadDefault() {
    const my = ++seq;
    try {
      const r = await get('/Users/{U}/Items', Object.assign({}, COMMON, { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 16 }), 300000);
      if (my === seq) show((r.Items || []).map(slim), 'Recently added');
    } catch (e) { /* offline */ }
  }

  let loaded = false;
  return {
    el: root,
    rows, // read by the TV tests (result order)
    get query() { return qt.textContent; },
    show() { root.classList.add('on'); setBg(''); if (!loaded) { loaded = true; loadDefault(); } this.resume(); },
    hide() { root.classList.remove('on'); },
    resume() { if (focus === 'kb') kb.focus(); else rows.focus(); },
    reenter() { focus = 'kb'; rows.blur(); kb.focus(); },
    // filled in from outside (the phone remote, tvremote.home): same as typing it on the letter grid
    setQuery(t) { kb.text = t; qt.textContent = t; if (focus === 'res') { rows.blur(); focus = 'kb'; kb.focus(); } later(t); },
    key(k, e) {
      if (k === 'back') {
        if (focus === 'res') { rows.blur(); focus = 'kb'; kb.focus(); return true; }
        return false;
      }
      if (focus === 'kb') return kb.key(k);
      const handled = rows.key(k, e);
      if (rows.item) setBgLater(rows.item);
      return handled;
    },
  };
}

const setBgLater = debounce((it) => setBg(backdropImg(it, 1280)), 400);
