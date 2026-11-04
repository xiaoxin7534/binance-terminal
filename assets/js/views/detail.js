/* 右侧详情：迷你走势 + 24h 数据 + 合约指标 + 盘口 + 逐笔 */

import { api } from '../core/api.js';
import { market, state, dpOf, isFav, toggleFav, sectorLabels } from '../core/store.js';
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
    this.lastDepth = null;
    this.bookOpen = false;     // 盘口默认 8 档（4 卖 + 4 买），展开后 20 档
    this.renderEmpty();
  }

  renderEmpty() {
    this.root.innerHTML = '<div class="dt-empty">选择左侧任意币种<br>查看盘口与明细</div>';
    this.chart = null;
    this.$ = null;
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
    this.lastDepth = null;
    this.perp = null;
    clearInterval(this.cdTimer);
    clearInterval(this.perpTimer);
    clearInterval(this.bookTimer);
    this.build();
    this.loadSpark();
    this.loadSnapshot(sym);
    if (sym.endsWith('@f')) {
      this.loadPerp(sym);
      this.loadFundHist(sym);
      this.cdTimer = setInterval(() => this.tickCountdown(), 1000);
      this.perpTimer = setInterval(() => {
        if (!this.visible()) return;
        this.loadPerp(this.symbol);
      }, 20000);
      // 合约 WS 网关不提供 depth 流，盘口/逐笔只能靠 REST 轮询
      this.bookTimer = setInterval(() => {
        if (!this.visible()) return;
        this.loadSnapshot(this.symbol);
      }, 4000);
    }
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
  async loadSnapshot(sym) {
    try {
      const [d, t] = await Promise.all([api.depth(sym, 20), api.trades(sym, 20)]);
      if (sym !== this.symbol) return;
      this.lastDepth = { s: sym, b: d.b || [], a: d.a || [] };
      this.renderBook();
      const rows = (t.t || []).slice().reverse();
      this.trades = rows.map(([p, q, T, m]) => ({ s: sym, p, q, m, T }));
      this.renderTrades();
    } catch (e) { /* 网络抖动忽略 */ }
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
    this.root.innerHTML = `
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
        <h4>24 小时统计<span class="line"></span></h4>
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
      </div>
      ${info.perp ? `
      <div class="dt-section" data-role="perp">
        <h4>合约数据<span class="cd" data-role="cd"></span><span class="line"></span></h4>
        <div class="kv-grid">
          <div class="kv"><span>资金费率</span><b data-role="fr">--</b></div>
          <div class="kv"><span>下次结算</span><b data-role="nft">--</b></div>
          <div class="kv"><span>持仓量</span><b data-role="oi">--</b></div>
          <div class="kv"><span>持仓价值</span><b data-role="oiv">--</b></div>
          <div class="kv"><span>标记价</span><b data-role="mp">--</b></div>
          <div class="kv"><span>基差</span><b data-role="basis">--</b></div>
        </div>
        <div class="lsr" data-role="lsr" hidden>
          <div class="lsr-bar"><i data-role="lsr-bar"></i></div>
          <div class="lsr-legend">
            <span class="up">多 <b data-role="longp">--</b></span>
            <span class="down">空 <b data-role="shortp">--</b></span>
            <span>多空比 <b data-role="lsrv">--</b></span>
          </div>
        </div>
        <div class="fh-head"><span>资金费率历史</span><span>近 9 次结算</span></div>
        <div class="fhist" data-role="fhist"></div>
      </div>` : ''}
      <div class="dt-section">
        <h4>盘口<span class="line"></span><button class="book-more${this.bookOpen ? ' on' : ''}" data-role="bookmore"
          title="切换盘口档位：8 档 / 20 档">${this.bookOpen ? '20 档 ▴' : '8 档 ▾'}</button></h4>
        <div class="book" data-role="book"><div class="muted" style="padding:8px 4px">等待盘口数据…</div></div>
      </div>
      <div class="dt-section" style="border-bottom:none">
        <h4>最近成交<span class="line"></span></h4>
        <div class="trade-head"><span>价格</span><span>数量</span><span>时间</span></div>
        <div class="trades" data-role="trades"><div class="muted" style="padding:6px 4px">等待成交…</div></div>
      </div>`;

    this.$ = (r) => this.root.querySelector(`[data-role="${r}"]`);
    this.pxEl = this.$('px');
    this.pctEl = this.$('pct');
    this.chartEl = this.$('chart');
    this.bookEl = this.$('book');
    this.tradesEl = this.$('trades');

    this.root.querySelector('[data-role="fav"]').addEventListener('click', (e) => {
      toggleFav(this.symbol);
      const on = isFav(this.symbol);
      const svg = e.currentTarget.querySelector('svg');
      svg.setAttribute('fill', on ? 'currentColor' : 'none');
      svg.style.color = on ? '#f5a623' : 'var(--muted)';
    });

    const closeBtn = this.root.querySelector('[data-role="close"]');
    if (closeBtn && this.opts.onClose) closeBtn.addEventListener('click', () => this.opts.onClose());

    const moreBtn = this.$('bookmore');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        this.bookOpen = !this.bookOpen;
        moreBtn.classList.toggle('on', this.bookOpen);
        moreBtn.textContent = this.bookOpen ? '20 档 ▴' : '8 档 ▾';
        this.renderBook();
      });
    }

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
        fontFamily: '"Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
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
        if (w > 10 && h > 10) this.chart.applyOptions({ width: w, height: h });
      });
    }
    this.ro.observe(this.chartEl);
  }

  async loadSpark() {
    const sym = this.symbol;
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
    this.lastDepth = msg;
    if (this.depthTimer) return;
    this.depthTimer = setTimeout(() => {
      this.depthTimer = 0;
      this.renderBook();
    }, 120);
  }

  renderBook() {
    const msg = this.lastDepth;
    if (!msg || !this.bookEl) return;
    const dp = dpOf(this.symbol);
    // 8 档 = 4 卖 + 4 买（默认），展开后 10 + 10。20 档全铺会把「最近成交」顶出可视区
    const N = this.bookOpen ? 10 : 4;
    const asks = msg.a.slice(0, N);
    const bids = msg.b.slice(0, N);
    const maxQ = Math.max(
      ...asks.map((x) => x[1]), ...bids.map((x) => x[1]), 0.0000001
    );
    const bestAsk = asks.length ? asks[0][0] : null;
    const bestBid = bids.length ? bids[0][0] : null;
    const spread = bestAsk && bestBid ? bestAsk - bestBid : null;
    const spreadPct = bestAsk && bestBid ? ((bestAsk - bestBid) / bestAsk) * 100 : null;

    const rows = [];
    for (let i = asks.length - 1; i >= 0; i--) {
      const [p, q] = asks[i];
      rows.push(`<div class="book-row ask"><span class="bar" style="width:${(q / maxQ) * 100}%"></span>
        <span class="bp">${fmtPrice(p, dp)}</span><span class="bq">${fmtQty(q)}</span></div>`);
    }
    rows.push(`<div class="spread-row">价差 <b>${spread == null ? '--' : fmtPrice(spread, dp)}</b>
      <span>${spreadPct == null ? '' : spreadPct.toFixed(3) + '%'}</span></div>`);
    for (const [p, q] of bids) {
      rows.push(`<div class="book-row bid"><span class="bar" style="width:${(q / maxQ) * 100}%"></span>
        <span class="bp">${fmtPrice(p, dp)}</span><span class="bq">${fmtQty(q)}</span></div>`);
    }
    this.bookEl.innerHTML = rows.join('');
  }

  onTrade(msg) {
    if (!msg || msg.s !== this.symbol) return;
    this.trades.unshift(msg);
    if (this.trades.length > 16) this.trades.pop();
    this.renderTrades();
  }

  renderTrades() {
    if (!this.tradesEl) return;
    const dp = dpOf(this.symbol);
    this.tradesEl.innerHTML = this.trades.map((t) => `
      <div class="trade-row">
        <span class="${t.m ? 'down' : 'up'}">${fmtPrice(t.p, dp)}</span>
        <span>${fmtQty(t.q)}</span>
        <span>${clockTime(t.T)}</span>
      </div>`).join('');
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
    set('fr', fmtFunding(d.fr), d.fr == null ? '' : dirClass(d.fr));

    if (d.oi != null) {
      set('oi', fmtQty(d.oi));
      const px = d.mp || row.l || 0;
      set('oiv', px ? fmtCompact(d.oi * px) : '--');
    }
    set('mp', d.mp ? fmtPrice(d.mp, dp) : '--');
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

  renderFundHist(raw) {
    const el = this.$ && this.$('fhist');
    if (!el) return;
    if (!raw.length) {
      el.innerHTML = '';
      return;
    }
    const hist = raw.slice(-9);      // 面板窄，9 根刚好放得下
    const max = Math.max(...hist.map((x) => Math.abs(x[1])), 0.0001);
    el.innerHTML = hist.map(([t, r], i) => {
      // 费率多数在 0.01% 附近，线性缩放会全变成一条细线，用 0.55 次幂拉开差距
      const hgt = Math.max(3, Math.round(Math.pow(Math.abs(r) / max, 0.55) * 24));
      const d = new Date(t);
      const lb = `${d.getMonth() + 1}/${d.getDate()}`;
      // 只在首尾标日期，中间留白，条形不会被文字挤乱
      const show = i === 0 || i === hist.length - 1 ? lb : '';
      return `<div class="fh-col" title="${lb} ${p2(d.getHours())}:00 ${r.toFixed(4)}%">
        <div class="fh-bar"><i class="${r >= 0 ? 'up' : 'down'}" style="height:${hgt}px"></i></div>
        <span>${show}</span></div>`;
    }).join('');
  }

  applyTheme() {
    if (!this.chart) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    this.chart.applyOptions({
      layout: { background: { type: 'solid', color: cv('--panel') }, textColor: cv('--muted') },
      grid: { horzLines: { color: dark ? 'rgba(255,255,255,.05)' : 'rgba(15,23,42,.05)' } },
    });
    this.colorSpark();
  }
}
