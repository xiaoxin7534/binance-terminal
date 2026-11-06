/* 应用入口：装配视图、数据流、交互 */

import { api, openStream } from './core/api.js';
import {
  state, market, seedMarket, applyTicks, applyFunding, onFrame, save,
  setSectorLabels, sectorLabels, setRegionLabels,
  matchTab, matchMkt, SECTOR_KEYS, TAB_KEYS, TAPE_SYMBOLS,
  isFav, toggleFav, IND_DEFAULTS, addFavTo, currentFavGroup,
} from './core/store.js';
import { openMenu, openParams } from './core/picker.js';
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
// 浏览器自己的噪音：ResizeObserver 的这条警告不影响任何功能
// （图表容器每帧都在变尺寸，Chrome 就会抛），但它会把真正有用的错误挤出日志
const NOISE = /ResizeObserver loop|Script error\.?$/;
function reportError(msg, url, stack) {
  if (errSent > 40) return;
  if (NOISE.test(String(msg || ''))) return;
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

/* --------------------------------------------------------------- 界面字体 */
const FONT_LABELS = {
  pingfang: '苹方 PingFang',
  yahei: '微软雅黑',
  system: '系统默认（Segoe UI）',
};
/* 字体是否真的装在这台机器上 —— 用画布量文字宽度对比 fallback，
   比 document.fonts.check 可靠：后者对「系统里没声明过的字体」经常误报 true */
function hasFont(name) {
  try {
    const c = document.createElement('canvas').getContext('2d');
    const probe = 'mmmmmmmmmm中文0123456789';
    c.font = '64px monospace';
    const base = c.measureText(probe).width;
    c.font = `64px "${name}", monospace`;
    return c.measureText(probe).width !== base;
  } catch (e) {
    return false;
  }
}
function fontAvailable(key) {
  if (key === 'pingfang') {
    // 两个来源都算：系统里装了苹方，或者把 woff2 丢进 assets/css/fonts/ 由 @font-face 加载
    if (hasFont('PingFang SC')) return true;
    try { return document.fonts.check('12px PingFangLocal'); } catch (e) { return false; }
  }
  if (key === 'yahei') return hasFont('Microsoft YaHei');
  return true;                       // 系统默认总能用
}
function applyFont(key, notify = false) {
  const k = FONT_LABELS[key] ? key : 'pingfang';
  document.documentElement.dataset.font = k;
  state.font = k;
  save();
  // 图表的坐标轴文字也吃这个字体，切完要让它们重画一次
  if (grid) grid.applyTheme();
  if (detail) detail.applyTheme();
  if (gridDetail) gridDetail.applyTheme();
  if (big) big.applyTheme();
  if (notify && !fontAvailable(k)) {
    toast(`本机没装「${FONT_LABELS[k]}」，已自动用微软雅黑显示`);
  }
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
    item.dataset.s = sym;
    item.title = `${r.b}/${r.q} · 单击选中，双击填进图表墙，右键更多`;
    item.innerHTML = `<b>${r.b}</b><span class="p"></span><span class="c"></span>`;
    el.appendChild(item);
    tapeRefs.set(sym, {
      el: item,
      p: item.querySelector('.p'),
      c: item.querySelector('.c'),
    });
  }
  updateTape(null);
  markTapeActive();
}

/** 行情条高亮当前选中的品种 */
function markTapeActive() {
  for (const [sym, ref] of tapeRefs) ref.el.classList.toggle('on', sym === state.selected);
}

/** 行情条交互：和左侧自选栏保持一致（单击选中 / 双击填格子 / 右键菜单） */
function bindTape() {
  const el = $('#tape');
  if (!el) return;

  el.addEventListener('click', (e) => {
    const it = e.target.closest('[data-s]');
    if (it) pickSymbol(it.dataset.s);
  });

  el.addEventListener('dblclick', (e) => {
    const it = e.target.closest('[data-s]');
    if (it) pickToGrid(it.dataset.s);
  });

  el.addEventListener('contextmenu', (e) => {
    const it = e.target.closest('[data-s]');
    if (!it) return;
    e.preventDefault();
    const sym = it.dataset.s;
    const cur = currentFavGroup();
    const items = [
      { key: 'big', label: '在大图中打开' },
      { divider: true },
      { key: 'fav', label: isFav(sym) ? `移出「${cur.name}」` : `加入「${cur.name}」` },
    ];
    // 有多个分组时，顺手给出「加到别的分组」的入口
    const others = state.favGroups.filter((g) => g.id !== cur.id);
    if (others.length) {
      items.push({ header: '加入其他分组' });
      for (const g of others) items.push({ key: 'g:' + g.id, label: g.name, count: g.list.length });
    }
    openMenu(it, items, '', (k) => {
      if (k === 'big') openBig(sym, state.interval);
      else if (k === 'fav') toggleFav(sym);
      else if (k.startsWith('g:')) {
        const gid = k.slice(2);
        const g = state.favGroups.find((x) => x.id === gid);
        if (addFavTo(sym, gid) && toast) toast(`已加入「${g ? g.name : '分组'}」`);
      }
    });
  });
}

/** 选中某个品种：自选栏高亮 + 行情条高亮，两处一起同步 */
function setActiveSymbol(sym) {
  if (watch) watch.setActive(sym);
  markTapeActive();
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
/** msg + 可选操作（如「撤销」）。带操作时停留 6 秒，纯文字 1.8 秒 */
function toast(msg, action) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  el.classList.toggle('has-act', !!action);
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(toastTimer);
      el.classList.remove('show');
      action.onClick();
    });
    el.appendChild(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 1800);
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
      .map((c) => [c.symbol, c.interval === 'time' ? '1m' : c.interval === '5d' ? '5m' : c.interval]);
    // 大图模式在看的那一个也要订阅，否则最后一根不动
    if (big && big.isOpen() && big.symbol) {
      klines.push([big.symbol, big.interval === 'time' ? '1m' : big.interval === '5d' ? '5m' : big.interval]);
    }
    // 盘口/逐笔只有详情面板在看着才需要
    const wantBook = (big && big.isOpen())
      ? !!big.showDetail
      : (state.view === 'list' || !!state.detailOpen);
    // 订阅要跟着**正在看的那张图**走。大图里左右键翻品种时 state.selected 会同步，
    // 但 big.open() 也可能被别处直接调用（自选栏 / 扫描器 / E2E），
    // 那时候 selected 还停在旧标的上，盘口流就订错了币，面板会一直是空的
    const bookSym = (big && big.isOpen() && big.symbol) ? big.symbol : state.selected;
    api.sub({
      tickers: [...tickers],
      klines,
      depth: wantBook ? bookSym : null,
      trades: wantBook ? bookSym : null,
    });
  }, 180);
}

/* ------------------------------------------------------------------ 动画 */
/** 元素淡入一次（只做 opacity/transform，不动布局；260ms 后回收类名）
 *  不强制重排：这些元素都是从 display:none 切出来的，动画本来就会播；
 *  为了「重播」去读 offsetWidth 反而要多付一次全量布局。 */
function animateIn(el, cls = 'view-enter') {
  if (!el || el.classList.contains('hidden')) return;
  el.classList.remove(cls);
  el.classList.add(cls);
  clearTimeout(el._animTimer);
  el._animTimer = setTimeout(() => el.classList.remove(cls), 260);
}

/* ------------------------------------------------------------------ 图表墙详情侧板 */
function setGridDetail(on) {
  state.detailOpen = !!on;
  save();
  const wrap = $('#grid-wrap');
  const wasOn = wrap ? !wrap.classList.contains('dt-off') : false;
  if (wrap) wrap.classList.toggle('dt-off', !state.detailOpen);
  const sw = $('#grid-detail-switch');
  if (sw) sw.checked = state.detailOpen;
  if (state.detailOpen && grid && gridDetail) {
    const c = grid.cells[grid.focusIndex || 0];
    if (c && c.symbol) gridDetail.setSymbol(c.symbol);
    if (!wasOn) animateIn($('#grid-detail'), 'dt-enter');
  }
  if (grid) grid.resize();
  syncSubs();
}

/* ------------------------------------------------------------------ 列表页详情面板 */
function setListDetail(on) {
  state.listDetailOpen = !!on;
  save();
  const view = $('#view-list');
  if (view) view.classList.toggle('dt-off', !state.listDetailOpen);
  const btn = $('#list-detail-btn');
  if (btn) btn.classList.toggle('on', state.listDetailOpen);
  if (list) list.onShow();          // 重新算列宽
}

/** 拖动详情面板左边缘调宽 */
function bindDetailResize() {
  const h = $('#dt-resize');
  const d = $('#detail');
  if (!h || !d) return;

  // 恢复上次拖的宽度
  if (state.detailWidth) {
    d.style.width = state.detailWidth + 'px';
    d.style.flexBasis = state.detailWidth + 'px';
  }

  let startX = 0;
  let startW = 0;
  let dragging = false;

  h.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = d.getBoundingClientRect().width;
    h.setPointerCapture(e.pointerId);
    h.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  h.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // 往左拖变宽
    const w = Math.max(320, Math.min(920, startW - (e.clientX - startX)));
    d.style.width = w + 'px';
    d.style.flexBasis = w + 'px';
    state.detailWidth = w;
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    h.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    save();
    if (list) list.onShow();
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
}

/* ------------------------------------------------------------------ 大图模式 */
function openBig(sym, iv) {
  if (!big || !sym) return;
  // 从列表双击进来时，顺便把列表的选中行和右侧详情对齐，关掉大图不会看到对不上的状态
  if (state.view === 'list' && list) list.select(sym);
  state.selected = sym;
  save();
  setActiveSymbol(sym);
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
  setActiveSymbol(sym);
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
  animateIn(view === 'grid' ? $('#view-grid') : $('#view-list'));
  setActiveSymbol(state.selected);

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

  // 指标参数：整面墙 + 大图一起重算。序列按位置复用，只有周期变，不重建图表
  $('#ind-params-btn').addEventListener('click', (e) => {
    openParams(e.currentTarget, state.indParams, IND_DEFAULTS, (next) => {
      state.indParams = next;
      save();
      grid.setIndicators();
      for (const c of grid.cells) {
        if (!c.mounted || !c.times || !c.times.length) continue;
        c.renderHead();          // 爆量阈值改了就靠这里重判
        if (!c.intraday) c.renderLegend(c.times.length - 1);
      }
      if (big && big.isOpen() && big.cell && big.cell.times.length) {
        big.cell.recalcIndicators();
        big.cell.renderLegend(big.cell.times.length - 1);
      }
      toast('指标参数已更新');
    });
  });

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

  // 界面字体：菜单里直接标出本机装没装，避免"选了没反应"
  const fontBtn = $('#btn-font');
  if (fontBtn) {
    fontBtn.addEventListener('click', () => {
      const items = Object.keys(FONT_LABELS).map((k) => ({
        key: k,
        label: FONT_LABELS[k] + (fontAvailable(k) ? '' : '（未安装）'),
      }));
      openMenu(fontBtn, items, state.font, (k) => applyFont(k, true));
    });
  }

  $('#btn-alerts').addEventListener('click', () => {
    if (alerts.isOpen()) alerts.close();
    else alerts.open();
  });

  $('#list-detail-btn').addEventListener('click', () => setListDetail(!state.listDetailOpen));

  // 新币上架通知：默认只弹页面内提示，开了这个才弹系统通知（需要浏览器授权）
  const bell = $('#list-bell-btn');
  if (bell) {
    bell.classList.toggle('on', !!state.notify);
    bell.addEventListener('click', async () => {
      if (state.notify) {
        state.notify = false;
        save();
        bell.classList.remove('on');
        toast('已关闭系统通知');
        return;
      }
      if (!('Notification' in window)) {
        toast('这个浏览器不支持系统通知');
        return;
      }
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast('系统通知被拒绝，只保留页面内提示');
        return;
      }
      state.notify = true;
      save();
      bell.classList.add('on');
      toast('新品种上架时会弹系统通知');
    });
  }

  // 列表行高：三档预设，菜单里标出当前那档
  $('#list-rowh-btn').addEventListener('click', (e) => {
    const cur = String(state.rowH || 30);
    openMenu(e.currentTarget, [
      { key: '26', label: '紧凑' },
      { key: '30', label: '标准' },
      { key: '34', label: '宽松' },
    ], cur, (k) => {
      state.rowH = Number(k);
      save();
      list.setRowH(state.rowH);
    });
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
/** 新品种上架：页面内提示 + 可选的系统通知
 *  服务端只推一次，所以这里不再做去重；tag 用代码，同币多条会合并。 */
let newRefreshTimer = 0;
function notifyNewListing(it) {
  if (!it || !it.b) return;
  toast(`新品种上线：${it.b}`, {
    label: '看大图',
    onClick: () => openBig(it.s, state.interval),
  });
  if (state.notify && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(`新品种上线：${it.b}`, {
        body: `${it.s} 刚上架，点这里看行情`,
        tag: 'new-' + it.b,
      });
      n.onclick = () => {
        window.focus();
        openBig(it.s, state.interval);
        n.close();
      };
    } catch (e) { /* 系统通知被拦（比如勿扰模式），页面内提示已经弹过了 */ }
  }
  // 一次上好几个时别连着拉几次快照
  clearTimeout(newRefreshTimer);
  newRefreshTimer = setTimeout(refreshMarket, 500);
}

/** 拉一次全量快照并重建列表（定时轮询和「新币归类」事件共用） */
async function refreshMarket() {
  try {
    const d = await api.market();
    seedMarket(d.rows);
    setSectorLabels(d.labels);
    setRegionLabels(d.regions);
    list.setLabels();
    list.rebuild(false);
    updateSectorBtn();
    if (watch) watch.render();
    if (!tapeRefs.size) buildTape();
  } catch (e) { /* 网络抖动忽略，等下一轮 */ }
}

async function boot() {
  applyTheme(state.theme, false);
  // 换了机器 / 首次运行：选中的字体不存在就落到雅黑，
  // 免得菜单里勾着「苹方（未安装）」而屏幕上是别的字体
  if (state.font === 'pingfang' && !hasFont('PingFang SC')) state.font = 'yahei';
  applyFont(state.font, false);

  // 行情快照先发出去。GridView 一构造就会给 8 个格子发 K 线请求，
  // 不抢先发的话 /api/market 会被挤到第 9 位，表头数字要等 1 秒才出来。
  // 桌面版现在会"先开窗口再等服务起来"，所以这里要能在服务还没监听时等一会儿。
  const marketReq = (async () => {
    let lastErr = null;
    for (let i = 0; i < 16; i++) {
      try {
        return await api.market();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    throw lastErr;
  })();

  grid = new GridView($('#grid'), {
    onCellsChanged: syncSubs,
    // 图表墙的板块选择会改写 mkt/tab/sector，列表要跟着刷新
    onFilterChanged: () => { if (list) list.syncFilterUI(); },
    onFocus: (sym) => {
      state.selected = sym;
      save();
      setActiveSymbol(sym);
      showInGridDetail(sym);
    },
    // 双击格子 / Enter：进大图
    onOpenBig: (sym, iv) => openBig(sym, iv),
  });
  list = new ListView($('#view-list'), {
    onSelect: (sym) => {
      detail.setSymbol(sym);
      syncSubs();
      setActiveSymbol(sym);
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
      setActiveSymbol(sym);
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
    toast,
  });
  // 自选变了就重算订阅：清空之后不该继续挂着那些行情流
  window.addEventListener('favchange', () => syncSubs());
  setActiveSymbol(state.selected);
  document.querySelector('.app').classList.toggle('watch-off', !state.watchOpen);
  setListDetail(state.listDetailOpen);
  bindDetailResize();

  bindToolbar();
  bindTape();
  markActive();
  updateSectorBtn();
  updateRowsBtn();
  setGridDetail(state.detailOpen);
  grid.cells.forEach((c) => c.syncTools());

  // 首屏行情（上面已经发出去了）
  try {
    const data = await marketReq;
    seedMarket(data.rows);
    setSectorLabels(data.labels);
    setRegionLabels(data.regions);
    buildTape();
    list.setLabels();
    list.rebuild(true);
    if (watch) { watch.render(); setActiveSymbol(state.selected); }
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
        // 服务端给新上架的币补上了板块分类：立刻刷新列表，不等 30 秒轮询
        case 'sec': {
          const names = Object.keys(msg.d || {});
          if (names.length) {
            const first = names.slice(0, 3).map((b) => {
              const secs = (msg.d[b] || []).map((k) => sectorLabels[k] || k);
              return secs.length ? `${b}（${secs.join('/')}）` : b;
            }).join('、');
            toast(`新币已归类：${first}${names.length > 3 ? ` 等 ${names.length} 个` : ''}`);
          }
          refreshMarket();
          break;
        }
        // 服务端给已归类的股票合约补上了市场归属：重拉快照即可（很少发生）
        case 'reg': refreshMarket(); break;
        // 新品种上线：页面内提示 + （开了的话）系统通知
        case 'new': (msg.d || []).forEach(notifyNewListing); break;
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

  window.__term = {
    grid, list, detail, gridDetail, big, scanner, alerts, state, market, syncSubs,
    notifyNewListing,          // 调试/回归用：手动触发一次「新品种上线」
  };

  setTimeout(() => {
    const sp = $('#splash');
    if (sp) {
      sp.classList.add('gone');
      setTimeout(() => sp.remove(), 400);
    }
  }, 320);

  // 每 30 秒补一次全量快照，兜住漏掉的币种
  setInterval(refreshMarket, 30000);
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
