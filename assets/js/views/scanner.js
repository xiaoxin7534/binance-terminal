/* 永续扫描器：把全市场合约的资金费率 / 基差 / 成交额排到一张表里
 *
 * 数据全部来自 /api/market（每 30 秒一次全量 + SSE 增量），不需要额外接口。
 * 年化 = 单次费率 × 3（一天 3 次结算）× 365。
 */

import { market } from '../core/store.js';
import { fmtPrice, fmtPct, fmtCompact, fmtFunding, dirClass } from '../core/fmt.js';

const SORTS = [
  { key: 'annual', label: '年化费率' },
  { key: 'basis', label: '基差' },
  { key: 'qv', label: '成交额' },
  { key: 'chgp', label: '涨跌幅' },
];

const LIMIT = 150;

export class Scanner {
  constructor(root, ctx = {}) {
    this.root = root;
    this.ctx = ctx;
    this.sort = 'annual';
    this.desc = true;
    this.filter = '';
    this.minQv = 0;
    this.timer = 0;

    this.body = root.querySelector('#sc-body');
    this.countEl = root.querySelector('#sc-count');
    this.searchEl = root.querySelector('#sc-search');

    root.querySelector('#sc-close').addEventListener('click', () => this.close());
    root.addEventListener('click', (e) => {
      if (e.target.id === 'scanner') this.close();
    });

    root.querySelector('#sc-sort').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-s]');
      if (!b) return;
      const k = b.dataset.s;
      if (this.sort === k) this.desc = !this.desc;
      else {
        this.sort = k;
        this.desc = true;
      }
      this.syncSort();
      this.render();
    });

    root.querySelector('#sc-minqv').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (!b) return;
      this.minQv = Number(b.dataset.q);
      root.querySelectorAll('#sc-minqv button').forEach((x) => x.classList.toggle('on', x === b));
      this.render();
    });

    this.searchEl.addEventListener('input', () => {
      this.filter = this.searchEl.value.trim().toUpperCase();
      this.render();
    });

    this.body.addEventListener('click', (e) => {
      const row = e.target.closest('.sc-row');
      if (!row) return;
      const sym = row.dataset.sym;
      this.close();
      if (this.ctx.onPick) this.ctx.onPick(sym);
    });

    this.syncSort();
  }

  isOpen() {
    return !this.root.classList.contains('hidden');
  }

  syncSort() {
    this.root.querySelectorAll('#sc-sort button[data-s]').forEach((b) => {
      const on = b.dataset.s === this.sort;
      b.classList.toggle('on', on);
      b.textContent = (SORTS.find((s) => s.key === b.dataset.s) || {}).label + (on ? (this.desc ? ' ↓' : ' ↑') : '');
    });
  }

  open() {
    this.root.classList.remove('hidden');
    this.render();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.isOpen()) this.render();
    }, 1500);
  }

  close() {
    this.root.classList.add('hidden');
    clearInterval(this.timer);
    this.timer = 0;
    if (this.ctx.onClose) this.ctx.onClose();
  }

  /** 现货价格按 base 建索引，用来算基差 */
  spotIndex() {
    const m = new Map();
    for (const r of market.values()) {
      if (r.mkt === 'perp') continue;
      if (!m.has(r.b)) m.set(r.b, r);
    }
    return m;
  }

  collect() {
    const spot = this.spotIndex();
    const out = [];
    for (const r of market.values()) {
      if (r.mkt !== 'perp') continue;
      if (this.filter && !r.b.includes(this.filter)) continue;
      if (this.minQv && (r.qv || 0) < this.minQv) continue;
      const sp = spot.get(r.b);
      const basis = r.mp && sp && sp.l ? (r.mp / sp.l - 1) * 100 : null;
      const annual = r.fr != null ? r.fr * 3 * 365 : null;
      out.push({ r, annual, basis, spotPx: sp ? sp.l : null });
    }
    const key = this.sort;
    const dir = this.desc ? -1 : 1;
    const val = (x) => {
      if (key === 'annual') return x.annual == null ? -Infinity : x.annual;
      if (key === 'basis') return x.basis == null ? -Infinity : x.basis;
      if (key === 'qv') return x.r.qv || 0;
      return x.r.chgp || 0;
    };
    out.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va === -Infinity && vb === -Infinity) return 0;
      return (va - vb) * dir;
    });
    return out;
  }

  render() {
    if (!this.isOpen()) return;
    const all = this.collect();
    const rows = all.slice(0, LIMIT);
    this.countEl.textContent = `${all.length} 个永续，显示前 ${rows.length}`;

    const nft = Date.now();
    this.body.innerHTML = rows.map(({ r, annual, basis }) => {
      const dp = r.dp ?? 2;
      const left = r.nft ? r.nft - nft : null;
      const leftTxt = left == null ? '--'
        : left <= 0 ? '结算中'
          : `${Math.floor(left / 3600000)}h${String(Math.floor((left % 3600000) / 60000)).padStart(2, '0')}m`;
      return `<div class="sc-row" data-sym="${r.s}">
        <span class="sc-sym">${r.b}<i>永续</i></span>
        <span class="sc-num ${r.fr == null ? '' : dirClass(r.fr)}">${r.fr == null ? '--' : fmtFunding(r.fr)}</span>
        <span class="sc-num ${annual == null ? '' : dirClass(annual)}">${annual == null ? '--' : fmtPct(annual, 1)}</span>
        <span class="sc-num muted">${leftTxt}</span>
        <span class="sc-num ${basis == null ? '' : (Math.abs(basis) < 0.005 ? 'flat' : dirClass(basis))}">${basis == null ? '--' : fmtPct(basis, 3)}</span>
        <span class="sc-num">${r.mp ? fmtPrice(r.mp, dp) : '--'}</span>
        <span class="sc-num ${dirClass(r.chgp)}">${fmtPct(r.chgp)}</span>
        <span class="sc-num">${fmtCompact(r.qv)}</span>
      </div>`;
    }).join('') || '<div class="sc-empty">没有匹配的合约</div>';
  }
}
