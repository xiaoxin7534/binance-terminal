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
    this.pendTimers = [];      // 延后发出的请求（切币时要取消）
    this.renderEmpty();
  }

  renderEmpty() {
    this.root.innerHTML = '<div class="dt-empty">选择左侧任意币种<br>查看盘口与明细</div>';
    this.chart = null;
    this.$ = null;
    this.symbol = null;      // 不清掉的话，下次 setSymbol 同一个币会 early-return
    this.lastDepth = null;
    this.lastDepthAt = 0;
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
    this.lastDepth = null;
    this.perp = null;
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
      const d = await api.depth(sym, 20);
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
      <div class="dt-section">
        <h4>盘口<span class="line"></span><span class="book-tag">买卖各 10 档</span></h4>
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
    this.lastDepthAt = Date.now();
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
    // 买卖各 10 档，并排两列：左卖右买，都用 column-reverse 让「卖一/买一」贴底，
    // 价差行紧跟在下面。10 行的高度 ≈ 原来 20 行的一半，不用再往下滚
    const asks = msg.a.slice(0, 10);
    const bids = msg.b.slice(0, 10);
    const maxQ = Math.max(
      ...asks.map((x) => x[1]), ...bids.map((x) => x[1]), 0.0000001
    );
    const bestAsk = asks.length ? asks[0][0] : null;
    const bestBid = bids.length ? bids[0][0] : null;
    const spread = bestAsk && bestBid ? bestAsk - bestBid : null;
    const spreadPct = bestAsk && bestBid ? ((bestAsk - bestBid) / bestAsk) * 100 : null;

    const cell = (p, q, side) => `<div class="book-row ${side}">
      <span class="bar" style="width:${(q / maxQ) * 100}%"></span>
      <span class="bp">${fmtPrice(p, dp)}</span><span class="bq">${fmtQty(q)}</span></div>`;

    const askCol = asks.map(([p, q]) => cell(p, q, 'ask')).join('');
    const bidCol = bids.map(([p, q]) => cell(p, q, 'bid')).join('');

    this.bookEl.innerHTML = `<div class="book-grid">
        <div class="book-col">${askCol}</div>
        <div class="book-col">${bidCol}</div>
      </div>
      <div class="spread-row">价差 <b>${spread == null ? '--' : fmtPrice(spread, dp)}</b>
        <span>${spreadPct == null ? '' : spreadPct.toFixed(3) + '%'}</span></div>`;
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
