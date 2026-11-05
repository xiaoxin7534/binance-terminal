#!/usr/bin/env node
/**
 * 首屏 / 交互耗时测量（零依赖，Node 18+）
 *
 *   node tools/perf.mjs             跑一遍，打印时间线
 *   node tools/perf.mjs --headed    显示窗口
 *   node tools/perf.mjs --keep      跑完不关浏览器（看现场）
 *
 * 前提：本地服务已经跑起来（python server.py），默认 8848。
 * 和 e2e.mjs 的区别：e2e 断言「功能对不对」，perf 只量「有多慢」，不做断言。
 * 每次都用全新的 user-data-dir（没有 localStorage 缓存），量的是真实的冷启动。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8848';
const CDP_PORT = Number(process.env.PERF_CDP_PORT || 9555);
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('没找到 Chrome / Edge，可用 E2E_CHROME 指定路径');
}

function launchChrome(bin, profileDir) {
  const args = [
    HEADED ? '--window-size=1600,900' : '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1600,900',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ];
  return spawn(bin, args, { stdio: 'ignore', detached: false });
}

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch { /* 还没起来 */ }
  }
  throw new Error('Chrome 调试端口没起来');
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    };
  }

  send(method, params = {}) {
    const mid = ++this.id;
    this.ws.send(JSON.stringify({ id: mid, method, params }));
    return new Promise((res, rej) => this.pending.set(mid, { res, rej }));
  }

  async ev(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
  }
}

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有 page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return new Session(ws);
}

/* ------------------------------------------------------------------ 采样 */

const rows = [];
function rec(name, ms, note = '') {
  rows.push({ name, ms, note });
  const s = (ms / 1000).toFixed(2);
  console.log(`  ${String(ms).padStart(6)} ms  ${name}${note ? '  ' + note : ''}${ms > 2000 ? `   (${s}s)` : ''}`);
}

/** 轮询直到页面里的表达式为真，返回耗时 */
async function until(s, expr, timeout = 60000, step = 50) {
  const t0 = Date.now();
  for (let i = 0; i < timeout / step; i++) {
    let v = false;
    try { v = await s.ev(`return !!(${expr});`); } catch { /* 页面还没就绪 */ }
    if (v) return Date.now() - t0;
    await sleep(step);
  }
  return -1;
}

async function main() {
  const chrome = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'bt-perf-'));
  const proc = launchChrome(chrome, profile);
  try {
    await waitForCdp();
    const s = await connect();

    console.log('\n币安看盘终端 · 性能采样   ' + BASE + '\n');
    const t0 = Date.now();
    await s.goto(BASE + '/');
    await until(s, 'window.__term && window.__term.market', 30000);
    const tMarket = Date.now() - t0;
    await until(s, 'document.querySelectorAll("#grid .cell").length > 0', 30000);
    const tCells = Date.now() - t0;
    const tBars = await until(s, `window.__term.grid && window.__term.grid.cells.length > 0
      && window.__term.grid.cells.every(c => c && c.times && c.times.length > 50)`, 60000);
    const tFit = await until(s, `window.__term.grid.cells.every(c => c.mounted && c.autoFit === false)`, 30000);

    rec('行情到位（/api/market）', tMarket);
    rec('格子 DOM 出现', tCells);
    rec('8 格 K 线全部出图', tBars, tBars < 0 ? '超时' : '');
    if (tFit >= 0) rec('全部取景完成', tFit);

    // 资源瀑布：按开始时间排，标出慢的
    const res = await s.ev(`
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const rs = performance.getEntriesByType('resource').map(r => ({
        n: (r.name.split('/').pop() || r.name).slice(0, 46),
        s: Math.round(r.startTime), d: Math.round(r.duration), b: r.transferSize,
      }));
      return { dom: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0),
               count: rs.length, slow: rs.sort((a,b)=>b.d-a.d).slice(0, 6),
               last: rs.map(r=>r.s+r.d).sort((a,b)=>b-a)[0] || 0 };
    `);
    console.log(`\n  DOMContentLoaded ${res.dom} ms · load ${res.load} ms · ${res.count} 个请求 · 最后一个完成 ${res.last} ms`);
    console.log('  最慢的 6 个请求：');
    for (const r of res.slow) console.log(`    ${String(r.d).padStart(6)} ms  ${r.n}  ${(r.b / 1024).toFixed(0)}KB`);

    // 交互：换周期
    let ms = await s.ev(`
      const c = window.__term.grid.cells[0];
      c.setInterval('5m');
      const t0 = performance.now();
      for (let i = 0; i < 600; i++) {
        if (c.interval === '5m' && c.times.length > 50 && c.loadedKey && c.loadedKey.endsWith('|5m')) return Math.round(performance.now() - t0);
        await new Promise(r => setTimeout(r, 50));
      }
      return -1;
    `);
    rec('格子切 5m（命中缓存/预取）', ms, ms < 0 ? '超时' : '');

    // 交互：详情面板打开（列表页）
    ms = await s.ev(`
      document.querySelector('#tabs button[data-view="list"]').click();
      let row = null;
      for (let i = 0; i < 100; i++) {
        row = document.querySelector('.tbody-inner .row');
        if (row) break;
        await new Promise(r => setTimeout(r, 50));
      }
      if (!row) return -1;
      const t0 = performance.now();
      row.click();
      for (let i = 0; i < 400; i++) {
        const d = document.querySelector('#detail');
        const book = d && d.querySelector('[data-role="book"] .book-row');
        if (book) return Math.round(performance.now() - t0);
        await new Promise(r => setTimeout(r, 50));
      }
      return -1;
    `);
    rec('列表详情面板出盘口', ms, ms < 0 ? '超时' : '');

    // 交互：大图 + 持仓量
    ms = await s.ev(`
      const big = window.__term.big;
      big.open('BTCUSDT@f', '1m');
      const t0 = performance.now();
      for (let i = 0; i < 600; i++) {
        if (big.cell && big.cell.times.length > 100) break;
        await new Promise(r => setTimeout(r, 50));
      }
      return Math.round(performance.now() - t0);
    `);
    rec('大图打开并出 K 线', ms);

    ms = await s.ev(`
      const big = window.__term.big;
      const t0 = performance.now();
      // 和真人一样：打开大图先看图，等后台把持仓量预取回来再点按钮
      for (let i = 0; i < 600; i++) {
        if (big.oiCache && big.oiCache.rows && big.oiCache.rows.length > 10) return Math.round(performance.now() - t0);
        await new Promise(r => setTimeout(r, 50));
      }
      return -1;
    `);
    rec('大图打开后持仓量后台预取完成', ms, ms < 0 ? '没预取到' : '');

    ms = await s.ev(`
      const big = window.__term.big;
      const t0 = performance.now();
      document.querySelector('#bc-oi-btn').click();
      for (let i = 0; i < 900; i++) {
        if (big.oiData && big.oiData.length > 10) return Math.round(performance.now() - t0);
        await new Promise(r => setTimeout(r, 50));
      }
      return -1;
    `);
    rec('点开持仓量（数据到位）', ms, ms < 0 ? '超时/没数据' : '');

    ms = await s.ev(`
      const big = window.__term.big;
      big.close();
      await new Promise(r => setTimeout(r, 300));
      const c = window.__term.grid.cells[0];
      if (c.interval !== '5d') { c.setInterval('5d'); }
      const t0 = performance.now();
      for (let i = 0; i < 900; i++) {
        if (c.times.length > 100) return Math.round(performance.now() - t0);
        await new Promise(r => setTimeout(r, 50));
      }
      return -1;
    `);
    rec('切 5 日分时', ms, ms < 0 ? '超时' : '');

    // 交互流畅度：做动作的同时采样 rAF 间隔，给中位数和 p90（单位 ms/帧，16.7 = 满帧）
    const frameProbe = (action, times = 12) => `
      const deltas = [];
      let last = performance.now();
      let run = true;
      const loop = () => {
        const n = performance.now();
        deltas.push(n - last); last = n;
        if (run) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      for (let i = 0; i < ${times}; i++) { ${action}; await new Promise(r => setTimeout(r, 90)); }
      run = false;
      await new Promise(r => setTimeout(r, 60));
      deltas.sort((a, b) => a - b);
      return {
        med: Math.round(deltas[Math.floor(deltas.length / 2)] * 10) / 10,
        p90: Math.round(deltas[Math.floor(deltas.length * 0.9)] * 10) / 10,
      };
    `;

    // 先热一次：第一次切到列表要建行 + 算列宽，冷启动的耗时不该混进"切换视图"里
    await s.ev(`
      document.querySelector('#tabs button[data-view="list"]').click();
      await new Promise(r => setTimeout(r, 900));
      document.querySelector('#tabs button[data-view="grid"]').click();
      await new Promise(r => setTimeout(r, 500));
      return 1;
    `);

    ms = await s.ev(frameProbe(`
      const b = document.querySelector('#tabs button[data-view="' + (window.__term.state.view === 'grid' ? 'list' : 'grid') + '"]');
      b.click();
    `));
    rec('切换视图（帧间隔）', ms.med, `ms/帧 · p90 ${ms.p90}ms`);

    ms = await s.ev(frameProbe(`
      const sw = document.querySelector('#grid-detail-switch');
      sw.click();
    `));
    rec('开合详情侧板（帧间隔）', ms.med, `ms/帧 · p90 ${ms.p90}ms`);
    await s.ev(`if (!window.__term.state.detailOpen) document.querySelector('#grid-detail-switch').click(); await new Promise(r=>setTimeout(r,300)); return 1;`);

    // 长任务才是"卡不卡"的直接证据：>50ms 的主线程阻塞用户一定能感觉到
    const lt = await s.ev(`
      const tasks = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(Math.round(e.duration)); });
      po.observe({ type: 'longtask' });
      const sw = document.querySelector('#grid-detail-switch');
      for (let i = 0; i < 4; i++) { sw.click(); await new Promise(r => setTimeout(r, 250)); }
      po.disconnect();
      return { n: tasks.length, max: tasks.length ? Math.max(...tasks) : 0, all: tasks };
    `);
    console.log(`          侧板开合 4 次：${lt.n} 个长任务${lt.n ? '，最长 ' + lt.max + 'ms（' + lt.all.join('/') + '）' : ''}`);

    // 列表滚动：1800 行的虚拟滚动，滚一整屏看看掉不掉帧
    const scrollMs = await s.ev(`
      document.querySelector('#tabs button[data-view="list"]').click();
      await new Promise(r => setTimeout(r, 1200));
      const sc = document.querySelector('#table-scroll');
      if (!sc || sc.scrollHeight <= sc.clientHeight + 2) return -2;
      const deltas = [];
      let last = performance.now();
      let run = true;
      const loop = () => {
        const n = performance.now();
        deltas.push(n - last); last = n;
        if (run) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      for (let y = 0; y < 3600; y += 60) {
        sc.scrollTop = y;
        await new Promise(r => requestAnimationFrame(r));
      }
      run = false;
      await new Promise(r => setTimeout(r, 80));
      deltas.sort((a, b) => a - b);
      return {
        med: Math.round(deltas[Math.floor(deltas.length / 2)] * 10) / 10,
        p90: Math.round(deltas[Math.floor(deltas.length * 0.9)] * 10) / 10,
        frames: deltas.length,
      };
    `);
    if (scrollMs && scrollMs.med > 0) rec('列表滚动 1800 行（帧间隔）', scrollMs.med, `ms/帧 · p90 ${scrollMs.p90}ms · ${scrollMs.frames} 帧`);
    else console.log('\n  （列表内容不足一屏，跳过滚动测试）');

    // 滚动长墙（如果开的是「全部品种」才有效）
    ms = await s.ev(`
      const g = document.querySelector('#grid');
      if (!g || g.scrollHeight <= g.clientHeight + 2) return -2;
      const t0 = performance.now();
      let frames = 0;
      for (let y = 0; y < 2000; y += 40) {
        g.scrollTop = y;
        await new Promise(r => requestAnimationFrame(r));
        frames++;
      }
      return Math.round((performance.now() - t0) / frames * 100) / 100;
    `);
    if (ms >= 0) rec('长墙滚动（每帧平均）', ms, 'ms/帧');
    else if (ms === -2) console.log('\n  （当前布局不足一屏，跳过滚动测试）');

    if (KEEP) {
      console.log('\n  --keep：浏览器留在现场，Ctrl+C 结束。');
      await new Promise(() => {});
    }
  } finally {
    if (!KEEP) {
      proc.kill();
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n[perf] ' + e.message + '\n');
  process.exit(1);
});
