#!/usr/bin/env node
/**
 * 界面截图（零依赖，Node 18+）—— 改 UI 前后各跑一次，肉眼对比
 *
 *   node tools/shots.mjs             存到 .shots/<时间戳>/
 *   node tools/shots.mjs before      存到 .shots/before/
 *   node tools/shots.mjs --headed    显示窗口
 *   node tools/shots.mjs --only=list 只截某个状态（grid/list/big/detail）
 *
 * 前提：本地服务已经跑起来（python server.py），默认 8848。
 * 默认 1600x900 视口 + 独立 user-data-dir，保证每次截图条件一致。
 * 想看别的宽度：SHOT_W=1366 SHOT_H=768 node tools/shots.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8848';
const W = Number(process.env.SHOT_W || 1600);
const H = Number(process.env.SHOT_H || 900);
const CDP_PORT = Number(process.env.SHOT_CDP_PORT || 9666);
const HEADED = process.argv.includes('--headed');
const args = process.argv.slice(2);
const tagArg = args.find((a) => !a.startsWith('-'));
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const TAG = tagArg || new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const OUT = join(process.cwd(), '.shots', TAG);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
}

async function main() {
  if (!CHROME) throw new Error('没找到 Chrome / Edge');
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'bt-shot-'));
  const proc = spawn(CHROME, [
    HEADED ? `--window-size=${W},${H}` : '--headless=new',
    // 不能用 --disable-gpu：lightweight-charts 的多层 canvas 会截出黑块
    // （详情面板的迷你走势图曾经整块发黑，其实是这个参数造成的假象）
    '--use-angle=swiftshader',
    '--hide-scrollbars', `--window-size=${W},${H}`,
    '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) break;
      } catch { /* 等 */ }
    }
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new Session(ws);

    await s.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });
    await s.send('Page.navigate', { url: BASE + '/' });
    // 等 8 个格子都有 K 线，截图才不会拍到半空的图
    for (let i = 0; i < 200; i++) {
      const ok = await s.ev(`
        const g = window.__term && window.__term.grid;
        return !!(g && g.cells.length && g.cells.every(c => c.times && c.times.length > 50));
      `).catch(() => false);
      if (ok) break;
      await sleep(100);
    }
    await sleep(800);

    const shoot = async (name) => {
      const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = join(OUT, name + '.png');
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log('  ' + file);
    };

    const want = (n) => !only || only.split(',').includes(n);
    const setTheme = async (t) => {
      const cur = await s.ev('return document.documentElement.dataset.theme || "light"');
      if (cur !== t) {
        await s.ev(`document.querySelector('#btn-theme').click(); await new Promise(r=>setTimeout(r,500)); return 1;`);
      }
    };

    if (want('grid')) {
      await setTheme('light');
      await shoot('grid-light');
      await setTheme('dark');
      await shoot('grid-dark');
    }

    if (want('list')) {
      await s.ev(`
        document.querySelector('#tabs button[data-view="list"]').click();
        await new Promise(r=>setTimeout(r,1200));
        const row = document.querySelector('.tbody-inner .row');
        if (row) row.click();
        await new Promise(r=>setTimeout(r,3500));
        return 1;
      `);
      await setTheme('light');
      await shoot('list-light');
      await setTheme('dark');
      await shoot('list-dark');
    }

    if (want('big')) {
      await s.ev(`
        document.querySelector('#tabs button[data-view="grid"]').click();
        await new Promise(r=>setTimeout(r,400));
        window.__term.big.open('BTCUSDT@f','5m');
        await new Promise(r=>setTimeout(r,4000));
        return 1;
      `);
      await setTheme('light');
      await shoot('big-light');
      await setTheme('dark');
      await shoot('big-dark');
      await s.ev(`window.__term.big.close(); await new Promise(r=>setTimeout(r,400)); return 1;`);
    }

    if (want('detail')) {
      await setTheme('light');
      await s.ev(`
        document.querySelector('#tabs button[data-view="list"]').click();
        await new Promise(r=>setTimeout(r,600));
        return 1;
      `);
      await shoot('list-wide');
    }
  } finally {
    proc.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log('');
}

main().catch((e) => { console.error('[shots] ' + e.message); process.exit(1); });
