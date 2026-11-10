/* 大图模式：单品种全屏图 + 绘图工具 + 十字光标明细
 *
 * 图表本体直接复用 grid.js 的 Cell（detached 模式）——指标、分时、K线缓存、
 * 实时增量、主题切换全都跟着走，这里只补三样东西：
 *   1. 顶部工具栏（币种 / 周期 / 指标 / 绘图）
 *   2. 十字光标明细行（开高低收 / 涨跌 / 量）
 *   3. 绘图图层（canvas 叠在图表上，坐标靠 timeToCoordinate / priceToCoordinate 换算）
 */

import { api } from '../core/api.js';
import { state, market, dpOf, save } from '../core/store.js';
import { openPrompt } from '../core/picker.js';
import { fmtPrice, fmtPct, fmtCompact, fmtSigned, dirClass, symLabel } from '../core/fmt.js';
import { Cell } from './cell.js';
import { DetailPanel } from './detail.js';

const DRAW_KEY = 'binance-terminal.drawings.v1';
const IVS = ['time', '5d', '1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w', '1M'];
const wsIv = (iv) => (iv === 'time' ? '1m' : iv === '5d' ? '5m' : iv);
const pad2 = (n) => String(n).padStart(2, '0');

const TOOLS = ['cursor', 'trend', 'ray', 'hline', 'hray', 'rect', 'fib', 'text'];
const IV_SEC = { time: 60, '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600,
  '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200, '1d': 86400,
  '1w': 604800, '1M': 2592000 };

/** 秒数 → 3h12m / 45m / 2d */
function fmtSpan(sec) {
  if (sec >= 86400) return Math.round(sec / 86400) + 'd';
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h + 'h' + String(m).padStart(2, '0') + 'm';
  }
  return Math.round(sec / 60) + 'm';
}
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
    this.measure = null;      // Shift+拖动 量出来的区间
    this.measuring = false;
    this.measureAt = 0;       // 松手时间，防止紧接着的 click 把结果清掉

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
    this.measure = null;
    this.measuring = false;
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

  /** 恢复一组图元（清空后的撤销用） */
  restore(items) {
    this.pushUndo();
    this.items = (items || []).map((x) => ({ ...x }));
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

    // Shift + 拖动 = 量涨跌幅（优先级高于绘图工具和图表平移）
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.measure = { p1: pt, p2: { t: pt.t, p: pt.p } };
      this.measuring = true;
      this.schedule();
      return;
    }

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
    if (this.measuring && this.measure) {
      const pt = this.pointAt(e);
      if (!pt) return;
      e.preventDefault();
      e.stopPropagation();
      this.measure.p2 = pt;
      this.schedule();
      return;
    }
    if (this.drag) {
      const pt = this.pointAt(e);
      if (!pt) return;
      e.preventDefault();
      e.stopPropagation();
      const it = this.items[this.drag.i];
      if (!it) return;
      if (it.type === 'hline' || it.type === 'hray' || it.type === 'text') {
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
    if (this.measuring) {
      this.measuring = false;
      this.measureAt = Date.now();
      e.preventDefault();
      e.stopPropagation();
      const m = this.measure;
      if (m && Math.abs(m.p2.p - m.p1.p) < 1e-9 && m.p2.t === m.p1.t) {
        this.measure = null;      // 几乎没拖动，不算测量
      }
      this.schedule();
      return;
    }
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
    if (d.type === 'text') {
      this.askText(d, e);
      this.schedule();
      return;
    }
    const flat = Math.abs(d.p2.p - d.p1.p) < 1e-12 && d.p2.t === d.p1.t;
    if (d.type === 'hline' || d.type === 'hray' || !flat) {
      this.pushUndo();
      this.items.push(d);
      this.persist();
    }
    this.schedule();
  }

  /** 文本标注：点一下位置后弹输入框，确认才落地（点取消什么都不留） */
  askText(draft, e) {
    const at = e && e.clientX ? { x: e.clientX, y: e.clientY } : null;
    openPrompt(this.host, {
      at,
      title: '文本标注', label: '内容', placeholder: '比如 这里放量 / 注意回踩',
      okText: '添加', value: '',
      onOk: (v) => {
        const txt = String(v).trim().slice(0, 40);
        if (!txt) return;
        this.pushUndo();
        this.items.push({
          type: 'text',
          p1: { t: draft.p1.t, p: draft.p1.p },
          p2: { t: draft.p1.t, p: draft.p1.p },
          text: txt,
        });
        this.persist();
        this.setTool('cursor');     // 打完字回到光标，避免下一次点击又弹框
        this.schedule();
      },
    });
  }

  /** 光标位置附近有没有可拖的端点 / 水平线 */
  hitHandle(x, y) {
    const TOL = 8;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const y1 = this.yOf(it.p1.p);
      if (y1 == null) continue;
      if (it.type === 'hline' || it.type === 'hray') {
        if (Math.abs(y - y1) <= TOL) return { i, which: 'p1' };
        continue;
      }
      if (it.type === 'text') {
        if (Math.abs(x - x1) <= 70 && Math.abs(y - y1) <= 13) return { i, which: 'p1' };
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
    if (Date.now() - this.measureAt < 300) return;   // 刚量完那一下不算点击
    if (this.measure) {
      this.measure = null;
      this.schedule();
      return;
    }
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
    if (it.type === 'hray') return Math.abs(y - y1) <= TOL && x >= x1 - TOL;
    // 文本按"锚点 + 一小块矩形"命中，别让人去点那一个像素
    if (it.type === 'text') return Math.abs(x - x1) <= 70 && Math.abs(y - y1) <= 13;

    const x2 = this.xOf(it.p2 && it.p2.t);
    const y2 = this.yOf(it.p2 && it.p2.p);
    if (x2 == null || y2 == null) return false;

    if (it.type === 'trend') return distToSeg(x, y, x1, y1, x2, y2) <= TOL;
    if (it.type === 'ray') {
      // 射线要延伸到画布外，命中检测也按延长后的线段算
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const k = 5000 / len;
      return distToSeg(x, y, x1, y1, x1 + dx * k, y1 + dy * k) <= TOL;
    }
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
    if (!this.items.length && !this.draft && !this.measure) return;

    const accent = cv('--accent') || '#2563eb';
    const text = cv('--text-2') || '#49525d';
    const panel = cv('--panel') || '#fff';

    for (let i = 0; i < this.items.length; i++) {
      this.paint(this.items[i], i === this.sel, { w, h, accent, text, panel });
    }
    if (this.draft) this.paint(this.draft, false, { w, h, accent, text, panel });
    if (this.measure) this.paintMeasure({ w, h, text, panel });
  }

  /** Shift 测量框：矩形 + 涨跌幅 / 价格差 / 根数 / 时间跨度 */
  paintMeasure(S) {
    const m = this.measure;
    if (!m) return;
    const x1 = this.xOf(m.p1.t);
    const y1 = this.yOf(m.p1.p);
    const x2 = this.xOf(m.p2.t);
    const y2 = this.yOf(m.p2.p);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return;

    const g = this.g;
    const up = m.p2.p >= m.p1.p;
    const color = up ? (cv('--up') || '#0f9d63') : (cv('--down') || '#e5484d');
    const l = Math.min(x1, x2);
    const t = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);

    g.save();
    g.globalAlpha = 0.12;
    g.fillStyle = color;
    g.fillRect(l, t, w, h);
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.strokeRect(l + 0.5, t + 0.5, w, h);
    g.setLineDash([]);

    const dp = dpOf(this.cell.symbol);
    const pct = m.p1.p ? (m.p2.p / m.p1.p - 1) * 100 : 0;
    const diff = m.p2.p - m.p1.p;
    const step = IV_SEC[this.cell.interval] || 60;
    const bars = Math.max(1, Math.round(Math.abs(m.p2.t - m.p1.t) / step));
    const span = fmtSpan(Math.abs(m.p2.t - m.p1.t));
    const line1 = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%   ${diff >= 0 ? '+' : ''}${fmtPrice(diff, dp)}`;
    const line2 = `${bars} 根 · ${span}`;

    g.font = '11px ui-monospace, Consolas, monospace';
    const bw = Math.max(g.measureText(line1).width, g.measureText(line2).width) + 16;
    const bh = 34;
    let bx = l + w / 2 - bw / 2;
    let by = t - bh - 8;
    if (by < 4) by = Math.min(t + h + 8, this.host.clientHeight - bh - 4);
    bx = Math.max(4, Math.min(this.host.clientWidth - bw - 74, bx));

    g.globalAlpha = 0.95;
    g.fillStyle = S.panel;
    g.beginPath();
    if (g.roundRect) g.roundRect(bx, by, bw, bh, 4); else g.rect(bx, by, bw, bh);
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.stroke();

    g.textBaseline = 'top';
    g.fillStyle = color;
    g.fillText(line1, bx + 8, by + 5);
    g.font = '10px ui-monospace, Consolas, monospace';
    g.fillStyle = S.text || '#49525d';
    g.fillText(line2, bx + 8, by + 20);
    g.restore();
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

    if (it.type === 'hray') {
      g.beginPath();
      g.moveTo(x1, y1 + 0.5);
      g.lineTo(S.w, y1 + 0.5);
      g.stroke();
      this.tag(g, S.w - 66, y1, fmtPrice(it.p1.p, dp), S, 'right');
      g.restore();
      return;
    }

    if (it.type === 'text') {
      const txt = String(it.text || '');
      if (txt) {
        g.font = '12px ' + (cv('--font') || 'system-ui');
        const tw = g.measureText(txt).width;
        // 底板跟着主题走，压在 K 线上也读得清
        g.globalAlpha = 0.92;
        g.fillStyle = S.panel;
        g.fillRect(x1 - 3, y1 - 13, tw + 10, 18);
        g.globalAlpha = 1;
        g.lineWidth = 1;
        g.strokeStyle = sel ? S.accent : 'rgba(125,135,152,.55)';
        g.strokeRect(x1 - 2.5, y1 - 12.5, tw + 9, 17);
        g.fillStyle = sel ? S.accent : S.text;
        g.fillText(txt, x1 + 2, y1);
      }
      if (sel) this.dot(x1, y1, S.accent);
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
    } else if (it.type === 'ray') {
      // 只往 p2 那一侧无限延伸；画到画布外，canvas 自己裁
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const k = 5000 / len;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x1 + dx * k, y1 + dy * k);
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
    this.interval = state.bcInterval || '1d';
    this.cell = null;
    this.draw = null;
    this.boundChart = null;
    this.hoverIdx = -1;
    this.showDetail = !!state.bcDetailOpen;   // 默认打开，用户关过才记成 false
    this.oiOn = false;
    this.oiSeries = null;
    this.cvdOn = state.cvd !== false;   // CVD 默认打开
    this.cvdSeries = null;
    this.cvdTimer = 0;
    this.cvdPaneTimer = 0;
    this.oiData = null;
    this.oiCache = null;        // { key: 'sym|period', rows } 后台预取的持仓量
    this.oiPrefetchTimer = 0;
    this.livePx = null;      // 最新成交价（逐笔 / K 线收盘），用来驱动头部报价
    this.quoteTimer = 0;

    this.body = root.querySelector('.bc-body');
    // 十字光标信息卡：贴着光标显示这一根 K 线的明细。
    // 必须等 this.body 拿到再 append —— 构造函数前半段还没有它。
    this.tipEl = document.createElement('div');
    this.tipEl.className = 'bc-tip';
    this.tipEl.hidden = true;
    this.body.appendChild(this.tipEl);
    // 复位按钮挂在图表格子里，不能挂在 .bc-body —— 那里面还含右侧盘口栏，
    // right:72px 会算到盘口栏上面去
    this.resetBtn = root.querySelector('#bc-reset');
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
    this.bindDetailResize();
    // 按上次的选择同步 UI（HTML 里不写死，避免首帧闪一下）
    this.body.classList.toggle('dt-off', !this.showDetail);
    const db = this.root.querySelector('#bc-detail-btn');
    if (db) db.classList.toggle('on', this.showDetail);
  }

  /** 盘口栏拖宽：和列表页详情面板同一套手感（左缘拖动、双击复位、宽度落盘） */
  bindDetailResize() {
    const h = this.root.querySelector('#bc-resize');
    const d = this.detailPanel.root;
    if (!h || !d) return;

    const applyW = (w) => {
      d.style.width = w + 'px';
      d.style.flexBasis = w + 'px';
    };
    if (state.bcDetailWidth) applyW(state.bcDetailWidth);

    let startX = 0;
    let startW = 0;
    let dragging = false;

    h.addEventListener('pointerdown', (e) => {
      if (!this.showDetail) return;
      dragging = true;
      startX = e.clientX;
      startW = d.getBoundingClientRect().width;
      // 合成事件 / 触控笔边界情况下 capture 会抛 NotFoundError，不该因此中断拖拽
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      h.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    h.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // 往左拖变宽；上下限按"再宽就没有图"和"再窄盘口就挤成一列"来定
      const w = Math.max(240, Math.min(560, startW - (e.clientX - startX)));
      applyW(w);
      state.bcDetailWidth = Math.round(w);
    });

    const end = () => {
      if (!dragging) return;
      dragging = false;
      h.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      save();
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);

    h.addEventListener('dblclick', () => {
      state.bcDetailWidth = 0;
      d.style.width = '';
      d.style.flexBasis = '';
      save();
    });
  }

  isOpen() {
    return !this.root.classList.contains('hidden');
  }

  /** 大图淡入一次（只动 opacity/transform，不触发图表 resize） */
  playEnter() {
    this.root.classList.remove('bc-enter');
    this.root.classList.add('bc-enter');
    clearTimeout(this.enterTimer);
    this.enterTimer = setTimeout(() => this.root.classList.remove('bc-enter'), 280);
  }

  /* ---------------- 顶部栏 ---------------- */
  bindBar() {
    this.root.querySelector('#bc-back').addEventListener('click', () => this.close());
    this.root.querySelector('#bc-close').addEventListener('click', () => this.close());
    this.root.querySelector('#bc-reset').addEventListener('click', () => this.resetView());
    this.root.querySelector('#bc-oi-btn').addEventListener('click', () => this.setOI(!this.oiOn));
    const cvdBtn = this.root.querySelector('#bc-cvd-btn');
    if (cvdBtn) {
      cvdBtn.classList.toggle('on', this.cvdOn);
      cvdBtn.addEventListener('click', () => this.setCVD(!this.cvdOn));
    }
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
        // 不用 window.confirm：原生弹窗会阻塞渲染进程（headless 下 CDP 直接卡死），
        // 而且和「清空自选」的 toast + 撤销不是一套交互
        const n = this.draw ? this.draw.items.length : 0;
        if (!n) return;
        const snap = this.draw.items.slice();
        this.draw.clearAll();
        if (this.ctx.toast) {
          this.ctx.toast(`已清除 ${n} 个绘图`, {
            label: '撤销',
            onClick: () => this.draw.restore(snap),
          });
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

  /** 图形复位：回到「K 线铺满 + 最后一根贴右」 */
  resetView() {
    const btn = this.root.querySelector('#bc-reset');
    if (btn) {
      btn.classList.remove('off');
      btn.classList.add('spin');
      setTimeout(() => btn.classList.remove('spin'), 460);
    }
    const c = this.cell;
    if (!c) return;
    c.autoFit = true;
    if (c.times.length) c.fitRange();
    if (this.draw) this.draw.schedule();
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
    // 换品种 / 换周期时这条曲线是重建的，旧数据不能留着（否则预取回来会被
    // 「已经有数据了」的判断挡住，白白多打一次接口）
    this.oiData = null;
    try {
      this.oiSeries = chart.addSeries(LC.LineSeries, {
        color: '#8b5cf6',
        lineWidth: 1.4,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'volume' },
      }, this.oiPane());
    } catch (e) {
      this.oiSeries = null;
      return;
    }
    cell.schedulePaneHeights();
    this.loadOI();
  }

  /** 持仓量放哪个 pane：CVD 开着就往后挪一位，两个都开时各占一格 */
  oiPane() {
    return this.cvdOn ? 3 : 2;
  }

  /* ---------------- CVD（累计买卖差） ----------------
     用 K 线自带的「主动买成交量」算：每根 Δ = 2*tb - v，
     从最左边那根开始累加就是 CVD 曲线。价格新高而 CVD 没跟上 = 买盘在撤，这是它最大的用处。
     放在独立 pane 2，持仓量打开时挪到 pane 3。 */
  setCVD(on) {
    this.cvdOn = !!on;
    state.cvd = this.cvdOn;
    save();
    const btn = this.root.querySelector('#bc-cvd-btn');
    if (btn) btn.classList.toggle('on', this.cvdOn);
    this.applyCVD();
    this.applyOI();          // 持仓量的 pane 位置跟着变
  }

  applyCVD() {
    const cell = this.cell;
    if (!cell || !cell.chart) return;
    const chart = cell.chart;
    if (!this.cvdOn || cell.intraday) {
      if (this.cvdSeries) {
        try { chart.removeSeries(this.cvdSeries); } catch (e) { /* ignore */ }
        this.cvdSeries = null;
      }
      return;
    }
    const bars = cell.bars || [];
    // 老缓存只有 7 个字段（没有主动买量），算不出来就不画，别画一条错的线
    if (bars.length < 2 || !bars[0] || bars[0].length < 8) return;

    let cum = 0;
    const data = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      cum += 2 * b[7] - b[5];
      data[i] = { time: Math.floor(b[0] / 1000), value: cum };
    }

    if (this.cvdSeries) {
      // 已经建好就只换数据：反复 add/remove 会让价格轴跟着跳
      this.cvdSeries.setData(data);
      return;
    }
    const LC = window.LightweightCharts;
    try {
      this.cvdSeries = chart.addSeries(LC.LineSeries, {
        color: '#2f6fed',
        lineWidth: 1.4,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'volume' },
      }, 2);
    } catch (e) {
      this.cvdSeries = null;
      return;
    }
    this.cvdSeries.setData(data);
    cell.schedulePaneHeights();     // 新开一个 pane，等布局稳定后压回 76px
  }

  /** 实时 K 线每根都会触发 onData，CVD 是累计量，1 秒刷一次足够 */
  scheduleCVD() {
    if (!this.cvdOn || this.cvdTimer) return;
    this.cvdTimer = setTimeout(() => {
      this.cvdTimer = 0;
      this.applyCVD();
    }, 800);
  }

  async loadOI() {
    const sym = this.symbol;
    if (!sym || !sym.endsWith('@f') || !this.oiSeries) return;
    const period = this.oiPeriod();
    const key = sym + '|' + period;
    const btn = this.root.querySelector('#bc-oi-btn');
    // 打开大图时后台已经拉过了，点开就是 0ms
    if (this.oiCache && this.oiCache.key === key && this.oiCache.rows.length) {
      this.applyOIRows(this.oiCache.rows);
      return;
    }
    if (btn) { btn.classList.add('loading'); btn.title = '持仓量加载中…'; }
    try {
      const d = await api.oihist(sym, period, 500);
      if (sym !== this.symbol || !this.oiSeries) return;
      const rows = (d.h || []).map(([t, oi]) => ({ time: Math.floor(t / 1000), value: oi }));
      this.oiCache = { key, rows };
      this.applyOIRows(rows);
    } catch (e) { /* 网络抖动忽略 */ } finally {
      if (btn) { btn.classList.remove('loading'); btn.title = '持仓量'; }
    }
  }

  applyOIRows(rows) {
    if (!this.oiSeries) return;
    this.oiData = rows;
    this.oiSeries.setData(rows);
    if (this.cell) this.cell.schedulePaneHeights();
  }

  /** 持仓量历史用哪个周期（分时图没 5m，统一按 5m 拉） */
  oiPeriod() {
    return ['time', '1m', '5m'].includes(this.interval) ? '5m' : this.interval;
  }

  /**
   * 打开永续大图后，后台先把持仓量历史拿回来。
   * 延后 2 秒：K 线 / 盘口 / 合约数据正在抢那条代理连接，
   * 预取这时候插进来只会让首屏更慢（K 线预取踩过这个坑）。
   */
  scheduleOIPrefetch() {
    clearTimeout(this.oiPrefetchTimer);
    this.oiPrefetchTimer = 0;
    const sym = this.symbol;
    if (!sym || !sym.endsWith('@f')) return;
    const iv = this.interval;
    const period = this.oiPeriod();
    const key = sym + '|' + period;
    if (this.oiCache && this.oiCache.key === key) return;
    this.oiPrefetchTimer = setTimeout(() => {
      this.oiPrefetchTimer = 0;
      if (this.symbol !== sym || this.interval !== iv) return;
      if (this.oiCache && this.oiCache.key === key) return;
      api.oihist(sym, period, 500).then((d) => {
        if (this.symbol !== sym || this.interval !== iv) return;
        const rows = (d.h || []).map(([t, oi]) => ({ time: Math.floor(t / 1000), value: oi }));
        this.oiCache = { key, rows };
        // 用户手快，已经点上「持仓量」并且在等数据了
        if (this.oiOn && this.oiSeries && (!this.oiData || !this.oiData.length)) this.applyOIRows(rows);
      }).catch(() => { /* 预取失败无所谓，点的时候还会再拉一次 */ });
    }, 2000);
  }

  /** 右侧盘口栏（复用列表页那块 DetailPanel） */
  setDetail(on) {
    this.showDetail = !!on;
    state.bcDetailOpen = this.showDetail;
    save();
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
    state.bcInterval = iv;      // 大图有自己的周期记忆，下次打开还是这个
    save();
    this.syncIv();
    if (!this.cell) return;
    this.cell.setInterval(iv);
    this.bindChart();
    if (this.cvdOn) this.applyCVD();
    if (this.oiOn) this.applyOI();
    if (this.draw) this.draw.setKey(this.drawKey());
    this.hoverIdx = -1;
    this.showInfo(this.cell.times.length - 1);
    this.scheduleOIPrefetch();
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
    const wasOpen = this.isOpen();
    if (this.symbol !== sym) {
      this.livePx = null;
      this.hideTip();
    }
    this.symbol = sym;
    if (iv && IVS.includes(iv)) this.interval = iv;

    this.root.classList.remove('hidden');
    document.body.classList.add('bc-open');
    if (!wasOpen) this.playEnter();

    if (same && this.cell) {
      this.syncBar();
      return;
    }
    this.mountCell();
    this.syncBar();
    if (this.showDetail) this.detailPanel.setSymbol(this.symbol);
    if (this.oiOn) this.applyOI();
    this.scheduleOIPrefetch();
  }

  close() {
    if (!this.isOpen()) return;
    this.hideTip();
    this.root.classList.add('hidden');
    document.body.classList.remove('bc-open');
    clearTimeout(this.oiPrefetchTimer);
    this.oiPrefetchTimer = 0;
    this.destroyCell();
    this.detailPanel.renderEmpty();
    if (this.ctx.onClose) this.ctx.onClose();
  }

  destroyCell() {
    if (this.draw) {
      this.draw.destroy();
      this.draw = null;
    }
    clearTimeout(this.cvdTimer);
    clearTimeout(this.cvdPaneTimer);
    if (this.quoteTimer) {
      clearTimeout(this.quoteTimer);
      this.quoteTimer = 0;
    }
    this.livePx = null;
    this.cvdTimer = 0;
    this.cvdSeries = null;
    if (this.cell) {
      this.cell.destroy();
      this.cell = null;
    }
    this.boundChart = null;
    this.hoverIdx = -1;
  }

  mountCell() {
    this.hideTip();
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
    if (this.resetBtn) cell.el.appendChild(this.resetBtn);
    cell.setSymbol(this.symbol);
    cell.mount();
    cell.syncTools();
    this.cell = cell;

    this.bindChart();
    // K 线到位 / 实时更新时刷新 CVD（节流在 scheduleCVD 里）
    cell.onData = () => {
      this.scheduleCVD();
      // 详情面板关着时没有逐笔流，K 线收盘是手上最新的价
      const c = this.cell;
      if (c && c.closes.length) this.setLivePx(c.closes[c.closes.length - 1]);
    };
    cell.extraPanes = (panes) => {
      const h = 76;
      if (this.cvdSeries && panes[2] && panes[2].setHeight) panes[2].setHeight(h);
      const oi = this.oiPane();
      if (this.oiSeries && panes[oi] && panes[oi].setHeight) panes[oi].setHeight(h);
    };
    this.applyCVD();

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
        this.hideTip();
        return;
      }
      const idx = this.cell.timeIdx(param.time);
      this.hoverIdx = idx;
      this.showInfo(idx);
      this.showTip(idx, param.point);
    });

    cell.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      if (this.draw) this.draw.schedule();
      const rb = this.root.querySelector('#bc-reset');
      if (rb) rb.classList.toggle('off', !cell.autoFit);
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
    const live = this.livePx;
    // 8 秒没新的逐笔就退回行情快照，免得流断了以后价格卡死在一个旧值上
    const fresh = live && live.s === this.symbol && performance.now() - live.at < 8000;
    const px = fresh ? live.p : r.l;
    const chgp = (fresh && r.o) ? ((px - r.o) / r.o) * 100 : r.chgp;
    const cls = dirClass(chgp);
    this.pxEl.textContent = fmtPrice(px, dp);
    this.pxEl.className = 'bc-px ' + cls;
    this.chgEl.textContent = fmtPct(chgp);
    this.chgEl.className = 'bc-chg ' + cls;
  }

  /** 十字光标信息卡：像终端那样把这一根 K 线的明细列成表 */
  showTip(idx, point) {
    const el = this.tipEl;
    const c = this.cell;
    if (!el || !c || !c.times.length) return;
    // 正在画线时不弹卡片：它会挡住落点，也干扰对第二根 K 线位置的判断
    if (this.draw && this.draw.tool) { this.hideTip(); return; }
    // 正在画线时不弹卡片：它会挡住落点，也干扰对第二根 K 线位置的判断
    if (this.draw && this.draw.tool) { this.hideTip(); return; }

    const i = Math.max(0, Math.min(c.times.length - 1, idx));
    const d = new Date(c.times[i] * 1000);
    const dp = dpOf(this.symbol);
    const day = `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
    const wd = '星期' + '日一二三四五六'[d.getDay()];
    const head = `<div class="bt-head"><span>${day}</span><span>${wd}</span></div>`;

    let rows = '';
    const row = (k, v, cls) => {
      rows += `<div class="bt-row"><span>${k}</span><b class="${cls || ''}">${v}</b></div>`;
    };

    if (c.intraday) {
      const px = c.closes[i];
      const base = c.basePrice || c.closes[0] || 0;
      const pct = base ? (px / base - 1) * 100 : 0;
      row('价格', fmtPrice(px, dp), dirClass(pct));
      row('今开', fmtPrice(base, dp));
      row('较今开', fmtPct(pct), dirClass(pct));
      row('成交量', fmtCompact(c.vols[i] || 0));
    } else {
      const b = c.bars[i];
      if (!b) { this.hideTip(); return; }
      const o = b[1];
      const h = b[2];
      const lo = b[3];
      const cl = b[4];
      const v = b[5];
      const q = b[6] || 0;
      const pct = o ? (cl / o - 1) * 100 : 0;
      const amp = o ? ((h - lo) / o) * 100 : 0;
      const prev = i > 0 ? c.bars[i - 1][4] : null;
      const pct2 = prev ? (cl / prev - 1) * 100 : null;
      const cls = dirClass(pct);
      row('收盘', fmtPrice(cl, dp), cls);
      row('开盘', fmtPrice(o, dp));
      row('最高', fmtPrice(h, dp));
      row('最低', fmtPrice(lo, dp));
      if (prev != null) row('前收', fmtPrice(prev, dp));
      row('涨跌', fmtSigned(cl - o, dp), cls);
      row('涨幅', fmtPct(pct), cls);
      if (pct2 != null) row('较前收', fmtPct(pct2), dirClass(pct2));
      row('振幅', amp.toFixed(2) + '%');
      row('成交量', fmtCompact(v));
      row('成交额', fmtCompact(q));
      if (v > 0 && q > 0) row('均价', fmtPrice(q / v, dp));
      row('状态', cl >= o ? '阳线' : '阴线', cl >= o ? 'up' : 'down');
    }

    el.innerHTML = head + rows;
    el.hidden = false;

    // 位置：贴着光标右侧；右边放不下就翻到左边，上下夹在图表里
    const bodyRect = this.body.getBoundingClientRect();
    const hostRect = c.host.getBoundingClientRect();
    const px = hostRect.left - bodyRect.left + (point ? point.x : 0);
    const py = hostRect.top - bodyRect.top + (point ? point.y : 0);
    const w = el.offsetWidth || 160;
    const hh = el.offsetHeight || 200;
    let left = px + 16;
    if (left + w > this.body.clientWidth - 8) left = px - 16 - w;
    left = Math.max(6, Math.min(left, this.body.clientWidth - w - 6));
    const top = Math.max(6, Math.min(py - 12, this.body.clientHeight - hh - 6));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  hideTip() {
    if (this.tipEl && !this.tipEl.hidden) this.tipEl.hidden = true;
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
    // 头部报价直接吃逐笔：行情快照是 0.7 秒一批、币安 ticker 本身 1 秒一次，
    // 而盘口 100ms、成交实时，三者会互相打架
    if (msg && msg.s === this.symbol) this.setLivePx(msg.p);
  }

  /** 记录一个"更实时"的价（逐笔或 K 线收盘），合并后再刷头部。
   *  用定时器而不是 rAF：窗口在后台/最小化时 rAF 会被节流到 1Hz 甚至暂停，
   *  头部就会落后一拍（实测差 4~5bps）。50ms 节流对肉眼已经足够。 */
  setLivePx(p) {
    if (!(p > 0)) return;
    this.livePx = { s: this.symbol, p, at: performance.now() };
    if (this.quoteTimer) return;
    this.quoteTimer = setTimeout(() => {
      this.quoteTimer = 0;
      this.syncQuote();
    }, 50);
  }

  applyTheme() {
    if (this.cell) this.cell.applyTheme();
    if (this.draw) this.draw.schedule();
    // 右侧详情栏是独立的 DetailPanel（自己持有一张轻量图表），
    // 不转发给它的话，换主题后那块迷你走势图还停在旧底色（浅色主题里一块黑）
    if (this.detailPanel) this.detailPanel.applyTheme();
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
    if (e.key === 'r' || e.key === 'R') { this.resetView(); return true; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.step(-1); return true; }
    if (e.key === 'ArrowRight') { e.preventDefault(); this.step(1); return true; }
    return false;
  }
}
