/* 右侧详情：迷你走势 + 24h 数据 + 合约指标 + 盘口 + 逐笔 */

import { api } from '../core/api.js';
import { market, state, dpOf, isFav, toggleFav, sectorLabels } from '../core/store.js';
import { openMenu } from '../core/picker.js';
import { cachedKlines } from './cell.js';
import {
  fmtPrice, fmtCompact, fmtPct, fmtQty, fmtFunding, dirClass, clockTime,
} from '../core/fmt.js';

const LC = window.LightweightCharts;
const cv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const p2 = (n) => String(n).padStart(2, '0');

export class DetailPanel {
  /**
   * @param root 容器
   * @param opts { closable?: boolean, onClose?: () => void, delay?: number }
   *   delay 用于图表墙：方向键连续换格子时先攒一下，不要每挪一格就重建整块面板
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts || {};
    this.closable = !!this.opts.closable;
    this.delay = this.opts.delay || 0;
    this.symbol = null;
    this.pendingSym = null;
    this.setTimer = 0;
    this.chart = null;
    this.area = null;
    this.depthTimer = 0;
    this.cdTimer = 0;
    this.perpTimer = 0;
    this.bookTimer = 0;
    this.perp = null;
    this.trades = [];
    this.sizes = [];          // 近 200 笔成交额，用来算大单线
    this.onlyBig = false;
    this.tradeRaf = 0;
    this.lastDepth = null;
    this.pendTimers = [];      // 延后发出的请求（切币时要取消）
    this.bookStep = 0;         // 盘口价格合并粒度，0 = 原始精度
    this.renderEmpty();
  }

  renderEmpty() {
    // 图表必须先 remove：只把引用置 null 的话，lightweight-charts 内部的
    // ResizeObserver 还挂在即将被 innerHTML 丢掉的节点上，之后可能从库内部
    // 抛 "Value is null"（栈里没有我们自己的帧，很难查）。
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }
    if (this.chart) {
      try { this.chart.remove(); } catch (e) { /* 已经没了 */ }
      this.chart = null;
    }
    this.root.innerHTML = '<div class="dt-empty">选择左侧任意币种<br>查看盘口与明细</div>';
    this.$ = null;
    this.symbol = null;      // 不清掉的话，下次 setSymbol 同一个币会 early-return
    this.lastDepth = null;
    this.lastDepthAt = 0;

    // 元素引用必须跟着一起清。只清 `$` 的话 tradesEl 还是指向旧 DOM 的真值，
    // 已经排进 rAF 的那帧 renderTrades 会照常进来，对着 null 的 `$` 调用 → TypeError。
    // 实测触发路径：大图右侧面板开着、成交正高频推送时关面板 / 换币。
    this.pxEl = null;
    this.pctEl = null;
    this.chartEl = null;
    this.bookEl = null;
    this.tradesEl = null;
    this.flowEl = null;
    this.buyBarEl = null;
    this.trades = [];
    this.sizes = [];
    this.perp = null;
    if (this.tradeRaf) {
      cancelAnimationFrame(this.tradeRaf);
      this.tradeRaf = 0;
    }
    // 延后请求和轮询也一并停掉：面板已经空了，再拉就是白打接口
    clearTimeout(this.setTimer);       // 图表墙的 140ms 延迟换币，否则关掉面板又被它重建回来
    this.setTimer = 0;
    this.pendingSym = null;
    this.pendTimers.forEach(clearTimeout);
    this.pendTimers = [];
    clearInterval(this.cdTimer);
    clearInterval(this.perpTimer);
    clearInterval(this.bookTimer);
    this.cdTimer = 0;
    this.perpTimer = 0;
    this.bookTimer = 0;
  }

  /** 所在视图被隐藏时停止轮询（列表页和图表墙各有一块详情） */
  visible() {
    return this.root.getClientRects().length > 0;
  }

  /** BTCUSDT@f -> {perp:true, base:'BTC', quote:'USDT'} */
  symInfo() {
    const sym = this.symbol || '';
    const perp = sym.endsWith('@f');
    const raw = perp ? sym.slice(0, -2) : sym;
    const row = market.get(sym) || {};
    const quote = row.q || (raw.endsWith('USDC') ? 'USDC' : 'USDT');
    const base = row.b || raw.slice(0, Math.max(0, raw.length - quote.length));
    return { perp, base, quote, raw };
  }

  setSymbol(sym) {
    if (!sym) return;
    // 同一个币被再次选中时 applySymbol 会 early-return，
    // 但如果盘口已经很久没更新（WS 刚重连之类），这里补拉一次
    if (sym === this.symbol && this.lastDepthAt && Date.now() - this.lastDepthAt > 5000) {
      this.reloadBook();
    }
    if (!this.delay) {
      this.applySymbol(sym);
      return;
    }
    if (this.symbol === sym && !this.setTimer) return;
    this.pendingSym = sym;
    clearTimeout(this.setTimer);
    this.setTimer = setTimeout(() => {
      this.setTimer = 0;
      this.applySymbol(this.pendingSym);
    }, this.delay);
  }

  applySymbol(sym) {
    if (!sym || this.symbol === sym) return;
    this.symbol = sym;
    this.trades = [];
    this.sizes = [];
    this.lastDepth = null;
    this.perp = null;
    this.perpTries = 0;
    this.bookStep = 0;
    this.pendTimers.forEach(clearTimeout);
    this.pendTimers = [];
    clearInterval(this.cdTimer);
    clearInterval(this.perpTimer);
    clearInterval(this.bookTimer);
    this.build();
    this.loadSpark();
    this.loadSnapshot(sym);
    if (sym.endsWith('@f')) {
      // 盘口和成交先出（用户最常看），合约数据延后 400ms，
      // 免得 5 个请求同时打代理，反而全都慢
      this.pendTimers.push(setTimeout(() => this.loadPerp(sym), 400));
      this.pendTimers.push(setTimeout(() => this.loadFundHist(sym), 800));
      this.pendTimers.push(setTimeout(() => this.loadLSRH(sym), 1100));
      this.cdTimer = setInterval(() => this.tickCountdown(), 1000);
      this.perpTimer = setInterval(() => {
        if (!this.visible()) return;
        this.loadPerp(this.symbol);
      }, 20000);
      // 合约盘口走 DepthWorker 的 WS 推送（100ms），逐笔走 aggTrade；
      // REST 只做兜底：万一 WS 断了，30 秒补一次盘口，不至于整块空着
      this.bookTimer = setInterval(() => {
        if (!this.visible()) return;
        this.reloadBook();
      }, 30000);
    }
  }

  /** 兜底：只补盘口，不动已经累积的逐笔 */
  async reloadBook() {
    const sym = this.symbol;
    if (!sym) return;
    try {
      // 合并粒度越大，越需要更多原始档才凑够 10 档：need = 10 × (粒度 / 最小跳动)
      let lim = 20;
      if (this.bookStep) {
        const need = Math.ceil((10 * this.bookStep) / this.tick());
        lim = Math.min(1000, Math.max(50, need));
      }
      const d = await api.depth(sym, lim);
      if (sym !== this.symbol) return;
      this.lastDepth = { s: sym, b: d.b || [], a: d.a || [] };
      this.renderBook();
    } catch (e) { /* 网络抖动忽略 */ }
  }

  /** 切回本视图时补一次数据：面板隐藏期间轮询是停的，不补会显示旧价 */
  refresh() {
    if (!this.symbol || !this.$) return;
    // 首屏行情还没到时建过一次面板（表头全是 --、板块标签也是空的），
    // 等 market 有数据了整块重建一次
    if (this.stale && market.get(this.symbol)) {
      this.build();
      this.loadSpark();
      this.loadSnapshot(this.symbol);
      if (this.symbol.endsWith('@f')) {
        this.loadPerp(this.symbol);
        this.loadFundHist(this.symbol);
      }
      return;
    }
    this.updateStats();
    this.loadSpark();
    this.loadSnapshot(this.symbol);
    if (this.symbol.endsWith('@f')) {
      this.loadPerp(this.symbol);
      this.loadFundHist(this.symbol);
    }
  }

  /** 用 REST 快照先把盘口/成交填上，WS 订阅生效后再接管 */
  loadSnapshot(sym) {
    // 两个请求**分开渲染**：原来用 Promise.all，盘口要等成交一起回来才显示，
    // 而成交往往比盘口慢一倍，用户盯着「等待盘口数据…」干等
    api.depth(sym, 20).then((d) => {
      if (sym !== this.symbol) return;
      this.lastDepth = { s: sym, b: d.b || [], a: d.a || [] };
      this.lastDepthAt = Date.now();
      this.renderBook();
    }).catch(() => { /* 网络抖动忽略 */ });

    api.trades(sym, 20).then((t) => {
      if (sym !== this.symbol) return;
      const rows = (t.t || []).slice().reverse();
      this.trades = rows.map(([p, q, T, m]) => ({ s: sym, p, q, m, T }));
      this.sizes = this.trades.map((x) => x.p * x.q);
      this.renderTrades();
    }).catch(() => { /* 网络抖动忽略 */ });
  }

  build() {
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }
    if (this.chart) {
      this.chart.remove();
      this.chart = null;
    }
    const row = market.get(this.symbol) || {};
    const dp = dpOf(this.symbol);
    const info = this.symInfo();
    const base = info.base;
    const fav = isFav(this.symbol);
    const sec = (market.get(this.symbol) || {}).sec || [];
    const tags = sec.map((k) => `<span>${sectorLabels[k] || k}</span>`).join('');
    // 资金费率 / 标记价 / 基差这三项行情表里本来就有，先用它填上，
    // 用户不用等 /api/perp 那趟代理往返（2~4 秒）才看到数字
    let basisTxt = '--';
    let basisCls = '';
    if (row.mp && row.ip) {
      const b = (row.mp / row.ip - 1) * 100;
      basisTxt = (b > 0 ? '+' : '') + b.toFixed(3) + '%';
      basisCls = Math.abs(b) < 0.005 ? 'flat' : dirClass(b);
    }
    this.root.innerHTML = `
      <div class="dt-cols">
      <div class="dt-col">
      <div class="dt-head">
        <div class="dt-title">
          <h3>${base}<span style="font-size:11px;color:var(--muted)">/${info.quote}</span></h3>
          <span>${info.perp ? '币安永续' : '币安现货'}</span>
          <button class="icon-btn" data-role="fav" style="margin-left:auto;width:24px;height:24px" title="加自选">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8"
              style="color:${fav ? '#f5a623' : 'var(--muted)'}">
              <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.6 9.7l5.8-.8z"/>
            </svg>
          </button>
          ${this.closable ? `<button class="icon-btn dt-close" data-role="close" title="收起详情 (Esc)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </button>` : ''}
        </div>
        <div class="dt-price">
          <span class="v ${dirClass(row.chgp)}" data-role="px">${fmtPrice(row.l, dp)}</span>
          <span class="d ${dirClass(row.chgp)}" data-role="pct">${fmtPct(row.chgp)}</span>
        </div>
        <div class="dt-sub">
          <span>高 <b data-role="h">${fmtPrice(row.h, dp)}</b></span>
          <span>低 <b data-role="lo">${fmtPrice(row.lo, dp)}</b></span>
          <span>额 <b data-role="qv">${fmtCompact(row.qv)}</b></span>
        </div>
        ${tags ? `<div class="dt-tags">${tags}</div>` : ''}
      </div>
      <div class="dt-chart-wrap">
        <div class="dt-chart" data-role="chart"></div>
        <span class="dt-chart-tag">近 2 小时</span>
      </div>
      <div class="dt-section">
        <h4>行情统计<span class="cd" data-role="cd"></span><span class="line"></span></h4>
        <div class="kv-grid">
          <div class="kv"><span>今开</span><b data-role="o">${fmtPrice(row.o, dp)}</b></div>
          <div class="kv"><span>均价</span><b data-role="wavg">${fmtPrice(row.wavg, dp)}</b></div>
          <div class="kv"><span>最高</span><b data-role="h2">${fmtPrice(row.h, dp)}</b></div>
          <div class="kv"><span>最低</span><b data-role="lo2">${fmtPrice(row.lo, dp)}</b></div>
          <div class="kv"><span>成交量</span><b data-role="v">${fmtCompact(row.v)}</b></div>
          <div class="kv"><span>成交额</span><b data-role="qv2">${fmtCompact(row.qv)}</b></div>
          <div class="kv"><span>振幅</span><b data-role="amp">--</b></div>
          <div class="kv"><span>涨跌额</span><b data-role="chg" class="${dirClass(row.chgp)}">--</b></div>
        </div>
        ${info.perp ? `<div data-role="perp">
        <div class="kv-divider"></div>
        <div class="kv-grid">
          <div class="kv"><span>资金费率</span><b data-role="fr" class="${row.fr == null ? '' : dirClass(row.fr)}">${row.fr == null ? '--' : fmtFunding(row.fr)}</b></div>
          <div class="kv"><span>下次结算</span><b data-role="nft">${row.nft ? p2(new Date(row.nft).getMonth() + 1) + '/' + p2(new Date(row.nft).getDate()) + ' ' + p2(new Date(row.nft).getHours()) + ':' + p2(new Date(row.nft).getMinutes()) : '--'}</b></div>
          <div class="kv"><span>持仓量</span><b data-role="oi">--</b></div>
          <div class="kv"><span>持仓价值</span><b data-role="oiv">--</b></div>
          <div class="kv"><span>标记价</span><b data-role="mp">${row.mp ? fmtPrice(row.mp, dp) : '--'}</b></div>
          <div class="kv"><span>基差</span><b data-role="basis" class="${basisCls}">${basisTxt}</b></div>
        </div>
        <div class="lsr" data-role="lsr" hidden>
          <div class="lsr-bar"><i data-role="lsr-bar"></i></div>
          <div class="lsr-legend">
            <span class="up">多 <b data-role="longp">--</b></span>
            <span class="down">空 <b data-role="shortp">--</b></span>
            <span>多空比 <b data-role="lsrv">--</b></span>
          </div>
        </div>
        <div class="lsrh" data-role="lsrh" hidden></div>
        <div class="fh-head"><span>资金费率历史</span><span>近 9 次结算</span></div>
        <div class="fhist" data-role="fhist"></div>
        </div>` : ''}
      </div>
      </div>
      <div class="dt-col">
      <div class="dt-section">
        <h4>盘口<span class="line"></span><button class="book-tag book-step" data-role="step" title="价格合并粒度">${this.stepLabel()}</button></h4>
        <div class="book" data-role="book"><div class="muted" style="padding:8px 4px">等待盘口数据…</div></div>
      </div>
      <div class="dt-section" style="border-bottom:none">
        <h4>最近成交<span class="line"></span><button class="book-tag book-step" data-role="bigonly"
          title="只看大单：近 200 笔成交额排前 15% 的">大单</button></h4>
        <div class="tflow" data-role="tflow" hidden title="近 30 笔成交里，主动买 / 主动卖各占多少成交额">
          <div class="tflow-bar"><i data-role="buybar"></i></div>
          <div class="tflow-legend">
            <span class="up">主动买 <b data-role="buyp">--</b></span>
            <span>净额 <b data-role="net">--</b></span>
            <span class="down">主动卖 <b data-role="sellp">--</b></span>
          </div>
        </div>
        <div class="trade-head"><span>价格</span><span>成交额</span><span>时间</span></div>
        <div class="trades" data-role="trades"><div class="muted" style="padding:6px 4px">等待成交…</div></div>
      </div>
      </div>
      </div>`;

    this.$ = (r) => this.root.querySelector(`[data-role="${r}"]`);
    this.pxEl = this.$('px');
    this.pctEl = this.$('pct');
    this.chartEl = this.$('chart');
    this.bookEl = this.$('book');
    this.tradesEl = this.$('trades');
    this.flowEl = this.$('tflow');
    this.buyBarEl = this.$('buybar');

    this.root.querySelector('[data-role="fav"]').addEventListener('click', (e) => {
      toggleFav(this.symbol);
      const on = isFav(this.symbol);
      const svg = e.currentTarget.querySelector('svg');
      svg.setAttribute('fill', on ? 'currentColor' : 'none');
      svg.style.color = on ? '#f5a623' : 'var(--muted)';
    });

    const stepBtn = this.$('step');
    if (stepBtn) stepBtn.addEventListener('click', () => this.openStepMenu(stepBtn));

    // 只看大单：把碎单滤掉，剩下的就是真正在扫盘的那几笔
    const bigBtn = this.$('bigonly');
    if (bigBtn) {
      bigBtn.classList.toggle('on', this.onlyBig);
      bigBtn.addEventListener('click', () => {
        this.onlyBig = !this.onlyBig;
        bigBtn.classList.toggle('on', this.onlyBig);
        this.renderTrades();
      });
    }

    const closeBtn = this.root.querySelector('[data-role="close"]');
    if (closeBtn && this.opts.onClose) closeBtn.addEventListener('click', () => this.opts.onClose());

    this.createChart();
    this.updateStats();
  }

  createChart() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const W = Math.max(120, this.chartEl.clientWidth || 300);
    const H = Math.max(60, this.chartEl.clientHeight || 92);
    this.chart = LC.createChart(this.chartEl, {
      width: W,
      height: H,
      layout: {
        background: { type: 'solid', color: cv('--panel') },
        textColor: cv('--muted'),
        fontSize: 9,
        fontFamily: cv('--font'),
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: dark ? 'rgba(255,255,255,.05)' : 'rgba(15,23,42,.05)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.1 }, entireTextOnly: true },
      timeScale: { visible: false },
      crosshair: { mode: LC.CrosshairMode.Normal },
      handleScale: false,
      handleScroll: false,
    });
    this.area = this.chart.addSeries(LC.AreaSeries, {
      lineWidth: 1.4,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      topColor: cv('--up-fill'),
      bottomColor: cv('--up-fade'),
      lineColor: cv('--up'),
    });

    if (!this.ro) {
      this.ro = new ResizeObserver(() => {
        if (!this.chart) return;
        const w = this.chartEl.clientWidth;
        const h = this.chartEl.clientHeight;
        if (w > 10 && h > 10) {
          this.chart.applyOptions({ width: w, height: h });
          // 面板可能是在隐藏状态下建的（大图右侧栏）：那时宽高是 0，
          // fitContent() 算出来的可视区间是空的，之后再改尺寸也不会自动重算，
          // 表现就是「近 2 小时」一直是一块白板。尺寸一稳定就重排一次。
          try { this.chart.timeScale().fitContent(); } catch (e) { /* ignore */ }
        }
      });
    }
    this.ro.observe(this.chartEl);
  }

  async loadSpark() {
    const sym = this.symbol;
    // 格子 / 大图刚拉过这个币的 1m，先拿它铺上——迷你走势图只有 84px 高，
    // 让用户盯着空白等 2~5 秒的接口毫无意义
    const warm = cachedKlines(sym, '1m');
    if (warm && warm.length) {
      const rows = warm.slice(-120).map((b) => ({ time: Math.floor(b[0] / 1000), value: b[4] }));
      this.area.setData(rows);
      this.chart.timeScale().fitContent();
      this.colorSpark();
    }
    try {
      const res = await api.klines(sym, '1m', 120);
      if (sym !== this.symbol || !this.area) return;
      const data = res.k.map((b) => ({ time: Math.floor(b[0] / 1000), value: b[4] }));
      this.area.setData(data);
      this.chart.timeScale().fitContent();
      this.colorSpark();
    } catch (e) { /* ignore */ }
  }

  colorSpark() {
    const row = market.get(this.symbol);
    if (!row || !this.area) return;
    const up = row.chgp >= 0;
    this.area.applyOptions({
      lineColor: up ? cv('--up') : cv('--down'),
      topColor: up ? cv('--up-fill') : cv('--down-fill'),
      bottomColor: up ? cv('--up-fade') : cv('--down-fade'),
    });
  }

  updateStats() {
    if (!this.pxEl) return;
    const row = market.get(this.symbol);
    if (!row) return;
    const dp = dpOf(this.symbol);
    const cls = dirClass(row.chgp);
    this.pxEl.textContent = fmtPrice(row.l, dp);
    this.pxEl.className = 'v ' + cls;
    this.pctEl.textContent = fmtPct(row.chgp);
    this.pctEl.className = 'd ' + cls;
    const set = (r, v) => { const el = this.$(r); if (el) el.textContent = v; };
    set('h', fmtPrice(row.h, dp));
    set('lo', fmtPrice(row.lo, dp));
    set('qv', fmtCompact(row.qv));
    set('o', fmtPrice(row.o, dp));
    set('wavg', fmtPrice(row.wavg, dp));
    set('h2', fmtPrice(row.h, dp));
    set('lo2', fmtPrice(row.lo, dp));
    set('v', fmtCompact(row.v));
    set('qv2', fmtCompact(row.qv));
    set('amp', row.o ? (((row.h - row.lo) / row.o) * 100).toFixed(2) + '%' : '--');
    const chg = this.$('chg');
    if (chg) {
      chg.textContent = (row.l - row.o >= 0 ? '+' : '') + fmtPrice(row.l - row.o, dp);
      chg.className = cls;
    }
  }

  onDepth(msg) {
    if (!msg || msg.s !== this.symbol) return;
    // 合并粒度模式下用的是 REST 拉的 200 档，WS 只推 20 档会把深档冲掉
    if (this.bookStep) return;
    this.lastDepth = msg;
    this.lastDepthAt = Date.now();
    if (this.depthTimer) return;
    this.depthTimer = setTimeout(() => {
      this.depthTimer = 0;
      this.renderBook();
    }, 120);
  }

  /** tick = 最小价格变动，按小数位推出来 */
  tick() {
    return Math.pow(10, -dpOf(this.symbol));
  }

  stepLabel() {
    if (!this.bookStep) return '原始 ▾';
    const d = dpOf(this.symbol);
    return String(Number(this.bookStep.toFixed(Math.max(d, 8)))) + ' ▾';
  }

  openStepMenu(anchor) {
    const tick = this.tick();
    const items = [{ key: '0', label: '原始精度' }, { divider: true }];
    for (let i = 0; i < 5; i++) {
      const v = tick * Math.pow(10, i);
      items.push({ key: String(v), label: String(Number(v.toFixed(8))) });
    }
    openMenu(anchor, items, String(this.bookStep), (key) => {
      this.bookStep = Number(key);
      const btn = this.$('step');
      if (btn) btn.textContent = this.stepLabel();
      // 粒度大时 20 档原始数据不够用，改成 REST 拉更多档 + 快一点的轮询
      clearInterval(this.bookTimer);
      if (this.bookStep) {
        this.reloadBook();
        this.bookTimer = setInterval(() => {
          if (!this.visible()) return;
          this.reloadBook();
        }, 2500);
      }
      this.renderBook();
    });
  }

  /** 按粒度合并档位：卖价向上取整、买价向下取整（保守，不会把价算错方向） */
  groupLevels(levels, step, side) {
    if (!step || !levels.length) return levels;
    const m = new Map();
    for (const [p, q] of levels) {
      const k = side === 'ask'
        ? Math.ceil(p / step - 1e-9) * step
        : Math.floor(p / step + 1e-9) * step;
      m.set(k, (m.get(k) || 0) + q);
    }
    return [...m.entries()].sort((a, b) => (side === 'ask' ? a[0] - b[0] : b[0] - a[0]));
  }

  renderBook() {
    const msg = this.lastDepth;
    if (!msg || !this.bookEl) return;
    const dp = dpOf(this.symbol);
    // 买卖各 10 档，并排两列：左卖右买，都用 column-reverse 让「卖一/买一」贴底，
    // 价差行紧跟在下面。10 行的高度 ≈ 原来 20 行的一半，不用再往下滚
    const asks = this.groupLevels(msg.a, this.bookStep, 'ask').slice(0, 10);
    const bids = this.groupLevels(msg.b, this.bookStep, 'bid').slice(0, 10);
    const maxQ = Math.max(
      ...asks.map((x) => x[1]), ...bids.map((x) => x[1]), 0.0000001
    );
    const bestAsk = asks.length ? asks[0][0] : null;
    const bestBid = bids.length ? bids[0][0] : null;
    const spread = bestAsk && bestBid ? bestAsk - bestBid : null;
    const spreadPct = bestAsk && bestBid ? ((bestAsk - bestBid) / bestAsk) * 100 : null;

    // 累计量：卖盘从卖1 往上加，买盘从买1 往下加
    const askCum = [];
    let acc = 0;
    for (const [, q] of asks) { acc += q; askCum.push(acc); }
    const bidCum = [];
    acc = 0;
    for (const [, q] of bids) { acc += q; bidCum.push(acc); }

    const cell = (p, q, cum, side) => `<div class="book-row ${side}">
      <span class="bar" style="width:${(q / maxQ) * 100}%"></span>
      <span class="bp">${fmtPrice(p, dp)}</span>
      <span class="bq">${fmtQty(q)}</span>
      <span class="bc">${fmtCompact(cum)}</span></div>`;

    // 卖盘从上到下：卖10 → 卖1
    const askHtml = asks.map(([p, q], i) => cell(p, q, askCum[i], 'ask')).reverse().join('');
    const bidHtml = bids.map(([p, q], i) => cell(p, q, bidCum[i], 'bid')).join('');

    const row = market.get(this.symbol) || {};
    const lastPx = row.l || (bids[0] ? bids[0][0] : 0);
    const up = (row.chgp || 0) >= 0;

    // 买卖力量对比（按当前这 20 档的总量）
    const sumBid = bidCum[bidCum.length - 1] || 0;
    const sumAsk = askCum[askCum.length - 1] || 0;
    const tot = sumBid + sumAsk || 1;
    const bidPct = (sumBid / tot) * 100;

    this.bookEl.innerHTML = `
      <div class="book-head"><span>价格</span><span>数量</span><span>合计</span></div>
      ${askHtml}
      <div class="book-last ${up ? 'up' : 'down'}">
        <span>${fmtPrice(lastPx, dp)}</span><i>${up ? '↑' : '↓'}</i>
        <em>${spread == null ? '' : '价差 ' + fmtPrice(spread, dp) + ' (' + spreadPct.toFixed(3) + '%)'}</em>
      </div>
      ${bidHtml}
      <div class="book-ratio">
        <span class="up">B ${bidPct.toFixed(1)}%</span>
        <div class="book-ratio-bar"><i style="width:${bidPct}%"></i></div>
        <span class="down">${(100 - bidPct).toFixed(1)}% S</span>
      </div>`;
  }

  onTrade(msg) {
    if (!msg || msg.s !== this.symbol) return;
    this.pushTrade(msg);
  }

  /** 收一笔成交：只入队，渲染合并到下一帧
   *  逐笔重建 30 行 DOM 在高频合约上会把主线程占满，看盘反而卡 */
  pushTrade(t) {
    this.trades.unshift(t);
    if (this.trades.length > 30) this.trades.length = 30;
    this.sizes.push(t.p * t.q);
    if (this.sizes.length > 200) this.sizes.shift();
    if (this.tradeRaf) return;
    this.tradeRaf = requestAnimationFrame(() => {
      this.tradeRaf = 0;
      this.renderTrades();
    });
  }

  /** 大单线：近 200 笔成交额的 85 分位
   *  绝对金额跨币种没法比（BTC 的 5 万 U 和某个小币的 5 万 U 不是一个量级），
   *  用相对分位才能每个币都挑出"最显眼的那批" */
  bigThreshold() {
    const n = this.sizes.length;
    if (n < 12) return Infinity;
    const s = this.sizes.slice().sort((a, b) => a - b);
    return s[Math.min(n - 1, Math.floor(n * 0.85))];
  }

  renderTrades() {
    if (!this.$ || !this.tradesEl) return;   // 面板已清空（见 renderEmpty 的注释）
    const dp = dpOf(this.symbol);
    const big = this.bigThreshold();

    // 主动买 / 主动卖：m=1 表示买方挂单（主动卖），m=0 表示主动买
    let buy = 0;
    let sell = 0;
    for (const t of this.trades) {
      const v = t.p * t.q;
      if (t.m) sell += v;
      else buy += v;
    }
    const total = buy + sell;
    if (this.flowEl) {
      this.flowEl.hidden = !total;
      if (total) {
        const bp = (buy / total) * 100;
        this.buyBarEl.style.width = bp.toFixed(1) + '%';
        this.$('buyp').textContent = bp.toFixed(0) + '%';
        this.$('sellp').textContent = (100 - bp).toFixed(0) + '%';
        const net = buy - sell;
        const netEl = this.$('net');
        netEl.textContent = (net >= 0 ? '+' : '-') + fmtCompact(Math.abs(net));
        netEl.className = net >= 0 ? 'up' : 'down';
      }
    }

    // 统计用满 30 笔，屏幕上只放 18 行：再长就只是噪音，而且会把整个侧栏顶下去
    const rows = (this.onlyBig ? this.trades.filter((t) => t.p * t.q >= big) : this.trades)
      .slice(0, 18);
    if (!rows.length) {
      this.tradesEl.innerHTML = `<div class="muted" style="padding:6px 4px">${
        this.onlyBig ? '这一会儿没有大单' : '等待成交…'}</div>`;
      return;
    }
    this.tradesEl.innerHTML = rows.map((t) => {
      const v = t.p * t.q;
      return `<div class="trade-row${v >= big ? ' big' : ''}"
        title="${t.m ? '主动卖' : '主动买'} ${fmtQty(t.q)} · ${fmtCompact(v)} USDT">
        <span class="${t.m ? 'down' : 'up'}">${fmtPrice(t.p, dp)}</span>
        <span>${fmtCompact(v)}</span>
        <span>${clockTime(t.T)}</span></div>`;
    }).join('');
  }

  updateTick() {
    this.updateStats();
  }

  /* ---------------- 合约衍生指标 ---------------- */
  async loadPerp(sym) {
    if (!sym || !sym.endsWith('@f')) return;
    try {
      const d = await api.perp(sym);
      if (sym !== this.symbol) return;
      this.perp = d;
      this.renderPerp();
      this.tickCountdown();
      // 有些字段拿不到时面板上就是一片 "--"，而轮询要等 20 秒。这里按缺口补两次：
      //  - fr/mp：开服头几秒资金费率表还是空的；
      //  - oi：/api/perp 里持仓量单独有个 4 秒超时，代理抖一下就没了。
      const missing = d.fr == null || d.mp == null || d.oi == null;
      if (missing && this.perpTries < 2) {
        this.perpTries = (this.perpTries || 0) + 1;
        setTimeout(() => {
          if (sym === this.symbol) this.loadPerp(sym);
        }, 2000 * this.perpTries);
      }
    } catch (e) { /* 网络抖动忽略 */ }
  }

  renderPerp() {
    const d = this.perp;
    if (!d || !this.$) return;
    const set = (r, v, cls) => {
      const el = this.$(r);
      if (!el) return;
      el.textContent = v;
      if (cls !== undefined) el.className = cls;
    };
    const dp = dpOf(this.symbol);
    const row = market.get(this.symbol) || {};
    // 只覆盖有值的项：/api/perp 拿不到时（代理抖），别把 build() 里
    // 用行情表预填好的费率/标记价/基差又清成 --
    if (d.fr != null) set('fr', fmtFunding(d.fr), dirClass(d.fr));

    if (d.oi != null) {
      set('oi', fmtQty(d.oi));
      const px = d.mp || row.l || 0;
      set('oiv', px ? fmtCompact(d.oi * px) : '--');
    }
    if (d.mp) set('mp', fmtPrice(d.mp, dp));
    if (d.mp && d.ip) {
      const basis = (d.mp / d.ip - 1) * 100;
      set('basis', (basis > 0 ? '+' : '') + basis.toFixed(3) + '%',
        Math.abs(basis) < 0.005 ? 'flat' : dirClass(basis));
    }
    if (d.lsr != null && d.longPct != null) {
      const box = this.$('lsr');
      if (box) {
        box.hidden = false;
        const bar = this.$('lsr-bar');
        if (bar) bar.style.width = Math.max(2, Math.min(98, d.longPct)) + '%';
        set('longp', d.longPct.toFixed(1) + '%');
        set('shortp', (100 - d.longPct).toFixed(1) + '%');
        set('lsrv', d.lsr.toFixed(2));
      }
    }
  }

  tickCountdown() {
    const d = this.perp;
    const el = this.$ && this.$('cd');
    if (!el || !d || !d.nft) return;
    const left = d.nft - Date.now();
    if (left <= 0) {
      el.textContent = '结算中';
      return;
    }
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = (h ? h + 'h ' : '') + p2(m) + 'm ' + p2(s) + 's';
    const nftEl = this.$('nft');
    if (nftEl) {
      const dt = new Date(d.nft);
      nftEl.textContent = `${p2(dt.getMonth() + 1)}/${p2(dt.getDate())} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
    }
  }

  async loadFundHist(sym) {
    if (!sym || !sym.endsWith('@f')) return;
    try {
      const d = await api.fundingHist(sym);
      if (sym !== this.symbol) return;
      this.renderFundHist(d.h || []);
    } catch (e) { /* 网络抖动忽略 */ }
  }

  async loadLSRH(sym) {
    if (!sym || !sym.endsWith('@f')) return;
    try {
      const d = await api.lsrh(sym, '5m', 48);
      if (sym !== this.symbol) return;
      this.renderLSRH(d.h || []);
    } catch (e) { /* 网络抖动忽略 */ }
  }

  /** 多空账户比的历史走势：48 个 5 分钟点 = 近 4 小时 */
  renderLSRH(raw) {
    const el = this.$ && this.$('lsrh');
    if (!el) return;
    if (!raw.length) {
      el.hidden = true;
      return;
    }
    const vals = raw.map((x) => x[2]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = Math.max(0.8, max - min);
    const W = 100;
    const H = 26;
    const pts = vals.map((v, i) => {
      const x = (i / Math.max(1, vals.length - 1)) * W;
      const y = H - ((v - min) / span) * (H - 5) - 2.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const last = vals[vals.length - 1];
    el.hidden = false;
    el.innerHTML = `<div class="lsrh-head"><span>多空比走势</span><span>近 4 小时 · 多头 ${last.toFixed(1)}%</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="lsrh-svg">
        <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.3" vector-effect="non-scaling-stroke"/>
      </svg>`;
  }

  renderFundHist(raw) {
    const el = this.$ && this.$('fhist');
    if (!el) return;
    if (!raw.length) {
      el.innerHTML = '';
      return;
    }
    const hist = raw.slice(-9);      // 面板窄，9 根刚好放得下
    const max = Math.max(...hist.map((x) => Math.abs(x[1])), 0.0001);
    // 有负费率时零轴放中间（正柱向上、负柱向下），全是正的就把零轴放底部，多用一倍高度
    const hasNeg = hist.some((x) => x[1] < 0);
    el.classList.toggle('has-neg', hasNeg);
    // 列宽由 grid 均分，标签文字再长也不会把某一列撑宽
    el.style.gridTemplateColumns = `repeat(${hist.length}, minmax(0, 1fr))`;
    // 日期标签：首根 + 每三根 + 末根，同一天只标一次（否则末尾会出现两个 11/6）
    let lastLb = '';
    const labels = hist.map(([t], i) => {
      const d = new Date(t);
      const lb = `${d.getMonth() + 1}/${d.getDate()}`;
      const want = i === 0 || i === hist.length - 1 || i % 3 === 0;
      if (want && lb !== lastLb) {
        lastLb = lb;
        return lb;
      }
      return '';
    });
    el.innerHTML = hist.map(([t, r], i) => {
      // 线性比例：柱高就是「占最大值的百分比」。之前用 0.55 次幂拉开差距，
      // 结果 24% 的费率画成 46% 高，看着像差不多 —— 这是"比例不对"的来源。
      // 只留 3px 保底，免得极小的值完全看不见。
      const h = Math.max(0.09, Math.abs(r) / max).toFixed(3);
      const d = new Date(t);
      const lb = `${d.getMonth() + 1}/${d.getDate()}`;
      return `<div class="fh-col" title="${lb} ${p2(d.getHours())}:00 ${r.toFixed(4)}%">
        <div class="fh-bar"><i class="${r >= 0 ? 'up' : 'down'}" style="--h:${h}"></i></div>
        <span>${labels[i]}</span></div>`;
    }).join('');
  }

  applyTheme() {
    if (!this.chart) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    this.chart.applyOptions({
      layout: {
        background: { type: 'solid', color: cv('--panel') },
        textColor: cv('--muted'),
        fontFamily: cv('--font'),
      },
      grid: { horzLines: { color: dark ? 'rgba(255,255,255,.05)' : 'rgba(15,23,42,.05)' } },
    });
    this.colorSpark();
  }
}
