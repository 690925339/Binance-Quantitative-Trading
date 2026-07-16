const DAYS_PER_YEAR = 365;

const DEFAULTS = Object.freeze({
  mode: 'momentum',
  lookbackDays: 20,
  rebalanceDays: 1,
  positionsPerSide: 1,
  baseGrossExposure: 0.5,
  maxGrossExposure: 0.5,
  dynamicLeverageEnabled: false,
  dynamicLeverageMax: 1,
  dispersionTarget: 0.20,
  tradingCostRate: 0.0007,
  dailyCarryCostRate: 0.00005,
  monthlyProfitLock: null,
  monthlyLossLimit: null,
  referenceFilterEnabled: false,
  referenceWindowDays: 20,
  fearGreedMinimum: null,
  fearGreedMaximum: null,
  maximumMarketVolatility: null,
  maximumBreadthImbalance: null,
  referenceOutsideScale: 0.5,
});

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function mergeOptions(options) {
  const settings = { ...DEFAULTS, ...options };
  if (!['momentum', 'meanReversion'].includes(settings.mode)) {
    throw new Error('mode 必须是 momentum 或 meanReversion');
  }
  for (const key of ['lookbackDays', 'rebalanceDays', 'positionsPerSide']) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new Error(`${key} 必须是正整数`);
  }
  for (const key of ['baseGrossExposure', 'maxGrossExposure', 'dispersionTarget']) {
    if (!Number.isFinite(settings[key]) || settings[key] <= 0) throw new Error(`${key} 必须大于 0`);
  }
  if (settings.baseGrossExposure > settings.maxGrossExposure) {
    throw new Error('baseGrossExposure 不能超过 maxGrossExposure');
  }
  if (typeof settings.dynamicLeverageEnabled !== 'boolean') throw new Error('dynamicLeverageEnabled 必须是布尔值');
  if (!Number.isFinite(settings.dynamicLeverageMax)
    || settings.dynamicLeverageMax < 1
    || settings.dynamicLeverageMax > 3) {
    throw new Error('dynamicLeverageMax 必须在 1 到 3 之间');
  }
  for (const key of ['tradingCostRate', 'dailyCarryCostRate']) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0) throw new Error(`${key} 不能小于 0`);
  }
  for (const key of ['monthlyProfitLock', 'monthlyLossLimit']) {
    if (settings[key] !== null
      && (!Number.isFinite(settings[key]) || settings[key] <= 0 || settings[key] >= 1)) {
      throw new Error(`${key} 必须大于 0 且小于 1，或设为 null`);
    }
  }
  if (typeof settings.referenceFilterEnabled !== 'boolean') {
    throw new Error('referenceFilterEnabled 必须是布尔值');
  }
  if (!Number.isInteger(settings.referenceWindowDays) || settings.referenceWindowDays < 2) {
    throw new Error('referenceWindowDays 必须是大于等于 2 的整数');
  }
  for (const key of ['fearGreedMinimum', 'fearGreedMaximum']) {
    if (settings[key] !== null
      && (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 100)) {
      throw new Error(`${key} 必须在 0 到 100 之间，或设为 null`);
    }
  }
  if ((settings.fearGreedMinimum === null) !== (settings.fearGreedMaximum === null)) {
    throw new Error('恐惧指数上下限必须同时设置或同时为 null');
  }
  if (settings.fearGreedMinimum !== null && settings.fearGreedMinimum > settings.fearGreedMaximum) {
    throw new Error('fearGreedMinimum 不能超过 fearGreedMaximum');
  }
  if (settings.maximumMarketVolatility !== null
    && (!Number.isFinite(settings.maximumMarketVolatility) || settings.maximumMarketVolatility <= 0)) {
    throw new Error('maximumMarketVolatility 必须大于 0，或设为 null');
  }
  if (settings.maximumBreadthImbalance !== null
    && (!Number.isFinite(settings.maximumBreadthImbalance)
      || settings.maximumBreadthImbalance < 0
      || settings.maximumBreadthImbalance > 1)) {
    throw new Error('maximumBreadthImbalance 必须在 0 到 1 之间，或设为 null');
  }
  if (!Number.isFinite(settings.referenceOutsideScale)
    || settings.referenceOutsideScale < 0
    || settings.referenceOutsideScale > 1) {
    throw new Error('referenceOutsideScale 必须在 0 到 1 之间');
  }
  return settings;
}

function validateSeries(seriesBySymbol, settings) {
  const entries = Object.entries(seriesBySymbol || {});
  if (entries.length < settings.positionsPerSide * 2) throw new Error('交易对数量不足以建立多空两侧仓位');
  const dates = entries[0]?.[1]?.map((item) => item.date);
  if (!dates?.length) throw new Error('行情序列不能为空');
  for (const [symbol, series] of entries) {
    if (!Array.isArray(series) || series.length !== dates.length) throw new Error(`${symbol} 行情长度不一致`);
    series.forEach((item, index) => {
      if (item.date !== dates[index]) throw new Error(`${symbol} 在 ${index} 处的日期未对齐`);
      if (!Number.isFinite(item.close) || item.close <= 0) throw new Error(`${symbol} 在 ${item.date} 的收盘价无效`);
    });
  }
  return { dates, symbols: entries.map(([symbol]) => symbol) };
}

export function calculateCrossSectionalWeights(closesBySymbol, symbols, index, settings) {
  const ranked = symbols.map((symbol) => ({
    symbol,
    relativeReturn: closesBySymbol[symbol][index] / closesBySymbol[symbol][index - settings.lookbackDays] - 1,
  })).sort((left, right) => right.relativeReturn - left.relativeReturn);
  const strongest = ranked.slice(0, settings.positionsPerSide);
  const weakest = ranked.slice(-settings.positionsPerSide);
  const dispersion = mean(strongest.map((item) => item.relativeReturn))
    - mean(weakest.map((item) => item.relativeReturn));
  const leverage = settings.dynamicLeverageEnabled
    ? 1 + (settings.dynamicLeverageMax - 1) * Math.min(1, Math.max(0, dispersion) / settings.dispersionTarget)
    : 1;
  const grossExposure = Math.min(settings.maxGrossExposure, settings.baseGrossExposure * leverage);
  const sideWeight = grossExposure / 2 / settings.positionsPerSide;
  const weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  const longItems = settings.mode === 'momentum' ? strongest : weakest;
  const shortItems = settings.mode === 'momentum' ? weakest : strongest;
  for (const item of longItems) weights[item.symbol] = sideWeight;
  for (const item of shortItems) weights[item.symbol] = -sideWeight;
  return { weights, leverage };
}

function normalizeFearGreedByDate(value) {
  if (value === undefined || value === null) return new Map();
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return new Map(entries.map(([date, indexValue]) => {
    const numericValue = Number(indexValue);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(numericValue)
      || numericValue < 0
      || numericValue > 100) {
      throw new Error(`恐惧指数 ${date} 的值无效`);
    }
    return [date, numericValue];
  }));
}

function calculateReferenceObservation({
  dates,
  closesBySymbol,
  symbols,
  index,
  fearGreedByDate,
  settings,
}) {
  if (!settings.referenceFilterEnabled) {
    return { scale: 1, fearGreedMissing: false };
  }

  let scale = 1;
  let fearGreedMissing = false;
  let fearGreed = null;
  if (settings.fearGreedMinimum !== null) {
    const previousDate = dates[index - 1];
    fearGreed = fearGreedByDate.get(previousDate);
    if (!Number.isFinite(fearGreed)) {
      fearGreedMissing = true;
      scale = 0;
    } else if (fearGreed < settings.fearGreedMinimum || fearGreed > settings.fearGreedMaximum) {
      scale = Math.min(scale, settings.referenceOutsideScale);
    }
  }

  let marketVolatility = null;
  let breadth = null;
  let breadthImbalance = null;
  if (settings.maximumMarketVolatility !== null || settings.maximumBreadthImbalance !== null) {
    const startIndex = index - settings.referenceWindowDays;
    if (startIndex < 0) {
      scale = 0;
    } else {
      const basketReturns = [];
      for (let cursor = startIndex + 1; cursor <= index; cursor += 1) {
        basketReturns.push(mean(symbols.map((symbol) => (
          Math.log(closesBySymbol[symbol][cursor] / closesBySymbol[symbol][cursor - 1])
        ))));
      }
      marketVolatility = sampleStandardDeviation(basketReturns) * Math.sqrt(DAYS_PER_YEAR);
      breadth = symbols.filter((symbol) => (
        closesBySymbol[symbol][index] > closesBySymbol[symbol][startIndex]
      )).length / symbols.length;
      breadthImbalance = Math.abs(breadth - 0.5) * 2;
      if (settings.maximumMarketVolatility !== null
        && marketVolatility > settings.maximumMarketVolatility) {
        scale = Math.min(scale, settings.referenceOutsideScale);
      }
      if (settings.maximumBreadthImbalance !== null
        && breadthImbalance > settings.maximumBreadthImbalance) {
        scale = Math.min(scale, settings.referenceOutsideScale);
      }
    }
  }

  return {
    scale,
    fearGreed,
    fearGreedDate: dates[index - 1] || null,
    fearGreedMissing,
    marketVolatility,
    breadth,
    breadthImbalance,
  };
}

export function isCalendarRebalanceDay(date, rebalanceDays) {
  const utcDayNumber = Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
  return utcDayNumber % rebalanceDays === 0;
}

function summarize(
  dates,
  dailyReturns,
  equityCurve,
  turnovers,
  grossExposures,
  leverages,
  lockStates,
  referenceObservations,
) {
  const elapsedDays = Math.max(1, (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86_400_000);
  const finalEquity = equityCurve.at(-1);
  const annualizedVolatility = sampleStandardDeviation(dailyReturns) * Math.sqrt(DAYS_PER_YEAR);
  let peak = 1;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return {
    totalReturn: round(finalEquity - 1),
    annualizedReturn: round(finalEquity > 0 ? finalEquity ** (DAYS_PER_YEAR / elapsedDays) - 1 : -1),
    annualizedVolatility: round(annualizedVolatility),
    sharpeRatio: round(annualizedVolatility > 0 ? mean(dailyReturns) * DAYS_PER_YEAR / annualizedVolatility : 0),
    maxDrawdown: round(maxDrawdown),
    averageGrossExposure: round(mean(grossExposures)),
    averageDynamicLeverage: round(mean(leverages)),
    maximumDynamicLeverage: round(Math.max(...leverages)),
    monthlyLockedDays: lockStates.filter(Boolean).length,
    totalTurnover: round(turnovers.reduce((sum, value) => sum + value, 0)),
    averageReferenceScale: round(mean(referenceObservations.map((item) => item.scale))),
    referenceFilteredDays: referenceObservations.filter((item) => item.scale < 1).length,
    missingFearGreedDays: referenceObservations.filter((item) => item.fearGreedMissing).length,
  };
}

export function runCrossSectionalBacktest(seriesBySymbol, options = {}, references = {}) {
  const settings = mergeOptions(options);
  const { dates, symbols } = validateSeries(seriesBySymbol, settings);
  const fearGreedByDate = normalizeFearGreedByDate(references.fearGreedByDate);
  const closesBySymbol = Object.fromEntries(symbols.map((symbol) => [
    symbol,
    seriesBySymbol[symbol].map((item) => item.close),
  ]));
  if (dates.length <= settings.lookbackDays + 2) throw new Error('行情长度不足');

  let weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  let equity = 1;
  let currentMonth = null;
  let monthStartEquity = 1;
  let lockReason = null;
  let currentLeverage = 1;
  let baseWeights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  const resultDates = [];
  const dailyReturns = [];
  const equityCurve = [];
  const turnovers = [];
  const grossExposures = [];
  const leverages = [];
  const lockStates = [];
  const referenceObservations = [];

  for (let index = settings.lookbackDays; index < dates.length - 1; index += 1) {
    const resultMonth = dates[index + 1].slice(0, 7);
    const monthChanged = resultMonth !== currentMonth;
    if (monthChanged) {
      currentMonth = resultMonth;
      monthStartEquity = equity;
      lockReason = null;
    }
    const scheduledRebalance = isCalendarRebalanceDay(dates[index], settings.rebalanceDays);
    const needsLockClose = lockReason !== null && symbols.some((symbol) => weights[symbol] !== 0);
    if (lockReason === null && (scheduledRebalance || monthChanged)) {
      const allocation = calculateCrossSectionalWeights(closesBySymbol, symbols, index, settings);
      baseWeights = allocation.weights;
      currentLeverage = allocation.leverage;
    }
    const referenceObservation = calculateReferenceObservation({
      dates,
      closesBySymbol,
      symbols,
      index,
      fearGreedByDate,
      settings,
    });
    const targetWeights = lockReason === null
      ? Object.fromEntries(symbols.map((symbol) => [
        symbol,
        baseWeights[symbol] * referenceObservation.scale,
      ]))
      : Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
    let turnover = 0;
    const referenceScaleChanged = settings.referenceFilterEnabled
      && symbols.some((symbol) => targetWeights[symbol] !== weights[symbol]);
    if (scheduledRebalance || monthChanged || needsLockClose || referenceScaleChanged) {
      turnover = symbols.reduce((sum, symbol) => sum + Math.abs(targetWeights[symbol] - weights[symbol]), 0);
      weights = targetWeights;
    }
    const grossExposure = symbols.reduce((sum, symbol) => sum + Math.abs(weights[symbol]), 0);
    const marketReturn = symbols.reduce((sum, symbol) => (
      sum + weights[symbol] * (closesBySymbol[symbol][index + 1] / closesBySymbol[symbol][index] - 1)
    ), 0);
    const strategyReturn = marketReturn
      - turnover * settings.tradingCostRate
      - grossExposure * settings.dailyCarryCostRate;
    equity *= 1 + strategyReturn;
    const monthlyReturn = equity / monthStartEquity - 1;
    if (lockReason === null && settings.monthlyProfitLock !== null && monthlyReturn >= settings.monthlyProfitLock) {
      lockReason = 'profit';
    } else if (lockReason === null && settings.monthlyLossLimit !== null && monthlyReturn <= -settings.monthlyLossLimit) {
      lockReason = 'loss';
    }

    resultDates.push(dates[index + 1]);
    dailyReturns.push(strategyReturn);
    equityCurve.push(equity);
    turnovers.push(turnover);
    grossExposures.push(grossExposure);
    leverages.push(currentLeverage);
    lockStates.push(lockReason);
    referenceObservations.push(referenceObservation);
  }

  return {
    strategy: '横截面市场中性多空',
    settings,
    symbols,
    metrics: summarize(
      resultDates,
      dailyReturns,
      equityCurve,
      turnovers,
      grossExposures,
      leverages,
      lockStates,
      referenceObservations,
    ),
    equityCurve: resultDates.map((date, index) => ({ date, equity: round(equityCurve[index]) })),
  };
}
