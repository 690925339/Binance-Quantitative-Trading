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
  minimumRebalanceTurnover: 0,
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
  adaptiveBreadthEnabled: false,
  confirmationLookbackDays: Object.freeze([5, 10, 20]),
  uncertainPositionsPerSide: 2,
  minimumRankStability: 0.70,
  minimumSelectionGap: 0.25,
  uncertainGrossExposureScale: 0.75,
  uncertainLeverageCap: 1.5,
  adaptiveVolatilityWindowDays: 20,
  maximumAdaptiveMarketVolatility: null,
  highVolatilityGrossExposureScale: 0.5,
  maximumSingleAssetExposure: null,
});

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function percentile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1));
  return sorted[index];
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
  if (!Number.isFinite(settings.minimumRebalanceTurnover)
    || settings.minimumRebalanceTurnover < 0
    || settings.minimumRebalanceTurnover > 2) {
    throw new Error('minimumRebalanceTurnover 必须在 0 到 2 之间');
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
  if (typeof settings.adaptiveBreadthEnabled !== 'boolean') {
    throw new Error('adaptiveBreadthEnabled 必须是布尔值');
  }
  if (!Array.isArray(settings.confirmationLookbackDays)
    || settings.confirmationLookbackDays.length < 2
    || settings.confirmationLookbackDays.some((value) => !Number.isInteger(value) || value < 2)) {
    throw new Error('confirmationLookbackDays 必须包含至少两个大于等于 2 的整数');
  }
  settings.confirmationLookbackDays = [...new Set(settings.confirmationLookbackDays)];
  if (!Number.isInteger(settings.uncertainPositionsPerSide)
    || settings.uncertainPositionsPerSide < settings.positionsPerSide) {
    throw new Error('uncertainPositionsPerSide 不能小于 positionsPerSide');
  }
  for (const key of [
    'minimumRankStability',
    'uncertainGrossExposureScale',
    'highVolatilityGrossExposureScale',
  ]) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1) {
      throw new Error(`${key} 必须在 0 到 1 之间`);
    }
  }
  if (!Number.isFinite(settings.minimumSelectionGap)
    || settings.minimumSelectionGap < 0
    || settings.minimumSelectionGap > 2) {
    throw new Error('minimumSelectionGap 必须在 0 到 2 之间');
  }
  if (settings.adaptiveBreadthEnabled
    && (!Number.isFinite(settings.uncertainLeverageCap)
      || settings.uncertainLeverageCap < 1
      || settings.uncertainLeverageCap > settings.dynamicLeverageMax)) {
    throw new Error('uncertainLeverageCap 必须在 1 到 dynamicLeverageMax 之间');
  }
  if (!Number.isInteger(settings.adaptiveVolatilityWindowDays)
    || settings.adaptiveVolatilityWindowDays < 2) {
    throw new Error('adaptiveVolatilityWindowDays 必须是大于等于 2 的整数');
  }
  if (settings.maximumAdaptiveMarketVolatility !== null
    && (!Number.isFinite(settings.maximumAdaptiveMarketVolatility)
      || settings.maximumAdaptiveMarketVolatility <= 0)) {
    throw new Error('maximumAdaptiveMarketVolatility 必须大于 0，或设为 null');
  }
  if (settings.maximumSingleAssetExposure !== null
    && (!Number.isFinite(settings.maximumSingleAssetExposure)
      || settings.maximumSingleAssetExposure <= 0
      || settings.maximumSingleAssetExposure > 1)) {
    throw new Error('maximumSingleAssetExposure 必须在 0 到 1 之间，或设为 null');
  }
  return settings;
}

function validateSeries(seriesBySymbol, settings) {
  const entries = Object.entries(seriesBySymbol || {});
  const requiredPositions = settings.adaptiveBreadthEnabled
    ? settings.uncertainPositionsPerSide
    : settings.positionsPerSide;
  if (entries.length < requiredPositions * 2) throw new Error('交易对数量不足以建立多空两侧仓位');
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

function calculateMarketVolatility(closesBySymbol, symbols, index, windowDays) {
  if (index < windowDays) return null;
  const basketReturns = [];
  for (let cursor = index - windowDays + 1; cursor <= index; cursor += 1) {
    basketReturns.push(mean(symbols.map((symbol) => (
      Math.log(closesBySymbol[symbol][cursor] / closesBySymbol[symbol][cursor - 1])
    ))));
  }
  return sampleStandardDeviation(basketReturns) * Math.sqrt(DAYS_PER_YEAR);
}

function calculateAdaptiveRisk({
  closesBySymbol,
  symbols,
  index,
  ranked,
  settings,
}) {
  if (!settings.adaptiveBreadthEnabled) {
    return {
      enabled: false,
      stable: true,
      effectivePositionsPerSide: settings.positionsPerSide,
      rankStability: 1,
      selectionGap: null,
      grossExposureScale: 1,
      marketVolatility: null,
      highVolatility: false,
    };
  }

  const rankMaps = settings.confirmationLookbackDays.map((lookbackDays) => {
    const sorted = symbols.map((symbol) => ({
      symbol,
      value: closesBySymbol[symbol][index] / closesBySymbol[symbol][index - lookbackDays] - 1,
    })).sort((left, right) => right.value - left.value);
    return new Map(sorted.map((item, rank) => [item.symbol, rank]));
  });
  const denominator = Math.max(1, symbols.length - 1);
  const basePositions = settings.positionsPerSide;
  const longBoundaryGap = ranked[basePositions - 1].rankingScore
    - ranked[basePositions].rankingScore;
  const shortBoundaryGap = ranked.at(-basePositions - 1).rankingScore
    - ranked.at(-basePositions).rankingScore;
  const selectionGap = Math.min(longBoundaryGap, shortBoundaryGap);
  const longItems = ranked.slice(0, basePositions);
  const shortItems = ranked.slice(-basePositions);
  const longStability = mean(longItems.flatMap((item) => rankMaps.map((ranks) => (
    1 - ranks.get(item.symbol) / denominator
  ))));
  const shortStability = mean(shortItems.flatMap((item) => rankMaps.map((ranks) => (
    ranks.get(item.symbol) / denominator
  ))));
  const rankStability = Math.min(longStability, shortStability);
  const stable = rankStability >= settings.minimumRankStability
    && selectionGap >= settings.minimumSelectionGap;
  const marketVolatility = calculateMarketVolatility(
    closesBySymbol,
    symbols,
    index,
    settings.adaptiveVolatilityWindowDays,
  );
  const highVolatility = settings.maximumAdaptiveMarketVolatility !== null
    && Number.isFinite(marketVolatility)
    && marketVolatility > settings.maximumAdaptiveMarketVolatility;
  let grossExposureScale = stable ? 1 : settings.uncertainGrossExposureScale;
  if (highVolatility) grossExposureScale *= settings.highVolatilityGrossExposureScale;
  return {
    enabled: true,
    stable,
    effectivePositionsPerSide: stable
      ? settings.positionsPerSide
      : settings.uncertainPositionsPerSide,
    rankStability,
    selectionGap,
    grossExposureScale,
    marketVolatility,
    highVolatility,
  };
}

export function calculateCrossSectionalWeights(
  closesBySymbol,
  symbols,
  index,
  settings,
  signalContext = {},
) {
  const observations = symbols.map((symbol) => ({
    symbol,
    relativeReturn: closesBySymbol[symbol][index] / closesBySymbol[symbol][index - settings.lookbackDays] - 1,
  }));
  const returns = observations.map((item) => item.relativeReturn);
  const minimumReturn = Math.min(...returns);
  const maximumReturn = Math.max(...returns);
  const midpoint = (minimumReturn + maximumReturn) / 2;
  const halfRange = Math.max((maximumReturn - minimumReturn) / 2, Number.EPSILON);
  const newsSignalWeight = Number.isFinite(signalContext.newsSignalWeight)
    ? Math.min(1, Math.max(0, signalContext.newsSignalWeight))
    : 0;
  const newsScoresBySymbol = signalContext.newsScoresBySymbol || {};
  const newsWeightsBySymbol = signalContext.newsWeightsBySymbol || {};
  const perSymbolNewsActive = Object.values(newsWeightsBySymbol)
    .some((value) => Number.isFinite(value) && value > 0);
  const newsOverlayActive = (newsSignalWeight > 0 || perSymbolNewsActive)
    && Object.values(newsScoresBySymbol).some((value) => Number.isFinite(value));
  const ranked = observations.map((item) => {
    const priceScore = Math.min(1, Math.max(-1, (item.relativeReturn - midpoint) / halfRange));
    const suppliedNewsScore = newsScoresBySymbol[item.symbol];
    const suppliedNewsWeight = newsWeightsBySymbol[item.symbol];
    const effectiveNewsWeight = Number.isFinite(suppliedNewsWeight)
      ? Math.min(1, Math.max(0, suppliedNewsWeight))
      : newsSignalWeight;
    const newsEligible = Number.isFinite(suppliedNewsScore) && effectiveNewsWeight > 0;
    const newsScore = newsEligible ? Math.min(1, Math.max(-1, suppliedNewsScore)) : 0;
    return {
      ...item,
      priceScore,
      newsScore,
      newsWeight: newsEligible ? effectiveNewsWeight : 0,
      newsEligible,
      rankingScore: newsOverlayActive
        ? priceScore * (1 - effectiveNewsWeight) + newsScore * effectiveNewsWeight
        : priceScore,
    };
  }).sort((left, right) => right.rankingScore - left.rankingScore);
  const adaptiveRisk = calculateAdaptiveRisk({
    closesBySymbol,
    symbols,
    index,
    ranked,
    settings,
  });
  const positionsPerSide = adaptiveRisk.effectivePositionsPerSide;
  const strongest = ranked.slice(0, positionsPerSide);
  const weakest = ranked.slice(-positionsPerSide);
  const dispersion = mean(strongest.map((item) => item.relativeReturn))
    - mean(weakest.map((item) => item.relativeReturn));
  const rawLeverage = settings.dynamicLeverageEnabled
    ? 1 + (settings.dynamicLeverageMax - 1) * Math.min(1, Math.max(0, dispersion) / settings.dispersionTarget)
    : 1;
  const leverage = adaptiveRisk.enabled && !adaptiveRisk.stable
    ? Math.min(rawLeverage, settings.uncertainLeverageCap)
    : rawLeverage;
  const requestedGrossExposure = Math.min(
    settings.maxGrossExposure,
    settings.baseGrossExposure * leverage,
  ) * adaptiveRisk.grossExposureScale;
  const uncappedSideWeight = requestedGrossExposure / 2 / positionsPerSide;
  const sideWeight = settings.maximumSingleAssetExposure == null
    ? uncappedSideWeight
    : Math.min(uncappedSideWeight, settings.maximumSingleAssetExposure);
  const grossExposure = sideWeight * positionsPerSide * 2;
  const weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  const longItems = settings.mode === 'momentum' ? strongest : weakest;
  const shortItems = settings.mode === 'momentum' ? weakest : strongest;
  for (const item of longItems) weights[item.symbol] = sideWeight;
  for (const item of shortItems) weights[item.symbol] = -sideWeight;
  return {
    weights,
    leverage,
    grossExposure,
    ranking: ranked,
    newsAppliedSymbols: ranked.filter((item) => item.newsEligible).map((item) => item.symbol),
    adaptiveRisk: {
      ...adaptiveRisk,
      rawLeverage,
      leverage,
      requestedGrossExposure,
      grossExposure,
      maximumSingleAssetExposure: sideWeight,
    },
  };
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

export function shouldSuppressSmallRebalance({
  scheduled,
  force = false,
  monthChanged = false,
  needsLockClose = false,
  referenceScaleChanged = false,
  proposedTurnover,
  minimumRebalanceTurnover = 0,
}) {
  return scheduled
    && !force
    && !monthChanged
    && !needsLockClose
    && !referenceScaleChanged
    && proposedTurnover < minimumRebalanceTurnover;
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
  adaptiveObservations,
  singleAssetExposures,
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
    adaptiveStableDays: adaptiveObservations.filter((item) => item.enabled && item.stable).length,
    adaptiveUncertainDays: adaptiveObservations.filter((item) => item.enabled && !item.stable).length,
    adaptiveHighVolatilityDays: adaptiveObservations.filter((item) => item.highVolatility).length,
    averageEffectivePositionsPerSide: round(mean(adaptiveObservations.map(
      (item) => item.effectivePositionsPerSide,
    ))),
    averageSingleAssetExposure: round(mean(singleAssetExposures)),
    p95SingleAssetExposure: round(percentile(singleAssetExposures, 0.95)),
    maximumSingleAssetExposure: round(Math.max(...singleAssetExposures)),
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
  const warmupDays = Math.max(
    settings.lookbackDays,
    ...(settings.adaptiveBreadthEnabled ? settings.confirmationLookbackDays : []),
    settings.adaptiveBreadthEnabled ? settings.adaptiveVolatilityWindowDays : 0,
  );
  if (dates.length <= warmupDays + 2) throw new Error('行情长度不足');

  let weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  let equity = 1;
  let currentMonth = null;
  let monthStartEquity = 1;
  let lockReason = null;
  let currentLeverage = 1;
  let baseWeights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  let currentAdaptiveRisk = {
    enabled: false,
    stable: true,
    effectivePositionsPerSide: settings.positionsPerSide,
    highVolatility: false,
  };
  const resultDates = [];
  const dailyReturns = [];
  const equityCurve = [];
  const turnovers = [];
  const grossExposures = [];
  const leverages = [];
  const lockStates = [];
  const referenceObservations = [];
  const adaptiveObservations = [];
  const singleAssetExposures = [];

  for (let index = warmupDays; index < dates.length - 1; index += 1) {
    const resultMonth = dates[index + 1].slice(0, 7);
    const monthChanged = resultMonth !== currentMonth;
    if (monthChanged) {
      currentMonth = resultMonth;
      monthStartEquity = equity;
      lockReason = null;
    }
    const scheduledRebalance = isCalendarRebalanceDay(dates[index], settings.rebalanceDays);
    const needsLockClose = lockReason !== null && symbols.some((symbol) => weights[symbol] !== 0);
    let proposedBaseWeights = baseWeights;
    let proposedLeverage = currentLeverage;
    if (lockReason === null && (scheduledRebalance || monthChanged)) {
      const allocation = calculateCrossSectionalWeights(closesBySymbol, symbols, index, settings);
      proposedBaseWeights = allocation.weights;
      proposedLeverage = allocation.leverage;
      currentAdaptiveRisk = allocation.adaptiveRisk;
    }
    const referenceObservation = calculateReferenceObservation({
      dates,
      closesBySymbol,
      symbols,
      index,
      fearGreedByDate,
      settings,
    });
    const proposedTargetWeights = lockReason === null
      ? Object.fromEntries(symbols.map((symbol) => [
        symbol,
        proposedBaseWeights[symbol] * referenceObservation.scale,
      ]))
      : Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
    let turnover = 0;
    const currentReferenceWeights = lockReason === null
      ? Object.fromEntries(symbols.map((symbol) => [
        symbol,
        baseWeights[symbol] * referenceObservation.scale,
      ]))
      : Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
    const referenceScaleChanged = settings.referenceFilterEnabled
      && symbols.some((symbol) => currentReferenceWeights[symbol] !== weights[symbol]);
    const proposedTurnover = symbols.reduce((sum, symbol) => (
      sum + Math.abs(proposedTargetWeights[symbol] - weights[symbol])
    ), 0);
    const suppressSmallRebalance = shouldSuppressSmallRebalance({
      scheduled: scheduledRebalance,
      monthChanged,
      needsLockClose,
      referenceScaleChanged,
      proposedTurnover,
      minimumRebalanceTurnover: settings.minimumRebalanceTurnover,
    });
    const targetWeights = suppressSmallRebalance ? weights : proposedTargetWeights;
    if (!suppressSmallRebalance && lockReason === null) {
      baseWeights = proposedBaseWeights;
      currentLeverage = proposedLeverage;
    }
    if (!suppressSmallRebalance
      && (scheduledRebalance || monthChanged || needsLockClose || referenceScaleChanged)) {
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
    adaptiveObservations.push(currentAdaptiveRisk);
    singleAssetExposures.push(Math.max(...symbols.map((symbol) => Math.abs(weights[symbol]))));
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
      adaptiveObservations,
      singleAssetExposures,
    ),
    equityCurve: resultDates.map((date, index) => ({ date, equity: round(equityCurve[index]) })),
  };
}
