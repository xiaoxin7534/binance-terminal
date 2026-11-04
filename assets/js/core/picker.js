/* 交易对选择弹层 */

import { market, state } from './store.js';
import { fmtPrice, fmtPct, dirClass } from './fmt.js';

let cur = null;
let outsideBound = false;
let anchorEl = null;

function outside(e) {
  if (!cur) return;
  if (cur.contains(e.target)) return;
  if (anchorEl && anchorEl.contains(e.target)) return;
  closePicker();
}

export function closePicker() {
  if (cur) {
    cur.remove();
    cur = null;
    anchorEl = null;
  }
  if (outsideBound) {
    document.removeEventListener('mousedown', outside, true);
    outsideBound = false;
  }
}

export function openPicker(anchor, onPick) {
  closePicker();

  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.width = '272px';
  pop.innerHTML = '<div class="pop-search"><input placeholder="搜索交易对 / 币种" autocomplete="off" spellcheck="false"></div><div class="pop-list"></div>';
  document.body.appendChild(pop);

  const W = 272;
  const H = 330;
  const r = anchor.getBoundingClientRect();
  let left = Math.min(r.left, window.innerWidth - W - 10);
  let top = r.bottom + 4;
  if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 4);
  pop.style.left = Math.max(6, left) + 'px';
  pop.style.top = top + 'px';
  pop.style.height = H + 'px';

  const input = pop.querySelector('input');
  const listEl = pop.querySelector('.pop-list');
  let items = [];

  const render = (q) => {
    const query = (q || '').trim().toUpperCase();
    const all = [...market.values()];
    all.sort((a, b) => b.qv - a.qv);
    items = all
      .filter((r) => !query || r.s.includes(query) || r.b.includes(query))
      .slice(0, 120);

    if (!items.length) {
      listEl.innerHTML = '<div class="pop-empty">没有匹配的交易对</div>';
      return;
    }
    listEl.innerHTML = items.map((r, i) => `
      <div class="pop-item" data-i="${i}">
        <b>${r.b}<span class="muted" style="font-weight:400">/${r.q}</span>${r.mkt === 'perp' ? '<i class="perp-tag">永续</i>' : ''}</b>
        <span class="pp">${fmtPrice(r.l, r.dp)}</span>
        <span class="pc ${dirClass(r.chgp)}">${fmtPct(r.chgp)}</span>
      </div>`).join('');
  };

  listEl.addEventListener('click', (e) => {
    const it = e.target.closest('.pop-item');
    if (!it) return;
    const row = items[+it.dataset.i];
    if (row) {
      onPick(row.s);
      closePicker();
    }
  });

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePicker();
    if (e.key === 'Enter' && items[0]) {
      onPick(items[0].s);
      closePicker();
    }
  });

  render('');
  setTimeout(() => input.focus(), 20);
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    outsideBound = true;
  }, 0);

  anchorEl = anchor;
  cur = pop;
  return pop;
}

/** 通用下拉菜单：items = [{key,label,count} | {divider:true} | {header:'现货'} | {key,label,count,sub:true}] */
export function openMenu(anchor, items, current, onPick) {
  closePicker();

  const pop = document.createElement('div');
  pop.className = 'popover menu';
  pop.style.width = '232px';
  const list = document.createElement('div');
  list.className = 'pop-list';
  list.innerHTML = items.map((it) => {
    if (it.divider) return '<div class="menu-divider"></div>';
    if (it.header) return `<div class="menu-head">${it.header}</div>`;
    const on = it.key === current ? ' on' : '';
    const n = it.count == null ? '' : `<span class="n">${it.count}</span>`;
    return `<button class="menu-item${on}${it.sub ? ' sub' : ''}" data-k="${it.key}"><span>${it.label}</span>${n}</button>`;
  }).join('');
  pop.appendChild(list);
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  const W = 232;
  const H = Math.min(430, pop.offsetHeight || 320);
  const left = Math.min(r.left, window.innerWidth - W - 10);
  let top = r.bottom + 4;
  if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 4);
  pop.style.left = Math.max(6, left) + 'px';
  pop.style.top = top + 'px';

  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    onPick(b.dataset.k);
    closePicker();
  });

  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    outsideBound = true;
  }, 0);

  anchorEl = anchor;
  cur = pop;
  return pop;
}
