/* 资金费率告警
 *
 * 数据源就是每分钟一次的 `fund` 推送（服务端只发发生变化的合约），
 * 所以这里不需要额外轮询，只要在 applyFunding 之后跑一遍比较。
 *
 * 阈值是「资金费率绝对值」，单位 %，默认 0.05（常规是 0.01）。
 * 命中后：顶部提示 + 一声蜂鸣 + 进列表。同一合约 8 小时内不重复报。
 */

import { state, market } from './store.js';
import { fmtFunding, dirClass } from './fmt.js';

const MAX_HITS = 200;

export class Alerts {
  constructor(root, ctx = {}) {
    this.root = root;
    this.ctx = ctx;
    this.hits = [];
    this.baseline = null;      // 首次开启时的基线，避免一开就刷屏

    this.listEl = root.querySelector('#al-list');
    this.onEl = root.querySelector('#al-on');
    this.thrEl = root.querySelector('#al-thr');
    this.sysEl = root.querySelector('#al-sys');

    if (!state.alert) state.alert = { on: false, thr: 0.05, sys: false };
    this.onEl.checked = !!state.alert.on;
    this.thrEl.value = state.alert.thr;

    this.onEl.addEventListener('change', () => {
      state.alert.on = this.onEl.checked;
      if (this.ctx.save) this.ctx.save();
      if (state.alert.on) {
        this.baseline = this.currentHits();
        this.hits = [];
      } else {
        this.baseline = null;
      }
      this.render();
    });

    this.thrEl.addEventListener('change', () => {
      const v = Math.max(0.001, Math.min(5, Number(this.thrEl.value) || 0.05));
      this.thrEl.value = v;
      state.alert.thr = v;
      if (this.ctx.save) this.ctx.save();
      if (state.alert.on) {
        this.baseline = this.currentHits();
        this.hits = [];
      }
      this.render();
    });

    // 系统通知开关：要授权，被拒就自动弹回去（不能让开关停在"开"但实际收不到）
    if (this.sysEl) {
      this.sysEl.checked = !!state.alert.sys && 'Notification' in window
        && Notification.permission === 'granted';
      this.sysEl.addEventListener('change', async () => {
        const save = () => { if (this.ctx.save) this.ctx.save(); };
        if (!this.sysEl.checked) {
          state.alert.sys = false;
          save();
          return;
        }
        if (!('Notification' in window)) {
          this.sysEl.checked = false;
          if (this.ctx.toast) this.ctx.toast('这个浏览器不支持系统通知');
          return;
        }
        let perm = Notification.permission;
        if (perm === 'default') {
          try {
            perm = await Notification.requestPermission();
          } catch (e) { perm = 'denied'; }
        }
        if (perm !== 'granted') {
          this.sysEl.checked = false;
          state.alert.sys = false;
          save();
          if (this.ctx.toast) this.ctx.toast('系统通知被浏览器拦下了，地址栏左侧可以放行');
          return;
        }
        state.alert.sys = true;
        save();
        if (this.ctx.toast) this.ctx.toast('资金费率告警会弹系统通知');
      });
    }

    root.querySelector('#al-close').addEventListener('click', () => this.close());
    root.addEventListener('click', (e) => {
      if (e.target.id === 'alerts') this.close();
    });

    this.listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.al-row');
      if (!row) return;
      this.close();
      if (this.ctx.onPick) this.ctx.onPick(row.dataset.sym);
    });
  }

  isOpen() {
    return !this.root.classList.contains('hidden');
  }

  open() {
    this.root.classList.remove('hidden');
    this.render();
  }

  close() {
    this.root.classList.add('hidden');
  }

  /** 当前所有超阈值的合约（symbol 集合） */
  currentHits() {
    const thr = Math.abs(state.alert.thr || 0.05);
    const s = new Set();
    for (const r of market.values()) {
      if (r.mkt !== 'perp' || r.fr == null) continue;
      if (Math.abs(r.fr) >= thr) s.add(r.s);
    }
    return s;
  }

  /** 每次 funding 推送后调用 */
  check() {
    if (!state.alert || !state.alert.on) return;
    const now = this.currentHits();
    if (!this.baseline) {
      this.baseline = now;
      return;
    }
    const fresh = [];
    for (const sym of now) {
      if (this.baseline.has(sym)) continue;
      fresh.push(sym);
    }
    this.baseline = now;
    if (!fresh.length) return;

    const thr = Math.abs(state.alert.thr || 0.05);
    for (const sym of fresh) {
      const r = market.get(sym);
      if (!r) continue;
      this.hits.unshift({
        sym,
        base: r.b,
        fr: r.fr,
        nft: r.nft,
        at: Date.now(),
      });
    }
    if (this.hits.length > MAX_HITS) this.hits.length = MAX_HITS;
    this.render();
    this.notify(fresh, thr);
  }

  notify(syms, thr) {
    const first = market.get(syms[0]);
    const name = first ? first.b : syms[0];
    const more = syms.length > 1 ? ` 等 ${syms.length} 个` : '';
    if (this.ctx.toast) this.ctx.toast(`${name} 资金费率超过 ±${thr}%${more}`);
    this.beep();
    if (this.ctx.onFlash) this.ctx.onFlash();

    // 窗口在后台时页面内提示看不见，这时只有系统通知有用。
    // silent: 已经有蜂鸣了，别再来一次系统提示音。
    if (state.alert.sys && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const fr = first && first.fr != null ? `（${fmtFunding(first.fr)}）` : '';
        const n = new Notification(`资金费率告警${fr}`, {
          body: `${name} 超过 ±${thr}%${more}`,
          tag: 'bterm-funding',       // 同 tag 只留一条，别把通知中心刷满
          silent: true,
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch (e) { /* 平台不支持就算了，页面内提示还在 */ }
    }
  }

  /** 短促的两声蜂鸣，不用音频文件 */
  beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.actx) this.actx = new AC();
      const ctx = this.actx;
      if (ctx.state === 'suspended') ctx.resume();
      const play = (freq, delay) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.value = freq;
        const t0 = ctx.currentTime + delay;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        o.start(t0);
        o.stop(t0 + 0.18);
      };
      play(880, 0);
      play(1174, 0.19);
    } catch (e) { /* 浏览器不给放声音就算了 */ }
  }

  render() {
    if (!this.listEl) return;
    const thr = Math.abs(state.alert.thr || 0.05);
    if (!this.hits.length) {
      // 别写「暂无超阈值的合约」——超阈值的一大把，只是没「新突破」而已
      this.listEl.innerHTML = `<div class="al-empty">${state.alert.on
        ? `正在盯着：只报新突破 ±${thr}% 的合约<br><span style="opacity:.7">当前已超阈值的不会重复提醒，去扫描器看全量</span>`
        : '告警未开启'}</div>`;
      return;
    }
    const p2 = (n) => String(n).padStart(2, '0');
    this.listEl.innerHTML = this.hits.map((h) => {
      const d = new Date(h.at);
      const tm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
      return `<div class="al-row" data-sym="${h.sym}">
        <span class="al-sym">${h.base}<i>永续</i></span>
        <span class="al-fr ${dirClass(h.fr)}">${fmtFunding(h.fr)}</span>
        <span class="al-t">${tm}</span>
      </div>`;
    }).join('');
  }
}
