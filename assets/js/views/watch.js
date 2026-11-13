/* 左侧自选栏：只放自选（热门榜已移除），点一下就把行情拉到主视图 */

import {
  market, state, isFav, toggleFav, clearFavs, setFavs, dpOf,
  currentFavGroup, setFavGroup, addFavGroup, renameFavGroup, removeFavGroup, restoreFavGroup,
} from '../core/store.js';
import { fmtPrice, fmtPct, dirClass, symLabel } from '../core/fmt.js';
import { openPicker, openMenu, openPrompt } from '../core/picker.js';


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
      const gbtn = e.target.closest('[data-gmenu]');
      if (gbtn) {
        e.stopPropagation();
        this.openGroupMenu(gbtn);
        return;
      }
      const clr = e.target.closest('[data-clear]');
      if (clr) {
        e.stopPropagation();
        const prev = state.favs.slice();
        if (!prev.length) return;
        clearFavs();
        // 一键清空 + 可撤销，比弹确认框顺手
        if (this.ctx.toast) {
          this.ctx.toast(`已清空 ${prev.length} 个自选`, {
            label: '撤销',
            onClick: () => setFavs(prev),
          });
        }
        return;
      }
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

  esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /** 分组菜单：切换 / 新建 / 重命名 / 删除 */
  openGroupMenu(btn) {
    const cur = currentFavGroup();
    const items = state.favGroups.map((g) => ({ key: 'g:' + g.id, label: g.name, count: g.list.length }));
    items.push({ divider: true }, { key: 'new', label: '新建分组…' });
    items.push({ key: 'rename', label: '重命名「' + cur.name + '」…' });
    if (state.favGroups.length > 1) items.push({ key: 'del', label: '删除「' + cur.name + '」' });

    openMenu(btn, items, 'g:' + cur.id, (k) => {
      if (k.startsWith('g:')) {
        setFavGroup(k.slice(2));
        return;
      }
      // 菜单的 onPick 之后紧跟 closePicker()，这里必须推到下一帧再开输入层，
      // 否则刚建出来的弹层会被那次 closePicker 一起收掉
      const promptLater = (opts) => setTimeout(() => openPrompt(btn, opts), 0);
      if (k === 'new') {
        promptLater({
          title: '新建分组', label: '名称', placeholder: '比如 主流 / 山寨 / 观察',
          okText: '创建', onOk: (v) => { addFavGroup(v); },
        });
        return;
      }
      if (k === 'rename') {
        promptLater({
          title: '重命名分组', label: '名称', value: cur.name, okText: '保存',
          onOk: (v) => { renameFavGroup(cur.id, v); },
        });
        return;
      }
      if (k === 'del') {
        // 分组连同里面的自选一起没了，给一次撤销机会
        const idx = state.favGroups.findIndex((g) => g.id === cur.id);
        const snap = { id: cur.id, name: cur.name, list: cur.list.slice() };
        const n = cur.list.length;
        if (removeFavGroup(cur.id) && this.ctx.toast) {
          this.ctx.toast(`已删除分组「${cur.name}」（${n} 个自选）`, {
            label: '撤销',
            onClick: () => restoreFavGroup(snap, idx),
          });
        }
      }
    });
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
    const favs = state.favs.filter((s) => market.has(s));
    const parts = [];
    const g = currentFavGroup();
    parts.push(`<div class="w-group"><button class="w-gname" data-gmenu title="切换 / 管理自选分组">`
      + `${this.esc(g.name)}<i>▾</i></button><span class="n">${favs.length}</span>`
      + (favs.length ? '<button class="w-clear" data-clear title="清空当前分组（可撤销）">清空</button>' : '')
      + '</div>');
    if (!favs.length) {
      parts.push('<div class="w-empty">还没有自选<br>点右上角 + 搜索添加，或在行情列表右键「加入自选」</div>');
    } else {
      parts.push(favs.map((s) => this.rowHtml(s)).join(''));
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
