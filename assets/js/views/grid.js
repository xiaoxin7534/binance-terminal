/* 图表墙：多图网格 + 指标 + 联动 */

import { api } from '../core/api.js';
import { state, market, save, dpOf, matchTab, matchMkt, isTabKey, DEFAULT_SYMBOLS } from '../core/store.js';
import { fmtPrice, fmtCompact, fmtPct, fmtFunding, dirClass, symLabel } from '../core/fmt.js';
import { sma, ema, boll, macd, macdLast, lastSma, lastEma, lastBoll } from '../core/ind.js';
import { openPicker } from '../core/picker.js';

const LC = window.LightweightCharts;
const IVS = ['time', '1m', '5m', '15m', '1h', '4h', '1d'];
const IV_LABEL = {
  time: '分时', '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d',
};
/** 分时用 1 分钟数据算，但订阅要落回 1m 流 */
const wsInterval = (iv) => (iv === 'time' ? '1m' : iv);
const MA_DEFS = [
  { p: 5, cls: 'lg-ma5', color: '#e8a33d', type: 'sma' },
  { p: 52, cls: 'lg-ma52', color: '#3b82f6', type: 'sma' },
  { p: 200, cls: 'lg-ma200', color: '#a855f7', type: 'sma' },
  { p: 200, cls: 'lg-ema200', color: '#f43f5e', type: 'ema', style: 2 },
];
const MACD_H = 72;
const BAR_LIMIT = 500;

/* 前端 K 线缓存：长墙上下来回滚动时不用每次都等接口 */
const KL_CACHE = new Map();
const KL_CACHE_MAX = 120;

function rememberKlines(key, k) {
  KL_CACHE.delete(key);
  KL_CACHE.set(key, { ts: Date.now(), k });
  while (KL_CACHE.size > KL_CACHE_MAX) {
    KL_CACHE.delete(KL_CACHE.keys().next().value);
  }
}

const cv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function themeColors() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    panel: cv('--panel'),
    text: cv('--text-2'),
    muted: cv('--muted'),
    grid: dark ? 'rgba(255,255,255,.05)' : 'rgba(15,23,42,.055)',
    up: cv('--up'),
    down: cv('--down'),
    cross: dark ? 'rgba(255,255,255,.2)' : 'rgba(15,23,42,.22)',
    label: dark ? '#2b3442' : '#4a5563',
    // 涨跌色统一走 CSS 变量，切配色方案时只改变量
    upVol: cv('--up-vol'),
    downVol: cv('--down-vol'),
    upSoft: cv('--up-fill'),
    downSoft: cv('--down-fill'),
    maBg: dark ? 'rgba(17,21,28,.86)' : 'rgba(255,255,255,.86)',
  };
}

function toLine(times, vals) {
  const out = new Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    out[i] = vals[i] === null || vals[i] === undefined ? { time: times[i] } : { time: times[i], value: vals[i] };
  }
  return out;
}

/* ------------------------------------------------------------------ Cell */

/**
 * 一个格子 = 表头 + 周期工具条 + 一张 lightweight-charts。
 * 大图模式（bigchart.js）会以 detached 模式复用这个类，所以别把 GridView 的
 * 东西写死进来——所有对 view 的调用都要能容忍 stub。
 */
export class Cell {
  constructor(view, index) {
    this.view = view;
    this.index = index;
    this.detached = !!view.detached;   // 大图模式：不写 state.cells
    this.symbol = null;
    this.interval = state.interval;
    this.bars = [];
    this.times = [];
    this.closes = [];
    this.maSeries = [];
    this.bollSeries = [];
    this.reqId = 0;
    this.legendIdx = -1;
    this.ready = false;
    this.mounted = false;     // 图表是否已挂载（视野外只留格子外壳）
    this.autoFit = true;      // 自动取景；用户手动拖动/缩放后置 false
    this.fitTimer = 0;

    this.el = document.createElement('div');
    this.el.className = 'cell';
    this.el.innerHTML = `
      <div class="cell-head">
        <div class="ch-row1">
          <button class="cell-sym"></button>
          <span class="cell-price">--</span>
          <span class="cell-chg">--</span>
        </div>
        <div class="ch-row2">
          <span>高 <b data-k="h">--</b></span>
          <span>低 <b data-k="lo">--</b></span>
          <span>额 <b data-k="qv">--</b></span>
          <span class="ch-fund" hidden>费 <b data-k="fr">--</b></span>
          <span class="ch-iv"></span>
        </div>
      </div>
      <div class="cell-tools"></div>
      <div class="cell-body">
        <div class="chart-host" style="position:absolute;inset:0"></div>
        <div class="cell-legend" data-role="legend"></div>
        <div class="cell-legend" data-role="mlegend"></div>
        <div class="cell-err hidden"></div>
        <div class="cell-loading hidden">加载中…</div>
      </div>`;

    this.symBtn = this.el.querySelector('.cell-sym');
    this.priceEl = this.el.querySelector('.cell-price');
    this.chgEl = this.el.querySelector('.cell-chg');
    this.hEl = this.el.querySelector('[data-k="h"]');
    this.loEl = this.el.querySelector('[data-k="lo"]');
    this.qvEl = this.el.querySelector('[data-k="qv"]');
    this.fundEl = this.el.querySelector('.ch-fund');
    this.frEl = this.el.querySelector('[data-k="fr"]');
    this.host = this.el.querySelector('.chart-host');
    this.legendEl = this.el.querySelector('[data-role="legend"]');
    this.mlegendEl = this.el.querySelector('[data-role="mlegend"]');
    this.errEl = this.el.querySelector('.cell-err');
    this.loadEl = this.el.querySelector('.cell-loading');
    this.toolsEl = this.el.querySelector('.cell-tools');

    // 用户手动拖动 / 滚轮缩放后，停止自动取景，免得把人家拖回去
    this.host.addEventListener('pointerdown', () => { this.autoFit = false; });

    // 滚轮优先滚动整个图表墙；墙没得滚（或按住 Ctrl）才交给图表缩放。
    // 必须用 capture，否则 lightweight-charts 的 canvas 监听器会先吃掉事件。
    this.host.addEventListener('wheel', (e) => {
      const g = this.view && this.view.root;
      const canScroll = g && g.scrollHeight > g.clientHeight + 1;
      if (!canScroll || e.ctrlKey) {
        this.autoFit = false;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      g.scrollTop += e.deltaY;
    }, { passive: false, capture: true });

    this.symBtn.addEventListener('click', () => {
      openPicker(this.symBtn, (sym) => this.setSymbol(sym));
    });

    // 单击选中、双击放大（拖拽过的不算点击）
    this.el.addEventListener('pointerdown', (e) => {
      this.downX = e.clientX;
      this.downY = e.clientY;
    });
    this.el.addEventListener('click', (e) => {
      if (e.target.closest('.cell-tools') || e.target.closest('.cell-sym')) return;
      if (Math.abs(e.clientX - (this.downX || 0)) > 4) return;
      if (Math.abs(e.clientY - (this.downY || 0)) > 4) return;
      this.view.setFocus(this.index);
    });
    this.el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.cell-tools') || e.target.closest('.cell-sym')) return;
      this.view.openBig(this.index);
    });

    this.toolsEl.innerHTML = IVS.map(
      (iv) => `<button data-iv="${iv}">${IV_LABEL[iv] || iv}</button>`
    ).join('');
    this.toolsEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-iv]');
      if (b) this.setInterval(b.dataset.iv);
    });
  }

  mount() {
    if (this.chart) return;
    this.mounted = true;
    this.buildChart();
    this.syncTools();
    if (this.times.length) this.paintBars();
    else if (this.symbol) this.load();
  }

  /** 只销毁图表、保留格子 DOM —— 滚动到视野外时用，避免几十张图同时吃内存 */
  unmountChart() {
    this.disposed = true;
    this.ready = false;
    this.reqId++;              // 丢弃在途的 K 线请求，回来也不会再画
    clearTimeout(this.fitTimer);
    clearTimeout(this.paneTimer);
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }
    if (this.chart) {
      try { this.chart.remove(); } catch (e) { /* ignore */ }
    }
    this.chart = null;
    this.candle = null;
    this.vol = null;
    this.macdHist = null;
    this.difLine = null;
    this.deaLine = null;
    this.maSeries = [];
    this.bollSeries = [];
    this.ind = null;
    this.mounted = false;
    this.bars = [];
    this.times = [];
    this.closes = [];
    this.vols = [];
  }

  /* ---------------- 图表生命周期 ---------------- */
  buildChart() {
    this.disposed = false;
    this.intraday = this.interval === 'time';
    const C = themeColors();
    const dp = dpOf(this.symbol);
    const ind = state.indicators;
    const W = Math.max(80, this.host.clientWidth || 320);
    const H = Math.max(80, this.host.clientHeight || 240);

    this.chart = LC.createChart(this.host, {
      width: W,
      height: H,
      layout: {
        background: { type: 'solid', color: C.panel },
        textColor: C.muted,
        fontSize: 10,
        fontFamily: '"Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
        attributionLogo: false,
      },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.07, bottom: 0.24 },
        entireTextOnly: true,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        barSpacing: 6,
        minBarSpacing: 0.1,      // 分时一天 1440 根要能塞进一个格子
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (time, type) => {
          const d = new Date(time * 1000);
          const p2 = (n) => String(n).padStart(2, '0');
          switch (type) {
            case 0: return String(d.getFullYear());
            case 1: return p2(d.getMonth() + 1) + '/01';
            case 2: return p2(d.getMonth() + 1) + '/' + p2(d.getDate());
            case 3: return p2(d.getHours()) + ':' + p2(d.getMinutes());
            default: return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
          }
        },
      },
      crosshair: {
        mode: LC.CrosshairMode.Normal,
        vertLine: { color: C.cross, width: 1, style: 3, labelBackgroundColor: C.label },
        horzLine: { color: C.cross, width: 1, style: 3, labelBackgroundColor: C.label },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      localization: { locale: 'zh-CN' },
    });

    if (this.intraday) {
      // 分时横轴只显示时分，不要出现 11/04 这种日期刻度
      const p2 = (n) => String(n).padStart(2, '0');
      this.chart.applyOptions({
        timeScale: {
          tickMarkFormatter: (time) => {
            const d = new Date(time * 1000);
            return p2(d.getHours()) + ':' + p2(d.getMinutes());
          },
        },
      });
    }

    if (this.intraday) {
      // 分时：以今日开盘价为基准的折线，高于基准红、低于基准绿
      this.candle = this.chart.addSeries(LC.BaselineSeries, {
        baseValue: { type: 'price', price: this.basePrice || 0 },
        topLineColor: C.up,
        topFillColor1: C.upSoft,
        topFillColor2: C.upSoft,
        bottomLineColor: C.down,
        bottomFillColor1: C.downSoft,
        bottomFillColor2: C.downSoft,
        lineWidth: 1.5,
        priceLineVisible: true,
        priceLineStyle: 2,
        priceLineWidth: 1,
        priceLineColor: C.muted,
        priceFormat: { type: 'price', precision: dp, minMove: Math.pow(10, -dp) },
      });
    } else {
      this.candle = this.chart.addSeries(LC.CandlestickSeries, {
        upColor: C.up,
        downColor: C.down,
        borderVisible: false,
        wickUpColor: C.up,
        wickDownColor: C.down,
        priceLineVisible: true,
        priceLineStyle: 2,
        priceLineWidth: 1,
        priceLineColor: C.up,
        priceFormat: { type: 'price', precision: dp, minMove: Math.pow(10, -dp) },
      });
    }

    this.vol = this.chart.addSeries(LC.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false,
    }, 0);
    this.chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.79, bottom: 0 },
      visible: false,
    });

    this.maSeries = [];
    this.bollSeries = [];
    this.hasMacd = false;

    if (!this.intraday) {
      // 均线
      this.maSeries = MA_DEFS.map((d) => ({
        ...d,
        vals: [],
        series: this.chart.addSeries(LC.LineSeries, {
          color: d.color,
          lineWidth: 1,
          lineStyle: d.style || 0,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }, 0),
      }));

      // 布林带
      this.bollSeries = [
        { key: 'up', color: '#8b95a5' },
        { key: 'mid', color: '#c0a24a' },
        { key: 'low', color: '#8b95a5' },
      ].map((d) => ({
        ...d,
        vals: [],
        series: this.chart.addSeries(LC.LineSeries, {
          color: d.color,
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }, 0),
      }));

      // MACD 副图
      this.hasMacd = ind.macd;
      if (ind.macd) {
        const mdp = Math.min(Math.max(dp, 2), 8);
        const fmt = { type: 'price', precision: mdp, minMove: Math.pow(10, -mdp) };
        this.macdHist = this.chart.addSeries(LC.HistogramSeries, {
          priceScaleId: 'right',
          priceFormat: fmt,
          lastValueVisible: false,
          priceLineVisible: false,
          base: 0,
        }, 1);
        this.difLine = this.chart.addSeries(LC.LineSeries, {
          priceScaleId: 'right', color: '#e8a33d', lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        }, 1);
        this.deaLine = this.chart.addSeries(LC.LineSeries, {
          priceScaleId: 'right', color: '#3b82f6', lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        }, 1);
        try {
          const panes = this.chart.panes();
          if (panes && panes[1] && panes[1].setHeight) panes[1].setHeight(MACD_H);
        } catch (e) { /* 旧版本忽略 */ }
      }
    }

    this.applyIndicators();
    this.bindEvents();
    this.layoutLegends();
    this.schedulePaneHeights();
    this.scheduleLegendLayout();

    if (!this.ro) {
      this.ro = new ResizeObserver(() => this.onResize());
    }
    this.ro.observe(this.host);
  }

  applyPaneHeights() {
    if (!this.hasMacd || !this.chart) return;
    try {
      const panes = this.chart.panes();
      if (!panes || !panes[1] || !panes[1].setHeight) return;
      // 指标窗占 22%，上下都限幅：小格里不至于把 K 线挤没，大格里也不至于太高
      const h = Math.round(Math.max(56, Math.min(140, this.host.clientHeight * 0.22)));
      panes[1].setHeight(h);
    } catch (e) { /* ignore */ }
  }

  /** setHeight 是异步生效的，尺寸刚变完就设会被内部布局覆盖，必须等布局稳定后再设一次 */
  schedulePaneHeights() {
    clearTimeout(this.paneTimer);
    this.paneTimer = setTimeout(() => {
      if (this.disposed || !this.chart) return;
      this.applyPaneHeights();
      setTimeout(() => {
        if (!this.disposed && this.chart) this.layoutLegends();
      }, 80);
    }, 220);
  }

  onResize() {
    if (this.disposed || !this.chart) return;
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    if (W < 10 || H < 10) return;
    this.chart.applyOptions({ width: W, height: H });
    this.schedulePaneHeights();
    this.scheduleLegendLayout();
    this.scheduleFit();
  }

  scheduleLegendLayout() {
    const run = () => {
      if (this.disposed || !this.chart) return;
      this.layoutLegends();
    };
    requestAnimationFrame(run);
    setTimeout(run, 130);
  }

  bindEvents() {
    this.chart.subscribeCrosshairMove((param) => {
      if (this.disposed) return;
      if (!param || !param.time) {
        this.legendIdx = -1;
        this.renderLegend(this.times.length - 1);
        if (state.sync) this.view.clearCrosshair(this);
        return;
      }
      const idx = this.timeIdx(param.time);
      this.legendIdx = idx;
      this.renderLegend(idx);
      if (state.sync) this.view.syncCrosshair(this, param.time);
    });

    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (this.disposed) return;
      if (range && state.sync) this.view.syncRange(this, range);
    });
  }

  layoutLegends() {
    if (this.disposed || !this.chart || !this.mlegendEl) return;
    const ind = state.indicators;
    if (!ind.macd || !this.hasMacd) {
      this.mlegendEl.style.display = 'none';
      return;
    }
    this.mlegendEl.style.display = '';
    let th = 24;
    let mh = MACD_H;
    try {
      th = this.chart.timeScale().height() || 24;
      const panes = this.chart.panes();
      if (panes && panes[1] && panes[1].getHeight) mh = panes[1].getHeight();
    } catch (e) { /* ignore */ }
    this.mlegendEl.style.bottom = (th + mh - 18) + 'px';
    this.mlegendEl.style.top = 'auto';
  }

  timeIdx(time) {
    // 二分查找
    const arr = this.times;
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] === time) return mid;
      if (arr[mid] < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(0, Math.min(arr.length - 1, hi));
  }

  /* ---------------- 数据 ---------------- */
  setSymbol(sym) {
    if (this.symbol === sym) return;
    this.symbol = sym;
    this.ready = false;
    this.autoFit = true;
    this.failCount = 0;
    if (!this.detached) {
      state.cells[this.index] = sym;
      save();
    }
    this.symBtn.innerHTML = `${symLabel(sym)} <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>`;
    this.applyPriceFormat();
    this.renderHead();
    if (this.mounted) {
      this.renderLegend(-1);
      this.load();
    }
    // 在格子里直接换币（表头下拉 / 板块批量填充）时，右侧详情也要跟着走
    if (!this.detached && this.index === this.view.focusIndex && this.view.ctx && this.view.ctx.onFocus) {
      this.view.ctx.onFocus(sym);
    }
    this.view.onCellsChanged();
  }

  setInterval(iv) {
    if (this.interval === iv) return;
    const wasIntraday = this.interval === 'time';
    this.interval = iv;
    this.autoFit = true;
    this.syncTools();
    // 分时和 K 线是两种图（折线 vs 蜡烛），切换时必须重建
    if (this.mounted && wasIntraday !== (iv === 'time')) {
      this.unmountChart();
      this.mount();
    } else if (this.mounted) {
      this.load();
    }
    this.view.onCellsChanged();
  }

  syncTools() {
    this.toolsEl.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.iv === this.interval);
    });
    const ivEl = this.el.querySelector('.ch-iv');
    if (ivEl) ivEl.textContent = IV_LABEL[this.interval] || this.interval;
  }

  applyPriceFormat() {
    const dp = dpOf(this.symbol);
    if (this.candle) {
      this.candle.applyOptions({
        priceFormat: { type: 'price', precision: dp, minMove: Math.pow(10, -dp) },
      });
    }
  }

  /** 把一批 K 线灌进图表 */
  applyKlines(k, silent) {
    this.times = [];
    this.bars = k;
    this.closes = new Array(k.length);
    this.vols = new Array(k.length);
    for (let i = 0; i < k.length; i++) {
      this.times.push(Math.floor(k[i][0] / 1000));
      this.closes[i] = k[i][4];
      this.vols[i] = k[i][5] || 0;
    }
    this.applyPriceFormat();
    this.paintBars(silent);
    this.renderHead();
    this.renderLegend(this.times.length - 1);
  }

  /** 分时：k = [[ts, close, vol], ...] */
  applyIntraday(k, silent) {
    this.times = [];
    this.bars = [];
    this.closes = [];
    this.vols = [];
    for (let i = 0; i < k.length; i++) {
      this.times.push(Math.floor(k[i][0] / 1000));
      this.closes.push(k[i][1]);
      this.vols.push(k[i][2] || 0);
    }
    this.applyPriceFormat();
    this.paintBars(silent);
    this.renderHead();
    this.renderLegend(this.times.length - 1);
  }

  async load(silent) {
    const id = ++this.reqId;
    const key = this.symbol + '|' + this.interval;
    // 先用缓存秒画（来回滚动时不至于每次都等接口）
    const hit = this.intraday ? null : KL_CACHE.get(key);
    // 缓存够新就直接用，连接口都不用打（WS 会把最后一根实时补上）
    if (hit && !silent && !this.bars.length && Date.now() - hit.ts < 30000) {
      this.errEl.classList.add('hidden');
      if (this.loadEl) this.loadEl.classList.add('hidden');
      this.applyKlines(hit.k, false);
      return;
    }
    if (hit && !silent && !this.bars.length) {
      this.errEl.classList.add('hidden');
      if (this.loadEl) this.loadEl.classList.add('hidden');
      this.applyKlines(hit.k, false);       // 先画旧的，同时后台刷新
    } else if (!silent && this.loadEl) {
      this.loadEl.classList.remove('hidden');
    }
    try {
      const res = this.intraday
        ? await api.intraday(this.symbol)
        : await api.klines(this.symbol, this.interval, BAR_LIMIT);
      if (id !== this.reqId) return;
      this.errEl.classList.add('hidden');
      this.failCount = 0;
      if (this.loadEl) this.loadEl.classList.add('hidden');
      if (this.intraday) {
        this.basePrice = res.o || 0;
        this.applyIntraday(res.k || [], silent);
      } else {
        rememberKlines(key, res.k);
        this.applyKlines(res.k, silent);
      }
    } catch (e) {
      if (id !== this.reqId) return;
      if (this.loadEl) this.loadEl.classList.add('hidden');
      // 长墙上难免有一两个下架/异常的品种，重试 3 次就停，别一直打接口
      this.failCount = (this.failCount || 0) + 1;
      if (this.failCount <= 3) {
        this.errEl.textContent = 'K线加载失败，稍后自动重试';
        this.errEl.classList.remove('hidden');
        setTimeout(() => { if (id === this.reqId && !this.disposed) this.load(); }, 4000);
      } else {
        this.errEl.textContent = 'K线加载失败';
        this.errEl.classList.remove('hidden');
      }
    }
  }

  paintBars(silent) {
    if (this.intraday) return this.paintIntraday(silent);
    const C = themeColors();
    const n = this.bars.length;
    const candles = new Array(n);
    const vols = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = this.bars[i];
      const t = this.times[i];
      candles[i] = { time: t, open: b[1], high: b[2], low: b[3], close: b[4] };
      vols[i] = { time: t, value: b[5], color: b[4] >= b[1] ? C.upVol : C.downVol };
    }
    this.candle.setData(candles);
    this.vol.setData(vols);
    // 最新价那条横线的颜色跟着最后一根走（原来只在收到实时推送时才更新，
    // 刚加载完会停在建图时的默认色，大图上看得特别明显）
    if (n) {
      const last = this.bars[n - 1];
      this.candle.applyOptions({ priceLineColor: last[4] >= last[1] ? C.up : C.down });
    }
    this.recalcIndicators();
    if (!silent) this.fitRange();
    this.layoutLegends();
  }

  paintIntraday(silent) {
    if (!this.candle) return;
    const C = themeColors();
    const base = this.basePrice || this.closes[0] || 0;
    try {
      this.candle.applyOptions({
        baseValue: { type: 'price', price: base },
        topLineColor: C.up, bottomLineColor: C.down,
        topFillColor1: C.upSoft, topFillColor2: C.upSoft,
        bottomFillColor1: C.downSoft, bottomFillColor2: C.downSoft,
      });
    } catch (e) { /* ignore */ }
    const n = this.times.length;
    const step = this.intradayStep();
    const line = [];
    const vols = [];
    for (let i = 0; i < n; i += step) {
      const end = Math.min(n, i + step);
      const close = this.closes[end - 1];
      const prev = i > 0 ? this.closes[i - 1] : close;
      let v = 0;
      for (let j = i; j < end; j++) v += this.vols[j] || 0;
      const t = this.times[i];
      line.push({ time: t, value: close });
      vols.push({ time: t, value: v, color: close < prev ? C.downVol : C.upVol });
    }
    this.candle.setData(line);
    if (this.vol) this.vol.setData(vols);
    if (!silent) this.fitRange();
    this.layoutLegends();
  }

  /** 分时抽样步长：小格子里 1440 个点会糊成毛边，约每 1.6px 一个点。
   *  步长取整分钟数（1/2/3/5/6/10/12/15/20/30/60），横轴刻度才会落在整点上 */
  intradayStep() {
    const STEPS = [1, 2, 3, 5, 6, 10, 12, 15, 20, 30, 60];
    const w = this.host.clientWidth || 320;
    const paneW = Math.max(80, w - 62);
    const want = 1440 / Math.max(60, paneW / 1.6);
    for (const st of STEPS) if (st >= want) return st;
    return 60;
  }

  fitRange() {
    // 分时：整天 00:00–24:00 铺满宽度，没走到的部分是空白
    if (this.intraday) {
      const w = this.host.clientWidth || 0;
      if (w < 20) return;
      const paneW = Math.max(80, w - 62);
      const slots = Math.ceil(1440 / this.intradayStep()) + 1;   // 抽样后的"一天有多少个槽"
      const spacing = Math.max(0.05, paneW / slots);
      try {
        this.chart.timeScale().applyOptions({ barSpacing: spacing, rightOffset: 0 });
        this.chart.timeScale().setVisibleLogicalRange({ from: -1, to: slots });
      } catch (e) { /* ignore */ }
      this.ready = true;
      return;
    }
    // 目标：K 线铺满整个格子，且最后一根贴住右侧
    // 先按容器宽度算出「铺满需要多大间距」，再滚到最右；间距过小说明放不下，就只显示最近的一段
    const n = this.bars.length;
    if (!n) return;
    const apply = (tries) => {
      if (!this.chart || this.disposed) return;
      const w = this.host.clientWidth || 0;
      if (w < 20) {
        if (tries < 60) requestAnimationFrame(() => apply(tries + 1));
        return;                       // 容器还没布局好，等下一帧
      }
      const paneW = Math.max(80, w - 62);        // 右侧价格轴约占 60px
      // 2.6px 是蜡烛还能看出形状的下限，低于它就只显示最近的一段；
      // 上限 14px 防止品种太少时蜡烛胖成方块
      const spacing = Math.max(2.6, Math.min(14, paneW / (n + 2)));
      try {
        this.chart.timeScale().applyOptions({ barSpacing: spacing, rightOffset: 1 });
        this.chart.timeScale().scrollToRealTime();
      } catch (e) { /* ignore */ }
      this.ready = true;
    };
    apply(0);
  }

  /** 尺寸变化后重新取景（用户手动拖动/缩放过就不再自动跳） */
  scheduleFit() {
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      if (this.disposed || !this.chart || !this.autoFit) return;
      // 分时要按新宽度重新抽样，否则点距和可视区间对不上
      if (this.intraday && this.times.length) this.paintIntraday(false);
      else if (this.bars.length) this.fitRange();
    }, 140);
  }

  recalcIndicators() {
    if (this.intraday) return;
    const ind = state.indicators;
    const closes = this.closes;
    const times = this.times;

    if (ind.ma) {
      for (const m of this.maSeries) {
        m.vals = m.type === 'ema' ? ema(closes, m.p) : sma(closes, m.p);
        m.series.applyOptions({ visible: true });
        m.series.setData(toLine(times, m.vals));
      }
    }
    if (ind.boll) {
      const b = boll(closes, 20, 2);
      for (const s of this.bollSeries) {
        s.vals = b[s.key];
        s.series.applyOptions({ visible: true });
        s.series.setData(toLine(times, s.vals));
      }
    }
    if (ind.macd && this.macdHist) {
      const m = macd(closes);
      this.ind = m;
      const C = themeColors();
      this.macdHist.setData(m.hist.map((v, i) => ({
        time: times[i], value: v, color: v >= 0 ? C.upVol : C.downVol,
      })));
      this.difLine.setData(toLine(times, m.dif));
      this.deaLine.setData(toLine(times, m.dea));
    }
  }

  applyIndicators() {
    const ind = state.indicators;
    for (const m of this.maSeries) m.series.applyOptions({ visible: !!ind.ma });
    for (const s of this.bollSeries) s.series.applyOptions({ visible: !!ind.boll });
    if (this.vol) this.vol.applyOptions({ visible: !!ind.vol });
    this.chart.priceScale('vol').applyOptions({
      scaleMargins: ind.vol ? { top: 0.79, bottom: 0 } : { top: 1, bottom: 0 },
    });
  }

  /* ---------------- 实时 ---------------- */
  onKline(d) {
    const t = Math.floor(d[0] / 1000);
    const n = this.times.length;
    if (!n) return;
    const lastT = this.times[n - 1];
    if (t < lastT) return;
    const C = themeColors();
    if (this.intraday) {
      const close = d[4];
      if (t > lastT) {
        this.times.push(t); this.closes.push(close); this.vols.push(d[5] || 0);
      } else {
        this.closes[n - 1] = close; this.vols[n - 1] = d[5] || 0;
      }
      const i = this.times.length - 1;
      const down = i > 0 && this.closes[i] < this.closes[i - 1];
      try {
        this.candle.update({ time: this.times[i], value: this.closes[i] });
        if (this.vol) {
          this.vol.update({
            time: this.times[i], value: this.vols[i] || 0,
            color: down ? C.downVol : C.upVol,
          });
        }
      } catch (e) { /* ignore */ }
      this.renderHead();
      if (this.legendIdx < 0) this.renderLegend(this.times.length - 1);
      return;
    }
    const isNew = t > lastT;
    if (isNew) {
      this.times.push(t);
      this.bars.push([d[0], d[1], d[2], d[3], d[4], d[5], d[6]]);
      this.closes.push(d[4]);
      if (this.times.length > BAR_LIMIT + 200) {
        this.times.shift();
        this.bars.shift();
        this.closes.shift();
      }
    } else {
      this.bars[n - 1] = [d[0], d[1], d[2], d[3], d[4], d[5], d[6]];
      this.closes[n - 1] = d[4];
    }
    this.candle.update({ time: t, open: d[1], high: d[2], low: d[3], close: d[4] });
    this.vol.update({ time: t, value: d[5], color: d[4] >= d[1] ? C.upVol : C.downVol });
    this.candle.applyOptions({ priceLineColor: d[4] >= d[1] ? C.up : C.down });
    this.updateTail();
    this.renderHead();
    if (this.legendIdx < 0) this.renderLegend(this.times.length - 1);
  }

  updateTail() {
    const ind = state.indicators;
    const i = this.times.length - 1;
    const t = this.times[i];
    const closes = this.closes;
    const C = themeColors();

    if (ind.ma) {
      for (const m of this.maSeries) {
        const v = m.type === 'ema' ? lastEma(closes, m.p) : lastSma(closes, m.p);
        if (v !== null && v !== undefined) {
          m.vals[i] = v;
          m.series.update({ time: t, value: v });
        }
      }
    }
    if (ind.boll) {
      const b = lastBoll(closes, 20, 2);
      if (b) {
        for (const s of this.bollSeries) {
          s.vals[i] = b[s.key];
          s.series.update({ time: t, value: b[s.key] });
        }
      }
    }
    if (ind.macd && this.macdHist) {
      const m = macdLast(closes);
      if (!this.ind) this.ind = { dif: [], dea: [], hist: [] };
      this.ind.dif[i] = m.dif;
      this.ind.dea[i] = m.dea;
      this.ind.hist[i] = m.hist;
      this.macdHist.update({ time: t, value: m.hist, color: m.hist >= 0 ? C.upVol : C.downVol });
      this.difLine.update({ time: t, value: m.dif });
      this.deaLine.update({ time: t, value: m.dea });
    }
  }

  /* ---------------- 渲染 ---------------- */
  renderHead() {
    const r = market.get(this.symbol);
    if (!r) return;
    const dp = dpOf(this.symbol);
    const cls = dirClass(r.chgp);
    this.priceEl.textContent = fmtPrice(r.l, dp);
    this.priceEl.className = 'cell-price ' + cls;
    this.chgEl.textContent = fmtPct(r.chgp);
    this.chgEl.className = 'cell-chg ' + cls;
    this.hEl.textContent = fmtPrice(r.h, dp);
    this.loEl.textContent = fmtPrice(r.lo, dp);
    this.qvEl.textContent = fmtCompact(r.qv);
    // 永续合约在头部多显示一项资金费率
    if (this.fundEl) {
      const on = r.mkt === 'perp' && r.fr != null;
      this.fundEl.hidden = !on;
      if (on && this.frEl) {
        this.frEl.textContent = fmtFunding(r.fr);
        this.frEl.className = dirClass(r.fr);
      }
    }
  }

  renderLegend(idx) {
    const i = idx === -1 || idx === undefined ? this.times.length - 1 : idx;
    const dp = dpOf(this.symbol);
    if (this.intraday) {
      const px = this.closes[i];
      const base = this.basePrice || this.closes[0] || 0;
      if (px == null) { this.legendEl.innerHTML = ''; return; }
      const pct = base ? ((px - base) / base) * 100 : 0;
      this.legendEl.innerHTML =
        `<span>今开 <b>${fmtPrice(base, dp)}</b></span>` +
        `<span class="${dirClass(pct)}">${fmtPct(pct)}</span>`;
      if (this.mlegendEl) this.mlegendEl.innerHTML = '';
      return;
    }
    const ind = state.indicators;
    const parts = [];

    if (ind.ma) {
      for (const m of this.maSeries) {
        const v = m.vals && m.vals[i];
        const nm = (m.type === 'ema' ? 'EMA' : 'MA') + m.p;
        parts.push(`<span class="${m.cls}">${nm} <b>${v == null ? '--' : fmtPrice(v, dp)}</b></span>`);
      }
    }
    if (ind.boll && this.bollSeries[1] && this.bollSeries[1].vals[i] != null) {
      const b = this.bollSeries;
      parts.push(`<span>BOLL <b>${fmtPrice(b[1].vals[i], dp)}</b></span>`);
    }
    this.legendEl.innerHTML = parts.join('');

    if (ind.macd && this.mlegendEl && this.ind) {
      const mdp = Math.min(Math.max(dp, 2), 8);
      const dif = this.ind.dif && this.ind.dif[i];
      const dea = this.ind.dea && this.ind.dea[i];
      const hist = this.ind.hist && this.ind.hist[i];
      this.mlegendEl.innerHTML =
        `<span class="lg-macd">MACD(12,26,9)</span>` +
        `<span class="lg-macd">DIF <b>${dif == null ? '--' : dif.toFixed(mdp)}</b></span>` +
        `<span class="lg-macd">DEA <b>${dea == null ? '--' : dea.toFixed(mdp)}</b></span>` +
        `<span class="lg-macd">MACD <b class="${dirClass(hist)}">${hist == null ? '--' : hist.toFixed(mdp)}</b></span>`;
    }
  }

  applyTheme() {
    const C = themeColors();
    this.chart.applyOptions({
      layout: { background: { type: 'solid', color: C.panel }, textColor: C.muted },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: {
        vertLine: { color: C.cross, labelBackgroundColor: C.label },
        horzLine: { color: C.cross, labelBackgroundColor: C.label },
      },
    });
    if (this.intraday) {
      this.candle.applyOptions({
        topLineColor: C.up, bottomLineColor: C.down,
        topFillColor1: C.upSoft, topFillColor2: C.upSoft,
        bottomFillColor1: C.downSoft, bottomFillColor2: C.downSoft,
      });
    } else {
      this.candle.applyOptions({
        upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
      });
    }
    this.repaintColors();
  }

  repaintColors() {
    if (!this.bars.length) return;
    this.paintBars(true);
  }

  resize() {
    this.layoutLegends();
  }

  destroy() {
    this.unmountChart();
    this.el.remove();
  }
}

/* -------------------------------------------------------------- GridView */

const MAX_CELLS = 400;      // 一张墙最多铺 400 个格子（虚拟滚动，同时只有 ~20 张图在跑）

export class GridView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.cells = [];
    this.cols = 4;
    this.focusIndex = 0;
    this.zoomed = false;
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
    if (this.zoomed) {
      this.zoomed = false;
      this.root.classList.remove('zoomed');
    }
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
    if (this.zoomed) {
      // 放大态只有一张图，其余全部卸掉
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (i === this.focusIndex) { if (!c.mounted) c.mount(); }
        else if (c.mounted) c.unmountChart();
      }
      return;
    }
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

  /** 双击：把当前格子放大到整面墙，再双击还原（已被大图模式取代，仅保留能力） */
  toggleZoom(i) {
    if (i != null) this.setFocus(i);
    this.zoomed = !this.zoomed;
    this.root.classList.toggle('zoomed', this.zoomed);
    this.syncMount();
    requestAnimationFrame(() => {
      const c = this.cells[this.focusIndex];
      if (c && c.mounted) { c.autoFit = true; c.fitRange(); }
    });
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
      if (c.symbol === msg.s && wsInterval(c.interval) === msg.i) c.onKline(msg.d);
    }
  }

  /* ---------------- 联动 ---------------- */
  syncRange(src, range) {
    if (!src.ready || !range) return;
    if (this.syncLock) return;
    this.syncLock = 1;
    for (const c of this.cells) {
      if (c === src || !c.chart || !c.ready) continue;
      if (!!c.intraday !== !!src.intraday) continue;
      try {
        const cur = c.chart.timeScale().getVisibleLogicalRange();
        // 已经一致就不必再设，避免互相触发形成回环
        if (cur && Math.abs(cur.from - range.from) < 0.4 && Math.abs(cur.to - range.to) < 0.4) continue;
        c.chart.timeScale().setVisibleLogicalRange(range);
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
