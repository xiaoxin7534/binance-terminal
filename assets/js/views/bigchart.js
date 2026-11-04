/* 大图模式：单品种全屏图 + 绘图工具 + 十字光标明细
 *
 * 图表本体直接复用 grid.js 的 Cell（detached 模式）——指标、分时、K线缓存、
 * 实时增量、主题切换全都跟着走，这里只补三样东西：
 *   1. 顶部工具栏（币种 / 周期 / 指标 / 绘图）
 *   2. 十字光标明细行（开高低收 / 涨跌 / 量）
 *   3. 绘图图层（canvas 叠在图表上，坐标靠 timeToCoordinate / priceToCoordinate 换算）
 */

import { api } from '../core/api.js';
import { state, market, dpOf } from '../core/store.js';
import { fmtPrice, fmtPct, fmtCompact, dirClass, symLabel } from '../core/fmt.js';
import { Cell } from './cell.js';
import { DetailPanel } from './detail.js';

const DRAW_KEY = 'binance-terminal.drawings.v1';
const IVS = ['time', '1m', '5m', '15m', '1h', '4h', '1d'];
const wsIv = (iv) => (iv === 'time' ? '1m' : iv);
const pad2 = (n) => String(n).padStart(2, '0');

const TOOLS = ['cursor', 'trend', 'hline', 'rect', 'fib'];
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function loadDrawings() {
  try {
    const raw = localStorage.getItem(DRAW_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

function saveDrawings(all) {
  try {
    localStorage.setItem(DRAW_KEY, JSON.stringify(all));
  } catch (e) { /* 隐私模式下忽略 */ }
}

const cv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ==================================================================== 绘图层 */

class DrawLayer {
  constructor(cell, host) {
    this.cell = cell;
    this.host = host;
    this.el = document.createElement('canvas');
    this.el.className = 'bc-draw-layer';
    host.appendChild(this.el);
    this.g = this.el.getContext('2d');

    this.items = [];
    this.tool = null;      // null = 光标模式
    this.draft = null;
    this.dragging = false;
    this.drag = null;      // 光标模式下拖动已有图元的端点
    this.sel = -1;
    this.key = '';
    this.raf = 0;
    this.undoStack = [];

    this.onDown = this.onDown.bind(this);
    this.onMove = this.onMove.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onClick = this.onClick.bind(this);

    host.addEventListener('pointerdown', this.onDown, true);
    host.addEventListener('pointermove', this.onMove, true);
    host.addEventListener('pointerup', this.onUp, true);
    host.addEventListener('pointercancel', this.onUp, true);
    host.addEventListener('click', this.onClick, true);

    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(host);
  }

  destroy() {
    this.ro.disconnect();
    this.host.removeEventListener('pointerdown', this.onDown, true);
    this.host.removeEventListener('pointermove', this.onMove, true);
    this.host.removeEventListener('pointerup', this.onUp, true);
    this.host.removeEventListener('pointercancel', this.onUp, true);
    this.host.removeEventListener('click', this.onClick, true);
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  /* ---------------- 坐标 ---------------- */
  xOf(t) {
    const chart = this.cell && this.cell.chart;
    if (!chart || t == null) return null;
    try {
      const x = chart.timeScale().timeToCoordinate(t);
      return typeof x === 'number' && isFinite(x) ? x : null;
    } catch (e) { return null; }
  }

  yOf(p) {
    const c = this.cell;
    if (!c || !c.candle || p == null) return null;
    try {
      const y = c.candle.priceToCoordinate(p);
      return typeof y === 'number' && isFinite(y) ? y : null;
    } catch (e) { return null; }
  }

  pointAt(e) {
    const c = this.cell;
    if (!c || !c.chart || !c.candle) return null;
    const rect = this.host.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    try {
      const t = c.chart.timeScale().coordinateToTime(x);
      const p = c.candle.coordinateToPrice(y);
      if (t == null || p == null || !isFinite(p)) return null;
      return { t, p };
    } catch (err) { return null; }
  }

  /* ---------------- 数据 ---------------- */
  setKey(key) {
    this.key = key;
    const all = loadDrawings();
    this.items = Array.isArray(all[key]) ? all[key].slice() : [];
    this.sel = -1;
    this.schedule();
  }

  persist() {
    const all = loadDrawings();
    if (this.items.length) all[this.key] = this.items;
    else delete all[this.key];
    saveDrawings(all);
  }

  setTool(tool) {
    this.tool = tool && tool !== 'cursor' ? tool : null;
    this.draft = null;
    this.dragging = false;
    this.sel = -1;
    this.schedule();
  }

  /* ---------------- 撤销 ---------------- */
  pushUndo() {
    this.undoStack.push(JSON.stringify(this.items));
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  undo() {
    if (!this.undoStack.length) return false;
    const snap = this.undoStack.pop();
    try {
      this.items = JSON.parse(snap) || [];
    } catch (e) {
      return false;
    }
    this.sel = -1;
    this.persist();
    this.schedule();
    return true;
  }

  clearAll() {
    if (!this.items.length) return;
    this.pushUndo();
    this.items = [];
    this.sel = -1;
    this.persist();
    this.schedule();
  }

  removeSelected() {
    if (this.sel < 0 || this.sel >= this.items.length) return false;
    this.pushUndo();
    this.items.splice(this.sel, 1);
    this.sel = -1;
    this.persist();
    this.schedule();
    return true;
  }

  /* ---------------- 交互 ---------------- */
  onDown(e) {
    if (e.button !== 0) return;
    const pt = this.pointAt(e);
    if (!pt) return;

    // 光标模式：抓住端点就拖动改图元，否则交给图表平移
    if (!this.tool) {
      const box = this.host.getBoundingClientRect();
      const h = this.hitHandle(e.clientX - box.left, e.clientY - box.top);
      if (!h) return;
      e.preventDefault();
      e.stopPropagation();
      this.pushUndo();
      this.drag = { i: h.i, which: h.which };
      this.sel = h.i;
      this.schedule();
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    this.draft = { type: this.tool, p1: pt, p2: { t: pt.t, p: pt.p } };
    this.dragging = true;
    this.schedule();
  }

  onMove(e) {
    if (this.drag) {
      const pt = this.pointAt(e);
      if (!pt) return;
      e.preventDefault();
      e.stopPropagation();
      const it = this.items[this.drag.i];
      if (!it) return;
      if (it.type === 'hline') {
        it.p1 = pt;
        if (it.p2) it.p2 = { t: pt.t, p: pt.p };
      } else if (this.drag.which === 'p1') {
        it.p1 = pt;
      } else {
        it.p2 = pt;
      }
      this.schedule();
      return;
    }
    if (!this.dragging || !this.draft) return;
    const pt = this.pointAt(e);
    if (!pt) return;
    e.preventDefault();
    e.stopPropagation();
    this.draft.p2 = pt;
    this.schedule();
  }

  onUp(e) {
    if (this.drag) {
      this.drag = null;
      e.preventDefault();
      e.stopPropagation();
      this.persist();
      this.schedule();
      return;
    }
    if (!this.dragging) return;
    this.dragging = false;
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const flat = Math.abs(d.p2.p - d.p1.p) < 1e-12 && d.p2.t === d.p1.t;
    if (d.type === 'hline' || !flat) {
      this.pushUndo();
      this.items.push(d);
      this.persist();
    }
    this.schedule();
  }

  /** 光标位置附近有没有可拖的端点 / 水平线 */
  hitHandle(x, y) {
    const TOL = 8;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const y1 = this.yOf(it.p1.p);
      if (y1 == null) continue;
      if (it.type === 'hline') {
        if (Math.abs(y - y1) <= TOL) return { i, which: 'p1' };
        continue;
      }
      const x1 = this.xOf(it.p1.t);
      if (x1 != null && Math.hypot(x - x1, y - y1) <= TOL) return { i, which: 'p1' };
      const x2 = this.xOf(it.p2 && it.p2.t);
      const y2 = this.yOf(it.p2 && it.p2.p);
      if (x2 != null && y2 != null && Math.hypot(x - x2, y - y2) <= TOL) return { i, which: 'p2' };
    }
    return null;
  }

  /** 光标模式下点一下：命中已有图元就选中，方便 Delete 删除 */
  onClick(e) {
    if (this.tool) return;
    const rect = this.host.getBoundingClientRect();
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit !== this.sel) {
      this.sel = hit;
      this.schedule();
    }
  }

  hitTest(x, y) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.nearItem(this.items[i], x, y)) return i;
    }
    return -1;
  }

  nearItem(it, x, y) {
    const TOL = 6;
    const x1 = this.xOf(it.p1.t);
    const y1 = this.yOf(it.p1.p);
    if (x1 == null || y1 == null) return false;
    if (it.type === 'hline') return Math.abs(y - y1) <= TOL;

    const x2 = this.xOf(it.p2 && it.p2.t);
    const y2 = this.yOf(it.p2 && it.p2.p);
    if (x2 == null || y2 == null) return false;

    if (it.type === 'trend') return distToSeg(x, y, x1, y1, x2, y2) <= TOL;
    if (it.type === 'rect') {
      const l = Math.min(x1, x2);
      const r = Math.max(x1, x2);
      const t = Math.min(y1, y2);
      const b = Math.max(y1, y2);
      const nearEdge = (Math.abs(x - l) <= TOL && y >= t - TOL && y <= b + TOL)
        || (Math.abs(x - r) <= TOL && y >= t - TOL && y <= b + TOL)
        || (Math.abs(y - t) <= TOL && x >= l - TOL && x <= r + TOL)
        || (Math.abs(y - b) <= TOL && x >= l - TOL && x <= r + TOL);
      return nearEdge || (x > l && x < r && y > t && y < b);
    }
    if (it.type === 'fib') {
      for (const lv of FIB_LEVELS) {
        const yy = y1 + (y2 - y1) * lv;
        if (Math.abs(y - yy) <= TOL) return true;
      }
    }
    return false;
  }

  /* ---------------- 渲染 ---------------- */
  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render() {
    const host = this.host;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.el.width !== Math.round(w * dpr) || this.el.height !== Math.round(h * dpr)) {
      this.el.width = Math.round(w * dpr);
      this.el.height = Math.round(h * dpr);
      this.el.style.width = w + 'px';
      this.el.style.height = h + 'px';
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!this.items.length && !this.draft) return;

    const accent = cv('--accent') || '#2563eb';
    const text = cv('--text-2') || '#49525d';
    const panel = cv('--panel') || '#fff';

    for (let i = 0; i < this.items.length; i++) {
      this.paint(this.items[i], i === this.sel, { w, h, accent, text, panel });
    }
    if (this.draft) this.paint(this.draft, false, { w, h, accent, text, panel });
  }

  paint(it, sel, S) {
    const g = this.g;
    const dp = dpOf(this.cell.symbol);
    const x1 = this.xOf(it.p1.t);
    const y1 = this.yOf(it.p1.p);
    if (x1 == null || y1 == null) return;

    g.save();
    g.strokeStyle = S.accent;
    g.fillStyle = S.accent;
    g.lineWidth = sel ? 2.2 : 1.4;
    g.setLineDash([]);

    if (it.type === 'hline') {
      g.beginPath();
      g.moveTo(0, y1 + 0.5);
      g.lineTo(S.w, y1 + 0.5);
      g.stroke();
      // 右侧 60px 是价格轴，标签往左让开，别压在刻度上
      this.tag(g, S.w - 66, y1, fmtPrice(it.p1.p, dp), S, 'right');
      g.restore();
      return;
    }

    const x2 = this.xOf(it.p2 && it.p2.t);
    const y2 = this.yOf(it.p2 && it.p2.p);
    if (x2 == null || y2 == null) { g.restore(); return; }

    if (it.type === 'trend') {
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      if (sel) {
        this.dot(x1, y1, S.accent);
        this.dot(x2, y2, S.accent);
      }
    } else if (it.type === 'rect') {
      const l = Math.min(x1, x2);
      const t = Math.min(y1, y2);
      const rw = Math.abs(x2 - x1);
      const rh = Math.abs(y2 - y1);
      g.globalAlpha = 0.09;
      g.fillRect(l, t, rw, rh);
      g.globalAlpha = 1;
      g.strokeRect(l + 0.5, t + 0.5, rw, rh);
      if (sel) {
        this.dot(x1, y1, S.accent);
        this.dot(x2, y2, S.accent);
      }
    } else if (it.type === 'fib') {
      const up = it.p2.p >= it.p1.p;
      for (const lv of FIB_LEVELS) {
        const price = it.p1.p + (it.p2.p - it.p1.p) * lv;
        const y = this.yOf(price);
        if (y == null) continue;
        g.setLineDash(lv === 0 || lv === 1 ? [] : [4, 3]);
        g.lineWidth = sel ? 1.6 : 1;
        g.beginPath();
        g.moveTo(Math.min(x1, x2), y + 0.5);
        g.lineTo(Math.max(x1, x2), y + 0.5);
        g.stroke();
        g.setLineDash([]);
        this.tag(g, Math.max(x1, x2) + 6, y, `${lv.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}  ${fmtPrice(price, dp)}`, S, 'left');
      }
      // 0→1 的连线，方便看清方向
      g.globalAlpha = 0.5;
      g.setLineDash([2, 4]);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
      if (up && sel) { this.dot(x1, y1, S.accent); this.dot(x2, y2, S.accent); }
    }
    g.restore();
  }

  dot(x, y, color) {
    const g = this.g;
    g.save();
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  /** 右侧 / 左侧的小价格标签 */
  tag(g, x, y, text, S, align) {
    g.save();
    g.font = '10px ui-monospace, Consolas, monospace';
    const w = g.measureText(text).width + 8;
    const bx = align === 'right' ? x - w : x;
    const by = y - 14;
    g.globalAlpha = 0.92;
    g.fillStyle = S.panel;
    g.beginPath();
    g.roundRect ? g.roundRect(bx, by, w, 13, 3) : g.rect(bx, by, w, 13);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = S.text;
    g.textBaseline = 'middle';
    g.fillText(text, bx + 4, by + 7);
    g.restore();
  }
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  if (!len) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* ==================================================================== 大图 */

export class BigChart {
  constructor(root, ctx = {}) {
    this.root = root;
    this.ctx = ctx;
    this.symbol = null;
    this.interval = '1m';
    this.cell = null;
    this.draw = null;
    this.boundChart = null;
    this.hoverIdx = -1;
    this.showDetail = false;
    this.oiOn = false;
    this.oiSeries = null;
    this.oiData = null;

    this.body = root.querySelector('.bc-body');
    this.detailPanel = new DetailPanel(root.querySelector('#bc-detail'), { delay: 0 });
    this.infoEl = root.querySelector('#bc-info');
    this.pxEl = root.querySelector('#bc-px');
    this.chgEl = root.querySelector('#bc-chg');
    this.symEl = root.querySelector('#bc-sym');
    this.tagEl = root.querySelector('#bc-tag');
    this.ivBar = root.querySelector('#bc-iv');
    this.indBar = root.querySelector('#bc-ind');
    this.toolBar = root.querySelector('#bc-draw');

    this.bindBar();
  }

  isOpen() {
    return !this.root.classList.contains('hidden');
  }

  /* ---------------- 顶部栏 ---------------- */
  bindBar() {
    this.root.querySelector('#bc-back').addEventListener('click', () => this.close());
    this.root.querySelector('#bc-close').addEventListener('click', () => this.close());
    this.root.querySelector('#bc-oi-btn').addEventListener('click', () => this.setOI(!this.oiOn));
    this.root.querySelector('#bc-detail-btn').addEventListener('click', () => {
      this.setDetail(!this.showDetail);
      if (this.ctx.onDetailToggle) this.ctx.onDetailToggle(this.showDetail);
    });

    this.ivBar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-iv]');
      if (!b || b.dataset.iv === this.interval) return;
      this.setInterval(b.dataset.iv);
    });

    this.indBar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-bind]');
      if (!b) return;
      const k = b.dataset.bind;
      // 和图表墙共用一套指标开关，两边永远一致
      state.indicators[k] = !state.indicators[k];
      if (this.ctx.onIndicatorsChanged) this.ctx.onIndicatorsChanged();
      this.syncIndicators();
      if (this.cell) {
        this.cell.applyIndicators();
        if (this.cell.times.length) this.cell.recalcIndicators();
      }
    });

    this.toolBar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tool]');
      if (!b) return;
      const t = b.dataset.tool;
      if (t === 'clear') {
        if (this.draw && this.draw.items.length && window.confirm('清除这个品种的全部绘图？')) {
          this.draw.clearAll();
        }
        return;
      }
      if (t === 'undo') {
        if (this.draw) this.draw.removeSelected();
        return;
      }
      this.setTool(t);
    });
  }

  /* ---------------- 持仓量叠加 ---------------- */
  setOI(on) {
    this.oiOn = !!on;
    const btn = this.root.querySelector('#bc-oi-btn');
    if (btn) btn.classList.toggle('on', this.oiOn);
    this.applyOI();
  }

  /** 建/拆 OI 曲线。放在独立的 pane 2，不跟价格轴和成交量抢空间 */
  applyOI() {
    const cell = this.cell;
    if (!cell || !cell.chart) return;
    const chart = cell.chart;
    if (this.oiSeries) {
      try { chart.removeSeries(this.oiSeries); } catch (e) { /* ignore */ }
      this.oiSeries = null;
    }
    if (!this.oiOn || !this.symbol || !this.symbol.endsWith('@f')) {
      if (this.oiOn && this.symbol && !this.symbol.endsWith('@f')) {
        // 现货没有持仓量，点了也白点，直接回弹
        this.oiOn = false;
        const b = this.root.querySelector('#bc-oi-btn');
        if (b) b.classList.remove('on');
      }
      return;
    }
    const LC = window.LightweightCharts;
    try {
      this.oiSeries = chart.addSeries(LC.LineSeries, {
        color: '#8b5cf6',
        lineWidth: 1.4,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'volume' },
      }, 2);
    } catch (e) {
      this.oiSeries = null;
      return;
    }
    this.sizeOIPane();
    this.loadOI();
  }

  sizeOIPane() {
    const cell = this.cell;
    if (!cell || !cell.chart) return;
    clearTimeout(this.oiTimer);
    this.oiTimer = setTimeout(() => {
      if (!cell.chart || !this.oiSeries) return;
      try {
        const panes = cell.chart.panes();
        if (panes[2] && panes[2].setHeight) panes[2].setHeight(88);
      } catch (e) { /* ignore */ }
    }, 260);
  }

  async loadOI() {
    const sym = this.symbol;
    if (!sym || !sym.endsWith('@f') || !this.oiSeries) return;
    const period = ['time', '1m', '5m'].includes(this.interval) ? '5m' : this.interval;
    try {
      const d = await api.oihist(sym, period, 500);
      if (sym !== this.symbol || !this.oiSeries) return;
      const rows = (d.h || []).map(([t, oi]) => ({ time: Math.floor(t / 1000), value: oi }));
      this.oiData = rows;
      this.oiSeries.setData(rows);
      this.sizeOIPane();
    } catch (e) { /* 网络抖动忽略 */ }
  }

  /** 右侧盘口栏（复用列表页那块 DetailPanel） */
  setDetail(on) {
    this.showDetail = !!on;
    this.body.classList.toggle('dt-off', !this.showDetail);
    const btn = this.root.querySelector('#bc-detail-btn');
    if (btn) btn.classList.toggle('on', this.showDetail);
    if (this.showDetail) this.detailPanel.setSymbol(this.symbol);
    else this.detailPanel.renderEmpty();
  }

  syncIndicators() {
    const ind = state.indicators;
    this.indBar.querySelectorAll('button[data-bind]').forEach((b) => {
      b.classList.toggle('on', !!ind[b.dataset.bind]);
    });
  }

  setTool(tool) {
    if (this.draw) this.draw.setTool(tool);
    this.toolBar.querySelectorAll('button[data-tool]').forEach((b) => {
      const t = b.dataset.tool;
      if (t === 'undo' || t === 'clear') return;
      b.classList.toggle('on', t === tool);
    });
  }

  setInterval(iv) {
    if (!IVS.includes(iv) || iv === this.interval) return;
    this.interval = iv;
    this.syncIv();
    if (!this.cell) return;
    this.cell.setInterval(iv);
    this.bindChart();
    if (this.oiOn) this.applyOI();
    if (this.draw) this.draw.setKey(this.drawKey());
    this.hoverIdx = -1;
    this.showInfo(this.cell.times.length - 1);
  }

  syncIv() {
    this.ivBar.querySelectorAll('button[data-iv]').forEach((b) => {
      b.classList.toggle('on', b.dataset.iv === this.interval);
    });
  }

  /* ---------------- 打开 / 关闭 ---------------- */
  drawKey() {
    return `${this.symbol}|${this.interval}`;
  }

  open(sym, iv) {
    if (!sym) return;
    const same = this.isOpen() && this.symbol === sym && this.interval === (iv || this.interval);
    this.symbol = sym;
    if (iv && IVS.includes(iv)) this.interval = iv;

    this.root.classList.remove('hidden');
    document.body.classList.add('bc-open');

    if (same && this.cell) {
      this.syncBar();
      return;
    }
    this.mountCell();
    this.syncBar();
    if (this.showDetail) this.detailPanel.setSymbol(this.symbol);
    if (this.oiOn) this.applyOI();
  }

  close() {
    if (!this.isOpen()) return;
    this.root.classList.add('hidden');
    document.body.classList.remove('bc-open');
    this.destroyCell();
    this.detailPanel.renderEmpty();
    if (this.ctx.onClose) this.ctx.onClose();
  }

  destroyCell() {
    if (this.draw) {
      this.draw.destroy();
      this.draw = null;
    }
    if (this.cell) {
      this.cell.destroy();
      this.cell = null;
    }
    this.boundChart = null;
    this.hoverIdx = -1;
  }

  mountCell() {
    this.destroyCell();
    const stub = {
      detached: true,
      root: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
      ctx: {},
      cells: [],
      focusIndex: 0,
      syncRange() {},
      clearCrosshair() {},
      syncCrosshair() {},
      setFocus() {},
      openBig() {},
      onCellsChanged() {},
    };
    const cell = new Cell(stub, 0);
    cell.interval = this.interval;
    this.body.insertBefore(cell.el, this.detailPanel.root);
    cell.setSymbol(this.symbol);
    cell.mount();
    cell.syncTools();
    this.cell = cell;

    this.bindChart();

    this.draw = new DrawLayer(cell, cell.host);
    this.draw.setKey(this.drawKey());

    // 图表重建后 ResizeObserver 已经跑过一轮，这里补一次取景
    requestAnimationFrame(() => {
      if (!this.cell) return;
      this.cell.autoFit = true;
      if (this.cell.times.length) this.cell.fitRange();
      if (this.draw) this.draw.schedule();
    });
  }

  /** 订阅十字光标 + 可视区间变化（图表被重建后要重挂） */
  bindChart() {
    const cell = this.cell;
    if (!cell || !cell.chart) return;
    if (cell.chart === this.boundChart) return;
    this.boundChart = cell.chart;

    cell.chart.subscribeCrosshairMove((param) => {
      if (!this.cell || !this.cell.times.length) return;
      if (!param || param.time == null) {
        this.hoverIdx = -1;
        this.showInfo(this.cell.times.length - 1);
        return;
      }
      const idx = this.cell.timeIdx(param.time);
      this.hoverIdx = idx;
      this.showInfo(idx);
    });

    cell.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      if (this.draw) this.draw.schedule();
      // 首次加载 / 换周期 / 缩放后都补一次明细行（没在悬停时跟最后一根走）
      if (this.hoverIdx < 0 && this.cell && this.cell.times.length) {
        this.showInfo(this.cell.times.length - 1);
      }
    });
  }

  /* ---------------- 数据 ---------------- */
  syncBar() {
    const sym = this.symbol || '';
    const perp = sym.endsWith('@f');
    const row = market.get(sym) || {};
    const raw = perp ? sym.slice(0, -2) : sym;
    const quote = row.q || (raw.endsWith('USDC') ? 'USDC' : 'USDT');
    const base = row.b || raw.slice(0, Math.max(0, raw.length - quote.length));

    this.symEl.textContent = base;
    const qEl = this.root.querySelector('#bc-quote');
    if (qEl) qEl.textContent = '/' + quote;
    this.tagEl.hidden = !perp;
    this.tagEl.textContent = perp ? '永续' : '';
    this.root.querySelector('.bc-title').title = symLabel(sym);

    this.syncIv();
    this.syncIndicators();
    this.syncQuote();
    this.showInfo((this.cell && this.cell.times.length - 1) || -1);
  }

  syncQuote() {
    const r = market.get(this.symbol);
    if (!r || !this.pxEl) return;
    const dp = dpOf(this.symbol);
    const cls = dirClass(r.chgp);
    this.pxEl.textContent = fmtPrice(r.l, dp);
    this.pxEl.className = 'bc-px ' + cls;
    this.chgEl.textContent = fmtPct(r.chgp);
    this.chgEl.className = 'bc-chg ' + cls;
  }

  /** 十字光标 / 最新一根的 OHLC 明细 */
  showInfo(idx) {
    const c = this.cell;
    if (!c || !c.times.length || !this.infoEl) {
      if (this.infoEl) this.infoEl.innerHTML = '';
      return;
    }
    const i = Math.max(0, Math.min(c.times.length - 1, idx));
    const t = c.times[i];
    const dp = dpOf(this.symbol);
    const d = new Date(t * 1000);
    const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const time = this.interval === '1d' ? day : `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

    if (c.intraday) {
      const px = c.closes[i];
      const base = c.basePrice || c.closes[0] || 0;
      const pct = base ? (px / base - 1) * 100 : 0;
      this.infoEl.innerHTML = `<span class="bi-time">${time}</span>
        <span>价 <b class="${dirClass(pct)}">${fmtPrice(px, dp)}</b></span>
        <span>较今开 <b class="${dirClass(pct)}">${fmtPct(pct)}</b></span>
        <span>量 <b>${fmtCompact(c.vols[i] || 0)}</b></span>`;
      return;
    }

    const b = c.bars[i];
    if (!b) { this.infoEl.innerHTML = ''; return; }
    const o = b[1];
    const h = b[2];
    const lo = b[3];
    const cl = b[4];
    const v = b[5];
    const pct = o ? (cl / o - 1) * 100 : 0;
    const cls = dirClass(pct);
    this.infoEl.innerHTML = `<span class="bi-time">${time}</span>
      <span>开 <b class="${cls}">${fmtPrice(o, dp)}</b></span>
      <span>高 <b>${fmtPrice(h, dp)}</b></span>
      <span>低 <b>${fmtPrice(lo, dp)}</b></span>
      <span>收 <b class="${cls}">${fmtPrice(cl, dp)}</b></span>
      <span>涨跌 <b class="${cls}">${fmtPct(pct)}</b></span>
      <span>振幅 <b>${o ? (((h - lo) / o) * 100).toFixed(2) + '%' : '--'}</b></span>
      <span>量 <b>${fmtCompact(v)}</b></span>`;
  }

  /* ---------------- 外部驱动 ---------------- */
  onKline(msg) {
    if (!this.cell || msg.s !== this.symbol) return;
    if (wsIv(this.interval) !== msg.i) return;
    this.cell.onKline(msg.d);
    if (this.hoverIdx < 0) this.showInfo(this.cell.times.length - 1);
    if (this.draw) this.draw.schedule();
  }

  onFrame(dirty) {
    if (dirty.has(this.symbol)) this.syncQuote();
  }

  onDepth(msg) {
    if (this.showDetail) this.detailPanel.onDepth(msg);
  }

  onTrade(msg) {
    if (this.showDetail) this.detailPanel.onTrade(msg);
  }

  applyTheme() {
    if (this.cell) this.cell.applyTheme();
    if (this.draw) this.draw.schedule();
  }

  /** 在当前筛选结果里前后翻一个品种（左右键） */
  step(dir) {
    const list = (this.ctx.symbolList && this.ctx.symbolList()) || [];
    if (!list.length) return;
    let i = list.indexOf(this.symbol);
    if (i < 0) i = 0;
    const next = list[(i + dir + list.length) % list.length];
    if (!next || next === this.symbol) return;
    this.open(next, this.interval);
    if (this.showDetail) this.detailPanel.setSymbol(next);
    if (this.ctx.onSymbolChange) this.ctx.onSymbolChange(next);
  }

  /* ---------------- 键盘 ---------------- */
  /** 返回 true 表示按键已被大图消费 */
  onKey(e) {
    if (!this.isOpen()) return false;
    if (e.key === 'Escape') { this.close(); return true; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (this.draw) this.draw.undo();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.draw && this.draw.removeSelected()) {
        e.preventDefault();
        return true;
      }
      return false;
    }
    if (e.key === 'v' || e.key === 'V') { this.setTool('cursor'); return true; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.step(-1); return true; }
    if (e.key === 'ArrowRight') { e.preventDefault(); this.step(1); return true; }
    return false;
  }
}
