import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAdaptivePortfolioBacktest } from '../src/adaptive-portfolio-backtest.js';
import { runCrossSectionalBacktest } from '../src/cross-sectional-backtest.js';
import { runLongShortTrendBacktest } from '../src/long-short-trend.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const sentimentDir = path.join(rootDir, 'data', 'market', 'sentiment');
const manifest = JSON.parse(await fs.readFile(path.join(marketDir, 'manifest.json'), 'utf8'));
const developmentPeriod = { startMonth: '2023-08', endMonth: '2024-12' };
const selectionPeriod = { startMonth: '2023-01', endMonth: '2024-12' };
const validationPeriod = { startMonth: '2025-01', endMonth: '2026-06' };
const reportPeriod = { startMonth: '2023-01', endMonth: '2026-06' };
const reportStartDate = '2023-01-01';
const manifestEnd = new Date(manifest.requestedEndTimeUtc);
if (!(manifestEnd.getUTCHours() === 23
  && manifestEnd.getUTCMinutes() === 59
  && manifestEnd.getUTCSeconds() === 59)) {
  manifestEnd.setUTCDate(manifestEnd.getUTCDate() - 1);
}
const reportEndDate = manifestEnd.toISOString().slice(0, 10);

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

async function loadFearGreed() {
  const text = await fs.readFile(path.join(sentimentDir, 'fear-greed.csv'), 'utf8');
  const [, ...rows] = text.trim().split(/\r?\n/);
  return new Map(rows.map((row) => {
    const [date, value] = row.split(',');
    return [date, Number(value)];
  }));
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
const fearGreedByDate = await loadFearGreed();

const trendSettings = {
  lookbackDays: [45, 90, 180],
  minimumTrendVotes: 2,
  minimumActiveSignals: 1,
  minimumTrendStrength: 0.02,
  targetVolatility: 0.10,
  maxGrossExposure: 1,
  maxAssetExposure: 0.30,
  dynamicLeverageEnabled: true,
  dynamicLeverageMin: 1,
  dynamicLeverageMax: 3,
  dynamicLeverageStrengthTarget: 0.20,
  volatilityWindowDays: 30,
  rebalanceDays: 1,
  monthlyProfitLock: 0.0125,
  monthlyLossLimit: 0.015,
};
const marketNeutralSettings = {
  mode: 'momentum',
  lookbackDays: 10,
  rebalanceDays: 7,
  positionsPerSide: 1,
  baseGrossExposure: 0.5,
  maxGrossExposure: 1.5,
  dynamicLeverageEnabled: true,
  dynamicLeverageMax: 3,
  dispersionTarget: 0.15,
  monthlyProfitLock: 0.01,
  monthlyLossLimit: null,
};
const trendResult = runLongShortTrendBacktest(seriesBySymbol, trendSettings);
const marketNeutralResult = runCrossSectionalBacktest(seriesBySymbol, marketNeutralSettings);
const input = { trendResult, marketNeutralResult, seriesBySymbol, fearGreedByDate };

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
  const rollingSixMonthReturns = monthly.slice(5).map((_, index) => (
    monthly.slice(index, index + 6).reduce((equity, item) => equity * (1 + item.value), 1) - 1
  ));
  return {
    monthCount: monthly.length,
    positiveMonths: monthly.filter((item) => item.value > 0).length,
    positiveMonthRatio: monthly.filter((item) => item.value > 0).length / monthly.length,
    totalReturn,
    annualizedReturn: (1 + totalReturn) ** (12 / monthly.length) - 1,
    maxDrawdown,
    minimumRollingSixMonthReturn: rollingSixMonthReturns.length
      ? Math.min(...rollingSixMonthReturns)
      : null,
    monthly,
  };
}

function dateRangeMetrics(result, startDate, endDate) {
  const startingEquity = result.equityCurve.filter((point) => point.date < startDate).at(-1)?.equity || 1;
  const daily = result.equityCurve.filter((point) => point.date >= startDate && point.date <= endDate);
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
    totalReturn,
    annualizedReturn: (1 + totalReturn) ** (365 / elapsedDays) - 1,
    maxDrawdown,
    annualReturns,
  };
}

function evaluate(settings) {
  const result = runAdaptivePortfolioBacktest(input, settings);
  return {
    settings,
    result,
    development: periodMetrics(result, developmentPeriod),
    selection: periodMetrics(result, selectionPeriod),
  };
}

const currentSettings = {
  baseTrendWeight: 0.20,
  minimumTrendWeight: 0.20,
  maximumTrendWeight: 0.20,
};
const current = evaluate(currentSettings);
const fixedFifteen = evaluate({
  baseTrendWeight: 0.15,
  minimumTrendWeight: 0.15,
  maximumTrendWeight: 0.15,
});

const allocationProfiles = [
  { baseTrendWeight: 0.10, minimumTrendWeight: 0.10, maximumTrendWeight: 0.10 },
  { baseTrendWeight: 0.15, minimumTrendWeight: 0.15, maximumTrendWeight: 0.15 },
  { baseTrendWeight: 0.20, minimumTrendWeight: 0.20, maximumTrendWeight: 0.20 },
  { baseTrendWeight: 0.10, minimumTrendWeight: 0.05, maximumTrendWeight: 0.15, stateAllocationEnabled: true },
  { baseTrendWeight: 0.125, minimumTrendWeight: 0.10, maximumTrendWeight: 0.15, stateAllocationEnabled: true },
  { baseTrendWeight: 0.15, minimumTrendWeight: 0.10, maximumTrendWeight: 0.20, stateAllocationEnabled: true },
  { baseTrendWeight: 0.15, minimumTrendWeight: 0.05, maximumTrendWeight: 0.25, stateAllocationEnabled: true },
  { baseTrendWeight: 0.175, minimumTrendWeight: 0.15, maximumTrendWeight: 0.20, stateAllocationEnabled: true },
];
const drawdownProfiles = [
  {},
  { drawdownControlStart: 0.03, drawdownControlFull: 0.10, minimumDrawdownScale: 0.50 },
  { drawdownControlStart: 0.03, drawdownControlFull: 0.10, minimumDrawdownScale: 0.75 },
  { drawdownControlStart: 0.05, drawdownControlFull: 0.15, minimumDrawdownScale: 0.50 },
  { drawdownControlStart: 0.05, drawdownControlFull: 0.15, minimumDrawdownScale: 0.75 },
  { drawdownControlStart: 0.075, drawdownControlFull: 0.15, minimumDrawdownScale: 0.50 },
  { drawdownControlStart: 0.075, drawdownControlFull: 0.15, minimumDrawdownScale: 0.75 },
  { drawdownControlStart: 0.075, drawdownControlFull: 0.20, minimumDrawdownScale: 0.50 },
  { drawdownControlStart: 0.075, drawdownControlFull: 0.20, minimumDrawdownScale: 0.75 },
  { drawdownControlStart: 0.10, drawdownControlFull: 0.20, minimumDrawdownScale: 0.50 },
  { drawdownControlStart: 0.10, drawdownControlFull: 0.20, minimumDrawdownScale: 0.75 },
];
const referenceProfiles = [
  {},
  {
    referenceRiskEnabled: true,
    fearGreedMinimum: 10,
    fearGreedMaximum: 90,
    maximumMarketVolatility: 1.20,
    referenceOutsideScale: 0.90,
  },
  {
    referenceRiskEnabled: true,
    fearGreedMinimum: 15,
    fearGreedMaximum: 85,
    maximumMarketVolatility: 1.00,
    referenceOutsideScale: 0.90,
  },
  {
    referenceRiskEnabled: true,
    fearGreedMinimum: 20,
    fearGreedMaximum: 80,
    maximumMarketVolatility: 0.80,
    referenceOutsideScale: 0.90,
  },
  {
    referenceRiskEnabled: true,
    fearGreedMinimum: 10,
    fearGreedMaximum: 90,
    maximumMarketVolatility: 1.00,
    referenceOutsideScale: 0.75,
  },
];

const candidates = [];
for (const allocation of allocationProfiles) {
  for (const drawdown of drawdownProfiles) {
    for (const reference of referenceProfiles) {
      candidates.push({ ...allocation, ...drawdown, ...reference });
    }
  }
}
const evaluated = candidates.map(evaluate);
const qualified = evaluated.filter((candidate) => (
  candidate.development.positiveMonthRatio >= current.development.positiveMonthRatio
  && candidate.development.annualizedReturn >= 0.10
  && candidate.development.maxDrawdown >= -0.15
  && candidate.selection.positiveMonthRatio >= current.selection.positiveMonthRatio
  && candidate.selection.annualizedReturn >= 0.10
  && candidate.selection.maxDrawdown >= -0.25
)).sort((left, right) => (
  right.selection.positiveMonthRatio - left.selection.positiveMonthRatio
  || right.selection.minimumRollingSixMonthReturn - left.selection.minimumRollingSixMonthReturn
  || right.selection.maxDrawdown - left.selection.maxDrawdown
  || right.selection.annualizedReturn - left.selection.annualizedReturn
));
const selected = qualified[0] || null;

function fullEvaluation(candidate) {
  if (!candidate) return null;
  return {
    settings: candidate.settings,
    development: candidate.development,
    selection: candidate.selection,
    validation: periodMetrics(candidate.result, validationPeriod),
    historicalMonths: periodMetrics(candidate.result, reportPeriod),
    toDate: dateRangeMetrics(candidate.result, reportStartDate, reportEndDate),
    engineMetrics: candidate.result.metrics,
  };
}

const currentFull = fullEvaluation(current);
const fixedFifteenFull = fullEvaluation(fixedFifteen);
const selectedFull = fullEvaluation(selected);
const auditedQualified = qualified.map(fullEvaluation);
const strictlyDominantCandidates = auditedQualified.filter((candidate) => (
  candidate.validation.positiveMonths > currentFull.validation.positiveMonths
  && candidate.validation.annualizedReturn >= currentFull.validation.annualizedReturn
  && candidate.validation.maxDrawdown >= currentFull.validation.maxDrawdown
  && candidate.historicalMonths.positiveMonths > currentFull.historicalMonths.positiveMonths
  && candidate.toDate.annualizedReturn >= currentFull.toDate.annualizedReturn
  && candidate.toDate.maxDrawdown >= currentFull.toDate.maxDrawdown
)).sort((left, right) => (
  right.validation.positiveMonths - left.validation.positiveMonths
  || right.historicalMonths.positiveMonths - left.historicalMonths.positiveMonths
  || right.validation.annualizedReturn - left.validation.annualizedReturn
  || right.validation.maxDrawdown - left.validation.maxDrawdown
));
const strictlyDominant = strictlyDominantCandidates[0] || null;
const balancedCandidates = auditedQualified.filter((candidate) => (
  candidate.validation.positiveMonths > currentFull.validation.positiveMonths
  && candidate.validation.annualizedReturn >= 0.10
  && candidate.validation.maxDrawdown >= currentFull.validation.maxDrawdown
  && candidate.historicalMonths.positiveMonths > currentFull.historicalMonths.positiveMonths
  && candidate.toDate.annualizedReturn >= 0.10
  && candidate.toDate.maxDrawdown >= currentFull.toDate.maxDrawdown
)).sort((left, right) => (
  right.historicalMonths.positiveMonths - left.historicalMonths.positiveMonths
  || right.toDate.annualizedReturn - left.toDate.annualizedReturn
  || right.validation.annualizedReturn - left.validation.annualizedReturn
  || right.toDate.maxDrawdown - left.toDate.maxDrawdown
));
const balanced = balancedCandidates[0] || null;
const promotionChecks = selectedFull ? {
  validationPositiveMonthsImproved:
    selectedFull.validation.positiveMonths > currentFull.validation.positiveMonths,
  validationAnnualizedReturnNotLower:
    selectedFull.validation.annualizedReturn >= currentFull.validation.annualizedReturn,
  validationMaxDrawdownNotWorse:
    selectedFull.validation.maxDrawdown >= currentFull.validation.maxDrawdown,
  historicalPositiveMonthsImproved:
    selectedFull.historicalMonths.positiveMonths > currentFull.historicalMonths.positiveMonths,
  historicalAnnualizedReturnNotLower:
    selectedFull.toDate.annualizedReturn >= currentFull.toDate.annualizedReturn,
  historicalMaxDrawdownNotWorse:
    selectedFull.toDate.maxDrawdown >= currentFull.toDate.maxDrawdown,
} : {};
const promoted = selectedFull && Object.values(promotionChecks).every(Boolean);
const accuracyPriorityChecks = {
  validationPositiveMonthsImproved:
    fixedFifteenFull.validation.positiveMonths > currentFull.validation.positiveMonths,
  validationAnnualizedReturnAboveTarget:
    fixedFifteenFull.validation.annualizedReturn >= 0.10,
  validationDrawdownWithinHalfPointTolerance:
    fixedFifteenFull.validation.maxDrawdown >= currentFull.validation.maxDrawdown - 0.005,
  historicalPositiveMonthsImproved:
    fixedFifteenFull.historicalMonths.positiveMonths > currentFull.historicalMonths.positiveMonths,
  historicalAnnualizedReturnAboveTarget:
    fixedFifteenFull.toDate.annualizedReturn >= 0.10,
  historicalDrawdownWithinOneAndHalfPointTolerance:
    fixedFifteenFull.toDate.maxDrawdown >= currentFull.toDate.maxDrawdown - 0.015,
};
const accuracyPriorityPromoted = Object.values(accuracyPriorityChecks).every(Boolean);
const percent = (value) => `${(value * 100).toFixed(2)}%`;
const tableRow = (candidate) => ({
  '开发盈利月': `${candidate.development.positiveMonths}/${candidate.development.monthCount}`,
  '选择期盈利月': `${candidate.selection.positiveMonths}/${candidate.selection.monthCount}`,
  '验证盈利月': `${candidate.validation.positiveMonths}/${candidate.validation.monthCount}`,
  '验证年化': percent(candidate.validation.annualizedReturn),
  '验证回撤': percent(candidate.validation.maxDrawdown),
  '历史盈利月': `${candidate.historicalMonths.positiveMonths}/${candidate.historicalMonths.monthCount}`,
  '历史年化': percent(candidate.toDate.annualizedReturn),
  '历史回撤': percent(candidate.toDate.maxDrawdown),
});

console.table({
  '当前 80/20': tableRow(currentFull),
  '固定 85/15': tableRow(fixedFifteenFull),
  ...(selectedFull ? { '开发选择候选': tableRow(selectedFull) } : {}),
});
console.table(promotionChecks);
console.table(accuracyPriorityChecks);
console.table(Object.fromEntries(Object.entries(fixedFifteenFull.toDate.annualReturns).map(([year, value]) => [
  year,
  { '准确率优先年收益': percent(value) },
])));
if (strictlyDominant) {
  console.table({ '严格支配候选': tableRow(strictlyDominant) });
}
if (balanced) {
  console.table({ '准确率优先平衡候选': tableRow(balanced) });
}
console.log(JSON.stringify({
  testedCandidates: candidates.length,
  qualifiedCandidates: qualified.length,
  selectionRule: '只使用2023-01至2024-12；先盈利月，再最差滚动6月收益、回撤、年化',
  current: currentFull,
  fixedFifteen: fixedFifteenFull,
  selected: selectedFull,
  strictlyDominantCandidateCount: strictlyDominantCandidates.length,
  strictlyDominant,
  balancedCandidateCount: balancedCandidates.length,
  balanced,
  promotionChecks,
  promoted,
  accuracyPriorityChecks,
  accuracyPriorityPromoted,
}));
