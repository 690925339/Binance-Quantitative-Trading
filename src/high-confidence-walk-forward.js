const DAYS_PER_YEAR = 365;

export const HIGH_CONFIDENCE_DEFAULTS = Object.freeze({
  lookbackDays: [14, 42, 84],
  predictionHorizonDays: 14,
  decisionIntervalDays: 14,
  volatilityWindowDays: 30,
  minimumConfidence: 0.45,
  marketWeight: 0.25,
  requireMarketConfirmation: true,
  maxSelectedAssets: 2,
  grossExposure: 0.5,
  tradingCostRate: 0.0007,
  dailyCarryCostRate: 0.00005,
});

export const HIGH_CONFIDENCE_RELEASE_TARGETS = Object.freeze({
  minimumPortfolioAccuracy: 0.8,
  minimumAssetAccuracy: 0.8,
  minimumActiveDecisions: 24,
  minimumAssetForecasts: 36,
  minimumDirectionForecasts: 8,
  minimumSignalCoverage: 0.1,
  minimumAnnualizedReturn: 0.05,
  maximumAnnualizedReturn: 0.1,
  maximumDrawdown: -0.15,
});

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
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
  const settings = { ...HIGH_CONFIDENCE_DEFAULTS, ...options };
  if (!Array.isArray(settings.lookbackDays) || settings.lookbackDays.length < 2) {
    throw new Error('高置信度策略至少需要两个回看周期');
  }
  if (settings.lookbackDays.some((value) => !Number.isInteger(value) || value < 2)) {
    throw new Error('回看周期必须是大于 1 的整数');
  }
  for (const key of ['predictionHorizonDays', 'decisionIntervalDays', 'volatilityWindowDays', 'maxSelectedAssets']) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new Error(`${key} 必须是正整数`);
  }
  if (settings.decisionIntervalDays < settings.predictionHorizonDays) {
    throw new Error('决策间隔不能短于预测窗口，避免重叠标签夸大样本量');
  }
  for (const key of ['minimumConfidence', 'marketWeight', 'grossExposure']) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1) {
      throw new Error(`${key} 必须在 0 到 1 之间`);
    }
  }
  for (const key of ['tradingCostRate', 'dailyCarryCostRate']) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0) throw new Error(`${key} 不能小于 0`);
  }
  return settings;
}

function validateSeries(seriesBySymbol) {
  const entries = Object.entries(seriesBySymbol || {});
  if (entries.length < 2) throw new Error('高置信度组合至少需要两个交易对');
  const dates = entries[0][1]?.map((item) => item.date);
  if (!dates?.length) throw new Error('行情序列不能为空');
  for (const [symbol, series] of entries) {
    if (!Array.isArray(series) || series.length !== dates.length) throw new Error(`${symbol} 行情长度不一致`);
    series.forEach((item, index) => {
      if (item.date !== dates[index]) throw new Error(`${symbol} 在 ${index} 处的日期未对齐`);
      if (!Number.isFinite(item.close) || item.close <= 0) throw new Error(`${symbol} 在 ${item.date} 的收盘价无效`);
    });
  }
  return {
    dates,
    symbols: entries.map(([symbol]) => symbol),
    closesBySymbol: Object.fromEntries(entries.map(([symbol, series]) => [symbol, series.map((item) => item.close)])),
  };
}

function dailyVolatility(closes, index, windowDays) {
  const returns = [];
  for (let cursor = index - windowDays + 1; cursor <= index; cursor += 1) {
    returns.push(Math.log(closes[cursor] / closes[cursor - 1]));
  }
  return sampleStandardDeviation(returns);
}

function momentumFeature(closes, index, lookbacks, volatilityWindowDays) {
  const volatility = dailyVolatility(closes, index, volatilityWindowDays);
  if (!volatility) return null;
  const normalized = lookbacks.map((lookback) => {
    const trendReturn = Math.log(closes[index] / closes[index - lookback]);
    return clamp(trendReturn / (volatility * Math.sqrt(lookback)), -3, 3) / 3;
  });
  const directions = normalized.map(Math.sign).filter(Boolean);
  const score = mean(normalized);
  const direction = Math.sign(score);
  const agreement = directions.length
    ? directions.filter((value) => value === direction).length / lookbacks.length
    : 0;
  return { score, direction, agreement };
}

function buildDecision({ symbols, closesBySymbol, index, settings }) {
  const features = symbols.map((symbol) => ({
    symbol,
    feature: momentumFeature(
      closesBySymbol[symbol],
      index,
      settings.lookbackDays,
      settings.volatilityWindowDays,
    ),
  })).filter((item) => item.feature?.direction);
  if (!features.length) return [];

  const marketScore = mean(features.map((item) => item.feature.score));
  const marketDirection = Math.sign(marketScore);
  return features.map(({ symbol, feature }) => {
    const combinedScore = (1 - settings.marketWeight) * feature.score + settings.marketWeight * marketScore;
    const direction = Math.sign(combinedScore);
    const marketConfirmed = !settings.requireMarketConfirmation
      || marketDirection === 0
      || direction === marketDirection;
    const confidence = Math.abs(combinedScore) * feature.agreement;
    return {
      symbol,
      direction,
      confidence,
      marketConfirmed,
    };
  }).filter((item) => (
    item.direction !== 0
    && item.marketConfirmed
    && item.confidence >= settings.minimumConfidence
  )).sort((left, right) => right.confidence - left.confidence)
    .slice(0, settings.maxSelectedAssets);
}

function summarize(events, eligibleDecisionCount, settings, evaluationPeriod) {
  const assetForecasts = events.flatMap((event) => event.forecasts);
  const correctEvents = events.filter((event) => event.correct).length;
  const correctAssets = assetForecasts.filter((forecast) => forecast.correct).length;
  const longForecasts = assetForecasts.filter((forecast) => forecast.direction > 0);
  const shortForecasts = assetForecasts.filter((forecast) => forecast.direction < 0);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const event of events) {
    equity *= 1 + settings.grossExposure * event.netDirectionalReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const elapsedDays = evaluationPeriod.startDate && evaluationPeriod.endDate
    ? Math.max(1, (Date.parse(evaluationPeriod.endDate) - Date.parse(evaluationPeriod.startDate)) / 86_400_000)
    : 0;
  const annualizedReturn = elapsedDays > 0 && equity > 0
    ? equity ** (DAYS_PER_YEAR / elapsedDays) - 1
    : 0;
  return {
    eligibleDecisionCount,
    activeDecisionCount: events.length,
    signalCoverage: round(eligibleDecisionCount ? events.length / eligibleDecisionCount : 0),
    portfolioAccuracy: round(events.length ? correctEvents / events.length : 0),
    portfolioAccuracyWilson95Lower: round(wilsonLowerBound(correctEvents, events.length)),
    assetForecastCount: assetForecasts.length,
    assetAccuracy: round(assetForecasts.length ? correctAssets / assetForecasts.length : 0),
    longForecastCount: longForecasts.length,
    longAccuracy: round(longForecasts.length ? longForecasts.filter((item) => item.correct).length / longForecasts.length : 0),
    shortForecastCount: shortForecasts.length,
    shortAccuracy: round(shortForecasts.length ? shortForecasts.filter((item) => item.correct).length / shortForecasts.length : 0),
    totalReturn: round(equity - 1),
    annualizedReturn: round(annualizedReturn),
    maxDrawdown: round(maxDrawdown),
    averageEventReturn: round(mean(events.map((event) => event.netDirectionalReturn))),
  };
}

export function runHighConfidenceBacktest(seriesBySymbol, options = {}, period = {}) {
  const settings = mergeOptions(options);
  const { dates, symbols, closesBySymbol } = validateSeries(seriesBySymbol);
  const warmupDays = Math.max(...settings.lookbackDays, settings.volatilityWindowDays);
  const finalIndex = dates.length - settings.predictionHorizonDays - 1;
  if (finalIndex <= warmupDays) throw new Error('行情长度不足以完成高置信度回测');
  const startDate = period.startDate || dates[warmupDays];
  const endDate = period.endDate || dates[finalIndex];
  const roundTripCost = settings.tradingCostRate * 2
    + settings.dailyCarryCostRate * settings.predictionHorizonDays;
  const events = [];
  let eligibleDecisionCount = 0;
  let evaluationStartDate = null;
  let evaluationEndDate = null;

  for (let index = warmupDays; index <= finalIndex; index += settings.decisionIntervalDays) {
    const date = dates[index];
    if (date < startDate || date > endDate) continue;
    eligibleDecisionCount += 1;
    evaluationStartDate ||= date;
    evaluationEndDate = dates[index + settings.predictionHorizonDays];
    const selected = buildDecision({ symbols, closesBySymbol, index, settings });
    if (!selected.length) continue;
    const forecasts = selected.map((item) => {
      const futureReturn = closesBySymbol[item.symbol][index + settings.predictionHorizonDays]
        / closesBySymbol[item.symbol][index] - 1;
      const directionalReturn = item.direction * futureReturn - roundTripCost;
      return {
        ...item,
        futureReturn: round(futureReturn),
        netDirectionalReturn: round(directionalReturn),
        correct: directionalReturn > 0,
      };
    });
    const netDirectionalReturn = mean(forecasts.map((item) => item.netDirectionalReturn));
    events.push({
      date,
      exitDate: dates[index + settings.predictionHorizonDays],
      forecasts,
      netDirectionalReturn: round(netDirectionalReturn),
      correct: netDirectionalReturn > 0,
    });
  }

  return {
    strategy: '高置信度多空趋势组合',
    period: { startDate, endDate },
    symbols,
    settings,
    metrics: summarize(events, eligibleDecisionCount, settings, {
      startDate: evaluationStartDate,
      endDate: evaluationEndDate,
    }),
    events,
  };
}

export function rankHighConfidenceCandidates(seriesBySymbol, candidates, period, constraints = {}) {
  const minimumActiveDecisions = constraints.minimumActiveDecisions ?? 12;
  const minimumDirectionForecasts = constraints.minimumDirectionForecasts ?? 3;
  const minimumCoverage = constraints.minimumCoverage ?? 0.1;
  const minimumAnnualizedReturn = constraints.minimumAnnualizedReturn ?? 0;
  const maximumDrawdown = constraints.maximumDrawdown ?? -1;
  return candidates.map((settings) => runHighConfidenceBacktest(seriesBySymbol, settings, period))
    .filter((result) => (
      result.metrics.activeDecisionCount >= minimumActiveDecisions
      && result.metrics.longForecastCount >= minimumDirectionForecasts
      && result.metrics.shortForecastCount >= minimumDirectionForecasts
      && result.metrics.signalCoverage >= minimumCoverage
      && result.metrics.annualizedReturn >= minimumAnnualizedReturn
      && result.metrics.maxDrawdown >= maximumDrawdown
    ))
    .sort((left, right) => {
      const lowerBoundDifference = right.metrics.portfolioAccuracyWilson95Lower
        - left.metrics.portfolioAccuracyWilson95Lower;
      if (lowerBoundDifference) return lowerBoundDifference;
      const accuracyDifference = right.metrics.portfolioAccuracy - left.metrics.portfolioAccuracy;
      if (accuracyDifference) return accuracyDifference;
      const assetAccuracyDifference = right.metrics.assetAccuracy - left.metrics.assetAccuracy;
      if (assetAccuracyDifference) return assetAccuracyDifference;
      return right.metrics.annualizedReturn - left.metrics.annualizedReturn;
    });
}

export function evaluateHighConfidenceRelease(metrics, targets = {}) {
  const settings = { ...HIGH_CONFIDENCE_RELEASE_TARGETS, ...targets };
  const checks = {
    portfolioAccuracy: metrics.portfolioAccuracy >= settings.minimumPortfolioAccuracy,
    assetAccuracy: metrics.assetAccuracy >= settings.minimumAssetAccuracy,
    activeDecisions: metrics.activeDecisionCount >= settings.minimumActiveDecisions,
    assetForecasts: metrics.assetForecastCount >= settings.minimumAssetForecasts,
    longForecasts: metrics.longForecastCount >= settings.minimumDirectionForecasts,
    shortForecasts: metrics.shortForecastCount >= settings.minimumDirectionForecasts,
    signalCoverage: metrics.signalCoverage >= settings.minimumSignalCoverage,
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
