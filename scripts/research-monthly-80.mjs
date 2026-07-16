import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLongShortTrendBacktest } from '../src/long-short-trend.js';
import { runCrossSectionalBacktest } from '../src/cross-sectional-backtest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const sentimentDir = path.join(rootDir, 'data', 'market', 'sentiment');
const manifest = JSON.parse(await fs.readFile(path.join(marketDir, 'manifest.json'), 'utf8'));
const developmentPeriod = { startMonth: '2023-08', endMonth: '2024-12' };
const validationPeriod = { startMonth: '2025-01', endMonth: '2026-06' };
const reportStartDate = '2023-01-01';
const manifestEnd = new Date(manifest.requestedEndTimeUtc);
const endContainsCompleteUtcDay = manifestEnd.getUTCHours() === 23
  && manifestEnd.getUTCMinutes() === 59
  && manifestEnd.getUTCSeconds() === 59;
if (!endContainsCompleteUtcDay) manifestEnd.setUTCDate(manifestEnd.getUTCDate() - 1);
const reportEndDate = manifestEnd.toISOString().slice(0, 10);
const completeMonthCursor = new Date(`${reportEndDate}T00:00:00.000Z`);
completeMonthCursor.setUTCDate(0);
const reportCompletePeriod = {
  startMonth: reportStartDate.slice(0, 7),
  endMonth: completeMonthCursor.toISOString().slice(0, 7),
};

async function loadDailySeries(dataset) {
  const text = await fs.readFile(path.join(marketDir, dataset.file), 'utf8');
  const [headerLine, ...rows] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const dateIndex = headers.indexOf('open_time_utc');
  const closeIndex = headers.indexOf('close');
  const byDate = new Map();
  for (const row of rows) {
    const columns = row.split(',');
    byDate.set(columns[dateIndex].slice(0, 10), Number(columns[closeIndex]));
  }
  return [...byDate.entries()].map(([date, close]) => ({ date, close }));
}

async function loadFearGreedSeries() {
  const text = await fs.readFile(path.join(sentimentDir, 'fear-greed.csv'), 'utf8');
  const [headerLine, ...rows] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const dateIndex = headers.indexOf('date');
  const valueIndex = headers.indexOf('value');
  if (dateIndex < 0 || valueIndex < 0) throw new Error('恐惧指数 CSV 缺少 date 或 value 列');
  const result = new Map();
  for (const row of rows) {
    const columns = row.split(',');
    const date = columns[dateIndex];
    const value = Number(columns[valueIndex]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(value)
      || value < 0
      || value > 100) {
      throw new Error(`恐惧指数 CSV 存在非法记录：${row}`);
    }
    result.set(date, value);
  }
  return result;
}

const loaded = Object.fromEntries(await Promise.all(manifest.datasets.map(async (dataset) => [
  dataset.symbol,
  await loadDailySeries(dataset),
])));
const commonDates = Object.values(loaded).map((series) => new Set(series.map((item) => item.date)))
  .reduce((intersection, dates) => new Set([...intersection].filter((date) => dates.has(date))));
const seriesBySymbol = Object.fromEntries(Object.entries(loaded).map(([symbol, series]) => [
  symbol,
  series.filter((item) => commonDates.has(item.date) && item.date <= reportEndDate),
]));
const fearGreedByDate = await loadFearGreedSeries();

function monthlyReturns(equityCurve) {
  const monthEnds = new Map();
  for (const point of equityCurve) monthEnds.set(point.date.slice(0, 7), point.equity);
  let previousEquity = 1;
  return [...monthEnds.entries()].map(([month, equity]) => {
    const value = equity / previousEquity - 1;
    previousEquity = equity;
    return { month, value };
  });
}

function periodMetrics(result, period) {
  const monthly = monthlyReturns(result.equityCurve)
    .filter((item) => item.month >= period.startMonth && item.month <= period.endMonth);
  const totalReturn = monthly.reduce((equity, item) => equity * (1 + item.value), 1) - 1;
  const annualizedReturn = (1 + totalReturn) ** (12 / monthly.length) - 1;
  const positiveMonths = monthly.filter((item) => item.value > 0).length;
  const startDate = `${period.startMonth}-01`;
  const endDate = `${period.endMonth}-31`;
  const startingEquity = result.equityCurve.filter((point) => point.date < startDate).at(-1)?.equity || 1;
  const daily = result.equityCurve.filter((point) => point.date >= startDate && point.date <= endDate);
  let peak = startingEquity;
  let maxDrawdown = 0;
  for (const point of daily) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
  }
  return {
    monthCount: monthly.length,
    positiveMonths,
    positiveMonthRatio: positiveMonths / monthly.length,
    totalReturn,
    annualizedReturn,
    maxDrawdown,
    monthly,
  };
}

function dateRangeMetrics(result, startDate, endDate) {
  const startingEquity = result.equityCurve.filter((point) => point.date < startDate).at(-1)?.equity || 1;
  const daily = result.equityCurve.filter((point) => point.date >= startDate && point.date <= endDate);
  if (!daily.length) throw new Error(`回测范围 ${startDate} 至 ${endDate} 没有可用净值`);
  let peak = startingEquity;
  let maxDrawdown = 0;
  const yearEnds = new Map();
  for (const point of daily) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
    yearEnds.set(point.date.slice(0, 4), point.equity);
  }
  const totalReturn = daily.at(-1).equity / startingEquity - 1;
  const elapsedDays = Math.max(1, (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000);
  let previousEquity = startingEquity;
  const annualReturns = {};
  for (const [year, endingEquity] of yearEnds) {
    annualReturns[year] = endingEquity / previousEquity - 1;
    previousEquity = endingEquity;
  }
  return {
    startDate,
    endDate,
    totalReturn,
    annualizedReturn: (1 + totalReturn) ** (365 / elapsedDays) - 1,
    maxDrawdown,
    annualReturns,
  };
}

function combineResults(results, weights = results.map(() => 1 / results.length)) {
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const normalizedWeights = weights.map((value) => value / weightTotal);
  const returnMaps = results.map((result) => {
    let previousEquity = 1;
    return new Map(result.equityCurve.map((point) => {
      const dailyReturn = point.equity / previousEquity - 1;
      previousEquity = point.equity;
      return [point.date, dailyReturn];
    }));
  });
  const commonDates = [...returnMaps[0].keys()]
    .filter((date) => returnMaps.every((returns) => returns.has(date)));
  let equity = 1;
  const equityCurve = commonDates.map((date) => {
    const dailyReturn = returnMaps.reduce((sum, returns, index) => (
      sum + returns.get(date) * normalizedWeights[index]
    ), 0);
    equity *= 1 + dailyReturn;
    return { date, equity };
  });
  return { equityCurve };
}

function fullCurveMetrics(result) {
  const { equityCurve } = result;
  let peak = 1;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
  }
  const elapsedDays = Math.max(
    1,
    (Date.parse(equityCurve.at(-1).date) - Date.parse(equityCurve[0].date)) / 86_400_000,
  );
  return {
    totalReturn: equityCurve.at(-1).equity - 1,
    annualizedReturn: equityCurve.at(-1).equity ** (365 / elapsedDays) - 1,
    maxDrawdown,
  };
}

const signalProfiles = [
  { lookbackDays: [20, 60, 120], minimumTrendVotes: 2, minimumActiveSignals: 1, minimumTrendStrength: 0.02 },
  { lookbackDays: [20, 60, 120], minimumTrendVotes: 2, minimumActiveSignals: 1, minimumTrendStrength: 0.04 },
  { lookbackDays: [20, 60, 120], minimumTrendVotes: 3, minimumActiveSignals: 2, minimumTrendStrength: 0.04 },
  { lookbackDays: [20, 60, 120], minimumTrendVotes: 3, minimumActiveSignals: 2, minimumTrendStrength: 0.06 },
  { lookbackDays: [30, 60, 120], minimumTrendVotes: 2, minimumActiveSignals: 1, minimumTrendStrength: 0.03 },
  { lookbackDays: [30, 60, 120], minimumTrendVotes: 3, minimumActiveSignals: 2, minimumTrendStrength: 0.04 },
  { lookbackDays: [30, 90, 180], minimumTrendVotes: 2, minimumActiveSignals: 1, minimumTrendStrength: 0.02 },
  { lookbackDays: [45, 90, 180], minimumTrendVotes: 2, minimumActiveSignals: 1, minimumTrendStrength: 0.02 },
  { lookbackDays: [60, 120, 240], minimumTrendVotes: 2, minimumActiveSignals: 1, minimumTrendStrength: 0.02 },
];
const riskProfiles = [
  { targetVolatility: 0.15, maxGrossExposure: 0.75, maxAssetExposure: 0.225 },
  { targetVolatility: 0.20, maxGrossExposure: 1.00, maxAssetExposure: 0.30 },
  { targetVolatility: 0.25, maxGrossExposure: 1.25, maxAssetExposure: 0.375 },
  {
    targetVolatility: 0.10,
    maxGrossExposure: 1,
    maxAssetExposure: 0.30,
    dynamicLeverageEnabled: true,
    dynamicLeverageMin: 1,
    dynamicLeverageMax: 2,
    dynamicLeverageStrengthTarget: 0.10,
  },
  {
    targetVolatility: 0.10,
    maxGrossExposure: 1,
    maxAssetExposure: 0.30,
    dynamicLeverageEnabled: true,
    dynamicLeverageMin: 1,
    dynamicLeverageMax: 3,
    dynamicLeverageStrengthTarget: 0.20,
  },
];
const candidates = [];
for (const signalProfile of signalProfiles) {
  for (const riskProfile of riskProfiles) {
    for (const monthlyProfitLock of [0.004, 0.006, 0.008, 0.01, 0.0125, 0.015, 0.02]) {
      for (const monthlyLossLimit of [null, 0.01, 0.015, 0.02, 0.03, 0.05]) {
        candidates.push({
          ...signalProfile,
          ...riskProfile,
          volatilityWindowDays: 30,
          rebalanceDays: 1,
          monthlyProfitLock,
          monthlyLossLimit,
        });
      }
    }
  }
}

const baselineSettings = {
  targetVolatility: 0.20,
  maxGrossExposure: 1,
  maxAssetExposure: 0.30,
};
const baselineResult = runLongShortTrendBacktest(seriesBySymbol, baselineSettings);
const baseline = {
  settings: baselineSettings,
  development: periodMetrics(baselineResult, developmentPeriod),
  validation: periodMetrics(baselineResult, validationPeriod),
  full: baselineResult.metrics,
};

const evaluated = candidates.map((settings) => {
  const result = runLongShortTrendBacktest(seriesBySymbol, settings);
  return { settings, result, development: periodMetrics(result, developmentPeriod) };
});
const ranked = evaluated.filter((candidate) => (
  candidate.development.annualizedReturn >= 0.05
  && candidate.development.maxDrawdown >= -0.25
)).sort((left, right) => (
  right.development.positiveMonthRatio - left.development.positiveMonthRatio
  || right.development.annualizedReturn - left.development.annualizedReturn
  || right.development.maxDrawdown - left.development.maxDrawdown
));
const frozenCandidate = ranked[0] || null;
const frozen = frozenCandidate ? {
  settings: frozenCandidate.settings,
  development: frozenCandidate.development,
  validation: periodMetrics(frozenCandidate.result, validationPeriod),
  full: frozenCandidate.result.metrics,
} : null;
const crossSectionalCandidates = [];
for (const mode of ['momentum', 'meanReversion']) {
  for (const lookbackDays of [3, 5, 10, 20, 40, 60]) {
    for (const rebalanceDays of [1, 3, 7]) {
      for (const positionsPerSide of [1, 2]) {
        for (const riskProfile of [
          { baseGrossExposure: 0.5, maxGrossExposure: 0.5 },
          { baseGrossExposure: 0.75, maxGrossExposure: 0.75 },
          { baseGrossExposure: 1, maxGrossExposure: 1 },
          {
            baseGrossExposure: 0.5,
            maxGrossExposure: 1.5,
            dynamicLeverageEnabled: true,
            dynamicLeverageMax: 3,
            dispersionTarget: 0.15,
          },
        ]) {
          for (const monthlyProfitLock of [0.006, 0.008, 0.01, 0.0125, 0.015]) {
            for (const monthlyLossLimit of [null, 0.01, 0.015, 0.02, 0.03]) {
              crossSectionalCandidates.push({
                mode,
                lookbackDays,
                rebalanceDays,
                positionsPerSide,
                ...riskProfile,
                monthlyProfitLock,
                monthlyLossLimit,
              });
            }
          }
        }
      }
    }
  }
}
const evaluatedCrossSectional = crossSectionalCandidates.map((settings) => {
  const result = runCrossSectionalBacktest(seriesBySymbol, settings);
  return { settings, result, development: periodMetrics(result, developmentPeriod) };
});
const rankedCrossSectional = evaluatedCrossSectional.filter((candidate) => (
  candidate.development.annualizedReturn >= 0.05
  && candidate.development.maxDrawdown >= -0.25
)).sort((left, right) => (
  right.development.positiveMonthRatio - left.development.positiveMonthRatio
  || right.development.annualizedReturn - left.development.annualizedReturn
  || right.development.maxDrawdown - left.development.maxDrawdown
));
const crossSectionalCandidate = rankedCrossSectional[0] || null;
const crossSectional = crossSectionalCandidate ? {
  settings: crossSectionalCandidate.settings,
  development: crossSectionalCandidate.development,
  validation: periodMetrics(crossSectionalCandidate.result, validationPeriod),
  full: crossSectionalCandidate.result.metrics,
} : null;
const blendedCandidates = frozenCandidate && crossSectionalCandidate
  ? [0.2, 0.35, 0.5, 0.65, 0.8].map((trendWeight) => {
    const result = combineResults(
      [frozenCandidate.result, crossSectionalCandidate.result],
      [trendWeight, 1 - trendWeight],
    );
    return {
      trendWeight,
      crossSectionalWeight: 1 - trendWeight,
      result,
      development: periodMetrics(result, developmentPeriod),
    };
  }).filter((candidate) => (
    candidate.development.positiveMonthRatio >= 0.80
    && candidate.development.annualizedReturn >= 0.10
    && candidate.development.maxDrawdown >= -0.15
  )).sort((left, right) => (
    right.development.positiveMonthRatio - left.development.positiveMonthRatio
    || right.development.annualizedReturn - left.development.annualizedReturn
    || right.development.maxDrawdown - left.development.maxDrawdown
  ))
  : [];
const fixedWeightDiagnostics = frozenCandidate && crossSectionalCandidate
  ? [0, 0.05, 0.10, 0.15, 0.20, 0.25].map((trendWeight) => {
    const result = combineResults(
      [frozenCandidate.result, crossSectionalCandidate.result],
      [trendWeight, 1 - trendWeight],
    );
    return {
      trendWeight,
      crossSectionalWeight: 1 - trendWeight,
      development: periodMetrics(result, developmentPeriod),
      validation: periodMetrics(result, validationPeriod),
      historicalRange: {
        completeMonths: periodMetrics(result, reportCompletePeriod),
        toDate: dateRangeMetrics(result, reportStartDate, reportEndDate),
      },
    };
  })
  : [];
const blendedCandidate = blendedCandidates[0] || null;
const blended = blendedCandidate ? {
  trendWeight: blendedCandidate.trendWeight,
  crossSectionalWeight: blendedCandidate.crossSectionalWeight,
  development: blendedCandidate.development,
  validation: periodMetrics(blendedCandidate.result, validationPeriod),
  full: fullCurveMetrics(blendedCandidate.result),
} : null;
const historicalRange = blendedCandidate ? {
  startDate: reportStartDate,
  endDate: reportEndDate,
  completeMonthPeriod: reportCompletePeriod,
  completeMonths: periodMetrics(blendedCandidate.result, reportCompletePeriod),
  toDate: dateRangeMetrics(blendedCandidate.result, reportStartDate, reportEndDate),
} : null;
const referenceFilterCandidates = [];
for (const fearRange of [
  { fearGreedMinimum: null, fearGreedMaximum: null },
  { fearGreedMinimum: 10, fearGreedMaximum: 90 },
  { fearGreedMinimum: 15, fearGreedMaximum: 85 },
  { fearGreedMinimum: 20, fearGreedMaximum: 80 },
  { fearGreedMinimum: 25, fearGreedMaximum: 75 },
  { fearGreedMinimum: 30, fearGreedMaximum: 70 },
]) {
  for (const maximumMarketVolatility of [null, 0.60, 0.80, 1.00]) {
    for (const maximumBreadthImbalance of [null, 0.50, 0.67, 1.00]) {
      for (const referenceOutsideScale of [0, 0.25, 0.50, 0.75]) {
        if (fearRange.fearGreedMinimum === null
          && maximumMarketVolatility === null
          && maximumBreadthImbalance === null) continue;
        referenceFilterCandidates.push({
          referenceFilterEnabled: true,
          referenceWindowDays: 20,
          ...fearRange,
          maximumMarketVolatility,
          maximumBreadthImbalance,
          referenceOutsideScale,
        });
      }
    }
  }
}
const evaluatedReferenceFilters = blendedCandidate && frozenCandidate && crossSectionalCandidate
  ? referenceFilterCandidates.map((referenceSettings) => {
    const crossResult = runCrossSectionalBacktest(
      seriesBySymbol,
      { ...crossSectionalCandidate.settings, ...referenceSettings },
      { fearGreedByDate },
    );
    const result = combineResults(
      [frozenCandidate.result, crossResult],
      [blendedCandidate.trendWeight, blendedCandidate.crossSectionalWeight],
    );
    return {
      referenceSettings,
      crossResult,
      result,
      development: periodMetrics(result, developmentPeriod),
    };
  })
  : [];
const rankedReferenceFilters = evaluatedReferenceFilters.filter((candidate) => (
  candidate.development.positiveMonthRatio >= 0.80
  && candidate.development.annualizedReturn >= 0.10
  && candidate.development.maxDrawdown >= -0.15
)).sort((left, right) => (
  right.development.positiveMonthRatio - left.development.positiveMonthRatio
  || right.development.annualizedReturn - left.development.annualizedReturn
  || right.development.maxDrawdown - left.development.maxDrawdown
));
const referenceFilterCandidate = rankedReferenceFilters[0] || null;
const referenceFiltered = referenceFilterCandidate ? {
  referenceSettings: referenceFilterCandidate.referenceSettings,
  development: referenceFilterCandidate.development,
  validation: periodMetrics(referenceFilterCandidate.result, validationPeriod),
  full: fullCurveMetrics(referenceFilterCandidate.result),
  referenceUsage: {
    averageReferenceScale: referenceFilterCandidate.crossResult.metrics.averageReferenceScale,
    referenceFilteredDays: referenceFilterCandidate.crossResult.metrics.referenceFilteredDays,
    missingFearGreedDays: referenceFilterCandidate.crossResult.metrics.missingFearGreedDays,
  },
} : null;
const referenceHistoricalRange = referenceFilterCandidate ? {
  startDate: reportStartDate,
  endDate: reportEndDate,
  completeMonthPeriod: reportCompletePeriod,
  completeMonths: periodMetrics(referenceFilterCandidate.result, reportCompletePeriod),
  toDate: dateRangeMetrics(referenceFilterCandidate.result, reportStartDate, reportEndDate),
} : null;
const referencePromotionChecks = referenceFiltered && blended && historicalRange ? {
  developmentMonthlyAccuracyNotLower:
    referenceFiltered.development.positiveMonthRatio >= blended.development.positiveMonthRatio,
  validationMonthlyAccuracyImproved:
    referenceFiltered.validation.positiveMonthRatio > blended.validation.positiveMonthRatio,
  validationAnnualizedReturnNotLower:
    referenceFiltered.validation.annualizedReturn >= blended.validation.annualizedReturn,
  validationMaxDrawdownNotWorse:
    referenceFiltered.validation.maxDrawdown >= blended.validation.maxDrawdown,
  historicalMonthlyAccuracyNotLower:
    referenceHistoricalRange.completeMonths.positiveMonthRatio
      >= historicalRange.completeMonths.positiveMonthRatio,
  historicalAnnualizedReturnNotLower:
    referenceHistoricalRange.toDate.annualizedReturn >= historicalRange.toDate.annualizedReturn,
  historicalMaxDrawdownNotWorse:
    referenceHistoricalRange.toDate.maxDrawdown >= historicalRange.toDate.maxDrawdown,
} : {};
const referenceFilterPromoted = referenceFiltered
  && Object.values(referencePromotionChecks).every(Boolean);
const developmentQualified = evaluated.filter((candidate) => (
  candidate.development.positiveMonthRatio >= 0.80
  && candidate.development.annualizedReturn >= 0.08
  && candidate.development.maxDrawdown >= -0.15
)).sort((left, right) => (
  right.development.annualizedReturn - left.development.annualizedReturn
  || right.development.maxDrawdown - left.development.maxDrawdown
));
const diverseMembers = [];
const usedSignals = new Set();
for (const candidate of developmentQualified) {
  const key = JSON.stringify({
    lookbackDays: candidate.settings.lookbackDays,
    minimumTrendVotes: candidate.settings.minimumTrendVotes,
    minimumActiveSignals: candidate.settings.minimumActiveSignals,
    minimumTrendStrength: candidate.settings.minimumTrendStrength,
  });
  if (usedSignals.has(key)) continue;
  usedSignals.add(key);
  diverseMembers.push(candidate);
}
const ensembleCandidates = [];
for (let mask = 1; mask < 2 ** diverseMembers.length; mask += 1) {
  const members = diverseMembers.filter((_, index) => (mask & (1 << index)) !== 0);
  if (members.length < 2 || members.length > 6) continue;
  const result = combineResults(members.map((member) => member.result));
  const development = periodMetrics(result, developmentPeriod);
  if (development.positiveMonthRatio < 0.80
    || development.annualizedReturn < 0.10
    || development.maxDrawdown < -0.15) continue;
  ensembleCandidates.push({ members, result, development });
}
ensembleCandidates.sort((left, right) => (
  right.development.positiveMonthRatio - left.development.positiveMonthRatio
  || right.development.annualizedReturn - left.development.annualizedReturn
  || right.development.maxDrawdown - left.development.maxDrawdown
));
const ensembleCandidate = ensembleCandidates[0] || null;
const ensemble = ensembleCandidate ? {
  memberCount: ensembleCandidate.members.length,
  memberSettings: ensembleCandidate.members.map((member) => member.settings),
  development: ensembleCandidate.development,
  validation: periodMetrics(ensembleCandidate.result, validationPeriod),
  full: fullCurveMetrics(ensembleCandidate.result),
} : null;
const releaseChecks = frozen ? {
  developmentMonthlyAccuracy: frozen.development.positiveMonthRatio >= 0.80,
  validationMonthlyAccuracy: frozen.validation.positiveMonthRatio >= 0.80,
  validationAnnualizedReturn: frozen.validation.annualizedReturn >= 0.10,
  validationMaxDrawdown: frozen.validation.maxDrawdown >= -0.25,
  fullAnnualizedReturn: frozen.full.annualizedReturn >= 0.10,
  fullMaxDrawdown: frozen.full.maxDrawdown >= -0.30,
} : {};
const releasePassed = frozen && Object.values(releaseChecks).every(Boolean);
const ensembleReleaseChecks = ensemble ? {
  developmentMonthlyAccuracy: ensemble.development.positiveMonthRatio >= 0.80,
  validationMonthlyAccuracy: ensemble.validation.positiveMonthRatio >= 0.80,
  validationAnnualizedReturn: ensemble.validation.annualizedReturn >= 0.10,
  validationMaxDrawdown: ensemble.validation.maxDrawdown >= -0.25,
  fullAnnualizedReturn: ensemble.full.annualizedReturn >= 0.10,
  fullMaxDrawdown: ensemble.full.maxDrawdown >= -0.30,
} : {};
const ensembleReleasePassed = ensemble && Object.values(ensembleReleaseChecks).every(Boolean);
const crossSectionalReleaseChecks = crossSectional ? {
  developmentMonthlyAccuracy: crossSectional.development.positiveMonthRatio >= 0.80,
  validationMonthlyAccuracy: crossSectional.validation.positiveMonthRatio >= 0.80,
  validationAnnualizedReturn: crossSectional.validation.annualizedReturn >= 0.10,
  validationMaxDrawdown: crossSectional.validation.maxDrawdown >= -0.25,
  fullAnnualizedReturn: crossSectional.full.annualizedReturn >= 0.10,
  fullMaxDrawdown: crossSectional.full.maxDrawdown >= -0.30,
} : {};
const crossSectionalReleasePassed = crossSectional && Object.values(crossSectionalReleaseChecks).every(Boolean);
const blendedReleaseChecks = blended ? {
  developmentMonthlyAccuracy: blended.development.positiveMonthRatio >= 0.80,
  validationMonthlyAccuracy: blended.validation.positiveMonthRatio >= 0.80,
  validationAnnualizedReturn: blended.validation.annualizedReturn >= 0.10,
  validationMaxDrawdown: blended.validation.maxDrawdown >= -0.25,
  fullAnnualizedReturn: blended.full.annualizedReturn >= 0.10,
  fullMaxDrawdown: blended.full.maxDrawdown >= -0.30,
} : {};
const blendedReleasePassed = blended && Object.values(blendedReleaseChecks).every(Boolean);
const overallReleasePassed = crossSectionalReleasePassed || blendedReleasePassed;
const percent = (value) => `${(value * 100).toFixed(2)}%`;

console.table({
  '固定 2.0× / 开发': {
    '盈利月': `${baseline.development.positiveMonths}/${baseline.development.monthCount}`,
    '月准确率': percent(baseline.development.positiveMonthRatio),
    '年化': percent(baseline.development.annualizedReturn),
    '最大回撤': percent(baseline.development.maxDrawdown),
  },
  '固定 2.0× / 验证': {
    '盈利月': `${baseline.validation.positiveMonths}/${baseline.validation.monthCount}`,
    '月准确率': percent(baseline.validation.positiveMonthRatio),
    '年化': percent(baseline.validation.annualizedReturn),
    '最大回撤': percent(baseline.validation.maxDrawdown),
  },
  ...(frozen ? {
    '冻结月保护 / 开发': {
      '盈利月': `${frozen.development.positiveMonths}/${frozen.development.monthCount}`,
      '月准确率': percent(frozen.development.positiveMonthRatio),
      '年化': percent(frozen.development.annualizedReturn),
      '最大回撤': percent(frozen.development.maxDrawdown),
    },
    '冻结月保护 / 验证': {
      '盈利月': `${frozen.validation.positiveMonths}/${frozen.validation.monthCount}`,
      '月准确率': percent(frozen.validation.positiveMonthRatio),
      '年化': percent(frozen.validation.annualizedReturn),
      '最大回撤': percent(frozen.validation.maxDrawdown),
    },
  } : {}),
  ...(ensemble ? {
    '冻结等权组合 / 开发': {
      '盈利月': `${ensemble.development.positiveMonths}/${ensemble.development.monthCount}`,
      '月准确率': percent(ensemble.development.positiveMonthRatio),
      '年化': percent(ensemble.development.annualizedReturn),
      '最大回撤': percent(ensemble.development.maxDrawdown),
    },
    '冻结等权组合 / 验证': {
      '盈利月': `${ensemble.validation.positiveMonths}/${ensemble.validation.monthCount}`,
      '月准确率': percent(ensemble.validation.positiveMonthRatio),
      '年化': percent(ensemble.validation.annualizedReturn),
      '最大回撤': percent(ensemble.validation.maxDrawdown),
    },
  } : {}),
  ...(crossSectional ? {
    '冻结市场中性 / 开发': {
      '盈利月': `${crossSectional.development.positiveMonths}/${crossSectional.development.monthCount}`,
      '月准确率': percent(crossSectional.development.positiveMonthRatio),
      '年化': percent(crossSectional.development.annualizedReturn),
      '最大回撤': percent(crossSectional.development.maxDrawdown),
    },
    '冻结市场中性 / 验证': {
      '盈利月': `${crossSectional.validation.positiveMonths}/${crossSectional.validation.monthCount}`,
      '月准确率': percent(crossSectional.validation.positiveMonthRatio),
      '年化': percent(crossSectional.validation.annualizedReturn),
      '最大回撤': percent(crossSectional.validation.maxDrawdown),
    },
  } : {}),
  ...(blended ? {
    '冻结趋势中性组合 / 开发': {
      '盈利月': `${blended.development.positiveMonths}/${blended.development.monthCount}`,
      '月准确率': percent(blended.development.positiveMonthRatio),
      '年化': percent(blended.development.annualizedReturn),
      '最大回撤': percent(blended.development.maxDrawdown),
    },
    '冻结趋势中性组合 / 验证': {
      '盈利月': `${blended.validation.positiveMonths}/${blended.validation.monthCount}`,
      '月准确率': percent(blended.validation.positiveMonthRatio),
      '年化': percent(blended.validation.annualizedReturn),
      '最大回撤': percent(blended.validation.maxDrawdown),
    },
  } : {}),
  ...(historicalRange ? {
    '冻结趋势中性组合 / 2023至今': {
      '盈利月': `${historicalRange.completeMonths.positiveMonths}/${historicalRange.completeMonths.monthCount}`,
      '月准确率': percent(historicalRange.completeMonths.positiveMonthRatio),
      '年化': percent(historicalRange.toDate.annualizedReturn),
      '最大回撤': percent(historicalRange.toDate.maxDrawdown),
    },
  } : {}),
  ...(referenceFiltered ? {
    '参考过滤组合 / 开发': {
      '盈利月': `${referenceFiltered.development.positiveMonths}/${referenceFiltered.development.monthCount}`,
      '月准确率': percent(referenceFiltered.development.positiveMonthRatio),
      '年化': percent(referenceFiltered.development.annualizedReturn),
      '最大回撤': percent(referenceFiltered.development.maxDrawdown),
    },
    '参考过滤组合 / 验证': {
      '盈利月': `${referenceFiltered.validation.positiveMonths}/${referenceFiltered.validation.monthCount}`,
      '月准确率': percent(referenceFiltered.validation.positiveMonthRatio),
      '年化': percent(referenceFiltered.validation.annualizedReturn),
      '最大回撤': percent(referenceFiltered.validation.maxDrawdown),
    },
    '参考过滤组合 / 2023至今': {
      '盈利月': `${referenceHistoricalRange.completeMonths.positiveMonths}/${referenceHistoricalRange.completeMonths.monthCount}`,
      '月准确率': percent(referenceHistoricalRange.completeMonths.positiveMonthRatio),
      '年化': percent(referenceHistoricalRange.toDate.annualizedReturn),
      '最大回撤': percent(referenceHistoricalRange.toDate.maxDrawdown),
    },
  } : {}),
});
console.table(releaseChecks);
console.table(ensembleReleaseChecks);
console.table(crossSectionalReleaseChecks);
console.table(blendedReleaseChecks);
console.table(referencePromotionChecks);
console.table(Object.fromEntries(fixedWeightDiagnostics.map((candidate) => [
  `趋势 ${Math.round(candidate.trendWeight * 100)}%`,
  {
    '开发盈利月': `${candidate.development.positiveMonths}/${candidate.development.monthCount}`,
    '验证盈利月': `${candidate.validation.positiveMonths}/${candidate.validation.monthCount}`,
    '验证年化': percent(candidate.validation.annualizedReturn),
    '验证最大回撤': percent(candidate.validation.maxDrawdown),
    '历史盈利月': `${candidate.historicalRange.completeMonths.positiveMonths}/${candidate.historicalRange.completeMonths.monthCount}`,
    '历史年化': percent(candidate.historicalRange.toDate.annualizedReturn),
    '历史最大回撤': percent(candidate.historicalRange.toDate.maxDrawdown),
  },
])));
console.log(JSON.stringify({
  testedCandidates: candidates.length,
  testedCrossSectionalCandidates: crossSectionalCandidates.length,
  testedReferenceFilterCandidates: referenceFilterCandidates.length,
  eligibleDevelopmentCandidates: ranked.length,
  developmentPeriod,
  validationPeriod,
  reportPeriod: {
    startDate: reportStartDate,
    endDate: reportEndDate,
    completeMonthEnd: reportCompletePeriod.endMonth,
  },
  baseline,
  frozen,
  diverseDevelopmentMembers: diverseMembers.length,
  testedEnsembles: ensembleCandidates.length,
  ensemble,
  crossSectional,
  blended,
  fixedWeightDiagnostics,
  historicalRange,
  referenceFiltered,
  referenceHistoricalRange,
  referencePromotionChecks,
  referenceFilterPromoted,
  releaseChecks,
  releasePassed,
  ensembleReleaseChecks,
  ensembleReleasePassed,
  crossSectionalReleaseChecks,
  crossSectionalReleasePassed,
  blendedReleaseChecks,
  blendedReleasePassed,
  overallReleasePassed,
}));
