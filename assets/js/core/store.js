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

/** 指标参数默认值（「恢复默认」用，也让 cell.js 有单一事实来源） */
export const IND_DEFAULTS = Object.freeze({
  ma: [5, 52, 200],
  ema: 200,
  boll: 20,
  bollMult: 2,
  macd: [12, 26, 9],
  spike: 3,          // 爆量阈值：本根成交额 ≥ 前 20 根均额的 N 倍
});

const DEFAULT_FAVS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

const DEFAULTS = {
  view: 'grid',
  theme: 'light',
  font: 'pingfang',    // 界面字体：pingfang / yahei / system
  watchOpen: true,     // 左侧自选栏
  layout: '4x2',
  rows: 0,             // 0=跟随布局行数，N=固定 N 行，-1=铺满当前筛选的全部品种
  interval: '1m',
  bcInterval: '1d',     // 大图自己的周期（默认日线，和格子墙的周期分开记）
  indicators: { ma: true, vol: true, macd: true, boll: false },
  // 指标参数：三条 SMA + 一条 EMA、BOLL 周期/倍数、MACD 快慢信号
  indParams: { ...IND_DEFAULTS, ma: [...IND_DEFAULTS.ma], macd: [...IND_DEFAULTS.macd] },
  sync: true,
  detailOpen: true,    // 多品种同列右侧详情侧板（默认打开）
  bcDetailOpen: true,  // 大图右侧盘口栏（默认打开）
  listDetailOpen: true, // 列表页右侧详情（默认打开）
  detailWidth: 0,       // 拖动调过的宽度，0 = 按 CSS 自适应
  bcDetailWidth: 0,     // 大图右侧盘口栏的宽度，0 = 按 CSS（320/286）
  rowH: 30,             // 列表行高（px），和 CSS 的 --row-h 必须一致
  cells: DEFAULT_SYMBOLS.slice(0, 8),
  // 自选分组：favs 只是「当前分组」的别名，真正的数据在 favGroups 里
  favGroups: [{ id: 'g1', name: '自选', list: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] }],
  favGroup: 'g1',
  selected: 'BTCUSDT',
  mkt: 'all',          // 最大分类：all / spot / perp
  tab: 'all',
  sector: null,
  region: null,        // 股票市场细分：US / HK / CN / KR / JP，null = 不限
  notify: false,       // 新币上架是否弹系统通知（页面内提示始终有）
  cvd: true,           // 大图是否叠加 CVD（累计买卖差），默认开
  gridSector: 'all',
  colOrder: null,
  search: '',
  sort: { key: 'qv', dir: -1 },
  alert: { on: false, thr: 0.05, sys: false },   // 资金费率告警：绝对值 ≥ thr% 时提醒，sys=系统通知
};

/** 老版本只有 favs 数组，升级时包成第一个分组 */
function normalizeGroups(saved) {
  const src = Array.isArray(saved.favGroups) ? saved.favGroups : [];
  const groups = [];
  const seen = new Set();
  for (const g of src) {
    if (!g || typeof g.id !== 'string' || seen.has(g.id)) continue;
    seen.add(g.id);
    groups.push({
      id: g.id,
      name: String(g.name || '自选').slice(0, 12),
      list: Array.isArray(g.list) ? g.list.filter((x) => typeof x === 'string') : [],
    });
  }
  if (groups.length) return groups;
  const legacy = Array.isArray(saved.favs) ? saved.favs.filter((x) => typeof x === 'string') : null;
  return [{ id: 'g1', name: '自选', list: legacy || [...DEFAULT_FAVS] }];
}

/** 让 state.favs 指向当前分组那个数组。
 *  是**别名**不是拷贝：别处拿到 state.favs 后原地 push / length=0 才写得到分组上。 */
function withActiveFavs(st) {
  if (!Array.isArray(st.favGroups) || !st.favGroups.length) {
    st.favGroups = [{ id: 'g1', name: '自选', list: [...DEFAULT_FAVS] }];
  }
  const cur = st.favGroups.find((g) => g.id === st.favGroup) || st.favGroups[0];
  st.favGroup = cur.id;
  st.favs = cur.list;
  return st;
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return withActiveFavs({ ...DEFAULTS, cells: [...DEFAULTS.cells],
      favGroups: DEFAULTS.favGroups.map((g) => ({ ...g, list: [...g.list] })) });
    const saved = JSON.parse(raw);
    if (saved.tab === 'stock') saved.tab = 'tradfi';   // 旧版本字段迁移
    if (saved.tab === 'perp') {                        // 永续从页签升级为一级分类
      saved.mkt = 'perp';
      saved.tab = 'all';
    }
    // v2：两个侧栏改成默认打开。老用户 localStorage 里存的是 false，
    // 迁一次，之后就按用户自己的选择走
    if (!saved.uiV || saved.uiV < 2) {
      saved.detailOpen = true;
      saved.bcDetailOpen = true;
      saved.uiV = 2;
    }
    // v3：详情面板改回一列，之前拖宽的像素值作废
    if (!saved.uiV || saved.uiV < 3) {
      saved.detailWidth = 0;
      saved.uiV = 3;
    }
    const out = {
      ...DEFAULTS, ...saved,
      indicators: { ...DEFAULTS.indicators, ...(saved.indicators || {}) },
      indParams: { ...DEFAULTS.indParams, ...(saved.indParams || {}) },
      sort: { ...DEFAULTS.sort, ...(saved.sort || {}) },
      alert: { ...DEFAULTS.alert, ...(saved.alert || {}) },
      alert: { ...DEFAULTS.alert, ...(saved.alert || {}) },
      cells: Array.isArray(saved.cells) && saved.cells.length ? saved.cells : [...DEFAULTS.cells],
      favGroups: normalizeGroups(saved),
    };
    return withActiveFavs(out);
  } catch (e) {
    return withActiveFavs({ ...DEFAULTS, cells: [...DEFAULTS.cells],
      favGroups: DEFAULTS.favGroups.map((g) => ({ ...g, list: [...g.list] })) });
  }
}

export const state = load();

let saveTimer = 0;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        view: state.view, theme: state.theme, font: state.font,
        watchOpen: state.watchOpen,
        layout: state.layout, rows: state.rows,
        interval: state.interval, bcInterval: state.bcInterval, indicators: state.indicators,
        indParams: state.indParams,
        sync: state.sync, cells: state.cells, favs: state.favs,
        favGroups: state.favGroups, favGroup: state.favGroup,
        detailOpen: state.detailOpen,
        selected: state.selected, mkt: state.mkt, tab: state.tab, sector: state.sector,
        region: state.region, notify: state.notify, cvd: state.cvd,
        gridSector: state.gridSector, colOrder: state.colOrder, sort: state.sort,
        alert: state.alert, uiV: 3,
        listDetailOpen: state.listDetailOpen, detailWidth: state.detailWidth,
        bcDetailWidth: state.bcDetailWidth,
        rowH: state.rowH,
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

/** 股票市场细分（美股/港股/A股/韩股/日股）。和板块标签一样是「包含」语义，
 *  一个标的可能同时属于两个市场（比如 A+H 两地上市）。 */
export function matchRegion(row, region) {
  if (!region) return true;
  return (row.reg || []).includes(region);
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

/* 股票市场细分标签与顺序（由服务端下发） */
export let regionLabels = {};
export let regionOrder = ['US', 'HK', 'CN', 'KR', 'JP'];
export function setRegionLabels(meta) {
  if (!meta) return;
  if (meta.labels && Object.keys(meta.labels).length) regionLabels = meta.labels;
  if (Array.isArray(meta.order) && meta.order.length) regionOrder = meta.order;
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

/** 清空自选，返回清掉的个数（撤销用） */
export function clearFavs() {
  const n = state.favs.length;
  if (!n) return 0;
  state.favs.length = 0;          // 保持数组引用不变，别处拿着的还是同一个
  save();
  window.dispatchEvent(new CustomEvent('favchange', { detail: null }));
  return n;
}

/** 恢复一组自选（撤销清空） */
export function setFavs(list) {
  state.favs.length = 0;
  for (const s of list || []) if (!state.favs.includes(s)) state.favs.push(s);
  save();
  window.dispatchEvent(new CustomEvent('favchange', { detail: null }));
}

/* ---------------------------------------------------------------- 自选分组 */

export function currentFavGroup() {
  return state.favGroups.find((g) => g.id === state.favGroup) || state.favGroups[0];
}

function emitFavs() {
  window.dispatchEvent(new CustomEvent('favchange', { detail: null }));
}

/** 切分组。favs 要重新指向新分组的数组，否则后续增删会写回上一个分组 */
export function setFavGroup(id) {
  const g = state.favGroups.find((x) => x.id === id);
  if (!g || g.id === state.favGroup) return false;
  state.favGroup = g.id;
  state.favs = g.list;
  save();
  emitFavs();
  return true;
}

export function addFavGroup(name) {
  const nm = String(name || '').trim().slice(0, 12) || '新分组';
  let id = '';
  do {
    id = 'g' + Math.random().toString(36).slice(2, 7);
  } while (state.favGroups.some((g) => g.id === id));
  const g = { id, name: nm, list: [] };
  state.favGroups.push(g);
  state.favGroup = id;
  state.favs = g.list;
  save();
  emitFavs();
  return g;
}

export function renameFavGroup(id, name) {
  const g = state.favGroups.find((x) => x.id === id);
  const nm = String(name || '').trim().slice(0, 12);
  if (!g || !nm || g.name === nm) return false;
  g.name = nm;
  save();
  emitFavs();
  return true;
}

/** 删分组：只剩一个时拒绝（否则用户会掉进"没有自选栏"的状态） */
export function removeFavGroup(id) {
  if (state.favGroups.length <= 1) return false;
  const i = state.favGroups.findIndex((g) => g.id === id);
  if (i < 0) return false;
  const wasCurrent = state.favGroups[i].id === state.favGroup;
  state.favGroups.splice(i, 1);
  if (wasCurrent) {
    state.favGroup = state.favGroups[0].id;
    state.favs = state.favGroups[0].list;
  }
  save();
  emitFavs();
  return true;
}

/** 撤销删除：把分组原样放回原来的位置 */
export function restoreFavGroup(group, index) {
  if (!group || !group.id || state.favGroups.some((g) => g.id === group.id)) return false;
  const at = Math.max(0, Math.min(Number(index) || 0, state.favGroups.length));
  state.favGroups.splice(at, 0, {
    id: group.id,
    name: String(group.name || '自选').slice(0, 12),
    list: Array.isArray(group.list) ? group.list.slice() : [],
  });
  save();
  emitFavs();
  return true;
}

/** 把品种加进指定分组（已存在就忽略），不切换当前分组 */
export function addFavTo(sym, gid) {
  const g = state.favGroups.find((x) => x.id === gid);
  if (!g || g.list.includes(sym)) return false;
  g.list.push(sym);
  save();
  emitFavs();
  return true;
}
