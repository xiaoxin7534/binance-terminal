# -*- coding: utf-8 -*-
"""股票市场细分：把 TradFi 里的股票类合约按「标的归属市场」分成
美股 / 港股 / A股 / 韩股 / 日股。

为什么不能直接抄币安：
  * 币安合约 exchangeInfo 的 underlyingType 是**挂牌地**，粒度只有
    EQUITY / HK_EQUITY / KR_EQUITY / CN_EQUITY 四种，且有两处明显标错：
      - ZHONGJI（中际旭创 300308，创业板）
      - GIGADEV（兆易创新 603986，沪市主板）
    这两家都没有 H 股，币安统一塞进了 HK_EQUITY。用户在港股里翻到它们
    只会困惑，所以这里改判成 A股。
  * 日股没有对应的 underlyingType（币安至今没上日股合约），只能拿 ADR /
    ETF 补：SONY 是索尼 ADR，EWJ 是 iShares 日本 ETF。

口径（按优先级）：
  1. underlyingType 给出挂牌市场 → 美股 / 港股 / A股 / 韩股
  2. REGION_FIX 里列出的覆盖掉第 1 步（修币安的错标）
  3. REGION_EXTRA 追加（补币安没有的市场）

一个标的最多可以属于两个市场（比如同时挂牌 A 股和 H 股的公司），
前端筛选是「包含」语义，和板块标签 r.sec 一致。
"""

# 市场 key -> 显示名（顺序即前端 chip 的顺序）
REGION_LABELS = {
    "US": "美股",
    "HK": "港股",
    "CN": "A股",
    "KR": "韩股",
    "JP": "日股",
}

REGION_ORDER = ["US", "HK", "CN", "KR", "JP"]

# 合约 underlyingType -> 市场
TYPE_TO_REGION = {
    "EQUITY": "US",
    "HK_EQUITY": "HK",
    "KR_EQUITY": "KR",
    "CN_EQUITY": "CN",
}

# 修正币安的错标：覆盖掉 underlyingType 推出来的结果
REGION_FIX = {
    # 中际旭创（光模块），深交所创业板 300308，无 H 股
    "ZHONGJI": ["CN"],
    # 兆易创新（存储/MCU），上交所主板 603986，无 H 股
    "GIGADEV": ["CN"],
}

# 追加：币安没有这个市场分类时用 ADR / ETF 补
REGION_EXTRA = {
    # 索尼集团 ADR（NYSE: SONY），美股时段交易，但标的是日本公司
    "SONY": ["JP"],
    # iShares MSCI Japan ETF
    "EWJ": ["JP"],
}

# 代码 -> 中文名。只收能确认的，宁可留空也不猜。
# 用途：列表行 hover 提示，让人一眼看出 ZHONGJI 是哪个公司。
NAMES = {
    # ---- 港股 ----
    "TENCENT": "腾讯控股",
    "HK0700": "腾讯控股",
    "HK0992": "联想集团",
    "HK1810": "小米集团",
    "HK0625": "港股 0625",
    "MEITUAN": "美团",
    "KUAISHOU": "快手",
    "POPMART": "泡泡玛特",
    "BYD": "比亚迪",
    "ZHIPU": "智谱",
    "MINIMAX": "稀宇科技",
    "CSOPSAMSUNG2L": "三星 2 倍做多 ETF",
    "CSOPSKHYNIX2L": "SK 海力士 2 倍做多 ETF",
    # ---- A 股 ----
    "ZHONGJI": "中际旭创",
    "GIGADEV": "兆易创新",
    "CXMT": "长鑫存储",
    "UNITREE": "宇树科技",
    # ---- 韩股 ----
    "SAMSUNG": "三星电子",
    "SAMSUNGEM": "三星电机",
    "SKHYNIX": "SK 海力士",
    "HYUNDAI": "现代汽车",
    "LGELECTRONICS": "LG 电子",
    "NAVER": "NAVER",
    "HANMI": "韩美药品",
    "KODEX200": "KOSPI200 ETF",
    # ---- 日股 ----
    "SONY": "索尼",
    "EWJ": "日本 ETF",
    # ---- 美股（只收常见的大票） ----
    "AAPL": "苹果",
    "MSFT": "微软",
    "NVDA": "英伟达",
    "TSLA": "特斯拉",
    "GOOGL": "谷歌",
    "AMZN": "亚马逊",
    "META": "Meta",
    "NFLX": "奈飞",
    "AVGO": "博通",
    "TSM": "台积电",
    "BABA": "阿里巴巴",
    "PDD": "拼多多",
    "AMD": "超威半导体",
    "INTC": "英特尔",
    "ORCL": "甲骨文",
    "CRM": "Salesforce",
    "COST": "好市多",
    "WMT": "沃尔玛",
    "JPM": "摩根大通",
    "GS": "高盛",
    "BAC": "美国银行",
    "XOM": "埃克森美孚",
    "LLY": "礼来",
    "UNH": "联合健康",
    "MCD": "麦当劳",
    "NKE": "耐克",
    "DIS": "迪士尼",
    "UBER": "Uber",
    "PLTR": "Palantir",
    "COIN": "Coinbase",
    "MSTR": "微策略",
    "HOOD": "Robinhood",
    "RDDT": "Reddit",
    "GME": "游戏驿站",
    "AMC": "AMC 院线",
    "SMCI": "超微电脑",
    "MU": "美光",
    "AMAT": "应用材料",
    "LRCX": "拉姆研究",
    "KLAC": "科磊",
    "ASML": "阿斯麦",
    "ARM": "Arm",
    "DELL": "戴尔",
    "IBM": "IBM",
    "CSCO": "思科",
    "QCOM": "高通",
    "TXN": "德州仪器",
    "PYPL": "PayPal",
    "SHOP": "Shopify",
    "MELI": "美客多",
    "NVO": "诺和诺德",
    "CRWD": "CrowdStrike",
    "PANW": "Palo Alto",
    "NOW": "ServiceNow",
    "ADBE": "Adobe",
    "SNOW": "Snowflake",
    "NET": "Cloudflare",
    "DDOG": "Datadog",
    "ZS": "Zscaler",
    "SPY": "标普 500 ETF",
    "QQQ": "纳指 100 ETF",
    "IWM": "罗素 2000 ETF",
    "TQQQ": "纳指 3 倍做多",
    "SQQQ": "纳指 3 倍做空",
    "SOXL": "半导体 3 倍做多",
    "SOXS": "半导体 3 倍做空",
    "SMH": "半导体 ETF",
    "GDX": "金矿 ETF",
    "XLE": "能源 ETF",
    "XBI": "生物科技 ETF",
}


def region_from_type(underlying_type):
    """underlyingType -> 市场 key（认不出来返回 None）"""
    return TYPE_TO_REGION.get(underlying_type)


def regions_of(base, underlying_type):
    """base + underlyingType -> 市场 key 列表（按 REGION_ORDER 排序）

    REGION_FIX 优先于 underlyingType（修错标），REGION_EXTRA 在其上追加。
    """
    hit = set()
    if base in REGION_FIX:
        hit.update(REGION_FIX[base])
    else:
        r = region_from_type(underlying_type)
        if r:
            hit.add(r)
    hit.update(REGION_EXTRA.get(base) or [])
    return [k for k in REGION_ORDER if k in hit]


def name_of(base):
    return NAMES.get(base, "")
