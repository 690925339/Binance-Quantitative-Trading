const DAYS_PER_YEAR = 365;

export const SELECTIVE_TRADE_DEFAULTS = Object.freeze({
  trendLookbackDays: 63,
  pullbackLookbackDays: 3,
  minimumTrendPercent: 0.03,
  pullbackThresholdPercent: 0.01,
  takeProfitPercent: 0.015,
  stopLossPercent: 0.04,
  maxHoldingDays: 10,
  riskPerTrade: 0.005,
  maxAssetExposure: 0.15,
  maxGrossExposure: 0.45,
  maxConcurrentTrades: 3,
  tradingCostRate: 0.0007,
  dailyCarryCostRate: 0.00005,
});

export const SELECTIVE_TRADE_RELEASE_TARGETS = Object.freeze({
  minimumWinRate: 0.8,
  minimumWinRateWilson95Lower: 0.6,
  minimumTrades: 30,
  minimumDirectionTrades: 5,
  minimumProfitFactor: 1.2,
  minimumAnnualizedReturn: 0.05,
  maximumAnnualizedReturn: 0.1,
  maximumDrawdown: -0.15,
});

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function wilsonLowerBound(successes, total, z = 1.96) {
  if (!total) return 0;
  const probability = successes / total;
  const zSquared = z ** 2;
  const denominator = 1 + zSquared / total;
  const centre = probability + zSquared / (2 * total);
  const margin = z * Math.sqrt((probability * (1 - probability) + zSquared / (4 * total)) / total);
  return (centre - margin) / denominator;
}

function mergeOptions(options) {
  const settings = { ...SELECTIVE_TRADE_DEFAULTS, ...options };
  for (const key of ['trendLookbackDays', 'pullbackLookbackDays', 'maxHoldingDays', 'maxConcurrentTrades']) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new Error(`${key} 必须是正整数`);
  }
  if (settings.trendLookbackDays <= settings.pullbackLookbackDays) {
    throw new Error('长期趋势窗口必须大于回撤窗口');
  }
  for (const key of [
    'minimumTrendPercent',
    'pullbackThresholdPercent',
    'takeProfitPercent',
    'stopLossPercent',
    'riskPerTrade',
    'maxAssetExposure',
    'maxGrossExposure',
  ]) {
    if (!Number.isFinite(settings[key]) || settings[key] <= 0 || settings[key] > 1) {
      throw new Error(`${key} 必须在 0 到 1 之间`);
    }
  }
  if (settings.maxAssetExposure > settings.maxGrossExposure) {
    throw new Error('单币敞口不能超过组合总敞口');
  }
  for (const key of ['tradingCostRate', 'dailyCarryCostRate']) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0) throw new Error(`${key} 不能小于 0`);
  }
  return settings;
}

function validateSeries(seriesBySymbol) {
  const entries = Object.entries(seriesBySymbol || {});
  if (entries.length < 2) throw new Error('选择性交易回测至少需要两个交易对');
  const dates = entries[0][1]?.map((item) => item.date);
  if (!dates?.length) throw new Error('行情序列不能为空');
  for (const [symbol, series] of entries) {
    if (!Array.isArray(series) || series.length !== dates.length) throw new Error(`${symbol} 行情长度不一致`);
    series.forEach((item, index) => {
      if (item.date !== dates[index]) throw new Error(`${symbol} 在 ${index} 处的日期未对齐`);
      const values = [item.open, item.high, item.low, item.close];
      if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error(`${symbol} 在 ${item.date} 的 OHLC 无效`);
      }
      if (item.high < Math.max(item.open, item.close) || item.low > Math.min(item.open, item.close)) {
        throw new Error(`${symbol} 在 ${item.date} 的高低价无效`);
      }
    });
  }
  return { dates, entries };
}

function simpleMovingAverage(series, endIndex, windowDays) {
  let sum = 0;
  for (let index = endIndex - windowDays + 1; index <= endIndex; index += 1) sum += series[index].close;
  return sum / windowDays;
}

function buildSignals(entries, signalIndex, settings, occupiedSymbols) {
  return entries.map(([symbol, series]) => {
    if (occupiedSymbols.has(symbol)) return null;
    const current = series[signalIndex].close;
    const trendReturn = current / series[signalIndex - settings.trendLookbackDays].close - 1;
    const pullbackReturn = current / series[signalIndex - settings.pullbackLookbackDays].close - 1;
    const movingAverage = simpleMovingAverage(series, signalIndex, settings.trendLookbackDays);
    let direction = 0;
    if (
      trendReturn >= settings.minimumTrendPercent
      && current > movingAverage
      && pullbackReturn <= -settings.pullbackThresholdPercent
    ) direction = 1;
    if (
      trendReturn <= -settings.minimumTrendPercent
      && current < movingAverage
      && pullbackReturn >= settings.pullbackThresholdPercent
    ) direction = -1;
    if (!direction) return null;
    const confidence = Math.abs(trendReturn) + Math.abs(pullbackReturn);
    return { symbol, direction, confidence, trendReturn, pullbackReturn };
  }).filter(Boolean).sort((left, right) => right.confidence - left.confidence);
}

function exitTrade(trade, bar, index, settings, forced = false) {
  const takeProfitPrice = trade.entryPrice * (1 + trade.direction * settings.takeProfitPercent);
  const stopLossPrice = trade.entryPrice * (1 - trade.direction * settings.stopLossPercent);
  const takeProfitHit = trade.direction > 0 ? bar.high >= takeProfitPrice : bar.low <= takeProfitPrice;
  const stopLossHit = trade.direction > 0 ? bar.low <= stopLossPrice : bar.high >= stopLossPrice;
  const holdingDays = index - trade.entryIndex + 1;
  let exitPrice = null;
  let reason = null;

  if (stopLossHit) {
    exitPrice = stopLossPrice;
    reason = 'stopLoss';
  } else if (takeProfitHit) {
    exitPrice = takeProfitPrice;
    reason = 'takeProfit';
  } else if (forced || holdingDays >= settings.maxHoldingDays) {
    exitPrice = bar.close;
    reason = forced ? 'periodEnd' : 'timeExit';
  }
  if (exitPrice === null) return null;

  const grossDirectionalReturn = trade.direction * (exitPrice / trade.entryPrice - 1);
  const costRate = settings.tradingCostRate * 2 + settings.dailyCarryCostRate * holdingDays;
  const netReturn = grossDirectionalReturn - costRate;
  return {
    ...trade,
    exitDate: bar.date,
    exitPrice: round(exitPrice),
    holdingDays,
    reason,
    grossDirectionalReturn: round(grossDirectionalReturn),
    netReturn: round(netReturn),
    pnl: round(trade.notional * netReturn),
    win: netReturn > 0,
  };
}

function currentTradeReturn(trade, close, index, settings) {
  const holdingDays = index - trade.entryIndex + 1;
  return trade.direction * (close / trade.entryPrice - 1)
    - settings.tradingCostRate * 2
    - settings.dailyCarryCostRate * holdingDays;
}

function summarize(trades, equityCurve, period) {
  const wins = trades.filter((trade) => trade.win);
  const losses = trades.filter((trade) => !trade.win);
  const longTrades = trades.filter((trade) => trade.direction > 0);
  const shortTrades = trades.filter((trade) => trade.direction < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const finalEquity = equityCurve.at(-1)?.equity ?? 1;
  const elapsedDays = Math.max(1, (Date.parse(period.endDate) - Date.parse(period.startDate)) / 86_400_000);
  let peak = 1;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
  }
  return {
    tradeCount: trades.length,
    winRate: round(trades.length ? wins.length / trades.length : 0),
    winRateWilson95Lower: round(wilsonLowerBound(wins.length, trades.length)),
    longTradeCount: longTrades.length,
    longWinRate: round(longTrades.length ? longTrades.filter((trade) => trade.win).length / longTrades.length : 0),
    shortTradeCount: shortTrades.length,
    shortWinRate: round(shortTrades.length ? shortTrades.filter((trade) => trade.win).length / shortTrades.length : 0),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0),
    averageWin: round(mean(wins.map((trade) => trade.netReturn))),
    averageLoss: round(mean(losses.map((trade) => trade.netReturn))),
    payoffRatio: round(losses.length && mean(losses.map((trade) => trade.netReturn)) < 0
      ? mean(wins.map((trade) => trade.netReturn)) / Math.abs(mean(losses.map((trade) => trade.netReturn)))
      : 0),
    expectancy: round(mean(trades.map((trade) => trade.netReturn))),
    averageHoldingDays: round(mean(trades.map((trade) => trade.holdingDays))),
    totalReturn: round(finalEquity - 1),
    annualizedReturn: round(finalEquity > 0 ? finalEquity ** (DAYS_PER_YEAR / elapsedDays) - 1 : -1),
    maxDrawdown: round(maxDrawdown),
  };
}

export function runSelectiveTradeBacktest(seriesBySymbol, options = {}, period = {}) {
  const settings = mergeOptions(options);
  const { dates, entries } = validateSeries(seriesBySymbol);
  const warmupDays = settings.trendLookbackDays + 1;
  const startDate = period.startDate || dates[warmupDays];
  const endDate = period.endDate || dates.at(-1);
  if (startDate >= endDate) throw new Error('回测开始日期必须早于结束日期');

  let realizedEquity = 1;
  let openTrades = [];
  const trades = [];
  const equityCurve = [];

  for (let index = warmupDays; index < dates.length; index += 1) {
    const date = dates[index];
    if (date < startDate || date > endDate) continue;
    const occupiedSymbols = new Set(openTrades.map((trade) => trade.symbol));
    const availableSlots = settings.maxConcurrentTrades - openTrades.length;
    if (availableSlots > 0) {
      const signals = buildSignals(entries, index - 1, settings, occupiedSymbols).slice(0, availableSlots);
      const currentGross = openTrades.reduce((sum, trade) => sum + trade.notional, 0);
      let availableGross = Math.max(0, realizedEquity * settings.maxGrossExposure - currentGross);
      for (const signal of signals) {
        const series = Object.fromEntries(entries)[signal.symbol];
        const allocation = Math.min(settings.maxAssetExposure, settings.riskPerTrade / settings.stopLossPercent);
        const notional = Math.min(realizedEquity * allocation, availableGross);
        if (notional <= 0) break;
        openTrades.push({
          ...signal,
          entryDate: date,
          entryIndex: index,
          entryPrice: series[index].open,
          notional,
        });
        availableGross -= notional;
      }
    }

    const remaining = [];
    for (const trade of openTrades) {
      const series = Object.fromEntries(entries)[trade.symbol];
      const closed = exitTrade(trade, series[index], index, settings, date === endDate);
      if (closed) {
        realizedEquity += closed.pnl;
        trades.push(closed);
      } else {
        remaining.push(trade);
      }
    }
    openTrades = remaining;
    const markToMarket = openTrades.reduce((sum, trade) => {
      const series = Object.fromEntries(entries)[trade.symbol];
      return sum + trade.notional * currentTradeReturn(trade, series[index].close, index, settings);
    }, 0);
    equityCurve.push({ date, equity: round(realizedEquity + markToMarket) });
  }

  return {
    strategy: '趋势回撤高胜率多空组合',
    symbols: entries.map(([symbol]) => symbol),
    period: { startDate, endDate },
    settings,
    metrics: summarize(trades, equityCurve, { startDate, endDate }),
    trades,
    equityCurve,
  };
}

export function rankSelectiveTradeCandidates(seriesBySymbol, candidates, period, constraints = {}) {
  const minimumTrades = constraints.minimumTrades ?? 20;
  const minimumDirectionTrades = constraints.minimumDirectionTrades ?? 3;
  const minimumProfitFactor = constraints.minimumProfitFactor ?? 1;
  const maximumDrawdown = constraints.maximumDrawdown ?? -0.2;
  return candidates.map((settings) => runSelectiveTradeBacktest(seriesBySymbol, settings, period))
    .filter((result) => (
      result.metrics.tradeCount >= minimumTrades
      && result.metrics.longTradeCount >= minimumDirectionTrades
      && result.metrics.shortTradeCount >= minimumDirectionTrades
      && result.metrics.profitFactor >= minimumProfitFactor
      && result.metrics.maxDrawdown >= maximumDrawdown
    ))
    .sort((left, right) => {
      const lowerBoundDifference = right.metrics.winRateWilson95Lower - left.metrics.winRateWilson95Lower;
      if (lowerBoundDifference) return lowerBoundDifference;
      const profitFactorDifference = right.metrics.profitFactor - left.metrics.profitFactor;
      if (profitFactorDifference) return profitFactorDifference;
      return right.metrics.annualizedReturn - left.metrics.annualizedReturn;
    });
}

export function evaluateSelectiveTradeRelease(metrics, targets = {}) {
  const settings = { ...SELECTIVE_TRADE_RELEASE_TARGETS, ...targets };
  const checks = {
    winRate: metrics.winRate >= settings.minimumWinRate,
    winRateWilson95Lower: metrics.winRateWilson95Lower >= settings.minimumWinRateWilson95Lower,
    trades: metrics.tradeCount >= settings.minimumTrades,
    longTrades: metrics.longTradeCount >= settings.minimumDirectionTrades,
    shortTrades: metrics.shortTradeCount >= settings.minimumDirectionTrades,
    profitFactor: metrics.profitFactor >= settings.minimumProfitFactor,
    positiveExpectancy: metrics.expectancy > 0,
    minimumAnnualizedReturn: metrics.annualizedReturn >= settings.minimumAnnualizedReturn,
    maximumAnnualizedReturn: metrics.annualizedReturn <= settings.maximumAnnualizedReturn,
    maximumDrawdown: metrics.maxDrawdown >= settings.maximumDrawdown,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    targets: settings,
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}
