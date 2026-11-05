#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
查板块归类：某个币为什么没进板块？币安到底给了它什么标签？

    python tools/check_sectors.py           # 列出所有「有标签但没归上类」的币
    python tools/check_sectors.py PEPE      # 查单个币的完整链路
    python tools/check_sectors.py --stats   # 各板块覆盖数量

需要能访问 www.binance.com（server.py 会自动探测本机代理）。
"""

import json
import os
import sys
import collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import server as S            # noqa: E402
from sector_rules import TAG_MAP, SUB_MAP  # noqa: E402


def stats():
    S.load_sectors()
    S.load_regions()
    m = S.SECTORS["map"]
    c = collections.Counter()
    for keys in m.values():
        for k in keys:
            c[k] += 1
    print("板块覆盖（共 %d 个币种）：" % len(m))
    for k, n in c.most_common():
        print("  %-12s %4d" % (S.SECTORS["labels"].get(k, k), n))
    print("  未归类          %4d" % sum(1 for v in m.values() if not v))

    r = S.REGIONS["map"]
    rc = collections.Counter()
    for reg in r.values():
        for k in reg:
            rc[k] += 1
    print("\n股票市场细分（共 %d 个代码）：" % len(r))
    for k in (S.REGION_ORDER or ["US", "HK", "CN", "KR", "JP"]):
        print("  %-6s %4d" % (S.REGIONS["labels"].get(k, k), rc[k]))
    # 归成了 TradFi 但不在任何股票市场里的：多数是商品 / 指数 / 外汇 / Pre-IPO，
    # 本来就该没有市场归属。如果这里面出现了明显是股票的名字，才需要重建 regions.json。
    no_reg = [b for b, ks in m.items()
              if any(x in ("TRADFI", "PREIPO", "PREMARKET") for x in ks) and b not in r]
    if no_reg:
        print("\n  非股票类 TradFi %d 个（商品/指数/外汇/Pre-IPO，无市场归属属正常）："
              % len(no_reg))
        print("    " + "、".join(sorted(no_reg)))


def one(base):
    S.detect_proxy()
    S.load_sectors()
    S.load_regions()
    base = base.upper()
    print("查询 %s" % base)
    print("  当前分类:", S.SECTORS["map"].get(base) or "（未归类）")
    print("  股票市场:", S.REGIONS["map"].get(base) or "（不是股票类）")
    print("  中文名  :", S.stock_name(base) or "（没有）")

    keys, tags = S._fetch_spot_tags(base)
    print("  现货标签:", tags or "（接口没有返回）")
    print("  映射结果:", keys or "（标签都不在我们的映射表里）")
    if tags:
        unknown = [t for t in tags if t not in TAG_MAP]
        if unknown:
            print("  未映射的标签:", unknown, "← 需要的话加进 sector_rules.TAG_MAP")

    fut, reg = S._fetch_futures_subtypes([base])
    print("  合约归类:", fut.get(base) or "（exchangeInfo 里没有这个 base）")
    print("  合约市场:", reg.get(base) or "（exchangeInfo 没给股票类型）")


def unmapped():
    """列出「币安有标签、但没一个属于我们板块」的币 —— 通常不用管，
    除非币安新开了分类维度（那就要补 TAG_MAP）"""
    S.detect_proxy()
    S.load_sectors()
    with S.HUB.lock:
        syms = [x for x in S.HUB.tickers if "@" not in x]
    bases = sorted({S.split_symbol(x)[0] for x in syms} - {None})
    todo = [b for b in bases if b and b not in S.SECTORS["map"]]
    print("行情里有 %d 个 base，未归类 %d 个，逐个查标签..." % (len(bases), len(todo)))

    out = []
    for i in range(0, len(todo), 20):
        batch = todo[i:i + 20]
        for b, (keys, tags) in zip(batch, S._sector_pool.map(S._fetch_spot_tags, batch)):
            if tags and not keys:
                out.append((b, tags))
    out.sort()
    print("\n有标签但不属于任何板块的 %d 个：" % len(out))
    for b, tags in out:
        print("  %-10s %s" % (b, tags))
    if not out:
        print("  （没有）")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--stats":
        stats()
    elif arg:
        one(arg)
    else:
        unmapped()
