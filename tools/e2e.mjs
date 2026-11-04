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
