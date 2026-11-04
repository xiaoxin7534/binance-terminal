/* 全局状态 + 行情内存表 + 帧内批量更新 */

const LS_KEY = 'binance-terminal.v1';

export const DEFAULT_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
  'SUIUSDT', 'AVAXUSDT', 'LINKUSDT', '1000PEPEUSDT', 'ADAUSDT', 'TONUSDT',
];

export const TAPE_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'SUIUSDT', 'AVAXUSDT',
];

const DEFAULTS = {
  view: 'grid',
  theme: 'light',
  watchOpen: true,     // 左侧自选栏
  layout: '4x2',
  rows: 0,             // 0=跟随布局行数，N=固定 N 行，-1=铺满当前筛选的全部品种
  interval: '1m',
  indicators: { ma: true, vol: true, macd: true, boll: false },
  sync: true,
  detailOpen: false,   // 图表墙右侧详情侧板（默认收起，4×2 时开着会压窄每格）
  cells: DEFAULT_SYMBOLS.slice(0, 8),
  favs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  selected: 'BTCUSDT',
  mkt: 'all',          // 最大分类：all / spot / perp
  tab: 'all',
  sector: null,
  gridSector: 'all',
  colOrder: null,
  search: '',
  sort: { key: 'qv', dir: -1 },
  alert: { on: false, thr: 0.05 },   // 资金费率告警：绝对值 ≥ thr% 时提醒
};

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS, cells: [...DEFAULTS.cells], favs: [...DEFAULTS.favs] };
    const saved = JSON.parse(raw);
    if (saved.tab === 'stock') saved.tab = 'tradfi';   // 旧版本字段迁移
    if (saved.tab === 'perp') {                        // 永续从页签升级为一级分类
      saved.mkt = 'perp';
      saved.tab = 'all';
    }
    return {
      ...DEFAULTS, ...saved,
      indicators: { ...DEFAULTS.indicators, ...(saved.indicators || {}) },
      sort: { ...DEFAULTS.sort, ...(saved.sort || {}) },
      cells: Array.isArray(saved.cells) && saved.cells.length ? saved.cells : [...DEFAULTS.cells],
      favs: Array.isArray(saved.favs) ? saved.favs : [...DEFAULTS.favs],
    };
  } catch (e) {
    return { ...DEFAULTS, cells: [...DEFAULTS.cells], favs: [...DEFAULTS.favs] };
  }
}

export const state = load();

let saveTimer = 0;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        view: state.view, theme: state.theme, watchOpen: state.watchOpen,
        layout: state.layout, rows: state.rows,
        interval: state.interval, indicators: state.indicators,
        sync: state.sync, cells: state.cells, favs: state.favs,
        detailOpen: state.detailOpen,
        selected: state.selected, mkt: state.mkt, tab: state.tab, sector: state.sector,
        gridSector: state.gridSector, colOrder: state.colOrder, sort: state.sort,
        alert: state.alert,
      }));
    } catch (e) { /* 隐私模式下忽略 */ }
  }, 250);
}

/* ---------------------------------------------------------------- 行情表 */

export const market = new Map();
export let marketVersion = 0;

export function seedMarket(rows) {
  const keep = new Set();
  for (const r of rows) {
    keep.add(r.s);
    const old = market.get(r.s);
    market.set(r.s, old ? { ...r, dir: old.dir } : { ...r, dir: 0 });
  }
  // 服务端过滤掉的（稳定币等）或已下架的，从本地表里剔除
  for (const sym of [...market.keys()]) {
    if (!keep.has(sym)) market.delete(sym);
  }
  marketVersion++;
}

const listeners = new Set();
export function onFrame(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let dirty = new Set();
let scheduled = false;
let structural = false;

function flush() {
  scheduled = false;
  const d = dirty;
  dirty = new Set();
  const st = structural;
  structural = false;
  if (st) marketVersion++;
  for (const fn of listeners) fn(d, st);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(flush);
}

export function applyTicks(batch) {
  for (let i = 0; i < batch.length; i++) {
    const [s, l, chgp, h, lo, v, qv, spd] = batch[i];
    const r = market.get(s);
    // 不在表里的币种由 30 秒一次的快照补进来，避免把服务端过滤掉的稳定币又加回来
    if (!r) continue;
    r.dir = l > r.l ? 1 : l < r.l ? -1 : 0;
    r.l = l;
    r.chgp = chgp;
    r.h = h;
    r.lo = lo;
    r.v = v;
    r.qv = qv;
    r.wavg = v ? qv / v : l;
    if (spd !== undefined) r.spd = spd;
    dirty.add(s);
  }
  schedule();
}

/** 资金费率推送：服务端每分钟只发发生变化的合约，[sym@f, 费率%, 下次结算ms] */
export function applyFunding(items) {
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const [s, fr, nft] = items[i];
    const r = market.get(s);
    if (!r) continue;
    r.fr = fr;
    r.nft = nft;
    dirty.add(s);
    n++;
  }
  if (n) schedule();
}

export const SECTOR_KEYS = ['AI', 'L1', 'RWA', 'L2', 'GAME', 'MEME', 'INFRA', 'DEFI', 'META'];

/** 列表页签里"非板块"的那几个（用于板块菜单和 fillSector 判断 key 的类型） */
export const TAB_KEYS = ['crypto', 'tradfi', 'preipo', 'premarket', 'usdc', 'new', 'chinese'];

export function isTabKey(k) {
  return TAB_KEYS.includes(k);
}

const NEW_MS = 180 * 86400000;

/** 列表页签 / 图表墙板块共用的筛选逻辑 */
export function matchTab(row, tab) {
  if (!tab || tab === 'all') return true;
  const sec = row.sec || [];
  switch (tab) {
    case 'fav': return state.favs.includes(row.s);
    case 'new': return !!(row.ln && Date.now() - row.ln < NEW_MS);
    case 'crypto': return !sec.includes('TRADFI') && !sec.includes('PREIPO') && !sec.includes('PREMARKET');
    case 'tradfi': return sec.includes('TRADFI');
    case 'preipo': return sec.includes('PREIPO');
    case 'premarket': return sec.includes('PREMARKET');
    case 'usdc': return row.q === 'USDC';
    case 'perp': return row.mkt === 'perp';
    case 'chinese': return sec.includes('CHINESE');
    default: return sec.includes(tab);
  }
}

/** 一级分类：现货 / 永续 */
export function matchMkt(row, mkt) {
  if (!mkt || mkt === 'all') return true;
  return (row.mkt || 'spot') === mkt;
}

export function dpOf(sym) {
  const r = market.get(sym);
  if (!r) return 2;
  return r.dp ?? 2;
}

export function rowOf(sym) {
  return market.get(sym);
}

/* 板块标签（由服务端下发） */
export let sectorLabels = {};
export function setSectorLabels(labels) {
  if (labels && Object.keys(labels).length) sectorLabels = labels;
}

export function isFav(sym) {
  return state.favs.includes(sym);
}

export function toggleFav(sym) {
  const i = state.favs.indexOf(sym);
  if (i >= 0) state.favs.splice(i, 1);
  else state.favs.push(sym);
  save();
  window.dispatchEvent(new CustomEvent('favchange', { detail: sym }));
}
