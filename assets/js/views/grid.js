/* 图表墙（多品种同列）：多图网格 + 虚拟化 + 联动
 *
 * 单个格子的图表逻辑在 cell.js 里，这里只管布局、挂载/卸载、选中和联动。
 */

import { state, market, save, matchTab, matchMkt, isTabKey, DEFAULT_SYMBOLS } from '../core/store.js';
import { Cell, wsInterval } from './cell.js';

/* -------------------------------------------------------------- GridView */

const MAX_CELLS = 400;      // 一张墙最多铺 400 个格子（虚拟滚动，同时只有 ~20 张图在跑）

export class GridView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.cells = [];
    this.cols = 4;
    this.focusIndex = 0;
    this.syncLock = 0;
    this.crossLock = false;
    this.scrollRaf = 0;

    // 只挂载视野内的图表，其余只留格子外壳
    this.ro = new ResizeObserver(() => this.syncMount());
    this.ro.observe(root);
    root.addEventListener('scroll', () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this.syncMount();
      });
    }, { passive: true });

    this.applyLayout();
  }

  /** 当前筛选下的品种，按成交额从高到低，同一币种只留成交额最大的计价对 */
  filteredSymbols(mkt, tab, sector) {
    const best = new Map();
    for (const r of market.values()) {
      if (!matchMkt(r, mkt)) continue;
      if (!matchTab(r, tab)) continue;
      if (sector && !(r.sec || []).includes(sector)) continue;
      const k = r.b + '|' + (r.mkt || 'spot');
      const cur = best.get(k);
      if (!cur || r.qv > cur.qv) best.set(k, r);
    }
    return [...best.values()].sort((a, b) => b.qv - a.qv).map((r) => r.s);
  }

  /** 当前筛选下的品种数（去重到 币种+市场） */
  filteredCount() {
    return this.filteredSymbols(state.mkt, state.tab, state.sector).length;
  }

  /** 总格子数：跟随布局 / 固定行数 / 全部品种 */
  totalCells(cols, layRows) {
    const rows = state.rows;
    if (rows === -1) {
      const n = this.filteredCount() || cols * layRows;
      return Math.min(MAX_CELLS, Math.ceil(n / cols) * cols);
    }
    const r = rows > 0 ? rows : layRows;
    return Math.min(MAX_CELLS, cols * r);
  }

  applyLayout() {
    const [cols, layRows] = state.layout.split('x').map(Number);
    this.cols = cols;
    const total = this.totalCells(cols, layRows);
    const rowCount = Math.ceil(total / cols);

    this.root.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    // 行高保底 220px：窗口不够高时格子不再被压扁，改为纵向滚动（滚轮可直接滚）
    this.root.style.gridTemplateRows = `repeat(${rowCount}, minmax(220px, 1fr))`;

    while (this.cells.length > total) {
      const c = this.cells.pop();
      c.destroy();
    }
    while (this.cells.length < total) {
      const c = new Cell(this, this.cells.length);
      this.root.appendChild(c.el);
      this.cells.push(c);
    }
    // 「全部品种」模式下按当前筛选结果铺，而不是重复 24 个默认币
    const fill = state.rows === -1 ? this.filteredSymbols(state.mkt, state.tab, state.sector) : null;
    this.cells.forEach((c, i) => {
      const sym = fill && fill.length
        ? fill[i % fill.length]
        : (state.cells[i] || DEFAULT_SYMBOLS[i % DEFAULT_SYMBOLS.length]);
      if (c.symbol !== sym) c.setSymbol(sym);
      else c.syncTools();
    });

    this.syncMount(true);
    if (this.focusIndex >= this.cells.length) this.focusIndex = 0;
    this.cells.forEach((c, i) => c.el.classList.toggle('focus', i === this.focusIndex));
    // 布局变化后按新宽度重新取景（格子大小变了，K线密度也该跟着变）
    requestAnimationFrame(() => {
      this.syncMount();
      this.cells.forEach((c) => {
        if (c.times.length > 1 && c.chart) { c.autoFit = true; c.fitRange(); }
      });
    });
  }

  /** 按滚动位置挂载/卸载图表：视野上下各多留一行，滚动时不至于白屏 */
  syncMount() {
    const cells = this.cells;
    if (!cells.length) return;
    const cols = this.cols;
    const h0 = cells[0].el.offsetHeight;
    const rowH = (h0 > 20 ? h0 : 220) + 1;      // 首帧还没布局时用兜底值
    const top = this.root.scrollTop;
    const h = this.root.clientHeight || 400;
    const firstRow = Math.max(0, Math.floor(top / rowH) - 2);
    const lastRow = Math.ceil((top + h) / rowH) + 2;
    const from = firstRow * cols;
    const to = (lastRow + 1) * cols;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const want = i >= from && i < to;
      if (want && !c.mounted) c.mount();
      else if (!want && c.mounted) c.unmountChart();
    }
  }

  /* ---------------- 选中 / 放大 ---------------- */
  setFocus(i) {
    if (i == null || i < 0 || i >= this.cells.length) return;
    const changed = this.focusIndex !== i;
    this.focusIndex = i;
    this.cells.forEach((c, idx) => c.el.classList.toggle('focus', idx === i));
    const c = this.cells[i];
    if (changed && c && c.symbol && this.ctx.onFocus) this.ctx.onFocus(c.symbol);
  }

  /** 键盘方向键在格子间移动 */
  moveFocus(dx, dy) {
    const n = this.cells.length;
    if (!n) return;
    let i = (this.focusIndex || 0) + dx + dy * this.cols;
    i = Math.max(0, Math.min(n - 1, i));
    this.setFocus(i);
    const el = this.cells[i].el;
    const r = el.getBoundingClientRect();
    const gr = this.root.getBoundingClientRect();
    if (r.top < gr.top) this.root.scrollTop -= (gr.top - r.top) + 6;
    else if (r.bottom > gr.bottom) this.root.scrollTop += (r.bottom - gr.bottom) + 6;
  }

  /** 双击 / Enter：进入大图模式（带绘图和 OHLC 明细） */
  openBig(i) {
    if (i != null) this.setFocus(i);
    const c = this.cells[this.focusIndex];
    if (!c || !c.symbol) return;
    if (this.ctx && this.ctx.onOpenBig) this.ctx.onOpenBig(c.symbol, c.interval);
  }

  onCellsChanged() {
    if (this.ctx && this.ctx.onCellsChanged) this.ctx.onCellsChanged();
  }

  /** 按列表当前的筛选 + 排序填充所有格子 */
  fillByFilter(mkt, tab, sector, sort) {
    if (state.rows === -1) this.applyLayout();   // 全部模式：格子数跟着筛选结果变
    const list = [...market.values()].filter((r) => matchMkt(r, mkt)
      && matchTab(r, tab)
      && (!sector || (r.sec || []).includes(sector)));
    const best = new Map();
    for (const r of list) {
      const k = r.b + '|' + (r.mkt || 'spot');
      const cur = best.get(k);
      if (!cur || r.qv > cur.qv) best.set(k, r);
    }
    const arr = [...best.values()];
    if (!arr.length) return false;
    const { key, dir } = sort || { key: 'qv', dir: -1 };
    const amp = (r) => (r.o ? ((r.h - r.lo) / r.o) * 100 : 0);
    arr.sort((a, b) => {
      if (key === 's') return a.b.localeCompare(b.b) * dir;
      if (key === 'amp') return (amp(a) - amp(b)) * dir;
      return ((a[key] ?? 0) - (b[key] ?? 0)) * dir;
    });
    this.cells.forEach((c, i) => c.setSymbol(arr[i % arr.length].s));
    return true;
  }

  /** 按分类批量填充所有格子（按成交额从高到低）
   *  key 形如 'all' / 'spot:all' / 'perp:AI' / 'spot:crypto'
   */
  fillSector(key) {
    const raw = key || 'all';
    let mkt = 'all';
    let sec = 'all';
    if (raw !== 'all') {
      const parts = raw.split(':');
      mkt = parts[0] || 'all';
      sec = parts[1] || 'all';
    }
    state.gridSector = raw;
    // 列表筛选跟着一起走，两边看到的永远是同一批标的
    state.mkt = mkt;
    if (sec === 'all') { state.tab = 'all'; state.sector = null; }
    else if (isTabKey(sec)) { state.tab = sec; state.sector = null; }
    else { state.tab = 'all'; state.sector = sec; }
    save();
    if (this.ctx.onFilterChanged) this.ctx.onFilterChanged();
    if (state.rows === -1) this.applyLayout();   // 全部模式：格子数跟着筛选结果变

    if (raw === 'all') {
      this.cells.forEach((c, i) => c.setSymbol(DEFAULT_SYMBOLS[i % DEFAULT_SYMBOLS.length]));
      return true;
    }
    const list = this.filteredSymbols(state.mkt, state.tab, state.sector);
    if (!list.length) return false;
    this.cells.forEach((c, i) => c.setSymbol(list[i % list.length]));
    return true;
  }

  setIntervalAll(iv) {
    this.cells.forEach((c) => c.setInterval(iv));
  }

  setIndicators() {
    const ind = state.indicators;
    // 分时没有 MACD，不参与重建判断
    const needRebuild = this.cells.some((c) => c.mounted && !c.intraday && c.hasMacd !== ind.macd);
    if (needRebuild) {
      this.cells.forEach((c) => {
        if (!c.mounted || c.intraday) return;
        const range = c.chart ? c.chart.timeScale().getVisibleLogicalRange() : null;
        const bars = c.bars, times = c.times, closes = c.closes;
        c.unmountChart();
        c.bars = bars; c.times = times; c.closes = closes;
        c.mount();
        if (range && c.chart) {
          try { c.chart.timeScale().setVisibleLogicalRange(range); } catch (e) { /* ignore */ }
        }
      });
    } else {
      this.cells.forEach((c) => {
        if (!c.mounted) return;
        c.applyIndicators();
        if (c.times.length) c.recalcIndicators();
      });
    }
    // 分时格子只需重刷颜色
    this.cells.forEach((c) => { if (c.mounted && c.intraday) c.paintBars(true); });
  }

  onFrame(dirty) {
    for (const c of this.cells) {
      // 只更新挂了图的格子：铺 200 个格子时逐个 renderHead 会拖垮主线程
      if (c.mounted && c.symbol && dirty.has(c.symbol)) c.renderHead();
    }
  }

  onKline(msg) {
    for (const c of this.cells) {
      // 没挂载的格子 times 是空的，喂它也没用；挂载回来会重新 load 一次
      if (!c.mounted) continue;
      if (c.symbol === msg.s && wsInterval(c.interval) === msg.i) c.onKline(msg.d);
    }
  }

  /* ---------------- 联动 ---------------- */
  /** 按「时间范围」联动：各格子 K 线根数不同，用逻辑索引会对不上 */
  syncRange(src, range) {
    if (!src.ready || !range || range.from == null || range.to == null) return;
    if (this.syncLock) return;
    this.syncLock = 1;
    for (const c of this.cells) {
      if (c === src || !c.chart || !c.ready) continue;
      if (!!c.intraday !== !!src.intraday) continue;
      try {
        const cur = c.chart.timeScale().getVisibleRange();
        // 已经一致就不必再设，避免互相触发形成回环（时间会被吸附到 K 线，留 1 秒容差）
        if (cur && Math.abs(cur.from - range.from) < 1 && Math.abs(cur.to - range.to) < 1) continue;
        c.chart.timeScale().setVisibleRange(range);
      } catch (e) { /* ignore */ }
    }
    this.syncLock = 0;
  }

  syncCrosshair(src, time) {
    if (!src.ready || this.crossLock) return;
    this.crossLock = true;
    for (const c of this.cells) {
      if (c === src || !c.chart || !c.times.length) continue;
      const idx = c.timeIdx(time);
      const price = c.closes[idx];
      if (price == null) continue;
      try { c.chart.setCrosshairPosition(price, time, c.candle); } catch (e) { /* ignore */ }
    }
    this.crossLock = false;
  }

  clearCrosshair(src) {
    if (this.crossLock) return;
    this.crossLock = true;
    for (const c of this.cells) {
      if (c === src || !c.chart) continue;
      try { c.chart.clearCrosshairPosition(); } catch (e) { /* ignore */ }
    }
    this.crossLock = false;
  }

  applyTheme() {
    this.cells.forEach((c) => { if (c.mounted) c.applyTheme(); });
  }

  resize() {
    this.cells.forEach((c) => { if (c.mounted) c.resize(); });
    this.syncMount();
  }
}
