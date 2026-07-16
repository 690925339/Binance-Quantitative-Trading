# 每日纸面模拟盘

该模拟盘从实际启动日开始记录85%横截面市场中性动量与15%动态趋势组合，不回填启动日前收益，也不会调用任何下单接口。

## 时间与行情口径

- 时区：Asia/Shanghai。
- 每日结算时间：09:00。
- 信号数据：结算日前已经完整结束的UTC日线。
- 模拟估值和调仓价格：09:00刚闭合的 `00:00–00:59 UTC` 一小时K线收盘价。
- 行情接口：Binance公开市场数据接口，不需要API Key。
- 月中启动的首月标记为不完整月份，不纳入盈利月准确率；下一个自然月才是首个完整前向月份。

## 资金与成本

首次启动默认本金为10,000 USDT。策略配置页面中的2×杠杆只代表保证金容量，不会再次乘到策略权重上。

模拟盘沿用回测成本：

- 每单位换仓成本：7 bps。
- 每日持仓成本：总绝对敞口的0.5 bps。
- 组合首次从现金分配到85/15两个仓位时，另计7 bps配置成本。

首次运行只建立仓位基线，因此价格盈亏为0，但会显示建仓模型成本。

## 运行

手工结算：

```powershell
npm.cmd run paper:daily
```

显示Windows通知：

```powershell
npm.cmd run paper:daily:notify
```

安装每天09:00运行的Windows任务：

```powershell
npm.cmd run paper:install-task
```

任务名称为 `BinanceQuantPaperDaily0900`，使用当前Windows用户、最低权限和交互式登录方式。用户未登录时不会显示通知；重新登录或网络恢复后，任务配置的“尽快补跑”会尝试补算遗漏日期。

## 持久化与幂等

- 主状态：`data/runtime/monthly-accuracy-paper.json`
- 最新日报：`data/runtime/paper-reports/latest.md`
- 每日JSON：`data/runtime/paper-reports/YYYY-MM-DD.json`

状态通过临时文件和原子重命名写入，并使用跨进程锁避免两个任务同时结算。已经处理过的日期不会重复计算盈亏、成本或换仓。

## 页面和接口

- 网页入口：首页“模拟盘”。
- `GET /api/paper-portfolio`：当前净值、累计盈亏、最大回撤、持仓与日报。
- `GET /api/paper-portfolio/reports?limit=30`：最近已经封账的日报。

页面只读取持久化结果；即使浏览器或本地Web服务没有保持打开，Windows任务仍可独立结算。

## 风险边界

这是固定成本假设下的纸面结果，不包含永续合约实际资金费率、基差、盘口深度、部分成交、强平或多腿失败。纸面盈利不能直接视为可实现收益，至少需要6至12个月新的前向样本后再决定是否进入小额实盘评估。
