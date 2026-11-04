/* 左侧自选栏：自选 + 热门，点一下就把行情拉到主视图 */

import { market, state, isFav, toggleFav, dpOf } from '../core/store.js';
import { fmtPrice, fmtPct, dirClass, symLabel } from '../core/fmt.js';
import { openPicker } from '../core/picker.js';

const HOT_N = 14;

export class WatchView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.listEl = root.querySelector('#watch-list');
    this.refs = new Map();
    this.active = state.selected;

    root.querySelector('#watch-add').addEventListener('click', (e) => {
      e.stopPropagation();
      openPicker(e.currentTarget, (sym) => {
        if (!isFav(sym)) toggleFav(sym);
        this.render();
      });
    });

    this.listEl.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        toggleFav(del.dataset.del);
        this.render();
        return;
      }
      const row = e.target.closest('[data-s]');
      if (row && this.ctx.onPick) this.ctx.onPick(row.dataset.s);
    });

    this.listEl.addEventListener('dblclick', (e) => {
      const row = e.target.closest('[data-s]');
      if (row && this.ctx.onPickGrid) this.ctx.onPickGrid(row.dataset.s);
    });

    // 列表里点星标、详情里点星标都会触发
    window.addEventListener('favchange', () => this.render());

    this.render();
  }

  /** 自选在前，热门补位（同币种的现货/永续只留一个，避免 BTC 出现两遍） */
  buildGroups() {
    const favs = state.favs.filter((s) => market.has(s));
    const favSet = new Set(favs);
    const favBases = new Set(favs.map((s) => (market.get(s) || {}).b).filter(Boolean));
    const hot = [...market.values()]
      .filter((r) => !favSet.has(r.s) && !favBases.has(r.b))
      .sort((a, b) => b.qv - a.qv)
      .slice(0, HOT_N)
      .map((r) => r.s);
    return { favs, hot };
  }

  rowHtml(sym) {
    const r = market.get(sym);
    if (!r) return '';
    const dp = r.dp ?? 2;
    const perp = sym.endsWith('@f');
    const on = sym === this.active ? ' on' : '';
    return `<div class="w-row${on}" data-s="${sym}">
      <span class="w-sym">${r.b}<i>/${r.q}</i>${perp ? '<u>永</u>' : ''}</span>
      <span class="w-px">${fmtPrice(r.l, dp)}</span>
      <span class="w-chg ${dirClass(r.chgp)}">${fmtPct(r.chgp)}</span>
      <button class="w-del" data-del="${sym}" title="移出自选">✕</button>
    </div>`;
  }

  render() {
    const { favs, hot } = this.buildGroups();
    const parts = [];
    parts.push(`<div class="w-group">自选<span class="n">${favs.length}</span></div>`);
    if (!favs.length) {
      parts.push('<div class="w-empty">还没有自选，点右上角 + 添加<br>或直接双击热门里的代码</div>');
    } else {
      parts.push(favs.map((s) => this.rowHtml(s)).join(''));
    }
    if (hot.length) {
      parts.push(`<div class="w-group">热门<span class="n">按成交额</span></div>`);
      parts.push(hot.map((s) => this.rowHtml(s)).join(''));
    }
    this.listEl.innerHTML = parts.join('');
    this.refs.clear();
    this.listEl.querySelectorAll('[data-s]').forEach((el) => {
      this.refs.set(el.dataset.s, {
        el,
        px: el.querySelector('.w-px'),
        chg: el.querySelector('.w-chg'),
      });
    });
  }

  /** 每帧只改价格和涨跌幅，不重建 DOM */
  update(dirty) {
    for (const [sym, ref] of this.refs) {
      if (dirty && !dirty.has(sym)) continue;
      const r = market.get(sym);
      if (!r) continue;
      const dp = r.dp ?? 2;
      ref.px.textContent = fmtPrice(r.l, dp);
      ref.chg.textContent = fmtPct(r.chgp);
      ref.chg.className = 'w-chg ' + dirClass(r.chgp);
    }
  }

  setActive(sym) {
    this.active = sym;
    for (const [s, ref] of this.refs) ref.el.classList.toggle('on', s === sym);
  }
}
