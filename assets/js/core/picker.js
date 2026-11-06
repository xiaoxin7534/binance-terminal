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

/** 通用下拉菜单：items = [{key,label,count} | {divider:true} | {header:'现货'} | {key,label,count,sub:true}] */export function openMenu(anchor, items, current, onPick) {
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

/**
 * 指标参数弹层。
 * 改完点「应用」才生效——边输入边重算会让整面墙每敲一个字符就重算一遍指标。
 * @param current  当前参数（state.indParams）
 * @param defaults 默认值（「恢复默认」用）
 * @param onApply  (next) => void
 */
export function openParams(anchor, current, defaults, onApply) {
  closePicker();

  const pop = document.createElement('div');
  pop.className = 'popover params';
  const num = (f, v, min, max, step) =>
    `<input type="number" data-f="${f}" value="${v}" min="${min}" max="${max}" step="${step}" inputmode="decimal">`;
  const ma = (current.ma || defaults.ma).slice();
  const macd = (current.macd || defaults.macd).slice();

  pop.innerHTML = `
    <div class="pp-head">指标参数<span class="pp-hint">改完点应用</span></div>
    <div class="pp-row"><label>均线 MA</label><span class="pp-nums">
      ${num('ma0', ma[0], 1, 500, 1)}${num('ma1', ma[1], 1, 500, 1)}${num('ma2', ma[2], 1, 500, 1)}
    </span></div>
    <div class="pp-row"><label>均线 EMA</label><span class="pp-nums">
      ${num('ema', current.ema ?? defaults.ema, 1, 500, 1)}
    </span></div>
    <div class="pp-row"><label>BOLL 周期/倍数</label><span class="pp-nums">
      ${num('boll', current.boll ?? defaults.boll, 2, 500, 1)}
      ${num('bollMult', current.bollMult ?? defaults.bollMult, 0.5, 5, 0.5)}
    </span></div>
    <div class="pp-row"><label>MACD 快/慢/信号</label><span class="pp-nums">
      ${num('m0', macd[0], 1, 200, 1)}${num('m1', macd[1], 1, 200, 1)}${num('m2', macd[2], 1, 200, 1)}
    </span></div>
    <div class="pp-row"><label>爆量阈值 ×</label><span class="pp-nums">
      ${num('spike', current.spike ?? defaults.spike, 1.2, 20, 0.5)}
    </span></div>
    <div class="pp-foot">
      <button class="chip" data-act="reset">恢复默认</button>
      <button class="chip on" data-act="apply">应用</button>
    </div>`;
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  const W = pop.offsetWidth || 272;
  const H = pop.offsetHeight || 210;
  const left = Math.min(r.left, window.innerWidth - W - 10);
  let top = r.bottom + 4;
  if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 4);
  pop.style.left = Math.max(6, left) + 'px';
  pop.style.top = top + 'px';

  const read = () => {
    const g = (f, dflt, min, max) => {
      const el = pop.querySelector(`[data-f="${f}"]`);
      let v = Number(el && el.value);
      if (!Number.isFinite(v)) v = dflt;
      return Math.min(max, Math.max(min, v));
    };
    return {
      ma: [g('ma0', defaults.ma[0], 1, 500), g('ma1', defaults.ma[1], 1, 500), g('ma2', defaults.ma[2], 1, 500)],
      ema: g('ema', defaults.ema, 1, 500),
      boll: g('boll', defaults.boll, 2, 500),
      bollMult: g('bollMult', defaults.bollMult, 0.5, 5),
      macd: [g('m0', defaults.macd[0], 1, 200), g('m1', defaults.macd[1], 1, 200), g('m2', defaults.macd[2], 1, 200)],
      spike: g('spike', defaults.spike, 1.2, 20),
    };
  };

  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'reset') {
      const d = { ma0: defaults.ma[0], ma1: defaults.ma[1], ma2: defaults.ma[2],
        ema: defaults.ema, boll: defaults.boll, bollMult: defaults.bollMult,
        m0: defaults.macd[0], m1: defaults.macd[1], m2: defaults.macd[2],
        spike: defaults.spike };
      for (const k in d) {
        const el = pop.querySelector(`[data-f="${k}"]`);
        if (el) el.value = d[k];
      }
      return;
    }
    onApply(read());
    closePicker();
  });

  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onApply(read());
      closePicker();
    } else if (e.key === 'Escape') {
      closePicker();
    }
  });

  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    outsideBound = true;
  }, 0);
  setTimeout(() => {
    const el = pop.querySelector('input');
    if (el) { el.focus(); el.select(); }
  }, 20);

  anchorEl = anchor;
  cur = pop;
  return pop;
}
