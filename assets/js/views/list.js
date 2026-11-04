/* 行情列表：虚拟滚动表格 + 分类筛选 + 可拖动列 */

import {
  market, state, save, dpOf, isFav, toggleFav, sectorLabels, matchTab, matchMkt,
} from '../core/store.js';
import { fmtPrice, fmtCompact, fmtPct, dirClass, fmtSigned, fmtFunding } from '../core/fmt.js';

const ROW_H = 30;
const THEAD_H = 34;
const BUF = 8;

const COLS = [
  { key: 's', label: '币种', cls: 'name', w: 210, min: 152, flex: 2.4, locked: true },
  { key: 'l', label: '最新价', cls: 'r', w: 110, min: 92, flex: 1.5 },
  { key: 'chgp', label: '涨跌幅', cls: 'r', w: 96, min: 82, flex: 1.1 },
  { key: 'chg', label: '涨跌额', cls: 'r', w: 100, min: 86, flex: 1.1 },
  { key: 'spd', label: '涨速', cls: 'r', w: 84, min: 68, flex: 0.8 },
  { key: 'fr', label: '资金费率', cls: 'r', w: 94, min: 76, flex: 0.9 },
  { key: 'h', label: '24h 高', cls: 'r', w: 108, min: 88, flex: 1.0 },
  { key: 'lo', label: '24h 低', cls: 'r', w: 108, min: 88, flex: 1.0 },
  { key: 'qv', label: '成交额', cls: 'r', w: 108, min: 92, flex: 1.2 },
  { key: 'v', label: '成交量', cls: 'r', w: 98, min: 84, flex: 1.0 },
  { key: 'wavg', label: '均价', cls: 'r', w: 104, min: 88, flex: 1.0 },
  { key: 'amp', label: '振幅', cls: 'r', w: 80, min: 62, flex: 0.8 },
];

// 与币安官网的分类顺序保持一致
const SECTOR_ORDER = ['AI', 'L1', 'RWA', 'L2', 'GAME', 'MEME', 'INFRA', 'DEFI', 'META', 'TRADFI', 'CHINESE'];

const STAR_SVG = '<svg class="star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.6 9.7l5.8-.8z"/></svg>';

/** 按用户自定义顺序排列列 */
function orderedCols() {
  const order = state.colOrder;
  if (!Array.isArray(order) || !order.length) return COLS;
  const pool = new Map(COLS.map((c) => [c.key, c]));
  const out = [];
  for (const k of order) {
    const c = pool.get(k);
    if (c) { out.push(c); pool.delete(k); }
  }
  for (const c of COLS) if (pool.has(c.key)) out.push(c);
  const i = out.findIndex((c) => c.key === 's');
  if (i > 0) out.unshift(out.splice(i, 1)[0]);
  return out;
}

/* 容器变窄时先砍掉信息量最小的列，保证每列都还读得清 */
const PRIO = {
  // 振幅是常用的排序维度，优先级要高于 24h 低 / 成交量 / 均价
  s: 100, l: 95, chgp: 90, qv: 80, chg: 70, amp: 65, spd: 60,
  fr: 55, h: 50, lo: 45, v: 40, wavg: 30,
};

function fitCols(cols, avail) {
  if (!avail) return cols;
  const out = cols.slice();
  const sum = (cs) => cs.reduce((a, c) => a + c.min, 0);
  while (sum(out) > avail && out.length > 4) {
    let idx = -1;
    let lowest = Infinity;
    out.forEach((c, i) => {
      if (c.locked) return;
      const p = PRIO[c.key] ?? 0;
      if (p < lowest) { lowest = p; idx = i; }
    });
    if (idx < 0) break;
    out.splice(idx, 1);
  }
  return out;
}

export class ListView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.scroller = root.querySelector('#table-scroll');
    this.thead = root.querySelector('#thead');
    this.inner = root.querySelector('#tbody-inner');
    this.countEl = root.querySelector('#list-count');
    this.searchEl = root.querySelector('#list-search');
    this.sectorBar = root.querySelector('#sector-bar');
    this.rows = [];
    this.pool = new Map();
    this.range = [-1, -1];
    this.selected = state.selected;
    this.colWidth = 0;
    this.dragging = false;

    this.layoutCols();
    this.buildHead();
    this.buildSectorBar();
    root.querySelectorAll('#list-tab button').forEach((b) => {
      b.classList.toggle('on', b.dataset.t === (state.tab || 'all'));
    });
    this.mktBar = root.querySelector('#list-mkt');
    this.mktBar.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.m === (state.mkt || 'all'));
    });
    this.bind();
    this.searchEl.value = state.search || '';
    this.rebuild(true);
    this.timer = setInterval(() => this.rebuild(false), 2000);

    this.ro = new ResizeObserver(() => {
      const w = this.scroller.clientWidth;
      if (!w || w === this.colWidth) return;
      this.layoutCols();
      this.range = [-1, -1];
      this.renderWindow(true);
    });
    this.ro.observe(this.scroller);
  }

  /* ---------------- 列宽：全部用像素，保证表头与数据严格对齐 ---------------- */
  layoutCols() {
    const avail = this.scroller.clientWidth;
    if (!avail) return;
    this.colWidth = avail;
    const cols = fitCols(orderedCols(), avail);
    const base = cols.reduce((a, c) => a + c.w, 0);
    let widths;
    if (avail >= base) {
      const flexSum = cols.reduce((a, c) => a + c.flex, 0);
      const extra = avail - base;
      widths = cols.map((c) => Math.floor(c.w + (extra * c.flex) / flexSum));
    } else {
      const scale = avail / base;
      widths = cols.map((c) => Math.max(c.min, Math.floor(c.w * scale)));
      // 各列保底宽度加起来可能仍超出容器，按比例整体回收，否则最后一列会被裁掉
      let sum = widths.reduce((a, b) => a + b, 0);
      if (sum > avail) {
        const k = avail / sum;
        widths = widths.map((w) => Math.max(46, Math.floor(w * k)));
        sum = widths.reduce((a, b) => a + b, 0);
        while (sum > avail) {
          const j = widths.indexOf(Math.max(...widths));
          if (widths[j] <= 46) break;
          widths[j] -= 1;
          sum -= 1;
        }
      }
    }
    this.root.style.setProperty('--cols', widths.map((w) => w + 'px').join(' '));

    // 列数会随容器宽度变化，变了就得重建表头和行，否则表头与数据错位
    const sig = cols.map((c) => c.key).join(',');
    if (sig !== this.colSig) {
      this.colSig = sig;
      if (this.thead && this.thead.children.length) this.buildHead();
      if (this.rows && this.rows.length) {
        this.range = [-1, -1];
        this.renderWindow(true);
      }
    }
  }

  /* ---------------- 表头 ---------------- */
  buildHead() {
    const cols = fitCols(orderedCols(), this.colWidth);
    this.thead.innerHTML = cols.map((c) => {
      const sorted = state.sort.key === c.key ? ' sorted' : '';
      const arrow = state.sort.key === c.key ? (state.sort.dir < 0 ? '▼' : '▲') : '▼';
      const drag = c.locked ? '' : ' draggable="true"';
      return `<div class="${c.cls}${sorted}" data-key="${c.key}"${drag}>${c.label}<span class="arrow">${arrow}</span></div>`;
    }).join('');
    this.updateSortButtons();
  }

  updateSortButtons() {
    const bar = this.root.querySelector('#list-sort');
    if (!bar) return;
    const k = state.sort.key;
    bar.querySelectorAll('[data-s]').forEach((b) => {
      const on = (b.dataset.s === 'gain' && k === 'chgp' && state.sort.dir < 0)
        || (b.dataset.s === 'lose' && k === 'chgp' && state.sort.dir > 0);
      b.classList.toggle('on', on);
    });
  }

  /* ---------------- 分类栏 ---------------- */
  /** 各板块的成分数 + 平均涨跌幅（同一币种只算一次） */
  sectorStats() {
    const counts = {};
    const sum = {};
    const seen = new Set();
    let total = 0;
    for (const r of market.values()) {
      if (!matchMkt(r, state.mkt)) continue;
      const k = r.b + '|' + (r.mkt || 'spot');
      if (seen.has(k)) continue;
      seen.add(k);
      total++;
      for (const t of (r.sec || [])) {
        counts[t] = (counts[t] || 0) + 1;
        sum[t] = (sum[t] || 0) + (r.chgp || 0);
      }
    }
    const avg = {};
    for (const k in counts) avg[k] = sum[k] / counts[k];
    return { counts, avg, total };
  }

  buildSectorBar() {
    if (!this.sectorBar) return;
    const st = this.sectorStats();
    this.sectorBar._stats = st;
    const parts = [
      `<button class="sector-chip${!state.sector ? ' on' : ''}" data-sec="">全部板块<span class="n">${st.total}</span></button>`,
      '<span class="divider"></span>',
    ];
    for (const k of SECTOR_ORDER) {
      const label = sectorLabels[k];
      const n = st.counts[k] || 0;
      if (!label || !n) continue;
      const a = st.avg[k] || 0;
      parts.push(`<button class="sector-chip${state.sector === k ? ' on' : ''}" data-sec="${k}">${label}`
        + `<span class="n">${n}</span><span class="sec-chg ${dirClass(a)}" data-sec-chg="${k}">${fmtPct(a)}</span></button>`);
    }
    this.sectorBar.innerHTML = parts.join('');
  }

  /** 板块 chip 上的平均涨跌幅随行情刷新（只改文本，不重建 DOM）
   *  6 秒一次就够——每 2 秒跑一遍等于把全表多遍历一次 */
  updateSectorChg(force) {
    if (!this.sectorBar || !this.sectorBar.firstChild) return;
    const now = Date.now();
    if (!force && now - (this.sectorChgAt || 0) < 6000) return;
    this.sectorChgAt = now;
    const st = this.sectorStats();
    this.sectorBar.querySelectorAll('[data-sec-chg]').forEach((el) => {
      const a = st.avg[el.dataset.secChg] || 0;
      el.textContent = fmtPct(a);
      el.className = 'sec-chg ' + dirClass(a);
    });
  }

  /* ---------------- 事件 ---------------- */
  bind() {
    this.thead.addEventListener('click', (e) => {
      if (this.dragging) return;
      const el = e.target.closest('[data-key]');
      if (!el) return;
      const key = el.dataset.key;
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: key === 's' ? 1 : -1 };
      save();
      this.buildHead();
      this.rebuild(true);
    });

    this.bindDrag();

    let raf = 0;
    this.scroller.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        this.renderWindow(false);
      });
    }, { passive: true });

    this.searchEl.addEventListener('input', () => {
      state.search = this.searchEl.value;
      this.rebuild(true);
    });

    const tabBar = this.root.querySelector('#list-tab');
    tabBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]');
      if (!b) return;
      state.tab = b.dataset.t;
      tabBar.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      save();
      this.rebuild(true);
      this.scroller.scrollTop = 0;
    });

    // 一级分类：全部 / 现货 / 永续
    this.mktBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b || b.dataset.m === state.mkt) return;
      state.mkt = b.dataset.m;
      this.mktBar.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      save();
      this.buildSectorBar();
      this.rebuild(true);
      this.scroller.scrollTop = 0;
    });

    const sortBar = this.root.querySelector('#list-sort');
    sortBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      const dir = b.dataset.s === 'gain' ? -1 : 1;
      if (state.sort.key === 'chgp' && state.sort.dir === dir) {
        state.sort = { key: 'qv', dir: -1 };
      } else {
        state.sort = { key: 'chgp', dir };
      }
      save();
      this.buildHead();
      this.rebuild(true);
    });

    this.sectorBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sec]');
      if (!b) return;
      state.sector = b.dataset.sec || null;
      save();
      this.buildSectorBar();
      this.rebuild(true);
      this.scroller.scrollTop = 0;
    });

    this.inner.addEventListener('click', (e) => {
      const star = e.target.closest('.star');
      if (star) {
        e.stopPropagation();
        const row = star.closest('.row');
        if (row) {
          toggleFav(row.dataset.sym);
          star.classList.toggle('on', isFav(row.dataset.sym));
          if (state.tab === 'fav') this.rebuild(true);
        }
        return;
      }
      const r = e.target.closest('.row');
      if (r) this.select(r.dataset.sym);
    });

    this.inner.addEventListener('dblclick', (e) => {
      const r = e.target.closest('.row');
      if (!r) return;
      // 双击直接进大图；没有大图能力时退回「在多品种同列里打开」
      if (this.ctx.onOpenBig) this.ctx.onOpenBig(r.dataset.sym);
      else if (this.ctx.onOpenInGrid) this.ctx.onOpenInGrid(r.dataset.sym);
    });
  }

  /* ---------------- 拖动调整列顺序 ---------------- */
  bindDrag() {
    let dragKey = null;

    const clearMarks = () => {
      this.thead.querySelectorAll('.dragging,.drop-left,.drop-right')
        .forEach((x) => x.classList.remove('dragging', 'drop-left', 'drop-right'));
    };

    this.thead.addEventListener('dragstart', (e) => {
      const el = e.target.closest('[data-key]');
      if (!el || el.dataset.key === 's') { e.preventDefault(); return; }
      dragKey = el.dataset.key;
      this.dragging = true;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragKey);
    });

    this.thead.addEventListener('dragend', () => {
      clearMarks();
      dragKey = null;
      setTimeout(() => { this.dragging = false; }, 80);
    });

    this.thead.addEventListener('dragover', (e) => {
      if (!dragKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const el = e.target.closest('[data-key]');
      this.thead.querySelectorAll('.drop-left,.drop-right')
        .forEach((x) => x.classList.remove('drop-left', 'drop-right'));
      if (!el || el.dataset.key === dragKey || el.dataset.key === 's') return;
      const r = el.getBoundingClientRect();
      el.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-left' : 'drop-right');
    });

    this.thead.addEventListener('drop', (e) => {
      if (!dragKey) return;
      e.preventDefault();
      const el = e.target.closest('[data-key]');
      if (!el) { clearMarks(); return; }
      const target = el.dataset.key;
      if (target === 's' || target === dragKey) { clearMarks(); return; }
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;

      const order = orderedCols().map((c) => c.key);
      order.splice(order.indexOf(dragKey), 1);
      let to = order.indexOf(target);
      if (!before) to += 1;
      order.splice(to, 0, dragKey);

      state.colOrder = order;
      save();
      clearMarks();
      this.layoutCols();
      this.buildHead();
      this.range = [-1, -1];
      this.renderWindow(true);
    });
  }

  /* ---------------- 数据 ---------------- */
  computeRows() {
    const q = (state.search || '').trim().toUpperCase();
    const tab = state.tab || 'all';
    const sector = state.sector;
    const list = [];

    for (const r of market.values()) {
      if (!matchMkt(r, state.mkt)) continue;
      if (!matchTab(r, tab)) continue;
      if (sector && !(r.sec || []).includes(sector)) continue;
      if (q && !r.s.includes(q)) continue;
      list.push(r);
    }

    // 同一币种同一市场类型只保留成交额最大的计价对（现货/永续各留一行）
    const best = new Map();
    for (const r of list) {
      const k = r.b + '|' + (r.mkt || 'spot');
      const cur = best.get(k);
      if (!cur || r.qv > cur.qv) best.set(k, r);
    }
    list.length = 0;
    list.push(...best.values());

    const { key, dir } = state.sort;
    // 派生列要自己算：涨跌额 = 最新价 - 今开，振幅 =（高-低）/今开
    // 缺值的行（比如现货没有资金费率）不管升序降序都沉底，不然会混在中间
    const val = (r) => {
      if (key === 'chg') return r.l - r.o;
      if (key === 'amp') return r.o ? ((r.h - r.lo) / r.o) * 100 : null;
      const v = r[key];
      return v == null || !isFinite(v) ? null : v;
    };
    list.sort((a, b) => {
      if (key === 's') return a.b.localeCompare(b.b) * dir;
      const av = val(a);
      const bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
    return list;
  }

  rebuild(force) {
    const next = this.computeRows();
    const same = !force
      && next.length === this.rows.length
      && next.every((r, i) => r.s === this.rows[i].s);
    this.rows = next;
    this.inner.style.height = (next.length * ROW_H) + 'px';
    if (!same) {
      this.range = [-1, -1];
      this.renderWindow(true);
    }
    this.updateCount();
    this.updateSectorChg();
  }

  updateCount() {
    const uniq = new Set();
    for (const r of market.values()) {
      if (!matchMkt(r, state.mkt)) continue;
      uniq.add(r.b + '|' + (r.mkt || 'spot'));
    }
    this.countEl.textContent = `显示 ${this.rows.length} / 共 ${uniq.size} 个币种`;
  }

  renderWindow(force) {
    const st = Math.max(0, this.scroller.scrollTop - THEAD_H);
    const h = this.scroller.clientHeight || 400;
    const start = Math.max(0, Math.floor(st / ROW_H) - BUF);
    const end = Math.min(this.rows.length, Math.ceil((st + h) / ROW_H) + BUF);
    if (!force && start === this.range[0] && end === this.range[1]) return;
    this.range = [start, end];

    this.pool.clear();
    if (!this.rows.length) {
      this.inner.innerHTML = state.mkt === 'perp'
        ? '<div class="list-empty">合约行情未就绪<br><span style="font-size:11px;opacity:.75;line-height:1.8">请确认本机代理（v2rayN / Clash）已开启<br>合约行情流经 SOCKS5 连接 fstream.binance.com</span></div>'
        : '<div class="list-empty">该分类暂无标的</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      frag.appendChild(this.makeRow(this.rows[i], i));
    }
    this.inner.replaceChildren(frag);
  }

  cellHtml(c, row, dp, cls, amp) {
    switch (c.key) {
      case 's':
        return `<div class="sym-cell">
          ${STAR_SVG.replace('class="star"', `class="star${isFav(row.s) ? ' on' : ''}"`)}
          <span class="nm"><b>${row.b}</b><i>${(state.tab === 'new' && row.ln)
            ? new Date(row.ln).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
            : (row.q || 'USDT') + (row.mkt === 'perp' ? ' 永续' : '')}</i></span>
        </div>`;
      case 'l': return `<div class="r px ${cls}">${fmtPrice(row.l, dp)}</div>`;
      case 'chgp': return `<div class="r"><span class="pill ${cls}">${fmtPct(row.chgp)}</span></div>`;
      case 'chg': return `<div class="r ${cls}">${fmtSigned(row.l - row.o, dp)}</div>`;
      case 'spd': {
        const v = row.spd || 0;
        return `<div class="r ${dirClass(v)}">${(v > 0 ? '+' : '') + v.toFixed(2)}%</div>`;
      }
      case 'fr': {
        // 只有永续合约有资金费率，现货行留空占位
        if (row.mkt !== 'perp' || row.fr == null) return '<div class="r muted">--</div>';
        return `<div class="r ${dirClass(row.fr)}">${fmtFunding(row.fr)}</div>`;
      }
      case 'h': return `<div class="r muted">${fmtPrice(row.h, dp)}</div>`;
      case 'lo': return `<div class="r muted">${fmtPrice(row.lo, dp)}</div>`;
      case 'qv': return `<div class="r">${fmtCompact(row.qv)}</div>`;
      case 'v': return `<div class="r muted">${fmtCompact(row.v)}</div>`;
      case 'wavg': return `<div class="r muted">${fmtPrice(row.wavg, dp)}</div>`;
      case 'amp': return `<div class="r muted">${amp.toFixed(2)}%</div>`;
      default: return '<div></div>';
    }
  }

  makeRow(row, i) {
    const el = document.createElement('div');
    el.className = 'row' + (row.s === this.selected ? ' sel' : '');
    el.dataset.sym = row.s;
    el.style.top = (i * ROW_H) + 'px';
    const dp = row.dp ?? 2;
    const cls = dirClass(row.chgp);
    const amp = row.o ? ((row.h - row.lo) / row.o) * 100 : 0;

    const cols = fitCols(orderedCols(), this.colWidth);
    el.innerHTML = cols.map((c) => this.cellHtml(c, row, dp, cls, amp)).join('');

    const refs = { el, row };
    cols.forEach((c, idx) => {
      const node = el.children[idx];
      if (!node || c.key === 's') return;
      refs[c.key] = c.key === 'chgp' ? node.querySelector('.pill') : node;
    });
    this.pool.set(row.s, refs);
    return el;
  }

  updateLive(dirty) {
    if (!this.pool.size) return;
    for (const [sym, ref] of this.pool) {
      if (!dirty.has(sym)) continue;
      const r = market.get(sym);
      if (!r) continue;
      const dp = r.dp ?? 2;
      const cls = dirClass(r.chgp);
      if (ref.l) {
        const txt = fmtPrice(r.l, dp);
        if (ref.l.textContent !== txt) {
          ref.l.textContent = txt;
          ref.l.className = 'r px ' + cls;
        }
      }
      if (ref.chgp) {
        ref.chgp.textContent = fmtPct(r.chgp);
        ref.chgp.className = 'pill ' + cls;
      }
      if (ref.chg) {
        ref.chg.textContent = fmtSigned(r.l - r.o, dp);
        ref.chg.className = 'r ' + cls;
      }
      if (ref.spd) {
        const v = r.spd || 0;
        ref.spd.textContent = (v > 0 ? '+' : '') + v.toFixed(2) + '%';
        ref.spd.className = 'r ' + dirClass(v);
      }
      if (ref.fr && r.mkt === 'perp' && r.fr != null) {
        ref.fr.textContent = fmtFunding(r.fr);
        ref.fr.className = 'r ' + dirClass(r.fr);
      }
      if (ref.h) ref.h.textContent = fmtPrice(r.h, dp);
      if (ref.lo) ref.lo.textContent = fmtPrice(r.lo, dp);
      if (ref.qv) ref.qv.textContent = fmtCompact(r.qv);
      if (ref.v) ref.v.textContent = fmtCompact(r.v);
      if (ref.wavg) ref.wavg.textContent = fmtPrice(r.wavg, dp);
      if (ref.amp) ref.amp.textContent = (r.o ? ((r.h - r.lo) / r.o) * 100 : 0).toFixed(2) + '%';
    }
  }

  /** 当前筛选 + 排序下的全部 symbol（大图左右键翻品种用） */
  symbols() {
    return this.rows.map((r) => r.s);
  }

  select(sym) {
    this.selected = sym;
    state.selected = sym;
    save();
    this.pool.forEach((ref) => ref.el.classList.toggle('sel', ref.el.dataset.sym === sym));
    if (this.ctx.onSelect) this.ctx.onSelect(sym);
  }

  /** 板块标签更新后重建分类栏（app.js 定时刷新时调用） */
  setLabels() {
    this.buildSectorBar();
  }

  /** 筛选条件被外部（图表墙的板块菜单）改写后，同步按钮状态并重绘 */
  syncFilterUI() {
    this.root.querySelectorAll('#list-tab button').forEach((b) => {
      b.classList.toggle('on', b.dataset.t === (state.tab || 'all'));
    });
    if (this.mktBar) {
      this.mktBar.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.m === (state.mkt || 'all'));
      });
    }
    this.buildSectorBar();
    this.rebuild(true);
    this.scroller.scrollTop = 0;
  }

  onShow() {
    this.layoutCols();
    this.buildSectorBar();
    this.range = [-1, -1];
    this.renderWindow(true);
  }

  destroy() {
    clearInterval(this.timer);
    if (this.ro) this.ro.disconnect();
  }
}
