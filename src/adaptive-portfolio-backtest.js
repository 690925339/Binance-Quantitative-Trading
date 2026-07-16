const DAYS_PER_YEAR = 365;

const DEFAULTS = Object.freeze({
  baseTrendWeight: 0.15,
  minimumTrendWeight: 0.15,
  maximumTrendWeight: 0.15,
  stateAllocationEnabled: false,
  stateWindowDays: 20,
  referenceRiskEnabled: false,
  fearGreedMinimum: 20,
  fearGreedMaximum: 80,
  maximumMarketVolatility: 0.80,
  referenceOutsideScale: 0.75,
  drawdownControlStart: null,
  drawdownControlFull: null,
  minimumDrawdownScale: 1,
  allocationTradingCostRate: 0.0007,
});

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0)
    / (values.length - 1));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function mergeOptions(options) {
  const settings = { ...DEFAULTS, ...options };
  for (const key of ['baseTrendWeight', 'minimumTrendWeight', 'maximumTrendWeight']) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1) {
      throw new Error(`${key} 必须在 0 到 1 之间`);
    }
  }
  if (settings.minimumTrendWeight > settings.maximumTrendWeight) {
    throw new Error('minimumTrendWeight 不能超过 maximumTrendWeight');
  }
  if (settings.baseTrendWeight < settings.minimumTrendWeight
    || settings.baseTrendWeight > settings.maximumTrendWeight) {
    throw new Error('baseTrendWeight 必须位于动态趋势权重范围内');
  }
  for (const key of ['stateAllocationEnabled', 'referenceRiskEnabled']) {
    if (typeof settings[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  }
  if (!Number.isInteger(settings.stateWindowDays) || settings.stateWindowDays < 2) {
    throw new Error('stateWindowDays 必须是大于等于 2 的整数');
  }
  for (const key of ['fearGreedMinimum', 'fearGreedMaximum']) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 100) {
      throw new Error(`${key} 必须在 0 到 100 之间`);
    }
  }
  if (settings.fearGreedMinimum > settings.fearGreedMaximum) {
    throw new Error('fearGreedMinimum 不能超过 fearGreedMaximum');
  }
  if (!Number.isFinite(settings.maximumMarketVolatility)
    || settings.maximumMarketVolatility <= 0) {
    throw new Error('maximumMarketVolatility 必须大于 0');
  }
  for (const key of ['referenceOutsideScale', 'minimumDrawdownScale']) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1) {
      throw new Error(`${key} 必须在 0 到 1 之间`);
    }
  }
  const drawdownEnabled = settings.drawdownControlStart !== null
    || settings.drawdownControlFull !== null;
  if (drawdownEnabled) {
    if (!Number.isFinite(settings.drawdownControlStart)
      || settings.drawdownControlStart <= 0
      || settings.drawdownControlStart >= 1) {
      throw new Error('drawdownControlStart 必须大于 0 且小于 1');
    }
    if (!Number.isFinite(settings.drawdownControlFull)
      || settings.drawdownControlFull <= settings.drawdownControlStart
      || settings.drawdownControlFull > 1) {
      throw new Error('drawdownControlFull 必须大于 drawdownControlStart 且不超过 1');
    }
  }
  if (!Number.isFinite(settings.allocationTradingCostRate)
    || settings.allocationTradingCostRate < 0) {
    throw new Error('allocationTradingCostRate 不能小于 0');
  }
  return settings;
}

function dailyReturnMap(result, label) {
  if (!Array.isArray(result?.equityCurve) || result.equityCurve.length < 2) {
    throw new Error(`${label}净值曲线无效`);
  }
  let previousEquity = 1;
  return new Map(result.equityCurve.map((point) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date)
      || !Number.isFinite(point.equity)
      || point.equity <= 0) {
      throw new Error(`${label}净值曲线存在非法记录`);
    }
    const dailyReturn = point.equity / previousEquity - 1;
    previousEquity = point.equity;
    return [point.date, dailyReturn];
  }));
}

function validateMarketSeries(seriesBySymbol) {
  const entries = Object.entries(seriesBySymbol || {});
  if (entries.length < 2) throw new Error('市场状态至少需要两个交易对');
  const dates = entries[0][1]?.map((item) => item.date);
  if (!dates?.length) throw new Error('市场行情不能为空');
  for (const [symbol, series] of entries) {
    if (!Array.isArray(series) || series.length !== dates.length) {
      throw new Error(`${symbol} 行情长度不一致`);
    }
    series.forEach((item, index) => {
      if (item.date !== dates[index]) throw new Error(`${symbol} 行情日期未对齐`);
      if (!Number.isFinite(item.close) || item.close <= 0) throw new Error(`${symbol} 收盘价无效`);
    });
  }
  return {
    dates,
    dateIndex: new Map(dates.map((date, index) => [date, index])),
    symbols: entries.map(([symbol]) => symbol),
    closesBySymbol: Object.fromEntries(entries.map(([symbol, series]) => [
      symbol,
      series.map((item) => item.close),
    ])),
  };
}

function normalizeFearGreedByDate(value) {
  if (value === undefined || value === null) return new Map();
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return new Map(entries.map(([date, item]) => {
    const numericValue = Number(item);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(numericValue)
      || numericValue < 0
      || numericValue > 100) {
      throw new Error(`恐惧指数 ${date} 的值无效`);
    }
    return [date, numericValue];
  }));
}

function marketState(market, signalIndex, fearGreedByDate, settings) {
  const startIndex = signalIndex - settings.stateWindowDays;
  if (startIndex < 0) {
    return {
      available: false,
      breadth: null,
      breadthImbalance: null,
      marketVolatility: null,
      fearGreed: null,
      fearGreedDate: null,
    };
  }
  const basketReturns = [];
  for (let index = startIndex + 1; index <= signalIndex; index += 1) {
    basketReturns.push(mean(market.symbols.map((symbol) => (
      Math.log(market.closesBySymbol[symbol][index] / market.closesBySymbol[symbol][index - 1])
    ))));
  }
  const breadth = market.symbols.filter((symbol) => (
    market.closesBySymbol[symbol][signalIndex] > market.closesBySymbol[symbol][startIndex]
  )).length / market.symbols.length;
  const fearGreedDate = market.dates[signalIndex - 1] || null;
  return {
    available: true,
    breadth,
    breadthImbalance: Math.abs(breadth - 0.5) * 2,
    marketVolatility: sampleStandardDeviation(basketReturns) * Math.sqrt(DAYS_PER_YEAR),
    fearGreed: fearGreedByDate.get(fearGreedDate) ?? null,
    fearGreedDate,
  };
}

function drawdownScale(equity, peakEquity, settings) {
  if (settings.drawdownControlStart === null || settings.drawdownControlFull === null) return 1;
  const magnitude = Math.max(0, 1 - equity / peakEquity);
  if (magnitude <= settings.drawdownControlStart) return 1;
  if (magnitude >= settings.drawdownControlFull) return settings.minimumDrawdownScale;
  const progress = (magnitude - settings.drawdownControlStart)
    / (settings.drawdownControlFull - settings.drawdownControlStart);
  return 1 - progress * (1 - settings.minimumDrawdownScale);
}

function referenceScale(state, settings) {
  if (!settings.referenceRiskEnabled) return 1;
  if (!state.available || !Number.isFinite(state.fearGreed)) return 0;
  const fearOutside = state.fearGreed < settings.fearGreedMinimum
    || state.fearGreed > settings.fearGreedMaximum;
  const volatilityOutside = state.marketVolatility > settings.maximumMarketVolatility;
  return fearOutside || volatilityOutside ? settings.referenceOutsideScale : 1;
}

function summarize(dates, dailyReturns, equities, states) {
  const elapsedDays = Math.max(
    1,
    (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86_400_000,
  );
  const finalEquity = equities.at(-1);
  const annualizedVolatility = sampleStandardDeviation(dailyReturns) * Math.sqrt(DAYS_PER_YEAR);
  let peak = 1;
  let maxDrawdown = 0;
  for (const equity of equities) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return {
    totalReturn: round(finalEquity - 1),
    annualizedReturn: round(finalEquity ** (DAYS_PER_YEAR / elapsedDays) - 1),
    annualizedVolatility: round(annualizedVolatility),
    sharpeRatio: round(annualizedVolatility > 0 ? mean(dailyReturns) * DAYS_PER_YEAR / annualizedVolatility : 0),
    maxDrawdown: round(maxDrawdown),
    averageTrendWeight: round(mean(states.map((item) => item.trendWeight))),
    averageRiskScale: round(mean(states.map((item) => item.riskScale))),
    drawdownScaledDays: states.filter((item) => item.drawdownScale < 1).length,
    referenceScaledDays: states.filter((item) => item.referenceScale < 1).length,
    missingReferenceDays: states.filter((item) => item.referenceMissing).length,
    totalAllocationTurnover: round(states.reduce((sum, item) => sum + item.allocationTurnover, 0)),
  };
}

export function runAdaptivePortfolioBacktest({
  trendResult,
  marketNeutralResult,
  seriesBySymbol,
  fearGreedByDate,
}, options = {}) {
  const settings = mergeOptions(options);
  const trendReturns = dailyReturnMap(trendResult, '趋势仓位');
  const marketNeutralReturns = dailyReturnMap(marketNeutralResult, '市场中性仓位');
  const market = validateMarketSeries(seriesBySymbol);
  const dates = [...trendReturns.keys()].filter((date) => (
    marketNeutralReturns.has(date) && (market.dateIndex.get(date) ?? -1) >= 1
  ));
  if (dates.length < 2) throw new Error('两个策略仓位没有足够的共同日期');
  const fearGreed = normalizeFearGreedByDate(fearGreedByDate);

  let equity = 1;
  let peakEquity = 1;
  let previousAllocations = { trend: 0, marketNeutral: 0 };
  const dailyReturns = [];
  const equities = [];
  const states = [];

  for (const date of dates) {
    const returnDateIndex = market.dateIndex.get(date);
    if (!Number.isInteger(returnDateIndex) || returnDateIndex < 1) throw new Error(`${date} 市场状态无效`);
    const signalIndex = returnDateIndex - 1;
    const state = marketState(market, signalIndex, fearGreed, settings);
    const trendWeight = settings.stateAllocationEnabled && state.available
      ? settings.minimumTrendWeight
        + (settings.maximumTrendWeight - settings.minimumTrendWeight) * state.breadthImbalance
      : settings.baseTrendWeight;
    const currentDrawdownScale = drawdownScale(equity, peakEquity, settings);
    const currentReferenceScale = referenceScale(state, settings);
    const riskScale = currentDrawdownScale * currentReferenceScale;
    const allocations = {
      trend: trendWeight * riskScale,
      marketNeutral: (1 - trendWeight) * riskScale,
    };
    const allocationTurnover = Math.abs(allocations.trend - previousAllocations.trend)
      + Math.abs(allocations.marketNeutral - previousAllocations.marketNeutral);
    const strategyReturn = allocations.trend * trendReturns.get(date)
      + allocations.marketNeutral * marketNeutralReturns.get(date)
      - allocationTurnover * settings.allocationTradingCostRate;
    equity *= 1 + strategyReturn;
    peakEquity = Math.max(peakEquity, equity);
    previousAllocations = allocations;
    dailyReturns.push(strategyReturn);
    equities.push(equity);
    states.push({
      date,
      ...state,
      trendWeight,
      drawdownScale: currentDrawdownScale,
      referenceScale: currentReferenceScale,
      referenceMissing: settings.referenceRiskEnabled && !Number.isFinite(state.fearGreed),
      riskScale,
      allocationTurnover,
    });
  }

  return {
    strategy: '自适应趋势与市场中性组合',
    settings,
    metrics: summarize(dates, dailyReturns, equities, states),
    equityCurve: dates.map((date, index) => ({ date, equity: round(equities[index]) })),
    states,
  };
}
