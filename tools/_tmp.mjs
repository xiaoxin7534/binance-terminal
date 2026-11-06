/* 统一的临时目录：默认落在 D 盘，不占系统盘（C 盘）
 *
 * 这些脚本每次都要起一个全新的 Chrome profile（几十 MB），
 * 原来用 os.tmpdir()，在 Windows 上就是 C:\Users\<用户>\AppData\Local\Temp。
 * 现在统一放到 BTERM_CACHE（默认 D:/WorkBuddy AI/.cache）。
 * 想换位置就设环境变量：BTERM_CACHE=E:/tmp node tools/e2e.mjs
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_ROOT = 'D:/WorkBuddy AI/.cache';
const PREFIXES = ['e2e-', 'perf-', 'shot-'];
const MAX_AGE_MS = 6 * 3600 * 1000;

let cachedRoot = null;

/** 清掉上一次残留的 profile。
 *  进程被强杀（Ctrl+C、测试超时）时 rmSync 跑不到，profile 会越积越多——
 *  历史上 C 盘就这样堆了 921MB。这里按前缀 + 时间兜底。 */
function sweepOld(root) {
  let names = [];
  try { names = readdirSync(root); } catch (e) { return; }
  const now = Date.now();
  for (const n of names) {
    if (!PREFIXES.some((p) => n.startsWith(p))) continue;
    const full = join(root, n);
    try {
      if (now - statSync(full).mtimeMs < MAX_AGE_MS) continue;
      rmSync(full, { recursive: true, force: true });
    } catch (e) { /* Chrome 还占着文件，下次再说 */ }
  }
}

export function cacheRoot() {
  if (cachedRoot) return cachedRoot;
  const want = process.env.BTERM_CACHE || DEFAULT_ROOT;
  try {
    mkdirSync(want, { recursive: true });
    cachedRoot = want;
    sweepOld(want);
  } catch (e) {
    // D 盘不可写（换机器/权限不足）才退回系统临时目录，并且明说一声
    console.warn(`[cache] ${want} 不可写（${e.message}），本次退回系统临时目录 ${tmpdir()}`);
    cachedRoot = tmpdir();
  }
  return cachedRoot;
}

/** 建一个独立的临时 profile 目录，返回绝对路径 */
export function makeProfile(prefix) {
  return mkdtempSync(join(cacheRoot(), prefix));
}

/** 删 profile。Chrome 被 taskkill 之后还会占用文件一小会儿，必须重试；
 *  删不掉也不算错，下次启动 sweepOld() 会兜底。 */
export async function removeProfile(dir, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e) { /* 还被占着 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
