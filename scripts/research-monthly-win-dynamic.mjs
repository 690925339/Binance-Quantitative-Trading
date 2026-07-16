import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLongShortTrendBacktest } from '../src/long-short-trend.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const manifest = JSON.parse(await fs.readFile(path.join(marketDir, 'manifest.json'), 'utf8'));
const developmentPeriod = { startMonth: '2023-08', endMonth: '2024-12' };
const validationPeriod = { startMonth: '2025-01', endMonth: '2026-06' };

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

const loaded = Object.fromEntries(await Promise.all(manifest.datasets.map(async (dataset) => [
  dataset.symbol,
  await loadDailySeries(dataset),
])));
const commonDates = Object.values(loaded).map((series) => new Set(series.map((item) => item.date)))
  .reduce((intersection, dates) => new Set([...intersection].filter((date) => dates.has(date))));
const seriesBySymbol = Object.fromEntries(Object.entries(loaded).map(([symbol, series]) => [
  symbol,
  series.filter((item) => commonDates.has(item.date)),
]));

function buildMonthlyReturns(equityCurve) {
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
  const monthly = buildMonthlyReturns(result.equityCurve)
    .filter((item) => item.month >= period.startMonth && item.month <= period.endMonth);
  const compoundedReturn = monthly.reduce((equity, item) => equity * (1 + item.value), 1) - 1;
  const annualizedReturn = (1 + compoundedReturn) ** (12 / monthly.length) - 1;
  const positiveMonths = monthly.filter((item) => item.value > 0).length;
  const activeMonths = monthly.filter((item) => Math.abs(item.value) >= 0.001).length;
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
    activeMonths,
    totalReturn: compoundedReturn,
    annualizedReturn,
    maxDrawdown,
    monthly,
  };
}

const lookbackCandidates = [
  [20, 60, 120],
  [30, 90, 180],
  [45, 90, 180],
  [60, 120, 240],
];
const candidates = [];
for (const lookbackDays of lookbackCandidates) {
  for (const minimumTrendVotes of [2, 3]) {
    for (const minimumActiveSignals of [1, 2]) {
      for (const minimumTrendStrength of [0.02, 0.04, 0.06]) {
        for (const rebalanceDays of [1, 3, 7]) {
          for (const dynamicLeverageMax of [2, 2.5, 3]) {
            for (const dynamicLeverageStrengthTarget of [0.10, 0.20]) {
              for (const targetVolatility of [0.08, 0.10]) {
                candidates.push({
                  lookbackDays,
                  volatilityWindowDays: 30,
                  targetVolatility,
                  minimumTrendStrength,
                  minimumTrendVotes,
                  minimumActiveSignals,
                  rebalanceDays,
                  dynamicLeverageEnabled: true,
                  dynamicLeverageMin: 1,
                  dynamicLeverageMax,
                  dynamicLeverageStrengthTarget,
                  maxGrossExposure: 1,
                  maxAssetExposure: 0.30,
                });
              }
            }
          }
        }
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

const ranked = candidates.map((settings) => {
  const result = runLongShortTrendBacktest(seriesBySymbol, settings);
  return {
    settings,
    development: periodMetrics(result, developmentPeriod),
    result,
  };
}).filter((candidate) => (
  candidate.development.annualizedReturn >= 0.05
  && candidate.development.maxDrawdown >= -0.25
  && candidate.development.activeMonths >= 14
)).sort((left, right) => (
  right.development.positiveMonthRatio - left.development.positiveMonthRatio
  || right.development.annualizedReturn - left.development.annualizedReturn
  || right.development.maxDrawdown - left.development.maxDrawdown
));

const frozenCandidate = ranked[0] || null;
const frozenSignal = frozenCandidate ? {
  settings: frozenCandidate.settings,
  development: frozenCandidate.development,
  validation: periodMetrics(frozenCandidate.result, validationPeriod),
  full: frozenCandidate.result.metrics,
} : null;
const leveragedSettings = frozenSignal ? {
  ...frozenSignal.settings,
  maxGrossExposure: frozenSignal.settings.dynamicLeverageMax,
  maxAssetExposure: 0.30 * frozenSignal.settings.dynamicLeverageMax,
  drawdownControlStart: 0.08,
  drawdownControlFull: 0.20,
  minimumRiskScale: 0.25,
} : null;
const leveragedResult = leveragedSettings
  ? runLongShortTrendBacktest(seriesBySymbol, leveragedSettings)
  : null;
const leveraged = leveragedResult ? {
  settings: leveragedSettings,
  development: periodMetrics(leveragedResult, developmentPeriod),
  validation: periodMetrics(leveragedResult, validationPeriod),
  full: leveragedResult.metrics,
} : null;
const releaseChecks = leveraged ? {
  validationWinRateImproved: leveraged.validation.positiveMonthRatio > baseline.validation.positiveMonthRatio,
  validationAnnualizedReturn: leveraged.validation.annualizedReturn >= 0.10,
  validationDrawdown: leveraged.validation.maxDrawdown >= -0.25,
  fullAnnualizedReturn: leveraged.full.annualizedReturn >= 0.10,
  fullDrawdown: leveraged.full.maxDrawdown >= -0.30,
} : {};
const releasePassed = leveraged && Object.values(releaseChecks).every(Boolean);
const percent = (value) => `${(value * 100).toFixed(2)}%`;

console.table({
  '固定 2.0× 基线 / 开发': {
    '盈利月': `${baseline.development.positiveMonths}/${baseline.development.monthCount}`,
    '月胜率': percent(baseline.development.positiveMonthRatio),
    '年化': percent(baseline.development.annualizedReturn),
    '最大回撤': percent(baseline.development.maxDrawdown),
  },
  '固定 2.0× 基线 / 验证': {
    '盈利月': `${baseline.validation.positiveMonths}/${baseline.validation.monthCount}`,
    '月胜率': percent(baseline.validation.positiveMonthRatio),
    '年化': percent(baseline.validation.annualizedReturn),
    '最大回撤': percent(baseline.validation.maxDrawdown),
  },
  ...(frozenSignal ? {
    '冻结胜率候选 / 开发': {
      '盈利月': `${frozenSignal.development.positiveMonths}/${frozenSignal.development.monthCount}`,
      '月胜率': percent(frozenSignal.development.positiveMonthRatio),
      '年化': percent(frozenSignal.development.annualizedReturn),
      '最大回撤': percent(frozenSignal.development.maxDrawdown),
    },
    '冻结胜率候选 / 验证': {
      '盈利月': `${frozenSignal.validation.positiveMonths}/${frozenSignal.validation.monthCount}`,
      '月胜率': percent(frozenSignal.validation.positiveMonthRatio),
      '年化': percent(frozenSignal.validation.annualizedReturn),
      '最大回撤': percent(frozenSignal.validation.maxDrawdown),
    },
  } : {}),
  ...(leveraged ? {
    '杠杆补偿候选 / 验证': {
      '盈利月': `${leveraged.validation.positiveMonths}/${leveraged.validation.monthCount}`,
      '月胜率': percent(leveraged.validation.positiveMonthRatio),
      '年化': percent(leveraged.validation.annualizedReturn),
      '最大回撤': percent(leveraged.validation.maxDrawdown),
    },
  } : {}),
});
console.table(releaseChecks);
console.log(JSON.stringify({
  testedCandidates: candidates.length,
  eligibleDevelopmentCandidates: ranked.length,
  developmentPeriod,
  validationPeriod,
  baseline,
  frozenSignal,
  leveraged,
  releaseChecks,
  releasePassed,
}));
