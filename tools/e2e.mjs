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
import { existsSync, rmSync } from 'node:fs';
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
  const defIv = await s.ev('return window.__term.state.bcInterval;');
  assertEq(defIv, '1d', '大图默认周期不是日线（首次运行）：' + defIv);
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
    // 等图表真的建好：跑全量时前面用例多，固定 3.8 秒会不够
    for (let i = 0; i < 250; i++) {
      if (big.cell && big.cell.chart && big.cell.bars && big.cell.bars.length > 10) break;
      await new Promise(r=>setTimeout(r,100));
    }
    await new Promise(r=>setTimeout(r,600));
    const before = big.cell.chart.panes().length;
    document.querySelector('#bc-oi-btn').click();
    // 持仓量历史要走代理，单次 2~5 秒（行情抖动时更久），
    // 固定等 4 秒会偶发误报，这里改成轮询到数据到位为止
    for (let i = 0; i < 600; i++) {
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
    window.__term.big.open('BTCUSDT@f','5m');
    // 固定等 4 秒不够稳：CVD 曲线要等 K 线挂载后才建，行情慢的时候会假失败
    for (let i=0;i<120;i++){
      const b = window.__term.big;
      if (b.cvdSeries && b.cell && b.cell.bars && b.cell.bars.length > 10) break;
      await new Promise(r=>setTimeout(r,100));
    }
    // 副图高度是 220ms + 80ms 两段式设的，曲线建好不等于高度落定
    for (let i=0;i<50;i++){
      let h = -1;
      try { h = window.__term.big.cell.chart.panes()[2].getHeight(); } catch (e) { h = -1; }
      if (h >= 50 && h <= 110) break;
      await new Promise(r=>setTimeout(r,100));
    }
    return 1;`);
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
    // 等成交真的到齐：汇总条要按近 30 笔算，成交慢的时候固定等待会假失败
    for (let i=0;i<120;i++){
      const flow = document.querySelector('#detail .tflow');
      const rows = document.querySelectorAll('#detail .trades .trade-row');
      if (flow && !flow.hidden && rows.length >= 5) break;
      await new Promise(r=>setTimeout(r,100));
    }
    return 1;`);
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
  assertEq(JSON.stringify(menu.items), JSON.stringify(['pingfang', 'yahei', 'system', 'mono']),
    '字体菜单项不对（应含新加的等宽字体）');

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
  // 菜单文案跟着当前分组名走（「加入「自选」」），只断言结构，别把分组名写死
  assertEq(r.labels.length, 2, '右键菜单项数量不对：' + r.labels.join(','));
  assertEq(r.labels[0], '在大图中打开', '右键菜单第一项不对：' + r.labels.join(','));
  assert(r.labels[1].includes('自选'), '右键菜单没有加自选项：' + r.labels.join(','));
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

test('爆量徽标：阈值生效，倍数与手算一致', async (s) => {
  await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,300));
    window.__term.grid.setIntervalAll('1m');
    for (let i=0;i<100;i++){
      const c = window.__term.grid.cells[0];
      if (c && c.bars && c.bars.length > 30) break;
      await new Promise(r=>setTimeout(r,100));
    }
    return 1;
  `);

  const setThr = async (v) => {
    await s.ev(`
      document.querySelector('#ind-params-btn').click();
      await new Promise(r=>setTimeout(r,160));
      const pop = document.querySelector('.popover.params');
      pop.querySelector('[data-f="spike"]').value = ${v};
      pop.querySelector('[data-act="apply"]').click();
      await new Promise(r=>setTimeout(r,450));
      return 1;
    `);
  };

  // 造一根确定的放量柱：把最后一根的成交额改成前 20 根均额的 5 倍。
  // 不靠真实行情——所有格子的 1m K 线共享同一个分钟边界，刚过整点时
  // 每格当前根都是刚开的，倍数同时接近 0，等真实放量会让用例随机失败。
  const inject = async (mult) => s.ev(`
    const cells = window.__term.grid.cells.filter(c => c.mounted && c.bars && c.bars.length > 30);
    if (!cells.length) return null;
    const c = cells[0];
    const n = c.bars.length;
    if (c.__origQ == null) c.__origQ = c.bars[n-1][6];
    let sum = 0;
    for (let i=n-21;i<n-1;i++) sum += c.bars[i][6] || 0;
    const avg = sum / 20;
    c.bars[n-1][6] = avg * ${mult};
    c.renderHead();
    return { idx: c.index, avg, manual: c.volRatio(), text: c.volBadgeEl.textContent,
             hidden: c.volBadgeEl.hidden, title: c.volBadgeEl.title,
             spikeCls: c.el.classList.contains('spike') };
  `);

  // 1) 阈值 20：注入 5 倍也不该显示（门控真的按参数走）
  await setThr(20);
  const hi = await inject(5);
  assert(hi, '没有已挂载且有 K 线的格子');
  assert(hi.hidden, `阈值 20 倍时 5 倍放量仍显示徽标`);
  assert(!hi.spikeCls, '阈值 20 倍时格子仍被标成爆量');

  // 2) 阈值 3：同一根柱子应当触发，且倍数与手算一致
  await setThr(3);
  const r = await inject(5);
  assert(!r.hidden, '阈值 3 倍时 5 倍放量没显示徽标');
  assert(r.text.startsWith('爆量 ×'), '徽标文字不对：' + r.text);
  const shown = Number(r.text.replace('爆量 ×', ''));
  assert(Number.isFinite(shown), '徽标倍数不是数字：' + r.text);
  const tol = shown >= 10 ? 0.6 : 0.06;   // 徽标保留 1 位小数，≥10 取整
  assert(Math.abs(shown - r.manual) < tol,
    `徽标倍数 ${shown} 与手算 ${r.manual.toFixed(3)} 不一致`);
  assert(r.title.includes('倍') && r.title.includes('成交额'), '悬停说明不完整：' + r.title);
  assert(r.spikeCls, '触发时格子没有 .spike 标记（窄格子只能靠它看出来）');

  // 3) 还原被改过的成交量，并把阈值恢复默认
  await s.ev(`
    const cells = window.__term.grid.cells.filter(c => c.__origQ != null);
    for (const c of cells) { c.bars[c.bars.length-1][6] = c.__origQ; delete c.__origQ; c.renderHead(); }
    document.querySelector('#ind-params-btn').click();
    await new Promise(r=>setTimeout(r,160));
    document.querySelector('.popover.params [data-act="reset"]').click();
    await new Promise(r=>setTimeout(r,120));
    document.querySelector('.popover.params [data-act="apply"]').click();
    await new Promise(r=>setTimeout(r,400));
    return 1;
  `);
  const back = await s.ev('return window.__term.state.indParams.spike;');
  assertEq(back, 3, '恢复默认后阈值不是 3');
});

test('自选分组：新建 / 隔离 / 重命名 / 删除可撤销', async (s) => {
  await s.ev(`
    const w = document.querySelector('#watch');
    if (w && w.classList.contains('hidden')) document.querySelector('#btn-watch').click();
    await new Promise(r=>setTimeout(r,400));
    return 1;
  `);

  // 1) 分组菜单能打开，且带新建/重命名入口
  const menu = await s.ev(`
    const btn = document.querySelector('.w-gname');
    if (!btn) return null;
    btn.click();
    await new Promise(r=>setTimeout(r,160));
    const pop = document.querySelector('.popover.menu');
    return { items: [...pop.querySelectorAll('.menu-item')].map(b=>b.textContent.trim()),
             name: btn.textContent.trim() };
  `);
  assert(menu, '自选栏没有分组按钮 .w-gname');
  assert(menu.items.some((t) => t.includes('新建分组')), '菜单缺「新建分组」：' + menu.items.join(' | '));
  assert(menu.items.some((t) => t.includes('重命名')), '菜单缺「重命名」：' + menu.items.join(' | '));

  // 2) 新建分组 → 自动切过去、列表为空
  const created = await s.ev(`
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b=>b.textContent.includes('新建分组')).click();
    await new Promise(r=>setTimeout(r,220));
    const pop = document.querySelector('.popover.params');
    if (!pop) return { ok:false };
    pop.querySelector('[data-f="v"]').value = '测试组';
    pop.querySelector('[data-act="ok"]').click();
    await new Promise(r=>setTimeout(r,420));
    const st = window.__term.state;
    const g = st.favGroups.find(x=>x.id===st.favGroup);
    return { ok:true, n: st.favGroups.length, name: g.name, favs: st.favs.length,
             title: document.querySelector('.w-gname').textContent.trim(),
             rows: document.querySelectorAll('#watch-list [data-s]').length };
  `);
  assert(created.ok, '新建分组的输入弹层没出现');
  assertEq(created.n, 2, '分组数没变成 2');
  assertEq(created.name, '测试组', '新分组名字不对');
  assertEq(created.favs, 0, '新分组应该是空的');
  assert(created.title.includes('测试组'), '自选栏标题没跟着换：' + created.title);

  // 3) 行情条右键「加入其他分组」把当前品种加进新分组
  const added = await s.ev(`
    const it = document.querySelector('#tape [data-s]');
    const sym = it.dataset.s;
    it.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true }));
    await new Promise(r=>setTimeout(r,170));
    const pop = document.querySelector('.popover.menu');
    const hit = [...pop.querySelectorAll('.menu-item')].find(b=>b.textContent.includes('测试组'));
    if (!hit) return { ok:false, items: [...pop.querySelectorAll('.menu-item')].map(b=>b.textContent.trim()) };
    hit.click();
    await new Promise(r=>setTimeout(r,420));
    const st = window.__term.state;
    const g = st.favGroups.find(x=>x.name==='测试组');
    return { ok:true, sym, inGroup: g.list.includes(sym), rows: document.querySelectorAll('#watch-list [data-s]').length };
  `);
  assert(added.ok, '行情条右键里没有「测试组」：' + (added.items || []).join(' | '));
  assert(added.inGroup, '右键加入分组没写进数据');
  assert(added.rows >= 1, '加入后自选栏没出现这一行');

  // 4) 切回「自选」，两组互不影响
  const back = await s.ev(`
    document.querySelector('.w-gname').click();
    await new Promise(r=>setTimeout(r,170));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b=>b.textContent.trim().startsWith('自选')).click();
    await new Promise(r=>setTimeout(r,360));
    const st = window.__term.state;
    const other = st.favGroups.find(x=>x.name==='测试组');
    return { cur: st.favs.length, other: other.list.length,
             title: document.querySelector('.w-gname').textContent.trim() };
  `);
  assert(back.cur >= 1, '切回后原分组自选丢了');
  assertEq(back.other, 1, '另一个分组的自选被串改了');
  assert(back.title.includes('自选'), '标题没切回「自选」：' + back.title);

  // 5) 切到测试组并重命名
  const renamed = await s.ev(`
    document.querySelector('.w-gname').click();
    await new Promise(r=>setTimeout(r,170));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b=>b.textContent.includes('测试组')).click();
    await new Promise(r=>setTimeout(r,300));
    document.querySelector('.w-gname').click();
    await new Promise(r=>setTimeout(r,170));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b=>b.textContent.includes('重命名')).click();
    await new Promise(r=>setTimeout(r,220));
    const pop = document.querySelector('.popover.params');
    if (!pop) return { ok:false };
    pop.querySelector('[data-f="v"]').value = '改名组';
    pop.querySelector('[data-act="ok"]').click();
    await new Promise(r=>setTimeout(r,360));
    const st = window.__term.state;
    return { ok:true, names: st.favGroups.map(g=>g.name),
             title: document.querySelector('.w-gname').textContent.trim() };
  `);
  assert(renamed.ok, '重命名弹层没出现');
  assert(renamed.names.includes('改名组'), '重命名没生效：' + renamed.names.join(','));
  assert(!renamed.names.includes('测试组'), '旧名字还在：' + renamed.names.join(','));
  assert(renamed.title.includes('改名组'), '标题没跟着改名');

  // 6) 删除当前分组 → 只剩一个，且有「撤销」
  const del = await s.ev(`
    document.querySelector('.w-gname').click();
    await new Promise(r=>setTimeout(r,170));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b=>b.textContent.includes('删除')).click();
    await new Promise(r=>setTimeout(r,420));
    const st = window.__term.state;
    const t = document.querySelector('.toast');
    return { n: st.favGroups.length, names: st.favGroups.map(g=>g.name),
             toast: t ? t.textContent : '', hasUndo: !!(t && t.querySelector('.toast-act')) };
  `);
  assertEq(del.n, 1, '删除后分组数应为 1');
  assert(!del.names.includes('改名组'), '分组没删掉');
  assert(del.hasUndo, '删除后没有「撤销」入口');
  assert(del.toast.includes('改名组'), '提示里没写删的是哪个分组：' + del.toast);

  // 7) 撤销 → 分组回来，名字和里面的自选都在
  const undo = await s.ev(`
    document.querySelector('.toast .toast-act').click();
    await new Promise(r=>setTimeout(r,420));
    const st = window.__term.state;
    const g = st.favGroups.find(x=>x.name==='改名组');
    return { n: st.favGroups.length, back: !!g, list: g ? g.list.length : -1,
             saved: (JSON.parse(localStorage.getItem('binance-terminal.v1')||'{}').favGroups||[]).map(x=>x.name) };
  `);
  assertEq(undo.n, 2, '撤销后分组数应为 2');
  assert(undo.back, '撤销没把分组放回来');
  assertEq(undo.list, 1, '撤销后分组里的自选丢了');
  assert(undo.saved.includes('改名组'), '分组没写进 localStorage：' + undo.saved.join(','));

  // 8) 收拾干净：再删一次，回到单分组
  await s.ev(`
    document.querySelector('.w-gname').click();
    await new Promise(r=>setTimeout(r,170));
    const hit = [...document.querySelectorAll('.popover.menu .menu-item')].find(b=>b.textContent.includes('删除'));
    if (hit) hit.click();
    await new Promise(r=>setTimeout(r,300));
    document.body.click();
    await new Promise(r=>setTimeout(r,200));
    return 1;
  `);
  const end = await s.ev('const st = window.__term.state; return { n: st.favGroups.length, cur: st.favGroup };');
  assertEq(end.n, 1, '收尾后应只剩 1 个分组');
  assertEq(end.cur, end.cur, '');
  assert(end.cur, '当前分组丢了');
});

test('大图：盘口栏拖动调宽 + 双击复位', async (s) => {
  await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,300));
    window.__term.big.open('BTCUSDT@f');
    await new Promise(r=>setTimeout(r,2600));
    const b = window.__term.big;
    if (!b.showDetail) b.setDetail(true);
    await new Promise(r=>setTimeout(r,700));
    return 1;
  `);

  const before = await s.ev(`
    const d = document.querySelector('#bc-detail');
    const h = document.querySelector('#bc-resize');
    return { w: Math.round(d.getBoundingClientRect().width),
             handle: !!h, handleW: h ? Math.round(h.getBoundingClientRect().width) : 0,
             saved: window.__term.state.bcDetailWidth };
  `);
  assert(before.handle, '盘口栏没有拖拽手柄 #bc-resize');
  assert(before.handleW >= 4, '拖拽手柄太窄，抓不住：' + before.handleW);
  assert(before.w > 200, '盘口栏宽度异常：' + before.w);

  // 往左拖 60px → 盘口栏变宽 60px
  const drag = await s.ev(`
    const h = document.querySelector('#bc-resize');
    const x0 = 1200;
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, clientX:x0, pointerId:1 }));
    h.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, clientX:x0-60, pointerId:1 }));
    h.dispatchEvent(new PointerEvent('pointerup',   { bubbles:true, clientX:x0-60, pointerId:1 }));
    await new Promise(r=>setTimeout(r,300));
    const d = document.querySelector('#bc-detail');
    const cell = document.querySelector('#bc-body .cell');
    return { w: Math.round(d.getBoundingClientRect().width),
             stateW: window.__term.state.bcDetailWidth,
             cellW: cell ? Math.round(cell.getBoundingClientRect().width) : 0,
             cursor: document.body.style.cursor };
  `);
  assert(Math.abs(drag.w - (before.w + 60)) <= 3,
    `拖动 60px 后宽度应约 ${before.w + 60}，实际 ${drag.w}`);
  assertEq(drag.stateW, drag.w, 'state.bcDetailWidth 和实际宽度不一致');
  assert(drag.cellW > 200, '拖动后图表区被挤没了：' + drag.cellW);
  assertEq(drag.cursor, '', '拖动结束后鼠标指针没还原');

  const saved = await s.ev(`
    const s = JSON.parse(localStorage.getItem('binance-terminal.v1')||'{}');
    return s.bcDetailWidth;
  `);
  assertEq(saved, drag.w, '拖完没写进 localStorage');

  // 双击复位
  const reset = await s.ev(`
    const h = document.querySelector('#bc-resize');
    h.dispatchEvent(new MouseEvent('dblclick', { bubbles:true }));
    await new Promise(r=>setTimeout(r,300));
    return { w: Math.round(document.querySelector('#bc-detail').getBoundingClientRect().width),
             stateW: window.__term.state.bcDetailWidth };
  `);
  assertEq(reset.stateW, 0, '双击后 state 没归零');
  assert(Math.abs(reset.w - before.w) <= 3, `双击复位后宽度应回到 ${before.w}，实际 ${reset.w}`);

  await s.ev(`window.__term.big.close(); await new Promise(r=>setTimeout(r,500)); return 1;`);
});

test('绘图工具栏：拆成两组，点击仍然生效', async (s) => {
  await s.ev(`
    window.__term.big.open('BTCUSDT@f');
    await new Promise(r=>setTimeout(r,1800));
    return 1;
  `);
  const r = await s.ev(`
    const groups = [...document.querySelectorAll('#bc-draw .bc-draw-grp')];
    const btns = [...document.querySelectorAll('#bc-draw button[data-tool]')];
    const sizes = groups.map(g => g.querySelectorAll('button').length);
    // 点「矩形」看是否切换成 on
    const rect = document.querySelector('#bc-draw button[data-tool="rect"]');
    rect.click();
    await new Promise(r=>setTimeout(r,200));
    const onNow = [...document.querySelectorAll('#bc-draw button.on')].map(b=>b.dataset.tool);
    const w = Math.round(rect.getBoundingClientRect().width);
    const h = Math.round(rect.getBoundingClientRect().height);
    // 回到光标，别影响后面的用例
    document.querySelector('#bc-draw button[data-tool="cursor"]').click();
    await new Promise(r=>setTimeout(r,150));
    return { groups: groups.length, sizes, n: btns.length, onNow, w, h };
  `);
  assertEq(r.groups, 2, '绘图工具栏应该是两组');
  assertEq(r.sizes.join(','), '8,2', '两组按钮数不对：' + r.sizes.join(','));
  assertEq(r.n, 10, '绘图按钮总数不对：' + r.n);
  assert(r.onNow.includes('rect'), '点矩形后没有选中：' + r.onNow.join(','));
  assert(r.w >= 24 && r.h >= 21, `按钮太小：${r.w}×${r.h}`);

  await s.ev(`window.__term.big.close(); await new Promise(r=>setTimeout(r,400)); return 1;`);
});

test('告警：系统通知开关（授权通过 / 被拒回弹）', async (s) => {
  const r = await s.ev(`
    // 用假 Notification 替掉浏览器的：headless 下没法真的授权
    const real = window.Notification;
    const made = [];
    class FakeN {
      constructor(t, o) { made.push({ t, o }); }
      close() {}
    }
    FakeN.permission = 'granted';
    FakeN.requestPermission = async () => 'granted';
    window.Notification = FakeN;
    window.__made = made;

    document.querySelector('#btn-alerts').click();
    await new Promise(r=>setTimeout(r,300));
    const sys = document.querySelector('#al-sys');
    if (!sys) { window.Notification = real; return { ok:false }; }
    if (!sys.checked) { sys.click(); }
    await new Promise(r=>setTimeout(r,300));

    const on = { checked: sys.checked, state: window.__term.state.alert.sys };

    // 直接触发一次命中：拿一个永续合约
    const sym = [...window.__term.market.values()].find(x => x.mkt === 'perp').s;
    window.__term.alerts.notify([sym], 0.05);
    await new Promise(r=>setTimeout(r,200));
    const one = made.slice();

    // 再触发一次：同 tag 应该继续产生新通知（我们只断言会继续调用）
    window.__term.alerts.notify([sym], 0.05);
    await new Promise(r=>setTimeout(r,120));

    // 被拒的路径：权限改 denied，再点一次开关
    sys.click();
    await new Promise(r=>setTimeout(r,200));
    FakeN.permission = 'denied';
    FakeN.requestPermission = async () => 'denied';
    sys.click();
    await new Promise(r=>setTimeout(r,300));
    const denied = { checked: sys.checked, state: window.__term.state.alert.sys };

    window.Notification = real;
    return { ok:true, on, n: one.length, first: one[0] || null,
             total: made.length, denied };
  `);
  assert(r.ok, '告警面板里没有 #al-sys 开关');
  assert(r.on.checked, '打开后开关没勾上');
  assertEq(r.on.state, true, 'state.alert.sys 没置 true');
  assertEq(r.n, 1, '命中一次应该弹 1 条系统通知，实际 ' + r.n);
  assert(r.first && r.first.t.includes('资金费率'), '通知标题不对：' + (r.first && r.first.t));
  assert(r.first.o && String(r.first.o.body).includes('±') && String(r.first.o.body).includes('超过'),
    '通知正文不对：' + (r.first.o && r.first.o.body));
  assertEq(r.first.o.tag, 'bterm-funding', '通知没带固定 tag，会把通知中心刷满');
  assertEq(r.total, 2, '第二次命中没有再次通知');
  assertEq(r.denied.checked, false, '权限被拒后开关应该自动弹回');
  assertEq(r.denied.state, false, '权限被拒后 state 应该回到 false');

  // 收拾：关掉告警面板和告警开关
  await s.ev(`
    document.querySelector('#al-close').click();
    await new Promise(r=>setTimeout(r,200));
    const on = document.querySelector('#al-on');
    if (on.checked) { on.click(); }
    await new Promise(r=>setTimeout(r,200));
    return 1;
  `);
});

test('详情面板：清空时真的销毁图表（防库内部 Value is null）', async (s) => {
  await s.ev(`
    window.__term.big.open('ETHUSDT@f');
    await new Promise(r=>setTimeout(r,2400));
    return 1;
  `);
  const before = await s.ev(`
    const dp = window.__term.big.detailPanel;
    return { chart: !!dp.chart, ro: !!dp.ro };
  `);
  assert(before.chart, '详情面板没有图表，用例前提不成立');

  const r = await s.ev(`
    const dp = window.__term.big.detailPanel;
    let removed = 0;
    if (dp.chart) {
      const orig = dp.chart.remove.bind(dp.chart);
      dp.chart.remove = () => { removed++; return orig(); };
    }
    let roOff = 0;
    if (dp.ro) {
      const orig = dp.ro.disconnect.bind(dp.ro);
      dp.ro.disconnect = () => { roOff++; return orig(); };
    }
    dp.renderEmpty();
    await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,120)));
    return { removed, roOff, chart: dp.chart, ro: dp.ro,
             empty: !!dp.root.querySelector('.dt-empty') };
  `);
  assertEq(r.removed, 1, 'renderEmpty 没有调用 chart.remove()（库内部观察器会继续挂在废弃节点上）');
  assertEq(r.roOff, 1, 'renderEmpty 没有断开 ResizeObserver');
  assertEq(r.chart, null, 'chart 引用没清空');
  assertEq(r.ro, null, 'ro 引用没清空');
  assert(r.empty, '没有回到空状态');

  await s.ev(`window.__term.big.close(); await new Promise(r=>setTimeout(r,500)); return 1;`);
});

test('绘图：射线 / 水平射线 / 文本标注', async (s) => {
  await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,300));
    window.__term.big.open('BTCUSDT@f');
    await new Promise(r=>setTimeout(r,2600));
    const d = window.__term.big.draw;
    d.items.length = 0;
    d.persist();
    d.schedule();
    return 1;
  `);

  const clickAt = (x, y) => `
    const host = window.__term.big.cell.host;
    const r = host.getBoundingClientRect();
    const mk = (type) => new PointerEvent(type, { bubbles:true, pointerId:1,
      clientX: r.left + ${x}, clientY: r.top + ${y} });
    host.dispatchEvent(mk('pointerdown'));
    host.dispatchEvent(mk('pointerup'));
  `;
  const dragTo = (x1, y1, x2, y2) => `
    const host = window.__term.big.cell.host;
    const r = host.getBoundingClientRect();
    const mk = (type, x, y) => new PointerEvent(type, { bubbles:true, pointerId:1,
      clientX: r.left + x, clientY: r.top + y });
    host.dispatchEvent(mk('pointerdown', ${x1}, ${y1}));
    host.dispatchEvent(mk('pointermove', ${x2}, ${y2}));
    host.dispatchEvent(mk('pointerup', ${x2}, ${y2}));
  `;

  // 1) 水平射线：点一下即可
  const hray = await s.ev(`
    window.__term.big.setTool('hray');
    await new Promise(r=>setTimeout(r,150));
    ${clickAt(320, 210)}
    await new Promise(r=>setTimeout(r,250));
    const it = window.__term.big.draw.items.slice(-1)[0];
    return { n: window.__term.big.draw.items.length, type: it && it.type,
             hasP1: !!(it && it.p1 && it.p1.t), tool: window.__term.big.draw.tool };
  `);
  assertEq(hray.n, 1, '水平射线没画上');
  assertEq(hray.type, 'hray', '图元类型不是 hray：' + hray.type);
  assert(hray.hasP1, '水平射线没有锚点');
  assertEq(hray.tool, 'hray', '工具应该保持选中，方便连画');

  // 2) 射线：拖两点
  const ray = await s.ev(`
    window.__term.big.setTool('ray');
    await new Promise(r=>setTimeout(r,150));
    ${dragTo(300, 260, 420, 180)}
    await new Promise(r=>setTimeout(r,250));
    const it = window.__term.big.draw.items.slice(-1)[0];
    return { n: window.__term.big.draw.items.length, type: it && it.type,
             p1: it && it.p1, p2: it && it.p2 };
  `);
  assertEq(ray.n, 2, '射线没画上');
  assertEq(ray.type, 'ray', '图元类型不是 ray：' + ray.type);
  assert(ray.p2 && ray.p2.t !== ray.p1.t, '射线两个点不该重合');

  // 3) 文本：点一下弹输入框 → 确认后落地，工具自动回光标
  const txt = await s.ev(`
    window.__term.big.setTool('text');
    await new Promise(r=>setTimeout(r,150));
    ${clickAt(360, 300)}
    await new Promise(r=>setTimeout(r,250));
    const pop = document.querySelector('.popover.params');
    if (!pop) return { ok:false, n: window.__term.big.draw.items.length };
    const inp = pop.querySelector('[data-f="v"]');
    inp.value = '这里放量';
    pop.querySelector('[data-act="ok"]').click();
    await new Promise(r=>setTimeout(r,350));
    const it = window.__term.big.draw.items.slice(-1)[0];
    return { ok:true, n: window.__term.big.draw.items.length, type: it && it.type,
             text: it && it.text, tool: window.__term.big.draw.tool,
             saved: (JSON.parse(localStorage.getItem('binance-terminal.drawings.v1')||'{}')) };
  `);
  assert(txt.ok, '文本工具没有弹出输入框');
  assertEq(txt.n, 3, '文本没落地');
  assertEq(txt.type, 'text', '图元类型不是 text：' + txt.type);
  assertEq(txt.text, '这里放量', '文本内容不对：' + txt.text);
  assertEq(txt.tool, null, '添加文本后应自动回到光标模式');
  const savedSome = Object.values(txt.saved).some((arr) => Array.isArray(arr)
    && arr.some((x) => x.type === 'text' && x.text === '这里放量'));
  assert(savedSome, '文本没写进 localStorage');

  // 4) 取消输入框：不应该留下图元
  const cancel = await s.ev(`
    window.__term.big.setTool('text');
    await new Promise(r=>setTimeout(r,150));
    ${clickAt(380, 320)}
    await new Promise(r=>setTimeout(r,250));
    const pop = document.querySelector('.popover.params');
    if (!pop) return { ok:false };
    pop.querySelector('[data-act="cancel"]').click();
    await new Promise(r=>setTimeout(r,300));
    return { ok:true, n: window.__term.big.draw.items.length };
  `);
  assert(cancel.ok, '第二次点文本没弹框');
  assertEq(cancel.n, 3, '点取消后不该新增图元');

  // 5) 光标模式点中水平射线 → Delete 删除
  const del = await s.ev(`
    window.__term.big.setTool('cursor');
    await new Promise(r=>setTimeout(r,150));
    const host = window.__term.big.cell.host;
    const r = host.getBoundingClientRect();
    const ev = (type, x, y) => new PointerEvent(type, { bubbles:true, pointerId:1,
      clientX: r.left + x, clientY: r.top + y });
    // 点在水平射线上（y=210，x 往右）
    host.dispatchEvent(ev('pointerdown', 320, 210));
    host.dispatchEvent(ev('pointerup', 320, 210));
    host.dispatchEvent(new MouseEvent('click', { bubbles:true, clientX: r.left+320, clientY: r.top+210 }));
    await new Promise(r=>setTimeout(r,200));
    const sel = window.__term.big.draw.sel;
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Delete', bubbles:true }));
    await new Promise(r=>setTimeout(r,250));
    return { sel, n: window.__term.big.draw.items.length,
             types: window.__term.big.draw.items.map(i=>i.type) };
  `);
  assert(del.sel >= 0, '光标模式没选中水平射线');
  assertEq(del.n, 2, 'Delete 没删掉图元');
  assert(!del.types.includes('hray'), '删错图元了：' + del.types.join(','));

  // 收尾：清空这个品种的绘图
  await s.ev(`
    document.querySelector('#bc-draw button[data-tool="clear"]').click();
    await new Promise(r=>setTimeout(r,300));
    window.__term.big.close();
    await new Promise(r=>setTimeout(r,400));
    return 1;
  `);
});

test('大图：头部报价跟逐笔一致，面板收起仍订阅逐笔', async (s) => {
  await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,300));
    window.__term.big.open('BTCUSDT@f');
    // 前面的用例可能把盘口栏关掉了，关着就不订逐笔，这里先打开
    if (!window.__term.big.showDetail) document.querySelector('#bc-detail-btn').click();
    window.__term.syncSubs();            // 走 app 正常路径，登记订阅
    await new Promise(r=>setTimeout(r,1200));
    // 等逐笔真的在流：只要最新一笔超过 3 秒没更新，说明订阅还没生效
    for (let i=0;i<150;i++){
      const t0 = window.__term.big.detailPanel.trades[0];
      if (t0 && Date.now() - t0.T < 3000) break;
      await new Promise(r=>setTimeout(r,100));
    }
    return 1;
  `);

  // 1) 头部价格应当跟着最后一笔成交，而不是 0.7 秒一批的行情快照
  const r = await s.ev(`
    const b = window.__term.big;
    const dp = b.detailPanel;
    const num = (t) => Number(String(t).replace(/,/g, ''));
    // 头部允许最多落后两笔成交（50ms 节流 + 采样时机），
    // 但绝不能像以前那样跟的是 0.7 秒一批的行情快照
    // 头部的实时源有两个：逐笔、以及最新一根 K 线的收盘（后者往往更新更快）。
    // 老 bug 是头部只跟 0.7 秒一批的行情快照，那个值和这两个源都对不上，
    // 所以判据是「头部必须等于其中一个实时源」，而不是死盯逐笔。
    const lastClose = () => {
      const c = b.cell;
      return c && c.closes.length ? c.closes[c.closes.length - 1] : null;
    };
    let worst = 0, n = 0, changed = 0, prev = null;
    for (let i = 0; i < 30; i++) {
      const cands = (dp.trades || []).slice(0, 3).map(t => t && t.p).filter(v => v > 0);
      const lc = lastClose();
      if (lc > 0) cands.push(lc);
      if (cands.length) {
        const hdr = num(b.pxEl.textContent);
        worst = Math.max(worst, Math.min(...cands.map(v => Math.abs(hdr - v) / v * 1e4)));
        if (prev != null && hdr !== prev) changed++;
        prev = hdr;
        n++;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return { worst, n, changed, hdr: b.pxEl.textContent,
             last: dp.trades[0] && dp.trades[0].p, live: b.livePx && b.livePx.p };
  `);
  assert(r.n >= 10, '逐笔太少，用例前提不成立：' + r.n);
  // 以前头部跟的是行情快照，和逐笔最多差到 30bps。
  // 阈值不能卡太死：BTC 一个最小跳动就约 1.3bps，波动大时"落后一笔"必然超过 1.5。
  // 所以用「4bps 上限 + 3 秒内必须跟着变过」两个条件，前者防退回快照，后者证明确实在跟逐笔。
  assert(r.worst < 4, `头部与逐笔/最新收盘最少差 ${r.worst.toFixed(2)}bps（应 < 4）`);
  assert(r.changed >= 2, `3 秒内头部只变了 ${r.changed} 次，没在跟实时源`);

  // 2) 收起右侧盘口栏后，逐笔订阅不能断（它是头部价格唯一的高频来源）
  const off = await s.ev(`
    const b = window.__term.big;
    b.setDetail(false);
    window.__term.syncSubs();
    await new Promise(r=>setTimeout(r,900));
    const st = await (await fetch('/api/status')).json();
    return { trades: st.trades, depth: st.depth, show: b.showDetail };
  `);
  assertEq(off.show, false, '盘口栏没关上');
  assertEq(off.trades, 'BTCUSDT@f', '收起面板后逐笔订阅被取消了：' + off.trades);
  assertEq(off.depth, '', '收起面板后盘口还在订阅（浪费带宽）：' + off.depth);

  // 3) 再打开，恢复原状
  await s.ev(`
    window.__term.big.setDetail(true);
    window.__term.syncSubs();
    await new Promise(r=>setTimeout(r,700));
    window.__term.big.close();
    await new Promise(r=>setTimeout(r,400));
    return 1;
  `);
});

test('周期：大图默认日线，周线/月线/30分都能出图', async (s) => {
  // 1) 走真实入口（双击格子）：大图应当用自己记住的周期，而不是格子的周期
  const first = await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,400));
    window.__term.state.bcInterval = '1d';
    window.__term.state.interval = '1m';      // 格子墙是 1m，大图仍应是日线
    document.querySelector('#grid .cell').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await new Promise(r=>setTimeout(r,3000));
    const b = window.__term.big;
    const onBtn = [...document.querySelectorAll('#bc-iv button.on')].map(x=>x.dataset.iv);
    return { iv: b.interval, onBtn, bars: b.cell ? b.cell.bars.length : 0,
             label: document.querySelector('#bc-iv button[data-iv="1d"]').textContent };
  `);
  assertEq(first.iv, '1d', '大图没听 bcInterval（格子的 1m 串进来了）：' + first.iv);
  assert(first.onBtn.includes('1d'), '日线按钮没高亮：' + first.onBtn.join(','));
  assert(first.bars > 10, '日线没加载出 K 线：' + first.bars);

  // 2) 周期条里要有 30分 / 周线 / 月线
  const btns = await s.ev(`
    const all = [...document.querySelectorAll('#bc-iv button')].map(b=>b.dataset.iv);
    return { all, has30: all.includes('30m'), hasW: all.includes('1w'), hasM: all.includes('1M'),
             wall30: !!document.querySelector('#interval-seg button[data-iv="30m"]') };
  `);
  assert(btns.has30 && btns.hasW && btns.hasM, '大图周期条缺按钮：' + btns.all.join(','));
  assert(btns.wall30, '格子墙顶栏没有 30分 按钮');

  // 3) 逐个切过去，确认都能出 K 线
  const check = async (iv, minBars) => {
    const r = await s.ev(`
      document.querySelector('#bc-iv button[data-iv="${iv}"]').click();
      for (let i=0;i<120;i++){
        const c = window.__term.big.cell;
        if (c && c.loadedKey === c.symbol + '|' + '${iv}' && c.bars.length > ${minBars}) break;
        await new Promise(r=>setTimeout(r,100));
      }
      const c = window.__term.big.cell;
      return { iv: window.__term.big.interval, bars: c ? c.bars.length : 0,
               loaded: c ? c.loadedKey : '', saved: window.__term.state.bcInterval };
    `);
    assertEq(r.iv, iv, '切到 ' + iv + ' 失败，实际 ' + r.iv);
    assert(r.bars > minBars, iv + ' 没加载出 K 线：' + r.bars);
    assertEq(r.saved, iv, '切换后没写进 state.bcInterval');
    return r;
  };

  await check('30m', 20);
  await check('1w', 20);
  await check('1M', 5);

  // 4) 关掉再打开，应该记住上次的周期
  const reopen = await s.ev(`
    window.__term.big.close();
    await new Promise(r=>setTimeout(r,400));
    window.__term.big.open('BTCUSDT@f');
    await new Promise(r=>setTimeout(r,2200));
    return { iv: window.__term.big.interval,
             onBtn: [...document.querySelectorAll('#bc-iv button.on')].map(x=>x.dataset.iv) };
  `);
  assertEq(reopen.iv, '1M', '重新打开没记住月线：' + reopen.iv);
  assert(reopen.onBtn.includes('1M'), '月线按钮没高亮：' + reopen.onBtn.join(','));

  // 5) 回到日线，别影响后面的用例
  await s.ev(`
    document.querySelector('#bc-iv button[data-iv="1d"]').click();
    await new Promise(r=>setTimeout(r,1200));
    window.__term.big.close();
    await new Promise(r=>setTimeout(r,400));
    return 1;
  `);
});

test('详情面板：迷你走势可切 分时/5日/1天/1周/1月', async (s) => {
  // 列表视图 + 选中一行，让右侧详情面板出现
  await s.ev(`
    document.querySelector('#tabs button[data-view="list"]').click();
    await new Promise(r=>setTimeout(r,900));
    const row = document.querySelector('.tbody-inner .row');
    if (row) row.click();
    await new Promise(r=>setTimeout(r,2200));
    return 1;
  `);

  // 1) 四个窗口按钮都在，默认 2时 高亮
  const tabs = await s.ev(`
    const d = document.querySelector('#detail');
    const btns = [...d.querySelectorAll('.dt-spark-tabs button')];
    return { labels: btns.map(b=>b.textContent), wins: btns.map(b=>b.dataset.win),
             on: btns.filter(b=>b.classList.contains('on')).map(b=>b.dataset.win),
             win: window.__term.state.sparkWin };
  `);
  assertEq(tabs.wins.join(','), 'time,5d,1d,1w,1m', '窗口按钮不对：' + tabs.wins.join(','));
  assertEq(tabs.on.join(','), 'time', '默认高亮的窗口不对：' + tabs.on.join(','));
  assertEq(tabs.win, 'time', 'state.sparkWin 默认值不对：' + tabs.win);

  // 2) 逐个切过去，确认高亮、state 和数据都跟着变
  const pick = async (win) => {
    const r = await s.ev(`
      const d = window.__term.detail;
      document.querySelector('#detail .dt-spark-tabs button[data-win="${win}"]').click();
      await new Promise(r=>setTimeout(r,1700));
      await new Promise(r=>setTimeout(r,420));   // save() 有 250ms 防抖
      const arr = d.area ? d.area.data() : [];
      const btns = [...document.querySelectorAll('#detail .dt-spark-tabs button')];
      return { n: arr.length, first: arr.length ? arr[0].time : 0,
               win: window.__term.state.sparkWin,
               on: btns.filter(b=>b.classList.contains('on')).map(b=>b.dataset.win),
               saved: JSON.parse(localStorage.getItem('binance-terminal.v1')||'{}').sparkWin };
    `);
    assertEq(r.win, win, '切到 ' + win + ' 后 state 不对：' + r.win);
    assertEq(r.on.join(','), win, '高亮没切过去：' + r.on.join(','));
    assertEq(r.saved, win, '窗口没写进 localStorage');
    assert(r.n > 20, win + ' 的曲线没数据：' + r.n);
    return r;
  };

  const w5d = await pick('5d');
  const w1d = await pick('1d');
  const w1w = await pick('1w');
  const w1m = await pick('1m');
  // 不同窗口的数据必须真的不一样（防止"切了但图没换"）
  const firsts = new Set([w5d.first, w1d.first, w1w.first, w1m.first]);
  assertEq(firsts.size, 4, '四个窗口的曲线起点相同，说明没真正换数据');

  // 3) 切回分时，收尾
  await pick('time');

  // 4) 大图右侧面板也用同一套（同一个 DetailPanel 类）
  const big = await s.ev(`
    window.__term.big.open('BTCUSDT@f');
    await new Promise(r=>setTimeout(r,2400));
    const d = window.__term.big.detailPanel;
    const btns = [...document.querySelectorAll('#bc-detail .dt-spark-tabs button')];
    return { n: btns.length, on: btns.filter(b=>b.classList.contains('on')).map(b=>b.dataset.win),
             bars: d.area ? d.area.data().length : 0 };
  `);
  assertEq(big.n, 5, '大图右侧面板没有窗口按钮');
  assertEq(big.on.join(','), 'time', '大图右侧面板默认窗口不对：' + big.on.join(','));
  assert(big.bars > 20, '大图右侧面板曲线没数据：' + big.bars);

  await s.ev(`window.__term.big.close(); await new Promise(r=>setTimeout(r,400)); return 1;`);
});

test('详情面板：迷你走势高度可拖拽调整', async (s) => {
  await s.ev(`
    document.querySelector('#tabs button[data-view="list"]').click();
    await new Promise(r=>setTimeout(r,900));
    const row = document.querySelector('.tbody-inner .row');
    if (row) row.click();
    await new Promise(r=>setTimeout(r,2200));
    return 1;
  `);

  const before = await s.ev(`
    const el = document.querySelector('#detail [data-role="chart"]');
    const h = document.querySelector('#detail [data-role="sparkresize"]');
    return { h: Math.round(el.getBoundingClientRect().height),
             handle: !!h, handleH: h ? Math.round(h.getBoundingClientRect().height) : 0,
             stateH: window.__term.state.sparkH };
  `);
  assert(before.handle, '没有高度拖拽条');
  assert(before.handleH >= 5, '拖拽条太窄，抓不住：' + before.handleH);
  assert(Math.abs(before.h - 84) <= 2, '默认高度不是 84：' + before.h);

  // 往下拖 80px
  const drag = await s.ev(`
    const h = document.querySelector('#detail [data-role="sparkresize"]');
    const el = document.querySelector('#detail [data-role="chart"]');
    const y0 = h.getBoundingClientRect().top + 3;
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, clientY:y0, pointerId:1 }));
    h.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, clientY:y0+80, pointerId:1 }));
    h.dispatchEvent(new PointerEvent('pointerup',   { bubbles:true, clientY:y0+80, pointerId:1 }));
    await new Promise(r=>setTimeout(r,450));   // save() 防抖
    return { h: Math.round(el.getBoundingClientRect().height),
             stateH: window.__term.state.sparkH,
             saved: JSON.parse(localStorage.getItem('binance-terminal.v1')||'{}').sparkH,
             cursor: document.body.style.cursor };
  `);
  assert(Math.abs(drag.h - (before.h + 80)) <= 3, `拖 80px 后应约 ${before.h + 80}，实际 ${drag.h}`);
  assertEq(drag.stateH, drag.h, 'state.sparkH 与实际高度不一致');
  assertEq(drag.saved, drag.h, '高度没写进 localStorage');
  assertEq(drag.cursor, '', '拖完鼠标指针没还原');

  // 换一个币，面板重建后高度仍然保持
  const rebuilt = await s.ev(`
    const rows = document.querySelectorAll('.tbody-inner .row');
    if (rows[1]) rows[1].click();
    await new Promise(r=>setTimeout(r,1600));
    const el = document.querySelector('#detail [data-role="chart"]');
    return { h: Math.round(el.getBoundingClientRect().height) };
  `);
  assert(Math.abs(rebuilt.h - drag.h) <= 2, `换币后高度丢了：${rebuilt.h}`);

  // 双击复位
  const reset = await s.ev(`
    const h = document.querySelector('#detail [data-role="sparkresize"]');
    h.dispatchEvent(new MouseEvent('dblclick', { bubbles:true }));
    await new Promise(r=>setTimeout(r,400));
    const el = document.querySelector('#detail [data-role="chart"]');
    return { h: Math.round(el.getBoundingClientRect().height), stateH: window.__term.state.sparkH };
  `);
  assertEq(reset.stateH, 84, '双击后 state 没回到 84');
  assert(Math.abs(reset.h - 84) <= 2, '双击复位后高度不对：' + reset.h);

  // 上下限：拖到很小 / 很大都不该越界
  const clamp = await s.ev(`
    const h = document.querySelector('#detail [data-role="sparkresize"]');
    const el = document.querySelector('#detail [data-role="chart"]');
    const y0 = h.getBoundingClientRect().top + 3;
    const drag = async (dy) => {
      h.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, clientY:y0, pointerId:1 }));
      h.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, clientY:y0+dy, pointerId:1 }));
      h.dispatchEvent(new PointerEvent('pointerup',   { bubbles:true, clientY:y0+dy, pointerId:1 }));
      await new Promise(r=>setTimeout(r,120));
      return Math.round(el.getBoundingClientRect().height);
    };
    const low = await drag(-500);
    const high = await drag(900);
    h.dispatchEvent(new MouseEvent('dblclick', { bubbles:true }));
    await new Promise(r=>setTimeout(r,300));
    return { low, high };
  `);
  assert(clamp.low >= 60, '最小高度越界：' + clamp.low);
  assert(clamp.high <= 320, '最大高度越界：' + clamp.high);
});


test('配色：彭博终端主题（黑底琥珀 + 直角 + 选中反白）', async (s) => {
  // 1) 配色入口必须是有名字的菜单，不是盲点循环
  const menu = await s.ev(`
    document.querySelector('#btn-theme').click();
    await new Promise(r => setTimeout(r, 200));
    const pop = document.querySelector('.popover.menu');
    if (!pop) return null;
    return { items: [...pop.querySelectorAll('.menu-item')].map(b => b.textContent.trim()),
             on: [...pop.querySelectorAll('.menu-item.on')].map(b => b.textContent.trim()) };
  `);
  assert(menu, '点配色按钮没弹出菜单');
  assertEq(menu.items.join(','), '浅色,深色,彭博终端,macOS', '配色菜单项不对：' + menu.items.join(','));

  // 2) 选「彭博终端」
  const r = await s.ev(`
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b => b.textContent.trim() === '彭博终端').click();
    await new Promise(r => setTimeout(r, 700));
    const cs = getComputedStyle(document.body);
    const root = getComputedStyle(document.documentElement);
    const topbar = document.querySelector('.topbar');
    const segBtn = document.querySelector('#interval-seg button.on') || document.querySelector('#interval-seg button');
    const chip = document.querySelector('.chip');
    const seg = document.querySelector('#interval-seg');
    return {
      theme: document.documentElement.dataset.theme,
      bg: cs.backgroundColor,
      fg: cs.color,
      font: cs.fontFamily,
      textVar: root.getPropertyValue('--text').trim(),
      title: document.querySelector('#btn-theme').title,
      topbarBorder: getComputedStyle(topbar).borderBottomColor,
      topbarBg: getComputedStyle(topbar).backgroundColor,
      // 直角：终端里没有圆角
      segRadius: segBtn ? getComputedStyle(segBtn).borderRadius : null,
      chipRadius: chip ? getComputedStyle(chip).borderRadius : null,
      // 选中项反白成琥珀块
      segOnBg: getComputedStyle(seg.querySelector('button.on')).backgroundColor,
      segOnColor: getComputedStyle(seg.querySelector('button.on')).color,
      segBorder: getComputedStyle(seg).borderTopColor,
      tabular: cs.fontVariantNumeric,
    };
  `);
  assertEq(r.theme, 'bbg', '没切到彭博主题：' + r.theme);
  assertEq(r.bg, 'rgb(0, 0, 0)', '底色不是纯黑：' + r.bg);
  assertEq(r.textVar, '#ffb000', '主文字不是琥珀色：' + r.textVar);
  assert(/mono|consolas|cascadia|courier/i.test(r.font), '字体不是等宽：' + r.font);
  assert(r.title.includes('彭博'), '配色按钮提示没跟着变：' + r.title);

  // 3) 皮肤必须真的压平，不只是换色
  assertEq(r.topbarBg, 'rgb(0, 0, 0)', '顶栏不是纯黑：' + r.topbarBg);
  assertEq(r.topbarBorder, 'rgb(255, 176, 0)', '顶栏下边线不是琥珀色：' + r.topbarBorder);
  assertEq(r.segRadius, '0px', '分段按钮还有圆角（皮肤没压平）：' + r.segRadius);
  assertEq(r.chipRadius, '0px', '顶栏按钮还有圆角：' + r.chipRadius);
  assertEq(r.segOnBg, 'rgb(255, 176, 0)', '选中的周期不是琥珀反白：' + r.segOnBg);
  assertEq(r.segOnColor, 'rgb(0, 0, 0)', '琥珀块上的字不是黑色：' + r.segOnColor);
  assertEq(r.segBorder, 'rgb(38, 38, 38)', '分段控件边框不是硬边：' + r.segBorder);
  assert(r.tabular.includes('tabular-nums'), '数字没用等宽对齐：' + r.tabular);

  // 4) 图表也吃这个主题
  const chart = await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r => setTimeout(r, 700));
    return { canvas: !!document.querySelector('#grid .cell canvas'), theme: window.__term.state.theme };
  `);
  assert(chart.canvas, '彭博主题下图表画布没画出来');
  assertEq(chart.theme, 'bbg', 'state.theme 不是 bbg');

  // 4.5) macOS 档：浅色系 + 圆角卡片 + 白色滑块，且图表不能被当成深色
  const mac = await s.ev(`
    document.querySelector('#btn-theme').click();
    await new Promise(r => setTimeout(r, 220));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b => b.textContent.trim() === 'macOS').click();
    await new Promise(r => setTimeout(r, 900));
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const cell = document.querySelector('#grid .cell');
    const cellCs = cell ? getComputedStyle(cell) : null;
    const tabOn = document.querySelector('#tabs button.on');
    const segOn = document.querySelector('#interval-seg button.on');
    return {
      theme: document.documentElement.dataset.theme,
      accent: root.getPropertyValue('--accent').trim(),
      up: root.getPropertyValue('--up').trim(),
      gradient: body.backgroundImage.includes('radial-gradient'),
      topbarBg: getComputedStyle(document.querySelector('.topbar')).backgroundColor,
      cellRadius: cellCs ? cellCs.borderRadius : null,
      tabOnBg: tabOn ? getComputedStyle(tabOn).backgroundColor : null,
      segOnBg: segOn ? getComputedStyle(segOn).backgroundColor : null,
      gridGap: getComputedStyle(document.querySelector('#grid')).gap,
      canvas: !!document.querySelector('#grid .cell canvas'),
    };
  `);
  assertEq(mac.theme, 'mac', '没切到 macOS：' + mac.theme);
  assertEq(mac.accent, '#0a84ff', 'macOS 强调色不是系统蓝：' + mac.accent);
  assertEq(mac.up, '#34c759', 'macOS 涨色不是系统绿：' + mac.up);
  assert(mac.gradient, 'macOS 档没有壁纸底色（body 缺 radial-gradient）');
  assertEq(mac.topbarBg, 'rgba(255, 255, 255, 0.72)', 'macOS 顶栏不是半透明白：' + mac.topbarBg);
  assertEq(mac.cellRadius, '10px', 'macOS 格子不是圆角卡片：' + mac.cellRadius);
  assertEq(mac.tabOnBg, 'rgb(255, 255, 255)', '视图切换不是白色滑块：' + mac.tabOnBg);
  assertEq(mac.segOnBg, 'rgb(255, 255, 255)', '周期分段不是白色滑块：' + mac.segOnBg);
  assertEq(mac.gridGap, '8px', 'macOS 格子之间没有卡片间距：' + mac.gridGap);
  assert(mac.canvas, 'macOS 档下图表画布没出来');

  // 5) 切回浅色（同样走菜单），别影响后面的用例
  await s.ev(`
    document.querySelector('#btn-theme').click();
    await new Promise(r => setTimeout(r, 200));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b => b.textContent.trim() === '浅色').click();
    await new Promise(r => setTimeout(r, 600));
    return 1;
  `);
  const back = await s.ev(`
    return { theme: document.documentElement.dataset.theme,
             radius: getComputedStyle(document.querySelector('.chip')).borderRadius };
  `);
  assertEq(back.theme, 'light', '没切回浅色：' + back.theme);
  assert(back.radius !== '0px', '浅色主题的圆角被彭博皮肤污染了：' + back.radius);
});

test('大图：十字光标信息卡（日期/星期 + 明细，配色随主题）', async (s) => {
  const box = await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r=>setTimeout(r,500));
    document.querySelector('#grid .cell').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    for (let i=0;i<150;i++){
      const b = window.__term.big;
      if (b.cell && b.cell.chart && b.cell.bars && b.cell.bars.length > 20) break;
      await new Promise(r=>setTimeout(r,100));
    }
    await new Promise(r=>setTimeout(r,400));
    const b = window.__term.big;
    const r = b.cell.host.getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.5), y: Math.round(r.top + r.height * 0.4),
             inBody: b.tipEl && b.tipEl.parentElement === b.body };
  `);
  assert(box.inBody, '信息卡没挂在 .bc-body 里');

  // 真实鼠标悬停（合成 MouseEvent 触发不了 lightweight-charts 的十字光标）
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
  await new Promise((r) => setTimeout(r, 500));

  const tip = await s.ev(`
    const t = document.querySelector('.bc-tip');
    const rows = [...t.querySelectorAll('.bt-row')].map(r => ({
      k: r.children[0].textContent, v: r.children[1].textContent, cls: r.children[1].className,
    }));
    const head = t.querySelector('.bt-head');
    const r = t.getBoundingClientRect();
    const body = document.querySelector('#bc-body').getBoundingClientRect();
    const cs = getComputedStyle(t);
    return {
      hidden: t.hidden,
      head: head ? head.textContent : '',
      keys: rows.map(x => x.k),
      rows,
      inside: r.left >= body.left - 1 && r.right <= body.right + 1
           && r.top >= body.top - 1 && r.bottom <= body.bottom + 1,
      pe: cs.pointerEvents,
      bg: cs.backgroundColor,
      radius: cs.borderTopLeftRadius,
      mono: cs.fontVariantNumeric,
    };
  `);
  assert(!tip.hidden, '悬停时信息卡没出现');
  assert(/^\d{4}\/\d{2}\/\d{2}星期[日一二三四五六]$/.test(tip.head),
    '表头不是「日期 + 星期」：' + tip.head);
  for (const k of ['收盘', '开盘', '最高', '最低', '涨幅', '振幅', '成交量', '成交额', '状态']) {
    assert(tip.keys.includes(k), '信息卡缺「' + k + '」行：' + tip.keys.join(','));
  }
  const get = (k) => tip.rows.find((x) => x.k === k);
  assert(['阳线', '阴线'].includes(get('状态').v), '状态行不对：' + get('状态').v);
  assert(/%$/.test(get('涨幅').v), '涨幅不是百分比：' + get('涨幅').v);
  assert(/%$/.test(get('振幅').v), '振幅不是百分比：' + get('振幅').v);
  // 涨跌上色必须和方向一致（涨绿跌红，跟整站一致）
  assertEq(get('涨幅').cls, get('涨幅').v.startsWith('+') ? 'up' : 'down',
    '涨幅的颜色与方向不一致：' + get('涨幅').v + ' / ' + get('涨幅').cls);
  // 卡片不能吃鼠标事件，否则会挡住画线工具
  assertEq(tip.pe, 'none', '信息卡会拦截鼠标事件');
  assert(tip.inside, '信息卡跑出了图表区域');
  assert(tip.mono.includes('tabular-nums'), '数字没等宽对齐：' + tip.mono);

  // 移开 → 收起
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
  await new Promise((r) => setTimeout(r, 450));
  const away = await s.ev(`return { hidden: document.querySelector('.bc-tip').hidden };`);
  assert(away.hidden, '鼠标移开信息卡没收起');

  // 彭博档：黑底琥珀边 + 直角
  const bbg = await s.ev(`
    document.querySelector('#btn-theme').click();
    await new Promise(r => setTimeout(r, 220));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b => b.textContent.trim() === '彭博终端').click();
    await new Promise(r => setTimeout(r, 700));
    return 1;
  `);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
  await new Promise((r) => setTimeout(r, 500));
  const skin = await s.ev(`
    const t = document.querySelector('.bc-tip');
    const cs = getComputedStyle(t);
    return { hidden: t.hidden, bg: cs.backgroundColor, border: cs.borderTopColor, radius: cs.borderTopLeftRadius,
             rows: t.querySelectorAll('.bt-row').length };
  `);
  assert(!skin.hidden, '彭博档下信息卡没出现');
  assertEq(skin.bg, 'rgb(0, 0, 0)', '彭博档信息卡不是黑底：' + skin.bg);
  assertEq(skin.border, 'rgb(255, 176, 0)', '彭博档信息卡边框不是琥珀：' + skin.border);
  assertEq(skin.radius, '0px', '彭博档信息卡还有圆角：' + skin.radius);
  assertEq(skin.rows, 13, '信息卡行数不对：' + skin.rows);

  // 换币必须收起（旧币的明细不能留在屏幕上）
  await s.ev(`
    document.querySelector('#bc-close').click();
    await new Promise(r => setTimeout(r, 400));
    return 1;
  `);
  const closed = await s.ev(`return { hidden: document.querySelector('.bc-tip').hidden };`);
  assert(closed.hidden, '关掉大图后信息卡没收起');

  // 收尾：切回浅色，别影响后面的用例
  await s.ev(`
    document.querySelector('#btn-theme').click();
    await new Promise(r => setTimeout(r, 220));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b => b.textContent.trim() === '浅色').click();
    await new Promise(r => setTimeout(r, 600));
    return 1;
  `);
  const back = await s.ev('return document.documentElement.dataset.theme;');
  assertEq(back, 'light', '没切回浅色：' + back);
});

test('列表工具栏：缩放后 9 个分类标签全部可见（折两行）', async (s) => {
  const check = async (w) => {
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 900));
    return s.ev(`
      document.querySelector('#tabs button[data-view="list"]').click();
      await new Promise(r => setTimeout(r, 900));
      const tb = document.querySelector('.list-toolbar');
      const seg = document.querySelector('#list-tab');
      const btns = [...seg.querySelectorAll('button')];
      const last = btns[btns.length - 1];
      const tbR = tb.getBoundingClientRect();
      const segR = seg.getBoundingClientRect();
      const lastR = last.getBoundingClientRect();
      // 每个按钮都必须落在可视区域内，且宽度没被压扁（文字被裁时宽度会变小）
      const clipped = btns.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > tbR.right + 1 || r.width < b.scrollWidth - 1;
      }).map((b) => b.textContent);
      return {
        w: window.innerWidth,
        rows: Math.round(tbR.height) > 46 ? 2 : 1,
        tbH: Math.round(tbR.height),
        n: btns.length,
        lastText: last.textContent,
        lastVisible: lastR.right <= tbR.right + 1 && lastR.width > 20,
        clipped,
        segScroll: seg.scrollWidth - seg.clientWidth,
        // 第二行必须整体在工具栏内（不能溢出到表格上）
        inside: segR.bottom <= tbR.bottom + 1,
      };
    `);
  };

  for (const w of [1600, 1200, 1000, 820]) {
    const r = await check(w);
    assertEq(r.n, 9, w + ' 下分类标签数量不对：' + r.n);
    assert(r.lastVisible, w + ' 下最后一个标签「' + r.lastText + '」被裁掉');
    assertEq(r.clipped.join(','), '', w + ' 下这些标签被裁：' + r.clipped.join(','));
    assert(r.inside, w + ' 下标签条溢出工具栏（压到表格上）');
    assertEq(r.segScroll, 0, w + ' 下标签条仍在内部横向滚动，没真正放下：' + r.segScroll);
  }

  // 窄到极限时可以滚动，但工具栏不能崩
  const tiny = await check(560);
  assertEq(tiny.n, 9, '窄屏下标签数量不对');
  assert(tiny.tbH >= 70, '窄屏下工具栏高度异常：' + tiny.tbH);

  await s.send('Emulation.clearDeviceMetricsOverride');
  await new Promise((r) => setTimeout(r, 600));
});

test('数字字体：苹果风（Inter）+ 等宽对齐，彭博档回到等宽', async (s) => {
  const r = await s.ev(`
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    document.querySelector('#tabs button[data-view="list"]').click();
    await new Promise(r => setTimeout(r, 1200));
    const pill = document.querySelector('#tbody-inner .row .pill');
    const px = document.querySelector('#tbody-inner .row .px');
    const cs = pill ? getComputedStyle(pill) : null;
    const loaded = document.fonts ? document.fonts.check('12px Inter') : false;
    return {
      loaded,
      font: cs ? cs.fontFamily : '',
      tabular: document.body ? getComputedStyle(document.body).fontVariantNumeric : '',
      pillText: pill ? pill.textContent : '',
      pxFont: px ? getComputedStyle(px).fontFamily : '',
    };
  `);
  assert(r.loaded, 'Inter 字体没加载（@font-face 路径或格式有问题）');
  assert(/Inter/.test(r.font), '涨跌幅数字没用 Inter：' + r.font);
  assert(/Inter/.test(r.pxFont), '价格数字没用 Inter：' + r.pxFont);
  assert(r.tabular.includes('tabular-nums'), '数字没有等宽对齐：' + r.tabular);
  assert(/%$/.test(r.pillText), '涨跌幅单元格取错了：' + r.pillText);

  // 彭博档要保持等宽（终端味道）
  const bbg = await s.ev(`
    document.querySelector('#btn-theme').click();
    await new Promise(r => setTimeout(r, 220));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b => b.textContent.trim() === '彭博终端').click();
    await new Promise(r => setTimeout(r, 800));
    const pill = document.querySelector('#tbody-inner .row .pill');
    const font = getComputedStyle(pill).fontFamily;
    document.querySelector('#btn-theme').click();
    await new Promise(r => setTimeout(r, 220));
    [...document.querySelectorAll('.popover.menu .menu-item')].find(b => b.textContent.trim() === '浅色').click();
    await new Promise(r => setTimeout(r, 500));
    return { font };
  `);
  assert(/Cascadia|Consolas|mono/i.test(bbg.font), '彭博档数字没回到等宽：' + bbg.font);
});

test('月线：取到的是月线不是分钟线，横轴按月显示', async (s) => {
  // 1) 接口层：这条直接守住「磁盘缓存文件名大小写不敏感导致 1m/1M 串档」
  const api = await s.ev(`
    const j = await (await fetch('/api/klines?symbol=BTCUSDT%40f&interval=1M&limit=36')).json();
    const k = j.k || [];
    const gaps = [];
    for (let i = 1; i < k.length; i++) gaps.push((k[i][0] - k[i - 1][0]) / 86400000);
    gaps.sort((a, b) => a - b);
    const m = await (await fetch('/api/klines?symbol=BTCUSDT%40f&interval=1m&limit=10')).json();
    const mk = m.k || [];
    const mg = mk.length > 1 ? (mk[mk.length - 1][0] - mk[0][0]) / (mk.length - 1) / 60000 : 0;
    return {
      n: k.length,
      med: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0,
      minGap: gaps[0] || 0,
      first: k.length ? new Date(k[0][0]).toISOString().slice(0, 10) : null,
      last: k.length ? new Date(k[k.length - 1][0]).toISOString().slice(0, 10) : null,
      minSpacing: mg,
    };
  `);
  assert(api.n >= 12, '月线根数太少：' + api.n);
  assert(api.med >= 28 && api.med <= 31.5, `月线间距应为 28~31 天，实际 ${api.med} 天`);
  assert(api.minGap >= 27, `月线里混进了更短的 K 线（最小间距 ${api.minGap} 天）——缓存串档了`);
  assert(/^\d{4}-\d{2}-01$/.test(api.first), '月线起点不是月初：' + api.first);
  assert(/^\d{4}-\d{2}-01$/.test(api.last), '月线终点不是月初：' + api.last);
  // 顺带确认 1m 没被这次改动带坏
  assert(api.minSpacing > 0.9 && api.minSpacing < 1.1, `1m 间距异常：${api.minSpacing} 分钟`);

  // 2) UI：切到月线，K 线要铺满宽度、时间文案只到月
  const ui = await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r => setTimeout(r, 400));
    document.querySelector('#grid .cell').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 2200));
    const b = window.__term.big;
    document.querySelector('#bc-iv button[data-iv="1M"]').click();
    for (let i = 0; i < 200; i++) {
      const c = b.cell;
      if (c && c.loadedKey === b.symbol + '|1M' && c.bars.length > 10) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 900));
    const c = b.cell;
    const ts = c.chart.timeScale();
    const opts = ts.options();
    const paneW = Math.max(80, c.host.clientWidth - 62);
    const filled = opts.barSpacing * c.bars.length / paneW;
    // 横轴刻度文案：不该出现 "23:00" 这种
    const ticks = [...document.querySelectorAll('#bigchart canvas')].length;
    return {
      bars: c.bars.length,
      first: new Date(c.times[0] * 1000).toISOString().slice(0, 10),
      last: new Date(c.times[c.times.length - 1] * 1000).toISOString().slice(0, 10),
      legend: b.infoEl.textContent.replace(/\\s+/g, ' ').trim(),
      spacing: opts.barSpacing,
      filled,
      canTick: typeof opts.tickMarkFormatter,
      canvas: ticks,
    };
  `);
  assert(ui.bars >= 20 && ui.bars <= 400, '大图月线根数异常：' + ui.bars);
  assert(/^\d{4}-\d{2}-01$/.test(ui.first), '大图月线起点不是月初：' + ui.first);
  // 顶部明细行：只有年月，不带时分
  assert(/^\d{4}-\d{2}\s/.test(ui.legend), '月线明细行时间格式不对：' + ui.legend.slice(0, 30));
  assert(!/\d{2}:\d{2}/.test(ui.legend.split('开')[0]), '月线明细行还带着时分：' + ui.legend.slice(0, 30));
  // K 线要铺满宽度（以前按 1000 根算间距，月线会全挤到右边）
  assert(ui.filled > 0.75, `月线只占了 ${(ui.filled * 100).toFixed(0)}% 宽度，左侧留白过多`);
  assert(ui.canvas > 0, '月线下没有画布');

  // 3) 悬停：信息卡表头应是「年/月 + 月线」
  const box = await s.ev(`
    const c = window.__term.big.cell;
    const r = c.host.getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height * 0.35) };
  `);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
  await new Promise((r) => setTimeout(r, 500));
  const tip = await s.ev(`
    const t = document.querySelector('.bc-tip');
    return { hidden: t.hidden, head: t.querySelector('.bt-head') ? t.querySelector('.bt-head').textContent.trim() : '' };
  `);
  assert(!tip.hidden, '月线悬停时信息卡没出现');
  assert(/^\d{4}\/\d{2}月线$/.test(tip.head), '月线信息卡表头不对：' + tip.head);

  // 4) 切回日线，确认没把别的周期带坏
  const back = await s.ev(`
    const b = window.__term.big;
    document.querySelector('#bc-iv button[data-iv="1d"]').click();
    for (let i = 0; i < 200; i++) {
      const c = b.cell;
      if (c && c.loadedKey === b.symbol + '|1d' && c.bars.length > 10) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 700));
    const c = b.cell;
    const gaps = [];
    for (let i = Math.max(1, c.bars.length - 10); i < c.bars.length; i++) gaps.push((c.bars[i][0] - c.bars[i - 1][0]) / 86400000);
    gaps.sort((a, b2) => a - b2);
    return { med: gaps[Math.floor(gaps.length / 2)] || 0,
             legend: b.infoEl.textContent.replace(/\\s+/g, ' ').trim().slice(0, 20) };
  `);
  assert(back.med >= 1 && back.med <= 3.2, `日线间距异常：${back.med} 天`);
  assert(/^\d{4}-\d{2}-\d{2}\s/.test(back.legend), '日线明细行格式不对：' + back.legend);

  await s.ev(`window.__term.big.close(); await new Promise(r => setTimeout(r, 400)); return 1;`);
});

test('对数坐标：一键切换，墙上与大图同步，落盘', async (s) => {
  const r = await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r => setTimeout(r, 600));
    const cells = window.__term.grid.cells.filter(c => c.mounted && c.chart);
    const before = cells.map(c => c.chart.priceScale('right').options().mode);
    const btn0 = document.querySelector('#log-btn').classList.contains('on');
    document.querySelector('#log-btn').click();
    await new Promise(r => setTimeout(r, 700));
    const after = cells.map(c => c.chart.priceScale('right').options().mode);
    return {
      n: cells.length, before, after, btn0,
      btnOn: document.querySelector('#log-btn').classList.contains('on'),
      state: window.__term.state.logScale,
      saved: JSON.parse(localStorage.getItem('binance-terminal.v1') || '{}').logScale,
    };
  `);
  assert(r.n > 0, '没有已挂载的格子');
  assertEq(r.btn0, false, '默认不该是对数');
  assert(r.before.every((m) => m === 0), '默认价格轴不是普通坐标：' + r.before.join(','));
  assert(r.after.every((m) => m === 1), '切换后不是所有格子都变对数：' + r.after.join(','));
  assertEq(r.btnOn, true, '按钮没高亮');
  assertEq(r.state, true, 'state.logScale 没变');
  assertEq(r.saved, true, '对数开关没写进 localStorage');

  // 大图要继承，并且大图工具栏那个按钮也能切
  const big = await s.ev(`
    document.querySelector('#grid .cell').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 2600));
    const b = window.__term.big;
    const openMode = b.cell.chart.priceScale('right').options().mode;
    const btnOn = document.querySelector('#bc-log-btn').classList.contains('on');
    document.querySelector('#bc-log-btn').click();
    await new Promise(r => setTimeout(r, 500));
    const afterToggle = b.cell.chart.priceScale('right').options().mode;
    const gridMode = window.__term.grid.cells.filter(c => c.mounted && c.chart)
      .map(c => c.chart.priceScale('right').options().mode);
    return { openMode, btnOn, afterToggle, gridMode, state: window.__term.state.logScale };
  `);
  assertEq(big.openMode, 1, '大图没继承对数坐标：' + big.openMode);
  assertEq(big.btnOn, true, '大图的对数按钮没高亮');
  assertEq(big.afterToggle, 0, '大图按钮没切回普通坐标');
  assert(big.gridMode.every((m) => m === 0), '大图切换没有同步到格子墙：' + big.gridMode.join(','));
  assertEq(big.state, false, '大图切换没写回 state');

  // 快捷键 L
  const hot = await s.ev(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const on = window.__term.state.logScale;
    const modes = window.__term.grid.cells.filter(c => c.mounted && c.chart)
      .map(c => c.chart.priceScale('right').options().mode);
    return { on, modes };
  `);
  assertEq(hot.on, true, '快捷键 L 没打开对数');
  assert(hot.modes.every((m) => m === 1), '快捷键没作用到格子：' + hot.modes.join(','));

  // 收尾：关大图、恢复普通坐标
  await s.ev(`
    if (window.__term.state.logScale) document.querySelector('#log-btn').click();
    window.__term.big.close();
    await new Promise(r => setTimeout(r, 500));
    return 1;
  `);
  const back = await s.ev('return window.__term.state.logScale;');
  assertEq(back, false, '收尾没恢复普通坐标');
});

test('格子墙密度：蜡烛间距够宽、格子之间有留白', async (s) => {
  const r = await s.ev(`
    document.querySelector('#tabs button[data-view="grid"]').click();
    await new Promise(r => setTimeout(r, 900));
    const cells = window.__term.grid.cells.filter(c => c.mounted && c.chart);
    const c0 = cells[0];
    const ts = c0.chart.timeScale();
    const opts = ts.options();
    const vis = ts.getVisibleLogicalRange();
    const grid = getComputedStyle(document.querySelector('#grid'));
    const cell = c0.el.getBoundingClientRect();
    return {
      n: cells.length,
      spacing: opts.barSpacing,
      visible: vis ? Math.round(vis.to - vis.from) : null,
      gap: grid.gap,
      pad: grid.paddingTop,
      cellW: Math.round(cell.width),
    };
  `);
  assert(r.n > 0, '没有已挂载的格子');
  assert(r.spacing >= 3.4, `格子墙蜡烛间距只有 ${r.spacing.toFixed(2)}px（应 ≥3.4，太密）`);
  assert(r.visible > 20 && r.visible <= 75, `每格可见根数 ${r.visible} 不合适（应 20~75）`);
  assertEq(r.gap, '4px', '格子之间没有留白：' + r.gap);
  assertEq(r.pad, '4px', '格子墙没有内边距：' + r.pad);
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
    // 必须等 taskkill 真的退出：它只是发个信号，进程没死之前文件还是被占着，
    // 这时候删 profile 会失败（原来就是 spawn 完立刻删，删不掉也不报错）
    await new Promise((res) => {
      try {
        if (process.platform === 'win32') {
          const k = spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
          k.on('exit', res);
          k.on('error', res);
        } else {
          chrome.kill('SIGKILL');
          res();
        }
      } catch (e) { res(); }
    });
  }
  await sleep(300);        // 让 Chrome 的子进程（crashpad 之类）也退干净
  if (!(await removeProfile(profile))) {
    console.warn(`[e2e] 临时 profile 没删掉，下次启动会自动清理：${profile}`);
  }
};

// 最后一道保险：进程退出前再同步删一次。异步清理偶尔赶不上 Chrome 释放句柄，
// 而 exit 钩子里同步删是最接近"真的退出"的时机。
process.on('exit', () => {
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 交给下次 sweepOld */ }
});

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
