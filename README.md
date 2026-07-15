# QuantFlow 币安量化交易基础版

一个面向手机浏览器的 Binance Spot Testnet 交易测试台。当前版本优先验证最小技术闭环：公开行情、HMAC API 签名、账户余额和测试下单。策略只展示 MA5/MA20 观察信号，不会自动下单。

## 当前能力

- 手机 H5 仪表盘，支持 BTC、ETH、BNB、SOL 对 USDT 行情
- 15 分钟 K 线收盘价趋势和 MA5/MA20 观察信号
- Binance Spot Testnet API Key 连接与权限验证
- 测试网非零资产查询
- 市价测试订单校验，调用 `/api/v3/order/test`，不进入撮合
- API Secret 仅保存在 Node 进程内存，不写入浏览器存储、文件或日志
- 可配置策略中心：现货网格、马丁补仓、定期定投和双均线趋势
- 策略配置支持创建、编辑、启停观察、复制和删除，并持久化到 `data/config/strategies.json`
- 同源 HttpOnly 会话、请求限流、请求体限制和基础安全响应头
- 零第三方运行依赖，Node.js 20+ 可直接启动

## 策略配置中心

当前提供四类基础模板：

- 现货网格：模式、上下限、网格数量、计划投入、止盈和止损均可配置。
- 马丁补仓：首单、安全单、回撤触发、金额倍率、间距倍率、补仓次数和资金上限均可配置。
- 定期定投：单次投入、时间间隔、执行次数、组合止盈止损和资金上限均可配置。
- 双均线趋势：K线周期、快慢均线、信号资金、最大仓位和单仓止盈止损均可配置。

“启用”仅表示策略进入观察状态。当前版本不会根据这些配置自动调用下单接口；后续回测和执行器应读取同一份策略配置，并在真实下单前根据 Binance `exchangeInfo` 再校验价格步长、数量步长和最小名义价值。

## 快速开始

1. 安装 Node.js 20 或更新版本。
2. 在项目目录运行：

   ```powershell
   npm.cmd start
   ```

3. 手机与电脑在同一局域网时，可设置监听地址后启动：

   ```powershell
   $env:HOST='0.0.0.0'
   npm.cmd start
   ```

4. 电脑浏览器访问 `http://127.0.0.1:3173`。手机访问电脑的局域网 IP，例如 `http://192.168.1.10:3173`。

## 配置 Binance Spot Testnet

1. 打开 [Binance Spot Test Network](https://testnet.binance.vision/) 并登录。
2. 创建测试网 HMAC API Key，按测试需要开启交易权限。
3. 在 QuantFlow 的“设置”页面填写测试网 API Key 与 Secret Key。
4. 连接成功后先检查“资产”，再到“交易”提交测试订单。

不要填写正式网 API Key。测试网资产没有真实价值，且 Spot Testnet 会不定期重置。

## 验证

```powershell
npm.cmd run check
```

测试覆盖签名算法、签名请求参数、Binance 错误转换、健康检查、静态首页和私有接口会话保护。

## 历史行情与回测数据

下载默认六个主流交易对从 2023-01-01 起的现货 1 小时 K 线：

```powershell
npm.cmd run data:download
```

默认交易对为 `BTCUSDT、ETHUSDT、BNBUSDT、SOLUSDT、XRPUSDT、DOGEUSDT`，输出目录为 `data/market/spot/1h/`。每个 CSV 包含 UTC 时间、OHLC、基础资产成交量、成交额、成交笔数和主动买入量，并生成带 SHA-256 与连续性检查的 `manifest.json`。

自定义示例：

```powershell
node scripts\download-market-data.mjs --symbols BTCUSDT,ETHUSDT --interval 4h --start 2020-01-01 --end 2025-12-31
```

历史数据来自 Binance 公共正式市场行情接口，不需要 API Key，也不会访问或修改账户。回测时应使用 `open_time` 排序，并避免把尚未收盘的 K 线作为信号输入。

生成带覆盖范围、质量检查、数据源和日线汇总的 Excel 索引工作簿：

```powershell
npm.cmd run data:workbook
```

复核 CSV 行数、首末时间、SHA-256 和 UTF-8 无 BOM：

```powershell
npm.cmd run data:verify
```

## 安全边界

这是可本地测试的基础版，不是可直接经营的多用户生产系统：

- 目前没有用户注册、登录、数据库和多租户隔离。
- API 凭证只在单个 Node 进程的内存中保存，默认 30 分钟过期，服务重启即清空。
- 局域网测试使用 HTTP；对公网部署前必须配置 HTTPS、安全的反向代理与可信主机。
- 正式交易前必须加入持久化加密、密钥轮换、IP 白名单、二次确认、订单幂等、仓位/损失限制、审计日志、告警与熔断。
- Binance 返回 5xx 或超时时，订单执行状态可能未知；真实下单系统必须主动查询订单状态，不能简单重试。

## 代码结构

```text
public/                    手机端页面、样式和交互
src/binance-client.js      REST 请求、时间同步与 HMAC 签名
src/server.js              同源 Web/API 服务、内存会话与路由
test/                      Node 原生自动化测试
```

## 下一阶段建议

1. 引入用户系统、PostgreSQL 与 KMS/信封加密，建立真正的多用户密钥隔离。
2. 把策略定义、行情采集、回测、风控、执行器拆成独立边界。
3. 先实现回测和纸面交易，再开放测试网自动交易。
4. 增加最大仓位、单笔风险、日亏损、冷却期、幂等键和全局熔断。
5. 最后才通过显式环境开关接入正式网，并保留人工确认和一键停机。

## 官方参考

- [Binance Spot API 官方文档](https://github.com/binance/binance-spot-api-docs)
- [Binance Spot REST API](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md)
- [Binance 开发者文档](https://developers.binance.com/en/docs/introduction)
