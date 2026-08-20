const DAYS_PER_YEAR = 365;

export const LONG_SHORT_TREND_DEFAULTS = Object.freeze({
  positionMode: 'both',
  lookbackDays: [30, 90, 180],
  volatilityWindowDays: 30,
  targetVolatility: 0.10,
  maxGrossExposure: 0.5,
  maxAssetExposure: 0.15,
  rebalanceDays: 1,
  minimumTrendStrength: 0.02,
  minimumTrendVotes: null,
  minimumActiveSignals: 1,
  shortConfirmationLookbackDays: null,
  shortConfirmationMinimumReturn: 0,
  dynamicLeverageEnabled: false,
  dynamicLeverageMin: 1,
  dynamicLeverageMax: 1,
  dynamicLeverageStrengthTarget: 0.20,
  tradingCostRate: 0.0007,
  dailyCarryCostRate: 0.00005,
  drawdownControlStart: null,
  drawdownControlFull: null,
  minimumRiskScale: 1,
  monthlyProfitLock: null,
  monthlyLossLimit: null,
});

export const LONG_SHORT_RISK_PROFILES = Object.freeze({
  baseline: Object.freeze({
    targetVolatility: 0.10,
    maxGrossExposure: 0.50,
    maxAssetExposure: 0.15,
    defaultLeverage: 1,
    maxLeverage: 125,
  }),
  enhanced: Object.freeze({
    targetVolatility: 0.15,
    maxGrossExposure: 0.75,
    maxAssetExposure: 0.225,
    defaultLeverage: 2,
    maxLeverage: 3,
  }),
  highReturn: Object.freeze({
    targetVolatility: 0.20,
    maxGrossExposure: 1.00,
    maxAssetExposure: 0.30,
    defaultLeverage: 2,
    maxLeverage: 3,
  }),
});

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function mergeOptions(options) {
  const merged = { ...LONG_SHORT_TREND_DEFAULTS, ...options };
  if (!['both', 'longOnly', 'shortOnly'].includes(merged.positionMode)) {
    throw new Error('positionMode 必须是 both、longOnly 或 shortOnly');
  }
  if (!Array.isArray(merged.lookbackDays) || merged.lookbackDays.length < 2) {
    throw new Error('趋势回看周期至少需要两个正整数');
  }
  if (merged.lookbackDays.some((value) => !Number.isInteger(value) || value < 2)) {
    throw new Error('趋势回看周期必须是大于 1 的整数');
  }
  for (const key of ['volatilityWindowDays', 'rebalanceDays', 'minimumActiveSignals']) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1) throw new Error(`${key} 必须是正整数`);
  }
  if (merged.shortConfirmationLookbackDays !== null
    && (!Number.isInteger(merged.shortConfirmationLookbackDays)
      || merged.shortConfirmationLookbackDays < 2)) {
    throw new Error('shortConfirmationLookbackDays 必须是至少2天的整数，或设为 null');
  }
  if (!Number.isFinite(merged.shortConfirmationMinimumReturn)
    || merged.shortConfirmationMinimumReturn < 0
    || merged.shortConfirmationMinimumReturn >= 1) {
    throw new Error('shortConfirmationMinimumReturn 必须大于等于0且小于1');
  }
  if (merged.minimumTrendVotes !== null
    && (!Number.isInteger(merged.minimumTrendVotes)
      || merged.minimumTrendVotes < 1
      || merged.minimumTrendVotes > merged.lookbackDays.length)) {
    throw new Error('minimumTrendVotes 必须是 1 到回看周期数量之间的整数');
  }
  for (const key of ['targetVolatility', 'maxGrossExposure', 'maxAssetExposure']) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) throw new Error(`${key} 必须大于 0`);
  }
  for (const key of ['minimumTrendStrength', 'tradingCostRate', 'dailyCarryCostRate']) {
    if (!Number.isFinite(merged[key]) || merged[key] < 0) throw new Error(`${key} 不能小于 0`);
  }
  if (typeof merged.dynamicLeverageEnabled !== 'boolean') throw new Error('dynamicLeverageEnabled 必须是布尔值');
  for (const key of ['dynamicLeverageMin', 'dynamicLeverageMax']) {
    if (!Number.isFinite(merged[key]) || merged[key] < 1 || merged[key] > 3) {
      throw new Error(`${key} 必须在 1 到 3 之间`);
    }
  }
  if (merged.dynamicLeverageMin > merged.dynamicLeverageMax) {
    throw new Error('dynamicLeverageMin 不能大于 dynamicLeverageMax');
  }
  if (!Number.isFinite(merged.dynamicLeverageStrengthTarget) || merged.dynamicLeverageStrengthTarget <= 0) {
    throw new Error('dynamicLeverageStrengthTarget 必须大于 0');
  }
  const drawdownControlEnabled = merged.drawdownControlStart !== null || merged.drawdownControlFull !== null;
  if (drawdownControlEnabled) {
    if (!Number.isFinite(merged.drawdownControlStart) || merged.drawdownControlStart <= 0 || merged.drawdownControlStart >= 1) {
      throw new Error('drawdownControlStart 必须大于 0 且小于 1');
    }
    if (!Number.isFinite(merged.drawdownControlFull)
      || merged.drawdownControlFull <= merged.drawdownControlStart
      || merged.drawdownControlFull > 1) {
      throw new Error('drawdownControlFull 必须大于 drawdownControlStart 且不超过 1');
    }
    if (!Number.isFinite(merged.minimumRiskScale) || merged.minimumRiskScale < 0 || merged.minimumRiskScale > 1) {
      throw new Error('minimumRiskScale 必须在 0 到 1 之间');
    }
  }
  for (const key of ['monthlyProfitLock', 'monthlyLossLimit']) {
    if (merged[key] !== null
      && (!Number.isFinite(merged[key]) || merged[key] <= 0 || merged[key] >= 1)) {
      throw new Error(`${key} 必须大于 0 且小于 1，或设为 null`);
    }
  }
  return merged;
}

function validateSeries(seriesBySymbol) {
  const entries = Object.entries(seriesBySymbol || {});
  if (entries.length < 2) throw new Error('多空趋势策略至少需要两个交易对');
  const dates = entries[0][1]?.map((item) => item.date);
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

export function calculateTrendSignal(closes, index, options) {
  const trendReturns = options.lookbackDays.map((lookback) => closes[index] / closes[index - lookback] - 1);
  const votes = trendReturns.map((trendReturn) => {
    if (Math.abs(trendReturn) < options.minimumTrendStrength) return 0;
    return Math.sign(trendReturn);
  });
  const positiveVotes = votes.filter((vote) => vote > 0).length;
  const negativeVotes = votes.filter((vote) => vote < 0).length;
  const threshold = options.minimumTrendVotes ?? Math.floor(options.lookbackDays.length / 2) + 1;
  const direction = positiveVotes >= threshold ? 1 : negativeVotes >= threshold ? -1 : 0;
  const agreeingReturns = trendReturns.filter((value) => Math.sign(value) === direction);
  const strength = direction && agreeingReturns.length
    ? mean(agreeingReturns.map((value) => Math.abs(value)))
    : 0;
  return { direction, strength, agreeingVotes: Math.max(positiveVotes, negativeVotes) };
}

export function calculateAnnualizedVolatility(closes, index, windowDays) {
  const returns = [];
  for (let cursor = index - windowDays + 1; cursor <= index; cursor += 1) {
    returns.push(Math.log(closes[cursor] / closes[cursor - 1]));
  }
  return sampleStandardDeviation(returns) * Math.sqrt(DAYS_PER_YEAR);
}

export function calculateLongShortTrendWeights(closesBySymbol, symbols, index, options) {
  const shortConfirmationEnabled = Number.isInteger(options.shortConfirmationLookbackDays);
  const evaluated = symbols.map((symbol) => {
    const trend = calculateTrendSignal(closesBySymbol[symbol], index, options);
    let signal = trend.direction;
    if (options.positionMode === 'longOnly' && signal < 0) signal = 0;
    if (options.positionMode === 'shortOnly' && signal > 0) signal = 0;
    const shortConfirmationReturn = shortConfirmationEnabled
      ? closesBySymbol[symbol][index]
        / closesBySymbol[symbol][index - options.shortConfirmationLookbackDays] - 1
      : null;
    const shortConfirmationPassed = signal >= 0 || !shortConfirmationEnabled
      || shortConfirmationReturn <= -options.shortConfirmationMinimumReturn;
    const shortSignalRejected = signal < 0 && !shortConfirmationPassed;
    if (shortSignalRejected) signal = 0;
    return {
      symbol,
      signal,
      strength: trend.strength,
      volatility: calculateAnnualizedVolatility(closesBySymbol[symbol], index, options.volatilityWindowDays),
      shortConfirmationReturn,
      shortSignalRejected,
    };
  });
  const candidates = evaluated.filter((item) => item.signal !== 0 && item.volatility > 0);
  const shortConfirmation = {
    enabled: shortConfirmationEnabled,
    lookbackDays: shortConfirmationEnabled ? options.shortConfirmationLookbackDays : null,
    minimumReturn: options.shortConfirmationMinimumReturn,
    rejectedSymbols: evaluated.filter((item) => item.shortSignalRejected).map((item) => item.symbol),
  };

  const weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  if (candidates.length < options.minimumActiveSignals) {
    return {
      weights,
      dynamicLeverage: 1,
      activeSignalCount: candidates.length,
      averageSignalStrength: 0,
      shortConfirmation,
    };
  }

  const averageSignalStrength = mean(candidates.map((item) => item.strength));
  const normalizedStrength = Math.min(1, averageSignalStrength / options.dynamicLeverageStrengthTarget);
  const dynamicLeverage = options.dynamicLeverageEnabled
    ? options.dynamicLeverageMin
      + (options.dynamicLeverageMax - options.dynamicLeverageMin) * normalizedStrength
    : 1;

  for (const item of candidates) {
    const riskBalancedWeight = options.targetVolatility * dynamicLeverage
      / (item.volatility * candidates.length);
    weights[item.symbol] = item.signal * Math.min(riskBalancedWeight, options.maxAssetExposure);
  }
  const grossExposure = Object.values(weights).reduce((sum, weight) => sum + Math.abs(weight), 0);
  if (grossExposure > options.maxGrossExposure) {
    const scale = options.maxGrossExposure / grossExposure;
    for (const symbol of symbols) weights[symbol] *= scale;
  }
  return {
    weights,
    dynamicLeverage,
    activeSignalCount: candidates.length,
    averageSignalStrength,
    shortConfirmation,
  };
}

function drawdownRiskScale(equity, peakEquity, options) {
  if (options.drawdownControlStart === null || options.drawdownControlFull === null) return 1;
  const drawdownMagnitude = Math.max(0, 1 - equity / peakEquity);
  if (drawdownMagnitude <= options.drawdownControlStart) return 1;
  if (drawdownMagnitude >= options.drawdownControlFull) return options.minimumRiskScale;
  const progress = (drawdownMagnitude - options.drawdownControlStart)
    / (options.drawdownControlFull - options.drawdownControlStart);
  return 1 - progress * (1 - options.minimumRiskScale);
}

function summarize(
  dates,
  dailyReturns,
  equityCurve,
  turnovers,
  grossExposures,
  positions,
  riskScales,
  dynamicLeverages,
  monthlyLockStates,
) {
  const elapsedDays = Math.max(1, (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86_400_000);
  const finalEquity = equityCurve.at(-1);
  const annualizedReturn = finalEquity > 0 ? finalEquity ** (DAYS_PER_YEAR / elapsedDays) - 1 : -1;
  const annualizedVolatility = sampleStandardDeviation(dailyReturns) * Math.sqrt(DAYS_PER_YEAR);
  const averageDailyReturn = mean(dailyReturns);
  const sharpeRatio = annualizedVolatility > 0 ? averageDailyReturn * DAYS_PER_YEAR / annualizedVolatility : 0;
  let peak = 1;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const rolling365DayReturns = equityCurve.slice(365).map((equity, index) => equity / equityCurve[index] - 1);

  const annualReturns = {};
  let previousYear = dates[0].slice(0, 4);
  let yearStartEquity = 1;
  dates.forEach((date, index) => {
    const year = date.slice(0, 4);
    if (year !== previousYear) {
      annualReturns[previousYear] = equityCurve[index - 1] / yearStartEquity - 1;
      previousYear = year;
      yearStartEquity = equityCurve[index - 1];
    }
  });
  annualReturns[previousYear] = finalEquity / yearStartEquity - 1;

  return {
    startDate: dates[0],
    endDate: dates.at(-1),
    days: dates.length,
    totalReturn: round(finalEquity - 1),
    annualizedReturn: round(annualizedReturn),
    annualizedVolatility: round(annualizedVolatility),
    sharpeRatio: round(sharpeRatio),
    maxDrawdown: round(maxDrawdown),
    positiveDayRatio: round(dailyReturns.filter((value) => value > 0).length / dailyReturns.length),
    averageGrossExposure: round(mean(grossExposures)),
    averageRiskScale: round(mean(riskScales)),
    deleveragedDays: riskScales.filter((value) => value < 0.999999).length,
    averageDynamicLeverage: round(mean(dynamicLeverages)),
    maximumDynamicLeverage: round(Math.max(...dynamicLeverages)),
    dynamicLeveragedDays: dynamicLeverages.filter((value) => value > 1.000001).length,
    monthlyLockedDays: monthlyLockStates.filter((value) => value !== null).length,
    monthlyProfitLockCount: new Set(monthlyLockStates.filter((value) => value?.reason === 'profit')
      .map((value) => value.month)).size,
    monthlyLossLockCount: new Set(monthlyLockStates.filter((value) => value?.reason === 'loss')
      .map((value) => value.month)).size,
    totalTurnover: round(turnovers.reduce((sum, value) => sum + value, 0)),
    longExposureDays: positions.filter((value) => value.hasLong).length,
    shortExposureDays: positions.filter((value) => value.hasShort).length,
    simultaneousLongShortDays: positions.filter((value) => value.hasLong && value.hasShort).length,
    minimumRolling365DayReturn: rolling365DayReturns.length ? round(Math.min(...rolling365DayReturns)) : null,
    maximumRolling365DayReturn: rolling365DayReturns.length ? round(Math.max(...rolling365DayReturns)) : null,
    annualReturns: Object.fromEntries(Object.entries(annualReturns).map(([year, value]) => [year, round(value)])),
  };
}

export function runLongShortTrendBacktest(seriesBySymbol, options = {}) {
  const settings = mergeOptions(options);
  const { dates, symbols } = validateSeries(seriesBySymbol);
  const closesBySymbol = Object.fromEntries(symbols.map((symbol) => [
    symbol,
    seriesBySymbol[symbol].map((item) => item.close),
  ]));
  const warmupDays = Math.max(
    ...settings.lookbackDays,
    settings.volatilityWindowDays,
    settings.shortConfirmationLookbackDays || 0,
  );
  if (dates.length <= warmupDays + 2) throw new Error(`行情长度至少需要 ${warmupDays + 3} 天`);

  let weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  let equity = 1;
  let peakEquity = 1;
  let currentRiskScale = 1;
  let currentDynamicLeverage = 1;
  let currentMonth = null;
  let monthStartEquity = 1;
  let monthlyLockReason = null;
  const resultDates = [];
  const dailyReturns = [];
  const equityCurve = [];
  const turnovers = [];
  const grossExposures = [];
  const positions = [];
  const riskScales = [];
  const dynamicLeverages = [];
  const monthlyLockStates = [];

  for (let index = warmupDays; index < dates.length - 1; index += 1) {
    const resultMonth = dates[index + 1].slice(0, 7);
    const monthChanged = resultMonth !== currentMonth;
    if (monthChanged) {
      currentMonth = resultMonth;
      monthStartEquity = equity;
      monthlyLockReason = null;
    }
    let turnover = 0;
    let riskScale = 1;
    const scheduledRebalance = (index - warmupDays) % settings.rebalanceDays === 0;
    const needsLockClose = monthlyLockReason !== null
      && symbols.some((symbol) => weights[symbol] !== 0);
    if (scheduledRebalance || monthChanged || needsLockClose) {
      const allocation = monthlyLockReason === null
        ? calculateLongShortTrendWeights(closesBySymbol, symbols, index, settings)
        : {
          weights: Object.fromEntries(symbols.map((symbol) => [symbol, 0])),
          dynamicLeverage: 1,
        };
      const nextWeights = allocation.weights;
      currentDynamicLeverage = allocation.dynamicLeverage;
      riskScale = drawdownRiskScale(equity, peakEquity, settings);
      currentRiskScale = riskScale;
      for (const symbol of symbols) nextWeights[symbol] *= riskScale;
      turnover = symbols.reduce((sum, symbol) => sum + Math.abs(nextWeights[symbol] - weights[symbol]), 0);
      weights = nextWeights;
    } else {
      riskScale = currentRiskScale;
    }
    const grossExposure = symbols.reduce((sum, symbol) => sum + Math.abs(weights[symbol]), 0);
    const marketReturn = symbols.reduce((sum, symbol) => {
      const nextReturn = closesBySymbol[symbol][index + 1] / closesBySymbol[symbol][index] - 1;
      return sum + weights[symbol] * nextReturn;
    }, 0);
    const strategyReturn = marketReturn
      - turnover * settings.tradingCostRate
      - grossExposure * settings.dailyCarryCostRate;
    equity *= 1 + strategyReturn;
    peakEquity = Math.max(peakEquity, equity);
    const monthlyReturn = equity / monthStartEquity - 1;
    if (monthlyLockReason === null
      && settings.monthlyProfitLock !== null
      && monthlyReturn >= settings.monthlyProfitLock) {
      monthlyLockReason = 'profit';
    } else if (monthlyLockReason === null
      && settings.monthlyLossLimit !== null
      && monthlyReturn <= -settings.monthlyLossLimit) {
      monthlyLockReason = 'loss';
    }

    resultDates.push(dates[index + 1]);
    dailyReturns.push(strategyReturn);
    equityCurve.push(equity);
    turnovers.push(turnover);
    grossExposures.push(grossExposure);
    riskScales.push(riskScale);
    dynamicLeverages.push(currentDynamicLeverage);
    monthlyLockStates.push(monthlyLockReason === null ? null : {
      month: currentMonth,
      reason: monthlyLockReason,
    });
    positions.push({
      hasLong: symbols.some((symbol) => weights[symbol] > 0),
      hasShort: symbols.some((symbol) => weights[symbol] < 0),
    });
  }

  return {
    strategy: '多资产波动率目标多空趋势',
    symbols,
    settings,
    metrics: summarize(
      resultDates,
      dailyReturns,
      equityCurve,
      turnovers,
      grossExposures,
      positions,
      riskScales,
      dynamicLeverages,
      monthlyLockStates,
    ),
    equityCurve: resultDates.map((date, index) => ({ date, equity: round(equityCurve[index]) })),
  };
}
