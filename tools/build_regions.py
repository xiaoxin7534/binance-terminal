#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
重建股票市场细分表（assets/data/regions.json）。

数据来源：
  1. 合约 /fapi/v1/exchangeInfo 的 underlyingType
     —— EQUITY / HK_EQUITY / KR_EQUITY / CN_EQUITY 直接对应 美股/港股/韩股/A股
  2. 现货 /bapi/asset/v1/public/asset-service/product/get-products 里
     tags 含 bStocks 的 token 化股票（代码形如 NVDAB = NVDA + B）
     —— 去掉尾字母 B 回查合约表；查不到的一律按美股算（bStocks 全是美股）
  3. stock_map.py 里的 REGION_FIX / REGION_EXTRA 修正币安的错标与缺口

用法：
    python tools/build_regions.py          # 直接覆盖 regions.json（会先备份）
    python tools/build_regions.py --dry    # 只看统计，不写文件

需要能访问 www.binance.com（本机 SOCKS5 代理，server.py 会自动探测）。
"""

import json
import os
import sys
import time
import collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import server  # noqa: E402  复用代理探测和请求封装
from stock_map import (  # noqa: E402
    REGION_LABELS, REGION_ORDER, NAMES, regions_of,
)

OUT = os.path.join(ROOT, "assets", "data", "regions.json")


def fetch_futures():
    """合约 -> {base: [region]}"""
    raw = json.loads(server.fapi_get("/fapi/v1/exchangeInfo", 40))
    out = {}
    for s in raw.get("symbols", []):
        if s.get("status") not in ("TRADING", "SETTLING"):
            continue
        base = s.get("baseAsset")
        if not base:
            continue
        reg = regions_of(base, s.get("underlyingType"))
        if reg:
            out[base] = reg
    return out


def fetch_bstocks(futures):
    """现货 token 化股票 -> {base: [region]}

    代码规则是「原代码 + B」：NVDAB / TSLAB / MSTRB。
    先按原样查合约表（BRKB 这种本身就以 B 结尾的正好命中），
    再去掉尾字母 B 查一次，都查不到按美股算。
    """
    status, data = server.https_via_socks(
        "www.binance.com",
        "/bapi/asset/v1/public/asset-service/product/get-products?includeEtf=true", 60)
    if status != 200:
        raise RuntimeError("get-products HTTP %d" % status)
    rows = json.loads(data).get("data") or []
    out, names = {}, {}
    for r in rows:
        if "bStocks" not in (r.get("tags") or []):
            continue
        base = r.get("b")
        if not base:
            continue
        reg = futures.get(base) or futures.get(base[:-1]) or ["US"]
        out[base] = reg
        an = (r.get("an") or "").split(" (")[0].split("（")[0].strip()
        if an and base not in NAMES:
            names[base] = an
    return out, names


def main():
    dry = "--dry" in sys.argv
    server.detect_proxy()
    if not server.SOCKS_PROXY:
        print("没有探测到本机代理，www.binance.com 走不通，先开代理再跑")
        return 1

    print("拉取合约 exchangeInfo ...")
    fut = fetch_futures()
    print("  合约带市场标签 %d 个" % len(fut))

    print("拉取现货 get-products ...")
    spot, names = fetch_bstocks(fut)
    print("  bStocks %d 个（其中 %d 个有英文名可补）" % (len(spot), len(names)))

    merged = dict(spot)
    merged.update(fut)          # 合约优先，现货只补合约没有的

    counts = collections.Counter()
    for reg in merged.values():
        for k in reg:
            counts[k] += 1
    print("\n各市场数量：")
    for k in REGION_ORDER:
        print("  %-6s %4d" % (REGION_LABELS[k], counts[k]))

    for k in ("HK", "CN", "KR", "JP"):
        items = sorted(b for b, rs in merged.items() if k in rs)
        print("%s 明细：%s" % (REGION_LABELS[k], "、".join(
            "%s(%s)" % (b, NAMES.get(b, "")) if NAMES.get(b) else b for b in items)))

    if dry:
        print("\n--dry：没有写文件")
        return 0

    if os.path.exists(OUT):
        bak = OUT + ".bak-%s" % time.strftime("%Y%m%d-%H%M%S")
        os.replace(OUT, bak)
        print("\n旧文件已备份 -> %s" % os.path.basename(bak))

    payload = {
        "labels": REGION_LABELS,
        "order": REGION_ORDER,
        "map": {k: v for k, v in sorted(merged.items())},
        "names": {k: v for k, v in sorted(names.items())},
        "meta": {
            "source": "binance exchangeInfo underlyingType + bStocks spot tokens",
            "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "bases": len(merged),
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print("已写入 %s（%d 个代码）" % (OUT, len(merged)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
