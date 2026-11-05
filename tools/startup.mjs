#!/usr/bin/env node
/**
 * 桌面版启动耗时（Windows，零依赖）
 *
 *   node tools/startup.mjs               测 dist/BinanceTerminal.exe
 *   node tools/startup.mjs --keep        测完不关（看现场）
 *   node tools/startup.mjs --dev         测开发版（python server.py，需要自己先起）
 *
 * 前提：8848 端口必须空闲（否则 exe 会检测到已有实例、只开窗口，测不到启动）。
 * 输出四个时间点：
 *   端口可用      —— /api/status 第一次 200
 *   窗口出现      —— 带 BinanceTerminal 配置的 Chrome 进程出现
 *   页面连上      —— /api/status 的 clients >= 1（SSE 建立，界面开始有数据）
 *   首屏有价      —— 可选：CDP 连不上真实窗口，这里用 clients 近似
 *
 * 注意：onefile 的 exe 会先解包（约 1.5s），这段时间在进程启动之后、
 * Python 代码之前，任何应用内日志都看不到，所以只能用外部轮询量。
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_PORT || 8848);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes('--keep');
const DEV = process.argv.includes('--dev');
const EXE = join(process.cwd(), 'dist', 'BinanceTerminal.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function status() {
  try {
    const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function hasWindowProcess() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Where-Object { $_.CommandLine -match \'BinanceTerminal\' } | Select-Object -First 1 -ExpandProperty ProcessId"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

async function main() {
  if (!DEV) {
    if (!existsSync(EXE)) throw new Error('没找到 dist/BinanceTerminal.exe，先跑 打包exe.bat');
  }
  const pre = await status();
  if (pre) {
    console.error(`\n[startup] ${BASE} 已经有服务在跑（clients=${pre.clients}）。`);
    console.error('          先关掉正在运行的看盘终端再测，否则量到的是"复用实例"。\n');
    process.exit(2);
  }

  console.log(`\n启动耗时（${DEV ? '开发版（需自行先启动 server.py）' : 'dist/BinanceTerminal.exe'}）\n`);
  const t0 = Date.now();
  let proc = null;
  if (!DEV) {
    proc = spawn(EXE, [], { stdio: 'ignore', detached: false });
  }

  let api = null;
  let win = null;
  let client = null;
  let lastWinCheck = 0;
  for (let i = 0; i < 900; i++) {
    await sleep(100);
    const st = await status();
    if (st && !api) api = Date.now() - t0;
    if (st && st.clients >= 1 && !client) client = Date.now() - t0;
    // 查 Chrome 命令行要起一个 PowerShell，很贵：1 秒查一次就够，
    // 每 100ms 查一次会把被测进程拖慢（实测能虚高 1 秒多）
    if (!win && Date.now() - lastWinCheck > 1000) {
      lastWinCheck = Date.now();
      if (hasWindowProcess()) win = Date.now() - t0;
    }
    if (api && win && client) break;
  }

  const fmt = (v) => (v == null ? '  超时/未测到' : `${String(v).padStart(5)} ms`);
  console.log(`  端口可用（/api/status）  ${fmt(api)}`);
  console.log(`  窗口出现（Chrome 进程）  ${fmt(win)}`);
  console.log(`  页面连上（clients>=1）   ${fmt(client)}`);
  if (api && win) console.log(`\n  —— 窗口比服务晚 ${win - api} ms；页面比窗口晚 ${client && win ? client - win : '?'} ms`);
  console.log('\n  参考：onefile 解包约 1.5s（进程启动后、Python 代码前，应用日志看不到）');
  console.log('        换 onedir 能省掉解包，但会从「一个 exe」变成「一个文件夹」\n');

  if (!KEEP && !DEV) {
    try { proc.kill(); } catch { /* ignore */ }
    // 窗口进程是独立的，需要一起收掉
    try {
      execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Where-Object { $_.CommandLine -match \'BinanceTerminal\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
        { stdio: 'ignore', timeout: 8000 });
    } catch { /* ignore */ }
    await sleep(800);
  }
}

main().catch((e) => { console.error('[startup] ' + e.message); process.exit(1); });
