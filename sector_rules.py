# -*- coding: utf-8 -*-
"""板块分类规则：币安官方标签 -> 本项目的板块 key

server.py（运行时增量归类）和 tools/build_sectors.py（全量重建）共用这份表，
避免两处各写一份、改一处忘另一处。

数据来源都是币安自己的分类，不是猜的：
  1. 合约 /fapi/v1/exchangeInfo 的 underlyingType / underlyingSubType
  2. 现货 /bapi/asset/v1/public/asset-service/product/get-products 的 tags
"""

# 板块 key -> 显示名（顺序即前端 chip 的顺序）
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

ORDER = ["AI", "L1", "L2", "RWA", "GAME", "MEME", "INFRA", "DEFI", "META",
         "TRADFI", "PREIPO", "PREMARKET", "CHINESE"]

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

# 现货 tags -> 我们的 key（币安把 Layer1/Layer2 合成一个 tag，只能归到 L1）
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

# 合约 underlyingType -> 兜底 key（股票/商品/指数/外汇类合约都算 TradFi）
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


def keys_from_tags(tags):
    """现货 tags -> 板块 key 列表（按 ORDER 排序、去重）"""
    hit = {TAG_MAP[t] for t in (tags or []) if t in TAG_MAP}
    return [k for k in ORDER if k in hit]


def keys_from_futures(subtypes, underlying_type=None):
    """合约 underlyingSubType + underlyingType -> 板块 key 列表"""
    hit = {SUB_MAP[t] for t in (subtypes or []) if t in SUB_MAP}
    k = TYPE_MAP.get(underlying_type)
    if k:
        hit.add(k)
    return [k for k in ORDER if k in hit]
