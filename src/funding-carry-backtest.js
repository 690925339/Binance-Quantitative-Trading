const DAYS_PER_YEAR = 365;

export const FUNDING_CARRY_DEFAULTS = Object.freeze({
  lookbackIntervals: 3,
  exitAfterWeakIntervals: 1,
  minimumAverageFundingRate: 0.00005,
  notionalToCapital: 0.8,
  spotFeeRate: 0.001,
  futuresFeeRate: 0.0005,
  slippageRatePerLeg: 0.0002,
});

export const FUNDING_CARRY_RELEASE_TARGETS = Object.freeze({
  minimumCycleWinRate: 0.8,
  minimumCycleWinRateWilson95Lower: 0.6,
  minimumCycles: 30,
  minimumFundingPredictionAccuracy: 0.8,
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
  const settings = { ...FUNDING_CARRY_DEFAULTS, ...options };
  for (const key of ['lookbackIntervals', 'exitAfterWeakIntervals']) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new Error(`${key} 必须是正整数`);
  }
  for (const key of ['minimumAverageFundingRate', 'notionalToCapital', 'spotFeeRate', 'futuresFeeRate', 'slippageRatePerLeg']) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1) {
      throw new Error(`${key} 必须在 0 到 1 之间`);
    }
  }
  if (settings.notionalToCapital <= 0) throw new Error('notionalToCapital 必须大于 0');
  return settings;
}

function validateSeries(seriesBySymbol) {
  const entries = Object.entries(seriesBySymbol || {});
  if (!entries.length) throw new Error('资金费率序列不能为空');
  for (const [symbol, series] of entries) {
    if (!Array.isArray(series) || series.length < 3) throw new Error(`${symbol} 资金费率样本不足`);
    let previousTime = 0;
    for (const item of series) {
      if (!Number.isFinite(item.fundingTime) || item.fundingTime <= previousTime) throw new Error(`${symbol} 资金时间未严格递增`);
      if (![item.fundingRate, item.markPrice, item.spotPrice].every((value) => Number.isFinite(value))) {
        throw new Error(`${symbol} 资金费率或价格无效`);
      }
      if (item.markPrice <= 0 || item.spotPrice <= 0) throw new Error(`${symbol} 价格必须大于 0`);
      previousTime = item.fundingTime;
    }
  }
  return entries;
}

function shouldEnter(series, index, settings) {
  if (index < settings.lookbackIntervals - 1) return false;
  const rates = series.slice(index - settings.lookbackIntervals + 1, index + 1).map((item) => item.fundingRate);
  return rates.every((rate) => rate > 0) && mean(rates) >= settings.minimumAverageFundingRate;
}

function legCosts(quantity, spotPrice, markPrice, settings) {
  const spotNotional = quantity * spotPrice;
  const futuresNotional = quantity * markPrice;
  return spotNotional * (settings.spotFeeRate + settings.slippageRatePerLeg)
    + futuresNotional * (settings.futuresFeeRate + settings.slippageRatePerLeg);
}

function runSymbol(symbol, series, settings, period) {
  const filtered = series.filter((item) => item.fundingTime >= period.startTime && item.fundingTime <= period.endTime);
  if (filtered.length <= settings.lookbackIntervals + 1) {
    return { symbol, finalEquity: 1, cycles: [], predictions: [], equityCurve: [] };
  }
  let equity = 1;
  let cycle = null;
  const cycles = [];
  const predictions = [];
  const equityCurve = [];

  for (let index = settings.lookbackIntervals - 1; index < filtered.length - 1; index += 1) {
    const current = filtered[index];
    const next = filtered[index + 1];
    const desired = shouldEnter(filtered, index, settings);
    if (!desired && cycle) {
      cycle.weakIntervals += 1;
      if (cycle.weakIntervals >= settings.exitAfterWeakIntervals) {
        const exitCost = legCosts(cycle.quantity, current.spotPrice, current.markPrice, settings);
        const basisPnl = cycle.quantity * ((current.spotPrice - cycle.entrySpotPrice)
          - (current.markPrice - cycle.entryMarkPrice));
        const pnl = cycle.fundingPnl + basisPnl - cycle.entryCost - exitCost;
        equity += pnl;
        cycles.push({
          ...cycle,
          exitTime: current.fundingTime,
          fundingPnl: round(cycle.fundingPnl),
          basisPnl: round(basisPnl),
          costs: round(cycle.entryCost + exitCost),
          pnl: round(pnl),
          returnOnCapital: round(pnl / cycle.entryEquity),
          win: pnl > 0,
          settlements: cycle.settlements,
        });
        cycle = null;
      }
    }
    if (!desired && !cycle) {
      equityCurve.push({ time: current.fundingTime, equity: round(equity) });
      continue;
    }

    if (!cycle) {
      const notional = equity * settings.notionalToCapital;
      const quantity = notional / current.spotPrice;
      cycle = {
        symbol,
        entryTime: current.fundingTime,
        entrySpotPrice: current.spotPrice,
        entryMarkPrice: current.markPrice,
        entryEquity: equity,
        quantity,
        entryCost: legCosts(quantity, current.spotPrice, current.markPrice, settings),
        fundingPnl: 0,
        settlements: 0,
        weakIntervals: 0,
      };
    }
    if (desired) cycle.weakIntervals = 0;

    const fundingPnl = cycle.quantity * next.markPrice * next.fundingRate;
    cycle.fundingPnl += fundingPnl;
    cycle.settlements += 1;
    predictions.push({
      symbol,
      decisionTime: current.fundingTime,
      fundingTime: next.fundingTime,
      predictedPositive: true,
      actualFundingRate: next.fundingRate,
      correct: next.fundingRate > 0,
    });
    const unrealizedBasis = cycle.quantity * ((next.spotPrice - cycle.entrySpotPrice)
      - (next.markPrice - cycle.entryMarkPrice));
    equityCurve.push({
      time: next.fundingTime,
      equity: round(equity + cycle.fundingPnl + unrealizedBasis - cycle.entryCost),
    });
  }

  if (cycle) {
    const last = filtered.at(-1);
    const exitCost = legCosts(cycle.quantity, last.spotPrice, last.markPrice, settings);
    const basisPnl = cycle.quantity * ((last.spotPrice - cycle.entrySpotPrice)
      - (last.markPrice - cycle.entryMarkPrice));
    const pnl = cycle.fundingPnl + basisPnl - cycle.entryCost - exitCost;
    equity += pnl;
    cycles.push({
      ...cycle,
      exitTime: last.fundingTime,
      fundingPnl: round(cycle.fundingPnl),
      basisPnl: round(basisPnl),
      costs: round(cycle.entryCost + exitCost),
      pnl: round(pnl),
      returnOnCapital: round(pnl / cycle.entryEquity),
      win: pnl > 0,
      settlements: cycle.settlements,
    });
    equityCurve.push({ time: last.fundingTime, equity: round(equity) });
  }
  return { symbol, finalEquity: equity, cycles, predictions, equityCurve };
}

function combineEquityCurves(results) {
  const times = [...new Set(results.flatMap((result) => result.equityCurve.map((point) => point.time)))].sort((a, b) => a - b);
  const positions = Object.fromEntries(results.map((result) => [result.symbol, 0]));
  const current = Object.fromEntries(results.map((result) => [result.symbol, 1]));
  return times.map((time) => {
    for (const result of results) {
      while (positions[result.symbol] < result.equityCurve.length
        && result.equityCurve[positions[result.symbol]].time <= time) {
        current[result.symbol] = result.equityCurve[positions[result.symbol]].equity;
        positions[result.symbol] += 1;
      }
    }
    return { time, equity: round(mean(Object.values(current))) };
  });
}

function summarize(results, equityCurve, period) {
  const cycles = results.flatMap((result) => result.cycles);
  const predictions = results.flatMap((result) => result.predictions);
  const wins = cycles.filter((cycle) => cycle.win);
  const losses = cycles.filter((cycle) => !cycle.win);
  const grossProfit = wins.reduce((sum, cycle) => sum + cycle.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, cycle) => sum + Math.min(0, cycle.pnl), 0));
  const finalEquity = equityCurve.at(-1)?.equity ?? 1;
  const elapsedDays = Math.max(1, (period.endTime - period.startTime) / 86_400_000);
  let peak = 1;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
  }
  return {
    cycleCount: cycles.length,
    cycleWinRate: round(cycles.length ? wins.length / cycles.length : 0),
    cycleWinRateWilson95Lower: round(wilsonLowerBound(wins.length, cycles.length)),
    fundingPredictionCount: predictions.length,
    fundingPredictionAccuracy: round(predictions.length
      ? predictions.filter((prediction) => prediction.correct).length / predictions.length
      : 0),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0),
    averageCycleReturn: round(mean(cycles.map((cycle) => cycle.returnOnCapital))),
    totalReturn: round(finalEquity - 1),
    annualizedReturn: round(finalEquity > 0 ? finalEquity ** (DAYS_PER_YEAR / elapsedDays) - 1 : -1),
    maxDrawdown: round(maxDrawdown),
  };
}

export function runFundingCarryBacktest(seriesBySymbol, options = {}, period = {}) {
  const settings = mergeOptions(options);
  const entries = validateSeries(seriesBySymbol);
  const allTimes = entries.flatMap(([, series]) => series.map((item) => item.fundingTime));
  const evaluationPeriod = {
    startTime: period.startTime ?? Math.min(...allTimes),
    endTime: period.endTime ?? Math.max(...allTimes),
  };
  const results = entries.map(([symbol, series]) => runSymbol(symbol, series, settings, evaluationPeriod));
  const equityCurve = combineEquityCurves(results);
  return {
    strategy: '现货多头 + 永续空头资金费率组合',
    symbols: entries.map(([symbol]) => symbol),
    settings,
    period: evaluationPeriod,
    metrics: summarize(results, equityCurve, evaluationPeriod),
    cycles: results.flatMap((result) => result.cycles),
    predictions: results.flatMap((result) => result.predictions),
    equityCurve,
  };
}

export function rankFundingCarryCandidates(seriesBySymbol, candidates, period, constraints = {}) {
  const minimumCycles = constraints.minimumCycles ?? 20;
  const minimumProfitFactor = constraints.minimumProfitFactor ?? 1;
  return candidates.map((settings) => runFundingCarryBacktest(seriesBySymbol, settings, period))
    .filter((result) => result.metrics.cycleCount >= minimumCycles && result.metrics.profitFactor >= minimumProfitFactor)
    .sort((left, right) => {
      const lowerBoundDifference = right.metrics.cycleWinRateWilson95Lower - left.metrics.cycleWinRateWilson95Lower;
      if (lowerBoundDifference) return lowerBoundDifference;
      return right.metrics.annualizedReturn - left.metrics.annualizedReturn;
    });
}

export function evaluateFundingCarryRelease(metrics, targets = {}) {
  const settings = { ...FUNDING_CARRY_RELEASE_TARGETS, ...targets };
  const checks = {
    cycleWinRate: metrics.cycleWinRate >= settings.minimumCycleWinRate,
    cycleWinRateWilson95Lower: metrics.cycleWinRateWilson95Lower >= settings.minimumCycleWinRateWilson95Lower,
    cycles: metrics.cycleCount >= settings.minimumCycles,
    fundingPredictionAccuracy: metrics.fundingPredictionAccuracy >= settings.minimumFundingPredictionAccuracy,
    profitFactor: metrics.profitFactor >= settings.minimumProfitFactor,
    minimumAnnualizedReturn: metrics.annualizedReturn >= settings.minimumAnnualizedReturn,
    maximumAnnualizedReturn: metrics.annualizedReturn <= settings.maximumAnnualizedReturn,
    maximumDrawdown: metrics.maxDrawdown >= settings.maximumDrawdown,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    targets: settings,
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key),
  };
}
