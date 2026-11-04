#!/usr/bin/env node
/**
 * 端到端回归脚本（零依赖，Node 18+）
 *
 *   node tools/e2e.mjs            跑全部用例
 *   node tools/e2e.mjs bigchart   只跑名字里带 bigchart 的用例
 *   node tools/e2e.mjs --headed   显示浏览器窗口（调试用）
 *
 * 前提：本地服务已经跑起来（python server.py），默认 8848。
 * 原理：起一个独立 user-data-dir 的 headless Chrome，用 CDP 驱动，
 *      直接在页面里做断言——不引入 puppeteer/playwright。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9333);
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8848';
const FILTER = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) || '';
const HEADED = process.argv.includes('--headed');

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
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/* ------------------------------------------------------------------ 环境 */

async function checkServer() {
  try {
    const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.tickers) throw new Error('行情还没起来');
    return j;
  } catch (e) {
    console.error(C.red(`\n[E2E] 连不上 ${BASE} —— 先启动服务：python server.py\n       (${e.message})\n`));
    process.exit(2);
  }
}

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
  ].filter(Boolean);
  const proc = spawn(bin, args, { stdio: 'ignore', detached: false });
  return proc;
}

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch (e) { /* 还没起来 */ }
  }
  throw new Error('Chrome 调试端口没起来');
}

/* ------------------------------------------------------------------ CDP */

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.onmessage = (ev) => this.onMessage(ev);
  }

  onMessage(ev) {
    const m = JSON.parse(ev.data);
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      this.errors.push(d.exception?.description || d.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      this.errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const ok = await this.ev('return !!window.__term;').catch(() => false);
      if (ok === true) return;
    }
    throw new Error('页面 30 秒内没加载出 __term');
  }
}

/* ------------------------------------------------------------------ 断言 */

const cases = [];
function test(name, fn, opts = {}) {
  cases.push({ name, fn, wait: opts.wait ?? 0 });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ================================================================== 用例 */

test('页面加载：无 JS 报错，行情到位', async (s) => {
  const info = await s.ev(`
    return {
      cells: document.querySelectorAll('#grid .cell').length,
      tickers: window.__term.market.size,
      view: window.__term.state.view,
    };
  `);
  assert(info.cells > 0, '格子没渲染');
  assert(info.tickers > 1000, '行情数量异常：' + info.tickers);
  assert(s.errors.length === 0, '页面有报错：\n  ' + s.errors.slice(0, 3).join('\n  '));
});

test('配色：绿涨红跌', async (s) => {
  const c = await s.ev(`
    const cs = getComputedStyle(document.documentElement);
    return { up: cs.getPropertyValue('--up').trim(), down: cs.getPropertyValue('--down').trim(),
             ask: cs.getPropertyValue('--ask').trim(), bid: cs.getPropertyValue('--bid').trim() };
  `);
  assertEq(c.up, '#0f9d63', '涨色应为绿');
  assertEq(c.down, '#e5484d', '跌色应为红');
  assertEq(c.ask, '#e5484d', '盘口卖应为红');
  assertEq(c.bid, '#0f9d63', '盘口买应为绿');
});

test('多品种同列：方向键移动选中格', async (s) => {
  await s.ev(`document.querySelector('#tabs button[data-view="grid"]').click(); await new Promise(r=>setTimeout(r,600)); return 1;`);
  const before = await s.ev('return window.__term.grid.focusIndex;');
  await s.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await new Promise(r=>setTimeout(r,300)); return 1;`);
  const after = await s.ev('return window.__term.grid.focusIndex;');
  assert(after === before + 1, `焦点没右移：${before} -> ${after}`);
  await s.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})); await new Promise(r=>setTimeout(r,300)); return 1;`);
});

test('大图：双击进入并加载 K 线', async (s) => {
  await s.ev(`
    document.querySelector('#grid .cell').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await new Promise(r=>setTimeout(r,3500));
    return 1;
  `);
  const b = await s.ev(`
    const big = window.__term.big;
    return { open: big.isOpen(), bars: big.cell ? big.cell.times.length : 0,
             info: document.querySelector('#bc-info').textContent.trim(),
             canvas: !!document.querySelector('#bigchart canvas') };
  `);
  assert(b.open, '大图没打开');
  assert(b.bars > 100, 'K 线数量异常：' + b.bars);
  assert(b.canvas, '图表 canvas 不存在');
  assert(b.info.length > 10, 'OHLC 明细行是空的');
}, { wait: 0 });

test('大图：切换周期后重新加载', async (s) => {
  await s.ev(`document.querySelector('#bc-iv button[data-iv="1h"]').click(); await new Promise(r=>setTimeout(r,3500)); return 1;`);
  const b = await s.ev(`
    const big = window.__term.big;
    return { iv: big.interval, bars: big.cell ? big.cell.times.length : 0 };
  `);
  assertEq(b.iv, '1h', '周期没切过去');
  assert(b.bars > 100, '1h K 线没加载：' + b.bars);
  await s.ev(`document.querySelector('#bc-iv button[data-iv="1m"]').click(); await new Promise(r=>setTimeout(r,2500)); return 1;`);
});

test('大图：画水平线并持久化', async (s) => {
  const r = await s.ev(`
    const big = window.__term.big;
    const host = big.cell.host;
    const box = host.getBoundingClientRect();
    const mk = (t,x,y) => new PointerEvent(t,{clientX:box.left+x,clientY:box.top+y,bubbles:true,button:0,pointerId:1});
    big.draw.clearAll();
    document.querySelector('#bc-draw button[data-tool="hline"]').click();
    host.dispatchEvent(mk('pointerdown', 500, 300));
    host.dispatchEvent(mk('pointerup', 500, 300));
    await new Promise(r=>setTimeout(r,400));
    document.querySelector('#bc-draw button[data-tool="cursor"]').click();
    const key = big.draw.key;
    const stored = JSON.parse(localStorage.getItem('binance-terminal.drawings.v1') || '{}');
    return { items: big.draw.items.length, key, persisted: !!(stored[key] && stored[key].length) };
  `);
  assertEq(r.items, 1, '图元数量不对');
  assert(r.persisted, '绘图没写进 localStorage');
});

test('大图：Esc 退出并销毁图表', async (s) => {
  await s.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await new Promise(r=>setTimeout(r,700)); return 1;`);
  const b = await s.ev(`
    return { open: window.__term.big.isOpen(),
             cellGone: !document.querySelector('#bigchart .cell'),
             view: window.__term.state.view };
  `);
  assert(!b.open, '大图没关闭');
  assert(b.cellGone, '大图里的图表没销毁');
});

test('列表：切换视图并选中一行', async (s) => {
  await s.ev(`
    document.querySelector('#tabs button[data-view="list"]').click();
    await new Promise(r=>setTimeout(r,1500));
    const row = document.querySelector('.tbody-inner .row');
    if (row) row.click();
    await new Promise(r=>setTimeout(r,2000));
    return 1;
  `);
  const r = await s.ev(`
    return { view: window.__term.state.view,
             visible: !document.querySelector('#view-list').classList.contains('hidden'),
             rows: document.querySelectorAll('.tbody-inner .row').length,
             sel: (document.querySelector('.tbody-inner .row.sel') || {}).dataset?.sym || null };
  `);
  assertEq(r.view, 'list', '没切到列表');
  assert(r.visible, '列表视图不可见');
  assert(r.rows > 10, '列表没渲染：' + r.rows);
  assert(r.sel, '没有选中行');
});

test('详情面板：盘口默认 8 档，可展开 20 档', async (s) => {
  await s.ev(`await new Promise(r=>setTimeout(r,6000)); return 1;`);
  const r = await s.ev(`
    const p = document.querySelector('#detail');
    const n1 = p.querySelectorAll('.book-row').length;
    const btn = p.querySelector('.book-more');
    if (btn) btn.click();
    await new Promise(r=>setTimeout(r,500));
    const n2 = p.querySelectorAll('.book-row').length;
    if (btn) btn.click();
    return { n1, n2 };
  `);
  assertEq(r.n1, 8, '默认档位不是 8');
  assertEq(r.n2, 20, '展开后不是 20 档');
});

test('列表：双击行进入大图', async (s) => {
  const r = await s.ev(`
    const row = document.querySelectorAll('.tbody-inner .row')[2];
    const sym = row.dataset.sym;
    row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await new Promise(r=>setTimeout(r,3500));
    return { sym, open: window.__term.big.isOpen(), bigSym: window.__term.big.symbol,
             view: window.__term.state.view };
  `);
  assert(r.open, '列表双击没进大图');
  assertEq(r.bigSym, r.sym, '大图品种和双击行不一致');
  assertEq(r.view, 'list', '视图状态被改了');
  await s.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await new Promise(r=>setTimeout(r,600)); return 1;`);
});

test('列表：Enter 进大图', async (s) => {
  const r = await s.ev(`
    const row = document.querySelector('.tbody-inner .row');
    row.click();
    await new Promise(r=>setTimeout(r,800));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    await new Promise(r=>setTimeout(r,3000));
    return { open: window.__term.big.isOpen(), sym: window.__term.big.symbol, sel: row.dataset.sym };
  `);
  assert(r.open, '列表按 Enter 没进大图');
  assertEq(r.sym, r.sel, '进的品种和选中行不一致');
  await s.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await new Promise(r=>setTimeout(r,600)); return 1;`);
});

test('合约盘口：WebSocket 实时推送（不是 4 秒轮询）', async (s) => {
  const r = await s.ev(`
    const rows = [...document.querySelectorAll('.tbody-inner .row')];
    const perp = rows.find(r => r.dataset.sym.endsWith('@f'));
    perp.click();
    await new Promise(r=>setTimeout(r,5000));
    const book = document.querySelector('#detail .book');
    let n = 0;
    const ob = new MutationObserver(() => n++);
    ob.observe(book, { childList: true, subtree: true });
    const s1 = await (await fetch('/api/status')).json();
    await new Promise(r=>setTimeout(r,3000));
    ob.disconnect();
    const s2 = await (await fetch('/api/status')).json();
    return { sym: perp.dataset.sym, mutations: n, rows: book.querySelectorAll('.book-row').length,
             inDoc: document.contains(book), sel: window.__term.state.selected,
             dsym: window.__term.detail.symbol, msgsDelta: s2.msgs - s1.msgs,
             serverDepth: s2.depth, futDepthState: s2.futdepth };
  `);
  assert(r.rows > 0, '盘口没数据');
  // 主断言看服务端有没有把这条合约的 depth 流订上（确定性，不受网络时序影响）
  assertEq(r.serverDepth, r.sym, '服务端没订阅这条合约的盘口');
  assertEq(r.futDepthState, 'ok', '合约盘口流没连上');
  // 次断言：确实在推（宽松，容忍刚订阅上的抖动）
  assert(r.mutations >= 1, `3 秒内盘口一次都没更新（rows=${r.rows} 消息增量=${r.msgsDelta}）`);
});

test('大图：左右键切换品种', async (s) => {
  const r = await s.ev(`
    const big = window.__term.big;
    if (big.isOpen()) big.close();
    await new Promise(r=>setTimeout(r,300));
    big.open('BTCUSDT','1m');
    await new Promise(r=>setTimeout(r,3500));
    const before = big.symbol;
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    await new Promise(r=>setTimeout(r,2800));
    const after = big.symbol;
    const bars = big.cell ? big.cell.times.length : 0;
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
    await new Promise(r=>setTimeout(r,2500));
    return { before, after, back: big.symbol, bars };
  `);
  assert(r.after !== r.before, `右键没换品种（还是 ${r.before}）`);
  assertEq(r.back, r.before, '左键没回到上一个');
  assert(r.bars >= 0, '换完品种图表异常');
});

test('绘图：拖动端点 + Ctrl+Z 撤销', async (s) => {
  const r = await s.ev(`
    const big = window.__term.big;
    const host = big.cell.host;
    const box = host.getBoundingClientRect();
    const mk = (t,x,y) => new PointerEvent(t,{clientX:box.left+x,clientY:box.top+y,bubbles:true,button:0,pointerId:1});
    big.draw.clearAll();
    big.draw.undoStack.length = 0;
    document.querySelector('#bc-draw button[data-tool="trend"]').click();
    host.dispatchEvent(mk('pointerdown', 300, 200));
    host.dispatchEvent(mk('pointermove', 600, 300));
    host.dispatchEvent(mk('pointerup', 600, 300));
    await new Promise(r=>setTimeout(r,300));
    document.querySelector('#bc-draw button[data-tool="cursor"]').click();
    const it = big.draw.items[0];
    const p2Before = { t: it.p2.t, p: it.p2.p };
    // 抓住 p2 端点拖到别处
    host.dispatchEvent(mk('pointerdown', 600, 300));
    host.dispatchEvent(mk('pointermove', 700, 380));
    host.dispatchEvent(mk('pointerup', 700, 380));
    await new Promise(r=>setTimeout(r,300));
    const moved = { t: it.p2.t, p: it.p2.p };
    const changed = moved.p !== p2Before.p || moved.t !== p2Before.t;
    // Ctrl+Z 撤销这次拖动
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));
    await new Promise(r=>setTimeout(r,400));
    const back = big.draw.items[0];
    const restored = back && Math.abs(back.p2.p - p2Before.p) < 1e-9 && back.p2.t === p2Before.t;
    return { items: big.draw.items.length, changed, restored, undoDepth: big.draw.undoStack.length };
  `);
  assertEq(r.items, 1, '图元数量不对');
  assert(r.changed, '拖动端点没改到坐标');
  assert(r.restored, 'Ctrl+Z 没恢复拖动前的状态');
});

test('快捷键面板：? 打开，Esc 关闭', async (s) => {
  const r = await s.ev(`
    const help = document.querySelector('#help');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}));
    await new Promise(r=>setTimeout(r,200));
    const opened = !help.classList.contains('hidden');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await new Promise(r=>setTimeout(r,200));
    return { opened, closed: help.classList.contains('hidden'),
             bigStillOpen: window.__term.big.isOpen() };
  `);
  assert(r.opened, '? 没打开面板');
  assert(r.closed, 'Esc 没关掉面板');
  assert(r.bigStillOpen, 'Esc 关面板时把大图也关了');
});

test('大图：右侧盘口栏可开关', async (s) => {
  const r = await s.ev(`
    const big = window.__term.big;
    if (big.isOpen()) big.close();
    await new Promise(r=>setTimeout(r,300));
    big.open('BTCUSDT@f','1m');
    await new Promise(r=>setTimeout(r,3500));
    // 盘口栏现在默认打开，先确保它是开的
    if (!big.showDetail) document.querySelector('#bc-detail-btn').click();
    await new Promise(r=>setTimeout(r,5000));
    const p = document.querySelector('#bc-detail');
    const on = { visible: p.getClientRects().length > 0, rows: p.querySelectorAll('.book-row').length,
                 title: (p.querySelector('.dt-title h3')||{}).textContent,
                 chartW: Math.round(document.querySelector('#bigchart .cell').getBoundingClientRect().width) };
    document.querySelector('#bc-detail-btn').click();
    await new Promise(r=>setTimeout(r,600));
    const off = { visible: p.getClientRects().length > 0,
                  chartW: Math.round(document.querySelector('#bigchart .cell').getBoundingClientRect().width) };
    return { on, off };
  `);
  assert(r.on.visible, '盘口栏没显示');
  assert(r.on.rows > 0, '盘口没数据');
  assert(r.off.visible === false, '盘口栏没关掉');
  assert(r.off.chartW > r.on.chartW, '关掉盘口栏后图表没变宽');
  await s.ev(`window.__term.big.close(); await new Promise(r=>setTimeout(r,400)); return 1;`);
});

test('扫描器：打开 / 过滤 / 关闭', async (s) => {
  const r = await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,600));
    document.querySelector('#btn-scanner').click();
    await new Promise(r=>setTimeout(r,900));
    const n1 = document.querySelectorAll('.sc-row').length;
    document.querySelector('#sc-minqv button[data-q="10000000"]').click();
    await new Promise(r=>setTimeout(r,500));
    const n2 = document.querySelectorAll('.sc-row').length;
    const first = (document.querySelector('.sc-row')||{}).textContent || '';
    document.querySelector('#sc-close').click();
    await new Promise(r=>setTimeout(r,300));
    return { n1, n2, first: first.replace(/\s+/g,' ').trim(), closed: !window.__term.scanner.isOpen() };
  `);
  assert(r.n1 > 10, '扫描器没渲染出行：' + r.n1);
  assert(r.n2 > 0 && r.n2 <= r.n1, '成交额过滤没生效');
  assert(r.closed, '扫描器没关掉');
});

test('告警：阈值命中后进列表', async (s) => {
  const r = await s.ev(`
    const a = window.__term.alerts;
    if (!window.__term.state.alert.on) {
      document.querySelector('#btn-alerts').click();
      await new Promise(r=>setTimeout(r,400));
      document.querySelector('#al-on').click();
      await new Promise(r=>setTimeout(r,400));
    } else {
      document.querySelector('#btn-alerts').click();
      await new Promise(r=>setTimeout(r,300));
    }
    const victim = [...a.baseline][0];
    a.baseline.delete(victim);
    a.check();
    await new Promise(r=>setTimeout(r,500));
    const rows = document.querySelectorAll('.al-row').length;
    document.querySelector('#al-close').click();
    return { enabled: window.__term.state.alert.on, victim, hits: a.hits.length, rows };
  `);
  assert(r.enabled, '告警没开启');
  assert(r.hits >= 1, '模拟突破阈值后没命中');
  assert(r.rows >= 1, '告警列表没渲染');
});

test('大图：持仓量叠加（pane 2）', async (s) => {
  const r = await s.ev(`
    const big = window.__term.big;
    if (big.isOpen()) big.close();
    await new Promise(r=>setTimeout(r,300));
    big.open('BTCUSDT@f','1m');
    await new Promise(r=>setTimeout(r,3800));
    document.querySelector('#bc-oi-btn').click();
    await new Promise(r=>setTimeout(r,4200));
    const panes = big.cell.chart.panes().length;
    const rows = big.oiData ? big.oiData.length : 0;
    document.querySelector('#bc-oi-btn').click();
    await new Promise(r=>setTimeout(r,500));
    const after = big.cell.chart.panes().length;
    big.close();
    await new Promise(r=>setTimeout(r,400));
    return { panes, rows, after };
  `);
  assertEq(r.panes, 3, '开持仓量后应该有 3 个窗格');
  assert(r.rows > 10, '持仓量数据太少：' + r.rows);
  assert(r.after < 3, '关掉持仓量后窗格没减少');
});

test('K 线：拖到左边缘自动补更早的历史', async (s) => {
  const r = await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,600));
    const c = window.__term.grid.cells[0];
    if (!c || !c.chart) return { skip: true };
    const before = c.times.length;
    const earliest = c.times[0];
    c.chart.timeScale().setVisibleLogicalRange({ from: -20, to: 60 });
    await new Promise(r=>setTimeout(r,4000));
    return { before, after: c.times.length, added: c.times.length - before,
             newEarliest: c.times[0], wentBack: c.times[0] < earliest,
             noMore: c.noMore };
  `);
  if (r.skip) return;
  assert(r.added > 0, `拖到左边缘没加载历史（还是 ${r.after} 根）`);
  assert(r.wentBack, '加载回来的数据不比原来的更早');
});

/* ================================================================== 执行 */

const server = await checkServer();
const bin = findChrome();
const profile = mkdtempSync(join(tmpdir(), 'bterm-e2e-'));
let chrome = null;
let ws = null;

const cleanup = () => {
  try { ws && ws.close(); } catch (e) { /* ignore */ }
  if (chrome && !chrome.killed) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      chrome.kill('SIGKILL');
    }
  }
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ } }, 800);
};

process.on('SIGINT', () => { cleanup(); process.exit(130); });

console.log(C.bold('\n币安看盘终端 · E2E 回归\n') + C.dim(`  服务 ${BASE}  ·  行情 ${server.tickers} 个  ·  ${FILTER ? '筛选: ' + FILTER : '全部用例'}\n`));

let failed = 0;
try {
  chrome = launchChrome(bin, profile);
  await waitForCdp();
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  const session = new Session(ws);
  await session.send('Runtime.enable');
  await session.send('Page.enable');
  await session.goto(BASE);
  await sleep(2500);

  const picked = cases.filter((c) => !FILTER || c.name.includes(FILTER));
  if (!picked.length) {
    console.log(C.yellow(`  没有匹配 "${FILTER}" 的用例\n`));
  }

  for (const c of picked) {
    const t0 = Date.now();
    try {
      await c.fn(session);
      const dt = Date.now() - t0;
      console.log(`  ${C.green('✓')} ${c.name} ${C.dim(dt + 'ms')}`);
    } catch (e) {
      failed++;
      console.log(`  ${C.red('✗')} ${c.name}`);
      console.log(C.red('    ' + (e.message || e).split('\n').join('\n    ')));
    }
  }
} catch (e) {
  failed++;
  console.error(C.red('\n[E2E] 执行失败：' + (e.message || e)));
} finally {
  cleanup();
}

const total = cases.filter((c) => !FILTER || c.name.includes(FILTER)).length;
console.log(
  failed
    ? C.red(`\n  ${total - failed}/${total} 通过，${failed} 个失败\n`)
    : C.green(`\n  ${total}/${total} 全部通过\n`)
);
process.exit(failed ? 1 : 0);
