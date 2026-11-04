# 项目交接文档 · 币安本地看盘终端

> 这份文档写给"下一个接手的人（或 AI）"，读完应该能立刻上手改代码。
> 最后更新：2026-11-04 23:35

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

**改完必须跑**：`node tools/e2e.mjs`（19 个用例，约 90 秒）。服务要先跑起来。
这套脚本是第 14 轮加的，覆盖页面加载、配色、两个视图、大图全流程、绘图、扫描器、告警、持仓量。

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
