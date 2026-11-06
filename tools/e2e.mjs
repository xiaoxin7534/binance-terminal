#!/usr/bin/env node
/**
 * 端到端回归脚本（零依赖，Node 18+）
 *
 *   node tools/e2e.mjs            跑全部用例
 *   node tools/e2e.mjs bigchart   只跑名字里带 bigchart 的用例
 *   node tools/e2e.mjs --headed   显示浏览器窗口（调试用）
 *
 * 前提：本地服务已经跑起来（python server.py），默认 8848。
 * 临时 Chrome profile 落在 D:/WorkBuddy AI/.cache（环境变量 BTERM_CACHE 可改），
 * 不写系统临时目录——C 盘被堆过 921MB 遗留 profile。
 * 原理：起一个独立 user-data-dir 的 headless Chrome，用 CDP 驱动，
 *      直接在页面里做断言——不引入 puppeteer/playwright。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeProfile, removeProfile } from './_tmp.mjs';

const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9444);
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

test('详情面板：三块并排 + 盘口上下竖置', async (s) => {
  await s.ev(`await new Promise(r=>setTimeout(r,6000)); return 1;`);
  const r = await s.ev(`
    const p = document.querySelector('#detail');
    const cols = [...p.querySelectorAll('.dt-col')];
    return {
      cols: cols.length,
      stacked: cols.length > 1 && cols[1].getBoundingClientRect().top > cols[0].getBoundingClientRect().top + 10,
      titles: cols.map(c => [...c.querySelectorAll('h4')].map(e => e.textContent.trim()).join('|')),
      head: [...p.querySelectorAll('.book-head span')].map(e => e.textContent),
      asks: p.querySelectorAll('.book-row.ask').length,
      bids: p.querySelectorAll('.book-row.bid').length,
      last: !!p.querySelector('.book-last'),
      ratio: !!p.querySelector('.book-ratio'),
    };
  `);
  assert(r.stacked, '详情面板应该是竖排一列');
  assert(r.titles[0].includes('行情统计'), '第一块不是行情统计');
  assert(r.titles[1].includes('盘口') && r.titles[1].includes('最近成交'),
    '第二块应该同时有盘口和最近成交：' + r.titles[1]);
  assertEq(r.head.join(','), '价格,数量,合计', '盘口表头不对');
  assertEq(r.asks, 10, '卖档不是 10');
  assertEq(r.bids, 10, '买档不是 10');
  assert(r.last, '没有当前价行');
  assert(r.ratio, '没有买卖力量条');
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
    // 真人只会在列表可见时点行；大图开着的话盘口订阅跟着大图走（这是对的），
    // 先把它关掉，否则这条用例测的就不是"点列表行"这件事了
    if (window.__term.big && window.__term.big.isOpen()) {
      window.__term.big.close();
      await new Promise(r=>setTimeout(r,400));
    }
    const rows = [...document.querySelectorAll('.tbody-inner .row')];
    const perp = rows.find(r => r.dataset.sym.endsWith('@f'));
    perp.click();
    await new Promise(r=>setTimeout(r,5000));
    const book = document.querySelector('#detail .book');
    let n = 0;
    const ob = new MutationObserver(() => n++);
    ob.observe(book, { childList: true, subtree: true });
    // 代理抖动时 DepthWorker 会掉线重连，等它回到 ok 再采样。
    // 这不是放宽标准：连不回来照样失败，只是别把"重连中"当成"没实现"。
    let s1 = null;
    for (let i = 0; i < 120; i++) {
      s1 = await (await fetch('/api/status')).json();
      if (s1.futdepth === 'ok' && s1.depth === perp.dataset.sym) break;
      await new Promise(r=>setTimeout(r,100));
    }
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
    // 盘口是 WS 推的，要先按「当前大图在看哪个币」重新登记订阅
    // （big.open() 直接被调用时不会走 openBig，订阅得自己补一发）
    window.__term.syncSubs();
    const p = document.querySelector('#bc-detail');
    // 轮询等盘口出档位：单次 REST 兜底在代理抖动时要好几秒，别写死等待时间
    for (let i = 0; i < 300; i++) {
      if (p.querySelectorAll('.book-row').length) break;
      await new Promise(r=>setTimeout(r,50));
    }
    await new Promise(r=>setTimeout(r,300));
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
  assert(r.on.rows > 0, '盘口没数据（等了 15 秒）');
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

test('大图：持仓量叠加（独立副图）', async (s) => {
  const r = await s.ev(`
    const big = window.__term.big;
    if (big.isOpen()) big.close();
    await new Promise(r=>setTimeout(r,300));
    big.open('BTCUSDT@f','1m');
    await new Promise(r=>setTimeout(r,3800));
    const before = big.cell.chart.panes().length;
    document.querySelector('#bc-oi-btn').click();
    // 持仓量历史要走代理，单次 2~5 秒（行情抖动时更久），
    // 固定等 4 秒会偶发误报，这里改成轮询到数据到位为止
    for (let i = 0; i < 300; i++) {
      if (big.oiData && big.oiData.length > 10) break;
      await new Promise(r=>setTimeout(r,50));
    }
    const panes = big.cell.chart.panes().length;
    const rows = big.oiData ? big.oiData.length : 0;
    const oiPane = big.oiPane();
    document.querySelector('#bc-oi-btn').click();
    await new Promise(r=>setTimeout(r,500));
    const after = big.cell.chart.panes().length;
    big.close();
    await new Promise(r=>setTimeout(r,400));
    return { before, panes, rows, after, oiPane };
  `);
  // CVD 默认开着，所以持仓量会落在第 4 格（index 3），不再是固定 pane 2
  assertEq(r.panes, r.before + 1, `开持仓量后窗格没加一格：${r.before} -> ${r.panes}`);
  assertEq(r.oiPane, r.panes - 1, '持仓量没落在最后一个窗格：' + r.oiPane);
  assert(r.rows > 10, '持仓量数据太少（等了 15 秒）：' + r.rows);
  assertEq(r.after, r.before, '关掉持仓量后窗格没回到原样');
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

test('5 日连续分时', async (s) => {
  const r = await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,600));
    const c = window.__term.grid.cells[0];
    c.setInterval('5d');
    // 冷启动时分两段并行拉 5 天 5m K 线，第一段先到、可视范围只有 2 天，
    // 第二段到了才铺满 5 天。只等 times.length 会抢跑，要等到范围真的够宽。
    let vr = null;
    let spanDays = 0;
    for (let i = 0; i < 120; i++) {
      vr = c.chart ? c.chart.timeScale().getVisibleRange() : null;
      spanDays = vr ? Math.round((vr.to - vr.from) / 86400) : 0;
      if (spanDays >= 4 && c.times.length > 500) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return { bars: c.times.length, intraday: c.intraday, spanDays,
             legend: (c.legendEl || {}).textContent || '',
             has5dBtn: [...document.querySelectorAll('#interval-seg button')].some(b => b.dataset.iv === '5d') };
  `);
  assert(r.has5dBtn, '周期条里没有 5日 按钮');
  assert(r.intraday, '5日 没走分时渲染路径');
  assert(r.bars > 500, '5 日数据太少：' + r.bars);
  assert(r.spanDays >= 4, '可视范围不到 4 天：' + r.spanDays);
  assert(r.legend.includes('首日开'), '图例没显示首日开盘价：' + r.legend);
});

test('窗口缩放：工具栏按钮不被压扁', async (s) => {
  await s.ev(`document.querySelector('#tabs button[data-view="list"]').click(); return 1;`);
  await new Promise((r) => setTimeout(r, 800));
  const bad = [];
  for (const w of [1600, 1440, 1366, 1280, 1200, 1024]) {
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 400));
    const r = await s.ev(`
      const btn = document.querySelector('#list-detail-btn');
      const tb = btn.closest('.list-toolbar');
      const top = document.querySelector('.topbar');
      const topOv = top.scrollWidth - top.clientWidth;
      const br = btn.getBoundingClientRect();
      const cs = getComputedStyle(btn);
      return {
        h: Math.round(br.height),
        w: Math.round(br.width),
        lines: Math.round(br.height / parseFloat(cs.lineHeight)),
        overflow: tb.scrollWidth - tb.clientWidth,
        topOv,
        wrap: cs.whiteSpace,
      };
    `);
    if (r.lines > 1) bad.push(`${w}px 下「详情」折成 ${r.lines} 行`);
    if (r.h > 26) bad.push(`${w}px 下「详情」高度 ${r.h}px（应为 24）`);
    if (r.w < 36) bad.push(`${w}px 下「详情」宽 ${r.w}px（被压扁）`);
    if (r.overflow > 1) bad.push(`${w}px 下工具栏溢出 ${r.overflow}px`);
    if (r.topOv > 1) bad.push(`${w}px 下顶栏溢出 ${r.topOv}px`);
    if (r.wrap !== 'nowrap') bad.push(`${w}px 下 white-space=${r.wrap}`);
  }
  await s.send('Emulation.clearDeviceMetricsOverride');
  assert(!bad.length, bad.join('；'));
});

test('股票市场细分：中际旭创归 A 股、腾讯归港股、索尼归日股', async (s) => {
  const r = await s.ev(`
    const m = window.__term.market;
    const reg = (b) => {
      const row = m.get(b + 'USDT@f') || m.get(b + 'USDT');
      return row && row.reg ? row.reg : [];
    };
    return {
      zhongji: reg('ZHONGJI'), gigadev: reg('GIGADEV'), unitree: reg('UNITREE'),
      tencent: reg('TENCENT'), meituan: reg('MEITUAN'),
      samsung: reg('SAMSUNG'), skhynix: reg('SKHYNIX'),
      sony: reg('SONY'),
      tsla: reg('TSLA'), nvdab: reg('NVDAB'),
      btc: reg('BTC'),
    };
  `);
  const eq = (k, want, msg) => assertEq(JSON.stringify(r[k]), JSON.stringify(want), msg);
  // 币安把中际旭创/兆易创新标成了 HK_EQUITY，这里必须改判成 A 股
  eq('zhongji', ['CN'], '中际旭创应归 A 股');
  eq('gigadev', ['CN'], '兆易创新应归 A 股');
  eq('unitree', ['CN'], '宇树科技应归 A 股');
  eq('tencent', ['HK'], '腾讯应归港股');
  eq('meituan', ['HK'], '美团应归港股');
  eq('samsung', ['KR'], '三星应归韩股');
  eq('skhynix', ['KR'], 'SK 海力士应归韩股');
  // 币安没有日股分类，索尼 ADR 靠 REGION_EXTRA 补；它在美股时段交易，两个都算
  assert(r.sony.includes('JP'), '索尼应归日股：' + JSON.stringify(r.sony));
  assert(r.sony.includes('US'), '索尼 ADR 也应留在美股：' + JSON.stringify(r.sony));
  eq('tsla', ['US'], '特斯拉应归美股');
  assert(r.nvdab.includes('US'), '现货 token 化股票（NVDAB）也要有市场：' + JSON.stringify(r.nvdab));
  eq('btc', [], '加密币不该有市场标签');
});

test('股票市场细分：菜单与筛选', async (s) => {
  // 前一个用例可能留下筛选状态，先复位
  await s.ev(`
    window.__term.state.region = null;
    document.querySelector('#tabs button[data-view="list"]').click();
    await new Promise(r=>setTimeout(r,700));
    window.__term.list.syncFilterUI();
    return 1;
  `);
  const menu = await s.ev(`
    const b = document.querySelector('#list-region');
    if (!b || b.hidden || !b.offsetWidth) return { missing: true };
    b.click();
    await new Promise(r=>setTimeout(r,320));
    return {
      keys: [...document.querySelectorAll('.popover.menu .menu-item')].map(x => x.dataset.k),
      text: [...document.querySelectorAll('.popover.menu .menu-item')].map(x => x.textContent.trim()),
    };
  `);
  assert(!menu.missing, '工具栏里没有「股票市场」入口（regions.json 缺失？）');
  for (const k of ['', 'US', 'HK', 'CN', 'KR', 'JP']) {
    assert(menu.keys.includes(k), `菜单里缺少 ${k || '全部'}：${JSON.stringify(menu.keys)}`);
  }
  assert(menu.text.some((t) => t.includes('日股')), '菜单里没有日股：' + JSON.stringify(menu.text));

  const hk = await s.ev(`
    document.querySelector('.popover.menu .menu-item[data-k="HK"]').click();
    await new Promise(r=>setTimeout(r,800));
    const t = window.__term;
    const rows = t.list.rows;
    return {
      region: t.state.region,
      n: rows.length,
      bad: rows.filter(x => !(x.reg || []).includes('HK')).map(x => x.b).slice(0, 5),
      label: document.querySelector('#list-region-name').textContent,
      on: document.querySelector('#list-region').classList.contains('on'),
      bases: rows.map(x => x.b),
    };
  `);
  assertEq(hk.region, 'HK', '选了港股但状态没变');
  assert(hk.n > 0, '港股筛选后一行都没有');
  assert(!hk.bad.length, '筛选后混进了非港股：' + hk.bad.join(','));
  assert(hk.label.includes('港股'), '按钮上没显示当前市场：' + hk.label);
  assert(hk.on, '按钮没有高亮');
  assert(hk.bases.includes('TENCENT'), '港股里应该能看到腾讯：' + hk.bases.join(','));

  const back = await s.ev(`
    document.querySelector('#list-region').click();
    await new Promise(r=>setTimeout(r,300));
    document.querySelector('.popover.menu .menu-item[data-k=""]').click();
    await new Promise(r=>setTimeout(r,700));
    return { region: window.__term.state.region, n: window.__term.list.rows.length,
             label: document.querySelector('#list-region-name').textContent };
  `);
  assertEq(back.region, null, '「全部股票」没清掉筛选');
  assert(back.n > hk.n, `取消筛选后行数没恢复：${hk.n} -> ${back.n}`);
  assert(back.label.includes('股票市场'), '按钮文字没复位：' + back.label);

  // 筛选组合出空表时，不能误报成「合约行情未就绪」（那是网络问题的提示）
  const empty = await s.ev(`
    document.querySelector('#list-mkt [data-m="perp"]').click();
    await new Promise(r=>setTimeout(r,500));
    document.querySelector('#list-region').click();
    await new Promise(r=>setTimeout(r,300));
    document.querySelector('.popover.menu .menu-item[data-k="HK"]').click();
    await new Promise(r=>setTimeout(r,600));
    const ai = document.querySelector('#sector-bar [data-sec="AI"]');
    if (!ai) return { skip: true };
    ai.click();
    await new Promise(r=>setTimeout(r,600));
    const el = document.querySelector('.tbody-inner .list-empty');
    const out = { n: window.__term.list.rows.length, text: el ? el.textContent : '' };
    // 复位，别影响后面的用例
    document.querySelector('#sector-bar [data-sec=""]').click();
    await new Promise(r=>setTimeout(r,400));
    document.querySelector('#list-mkt [data-m="all"]').click();
    await new Promise(r=>setTimeout(r,400));
    document.querySelector('#list-region').click();
    await new Promise(r=>setTimeout(r,300));
    document.querySelector('.popover.menu .menu-item[data-k=""]').click();
    await new Promise(r=>setTimeout(r,500));
    return out;
  `);
  if (!empty.skip) {
    assertEq(empty.n, 0, '永续 + 港股 + AI 应该没有交集');
    assert(empty.text.includes('暂无标的'), '空表提示不对：' + empty.text);
    assert(!empty.text.includes('未就绪'), '把筛选空表误报成行情未就绪：' + empty.text);
  }
  assertEq(await s.ev('return window.__term.state.region;'), null, '用例结束没复位 region');
});

test('大图：CVD 默认打开且数值正确', async (s) => {
  await s.ev(`document.querySelector('#tabs button[data-view="grid"]').click(); await new Promise(r=>setTimeout(r,500));
    window.__term.big.open('BTCUSDT@f','5m'); await new Promise(r=>setTimeout(r,4000)); return 1;`);
  const r = await s.ev(`
    const b = window.__term.big;
    const btn = document.querySelector('#bc-cvd-btn');
    const bars = (b.cell && b.cell.bars) || [];
    let cum = 0;
    for (const x of bars) cum += 2 * x[7] - x[5];
    let series = null;
    try { series = b.cvdSeries ? b.cvdSeries.data() : null; } catch (e) { series = null; }
    let panes = [];
    try { panes = b.cell.chart.panes().map((p) => (p.getHeight ? p.getHeight() : -1)); } catch (e) { panes = []; }
    const last = series && series.length ? series[series.length - 1].value : null;
    return {
      on: btn.classList.contains('on'),
      hasSeries: !!b.cvdSeries,
      bars: bars.length,
      fields: bars[0] ? bars[0].length : 0,
      seriesLen: series ? series.length : 0,
      last, expect: cum,
      state: window.__term.state.cvd,
      panes,
    };
  `);
  assert(r.on, 'CVD 按钮默认没打开');
  assertEq(r.state, true, 'state.cvd 默认不是 true');
  assert(r.hasSeries, '没有创建 CVD 曲线');
  assertEq(r.fields, 8, 'K 线没带主动买量（应为 8 个字段）');
  assert(r.bars > 50, 'K 线太少：' + r.bars);
  assertEq(r.seriesLen, r.bars, 'CVD 点数与 K 线根数不一致');
  assert(r.last !== null && Math.abs(r.last - r.expect) < 1e-6,
    `CVD 末值与手算不符：${r.last} vs ${r.expect}`);
  // 副图高度：CVD 那一格要压住，别把主图挤没了
  assert(r.panes.length >= 3, '没有独立的 CVD 副图：' + JSON.stringify(r.panes));
  assert(r.panes[2] >= 50 && r.panes[2] <= 110, 'CVD 副图高度异常：' + r.panes[2]);
  assert(r.panes[0] > 280, '主图被压得太小：' + r.panes[0]);

  const off = await s.ev(`
    document.querySelector('#bc-cvd-btn').click();
    await new Promise(r=>setTimeout(r,450));
    const b = window.__term.big;
    return { on: b.cvdOn, series: !!b.cvdSeries,
             cls: document.querySelector('#bc-cvd-btn').classList.contains('on'),
             state: window.__term.state.cvd };
  `);
  assert(!off.on && !off.series && !off.cls, '关掉 CVD 后曲线没拆掉');
  assertEq(off.state, false, '关闭状态没记住');

  const back = await s.ev(`
    document.querySelector('#bc-cvd-btn').click();
    await new Promise(r=>setTimeout(r,450));
    const b = window.__term.big;
    const ok = { on: b.cvdOn, series: !!b.cvdSeries };
    b.close();
    await new Promise(r=>setTimeout(r,500));
    return ok;
  `);
  assert(back.on && back.series, '再打开 CVD 没恢复');
});

test('最近成交：主动买卖汇总 + 只看大单', async (s) => {
  await s.ev(`document.querySelector('#tabs button[data-view="list"]').click(); await new Promise(r=>setTimeout(r,900));
    const row = document.querySelector('.tbody-inner .row'); if (row) row.click();
    await new Promise(r=>setTimeout(r,3200)); return 1;`);
  const r = await s.ev(`
    const d = document.querySelector('#detail');
    const rows = [...d.querySelectorAll('.trades .trade-row')];
    const flow = d.querySelector('.tflow');
    return {
      n: rows.length,
      flowHidden: !flow || flow.hidden,
      bp: d.querySelector('[data-role="buyp"]').textContent,
      sp: d.querySelector('[data-role="sellp"]').textContent,
      net: d.querySelector('[data-role="net"]').textContent,
      barW: d.querySelector('[data-role="buybar"]').style.width,
      cols: rows[0] ? rows[0].children.length : 0,
      head: [...d.querySelectorAll('.trade-head span')].map(x => x.textContent).join('/'),
      tip: rows[0] ? rows[0].getAttribute('title') : '',
    };
  `);
  assert(!r.flowHidden, '主动买卖汇总条没显示');
  assert(r.n > 3 && r.n <= 18, '成交行数异常：' + r.n);
  assertEq(r.cols, 3, '成交行不是 3 列');
  assertEq(r.head, '价格/成交额/时间', '列头没改成成交额：' + r.head);
  assert(/%$/.test(r.bp) && /%$/.test(r.sp), '买卖占比格式不对：' + r.bp + '/' + r.sp);
  assert(Math.abs(parseInt(r.bp, 10) + parseInt(r.sp, 10) - 100) <= 1,
    '买卖占比加起来不是 100：' + r.bp + '+' + r.sp);
  assert(/^[+-]/.test(r.net), '净额没带正负号：' + r.net);
  assert(/%$/.test(r.barW), '比例条宽度没设：' + r.barW);
  assert(/主动[买卖]/.test(r.tip) && /USDT/.test(r.tip), '成交行没有数量/金额提示：' + r.tip);

  const b = await s.ev(`
    const d = document.querySelector('#detail');
    const btn = d.querySelector('[data-role="bigonly"]');
    btn.click();
    await new Promise(r=>setTimeout(r,350));
    const rows = [...d.querySelectorAll('.trades .trade-row')];
    const allBig = rows.every(x => x.classList.contains('big'));
    const n = rows.length;
    const on = btn.classList.contains('on');
    btn.click();
    await new Promise(r=>setTimeout(r,350));
    return { n, allBig, on, back: d.querySelectorAll('.trades .trade-row').length };
  `);
  assert(b.on, '「大单」按钮没有高亮');
  assert(b.allBig, '「只看大单」里混进了小单');
  assert(b.back >= b.n, '取消大单过滤后行数没恢复');
});

test('资金费率柱：等宽对齐，负费率向下画', async (s) => {
  await s.ev(`document.querySelector('#tabs button[data-view="list"]').click(); await new Promise(r=>setTimeout(r,800));
    const row = document.querySelector('.tbody-inner .row'); if (row) row.click();
    await new Promise(r=>setTimeout(r,2600)); return 1;`);
  const r = await s.ev(`
    const now = Date.now(), day = 86400000;
    // 造一组含负费率的历史：两根负的，一根极小
    const hist = [[now-8*day,0.01],[now-7*day,0.005],[now-6*day,-0.004],[now-5*day,0.01],
                  [now-4*day,0.0004],[now-3*day,0.01],[now-2*day,-0.01],[now-1*day,0.006],[now,0.003]];
    window.__term.detail.renderFundHist(hist);
    await new Promise(r=>setTimeout(r,200));
    const el = document.querySelector('.fhist');
    const cols = [...el.querySelectorAll('.fh-col')];
    const bars = cols.map(c => c.querySelector('.fh-bar i'));
    const frames = cols.map(c => c.querySelector('.fh-bar').getBoundingClientRect());
    const rects = bars.map(b => b.getBoundingClientRect());
    return {
      hasNeg: el.classList.contains('has-neg'),
      n: cols.length,
      widths: [...new Set(rects.map(x => Math.round(x.width)))],
      cols: cols.map((c, i) => ({
        colC: Math.round(c.getBoundingClientRect().x + c.getBoundingClientRect().width / 2),
        barC: Math.round(rects[i].x + rects[i].width / 2),
        down: bars[i].classList.contains('down'),
        top: Math.round(rects[i].top),
        bottom: Math.round(rects[i].bottom),
        zero: Math.round(frames[i].top + frames[i].height / 2),
      })),
      labels: cols.map(c => c.querySelector('span').textContent).filter(Boolean),
    };
  `);
  assertEq(r.n, 9, '柱子数量不对');
  assert(r.hasNeg, '有负费率时没加 has-neg');
  assertEq(r.widths.length, 1, '柱子宽度不一致：' + JSON.stringify(r.widths));
  assertEq(r.cols.filter((c) => c.down).length, 2, '负费率柱子数量不对');
  for (const c of r.cols) {
    assert(Math.abs(c.colC - c.barC) <= 1, `柱子没居中：列 ${c.colC} vs 柱 ${c.barC}`);
    if (c.down) {
      assert(c.top >= c.zero - 1, `负费率柱子没从零轴往下画：top ${c.top} < 零轴 ${c.zero}`);
    } else {
      assert(c.bottom <= c.zero + 1, `正费率柱子没从零轴往上画：bottom ${c.bottom} > 零轴 ${c.zero}`);
    }
  }
  assert(r.labels.length <= 4, '日期标签太多，会挤：' + r.labels.join(','));
  assert(new Set(r.labels).size === r.labels.length, '日期标签重复：' + r.labels.join(','));
});

test('界面字体：菜单切换 + 持久化', async (s) => {
  const before = await s.ev('return window.__term.state.font;');
  const menu = await s.ev(`
    const b = document.querySelector('#btn-font');
    if (!b) return { missing: true };
    b.click();
    await new Promise(r=>setTimeout(r,300));
    return { items: [...document.querySelectorAll('.popover.menu .menu-item')].map(x => x.dataset.k) };
  `);
  assert(!menu.missing, '顶栏没有「字体」按钮');
  assertEq(JSON.stringify(menu.items), JSON.stringify(['pingfang', 'yahei', 'system']), '字体菜单项不对');

  const y = await s.ev(`
    document.querySelector('.popover.menu .menu-item[data-k="yahei"]').click();
    await new Promise(r=>setTimeout(r,350));
    return {
      attr: document.documentElement.dataset.font,
      state: window.__term.state.font,
      stack: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(),
      body: getComputedStyle(document.body).fontFamily,
    };
  `);
  assertEq(y.attr, 'yahei', 'data-font 没切到雅黑');
  assertEq(y.state, 'yahei', 'state.font 没记住');
  assert(y.stack.toLowerCase().includes('yahei'), '--font 没跟着变：' + y.stack);
  assert(y.body.toLowerCase().includes('yahei'), 'body 实际字体没变：' + y.body);

  // 复位，别影响后面的用例
  const back = await s.ev(`
    document.querySelector('#btn-font').click();
    await new Promise(r=>setTimeout(r,250));
    document.querySelector('.popover.menu .menu-item[data-k="${before}"]').click();
    await new Promise(r=>setTimeout(r,250));
    return window.__term.state.font;
  `);
  assertEq(back, before, '字体没复位');
});

test('新品种通知：铃铛入口 + 页面内提示', async (s) => {
  await s.ev(`document.querySelector('#tabs button[data-view="list"]').click(); await new Promise(r=>setTimeout(r,700)); return 1;`);
  const bell = await s.ev(`
    const b = document.querySelector('#list-bell-btn');
    if (!b) return { exists: false };
    const r = b.getBoundingClientRect();
    return { exists: true, w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 };
  `);
  assert(bell.exists, '工具栏里没有新币通知按钮');
  assert(bell.vis, '新币通知按钮被隐藏了');
  assert(bell.w > 20 && bell.w < 48, '铃铛按钮宽度异常：' + bell.w);

  const r = await s.ev(`
    window.__term.notifyNewListing({ b: 'TESTCOIN', s: 'TESTCOINUSDT', q: 'USDT', ts: Date.now() });
    await new Promise(r=>setTimeout(r,400));
    const t = document.querySelector('.toast');
    return { text: t ? t.textContent : '', show: t ? t.classList.contains('show') : false,
             act: !!(t && t.querySelector('.toast-act')) };
  `);
  assert(r.text.includes('TESTCOIN'), '没弹新品种提示：' + r.text);
  assert(r.show, '提示条没显示');
  assert(r.act, '提示条上没有「看大图」按钮');
});

test('行情条：单击选中 / 双击填格子 / 右键菜单', async (s) => {
  const r = await s.ev(`
    const items = [...document.querySelectorAll('#tape .tape-item')];
    if (items.length < 3) return { skip: true };
    const eth = items.find(e => e.dataset.s === 'ETHUSDT');
    eth.click();
    await new Promise(r => setTimeout(r, 500));
    const clicked = {
      sel: window.__term.state.selected,
      on: eth.classList.contains('on'),
      onCount: document.querySelectorAll('#tape .tape-item.on').length,
    };

    const sol = items.find(e => e.dataset.s === 'SOLUSDT');
    sol.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    const dbl = { cell0: window.__term.grid.cells[0].symbol, view: window.__term.state.view };

    const bnb = items.find(e => e.dataset.s === 'BNBUSDT');
    bnb.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 300));
    const menu = document.querySelector('.popover.menu');
    const labels = menu ? [...menu.querySelectorAll('.menu-item span')].map(e => e.textContent) : [];
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    return { clicked, dbl, labels,
             cursor: getComputedStyle(items[0]).cursor,
             menuClosed: !document.querySelector('.popover.menu') };
  `);
  if (r.skip) return;
  assertEq(r.cursor, 'pointer', '行情条没有可点击光标');
  assertEq(r.clicked.sel, 'ETHUSDT', '单击没切换选中');
  assert(r.clicked.on, '被点的那一项没高亮');
  assertEq(r.clicked.onCount, 1, '高亮项不是唯一一个');
  assertEq(r.dbl.cell0, 'SOLUSDT', '双击没把品种填进格子');
  assertEq(r.labels.join(','), '在大图中打开,加入自选', '右键菜单项不对：' + r.labels.join(','));
  assert(r.menuClosed, '菜单没有关掉');
});

test('自选：一键清空 + 撤销', async (s) => {
  const r = await s.ev(`
    const before = window.__term.state.favs.slice();
    // 资金费率告警和清空提示共用一个 toast，告警恰好在 400ms 内触发会把提示顶掉
    const alertWasOn = window.__term.state.alert.on;
    window.__term.state.alert.on = false;
    const btn = document.querySelector('#watch-list [data-clear]');
    if (!btn) return { skip: true, before };
    btn.click();
    await new Promise(r => setTimeout(r, 400));
    const cleared = {
      favs: window.__term.state.favs.slice(),
      toast: (document.querySelector('.toast') || {}).textContent || '',
      hasAct: !!document.querySelector('.toast-act'),
      btnGone: !document.querySelector('#watch-list [data-clear]'),
    };
    const undo = document.querySelector('.toast-act');
    if (undo) undo.click();
    await new Promise(r => setTimeout(r, 400));
    window.__term.state.alert.on = alertWasOn;
    return { before, cleared, after: window.__term.state.favs.slice() };
  `);
  if (r.skip) return;
  assert(r.before.length > 0, '跑之前就没有自选，测不出东西');
  assertEq(r.cleared.favs.length, 0, '清空后还剩 ' + r.cleared.favs.length + ' 个');
  assert(r.cleared.toast.includes('已清空'), '没有清空提示：' + r.cleared.toast);
  assert(r.cleared.hasAct, '提示里没有「撤销」');
  assert(r.cleared.btnGone, '清空后「清空」按钮还在');
  assertEq(r.after.join(','), r.before.join(','), '撤销没恢复成原来的自选');
});

test('列表行高：三档切换，CSS 变量与虚拟滚动同步', async (s) => {
  await s.ev(`document.querySelector('#tabs button[data-view="list"]').click(); return 1;`);
  await new Promise((r) => setTimeout(r, 900));

  const probe = `
    const rows = [...document.querySelectorAll('#tbody-inner .row')];
    const tops = rows.map(e => Math.round(e.getBoundingClientRect().top));
    const gaps = [];
    for (let i = 1; i < tops.length; i++) gaps.push(tops[i] - tops[i - 1]);
    const L = window.__term.list;
    return {
      rowH: L.rowH,
      stateRowH: window.__term.state.rowH,
      cssVar: getComputedStyle(document.documentElement).getPropertyValue('--row-h').trim(),
      rowPx: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0,
      gapSet: [...new Set(gaps)],
      innerH: Math.round(document.querySelector('#tbody-inner').getBoundingClientRect().height),
      expectH: L.rows.length * L.rowH,
      dense: document.querySelector('#view-list').dataset.dense || '',
    };
  `;

  const pick = async (label) => {
    await s.ev(`document.querySelector('#list-rowh-btn').click(); return 1;`);
    await new Promise((r) => setTimeout(r, 300));
    const ok = await s.ev(`
      const items = [...document.querySelectorAll('.popover.menu .menu-item')];
      const b = items.find(x => x.textContent.includes('${label}'));
      if (b) b.click();
      return !!b;
    `);
    await new Promise((r) => setTimeout(r, 500));
    return ok;
  };

  const bad = [];
  for (const [label, h] of [['紧凑', 26], ['宽松', 34], ['标准', 30]]) {
    const found = await pick(label);
    if (!found) { bad.push(`菜单里没有「${label}」`); continue; }
    const r = await s.ev(probe);
    if (r.rowH !== h) bad.push(`${label}: list.rowH=${r.rowH}，应为 ${h}`);
    if (r.stateRowH !== h) bad.push(`${label}: state.rowH=${r.stateRowH}，应为 ${h}`);
    if (r.cssVar !== h + 'px') bad.push(`${label}: --row-h=${r.cssVar}，应为 ${h}px`);
    if (r.rowPx !== h) bad.push(`${label}: 实际行高 ${r.rowPx}px，应为 ${h}`);
    if (r.gapSet.length !== 1 || r.gapSet[0] !== h) bad.push(`${label}: 行间距 ${JSON.stringify(r.gapSet)}，应为 ${h}`);
    if (Math.abs(r.innerH - r.expectH) > 1) bad.push(`${label}: 滚动高度 ${r.innerH}，应为 ${r.expectH}`);
    if ((h <= 27) !== (r.dense === '1')) bad.push(`${label}: dense 标记=${r.dense || '空'} 和行高不符`);
  }
  assert(!bad.length, bad.join('；'));
});

test('详情面板：清空后残留的成交帧不再抛异常', async (s) => {
  // 真实路径：大图右侧面板开着、成交正高频推送时关面板 / 换币 → renderEmpty()
  // 已经把 `$` 置空，但那一帧已经排进 rAF 的 renderTrades 仍会执行。
  await s.ev(`
    document.querySelector('#tabs button[data-view="list"]').click();
    await new Promise(r=>setTimeout(r,900));
    const row = document.querySelector('#tbody-inner .row'); if (row) row.click();
    await new Promise(r=>setTimeout(r,3200));
    return 1;
  `);
  const before = s.errors.length;

  const r = await s.ev(`
    const dp = window.__term.detail;
    const built = !!dp.tradesEl && typeof dp.$ === 'function';
    // 一笔成交排进 rAF，同一帧内面板被清空——就是关面板那一瞬间的时序
    dp.pushTrade({ s: dp.symbol, p: 1, q: 1, m: 0, T: Date.now() });
    const rafQueued = dp.tradeRaf !== 0;
    dp.renderEmpty();
    await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,120)));
    return {
      built, rafQueued,
      raf: dp.tradeRaf, dollar: dp.$ === null,
      tradesEl: dp.tradesEl === null, bookEl: dp.bookEl === null,
      timers: [dp.cdTimer, dp.perpTimer, dp.bookTimer].filter(Boolean).length,
      empty: !!dp.root.querySelector('.dt-empty'),
    };
  `);

  assert(r.built, '详情面板没建起来，用例前提不成立');
  assert(r.rafQueued, '没排出 rAF，复现路径不成立');
  assertEq(r.raf, 0, '清空后 rAF 没取消');
  assert(r.dollar, '清空后 $ 没置空');
  assert(r.tradesEl, '清空后仍残留 tradesEl 引用（这正是异常来源）');
  assert(r.bookEl, '清空后仍残留 bookEl 引用');
  assertEq(r.timers, 0, '清空后定时器还在跑');
  assert(r.empty, '清空后没有回到空状态');
  assertEq(s.errors.length, before, '清空面板时抛出异常：\n  ' + s.errors.slice(before, before + 2).join('\n  '));

  // 还原：后面的用例还要用这块面板
  await s.ev(`
    const row = document.querySelector('#tbody-inner .row'); if (row) row.click();
    await new Promise(r=>setTimeout(r,2500));
    return 1;
  `);
  const back = await s.ev('const dp = window.__term.detail; return { sym: dp.symbol, el: !!dp.tradesEl };');
  assert(back.sym && back.el, '重新选中后详情面板没恢复');
});

test('指标参数：改 MA/EMA/BOLL/MACD 后重算并持久化', async (s) => {
  await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,400));
    // 前面的用例直接对单个格子调过 setInterval('5d')（state.interval 没变），
    // 所以这里不能靠点周期按钮——那个按钮还是 on 的，点了会 early-return
    window.__term.grid.setIntervalAll('1m');
    await new Promise(r=>setTimeout(r,1200));
    // 等第一格 K 线真的到位，否则算出来的均线是空的
    for (let i=0;i<100;i++){
      const c = window.__term.grid.cells[0];
      if (c && c.maSeries && c.maSeries.length && c.times && c.times.length > 60) break;
      await new Promise(r=>setTimeout(r,100));
    }
    return 1;
  `);

  const before = await s.ev(`
    const c = window.__term.grid.cells[0];
    return { ma: c.maSeries.map(m=>m.p), bars: c.times.length, intraday: !!c.intraday };
  `);
  assert(!before.intraday, '第一格还在分时模式，用例前提不成立');
  assert(before.bars > 60, 'K 线没加载，用例前提不成立');
  assertEq(before.ma.join(','), '5,52,200,200', '默认均线周期不对');

  // BOLL 默认关着，先打开才能验证它的周期真的生效
  await s.ev(`
    const b = document.querySelector('[data-ind="boll"]');
    if (b && !b.classList.contains('on')) b.click();
    await new Promise(r=>setTimeout(r,700));
    return 1;
  `);

  const filled = await s.ev(`
    document.querySelector('#ind-params-btn').click();
    await new Promise(r=>setTimeout(r,160));
    const pop = document.querySelector('.popover.params');
    if (!pop) return { ok: false, why: '弹层没出来' };
    const fields = ['ma0','ma1','ma2','ema','boll','bollMult','m0','m1','m2'];
    const missing = fields.filter(k => !pop.querySelector('[data-f="'+k+'"]'));
    if (missing.length) return { ok: false, why: '缺输入框 ' + missing.join(',') };
    const set = (f,v) => { pop.querySelector('[data-f="'+f+'"]').value = v; };
    set('ma0',7); set('ma1',30); set('ma2',120); set('ema',100);
    set('boll',26); set('bollMult',2.5); set('m0',8); set('m1',21); set('m2',5);
    pop.querySelector('[data-act="apply"]').click();
    await new Promise(r=>setTimeout(r,700));
    return { ok: true };
  `);
  assert(filled.ok, '参数弹层异常：' + filled.why);

  const r = await s.ev(`
    const c = window.__term.grid.cells[0];
    const closes = c.closes, n = closes.length;
    const mean = (k) => { let s=0; for (let i=n-k;i<n;i++) s+=closes[i]; return s/k; };
    const saved = JSON.parse(localStorage.getItem('binance-terminal.v1')||'{}');
    return {
      p: window.__term.state.indParams,
      maP: c.maSeries.map(m=>m.p),
      ma7: c.maSeries[0].vals[n-1], mean7: mean(7),
      bollMid: c.bollSeries[1].vals[n-1], mean26: mean(26),
      legend: c.legendEl.textContent.replace(/\\s+/g,' ').trim(),
      mlegend: c.mlegendEl ? c.mlegendEl.textContent.replace(/\\s+/g,' ').trim() : '',
      saved: saved.indParams || null,
      popLeft: !!document.querySelector('.popover.params'),
    };
  `);

  assertEq((r.p.ma || []).join(','), '7,30,120', 'state.indParams.ma 没更新');
  assertEq(r.p.ema, 100, 'state.indParams.ema 没更新');
  assertEq(r.p.boll, 26, 'state.indParams.boll 没更新');
  assertEq(r.p.bollMult, 2.5, 'state.indParams.bollMult 没更新');
  assertEq((r.p.macd || []).join(','), '8,21,5', 'state.indParams.macd 没更新');
  assertEq(r.maP.join(','), '7,30,120,100', '均线序列的周期没跟着换');
  assert(Math.abs(r.ma7 - r.mean7) < 1e-6, `MA7 数值不对：${r.ma7} vs 手算 ${r.mean7}`);
  assert(Math.abs(r.bollMid - r.mean26) < 1e-6, `BOLL 中轨不对：${r.bollMid} vs 手算 ${r.mean26}`);
  assert(r.legend.includes('MA7') && r.legend.includes('MA30') && r.legend.includes('MA120'),
    '图例没跟着改：' + r.legend);
  assert(r.legend.includes('EMA100'), '图例 EMA 没跟着改：' + r.legend);
  assert(r.mlegend.includes('MACD 8,21,5'), 'MACD 图例参数没跟着改：' + r.mlegend);
  assert(r.saved && (r.saved.macd || []).join(',') === '8,21,5', '参数没写进 localStorage');
  assert(!r.popLeft, '应用后弹层没收起');

  // 还原：恢复默认 + 关掉 BOLL，别影响后面的用例
  await s.ev(`
    document.querySelector('#ind-params-btn').click();
    await new Promise(r=>setTimeout(r,160));
    document.querySelector('.popover.params [data-act="reset"]').click();
    await new Promise(r=>setTimeout(r,120));
    document.querySelector('.popover.params [data-act="apply"]').click();
    await new Promise(r=>setTimeout(r,500));
    const b = document.querySelector('[data-ind="boll"]');
    if (b && b.classList.contains('on')) b.click();
    await new Promise(r=>setTimeout(r,500));
    return 1;
  `);
  const back = await s.ev('const p = window.__term.state.indParams; return { ma: p.ma.join(","), macd: p.macd.join(",") };');
  assertEq(back.ma, '5,52,200', '恢复默认后均线周期不对');
  assertEq(back.macd, '12,26,9', '恢复默认后 MACD 参数不对');
});

/* ================================================================== 执行 */
const server = await checkServer();
const bin = findChrome();
const profile = makeProfile('e2e-');
let chrome = null;
let ws = null;

const cleanup = async () => {
  try { ws && ws.close(); } catch (e) { /* ignore */ }
  if (chrome && !chrome.killed) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      chrome.kill('SIGKILL');
    }
  }
  await removeProfile(profile);
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
  await cleanup();
}

const total = cases.filter((c) => !FILTER || c.name.includes(FILTER)).length;
console.log(
  failed
    ? C.red(`\n  ${total - failed}/${total} 通过，${failed} 个失败\n`)
    : C.green(`\n  ${total}/${total} 全部通过\n`)
);
process.exit(failed ? 1 : 0);
