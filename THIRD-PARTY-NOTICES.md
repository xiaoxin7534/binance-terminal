# 第三方组件与许可

本项目自身代码以 MIT 许可发布（见 `LICENSE`）。分发包里还包含下列第三方代码，
它们各自保留原有许可。

## TradingView Lightweight Charts™

- 版本：5.2.1（`assets/js/vendor/lightweight-charts.standalone.production.js`）
- 版权：Copyright (c) 2026 TradingView, Inc.
- 许可：**Apache License 2.0**
- 许可证全文：`licenses/Apache-2.0.txt`
- 项目主页：https://github.com/tradingview/lightweight-charts

该库的许可头保留在 vendor 文件顶部（`@license ... Licensed under Apache License 2.0`），
打包进 exe 时一并带上，未做删改。Apache 2.0 要求随分发提供许可证副本，
因此 `licenses/Apache-2.0.txt` 一并保留在仓库中。

## Inter（数字字体）

- 版本：5.x latin 子集（`assets/fonts/inter-400/500/600.woff2`）
- 版权：Copyright (c) 2016 The Inter Project Authors
- 许可：**SIL Open Font License 1.1**
- 许可证全文：`licenses/Inter-OFL.txt`
- 项目主页：https://github.com/rsms/inter

只取了 latin 子集的 400/500/600 三个字重（约 72KB），用于价格、涨跌幅等数字显示。
选它是因为 macOS 的 SF Pro 不能随项目分发，而 Inter 是字形最接近的开源替代。

## 说明

- 行情数据来自币安公开接口（`api.binance.com` / `fapi.binance.com` / `wss://stream.binance.com`），
  本项目不分发任何行情数据。
- 「币安」「Binance」是币安的商标，本项目与其无隶属关系，仅调用其公开行情接口。
- 本项目只读行情、不下单，不接触任何账户与资金。
