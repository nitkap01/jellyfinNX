// Home / Shows / Movies / My List: billboard on top, rows of cards below.
import { el, debounce, mark, fmtRuntime, epLabel, onIdle, setFlag } from '../util.js';
import { app } from '../app.js';
import { store } from '../store.js';
import { S, backdropImg, logoImg, invalidate } from '../api.js';
import { Rows } from '../ui/rows.js';
import { setBg } from '../ui/bg.js';
import { openRail } from '../ui/rail.js';
import { ICON } from '../icons.js';
import { openDetails } from './details.js';
import { playItem } from '../player/player.js';

const GRID_COLS = 5;

export function browseScreen(host, cfg) {
  // cfg: { name, defs(), hero, title, exitPrompt }
  const root = el('div', 'screen browse' + (cfg.hero ? ' has-hero top' : ' no-hero'), host);
  let mode = cfg.hero ? 'top' : 'rows';
  let featured = null, heroIdx = 0, shown = null;
  let H = null;
  if (cfg.hero) {
    const h = el('div', 'hero', root);
    H = { root: h, logoBox: el('div', 'h-logo', h) };
    H.logo = el('img', '', H.logoBox); H.logo.alt = '';
    H.logo.onload = () => H.logoBox.classList.add('has');
    H.logo.onerror = () => H.logoBox.classList.remove('has');
    H.title = el('div', 'h-title', H.logoBox);
    H.meta = el('div', 'h-meta', h);
    H.ov = el('div', 'h-ov', h);
    const b = el('div', 'h-btns', h);
    H.btns = [mkBtn(b, ICON.play, 'Play', 'btn-w'), mkBtn(b, ICON.info, 'More Info')];
  } else if (cfg.title) el('div', 'scr-title', root, cfg.title);
  const rowsHost = el('div', 'rows-host', root);

  // Hero screens: rows start low under the billboard; from the 2nd row on, the focused row sits at y=430
  // with the previous row dimmed above it (as in the approved design).
  const rows = new Rows(rowsHost, {
    dim: !!cfg.hero,
    offset: (r, row) => (cfg.hero ? (mode === 'top' || r === 0 ? 770 - row.top : 430 - row.top) : 170 - Math.max(0, row.top - 440)),
    onFocus: (it) => {
      if (mode !== 'rows') return;
      root.classList.toggle('deep', rows.r > 0);
      setFlag('deep', rows.r > 0);
      if (rows.r === 0) heroLater(it); else heroLater.cancel();
      bgLater(it);
    },
    onExitUp: () => { if (cfg.hero) toTop(); },
    onExitLeft: () => { rows.blur(); openRail(cfg.name); },
  });

  const heroLater = debounce((it) => showHero(it), 120);
  const bgLater = debounce((it) => setBg(backdropImg(it, 1280)), 450);

  function mkBtn(parent, icon, label, cls) {
    const b = el('div', 'btn ' + (cls || ''), parent);
    el('span', 'ic', b).innerHTML = icon;
    el('span', 'lb', b, label);
    return b;
  }

  function showHero(it) {
    if (!H || !it || shown === it) return;
    shown = it;
    const series = it.Type === 'Episode' ? it.SeriesName : '';
    const logo = logoImg(it);
    H.logoBox.classList.remove('has');
    H.title.textContent = series || it.Name;
    if (logo) H.logo.src = logo; else H.logo.removeAttribute('src');
    const m = [];
    if (it.Type === 'Episode') m.push(epLabel(it) + ' · ' + it.Name);
    if (it.ProductionYear) m.push(it.ProductionYear);
    if (it.OfficialRating) m.push(it.OfficialRating);
    if (it.Type !== 'Series' && it.RunTimeTicks) m.push(fmtRuntime(it.RunTimeTicks));
    if (it.CommunityRating) m.push('★ ' + it.CommunityRating.toFixed(1));
    H.meta.textContent = m.join('   ·   ');
    H.ov.textContent = it.Overview || '';
  }

  function paintHeroBtns() { H.btns.forEach((b, j) => b.classList.toggle('f', mode === 'top' && j === heroIdx && app.isTop(api))); }

  function toTop() {
    if (!cfg.hero) return;
    mode = 'top';
    root.classList.add('top');
    root.classList.remove('deep');
    setFlag('deep', false);
    rows.blur();
    rows.r = 0;
    rows.place();
    heroLater.cancel(); bgLater.cancel();
    if (featured) { showHero(featured); setBg(backdropImg(featured, 1280)); }
    heroIdx = 0;
    paintHeroBtns();
  }

  function toRows() {
    if (!rows.list.length) return;
    mode = 'rows';
    root.classList.remove('top');
    paintHeroBtns();
    rows.place();
    rows.focus();
  }

  // ---- data ----
  let loaded = false, lastLoad = 0, stale = false;
  const ck = () => cfg.name + '.' + S.userId;
  const defsById = {};

  function decorate(d) {
    d.onOk = (it) => (d.playDirect ? playItem(it) : openDetails(it));
    if (d.grid) d.kind = 'grid';
    return d;
  }

  function apply(d, items) {
    decorate(d);
    defsById[d.id] = d;
    if (d.grid) {
      const n = Math.ceil(items.length / GRID_COLS);
      for (let j = 0; j < n; j++) {
        rows.upsert(Object.assign({}, d, { id: d.id + '-' + j, title: j ? '' : d.title, order: d.order + j / 1000, rowH: j ? 222 : 272 }), items.slice(j * GRID_COLS, (j + 1) * GRID_COLS));
      }
      for (let j = n; rows.list.some((r) => r.def.id === d.id + '-' + j); j++) rows.remove(d.id + '-' + j);
      if (!n) emptyMsg(true);
      else emptyMsg(false);
    } else rows.upsert(d, items);
    if (!firstShown && rows.list.length) firstPaint();
    d._items = items;
  }

  let emptyEl;
  function emptyMsg(on) {
    if (on && !emptyEl) emptyEl = el('div', 'empty', root, 'Nothing here yet. Add titles with “My List” on any movie or show.');
    if (emptyEl) emptyEl.style.display = on ? '' : 'none';
  }

  let firstShown = false;
  function firstPaint() {
    firstShown = true;
    if (cfg.hero && !featured) pickFeatured();
    if (cfg.hero && mode === 'top') { showHero(featured); if (featured) setBg(backdropImg(featured, 1280)); paintHeroBtns(); } else if (app.isTop(api)) rows.focus();
    if (cfg.name === 'home') {
      mark('firstRowDom');
      watchFirstImages();
    }
  }

  function watchFirstImages() {
    const row = rows.list[0];
    if (!row) return;
    const imgs = row.cards.slice(0, 5).map((c) => c && c.querySelector('img')).filter((i) => i && i.src);
    const t0 = Date.now();
    (function poll() {
      if (imgs.every((i) => i.complete && i.naturalWidth) || Date.now() - t0 > 15000) { mark('firstRowImgs'); return; }
      setTimeout(poll, 30);
    })();
  }

  function pickFeatured(forNext) {
    const pool = [];
    for (const r of rows.list) for (const it of r.items) if ((it.Type === 'Movie' || it.Type === 'Series') && it.BackdropImageTags && it.Overview) pool.push(it);
    const good = pool.filter((it) => it.ImageTags && it.ImageTags.Logo);
    const p = good.length ? good : pool;
    const pick = p.length ? p[Math.floor(Math.random() * Math.min(p.length, 40))] : null;
    if (!forNext) featured = pick;
    return pick;
  }

  async function load(onlyDynamic) {
    lastLoad = Date.now(); stale = false;
    if (!loaded) {
      loaded = true;
      const c = store.cacheGet(ck());
      if (c && c.rows) {
        for (const r of c.rows) apply({ id: r.id, title: r.title, kind: r.kind, order: r.order, playDirect: r.playDirect, grid: r.grid, cached: true }, r.items);
        if (c.hero && cfg.hero) { featured = c.hero; if (mode === 'top') { shown = null; showHero(featured); setBg(backdropImg(featured, 1280)); } }
      }
    }
    const defs = cfg.defs();
    const seen = {};
    const run = (d) => d.load().then((items) => { seen[d.id] = 1; apply(d, items); }).catch((e) => { seen[d.id] = 1; console.warn(d.id, e); });
    const first = [], later = [];
    const known = Object.keys(defsById);
    await Promise.all(defs.map((d) => {
      if (d.expand) {
        return d.expand().then((ds) => { for (const x of ds) (x.lazy ? later : first).push(x); }).catch(() => {
          // keep cached rows that came from this group
          for (const id of known) if (defsById[id].cached) seen[id] = 1;
        });
      }
      if (onlyDynamic && !d.dynamic) { seen[d.id] = 1; return null; }
      (d.lazy ? later : first).push(d);
      return null;
    }));
    if (onlyDynamic) { for (const d of first.concat(later)) if (!d.dynamic) seen[d.id] = 1; }
    await Promise.all(first.filter((d) => !onlyDynamic || d.dynamic).map(run));
    await Promise.all(later.filter((d) => !onlyDynamic || d.dynamic).map(run));
    // remove rows that no longer exist (e.g. empty Continue Watching)
    for (const id of Object.keys(defsById)) {
      if (!seen[id]) {
        const d = defsById[id];
        delete defsById[id];
        if (d.grid) { for (let j = 0; rows.list.some((r) => r.def.id === id + '-' + j); j++) rows.remove(id + '-' + j); } else rows.remove(id);
      }
    }
    if (!rows.list.length && cfg.hero) emptyMsg(true);
    onIdle(save);
  }

  function save() {
    const out = [];
    const ids = Object.keys(defsById).map((id) => defsById[id]).sort((a, b) => a.order - b.order);
    for (const d of ids) if (d._items && d._items.length) out.push({ id: d.id, title: d.title, kind: d.kind, order: d.order, playDirect: d.playDirect, grid: d.grid, items: d._items.slice(0, 30) });
    store.cacheSet(ck(), { t: Date.now(), rows: out, hero: cfg.hero ? pickFeatured(true) || featured : null });
  }

  app.on('played', () => { stale = true; invalidate('/Resume', '/NextUp', 'IsFavorite', '/Latest'); if (app.current === api) load(true); });
  app.on('favs', () => { stale = true; invalidate('IsFavorite'); if (app.current === api) load(true); });

  // ---- keys ----
  let okTimer = 0, okHeld = false;
  const api = {
    el: root,
    rows,
    show() {
      root.classList.add('on');
      setFlag('deep', root.classList.contains('deep'));
      if (!loaded) load();
      else if (stale || Date.now() - lastLoad > 90000) load(true);
      if (mode === 'top' && featured) setBg(backdropImg(featured, 1280));
      else if (rows.item) setBg(backdropImg(rows.item, 1280));
      else if (!cfg.hero) setBg('');
      this.resume();
    },
    hide() { root.classList.remove('on'); setFlag('deep', false); },
    reenter() { if (cfg.hero) toTop(); else { rows.r = 0; rows.place(); rows.focus(); } },
    resume() {
      if (mode === 'top' && cfg.hero) paintHeroBtns();
      else if (rows.list.length) rows.focus();
      if (mode === 'rows' && rows.item) setBg(backdropImg(rows.item, 1280));
    },
    key(k, e) {
      if (mode === 'top' && cfg.hero) {
        if (k === 'left') { if (heroIdx > 0) { heroIdx--; paintHeroBtns(); } else { H.btns.forEach((b) => b.classList.remove('f')); openRail(cfg.name); } return true; }
        if (k === 'right') { if (heroIdx < 1) { heroIdx++; paintHeroBtns(); } return true; }
        if (k === 'down') { toRows(); return true; }
        if (k === 'ok') { if (featured) (heroIdx === 0 ? playItem(featured) : openDetails(featured)); return true; }
        if (k === 'back') { if (cfg.name === 'home') { cfg.exitPrompt(); return true; } return false; }
        if (k === 'up') return true;
        return false;
      }
      if (k === 'ok') {
        const row = rows.row;
        if (row && row.def.playDirect) {
          // Netflix-style: OK plays; holding OK opens the details.
          if (e && e.repeat) return true;
          okHeld = false;
          clearTimeout(okTimer);
          const it = rows.item;
          okTimer = setTimeout(() => { okTimer = 0; okHeld = true; openDetails(it); }, 650);
          return true;
        }
      }
      if (k === 'back') {
        if (cfg.hero) { toTop(); return true; }
        if (rows.r > 0) { rows.setRow(0); return true; }
        if (cfg.name === 'home') { cfg.exitPrompt(); return true; }
        return false;
      }
      if (k === 'play' || k === 'playpause') { const it = rows.item; if (it) playItem(it); return true; }
      return rows.key(k);
    },
    keyup(k) {
      if (k === 'ok' && okTimer) { clearTimeout(okTimer); okTimer = 0; if (!okHeld) { const it = rows.item; if (it) playItem(it); } }
    },
  };
  return api;
}
