# 项目交接文档 · 币安本地看盘终端

> 这份文档写给"下一个接手的人（或 AI）"，读完应该能立刻上手改代码。
> 最后更新：2026-11-05 16:05

---

## 一句话定位

跑在用户自己电脑上的币安看盘工具，对标 moomoo 的「多品种同列 + 行情列表 + 单图大图」。
涨跌配色按**美国模式（绿涨红跌）**。
纯本地、只读行情、不下单。现货 + 合约共 **1800+ 个交易对**实时推送。
可以打包成 8MB 的桌面 exe，双击即用，关窗即退。

---

## 接续须知（2026-11-04 21:45）

**做到哪了**：功能已完整，当天做了 14 轮迭代。第 14 轮是「一次把能改的都改了」：
合约盘口改走 WebSocket（4 秒轮询 → 100ms 实时）、大图增强（左右键翻品种 / 盘口栏 / 绘图拖动 / 撤销）、
永续扫描器、资金费率告警、持仓量叠加、多空比历史、板块平均涨跌幅、快捷键面板，
外加 git 版本控制 + E2E 回归脚本 + 把 Cell 从 grid.js 拆出来。exe 已打包验证过。

**改代码前先看**：本文档「数据链路」「K 线缓存」「长墙的虚拟化」「板块分类」
「多品种同列的详情侧板」「大图模式」「涨跌配色」七节，都是踩过坑才写对的，别凭直觉改。

**改完必须跑**：`node tools/e2e.mjs`（24 个用例，约 2 分钟）。服务要先跑起来。
这套脚本是第 14 轮加的，覆盖页面加载、配色、两个视图、大图全流程、绘图、扫描器、告警、持仓量。

**想知道慢在哪**：`node tools/perf.mjs`（第 15 轮加，只量耗时不断言，冷启动口径）。
先跑 perf 再谈优化，别凭感觉。

**改界面前后必须截图**：`node tools/shots.mjs before` / `after`
（第 16 轮加）。截图脚本**不能带 `--disable-gpu`**，否则 canvas 会截成黑块，
详见「界面观感 + 流畅度」那节。

**已知可继续的方向**：
1. 自选分组（多个 watchlist）
2. TradFi 下面再拆「美股 / 港股 / 商品 / 指数」（官方 `underlyingType` 里有数据）
3. 详情侧板 / 大图盘口栏支持拖动调宽
4. 绘图再加：文本标注、射线、水平射线
5. 告警加系统托盘通知（现在只有页面内提示 + 声音）
6. 爆量监控（1 分钟成交额 / 20 分钟均量），现在只有「涨速」列

**备份**：`backup/2026-11-04_*/` 每轮改动前的快照；旧手写板块表在
`backup/sectors-handmade-2026-11-04.json`。

---

## 怎么跑

**桌面版**：双击 `dist/BinanceTerminal.exe`（关窗即退出）
**开发版**：双击 `启动看盘.bat`，或 `python server.py --open`

```bash
# 改完代码重新打包
双击 打包exe.bat          # 产物 dist/BinanceTerminal.exe
双击 创建桌面快捷方式.bat   # 可选
```

浏览器打开 <http://127.0.0.1:8848/>。只用 Python 标准库，**零依赖，不需要 pip install**。

---

## 数据链路（这部分最关键，别改错）

```
浏览器 ──HTTP/SSE──> 本地 Python (8848) ──┬─> data-api.binance.vision      现货 REST（直连，快）
                                          ├─> data-stream.binance.vision   现货 WS（直连）
                                          ├─> www.binance.com/fapi/...     合约 REST（走本机 SOCKS5）
                                          └─> fstream.binance.com/market/stream  合约 WS（走本机 SOCKS5）
```

### ★ 三个非显然的坑（踩了很久才找到）

**1. 币安合约 API 要走 www 域名，不是 fapi 域名**

| 地址 | 结果 |
|---|---|
| `fapi.binance.com/fapi/v1/klines` | **451 受限地区**（直连还 DNS 污染） |
| `www.binance.com/fapi/v1/klines` | **200 ✅** |

同一套合约 API，币安在 www 域名下也挂了一份给网页版用，那条链路不检查地区。
怎么发现的：用 Playwright 打开币安合约页面抓包，发现它请求的是 `www.binance.com/fapi/...`。

**2. 合约 WebSocket 要走 `/market/stream`**

- `wss://fstream.binance.com/stream` → 握手 101 成功，但**一个数据帧都收不到**
- `wss://fstream.binance.com/market/stream` → **正常推全市场 ticker**

这条网关只挂了部分流（ticker / kline / aggTrade），**没有 depth**，见下文「合约流的能力边界」。

**3. 现货必须走 `.vision` 域名**

`api.binance.com` / `stream.binance.com` 在国内被 DNS 污染 + IP 封锁。
币安给受限地区开了 `data-api.binance.vision` / `data-stream.binance.vision`，只提供现货行情。

### 代理

合约接口必须走代理。`server.py` 的 `detect_proxy()` 自动探测本机 SOCKS5
（10808/1080/7890/7891/10809/2080/20171），用户机器上是 **127.0.0.1:10808（v2rayN）**。

合约流量走代理、现货走直连——**不要把所有流量都塞进代理**，现货直连更快。

### 另一个坑：币安 WS 订阅限流

**5 条消息/秒**，超了直接断连。分批订阅的间隔必须 ≥ 260ms，每批 ≤ 100 个流。
曾经改成 120ms 导致连接每 2 秒断一次。

---

## 界面结构（2026-11-04 晚重做）

```
┌─────────────────────────────────────────────────────┐
│ 顶栏  侧栏开关 | 品牌 | 多品种同列/行情列表 | 连接 | 主题│
├────────┬────────────────────────────────────────────┤
│ 自选栏  │ 工具栏（布局/板块/行数/周期/指标/联动/详情）    │
│ 自选 N  │────────────────────────────────────────────│
│ 热门 14 │ 多品种同列 ────────────┬── 详情侧板（可开关） │
└────────┴────────────────────────┴───────────────────┘
```

- **左侧自选栏**（218px，`[` 或顶栏按钮收起）：自选组 + 热门组（按成交额，
  与自选同 base 的自动跳过）。点一下 = 选中，双击 = 直接填进当前聚焦的图表格子
- **多品种同列 · 选中**：单击格子选中（1.5px 蓝框 + 代码前小蓝点 + 代码变蓝），
  方向键在格子间移动，`Enter` 或双击进大图，`Esc` 返回。
  **不要给整个表头铺蓝底**——试过，一片浅蓝很难看，已回退
- **列表列自适应**：容器变窄时按优先级自动砍列（先砍振幅/均价/成交量…），
  保证每列都读得清；列数变化时会重建表头，不会错位
- 涨跌幅保持纯色胶囊标签（试过加背景条，和胶囊叠在一起出现双层色块，已删）

## 已实现的功能

### 多品种同列（按 `1`，原「图表墙」）
- 布局：1×1 / 1×2 / 2×2 / 3×2 / 4×2 / 3×3 / **4×3（12 图）/ 4×4（16 图）**
- 每格独立选币、独立周期（**分时**/1m/5m/15m/1h/4h/1d）
- 均线 **MA5 / MA52 / MA200 + EMA200**（EMA200 虚线区分），BOLL、成交量、MACD
- 拖动/缩放任意一张图，其余同步；十字光标同步
- **加载完自动取景**：K 线铺满格子宽度、最后一根贴右（`fitRange()`），窗口/布局变化会重新取景
- **行数**（工具栏「行数」）：跟随布局 / 3·4·6·8·12·20 行 / **全部品种**
  选「全部品种」时按当前筛选（现货/永续 + 页签 + 板块）铺满，最多 400 格，按成交额排序
- **纵向滚动**：行高保底 220px，内容超出一屏就有 10px 滚动条，滚轮直接滚整面墙
- **滚轮行为**：墙能滚时滚轮滚墙；按住 `Ctrl` 滚轮才缩放单张图
  （lightweight-charts 默认吃掉 wheel 做缩放，不拦截的话鼠标放在图上永远滚不动）
- **虚拟化**：只有视野 ±2 行内的格子会真正挂载图表，其余只留格子外壳。
  400 格的长墙实际同时只有 20~32 张图在跑，内存和帧率都稳
- **板块切换**：工具栏「板块」按钮，菜单按「现货 / 永续」分组，一键把格子填满某分类
- **从列表切过来时自动继承列表的筛选 + 排序**（`switchView('grid')` 里比较签名）
- 列表里双击一行 = 直接进大图（`list.js` 优先走 `ctx.onOpenBig`，没有再退回 `onOpenInGrid`）
- **右侧详情侧板**（工具栏「详情」开关 / 按 `D` / 面板右上角 `×` / `Esc`）：
  停靠一块和列表页完全一样的详情面板，跟着当前聚焦的格子走——点格子、方向键、
  在格子里用表头下拉换币都会同步。默认**关闭**：4×2 布局下开着会把每格从 340px 压到 263px，
  窄格子按容器查询规则会少显示「额 / 费」两项

### 大图模式（双击格子 / 双击列表行 / `Enter`）

整屏看一个品种。**图表本体不是新写的**——`bigchart.js` 直接 `new Cell(stubView, 0)`，
用 `detached: true` 让 Cell 跳过 `state.cells` 写入，其余（指标、分时、K线缓存、实时增量、
主题、取景）全部复用。所以改 Cell 的时候大图会自动跟着变，别在大图里重复实现一套。

入口三个：格子里双击、列表里双击某一行、选中格子按 `Enter`。`state.view` 不变，
所以从列表进来关掉后回列表、从格子进来关掉后回墙面。

结构：`.bc-bar`（币种/现价/周期/指标/绘图工具）→ `.bc-info`（十字光标 OHLC 明细行）→
`.bc-body`（里面挂 `cell.el`，`.cell-head` 和 `.cell-tools` 被 CSS 隐藏）。

**绘图**是自己在 `.chart-host` 上叠一层 canvas（`.bc-draw-layer`，`pointer-events:none`）：

| 工具 | 存的数据 | 画法 |
|---|---|---|
| 趋势线 | 两点 `{t, p}` | 直线 |
| 水平线 | 一点（`p2` 忽略） | 全宽横线 + 右侧价格标签 |
| 矩形 | 两点 | 半透明填充 + 描边 |
| 斐波那契 | 两点 | 0/0.236/0.382/0.5/0.618/0.786/1 七条虚线 + 价格标签 |

几个关键点：

1. **坐标换算**：`timeScale().timeToCoordinate(t)` + `series.priceToCoordinate(p)`，
   反算是 `coordinateToTime(x)` + `coordinateToPrice(y)`。**点下去的位置一定落在某根 K 线上**
   （`coordinateToTime` 返回最近的 bar time），所以存 time 而不是 logical index——换周期/重载后还能还原。
2. **重绘时机**：`timeScale().subscribeVisibleLogicalRangeChange` + `ResizeObserver` + 每次数据更新，
   统一走 `schedule()` 里的 rAF 节流。**不要**用 setInterval 重绘，缩放时坐标是连续变的。
3. **绘图模式下要吃掉指针事件**：在 `.chart-host` 上用 **capture** 阶段监听 `pointerdown/move/up`，
   `preventDefault + stopPropagation`，否则 lightweight-charts 会同时把图拖走。
   光标模式（`tool=null`）不拦截，只额外挂一个 `click` 做命中测试。
4. **命中测试**按屏幕坐标算：线段用点到线段距离 < 6px，矩形看四条边，斐波那契看七条水平线。
5. **存储 key = `symbol|interval`**。跨周期共享做不到：`timeToCoordinate` 对不在序列里的时间
   返回 null，1m 上画的线到 1h 根本算不出 x。
6. **图元必须能在图表重建后存活**：`bindChart()` 里用 `boundChart` 记住当前 chart 实例，
   换周期导致 `unmountChart()/mount()` 之后要重挂订阅。
7. **OHLC 明细**：`subscribeCrosshairMove` 里用 `cell.timeIdx(param.time)` 拿到索引再读 `cell.bars[i]`；
   鼠标移开（`param.time == null`）回到最后一根。首次加载时靠 `subscribeVisibleLogicalRangeChange`
   补一次，否则要等鼠标动才有内容。

### 大图模式的三个附加面板

| 面板 | 入口 | 说明 |
|---|---|---|
| 右侧盘口栏 | 工具栏「盘口」 | 复用列表页那块 `DetailPanel`（第三个实例），宽 320px，关掉后图表自动变宽 |
| 持仓量叠加 | 工具栏「持仓量」 | 只在永续可用。曲线画在**独立的 pane 2**（88px），不跟价格轴和成交量抢空间 |
| 绘图编辑 | 光标模式下拖端点 | 拖 p1/p2 改形状，水平线整体平移；`Ctrl+Z` 撤销（最多 40 步） |

**OI 叠加的实现注意**：`addSeries(..., 2)` 会自动建 pane 2，但 `setHeight` 是异步生效的，
必须延时 260ms 再设（和 MACD 的 pane 1 同一个坑）。换周期会重建 chart，`applyOI()` 要重挂。

### 永续扫描器（工具栏「扫描器」）

791 个合约排一张表：资金费率 / 年化（×3×365）/ 距结算 / 基差 / 标记价 / 24h 涨跌 / 成交额。
数据全来自 `/api/market`（第 14 轮给 perp 行补了 `mp`/`ip`），**不需要额外接口**，1.5 秒重排一次。
基差 = 标记价 / 同 base 现货价 - 1，所以只有存在现货对的合约才有值（TradFi 代币大多没有）。

### 资金费率告警（工具栏「告警」）

阈值是**绝对值**，默认 0.05%（常规 0.01%）。命中后：顶部提示 + 两声蜂鸣（Web Audio，无音频文件）+ 进列表。

**关键设计：只报「从低于阈值变成高于阈值」的合约**。开启或改阈值时会把当前所有超标的记成基线，
之后只报新增——否则一开就刷 700 条。`baseline` 是内存态，刷新页面会重新建立。

### 行情列表（按 `2`）
- **两级分类**：一级 `全部 / 现货 / 永续`（`state.mkt`），二级页签
  全部 / 自选 / 新币上线 / Crypto / TradFi / Pre-IPO / Pre-Market / USDC / Chinese
- 板块 chip 行：AI / Layer-1 / RWA / Layer-2 / Gaming / Meme / 基础服务 / DeFi / 元宇宙 / TradFi / Chinese
  （数量按当前一级分类统计，切到永续后 AI 只剩 16 个）
- **列可拖动排序**（HTML5 DnD，币种列锁定最左），顺序存 localStorage
- 12 列：币种 / 最新价 / 涨跌幅 / 涨跌额 / **涨速(1m)** / **资金费率** / 24h高 / 24h低 / 成交额 / 成交量 / 均价 / 振幅
- 虚拟滚动，1600+ 行不卡
- 右侧详情：迷你走势、24h 统计、板块标签、实时盘口 20 档、逐笔成交
- 同一币种同一市场类型只留成交额最大的计价对（BTC 现货 / BTC 永续各一行）

### 详情面板排版（2026-11-04 晚重排）
- 头部 14px 内边距、价格 26px，标签改成无边框淡底
- 迷你走势 92→84px，左上角加「近 2 小时」小标签（`color-mix` 半透明底，压得住曲线）
- 分区 padding 10→12px，标题字距 .6→.8px，`kv-grid` 列间距 14→20px、行距 6→8px
- 持仓量不再带币种后缀（标题里已有），基差 |x|<0.005% 用中性色而不是绿/红
- 费率历史加「资金费率历史 / 近 9 次结算」小标题，柱高改用 **0.55 次幂**缩放
  （费率多在 0.01% 附近，线性缩放会全变成一条细线）
- 盘口/成交行高 17→18px，深度条透明度 .13→.18
- **盘口默认 8 档（4 卖 + 4 买），标题右侧「8 档 ▾」可展开到 20 档（10+10）**。
  20 档全铺会把「最近成交」整个顶出可视区；档位开关是面板本地状态，不落 localStorage

### 分时图
- 周期条第一项「分时」：本地当天 00:00 到现在的 1 分钟收盘价连线
- 用 `BaselineSeries`，基准线 = **今日开盘价**，高于基准红、低于基准绿，横轴整天铺满
- 图例显示「今开 xxx +x.xx%」（相对今开，和表头的 24h 涨跌幅不是一回事）
- 分时不画均线/BOLL/MACD（`hasMacd=false`），只有价格线和成交量
- 实现要点：
  - 数据走 `/api/intraday`，服务端按本地零点分段拉 1m K 线（单次上限 1000 根，一天要 2 段）
  - 小格子里 1440 个点会糊成毛边，按宽度抽样（步长取 1/2/3/5/6/10/12/15/20/30/60 分钟）
  - 抽样后可视区间要按「抽样槽位数」算，不能还写 1440，否则整条线会缩成左边一根竖条
  - 横轴 `tickMarkFormatter` 固定返回 HH:MM，否则会出现 11/04 这种日期刻度
  - 分时和 K 线是两种 series，切换时必须 `unmountChart()` + `mount()` 重建
  - 订阅要落回 1m 流（`wsInterval()`），联动时跳过不同类型的格子

### K 线缓存（性能）
- 服务端 `KLINES` 内存表，key = `s:BTCUSDT|1m` / `f:BTCUSDT@1m`
- 命中且未过期直接返回（**30 秒 ~ 5 分钟，周期越大越久**：`ttl = max(30, min(300, step/2000))`）
- 过期则**只补最近几根**（`startTime=最后一根的开盘时间`），按开盘时间合并覆盖
- 落后超过 `limit` 根就整段重拉；网络失败时用旧缓存兜底，不白屏
- 落盘 `cache/klines.json`（120 秒一次，最多 240 条序列），重启后直接载入
- 前端 `KL_CACHE` 30 秒内直接复用，连 `/api/klines` 都不打

实测（8 图整墙从打开到出图）：缓存命中 ~0.45s，需增量 ~2.6~4s（网络抖动大，
Binance 单请求 RTT 0.5~5s 波动，这个没法优化，只能靠缓存少打）

### 列表排序
`computeRows` 的排序比较器要处理三种情况：
1. `chg`（涨跌额）**没有现成字段**，得用 `l - o` 现算——之前直接 `a['chg']` 拿到 undefined，
   所有行都等于 0，点表头完全不动（这就是"有些类目失灵"）
2. `amp`（振幅）同理，`(h - lo) / o * 100`
3. 缺值行（现货没有资金费率）不管升序降序都沉底，不能 `?? 0` 混在中间

列宽不够时按优先级砍列，`amp` 的优先级要高于 `lo`/`v`/`wavg`——振幅是常用排序维度。

### 合约衍生指标（永续专属）
- 列表「资金费率」列：现货行留 `--`，永续行显示**当前预测费率**（结算前随溢价指数变动），正红负绿
- 详情面板「合约数据」块：资金费率、**下次结算倒计时（每秒走）**、持仓量、持仓价值、
  标记价、基差（标记价/指数价-1）、多空账户比（红绿条）、近 9 次结算的费率柱
- 每格头部多一项「费 +0.0100%」，格宽 < 460px 时自动隐藏
- 选币弹层给永续加「永续」小标签，避免 BTCUSDT 现货/永续两条看起来一样

### 其他
- 深浅色切换（`T`）、搜索（`/`）、状态持久化（localStorage）
- 快捷键：`1`/`2` 切视图、`[` 收放自选栏、方向键选格子、`Enter`/双击进大图、`D` 开关详情侧板、
  `Esc` 退出大图 / 收起详情、大图里 `Delete` 删图元、`V` 回光标
- 断线自动重连，重连后静默补 K 线
- 启动预热：拉一次全量 24h 快照（gzip 282KB/8.5s），冷门币和 USDC 对立刻可见
- 合约图表实时更新：`FuturesWorker` 动态订阅合约 K 线 + aggTrade
  （之前把 `btcusdt@f@kline_1m` 发到了现货流，是非法流名，等于合约图是静态的）

---

## 桌面封装（2026-11-04 晚）

用 **PyInstaller onefile + Chrome/Edge `--app` 模式**，不引入任何运行时依赖：

```
desktop.py  ──┬─ 起 server.build_server()（后台线程）
              ├─ 找 Chrome/Edge，用 --app= 开一个无地址栏窗口
              │  （独立 user-data-dir，避免和你日常浏览器抢实例）
              └─ proc.wait()：窗口一关，进程退出，服务随之结束
```

几个必须知道的点：

1. **路径**：打包后 `sys.frozen=True`，静态资源在 `sys._MEIPASS`（只读），
   缓存改写到 `%LOCALAPPDATA%\BinanceTerminal\cache`，否则每次启动都要重攒行情
2. **无控制台**：`--noconsole` 下 `sys.stdout` 是 `None`，`print()` 会抛异常。
   `desktop.py` 一进来就把 stdout/stderr 接到 `app.log`
3. **单实例**：先探 `/api/status`，已有实例在跑就只开窗口、不接管服务
4. **崩溃可见**：顶层 try/except 弹 MessageBox 并指到日志路径，否则双击没反应会很难查
5. **构建环境**：`build/.venv`（PyInstaller 装在里面，不污染系统 Python），
   45MB，删了下次打包会重建
6. `--add-data` 的源路径**必须用绝对路径**，PyInstaller 是相对 spec 文件解析的，
   相对路径会去 `build/` 下面找

## 文件地图

```
binance-terminal/
├── server.py                54K    后端全部逻辑（静态服务 + 代理 + WS 中继 + SSE）
├── desktop.py               5K     桌面壳（起服务 + 开应用窗口）
├── index.html               10K
├── assets/
│   ├── css/app.css          45K    全部样式
│   ├── data/sectors.json    20K    板块分类表（419 个代码，改这里调分类）
│   └── js/
│       ├── app.js                  装配、数据流、板块切换、快捷键
│       ├── core/{api,store,ind,fmt,picker}.js
│       ├── views/cell.js          1003 行 单个格子的图表（格子墙和大图共用）
│       ├── views/grid.js           318 行 图表墙布局 + 虚拟化 + 联动
│       ├── views/{list,detail,watch,bigchart,scanner}.js
│       ├── core/alerts.js          资金费率告警
│       └── vendor/lightweight-charts.standalone.production.js  v5.2.1 本地化
├── dist/BinanceTerminal.exe        打包好的桌面程序
├── build/                          打包中间产物 + .venv（45M，可删）
├── tools/
│   ├── e2e.mjs                     端到端回归（CDP 驱动，零依赖）
│   ├── probe_fstream_depth.py      合约 depth 端点探测
│   ├── build_sectors.py            生成 sectors.json
│   └── make_icon.py                纯标准库生成 app.ico
├── app.ico                         图标
├── 打包exe.bat                     重新打包
├── 创建桌面快捷方式.bat
├── 启动看盘.bat                    开发版启动脚本
├── backup/2026-11-04_*/            各轮改动前的快照
└── cache/                          开发版缓存（打包版缓存在 %LOCALAPPDATA%）
    ├── tickers.json                全市场快照（重启秒开）
    └── listing.json                上架时间（"新币"分类用）
```

### 后端接口一览

| 路径 | 说明 |
|---|---|
| `/api/market` | 全市场快照（每行带 `fr`/`nft`，永续才有） |
| `/api/klines` `/api/depth` `/api/trades` | K线 / 盘口 / 逐笔，按 `@f` 后缀路由现货或合约 |
| `/api/perp` | 合约详情：资金费率、结算时间、标记价、指数价、持仓量、多空比 |
| `/api/fundinghist` | 近 12 次资金费率结算 |
| `/api/oihist` | 持仓量历史（`/futures/data/openInterestHist`） |
| `/api/lsrh` | 多空账户比历史 |
| `/api/log` | 前端报错落盘（POST） |
| `/api/intraday` | 分时：本地当天 00:00 起的 1m 收盘价 + 今日开盘价 |
| `/api/stream` | SSE：`tk` 行情增量 / `k` K线 / `d` 盘口 / `r` 逐笔 / `fund` 费率变化 |
| `/api/status` | 连接数、订阅数、消息数、`fut`/`futdepth` 两条合约流的状态 |

---

## 关键实现细节

### 涨跌配色（美国模式，2026-11-04 晚）
**绿涨红跌**。所有涨跌色都走 CSS 变量，JS 里不再写死 `rgba(...)`：

| 变量 | 用途 |
|---|---|
| `--up` / `--up-soft` / `--up-fill` / `--up-vol` | 涨（绿） |
| `--down` / `--down-soft` / `--down-fill` / `--down-vol` | 跌（红） |
| `--ask` / `--bid` | 盘口卖/买（**固定红/绿，不跟涨跌翻转**） |
| `--ok` / `--danger` | 连接状态灯、删除按钮 |

要切回 A 股习惯，只改 `:root` 和 `[data-theme="dark"]` 里的 `--up*` / `--down*` 两组。

**踩过的坑**：`--up` 以前同时承担「涨」和「盘口卖单」两种语义，直接翻转会把卖单变绿。
所以先按语义拆成 `--ask/--bid/--ok/--danger`，再翻 `--up/--down`。
`grid.js` 的 `themeColors()` 和 `detail.js` 的 `colorSpark()` 里的硬编码 rgba 也一并改成 `cv('--up-vol')` 这类读取。

### 多格 K 线对齐 BUG（2026-11-04 23:10 修）

**现象**：多个格子加载进度不一样时，K 线横向错开，同一时间点对不齐。

**根因**：`fitRange()` 里 `spacing = paneW / (bars.length + 2)`——
每个币的 K 线根数不同（新币、停更的币更少），算出来的 `barSpacing` 就不同，
时间轴比例不同，自然错位。

**修法两处**：
1. `fitRange()` 的间距改成按**固定目标根数**（`BAR_LIMIT`）算，不依赖本格子的数据量。
   数据不足的格子左边留白，但和别的格子对得齐。
2. 联动从 `subscribeVisibleLogicalRangeChange` + `setVisibleLogicalRange`
   改成 `subscribeVisibleTimeRangeChange` + `setVisibleRange`——
   逻辑索引在不同数据长度的格子之间没有可比性，时间才有。

**验证**：8 个格子 `getVisibleRange().from` 的极差为 **0 秒**。

### 性能：首屏为什么曾经慢，现在怎么改的（2026-11-04 晚）

**实测时间线（改之前）**：DOMContentLoaded 121ms，但 `/api/market` 要 **1145ms**，
8 个 `/api/klines` 807~2769ms，全部出图约 3 秒。

**根因不是渲染，是请求排队**：
`GridView` 一构造就给 8 个格子发 K 线请求，`await api.market()` 排在它们后面。
8 个 K 线请求同时打到服务端，Python 线程被 JSON 解析占满，market 只能排队等。

**四处改动**：

| 改动 | 效果 |
|---|---|
| `api.market()` 提到 `new GridView()` **之前**发出 | 表头数字 1145ms → **82ms** |
| `_json()` 对 >8KB 的响应 gzip | 行情快照 451KB → **130KB** |
| 服务端 `prefetch_klines()`：启动 6 秒后预热默认 12 个 + 成交额前 40 的 1m K 线 | 刷新页面时 K 线 5ms 命中 |
| 预取**让路**：`LAST_USER_REQ` 在 `do_GET` 里打点，用户请求后 2 秒内预取不动作 | 不抢带宽 |

**实测（预取完成后）**：首屏 **884ms**，从格子进大图 **8~10ms**。
冷门合约（如 CRCLUSDT@f，排第 120 行不在预取范围）首次仍要 **2.7 秒**——
那是代理 RTT，除非换更快的代理节点，否则消不掉。

**已经排除的**：主线程不卡。静置 20 秒只有 1 个 60ms 长任务，切视图约 50ms，
长墙滚动 16ms/帧。所以「不流畅」只可能是等网络，不是渲染。

### 行情条可交互 + 一键清空自选（2026-11-05 13:20）

**行情条（顶部 8 个币）之前纯展示，不能点**。现在和左侧自选栏行为完全一致：

| 操作 | 结果 |
|---|---|
| 单击 | 选中该品种（列表页选中行、图表墙聚焦格子跟着走） |
| 双击 | 填进图表墙当前聚焦的格子（不在图表墙会自动切过去） |
| 右键 | 菜单：在大图中打开 / 加入自选（已在自选里则显示「移出自选」） |
| 悬停 | 高亮 + `title` 提示三种操作 |

当前选中的品种会常亮（`.tape-item.on`，和自选栏的 `.w-row.on` 同一套强调色）。

实现上新增 `setActiveSymbol(sym)`：原来有 7 处各写一遍
`if (watch) watch.setActive(sym)`，现在统一走它，顺带把行情条的高亮也刷了。

**一键清空自选**：自选分组标题右侧加「清空」按钮。

- 平时 `opacity: 0` + `pointer-events: none`，鼠标进到自选区才显形，避免误点
- 点击立即清空（不弹确认框），底部提示「已清空 N 个自选 · 撤销」
- 撤销按钮 6 秒内有效，点了原样恢复
- `store.js` 新增 `clearFavs()` / `setFavs(list)`，两者都**保持数组引用不变**
  （`state.favs.length = 0` 而不是重新赋值），别处拿着的引用不会失效

**`toast()` 扩展**：原来是纯文字，现在可以带一个操作按钮
`toast(msg, { label, onClick })`。带操作停留 6 秒，纯文字仍 1.8 秒。
按钮颜色用 `color: inherit`，因为提示条背景是 `var(--text)`，
明暗主题下深浅相反，写死颜色必然有一边看不清。

**顺带修的**：`favchange` 之前只有自选栏在听，订阅流不跟着变——
清空自选后那些行情流还挂着（实测 279 条）。现在 `favchange` 也触发 `syncSubs()`。

**回归用例**：新增「行情条：单击选中 / 双击填格子 / 右键菜单」和
「自选：一键清空 + 撤销」两条，24/24 通过。

### 工具栏按钮被压扁（2026-11-05 12:50 修）

**现象**：窗口变窄时，行情列表工具栏的「详情」按钮被压到 32~34px，
两个字折成两行溢出按钮框（截图里「详」「情」上下分家）。

**根因**：上一轮 UI 润色时写的防压缩规则只覆盖了 `.toolbar`：

```css
.toolbar > * { flex: 0 0 auto; }     /* 多品种同列页 */
```

但列表页用的是 **`.list-toolbar`**（另一个类名），完全没被匹配到。
flex 子项默认 `flex-shrink: 1`，空间不够时等比收缩；`.chip` 也没设
`white-space: nowrap`，于是文字折行。

实测：1366px 下按钮宽 32px、高 34px（两行）；1600px 正常 43×24。

**修法**：

| 规则 | 作用 |
|---|---|
| `.list-toolbar > * { flex: 0 0 auto }` | 子项不再收缩 |
| `.list-toolbar > .search { flex: 0 1 190px; min-width: 96px }` | 搜索框仍可缩 |
| `.list-toolbar > .tab-wrap { flex: 0 1 auto; min-width: 0 }` | 分类标签条仍可缩（内部横向滚动） |
| `.list-toolbar > #list-count { flex: 0 1 auto; text-overflow: ellipsis }` | 「显示 N 个」当压力阀，省略号收尾 |
| `.chip/.switch span/.top-chip { white-space: nowrap }` | 文字一律不折行 |
| `.list-toolbar { overflow-x: auto }` | 极窄时整条横向滚动，不压元素 |

**顺带修的两处**：

1. **`.tb-spacer` 被自己的规则打掉**：`.toolbar > *` 的优先级和 `.tb-spacer { flex: 1 }`
   相同、位置更靠后，把 spacer 变成 `flex: 0 0 auto`，右侧开关不再贴右。
   补 `.toolbar > .tb-spacer { flex: 1 1 auto }`。
2. **多品种同列工具栏在窄窗口溢出**：1200px 下内容需 1255px，溢出 273px，
   「联动/详情」被挤出可视区（`overflow-x: auto` 又没有可见滚动条，等于看不见）。
   改成 `flex-wrap: wrap` + `min-height: 38px`：放不下就折两行，宽度够时仍是一行 38px。
   折行后给第一个 `.switch` 加 `margin-left: auto`，保持贴右。

**窄屏下「显示 N 个」让位**：`.list-main` 加 `container-type: inline-size`，
容器宽度 < 760px 时隐藏该文字，把空间让给分类标签条。
（实测 `container-type` 不影响表格列宽计算，开关前后各列宽度完全一致。）

**回归用例**：新增「窗口缩放：工具栏按钮不被压扁」，在 1600/1366/1200/1024
四个宽度下断言按钮 43×24、单行、`white-space: nowrap`、工具栏无溢出。
临时回退 CSS 验证过这条用例确实会失败（报「1366px 下宽 32px」）。

### UI 润色 + 苹方字体（2026-11-05 03:30）

**字体**：`--font` 变量集中管理，顺序是
`PingFangLocal → PingFang SC → HarmonyOS Sans SC → MiSans → 思源黑体 → Segoe UI → 微软雅黑`。

`PingFangLocal` 是 `@font-face`，`src` 先试 `local("PingFang SC")`（系统装了就用），
再试 `url("fonts/PingFangSC-Regular.woff2")`（放在 `assets/css/fonts/` 里也能生效）。
**Windows 本身没有苹方**，不装字体的话会退到微软雅黑——字体文件怎么搞见 `assets/css/fonts/README.txt`。

**视觉调整**（只动观感，不碰任何影响布局计算的尺寸）：
- 背景 `#e9ecf0 → #eef1f6`，边框 `#e2e5ea → #e4e8ef`，整体更干净
- 圆角 `--r: 6px → 8px`，弹层统一 10px
- 阴影分两档，顶栏用 1px 投影代替硬边
- 表头字号 11 → 10.5、字距 +0.35px，退到背景里
- 交互元素过渡统一 `.14s ease`
- 数字统一 `tabular-nums`，跳动时不再左右晃
- 滚动条 9 → 8px

**顺手修的两个 bug**：
1. **工具栏按钮被压扁**：「扫描器」「告警」被挤成「扫描」「告」，因为 `.toolbar` 的子项没设
   `flex: 0 0 auto`。修完之后还是太挤，干脆把这两个全局功能挪到**顶栏**（连接状态左边）。
2. **E2E 端口冲突**：`tools/e2e.mjs` 默认 CDP 端口是 9333，和手动调试的浏览器撞了，
   测试会连到调试实例上（读到那边的深色主题、状态）。改成 **9444**。

### 详情面板最终定稿：一列（2026-11-05 02:35）

两列也被否了。恢复成**一列竖排**，宽度回到 336px：

```
头部（币种/价格/涨跌/标签）
近 2 小时走势
行情统计（24h 8 项 + 分隔线 + 合约 6 项）
多空比 / 多空比走势 / 资金费率历史
盘口（上下竖置：价格/数量/合计 + 当前价 + 力量条）
最近成交
```

**DOM 结构保留 `.dt-cols > .dt-col` 两层**（只是 `.dt-cols` 改成 `flex-direction: column`、
`.dt-col` 不再滚动），这样以后想改回分列只动 CSS，不用改 JS。

宽度 336px 后左侧表格恢复到 1026px，12 列基本都能显示。

**拖动调宽和收起开关都保留**，只是默认回到 336。

`uiV` 升到 3，把之前拖宽的像素值清零（否则老用户会卡在 780px）。

### 详情面板最终版：两列（2026-11-05 02:30）

三列通到底试过之后用户说「太丑」，中间盘口被压到 140px、数字叠在一起。
改成**两列均分**：

```
左列（信息）                     右列（市场）
NEAR/USDT  4.137 +7.65%          盘口（价格/数量/合计，卖上买下）
近 2 小时走势                      ─────────────
行情统计（24h 8 项 + 合约 6 项）    最近成交（价格/数量/时间）
多空比 / 多空比走势 / 费率历史
```

两列各 50%，`flex: 1 / 1`。右列内部盘口和成交上下排，中间一条 `border-top` 分隔。
左列内容刚好一屏（scrollH = clientH），右列 900px 需要滚 170px。

**教训**：三列在 660~780px 的面板里每列只有 220~260px，
盘口「价格/数量/合计」三列数据根本放不下。**列数要看内容需要多宽，不是越多越紧凑。**

### 详情面板：三列通到底（2026-11-05 02:20 修正）

上一版把 `.dt-head` 和迷你走势横跨在顶部，只有下面三列并排——用户要的是**三列从顶通到底**。

现在结构：

```
.dt-cols（flex，占满整个面板高度）
├── .dt-col ①  头部（币种/价格/涨跌/标签）+ 近2小时走势 + 行情统计 + 合约数据 + 多空比 + 费率历史
├── .dt-col ②  盘口（上下竖置：价格/数量/合计 + 当前价 + 力量条）
└── .dt-col ③  最近成交
```

列宽 `flex: 1.12 / 1.12 / 0.9`，三列等高、各自滚动。
`dt-head` 和 `dt-chart` 在列内要收内边距（12px / 78px 高），否则占太多。

### 详情面板可收起 + 可拖宽（2026-11-05 02:25）

三列并排的代价是压缩左侧表格（12 列砍到 6~7 列），所以补了两个出口：

1. **拖动调宽**：`.detail` 左边 5px 的 `.dt-resize` 拖拽条，往左拖变宽，
   范围 320~920px，宽度存 `state.detailWidth`，重启还原。
   拖完调 `list.onShow()` 让表格按新宽度重算列数。
2. **收起**：列表工具栏「详情」按钮，`state.listDetailOpen`，
   收起时 `.view-list.dt-off` 直接 `display:none`，表格吃满整个宽度。

两者都走 `save()` 持久化。大图的盘口栏还是走 `bcDetailOpen`，两套独立。

### 详情面板：三块左中右并排 + 盘口上下竖置（2026-11-05 02:35）

**布局**：`.detail` 从 336px 加宽到 `min(660px, 46vw)`，头部和迷你走势横跨整行，
下面 `.dt-cols` 三列并排（行情统计 / 盘口 / 最近成交），每列独立滚动。

列宽 `flex: 1 / 1.18 / 0.92` —— 盘口三列数据最挤，给它多一点。

**盘口改成上下竖置**（对标币安订单簿）：

```
价格        数量       合计
4.130      26.7K      26.40万     ← 卖10
  ...                            ← 递减
4.122      30.7K       ...
─────────── 4.121 ↑ 价差 0.001 ───
4.120      ...
  ...
4.111      51.5K      909.90K     ← 买10
B 48.3%  [====|====]  51.7% S
```

- **合计列**：卖盘从卖1 往上累加、买盘从买1 往下累加，所以最上面/最下面数字最大
- **当前价行**：涨绿跌红，右边跟一个价差
- **底部力量条**：按这 20 档的买卖总量算比例，绿=B、红=S

**注意**：详情面板变宽会压缩左侧表格的列数（12 列会砍到 7 列左右）。
这是三列并排的代价，窄屏下 `46vw` 会自动收。

### 详情面板重排：三块（2026-11-05 02:05）

原来是四个 section（24h 统计 / 合约数据 / 盘口 / 最近成交），合约数据单开一块很碎。
合并成三块：

1. **行情统计** —— 24h 的 8 项 + 分隔线 + 合约的 6 项（资金费率/结算/持仓量/持仓价值/标记价/基差），
   共 14 项排成 2 列 7 行，读起来是一张完整的表。多空比、多空比走势、费率历史都挂在这一块下面。
2. **盘口** —— 左 S 右 B，各带一个彩色小方块标签，中间一条竖线分开。
3. **最近成交**。

`data-role="perp"` 保留成一个包裹 div（E2E 靠它判断有没有合约数据）。

### 5 日连续分时（2026-11-05 02:10）

周期条加了一项「5日」，和「分时」一样走折线渲染（`BaselineSeries`），
基准线是**首日开盘价**，横轴显示 `MM/DD`。

**数据源**：`/api/intraday?days=5`，用 **5 分钟粒度**而不是 1 分钟——
5 天 1m 要 7200 根、8 次请求，小格子里本来也显示不下；5m 是 1440 根，两段并行拉完。

**实现要点**：
- `isIntradayIv(iv)` 统一判断「走折线路径」：`time` 和 `5d` 都算
- `wsInterval('5d')` 要落回 `5m` 流（和 `time` 落回 `1m` 一个道理）
- `fitRange` 和 `intradayStep` 里原来写死 `1440`（一天的分钟数），
  5 日要按 `this.times.length` 算——今天还没走完，实际只有 1171 根
- 订阅映射在 `app.js` 里两处（格子 + 大图），都要加 `5d → 5m`

实测：BTC 5 日 = 1171 根，11-01 00:00 → 11-05 01:30，首日开 77,622.01。

### 三层封锁：DNS 污染 + SNI 阻断 + 451（2026-11-05 02:05 补）

上一节只测了「域名能不能连」，这次往下挖了两层：

```
1. DNS 层：fapi.binance.com → 108.160.166.61（Dropbox 的 IP，假地址）
   阿里 DoH（dns.alidns.com）返回的也是这个假 IP —— 国内 DNS 服务商配合污染
2. 走代理查 Cloudflare DoH 拿到真实 IP：18.164.154.88（AWS CloudFront）
   用 curl --resolve 直连这个 IP → 0.197 秒就 000 失败
   （不是超时，是连接被立即 RST —— TLS ClientHello 里的 SNI 被识别）
3. 就算前两层过了，合约 API 还返回 451（服务端按地区拒绝）
```

**三层任何一层都过不去**，而且第三层是币安自己的策略，跟网络无关。

`api.binance.me` 能连（现货 200）但合约 403，正好证明「同一 IP 下，币安按接口决定给不给」。

**顺带验证的**：把币安 APP 的 UA（`binance-app/2.95.0` 等三种）换上去，
403 依旧；`www.binance.me/bapi/...` 也是 403。所以不是 UA 或 header 的问题。

### 合约能不能不靠代理？实测不能（2026-11-05 02:00）

用户提出「币安手机 APP 在国内能直连，能不能用它的接口」。把常见域名全测了一遍
（`curl --noproxy '*'` 强制直连）：

| 域名 | 现货 `/api/v3/ping` | 合约 `/fapi/v1/ping` |
|---|---|---|
| `api.binance.com` / `api1~4` | 超时 | 超时 |
| **`api.binance.me`** | **200 ✅** | **403** |
| `fapi.binance.me` | — | 302 → `www.binance.me`（网页，403） |
| `fapi.binance.com` / `fapi1~2` | — | 超时 |
| `www.binance.com` | — | 超时 |
| `data-api.binance.vision` | **200 ✅**（已在用） | — |
| `data-fapi.binance.vision` / `fapi-data.binance.vision` | DNS 解析不了 | — |

**结论**：合约 API 没有可直连的公开入口。

关键原因不是网络封锁，而是**服务端策略**——受限地区访问合约接口返回 **451**（法律原因不可用），
这是 API 层的拒绝。网络能通也没用，换域名也没用，除非币安自己开新域名。

手机 APP 能直连，大概率是 APP 内置了非公开的加速线路（CDN / 专线），
这些域名抓包才能拿到，靠猜猜不到。

**落地了两条防御性改动**：

1. **`probe_fapi_direct()`**：每次启动花最多 4 秒试 `fapi.binance.com` 直连，
   通了就设 `FAPI_DIRECT`，合约请求从此不走代理（延迟 2~4s → 200ms）。
   现在打的是「无法直连，继续走代理」，但换个网络环境或币安改策略时会自动生效。
2. **现货双域名**：`REST_HOST`（默认 `.vision`）+ `REST_HOST_ALT`（`.me`），
   主域名失败自动切备用；`BINANCE_REST_HOST` 环境变量可覆盖。

### 盘口价格合并粒度（2026-11-05 01:45）

对标币安官方订单簿的那个下拉：`原始 / tick / tick×10 / tick×100 / tick×1000 / …`，
按币种最小跳动推出来（NEAR tick=0.001 → 0.001 / 0.01 / 0.1 / 1 / 10）。

**合并规则**：卖价 `ceil`、买价 `floor`（保守，不会把卖价算低、买价算高），
同价位的数量累加，再按买卖各自方向排序。

**两个必须处理的坑**：

1. **WS 会覆盖 REST**：合并模式下用的是 REST 拉的深档（最多 1000），
   而 `onDepth()` 收到的 WS 推送只有 20 档，一覆盖就退回 1 档。
   → `if (this.bookStep) return;` 合并模式下忽略 WS。
2. **合约 depth 的 limit 只认固定档位**：5/10/20/50/100/500/1000，
   传 200 会被币安当成非法值忽略（返回的还是 20 档）。
   → 服务端 `api_depth` 把 limit 吸附到最近的合法值。

**要多少原始档**：`need = 10 × (合并粒度 / tick)`，上限 1000。
比如 NEAR tick=0.001、粒度 0.1 → 需要 1000 档才能凑出 10 格。
合并模式下轮询间隔从 30 秒降到 **2.5 秒**（REST 拉深档，没法用 WS）。

实测：NEAR 选 0.1 → 卖 4.100/4.200/…/5.000，买 4.000/3.900/…/3.100。

### 盘口改成两列 20 档（2026-11-05 01:15）

**20 档是上限**：`@depth20@100ms` 这条 WS 流固定给 20 档，再多只能改 diff 流自己维护订单簿
（复杂且容易出错），或者退回 REST 拉 50/500 档（要轮询，反而慢）。所以 20 就定在这。

**布局**：去掉 8/20 切换按钮，固定「买卖各 10 档」，并排两列：

```
左列（卖）        右列（买）
卖10              买10
 ...               ...
卖1               买1      ← 都贴底
──────────────────────────
价差 0.001 (0.02%)
```

两列都用 `flex-direction: column-reverse`，DOM 里第一个元素渲染在最底部，
所以 `asks[0]`（卖一）和 `bids[0]`（买一）自然贴着价差行。

高度从 **380px 降到 199px**，侧栏不用再往下滚。

### 侧栏默认打开 + 复位按钮改版（2026-11-05 01:20）

- **两个侧栏默认打开**：`state.detailOpen`（多品种同列的详情侧板）和
  `state.bcDetailOpen`（大图盘口栏）默认都是 `true`。
  localStorage 里加了 `uiV: 2` 做一次性迁移——老用户存的是 `false`，
  升级后强制打开一次，之后按用户自己的开关走。
- **复位按钮**换成圆形不闭合箭头（`M21 12a9 9 0 1 1-2.64-6.36` + `M21 3v6h-6`）。
- **按钮要挂在 `cell.el` 里，不能挂 `.bc-body`**：`.bc-body` 是 flex，里面还含右侧盘口栏，
  `right:72px` 会算到盘口栏上面去，按钮直接被盖住。`destroyCell()` 会把它一起移除，
  所以构造时存了 `this.resetBtn` 引用，`mountCell()` 每次重新 append。

### 详情侧栏为什么慢，怎么修的（2026-11-05 00:40）

截图现象：点开一个合约，合约数据全 `--`、盘口「等待盘口数据…」、迷你走势空白。

**根因**：`setSymbol()` 一口气发 5 个走代理的请求
（klines / perp / fundinghist / lsrh / depth+trades），互相抢带宽。
而其中**三个根本不需要请求**——资金费率、标记价、基差，行情表 `/api/market` 里本来就有。

**四处改动**：

| 改动 | 效果 |
|---|---|
| `build()` 用 `market` 里的 `fr`/`mp`/`ip` 预填费率/标记价/基差 | **2~4 秒 → 6~16ms** |
| `loadSnapshot` 拆开：depth 和 trades 各自 `.then()` 渲染（原来 `Promise.all`，盘口被成交拖住） | 盘口早 0.7 秒 |
| `loadPerp`/`loadFundHist`/`loadLSRH` 延后 400/800/1100ms 再发，别跟盘口抢 | 盘口 2.1s → 1.4s |
| `/api/perp` 的 oi/lsr 总超时 8s → 4s，单请求 25s → 12s；加 `PERP_CACHE` 10 秒 + `_inflight` 去重 | 最坏情况不再卡 8 秒 |

`DepthWorker._sync_subs` 的对账间隔也从 1 秒缩到 0.3 秒（切币后盘口早 0.7 秒）。

**踩的坑**：`renderPerp()` 里无条件 `set('fr', ...)`，当 `/api/perp` 拿不到值时会把预填的
费率又刷成 `--`。改成「有值才覆盖」。

**实测（BZUSDT@f，冷门合约）**：费率/标记价 16ms、盘口 1.4s、成交/持仓量/走势 3.0s。

### 图形复位 + Shift 测量（2026-11-04 晚）

**复位按钮**：大图右上角（`.bc-reset`，`position:absolute; right:72px`），
点一下 `cell.autoFit = true` + `fitRange()`，回到「K 线铺满 + 最后一根贴右」。
用户拖动过图之后 `autoFit` 变 false，按钮会常亮成蓝色提示「已经偏离，可以复位」。
快捷键 `R`。

**Shift + 拖动测量**：不用切工具，按住 Shift 在图上拖，画一个半透明矩形，
标签显示 `涨跌幅% / 价格差` 和 `N 根 · 时间跨度`。涨绿跌红。
松开保留结果，点一下图表清除；换币/换周期也会清。

**两个坑**：
1. `render()` 开头有 `if (!this.items.length && !this.draft) return;`，
   测量框既不是 items 也不是 draft，直接被跳过 → 条件里补 `&& !this.measure`。
2. `.bc-body` 是 `display:flex` 但没写 `position`，里面的 `absolute` 按钮
   一直定位到 `.bigchart`（fixed）上，跑到工具栏里去了 → 补 `position: relative`。

### 切周期为什么慢，怎么修的（2026-11-04 23:55）

用户反馈「切换各个周期还是加载好久」。查下来是三个问题叠在一起：

**1. 前端缓存逻辑写错了（影响最大）**

`Cell.load()` 里用 `!this.bars.length` 判断能不能用缓存。
但切周期时 `bars` 里是**上一个周期**的数据（非空），条件永远不成立，
所以来回切 1m ↔ 5m 每次都在重新请求。改成记录 `loadedKey` 判断。

**2. 服务端没有预热其他周期**

第一次看某个币时，把它的 5m/15m/1h/4h/1d 排进预取队列（`_maybe_prefetch_other`），
`kline_prefetch_worker` 在用户空闲时一个个拉好。用户切过去就是命中。

**3. 预取和用户请求撞车（最坑的一个）**

预取正在拉 5m 时用户也点 5m，两边同时打币安，用户反而等更久（实测 3.6 秒）。
加 `_inflight` 去重：同 key 只允许一个请求在飞，后来的 `Event.wait(8)` 等前一个，
拿到结果直接用。顺带把 `HTTPS_POOL_MAX` 从 8 提到 16。

**实测（同一个币连续切）**：

| 操作 | 修之前 | 修之后 |
|---|---|---|
| 首次切 5m | 3639ms | **104ms** |
| 首次切 15m | 5668ms | **387ms** |
| 切 1h | 104ms | 203ms |
| 切 4h | 265ms | 527ms |
| 来回切 1m / 5m | 每次重拉 | **7~16ms** |

**结论**：切周期现在是「命中缓存 5~20ms、预取过 100~500ms、完全冷启动 1~2s」。

### 往左拖加载更早的历史（2026-11-04 23:45）

前端 `Cell.loadMore()`：可视区 `from < 40` 时触发，用当前最早一根的时间当 `before`，
请求 `/api/klines?...&before=<ts>`，拿到更早的一段后**拼到前面**，并把视野整体右移
新增的根数（`setVisibleLogicalRange({from: vr.from + added, to: ...})`），画面不跳。

服务端 `get_klines_before()` 两级：
1. **先看缓存**——缓存里已经有比 `before` 更早的直接切一段返回，连接口都不打
2. 缓存不够才用 `endTime` 去币安拉，拉回来合并进缓存并写盘

**踩过的坑**：第一版判断"还有没有更早的"用的是 `raw[0][0] >= bars[0][0]`（缓存最早一根），
但缓存往往比前端手上那批厚得多（服务端 1500 根、前端 500 根），一比就误判成"到头了"，
直接返回空。改成先按 `before` 从缓存里切，切不出来再请求。

大图里 500 根铺不满 1522px，会**自动**触发一次加载，所以打开大图就是 1000 根。

### K 线磁盘缓存：分片存储（2026-11-04 23:20 重做）

**旧的**：所有序列塞进一个 `cache/klines.json`，60 秒整体重写一次。
实测只存了 24 条序列、每条 500 根、642KB —— 用户看过的币换个周期就没了。

**现在的**：`cache/klines/<key>.json`，**一条序列一个文件**。

| 项 | 值 |
|---|---|
| 目录 | `cache/klines/`（打包版在 `%LOCALAPPDATA%\BinanceTerminal\cache\klines`） |
| 文件名 | `s_BTCUSDT_1m.json` / `f_BTCUSDT@1m.json`（`:` `|` `@` 换成 `_`） |
| 首次拉取 | `KLINE_FETCH = 1000` 根（前端只要 500，多存的留给用户往左拖） |
| 写盘 | 后台线程 `kline_saver`，每 2 秒批量写脏序列，**不整体重写** |
| 读盘 | `get_klines` 内存 miss 时才读那一个文件，几毫秒 |
| 启动 | **不再全量载入**（分片可能上千个），启动更快 |
| 上限 | `KLINE_MAX_SERIES=1200` 只限内存；磁盘 `DISK_MAX_FILES=6000`，超了按 mtime 删最旧 |
| 迁移 | 老的 `klines.json` 启动时自动拆成分片，然后改名 `.migrated` |

**关键细节**：隔很久再打开时 `start` 会被置空走"整段重拉"，如果不处理会把磁盘上更早的
历史冲掉。所以重拉后要把旧数据里比新数据更早的部分接回去。

实测：首次 1.2s 存 1000 根 → 重启后 4.6ms → 26 小时后再看 1.7s（增量补）。

### 真正的元凶：TLS 握手 2 秒（2026-11-04 23:30 补）

上一轮只优化到「请求排队」，用户反馈还是慢。继续拆解单次请求：

```
现货直连 data-api.binance.vision:  TCP 2ms → TLS 1.98s → 首字节 3.42s
合约代理 www.binance.com:          TCP 2ms → TLS 2.44s → 首字节 3.08s
```

**TCP 只要 2ms，TLS 握手吃掉 2 秒。** 每个 K 线请求都重新握手一次，8 个格子就是 8 次。

修法：`http_get()` 改成走 **HTTPS 连接池**（`http.client.HTTPSConnection` 复用），
失败自动退回原来的 urllib 逻辑。实测连续 6 个不同币：**2~3s → 0.5~1.2s**。

同时分时接口原来是**串行拉两段**（一天 1440 根，单次上限 1000），
改成两段并行 + 结果缓存 12 秒：现货 2.4s → 1.2s，合约 5.4s → 3.8s。

**踩过的坑**：预取一开始用 3 线程硬跑，把代理带宽吃满，导致详情面板的
`/api/depth` 5 秒都回不来（E2E 的「盘口栏」用例直接挂了）。加让路逻辑后正常。

### 合约 symbol 约定
`BTCUSDT@f`（后缀 @f 表示永续）。前端 `encodeURIComponent`，后端按 `endswith("@f")` 路由。
`sectors.json` 里同时收录了现货股票代币（`AAPLB`）和合约代码（`XAU`/`SOXL`）。

### 涨速
服务端每 10 秒存一份全市场价格快照（`HUB.snaps`，保留 7 份），
涨速 = (现价 / 最早快照 - 1) × 100，约 60~70 秒窗口。**启动 60 秒后才有意义的值。**

### 合约衍生指标（数据成本决定实现方式）
| 指标 | 接口 | 成本 | 策略 |
|---|---|---|---|
| 资金费率 / 标记价 / 指数价 | `/fapi/v1/premiumIndex` | 210KB / 1.1s，**一次返回 945 个合约** | 后台线程 60s 轮询，只把 `fr`/`nft` 变化的推给前端 |
| 持仓量 | `/fapi/v1/openInterest?symbol=` | 1.1s / 单币 | 只在选中该币时拉，缓存 20s |
| 多空账户比 | `/futures/data/globalLongShortAccountRatio` | 3.5s / 单币（最慢） | 与持仓量**并行**拉，总超时 8s，拿不到就留空 |
| 费率历史 | `/fapi/v1/fundingRate?limit=12` | 2.5s / 单币 | 选中时拉一次，缓存 5 分钟 |

**单位约定**：`/api/market` 与 `/api/perp` 里的 `fr` 都是**百分数**（0.01 表示 0.01%），
服务端已乘过 100；`FUNDING` 内存表里存的是币安原始小数（0.0001）。这里最容易写错。

**`lastFundingRate` 是"当前预测费率"，不是上一次结算值**：实测 65 秒内有 161 个合约的
该字段在变（小币的溢价指数一直在动）。所以别指望它 8 小时才变一次。

**SSE 推送**：`{"t":"fund","d":[[sym@f, fr%, nft], ...]}`，只含发生变化的合约，
每分钟约 160~210 条 / 12KB。`nextFundingTime` 稳定，变的基本都是 `fr`。

### 合约流：两条连接，别搞混（2026-11-04 晚修正）
**旧结论「合约没有 depth 流」是错的**——那只对 `/market/stream` 成立。
币安合约有两条不同的 WebSocket 入口，能力不一样：

| 端点 | 有什么 | 谁在用 |
|---|---|---|
| `wss://fstream.binance.com/market/stream` | `!ticker@arr` 全市场快照、`@kline`、`@aggTrade`；**没有 depth** | `FuturesWorker` |
| `wss://fstream.binance.com/stream` | 标准合并流：`@depth20@100ms` 正常 100ms 一帧；**`!ticker@arr` 收不到** | `DepthWorker` |

所以：
- **合约 K 线 / 逐笔** → `FuturesWorker`（`/market/stream`，`_wanted()` 每 1.2 秒对账）
- **合约盘口** → `DepthWorker`（`/stream`，只订阅当前正在看的那个合约，`@depth20@100ms`）
- 前端详情面板的 REST 轮询降到 **30 秒兜底**（`reloadBook()`，只补盘口不动逐笔）

`tools/probe_fstream_depth.py` 是当时的探测脚本，六种写法全测过，留着以便币安改端点时复测。
现货流里仍然绝不能出现 `btcusdt@f@kline_1m` 这种带 @f 的流名——非法，`desired_streams()` 里已过滤。

### 板块分类（2026-11-04 晚改成官方数据）
`sectors.json` 结构：`{"labels": {code: 中文名}, "map": {base: [tag, ...]}, "meta": {...}}`。
一个币可以有多个标签（ETH = L1 + DEFI）。

**不再手写，由 `tools/build_sectors.py` 从币安官方数据生成**：
1. 合约 `/fapi/v1/exchangeInfo` 的 `underlyingSubType` —— 这就是币安合约页板块标签的来源，
   取值有 AI / Meme / DeFi / Layer-1 / Layer-2 / Gaming / Metaverse / RWA / Infrastructure /
   Chinese / Pre-IPO / Pre-Market / TradFi
2. `underlyingType`（COIN / EQUITY / HK_EQUITY / COMMODITY / PREMARKET / INDEX / FX）兜底 → TradFi
3. 只有现货没有合约的币，用 `/bapi/asset/v1/.../get-products` 的 `tags`
   （AI / Meme / defi / Layer1_Layer2 / Gaming / RWA / Infrastructure / bStocks / tCommodities）

重跑：`python tools/build_sectors.py`（会先把旧文件备份成 `sectors.json.bak-时间戳`）。

**之前手写版错在哪**：Pre-IPO 写成了 SPCX / ANTHROPIC / OPENAI（SPCX 其实是普通股票合约），
币安官方是 ANTHROPIC / OPENAI / MOONSHOT / OURA / PREDICT。手写 419 条 vs 官方 885 条，
差距远不止 Pre-IPO 一个类目。

### 股票代币怎么识别
筛「以 B 结尾 + 2025 年后上架」，再排除 10 个真实老币（AMB/ARB/BNB/CKB/DGB/MOB/PHB/SHIB/TRB/VIB），
得到 105 个。币安没给这类代币打任何特殊标记（exchangeInfo 的 permissions 完全一样）。

### 表格列对齐
`.row` 是 `position:absolute`，**必须显式 `width:100%`**，否则宽度按内容收缩，
和 `.thead` 的 `fr` 分配基数不同 → 列错位。
列宽由 JS 算成纯 px 写进 `--cols`，表头和数据用同一串值。

### lightweight-charts 的两个坑
1. `autoSize: true` 时容器初始宽度为 0，`setVisibleLogicalRange` 会被压缩成 [418,477]
   → 改为显式 width/height + ResizeObserver
2. `panes()[1].setHeight()` 会被后续 resize 覆盖 → 在 onResize 里重新设置

### 多品种同列的详情侧板（2026-11-04 晚）
**两个 `DetailPanel` 实例，不是把列表页那块 DOM 搬来搬去**——搬家会让 lightweight-charts
的 canvas 尺寸错乱，还要重建。实例化的差别只有三个构造参数：

```js
new DetailPanel($('#detail'))                                   // 列表页
new DetailPanel($('#grid-detail'), { closable: true, delay: 140, onClose: ... })
```

几个必须知道的点：

1. **可见性判断用 `root.getClientRects().length`，不要再用 `#view-list` 有没有 `.hidden`**。
   两块面板分属两个视图，写死某个视图 id 就会漏。隐藏时 `perpTimer` / `bookTimer`
   直接 return，切视图不会两边同时轮询同一个合约。
2. **`delay: 140`**：方向键连按时每挪一格都会 `setSymbol`，不防抖就是连续重建 DOM + 打
   `/api/klines`。`setSymbol()` 只记 `pendingSym` 并重排定时器，真正干活的是 `applySymbol()`。
3. **`Cell.setSymbol()` 末尾补了 `ctx.onFocus(sym)`**（仅当 `index === focusIndex`）。
   否则在格子里用表头下拉换了币，`focusIndex` 没变 → `setFocus()` 判定 `changed=false` →
   侧板还停在旧的币上。这个 bug 只在这一处暴露，改 `setFocus` 是改不掉的。
4. **订阅要跟着面板开关走**：`syncSubs()` 里 `wantBook = view === 'list' || state.detailOpen`，
   面板收起时把 `depth/trades` 传 `null`，服务端 `set_wanted` 会退订深度流。
5. **`refresh()`**：面板在另一个视图里待着时轮询是停的，切回来要补一次价格/盘口，
   否则显示的是一分钟前的数据（`setSymbol` 同币种会 early-return，指望不上它）。
6. 宽度：`.dt-side` 308px，`@media (max-width:1180px)` 降到 274px。收起时
   `.grid-wrap.dt-off > .dt-side { display:none }`，图表靠自己的 ResizeObserver 吃满。

### 长墙的虚拟化（重要）
`Cell` 分成「格子外壳」和「图表」两层：
- `unmountChart()` 只销毁 lightweight-charts 实例，保留 `.cell` DOM 和表头
- `GridView.syncMount()` 在滚动（rAF 节流）和 resize 时，按
  `scrollTop / 行高` 算出可见行，只挂载视野 ±2 行的格子
- `reqId++` 让卸载瞬间的在途请求作废，回来也不会再画
- K 线前端缓存 `KL_CACHE`（120 条，FIFO），来回滚动直接秒画
- `onFrame` / `resize` / `setIndicators` / `applyTheme` 全部只处理 `mounted` 的格子

### 滚轮必须先过图表墙（多品种同列）这一关
lightweight-charts 的 canvas 自己监听 `wheel` 做缩放，并且 `preventDefault`。
只要鼠标落在图上，容器就永远滚不动——这就是"没有滚动条 / 滚不动"的真正原因。
解法：在 `.chart-host` 上用 **capture** 阶段挂 wheel：

```js
host.addEventListener('wheel', (e) => {
  const g = view.root;
  const canScroll = g.scrollHeight > g.clientHeight + 1;
  if (!canScroll || e.ctrlKey) return;      // 交给图表缩放
  e.preventDefault(); e.stopPropagation();
  g.scrollTop += e.deltaY;
}, { passive: false, capture: true });
```
capture 必须开，否则子元素的 canvas 监听器先跑，`stopPropagation` 就晚了。

### 取景（fitRange）与分栏高度的正确写法
```js
const paneW = host.clientWidth - 62;               // 右侧价格轴约占 60px
const spacing = clamp(paneW / (n + 2), 2.6, 14);   // 2.6px 是蜡烛还看得清的下限
timeScale().applyOptions({ barSpacing: spacing, rightOffset: 1 });
timeScale().scrollToRealTime();                    // 关键：右对齐到最新
```
- 宽度 > (n+2)×2.6 时全部 K 线铺满（1×1 下 500 根正好铺满 1422px）；否则只显示最近的一段
- **`panes()[1].setHeight()` 是异步生效的**：尺寸刚变完就调会被内部布局覆盖
  （实测 1×1 里 MACD 窗被撑到 238px，K 线只剩 45% 高度，看起来就像"K线没占满窗口"）。
  必须 `setTimeout(..., 220ms)` 后再设，设完再重排 legend
- 用户 `pointerdown` / `wheel` 过后把 `autoFit` 置 false，之后 resize 不再抢镜头

### 窄格子的字段取舍
`.ch-row2` 里依次是 高 / 低 / 额 / 费 / 周期。容器查询按「费 → 额 → 低」的顺序砍：
- `< 460px` 隐藏「费」（永续资金费率）
- `< 300px` 隐藏「额」
- `< 260px` 隐藏「低」

早期版本是 `<400` 藏「低」、`<300` 藏「额」，结果 315px 的格子里只剩「高」，
看起来像数据掉了。高/低必须成对保留。

### 表格列宽的收尾处理
`Math.max(min, w*scale)` 会让保底宽度加起来超过容器（12 列时超 10px，最后一列被裁掉）。
超出后要按比例整体回收一次，仍超出再从最宽的列逐像素扣，直到 `sum <= avail`。

### 现货 / 永续两级分类
- `state.mkt = 'all' | 'spot' | 'perp'`，`matchMkt(row, mkt)` 做一级过滤
- 列表工具栏：`#list-mkt` 分段控件 → 页签 → 板块 chip，数量都按当前 mkt 统计
- 多品种同列的板块菜单 key 形如 `spot:AI` / `perp:all`；`fillSector` 会**同时改写 mkt/tab/sector**，
  再通过 `ctx.onFilterChanged` 让列表跟着刷新，两边永远一致
- 旧版 `tab === 'perp'` 在 `store.js` 的 load() 里迁移成 `mkt: 'perp', tab: 'all'`

---

## 2026-11-05 15:30 · 接手体检 + 优化（第 15 轮）

上一轮（11-05 13:20）之后的一轮。**没有加功能**，只把「等」和「假失败」清掉，
外加补了一个性能采样工具。所有结论都有数字，别看感觉。

### 1. 新增 `tools/perf.mjs`：只量耗时，不断言

```
node tools/perf.mjs            冷启动（全新 user-data-dir）+ 关键交互耗时
node tools/perf.mjs --headed   看现场
```

和 `e2e.mjs` 分工：e2e 管「功能对不对」，perf 管「有多慢」。输出首屏时间线、
最慢的 6 个请求、切周期 / 详情面板 / 大图 / 持仓量 / 5 日分时的耗时。
**以后说"优化"之前先跑它，别凭感觉。**

实测（本机、代理正常时）：行情 0.55s → 8 格出图 1.0~1.6s；
代理抖动时单次 K 线能到 10s，那是线路问题，不是代码。

### 2. 持仓量面板：2.7s 空白 → 通常 0ms

持仓量历史走 `/futures/data/openInterestHist`，单次 3~13 秒（取决于代理），
原来**点一下按钮才开始拉**，面板就那么空着。

| 改动 | 位置 |
|---|---|
| 打开永续大图后 **2 秒**后台预取（延后是为了不跟 K 线抢带宽） | `bigchart.scheduleOIPrefetch()` |
| 点开时命中预取直接画；没命中则按钮加 `.loading` 脉动，表示在拉 | `bigchart.loadOI()` |
| 重建 OI 曲线时清空 `oiData`，否则预取回来的数据会被"已有数据"挡住 | `bigchart.applyOI()` |
| 服务端 TTL 30s → **120s**（持仓量最小粒度就是 5m，2 分钟内数据不会变） | `server.api_oihist` |

实测：预取完成后再点按钮 **2ms**；没预取时仍是 1.4~2.7s（那是接口本身的时间）。

### 3. 合约 REST 加「同 key 只飞一个」

`cached_fapi()` 原来只有缓存、**没有去重**。而这一轮加了预取，很容易出现
「预取在拉、用户也在点」两边同时打币安——K 线预取踩过这个坑，这次提前堵上。

```python
# 第一个请求建 Event 当 owner，后来者 ev.wait(timeout) 等结果；
# 先落缓存再唤醒（否则等待方醒来还是 miss，又各拉一次）
```

实测（并发两个同一个 `/api/oihist`）：**总耗时 6.76s，不是两份 6.7s**；第三次 4ms。
多空比 `/api/lsrh` 的 TTL 也从 30s 提到 60s（数据按 5m 粒度过，没必要 30 秒重拉）。

### 4. `启动看盘.bat` 的 Python 探测是错的（真 bug）

原来用 `where python` 判断，但 **Windows 自带的「应用商店占位符」python.exe
能让 `where` 成功，一执行就返回 9009**。本机就是这种情况：
`where python` 有输出、`python server.py` 什么都不发生，双击后只是一闪而过。

改成**实跑一句**再算数，并加 `py -3` 兜底：

```bat
python -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=python"
...
```

没找到时给出可操作的提示（设置 → 应用 → 高级应用设置 → 应用执行别名，
关掉 python.exe / python3.exe）。`打包exe.bat` 同样改法。

**教训**：判断"某个命令能不能用"不要用 `where`/`command -v`，
要真的执行一次最小命令看退出码——PATH 里有东西不代表它能跑。

### 5. E2E 持仓量用例：固定等 4.2 秒 → 轮询到数据到位

这条用例 15:19 跑挂过一次（`持仓量数据太少：0`），不是功能坏了，
是持仓量接口那次排到了 4.5 秒以上。改成轮询（最多 15 秒），
断言从"恰好等够了"变成"最终有没有"，消除假失败。
24/24 通过。

### 6. 大图盘口栏订阅错币（真 bug，E2E 抓到的）

`syncSubs()` 里盘口/逐笔的订阅写的是 `state.selected`，可 `big.open()` 并不一定经过
`openBig()`（自选栏、扫描器、E2E 都会直接调），那一刻 `state.selected` 还停在旧标的上。
后果：服务端订了**另一个币**的 depth，大图右侧盘口只能靠 REST 兜底（30 秒一次），
代理一抖动面板就一直是空的 —— 表现是"盘口栏打开了但没数据"。

```js
// 订阅要跟着「正在看的那张图」走
const bookSym = (big && big.isOpen() && big.symbol) ? big.symbol : state.selected;
```

顺带把 `syncSubs` 挂进 `window.__term`，E2E 直接 `big.open()` 之后能补一发订阅；
这条用例也从「固定等 5 秒」改成「主动 syncSubs + 轮询最多 15 秒」。

**教训**：「当前在看哪个币」有多个来源（列表选中 / 格子焦点 / 大图品种），
任何订阅和请求都必须按**哪块面板真的在显示**来取，不能图省事用 `state.selected`。

### 7. 这一轮没做的事（想清楚了才不做）

- **盘口 REST 换成 WS 首帧优先**：现货 depth 订阅要等 `_sync_subs` 下一轮（~1.1s），
  和 REST 的 0.8~1.7s 基本打平，改了没收益，还多一条时序依赖。
- **大图复用格子的 500 根先画**：KL_CACHE 已经按 `symbol|interval` 命中，
  从格子双击进大图本来就是 0ms；只有从列表进冷门合约才要等，加预取会抢带宽。
- **server.py 拆模块**：2236 行确实长，但拆它全是风险、用户看不到收益。

---

## 2026-11-05 16:05 · 界面观感 + 流畅度（第 16 轮）

接上一轮，这次动的是「看着舒服、动起来顺」——功能没加，逻辑没改。

### 1. 新增 `tools/shots.mjs`：改 UI 前后必须截图对比

```
node tools/shots.mjs before        # 改之前
node tools/shots.mjs after         # 改之后
node tools/shots.mjs --only=big    # 只截某个状态（grid/list/big/detail）
```

固定 1600×900 视口、独立 user-data-dir，输出到 `.shots/<tag>/*.png`。

**踩到的坑（很重要）**：截图脚本原来带 `--disable-gpu`，
lightweight-charts 的多层 canvas 会被截成**黑块**——详情面板的迷你走势图整块发黑，
我一度以为是配色 bug，查了半天。改用 `--use-angle=swiftshader` 就正常了。
**凡是"截图里某块 canvas 是黑的"，先怀疑无头浏览器的 GPU 参数，别急着改代码。**

### 2. 修了两个真 bug（都是截图逼出来的）

**a. 换主题后，大图右侧详情面板的迷你走势图不跟着换**

`BigChart.applyTheme()` 只转发了 cell 和绘图层，没转发 `detailPanel`。
结果是：深色主题下打开大图 → 切浅色 → 那块图表还是深色底，浅色面板里一块黑。

```js
applyTheme() {
  if (this.cell) this.cell.applyTheme();
  if (this.draw) this.draw.schedule();
  if (this.detailPanel) this.detailPanel.applyTheme();   // ← 少的就是这行
}
```

**b. 迷你走势图在「面板隐藏时创建」会一直空着**

大图右侧栏的 DetailPanel 是在 `#bigchart` 还 `display:none` 的时候建图表的，
`clientWidth = 0` → `fitContent()` 算出空的可视区间；之后尺寸变了也不会自动重算，
表现就是「近 2 小时」一直白板。两处修：

- `ResizeObserver` 里尺寸稳定后重新 `fitContent()`
- `loadSpark()` 先吃 `KL_CACHE`（格子/大图刚拉过同一个币的 1m），**再**去请求接口。
  迷你图只有 84px 高，没理由让用户等 2~5 秒的接口。

`cachedKlines(sym, iv)` 是从 `cell.js` 新导出的，详情面板直接复用前端缓存。

### 3. 观感调整（都是 CSS 为主，JS 只加类名）

| 改动 | 位置 |
|---|---|
| 视图切换淡入 + 上移 3px（0.16s） | `switchView()` + `.view-enter` |
| 详情侧板从右侧滑入 10px（0.18s） | `setGridDetail()` + `.dt-enter` |
| 大图模式淡入（0.17s） | `BigChart.playEnter()` + `.bc-enter` |
| 图例右侧渐隐（不再被价格轴硬切）、MACD 图例留出轴宽 | `.cell-legend` + `.macd` |
| 格子窄于 340px 时 MACD 只留参数不留数值 | `@container (max-width:340px)` |
| 格子表头只显示基币，计价货币做小字、窄格子隐藏 | `Cell.setSymbol()` + `.cs-q` |
| 永续格子在代码后面挂一个「永」小标（之前只看表头分不出现货/合约） | `.cs-p` |
| 周期下拉平时 `opacity:.55`，鼠标进格子才显形 | `.ch-iv` |
| 费率历史加零轴虚线、柱子变窄、日期每 3 根标一次 | `.fhist` + `renderFundHist()` |
| 迷你走势图容器补 `background: var(--panel)`（防画布首帧发黑） | `.dt-chart` |

**动画只碰 `opacity` / `transform`**：这两个属性不触发布局。
如果去动 `width`，ResizeObserver 会每帧触发 `chart.resize`，比不加动画还卡。

### 4. 流畅度实测（`tools/perf.mjs` 新增两项 rAF 采样）

| 操作 | 帧间隔中位数 |
|---|---|
| 切换视图（连续 12 次） | **19.5 ms/帧**（约 51fps） |
| 开合详情侧板（连续 12 次） | **16.6 ms/帧**（满帧） |

帧间隔是在动作进行中采的 rAF 间隔中位数（不是平均值，避免一次长卡把结论带偏）。
切视图偏慢的部分主要是列表首次渲染 1800 行 + 列宽重算，不是动画本身。

### 5. 顺带让两条 E2E 用例别再被代理抖动误伤

- 「合约盘口」：先轮询 `/api/status` 等 `futdepth` 回到 ok 再采样
  （DepthWorker 掉线重连有空窗，断言的是"连没连上"，不是"此刻恰好在线上"）

### 6. 这一轮没做的事

- **默认布局自适应窗口宽度**：想过 1600px 默认 3×2，但用户已有 localStorage 布局，
  改了只对"新用户"生效，收益不对称，先不动
- **给图表轴加千分位**：轴标签和表头的格式会打架（每根 series 精度不同），
  局部改反而更不一致，留着以后统一做

---

## 2026-11-05 16:25 · 列表滚动与侧板开合的流畅度（第 17 轮）

主题：把「列表滚动」和「详情侧板开合」这两处主线程卡顿按住。
先说工具：`tools/perf.mjs` 这轮加了**长任务（>50ms）计数**——比帧间隔更接近
"人到底觉不觉得卡"。

### 1. 列表滚动：22.2 → 16.9 ms/帧（p90 33 → 25）

原来 `renderWindow()` 的判断是：

```js
if (!force && start === this.range[0] && end === this.range[1]) return;
```

而 `this.range` 存的是**没有余量**的 `[start, end]`。滚动一行，`end` 就 +1，
条件立刻不成立 —— **等于每帧都在重建整屏 DOM，而且每行都要重算一次列宽**
（`fitCols` 在 `makeRow()` 里面，被调用了 N 次）。

两处改：

| 改动 | 效果 |
|---|---|
| 渲染窗口上下各留 `PAD=4` 行余量，并把余量算进 `this.range` | 可视区还在已渲染窗口里就直接 return，滚动时多数帧零 DOM 操作 |
| `fitCols(orderedCols(), colWidth)` 从 `makeRow()` 提到 `renderWindow()` | 每次重建只算一次列宽 |

**注意**：只加余量不改判断是不够的（我第一版就这么写的，白改）。余量必须
同时存进 `this.range`，否则下一帧 `end` 仍然越界，还是每帧重建。

### 2. 侧板开合：一次 90~170ms 的卡顿 → 热态 0 个长任务

一开一合要同时改 8 张图的 canvas 尺寸。实测一次切换里主线程被占满 90~170ms，
肉眼就是"顿一下"。

改成分帧排队：

```js
// cell.js
const resizeQueue = [];
function queueResize(cell) { ... requestAnimationFrame(flushResizes) }
function flushResizes() {
  const t0 = performance.now();
  while (resizeQueue.length) {
    resizeQueue.shift().applySize();
    if (performance.now() - t0 > 8) break;   // 每帧最多干 8ms
  }
  if (resizeQueue.length) requestAnimationFrame(flushResizes);
}
```

顺手加了「尺寸没变就别重建 canvas」的判断：同一次布局里 ResizeObserver
可能连着触发两次，8 个格子 × 两次就是肉眼可见的卡。

实测（热态下开合 4 次）：**0 个长任务**。冷启动第一次开面板仍有 ~60ms
（要建面板 DOM + 迷你走势图 + 发请求），只发生一次。

**代价**：图表比容器晚 1~3 帧才跟上新尺寸。因为格子背景就是不透明面板色，
静止时完全看不出来，但**别把这个延迟放大到几十帧**，那样会看到图比格子窄一条。

### 3. 键盘焦点可见

`:focus-visible` 统一成主题色描边。浏览器默认焦点环在深色主题下几乎看不见。

### 4. 这一轮没做

- **行高密度切换**：40px 行高对看盘是合适的，再密就不好点了；真要做应该是可选档位
- **默认布局自适应**：同上轮，老用户有 localStorage，收益不对称

---

## 2026-11-05 16:45 · 长墙（全部品种）的滚动与加载（第 18 轮）

这轮的目标是「行数 = 全部品种」那面 400 格的墙。先说一个**测量陷阱**，不然全是白忙。

### 0. 长墙的"卡"有一大半是渲染后端的假象

同一段滚动，换 Chrome 启动参数，帧间隔差十倍：

| 启动参数 | 帧间隔中位数 |
|---|---|
| `--use-angle=swiftshader`（截图用的那套） | **~470ms** |
| `--disable-gpu` | ~53ms |
| 默认（硬件） | **~34ms** |

所以：**截图必须用 swiftshader（否则 canvas 发黑），性能必须用默认或 `--disable-gpu`，
两套参数不能混用**。我一开始用截图那套参数量长墙，得出「300ms/帧」的结论，
差点去优化一个不存在的问题。

### 1. 行高缓存：去掉每帧的强制布局

`syncMount()` 每帧都读 `cells[0].el.offsetHeight` —— 同步读，等于每帧强制浏览器
把 400 个格子的 grid 重新布局一遍。改成缓存 `this.rowH`，只在 resize / applyLayout 时失效。
（实测布局本身只要 0.7ms，所以它不是大头，但每帧强制布局是隐患。）

### 2. 先挂"看得见"的，再挂缓冲行

原来挂载顺序是索引序 `[from, to)`，而 `from` 比可视区早两行。
冷门区一屏 20 个请求，先喂给看不见的缓冲行，用户盯着的那几格反而排最后。
改成按「离可视区的距离」排序挂载。

### 3. K 线请求闸门 —— 以及一个必须记住的坑

一屏 20 个格子同时 mount 会同时发 20 个 K 线请求，走代理互相抢带宽。
加了并发闸门（8 个在飞，其余排队），卸载/切周期时排队中的任务会被跳过。
取 8 是因为默认 2×4 墙正好 8 格：首屏一轮放完，长墙才会真正限流。

**踩的坑**：第一版里"过期任务"是这样写的：

```js
if (isStale && isStale()) { resolve(null); return; }   // ← 队列就停在这了
```

过期任务让出位置后就没人去捞下一个了。实测 `active:0 / queued:47`，
整面墙永远「加载中」。改成「入队后统一 `pump()`」，过期任务靠 while 循环自然跳过。

调试钩子：页面控制台执行 `__klineStats()` 返回 `{active, queued}`。

### 4. fetch 统一 30 秒超时

`api.json` 加了 `AbortSignal.timeout(30000)`。代理挂住时至少会失败（触发格子的重试），
而不是永远停在「加载中」。

### 5. 实测（服务端 K 线缓存热）

| 场景 | 之前 | 之后 |
|---|---|---|
| 滚到冷门区，整屏 20 格出图 | 队列卡死，一直「加载中」 | 首格 ~1s / 半屏 ~1s / 全屏 **2.1s** |

> 冷启动（服务端没缓存）时单次 K 线走代理是 1.5~5 秒，20 格无论怎么排都要十几秒——
> 这个只能靠缓存和预取，不是前端能解决的。

### 6. 工具链教训（血泪）

**不要用 PowerShell 的 `Get-Content` / `Set-Content` 改源码文件。**
这轮我用 `Set-Content` 替换一个常量，中文按 GBK 写回，文件直接变成语法错误
（`K线加载失�?`），只能从 `backup/` 恢复再重做一遍改动。
改源码只用编辑工具，或者 Python 显式 `encoding='utf-8'`。

---

## 2026-11-05 17:00 · 启动时间 + 一次被推翻的优化（第 19 轮）

### 1. 启动时间是以前完全没量过的指标

| 节点 | 改前 | 改后 |
|---|---|---|
| 双击 exe → 端口可用（`/api/status` 200） | 2.4s | **2.0s** |
| 双击 exe → Chrome 窗口出现 | 2.6s | **2.2s** |
| 双击 exe → 页面连上（SSE 连上，实际能看） | ~5.6s | ~5.7s（持平） |

拆解这 5.7 秒：

```
PyInstaller onefile 解包   ~1.5s   ← 在 Python 代码跑起来之前，日志里看不到
导入 server + 读缓存 + 探代理 ~0.3s
Chrome 启动                ~1.0s
页面拉 /api/market + 8 张图  ~1.5s
```

### 2. 改了什么：服务与窗口并行启动

- `server.build_server()` **开头就 `Server((host, port), Handler)` 绑端口**，
  再做慢的初始化（读板块表、探测代理、拉起四条流），最后返回。
  HTTPServer 构造里已经 `server_bind + listen`，早到的连接会排队。
- `desktop.py` 把 `build_server` 放进线程，**立刻**开窗口，再等 ready。
- 前端 `marketReq` 加了 16 次 × 350ms 的重试：窗口可能比服务早到几百毫秒，
  但绝不能因此弹「无法连接本地服务」。

窗口提前约 0.4 秒。剩下最大的 1.5 秒是 onefile 解包——换 onedir 能省掉，
但会从「一个 9MB 的 exe」变成「一个文件夹」，README 里单文件是卖点，不动。

### 3. 一次被数据推翻的优化（必须记下来）

我一度认为长墙空闲时「每 10 秒 35 个 `>50ms` 长任务」是格子图例的 `mask-image` 造成的：
A/B 测出来 44 个 → 4 个，差得非常像。于是把渐隐删了。

后来发现**测量窗口压在加载期**：滚到冷门区之后 1~6 秒内还在挂图、拉 K 线、画指标，
量到的根本不是"空闲"。改成"等队列清空 + 可见格子都有数据"再测：

- 真空闲：长墙 8 秒 **0~3 个长任务**，帧间隔 7ms；
- 带 mask / 不带 mask **没有区别**（交替 A/B 三轮全是 0）。

结局：渐隐效果原样恢复，那次改动整个回滚。

**教训**：测"空闲开销"必须先证明真的空闲（请求队列空、画面不再变化），
否则测到的是加载过程。差点为了一个不存在的问题把效果删掉。

### 4. 顺带：一个我自己引入的 bug（已回滚）

给缓冲行加"不刷新"标记时，我把标记写在 `mount()` **之前**——新挂的格子那一刻
`mounted` 还是 false，结果 `live` 全是 0，整面墙再也不刷新。是靠探针里
`live: 0` 这个数字发现的（如果只截图，画面看起来完全正常）。

**结论**：这种"看起来只是优化"的改动，必须验证**状态确实在变**，不能只看渲染结果。

---

## 2026-11-05 17:20 · 启动回归工具 + 两个看得见的细节（第 20 轮）

### 1. 新增 `tools/startup.mjs`：把「双击 exe 到能看」变成可复现的数字

```
node tools/startup.mjs        # 测 dist/BinanceTerminal.exe（要求 8848 空闲）
node tools/startup.mjs --keep # 测完不关，看现场
node tools/startup.mjs --dev  # 测开发版（自己先起 server.py）
```

输出三个时间点：端口可用 / 窗口出现 / 页面连上。实测（本机、冷启动）：

| 节点 | 时间 |
|---|---|
| 端口可用（`/api/status` 200） | 2660 ms |
| 窗口出现（Chrome 进程） | 2520 ms |
| 页面连上（SSE，能看） | 4510 ms |

窗口比服务**早**约 140ms —— 这正是上一轮「服务与窗口并行启动」的效果，工具把它变成了可回归的指标。

**踩的坑**：第一版每 100ms 起一次 PowerShell 查 Chrome 命令行，把被测进程拖慢了一秒多
（量出来 3.2s vs 真实 2.0s）。改成 1 秒查一次，其余用 `fetch` 轮询。

### 2. 横轴最后一个刻度被切掉（每个格子都有）

`fitRange()` 里 `rightOffset: 1`，最后一根 K 线几乎贴住价格轴，于是横轴最后的
`17:00` 被裁成 `17:0(`。每个格子都这样，看着很毛糙。

```js
const rightOffset = Math.max(1, Math.round(16 / spacing));   // 留半个标签的宽度
```

验证方式：截一格的时间轴区域放大 3 倍对比，改前是 `17:0(`，改后完整显示 `17:00`。

### 3. 格子的加载态：一行"加载中…" → 小转圈 +「载入 K 线」

长墙滚到冷门区时会同时有 20 个格子在等数据，原来每个格子就一行灰字，
看着像"空盒子"。改成居中的小转圈（`transform` 动画，走合成层）+ 10.5px 标签，
遮罩从 72% 降到 55% 不透明度，表头的价格/涨跌还看得见。

---

## 2026-11-05 17:20 · 接回 WorkBuddy 第一轮（第 21 轮）

### 0. 先补版本库

DSH 那台环境没有 `git.exe`，第 15~20 轮全是未提交的工作区改动（16 个文件、1071 行）。
切回来第一件事就是提交（`8507539`），否则那 6 轮随时可能丢。
`git` 在本机可用，之后每轮照旧提交。

### 1. 列表行密度（交接清单第 1 项）

三档：紧凑 26 / 标准 30 / 宽松 34，工具栏「行高」按钮开菜单选，`state.rowH` 持久化。

**关键约束**（交接文档点名过）：`--row-h`（CSS）和 `ROW_H`（虚拟滚动步长）必须同源。
做法是 `List.applyRowH()` 一处同时写 CSS 变量和 `this.rowH`，
`ROW_H` 常量拆成 `ROW_H_MIN/MAX`，所有用到的地方改读 `this.rowH`。

**额外发现**：26px 时两行式币种名（`BTC` + `USDT 永续`）内容高 25px，上下只剩 1px，
实测 `scrollHeight` 溢出 2px。加 `data-dense="1"` 把 `.nm` 行距压到 1、
字号 11.5/9px，内容降到 21px，余量回到 5px。3.4 倍放大截图确认无裁切。

实测：三档下 `rowPx`、`--row-h`、行间距、`inner` 高度全部一致；滚动后
首行 `style.top` 与 `index × rowH` 完全吻合（104×34 = 3536）。

### 2. 四个「看起来该优化」的点，实测后都不需要动

按交接文档「改之前先跑，别凭感觉」，把剩下的怀疑逐条量了一遍：

| 疑点 | 实测 | 结论 |
|---|---|---|
| 切周期慢（perf 报 1079ms） | 热态 5~33ms（5m 33 / 1m 5 / 15m 19 / 1h 21） | perf 那次数的是全新 profile、预取还没跑完。**不回退** |
| 侧板开合 37.7ms/帧、4 个长任务 | 打点：`setDetail` 同步只花 1ms，`applySize` 调用 0 次，**0 个长任务** | perf 的长任务是启动期图表初始化混进来的，正是文档提醒的测量陷阱 |
| 列宽把 `资金费率` 截成 `-0.006…` | 7 种宽度 × 38 行遍历，`scrollWidth - clientWidth` 全部 ≤1 | 无截断，之前截图是布局未重算的瞬时态 |
| 滚动时行情文字刷新拖慢帧 | A/B：有刷新 35.2ms/帧，关掉 31.7ms | 只占约 3ms（10%），主成本在滚动本身。收益不足以冒「价格冻结」风险 |

### 3. 大图绘图工具栏加分隔线

交接清单第 2 项。放大 4 倍看，7 个图标（24×22 按钮、12px 间距）本身不挤，
真正的问题是「持仓量 / 盘口」两个 chip 和绘图组**颜色相同、挨在一起**，看不出是两组。
在中间补一个 `.vdiv`（和工具栏里已有的分隔线同款），不动布局、不加控件。

### 4. 没做的两项及原因

- **长墙暂停刷新**：文档自己的数据是「空闲 8 秒 0~3 个长任务、帧间隔 7ms」，
  暂停能省的接近 0。加个开关反而增加一个「看起来冻结了」的误解入口。
- **指标参数可调**：这是功能不是优化（要定 UI、要迁移已有指标实例），
  不在「接手继续做优化」的范围内。

**现状**：`node tools/e2e.mjs` **25/25**（新增「列表行高」用例）。

---

## 2026-11-05 17:55 · 便携分发包（第 22 轮）

用户要「给别的电脑解压就能用」的压缩包。

### 先说结论：exe 本来就是自包含的

PyInstaller onefile 把 Python 运行时、`index.html`、`assets/` 全塞进那一个 exe，
窗口用的是 **Chrome/Edge 的 `--app` 模式**（不是 pywebview），
所以目标机器**不需要装 Python**，有 Edge 就行（Win10/11 自带）。
缓存和日志写 `%LOCALAPPDATA%\BinanceTerminal`，解压目录只读也能跑。

实测：把 exe 单独复制到空目录、`BT_PORT=8899` 启动 → 1 秒出端口，
首页 / 静态资源 / 行情流全部正常。

### 唯一的真问题：合约要代理，而对方不会设环境变量

原来只支持 `BINANCE_PROXY` 环境变量 + 自动探测常见端口。
给别人用的话，代理端口不在那 7 个里就完全没辙。

补了 **`proxy.txt`**：

- 查找顺序：`sys.executable` 所在目录（exe 同目录）→ `%LOCALAPPDATA%\BinanceTerminal`
- 一行 `host:port`，`#` 开头是注释，`utf-8-sig` 读（记事本存的 BOM 不影响）
- 留空/全注释 → 退回原来的自动探测，行为不变

**坑**：冻结后 `ROOT` 是 `sys._MEIPASS`（临时解包目录，只读且每次变），
配置不能放那儿，必须用 `os.path.dirname(sys.executable)`。

实测：把 `127.0.0.1:10808` 写进 exe 同目录的 `proxy.txt`，
日志打「使用配置文件 C://...//pkgtest//proxy.txt 指定的代理 127.0.0.1:10808」，合约流 ok。

### 打包流程固化

`python tools/pack.py`：构建 exe → 组装 `dist/package/币安看盘终端/` → 压 zip。
`--skip-build` 复用现有 exe。文案模板放 `packaging/`（仓库里），
不要改 `dist/package` 里的副本。

两个编码细节：

- **zip 用 Python `zipfile` 写**，会给中文名打 UTF-8 标志位（`flag_bits & 0x800`），
  资源管理器解压不乱码。用 GBK 的老压缩包在别人机器上会变问号。
- `使用说明.txt` 存成 **UTF-8 + BOM + CRLF**（老记事本才不会把中文认成 GBK）；
  `设置代理.bat` 存成 **UTF-8 无 BOM**（配合 `chcp 65001`，和仓库里已有的 bat 一致）。

### 产物

`dist/币安看盘终端_2026-11-05.zip`，8.33 MB，内含：

| 文件 | 说明 |
|---|---|
| `BinanceTerminal.exe` | 8.5 MB，主程序 |
| `使用说明.txt` | 运行要求 / 代理 / 数据目录 / 常见问题 |
| `设置代理.bat` | 交互式写 proxy.txt |
| `proxy.txt` | 模板（全注释） |

验证：解压到**含空格和中文的路径**（`D://WorkBuddy AI\...\币安看盘终端`）→
1 秒出端口、页面正常、1867 个交易对、`fut: ok`。

---

## 交接：剩余工作（2026-11-05 17:30，从 DSH 切回 WorkBuddy）## 交接：剩余工作（2026-11-05 17:30，从 DSH 切回 WorkBuddy）## 交接：剩余工作（2026-11-05 17:30，从 DSH 切回 WorkBuddy）

这一段由 DeepSeek Harness 接手做了 6 轮（第 15~20 轮），**功能没加，全是性能、流畅度和观感**。
现在切回 WorkBuddy 继续，先看这里。

### 当前状态

- `node tools/e2e.mjs`：**24/24 通过**（最后一次全量；之后又改了两处，受影响的用例单独跑过绿）
- exe：`dist/BinanceTerminal.exe` 已用最新源码重新打包（17:12）
- 备份：`backup/2026-11-05_1625 / 1645 / 1700 / 1720 / 1730`
- **本机没有 `git.exe`**（.git 目录在，但命令不可用），所以一直靠 `backup/` 快照

### 四个测量工具（改之前先跑，别凭感觉）

| 工具 | 用途 | 基线（本机） |
|---|---|---|
| `node tools/e2e.mjs` | 功能回归，24 用例，约 2 分钟 | 24/24 |
| `node tools/perf.mjs` | 首屏 / 切周期 / 列表滚动 / 面板开合 / 长任务 | 首屏行情 0.6s；列表滚动 16.9 ms/帧；面板开合热态 0~1 个长任务 |
| `node tools/shots.mjs before|after` | 改界面前后截图对比（**必须 swiftshader**） | `.shots/` |
| `node tools/startup.mjs` | 双击 exe → 端口 / 窗口 / 页面连上 | 2.66s / 2.52s / 4.51s |

### 剩下的可选优化（按性价比排）

1. **列表行密度切换**（29→ 30px 已经比较紧；若要 28px/34px 两档，
   必须**同时**改 `assets/css/app.css` 的 `--row-h` 和 `list.js` 的 `ROW_H`，两者不一致会错位）
2. **大图绘图工具栏**：8 个 13px 图标挤在一起，可以加文字/tooltip 分组或折叠
3. **指标参数可调**（MA 周期、BOLL 带宽、MACD 快慢线）——现在是写死的
4. **长墙「暂停刷新」**：32 张图同时刷时给个省电开关（注意：做完要验状态确实冻结，
   别像上次那样 `live` 标记写错位置导致整面墙不刷新）
5. **装 git 并提交**：比任何优化都该先补，现在没有任何版本回退能力

### 三条最容易重犯的坑（都已写进上面各节）

1. **测长墙性能不能用 `--use-angle=swiftshader`**（截图必须用它）：同一段滚动
   软件渲染 470ms/帧、硬件 34ms/帧，差了 10 倍。
2. **测「空闲开销」必须先确认真的空闲**：请求队列空 + 画面不再变化。
   我因为没等，误判 mask-image 是元凶，白删了一次效果又恢复。
3. **不要用 PowerShell 的 `Get-Content`/`Set-Content` 改源码**：中文会按 GBK 写回，
   文件直接语法错误（`K线加载失�?`）。用编辑器工具或 Python `encoding='utf-8'`。

---

## 可扩展的方向

- 合约 K 线叠加持仓量曲线（OI 变化往往领先价格）
- 画线工具、指标自定义参数
- 多显示器分屏
- 导出/告警（资金费率突破阈值提醒是个高频需求）

---

## 现状（2026-11-04 21:45）

- 服务在 8848 跑着，现货 1010 + 永续 791 = 1801 个交易对
- 合约衍生指标：资金费率 945 个合约、持仓量、多空比、费率历史
- 多品种同列：自动取景（铺满 + 右对齐）、行高保底 220px 可纵向滚动、右侧详情侧板（默认收起）
- 大图模式：双击进入，趋势线/水平线/矩形/斐波那契 + 十字光标 OHLC 明细
- 全站绿涨红跌（美国模式）
- 永续扫描器：791 个合约按年化费率/基差/成交额排序
- 资金费率告警：阈值可调，只报新突破的
- 大图：持仓量叠加、右侧盘口栏、左右键翻品种、绘图拖动 + Ctrl+Z
- 合约盘口 100ms 实时（WebSocket），不再是 4 秒轮询
- 列表：现货 / 永续两级分类，盘口默认 8 档可展开
- 无已知 bug
- 备份：`backup/2026-11-04_1730/`（加合约指标前，**回退两轮改动都用它**）、
  `backup/2026-11-04_1830/`（本轮取景/滚动/两级分类改完后的快照）、
  `backup/2026-11-04_2110/`（加详情侧板 + 盘口档位之前）、
  `backup/2026-11-04_2130/`（大图模式 + 绿涨红跌之前）
