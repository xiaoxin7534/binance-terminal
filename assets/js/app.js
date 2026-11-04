/* 应用入口：装配视图、数据流、交互 */

import { api, openStream } from './core/api.js';
import {
  state, market, seedMarket, applyTicks, applyFunding, onFrame, save,
  setSectorLabels, sectorLabels, matchTab, matchMkt, SECTOR_KEYS, TAB_KEYS, TAPE_SYMBOLS,
} from './core/store.js';
import { openMenu } from './core/picker.js';
import { fmtPrice, fmtPct, dirClass, fmtCompact } from './core/fmt.js';
import { GridView } from './views/grid.js';
import { ListView } from './views/list.js';
import { DetailPanel } from './views/detail.js';
import { WatchView } from './views/watch.js';
import { BigChart } from './views/bigchart.js';
import { Scanner } from './views/scanner.js';
import { Alerts } from './core/alerts.js';

const $ = (s) => document.querySelector(s);

/* ------------------------------------------------------------------ 报错落盘 */
// 打包成 exe 后用户看不到 DevTools，白屏时只能靠服务端日志定位。
// 服务端会对同一条错误做 5 分钟去重，这里再加一层总量上限，防止错误风暴。
let errSent = 0;
function reportError(msg, url, stack) {
  if (errSent > 40) return;
  errSent++;
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg: String(msg || ''), url: url || location.href, stack: stack || '' }),
    }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}
window.addEventListener('error', (e) => {
  reportError(e.message, e.filename, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  reportError('unhandledrejection: ' + ((r && r.message) || r), location.href, r && r.stack);
});

let grid = null;
let list = null;
let detail = null;
let gridDetail = null;
let watch = null;
let big = null;
let scanner = null;
let alerts = null;
let stream = null;

/* ------------------------------------------------------------------ 主题 */
function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  state.theme = theme;
  if (persist) save();
  if (grid) grid.applyTheme();
  if (detail) detail.applyTheme();
  if (gridDetail) gridDetail.applyTheme();
  if (big) big.applyTheme();
}

/* ------------------------------------------------------------------ 连接状态 */
let connTimer = 0;
function setConn(on) {
  const el = $('#conn');
  if (!el) return;
  clearTimeout(connTimer);
  const paint = (up) => {
    el.className = 'conn ' + (up ? 'on' : 'off');
    el.querySelector('span').textContent = up ? '实时' : '重连中';
  };
  if (on) {
    paint(true);
  } else {
    // 断线通常 1~2 秒就恢复，短暂抖动不打扰用户
    connTimer = setTimeout(() => paint(false), 3500);
  }
}

/* ------------------------------------------------------------------ 行情条 */
const tapeRefs = new Map();

function buildTape() {
  const el = $('#tape');
  el.innerHTML = '';
  tapeRefs.clear();
  for (const sym of TAPE_SYMBOLS) {
    const r = market.get(sym);
    if (!r) continue;
    const item = document.createElement('div');
    item.className = 'tape-item';
    item.innerHTML = `<b>${r.b}</b><span class="p"></span><span class="c"></span>`;
    el.appendChild(item);
    tapeRefs.set(sym, { p: item.querySelector('.p'), c: item.querySelector('.c') });
  }
  updateTape(null);
}

function updateTape(dirty) {
  for (const [sym, ref] of tapeRefs) {
    if (dirty && !dirty.has(sym)) continue;
    const r = market.get(sym);
    if (!r) continue;
    const cls = dirClass(r.chgp);
    ref.p.textContent = fmtPrice(r.l, r.dp);
    ref.p.className = 'p ' + cls;
    ref.c.textContent = fmtPct(r.chgp);
    ref.c.className = 'c ' + cls;
  }
}

/* ------------------------------------------------------------------ 板块选择 */
const FIXED_NAMES = {
  crypto: 'Crypto', tradfi: 'TradFi', usdc: 'USDC', new: '新币', preipo: 'Pre-IPO',
  premarket: 'Pre-Market', chinese: 'Chinese', perp: '永续', spot: '现货',
};

function sectorName(key) {
  if (!key || key === 'all') return '全部';
  return FIXED_NAMES[key] || sectorLabels[key] || key;
}

/** 网格按钮文案：现货 · AI 这种 */
function filterLabel() {
  const parts = [];
  if (state.mkt === 'spot') parts.push('现货');
  else if (state.mkt === 'perp') parts.push('永续');
  if (state.sector) parts.push(sectorName(state.sector));
  else if (state.tab && state.tab !== 'all') parts.push(sectorName(state.tab));
  if (!parts.length) parts.push('全部');
  return parts.join(' · ');
}

function gridSectorLabel(key) {
  if (!key || key === 'all') return '全部';
  const [mkt, sec] = key.includes(':') ? key.split(':') : ['all', key];
  const head = mkt === 'spot' ? '现货' : mkt === 'perp' ? '永续' : '';
  const tail = sec === 'all' ? '全部' : sectorName(sec);
  return head ? `${head} · ${tail}` : tail;
}

function uniqCount(pred) {
  const seen = new Set();
  for (const r of market.values()) {
    if (!pred(r)) continue;
    seen.add(r.b + '|' + (r.mkt || 'spot'));
  }
  return seen.size;
}

const countMkt = (mkt) => uniqCount((r) => matchMkt(r, mkt));
const countMktTab = (mkt, tab) => uniqCount((r) => matchMkt(r, mkt) && matchTab(r, tab));
const countMktSec = (mkt, sec) => uniqCount(
  (r) => matchMkt(r, mkt) && (r.sec || []).includes(sec),
);

function buildSectorMenu() {
  const items = [{ key: 'all', label: '全部品种', count: countMkt('all') }];
  const group = (mkt, title) => {
    items.push({ divider: true }, { header: title });
    items.push({ key: `${mkt}:all`, label: `全部${title}`, count: countMkt(mkt), sub: true });
    for (const t of TAB_KEYS) {
      const n = countMktTab(mkt, t);
      if (n) items.push({ key: `${mkt}:${t}`, label: sectorName(t), count: n, sub: true });
    }
    for (const k of SECTOR_KEYS) {
      const n = countMktSec(mkt, k);
      if (n) items.push({ key: `${mkt}:${k}`, label: sectorLabels[k] || k, count: n, sub: true });
    }
  };
  group('spot', '现货');
  group('perp', '永续');
  return items;
}

function updateSectorBtn() {
  const nameEl = $('#grid-sector-name');
  const btn = $('#grid-sector-btn');
  if (!nameEl || !btn) return;
  const label = filterLabel();
  nameEl.textContent = label;
  btn.classList.toggle('on', label !== '全部');
}

/* ------------------------------------------------------------------ 行数 */
const ROW_OPTS = [
  { key: '0', label: '跟随布局' },
  { divider: true },
  { key: '3', label: '3 行' },
  { key: '4', label: '4 行' },
  { key: '6', label: '6 行' },
  { key: '8', label: '8 行' },
  { key: '12', label: '12 行' },
  { key: '20', label: '20 行' },
  { divider: true },
  { key: '-1', label: '全部品种（铺满当前筛选）' },
];

function rowsLabel() {
  const r = state.rows;
  if (r === -1) return '全部品种';
  if (r > 0) return r + ' 行';
  return '跟随布局';
}

function updateRowsBtn() {
  const el = $('#grid-rows-name');
  const btn = $('#grid-rows-btn');
  if (!el) return;
  el.textContent = rowsLabel();
  if (btn) btn.classList.toggle('on', state.rows !== 0);
}

let lastFillSig = '';

let toastTimer = 0;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ------------------------------------------------------------------ 订阅 */
let subTimer = 0;
function syncSubs() {
  clearTimeout(subTimer);
  subTimer = setTimeout(() => {
    if (!grid) return;
    const tickers = new Set([...state.cells, state.selected, ...state.favs, ...TAPE_SYMBOLS]);
    // 只订阅挂载中的格子：墙铺 100+ 个格子时不能给每个都开 K 线流
    const klines = grid.cells
      .filter((c) => c.symbol && c.mounted)
      .map((c) => [c.symbol, c.interval === 'time' ? '1m' : c.interval]);
    // 大图模式在看的那一个也要订阅，否则最后一根不动
    if (big && big.isOpen() && big.symbol) {
      klines.push([big.symbol, big.interval === 'time' ? '1m' : big.interval]);
    }
    // 盘口/逐笔只有详情面板在看着才需要
    const wantBook = (big && big.isOpen())
      ? !!big.showDetail
      : (state.view === 'list' || !!state.detailOpen);
    api.sub({
      tickers: [...tickers],
      klines,
      depth: wantBook ? state.selected : null,
      trades: wantBook ? state.selected : null,
    });
  }, 180);
}

/* ------------------------------------------------------------------ 图表墙详情侧板 */
function setGridDetail(on) {
  state.detailOpen = !!on;
  save();
  const wrap = $('#grid-wrap');
  if (wrap) wrap.classList.toggle('dt-off', !state.detailOpen);
  const sw = $('#grid-detail-switch');
  if (sw) sw.checked = state.detailOpen;
  if (state.detailOpen && grid && gridDetail) {
    const c = grid.cells[grid.focusIndex || 0];
    if (c && c.symbol) gridDetail.setSymbol(c.symbol);
  }
  if (grid) grid.resize();
  syncSubs();
}

/* ------------------------------------------------------------------ 大图模式 */
function openBig(sym, iv) {
  if (!big || !sym) return;
  // 从列表双击进来时，顺便把列表的选中行和右侧详情对齐，关掉大图不会看到对不上的状态
  if (state.view === 'list' && list) list.select(sym);
  state.selected = sym;
  save();
  if (watch) watch.setActive(sym);
  big.open(sym, iv || state.interval);
  syncSubs();
}

/* ------------------------------------------------------------------ 选中一个标的 */
function showInGridDetail(sym) {
  if (!sym || !state.detailOpen || !gridDetail) return;
  gridDetail.setSymbol(sym);
}

function pickSymbol(sym) {
  if (!sym) return;
  if (watch) watch.setActive(sym);
  if (state.view === 'list') {
    list.select(sym);              // 走列表的 onSelect：详情 + 订阅一起更新
  } else {
    state.selected = sym;
    save();
    const c = grid.cells[grid.focusIndex || 0];
    if (c) { c.setSymbol(sym); grid.setFocus(c.index); }
    showInGridDetail(sym);
    syncSubs();
  }
}

/** 自选栏双击：切到图表墙并填进当前聚焦的格子 */
function pickToGrid(sym) {
  if (!sym) return;
  if (state.view !== 'grid') switchView('grid');
  const c = grid.cells[grid.focusIndex || 0];
  if (c) { c.setSymbol(sym); grid.setFocus(c.index); }
  showInGridDetail(sym);
  syncSubs();
}

/* ------------------------------------------------------------------ 视图切换 */
function switchView(view) {
  state.view = view;
  save();
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === view);
  });
  $('#view-grid').classList.toggle('hidden', view !== 'grid');
  $('#view-list').classList.toggle('hidden', view !== 'list');
  if (watch) watch.setActive(state.selected);

  if (view === 'list') {
    list.onShow();
    detail.setSymbol(state.selected);
  } else {    // 从列表切过来时，沿用列表的板块筛选和排序
    const sig = `${state.mkt}|${state.tab}|${state.sector}|${state.sort.key}|${state.sort.dir}`;
    if (sig !== lastFillSig && (state.tab !== 'all' || state.sector || state.mkt !== 'all')) {
      lastFillSig = sig;
      grid.fillByFilter(state.mkt, state.tab, state.sector, state.sort);
      updateSectorBtn();
      syncSubs();
    }
    grid.cells.forEach((c) => c.renderHead());
    grid.resize();
    // 面板在别的视图里待过，数据是停更的，切回来补一次
    if (state.detailOpen && gridDetail) {
      const c = grid.cells[grid.focusIndex || 0];
      if (c && c.symbol) gridDetail.setSymbol(c.symbol);
      gridDetail.refresh();
    }
  }
}

/* ------------------------------------------------------------------ 自选栏开关 */
/* ------------------------------------------------------------------ 快捷键面板 */
function toggleHelp(force) {
  const el = $('#help');
  if (!el) return;
  const show = force === undefined ? el.classList.contains('hidden') : !!force;
  el.classList.toggle('hidden', !show);
}

function toggleWatch() {
  state.watchOpen = !state.watchOpen;
  save();
  document.querySelector('.app').classList.toggle('watch-off', !state.watchOpen);
  if (grid) grid.resize();
}

/* ------------------------------------------------------------------ 工具栏 */
function markActive() {
  document.querySelectorAll('#layout-seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.layout === state.layout);
  });
  document.querySelectorAll('#interval-seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.iv === state.interval);
  });
  document.querySelectorAll('[data-ind]').forEach((b) => {
    b.classList.toggle('on', !!state.indicators[b.dataset.ind]);
  });
  $('#sync-range').checked = state.sync;
}

function bindToolbar() {
  $('#btn-watch').addEventListener('click', toggleWatch);

  $('#layout-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-layout]');
    if (!b || b.dataset.layout === state.layout) return;
    state.layout = b.dataset.layout;
    save();
    markActive();
    grid.applyLayout();
    syncSubs();
  });

  $('#interval-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-iv]');
    if (!b) return;
    state.interval = b.dataset.iv;
    save();
    markActive();
    grid.setIntervalAll(state.interval);
  });

  document.querySelectorAll('[data-ind]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.ind;
      state.indicators[k] = !state.indicators[k];
      save();
      markActive();
      grid.setIndicators();
    });
  });

  $('#sync-range').addEventListener('change', (e) => {
    state.sync = e.target.checked;
    save();
  });

  $('#grid-detail-switch').addEventListener('change', (e) => setGridDetail(e.target.checked));

  $('#grid-sector-btn').addEventListener('click', () => {
    openMenu($('#grid-sector-btn'), buildSectorMenu(), state.gridSector || 'all', (key) => {
      const ok = grid.fillSector(key);
      updateSectorBtn();
      if (!ok) {
        toast(gridSectorLabel(key) + ' 暂无标的');
      } else {
        syncSubs();
      }
    });
  });

  $('#grid-rows-btn').addEventListener('click', () => {
    openMenu($('#grid-rows-btn'), ROW_OPTS, String(state.rows), (key) => {
      state.rows = Number(key);
      save();
      updateRowsBtn();
      grid.applyLayout();
      grid.root.scrollTop = 0;
      syncSubs();
    });
  });

  $('#btn-theme').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  $('#btn-scanner').addEventListener('click', () => {
    if (scanner.isOpen()) scanner.close();
    else scanner.open();
  });

  $('#btn-alerts').addEventListener('click', () => {
    if (alerts.isOpen()) alerts.close();
    else alerts.open();
  });

  $('#help-close').addEventListener('click', () => toggleHelp(false));
  $('#help').addEventListener('click', (e) => {
    if (e.target.id === 'help') toggleHelp(false);
  });

  document.querySelectorAll('#tabs button').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });
}

/* ------------------------------------------------------------------ 启动 */
async function boot() {
  applyTheme(state.theme, false);

  grid = new GridView($('#grid'), {
    onCellsChanged: syncSubs,
    // 图表墙的板块选择会改写 mkt/tab/sector，列表要跟着刷新
    onFilterChanged: () => { if (list) list.syncFilterUI(); },
    onFocus: (sym) => {
      state.selected = sym;
      save();
      if (watch) watch.setActive(sym);
      showInGridDetail(sym);
    },
    // 双击格子 / Enter：进大图
    onOpenBig: (sym, iv) => openBig(sym, iv),
  });
  list = new ListView($('#view-list'), {
    onSelect: (sym) => {
      detail.setSymbol(sym);
      syncSubs();
      if (watch) watch.setActive(sym);
    },
    // 列表里双击一行 = 直接进大图（和格子里双击一个意思）
    onOpenBig: (sym) => openBig(sym, state.interval),
    onOpenInGrid: (sym) => {
      if (grid.cells[0]) grid.cells[0].setSymbol(sym);
      switchView('grid');
    },
  });
  detail = new DetailPanel($('#detail'));
  // 图表墙右侧详情：方向键连按时会连续换币，给 140ms 攒一下再重建
  gridDetail = new DetailPanel($('#grid-detail'), {
    closable: true,
    delay: 140,
    onClose: () => setGridDetail(false),
  });
  // 大图模式：双击品种进入，带绘图 + OHLC 明细
  big = new BigChart($('#bigchart'), {
    onClose: () => syncSubs(),
    // 左右键翻品种：列表视图用列表当前的行顺序，否则用同列的筛选结果
    symbolList: () => (state.view === 'list' && list && list.symbols
      ? list.symbols()
      : grid.filteredSymbols(state.mkt, state.tab, state.sector)),
    onDetailToggle: () => syncSubs(),
    onSymbolChange: (sym) => {
      state.selected = sym;
      save();
      if (watch) watch.setActive(sym);
      if (state.view === 'list' && list) list.select(sym);
    },
    onIndicatorsChanged: () => {
      save();
      markActive();
      if (grid) grid.setIndicators();
    },
  });
  alerts = new Alerts($('#alerts'), {
    save,
    toast: (m) => toast(m),
    onPick: (sym) => openBig(sym, state.interval),
  });
  scanner = new Scanner($('#scanner'), {
    onPick: (sym) => openBig(sym, state.interval),
  });
  watch = new WatchView($('#watch'), {
    onPick: pickSymbol,
    onPickGrid: pickToGrid,
  });
  watch.setActive(state.selected);
  document.querySelector('.app').classList.toggle('watch-off', !state.watchOpen);

  bindToolbar();
  markActive();
  updateSectorBtn();
  updateRowsBtn();
  setGridDetail(state.detailOpen);
  grid.cells.forEach((c) => c.syncTools());

  // 首屏行情
  try {
    const data = await api.market();
    seedMarket(data.rows);
    setSectorLabels(data.labels);
    buildTape();
    list.setLabels();
    list.rebuild(true);
    if (watch) { watch.render(); watch.setActive(state.selected); }
    if (state.gridSector && state.gridSector !== 'all') {
      grid.fillSector(state.gridSector);
      updateSectorBtn();
    }
    grid.cells.forEach((c) => c.renderHead());
    showInGridDetail((grid.cells[grid.focusIndex || 0] || {}).symbol);
    if (gridDetail) gridDetail.refresh();     // 首屏是空壳，行情到了补一次
  } catch (e) {
    console.error('[market]', e);
    $('#splash').innerHTML = `<div class="splash-box"><p style="color:var(--up);font-weight:600;margin-bottom:6px">无法连接本地服务</p>
      <p>请先运行 <b>启动看盘.bat</b>（或 python server.py），<br>再从 http://127.0.0.1:8848 打开本页。</p>
      <p style="margin-top:10px;font-size:11px;color:var(--muted)">${(e && e.message) || e}</p></div>`;
    return;
  }

  // 实时流
  stream = openStream({
    onOpen: () => {
      setConn(true);
      syncSubs();          // 服务端重启后重新登记订阅
    },
    onError: () => setConn(false),
    onMessage: (msg) => {
      switch (msg.t) {
        case 'tk': applyTicks(msg.d); break;
        case 'fund': applyFunding(msg.d); if (alerts) alerts.check(); break;
        case 'k': grid.onKline(msg); if (big) big.onKline(msg); break;
        case 'd': detail.onDepth(msg); gridDetail.onDepth(msg); if (big) big.onDepth(msg); break;
        case 'r': detail.onTrade(msg); gridDetail.onTrade(msg); if (big) big.onTrade(msg); break;
        case 'ws':
          setConn(msg.up);
          // 行情流重连后补一次 K 线，避免断线期间漏掉整根
          if (msg.up) setTimeout(() => grid.cells.forEach((c) => c.load(true)), 900);
          break;
        case 'hi': setConn(msg.ws); break;
        default: break;
      }
    },
  });

  onFrame((dirty) => {
    // 窗口在后台时只收数据、不刷 DOM；切回来时全量补一次（见下面的 visibilitychange）
    if (document.hidden) return;
    if (state.view === 'grid') grid.onFrame(dirty);
    else list.updateLive(dirty);
    updateTape(dirty);
    if (watch) watch.update(dirty);
    if (big && big.isOpen()) big.onFrame(dirty);
    if (dirty.has(state.selected)) {
      if (state.view === 'list') detail.updateTick();
      else if (state.detailOpen && gridDetail) gridDetail.updateTick();
    }
  });

  switchView(state.view);
  syncSubs();

  // 从后台切回来：后台期间跳过的 DOM 更新一次性补上。
  // 用一个永远命中的 has() 代替构造 1800 个元素的 Set
  const ALL = { has: () => true };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.view === 'grid') grid.onFrame(ALL);
    else list.updateLive(ALL);
    updateTape(null);
    if (watch) watch.update(null);
    if (big && big.isOpen()) big.onFrame(ALL);
  });

  window.__term = { grid, list, detail, gridDetail, big, scanner, alerts, state, market };

  setTimeout(() => {
    const sp = $('#splash');
    if (sp) {
      sp.classList.add('gone');
      setTimeout(() => sp.remove(), 400);
    }
  }, 320);

  // 每 30 秒补一次全量快照，兜住漏掉的币种
  setInterval(async () => {
    try {
      const d = await api.market();
      seedMarket(d.rows);
      setSectorLabels(d.labels);
      list.setLabels();
      list.rebuild(false);
      updateSectorBtn();
      if (watch) watch.render();
      if (!tapeRefs.size) buildTape();
    } catch (e) { /* ignore */ }
  }, 30000);
}

/* ------------------------------------------------------------------ 快捷键 */
document.addEventListener('keydown', (e) => {
  if (e.target && e.target.matches && e.target.matches('input, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === '?' ) { e.preventDefault(); toggleHelp(); return; }
  if (e.key === 'Escape' && scanner && scanner.isOpen()) { scanner.close(); return; }
  if (e.key === 'Escape' && alerts && alerts.isOpen()) { alerts.close(); return; }
  if (e.key === 'Escape' && !$('#help').classList.contains('hidden')) { toggleHelp(false); return; }
  // 大图模式下先交给它自己处理，其余全局快捷键一律让路
  if (big && big.isOpen()) {
    if (e.key === 't' || e.key === 'T') { applyTheme(state.theme === 'dark' ? 'light' : 'dark'); return; }
    if (big.onKey(e)) return;
    return;
  }
  if (e.key === '[') { e.preventDefault(); toggleWatch(); return; }
  if (state.view === 'grid' && grid && !e.metaKey && !e.ctrlKey) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); grid.moveFocus(-1, 0); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); grid.moveFocus(1, 0); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); grid.moveFocus(0, -1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); grid.moveFocus(0, 1); return; }
    if (e.key === 'Enter') { e.preventDefault(); grid.openBig(); return; }
  }
  if (state.view === 'list' && list && e.key === 'Enter' && list.selected) {
    e.preventDefault();
    openBig(list.selected, state.interval);
    return;
  }
  if (e.key === 'Escape' && state.view === 'grid' && state.detailOpen) { setGridDetail(false); return; }
  if (e.key === '1') switchView('grid');
  else if (e.key === '2') switchView('list');
  else if (e.key === 'd' || e.key === 'D') {
    if (state.view === 'grid' && !e.metaKey && !e.ctrlKey) setGridDetail(!state.detailOpen);
  }
  else if (e.key === 't' || e.key === 'T') applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  else if (e.key === '/') {
    e.preventDefault();
    switchView('list');
    setTimeout(() => $('#list-search').focus(), 30);
  }
});

let rzTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => grid && grid.resize(), 120);
});

boot().catch((e) => {
  console.error('[boot]', e);
  const sp = document.querySelector('#splash');
  if (sp) {
    sp.innerHTML = `<div class="splash-box">
      <p style="color:var(--up);font-weight:600;margin-bottom:8px">启动失败</p>
      <p style="max-width:520px;line-height:1.7">${(e && e.message) || e}</p></div>`;
  }
});
