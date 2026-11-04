#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用币安官方数据重建板块分类表（assets/data/sectors.json）。

数据来源（都是币安自己的分类，不是猜的）：
  1. 合约 /fapi/v1/exchangeInfo 的 underlyingType / underlyingSubType
     —— 币安合约页的板块标签就来自这里（AI / Meme / Layer-1 / Pre-IPO / Chinese ...）
  2. 现货 /bapi/asset/v1/public/asset-service/product/get-products 的 tags
     —— 只有现货没有合约的币，用这里的标签补（AI / Meme / defi / bStocks ...）

用法：
    python tools/build_sectors.py          # 直接覆盖 sectors.json（会先备份）
    python tools/build_sectors.py --dry    # 只看统计，不写文件

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

OUT = os.path.join(ROOT, "assets", "data", "sectors.json")

# 我们的板块 key -> 中文名
LABELS = {
    "AI": "AI",
    "L1": "Layer-1",
    "L2": "Layer-2",
    "RWA": "RWA",
    "GAME": "Gaming",
    "MEME": "Meme",
    "INFRA": "基础服务",
    "DEFI": "DeFi",
    "META": "元宇宙",
    "TRADFI": "TradFi",
    "CHINESE": "Chinese",
    "PREIPO": "Pre-IPO",
    "PREMARKET": "Pre-Market",
}

# 合约 underlyingSubType -> 我们的 key
SUB_MAP = {
    "AI": "AI",
    "Meme": "MEME",
    "DeFi": "DEFI",
    "Layer-1": "L1",
    "Layer-2": "L2",
    "Gaming": "GAME",
    "Metaverse": "META",
    "RWA": "RWA",
    "Infrastructure": "INFRA",
    "Chinese": "CHINESE",
    "Pre-IPO": "PREIPO",
    "Pre-Market": "PREMARKET",
    "TradFi": "TRADFI",
}

# 现货 tags -> 我们的 key（Layer1_Layer2 合并的，只能归到 L1）
TAG_MAP = {
    "AI": "AI",
    "Meme": "MEME",
    "defi": "DEFI",
    "Layer1_Layer2": "L1",
    "Gaming": "GAME",
    "Metaverse": "META",
    "RWA": "RWA",
    "Infrastructure": "INFRA",
    "bStocks": "TRADFI",
    "tCommodities": "TRADFI",
}

# 合约 underlyingType -> 兜底 key
TYPE_MAP = {
    "EQUITY": "TRADFI",
    "HK_EQUITY": "TRADFI",
    "KR_EQUITY": "TRADFI",
    "CN_EQUITY": "TRADFI",
    "COMMODITY": "TRADFI",
    "INDEX": "TRADFI",
    "FX": "TRADFI",
    "PREMARKET": "PREIPO",
}

ORDER = ["AI", "L1", "L2", "RWA", "GAME", "MEME", "INFRA", "DEFI", "META",
         "TRADFI", "PREIPO", "PREMARKET", "CHINESE"]


def fetch_futures():
    raw = json.loads(server.fapi_get("/fapi/v1/exchangeInfo", 40))
    out = {}
    for s in raw.get("symbols", []):
        if s.get("status") not in ("TRADING", "SETTLING"):
            continue
        base = s.get("baseAsset")
        if not base:
            continue
        keys = out.setdefault(base, set())
        for t in (s.get("underlyingSubType") or []):
            k = SUB_MAP.get(t)
            if k:
                keys.add(k)
        k = TYPE_MAP.get(s.get("underlyingType"))
        if k:
            keys.add(k)
    return out


def fetch_spot():
    status, data = server.https_via_socks(
        "www.binance.com",
        "/bapi/asset/v1/public/asset-service/product/get-products?includeEtf=true", 45)
    if status != 200:
        raise RuntimeError("get-products HTTP %d" % status)
    rows = json.loads(data).get("data") or []
    out = {}
    for r in rows:
        if r.get("st") not in ("TRADING", "BREAK"):
            continue
        base = r.get("b")
        if not base:
            continue
        keys = out.setdefault(base, set())
        for t in (r.get("tags") or []):
            k = TAG_MAP.get(t)
            if k:
                keys.add(k)
    return out


def main():
    dry = "--dry" in sys.argv
    server.detect_proxy()
    if not server.SOCKS_PROXY:
        print("没有探测到本机代理，www.binance.com 走不通，先开代理再跑")
        return 1

    print("拉取合约 exchangeInfo ...")
    fut = fetch_futures()
    print("  %d 个 base，带板块 %d 个" % (len(fut), sum(1 for v in fut.values() if v)))

    print("拉取现货 get-products ...")
    spot = fetch_spot()
    print("  %d 个 base，带板块 %d 个" % (len(spot), sum(1 for v in spot.values() if v)))

    merged = collections.defaultdict(set)
    for src in (spot, fut):
        for base, keys in src.items():
            merged[base] |= keys

    sector_map = {}
    for base, keys in merged.items():
        ordered = [k for k in ORDER if k in keys]
        if ordered:
            sector_map[base] = ordered

    counts = collections.Counter()
    for keys in sector_map.values():
        for k in keys:
            counts[k] += 1
    print("\n各板块数量：")
    for k in ORDER:
        print("  %-10s %4d" % (LABELS[k], counts[k]))

    print("\nPre-IPO 明细：", sorted(b for b, ks in sector_map.items() if "PREIPO" in ks))
    print("Pre-Market 明细：", sorted(b for b, ks in sector_map.items() if "PREMARKET" in ks))
    print("Chinese 明细：", sorted(b for b, ks in sector_map.items() if "CHINESE" in ks))

    if dry:
        print("\n--dry：没有写文件")
        return 0

    if os.path.exists(OUT):
        bak = OUT + ".bak-%s" % time.strftime("%Y%m%d-%H%M%S")
        os.replace(OUT, bak)
        print("\n旧文件已备份 -> %s" % os.path.basename(bak))

    payload = {
        "labels": LABELS,
        "map": {k: v for k, v in sorted(sector_map.items())},
        "meta": {
            "source": "binance exchangeInfo underlyingSubType + asset-service tags",
            "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "bases": len(sector_map),
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print("已写入 %s（%d 个代码）" % (OUT, len(sector_map)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
