import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCrossSectionalBacktest } from '../src/cross-sectional-backtest.js';
import { runLongShortTrendBacktest } from '../src/long-short-trend.js';
import { MONTHLY_ACCURACY_PAPER_PROFILE } from '../src/monthly-accuracy-paper.js';

const DAY_MS = 86_400_000;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const outputDir = path.join(rootDir, 'data', 'runtime', 'paper-research');
const developmentPeriod = Object.freeze({ startMonth: '2023-01', endMonth: '2024-12' });
const validationPeriod = Object.freeze({ startMonth: '2025-01', endMonth: '2026-06' });
const historicalStartDate = '2023-01-01';
const rebalanceDaysGrid = Object.freeze([5, 6, 7, 8, 9, 10, 12, 14]);
const minimumTurnoverGrid = Object.freeze([0, 0.025, 0.05, 0.075, 0.10, 0.15, 0.20, 0.30]);
const costMultipliers = Object.freeze([1, 1.5, 2]);

function round(value, digits = 8) {
  return Number(Number(value).toFixed(digits));
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

async function loadDailySeries(dataset) {
  const text = await fs.readFile(path.join(marketDir, dataset.file), 'utf8');
  const [headerLine, ...rows] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const dateIndex = headers.indexOf('open_time_utc');
  const closeIndex = headers.indexOf('close');
  if (dateIndex < 0 || closeIndex < 0) throw new Error(`${dataset.file} 缺少日线聚合字段`);
  const byDate = new Map();
  for (const row of rows) {
    const columns = row.split(',');
    byDate.set(columns[dateIndex].slice(0, 10), Number(columns[closeIndex]));
  }
  return [...byDate.entries()].map(([date, close]) => ({ date, close }));
}

function lastCompleteDate(manifest) {
  const end = new Date(manifest.requestedEndTimeUtc);
  if (!(end.getUTCHours() === 23 && end.getUTCMinutes() === 59 && end.getUTCSeconds() === 59)) {
    end.setUTCDate(end.getUTCDate() - 1);
  }
  return end.toISOString().slice(0, 10);
}

async function loadMarket() {
  const manifest = JSON.parse(await fs.readFile(path.join(marketDir, 'manifest.json'), 'utf8'));
  const endDate = lastCompleteDate(manifest);
  const loaded = Object.fromEntries(await Promise.all(manifest.datasets.map(async (dataset) => [
    dataset.symbol,
    await loadDailySeries(dataset),
  ])));
  const commonDates = Object.values(loaded)
    .map((series) => new Set(series.map((item) => item.date)))
    .reduce((intersection, dates) => new Set([...intersection].filter((date) => dates.has(date))));
  return {
    manifest,
    endDate,
    seriesBySymbol: Object.fromEntries(Object.entries(loaded).map(([symbol, series]) => [
      symbol,
      series.filter((item) => commonDates.has(item.date) && item.date <= endDate),
    ])),
  };
}

function dailyReturnMap(result) {
  let previousEquity = 1;
  return new Map(result.equityCurve.map((point) => {
    const value = point.equity / previousEquity - 1;
    previousEquity = point.equity;
    return [point.date, value];
  }));
}

function combineResults(results, weights) {
  const returnMaps = results.map(dailyReturnMap);
  const commonDates = [...returnMaps[0].keys()]
    .filter((date) => returnMaps.every((returns) => returns.has(date)));
  let equity = 1;
  return {
    equityCurve: commonDates.map((date) => {
      const dailyReturn = returnMaps.reduce((sum, returns, index) => (
        sum + returns.get(date) * weights[index]
      ), 0);
      equity *= 1 + dailyReturn;
      return { date, equity };
    }),
  };
}

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

function rangeMetrics(result, startDate, endDate, monthRange) {
  const startingEquity = result.equityCurve.filter((point) => point.date < startDate).at(-1)?.equity || 1;
  const daily = result.equityCurve.filter((point) => point.date >= startDate && point.date <= endDate);
  if (!daily.length) throw new Error(`回测范围 ${startDate} 至 ${endDate} 没有净值数据`);
  let peak = startingEquity;
  let maxDrawdown = 0;
  for (const point of daily) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
  }
  const totalReturn = daily.at(-1).equity / startingEquity - 1;
  const elapsedDays = Math.max(1, (Date.parse(endDate) - Date.parse(startDate)) / DAY_MS);
  const monthly = monthlyReturns(result.equityCurve).filter((item) => (
    !monthRange || (item.month >= monthRange.startMonth && item.month <= monthRange.endMonth)
  ));
  const positiveMonths = monthly.filter((item) => item.value > 0).length;
  return {
    totalReturn: round(totalReturn),
    annualizedReturn: round((1 + totalReturn) ** (365 / elapsedDays) - 1),
    maxDrawdown: round(maxDrawdown),
    monthCount: monthly.length,
    positiveMonths,
    positiveMonthRatio: round(positiveMonths / monthly.length),
  };
}

function periodMetrics(result, period) {
  return rangeMetrics(result, `${period.startMonth}-01`, `${period.endMonth}-30`, period);
}

function evaluate(seriesBySymbol, endDate, rebalanceDays, minimumRebalanceTurnover, costMultiplier) {
  const profile = MONTHLY_ACCURACY_PAPER_PROFILE;
  const marketNeutralResult = runCrossSectionalBacktest(seriesBySymbol, {
    ...profile.marketNeutral,
    rebalanceDays,
    minimumRebalanceTurnover,
    tradingCostRate: profile.marketNeutral.tradingCostRate * costMultiplier,
    dailyCarryCostRate: profile.marketNeutral.dailyCarryCostRate * costMultiplier,
  });
  const trendResult = runLongShortTrendBacktest(seriesBySymbol, {
    ...profile.trend,
    tradingCostRate: profile.trend.tradingCostRate * costMultiplier,
    dailyCarryCostRate: profile.trend.dailyCarryCostRate * costMultiplier,
  });
  const combined = combineResults(
    [marketNeutralResult, trendResult],
    [profile.marketNeutralWeight, profile.trendWeight],
  );
  return {
    rebalanceDays,
    minimumRebalanceTurnover,
    costMultiplier,
    development: periodMetrics(combined, developmentPeriod),
    validation: periodMetrics(combined, validationPeriod),
    historical: rangeMetrics(combined, historicalStartDate, endDate, null),
    crossRisk: {
      totalTurnover: marketNeutralResult.metrics.totalTurnover,
      averageGrossExposure: marketNeutralResult.metrics.averageGrossExposure,
      averageDynamicLeverage: marketNeutralResult.metrics.averageDynamicLeverage,
    },
  };
}

function selectCandidate(results) {
  const normalCost = results.filter((item) => item.costMultiplier === 1);
  const baseline = normalCost.find((item) => (
    item.rebalanceDays === 7 && item.minimumRebalanceTurnover === 0
  ));
  const eligible = normalCost.filter((item) => (
    item.rebalanceDays === baseline.rebalanceDays
    && item.minimumRebalanceTurnover > 0
    && item.crossRisk.totalTurnover <= baseline.crossRisk.totalTurnover * 0.90
    && item.development.positiveMonthRatio >= 0.80
    && item.development.annualizedReturn >= 0.10
    && item.development.maxDrawdown >= baseline.development.maxDrawdown
  )).sort((left, right) => (
    right.development.positiveMonthRatio - left.development.positiveMonthRatio
    || right.development.annualizedReturn - left.development.annualizedReturn
    || right.development.maxDrawdown - left.development.maxDrawdown
  ));
  return { baseline, candidate: eligible[0] || null };
}

function candidateChecks(results) {
  const { baseline, candidate } = selectCandidate(results);
  if (!candidate) return { baseline, candidate: null, checks: {}, qualifiedForNewShadow: false };
  const stressed = results.find((item) => (
    item.rebalanceDays === candidate.rebalanceDays
    && item.minimumRebalanceTurnover === candidate.minimumRebalanceTurnover
    && item.costMultiplier === 2
  ));
  const candidateIndex = minimumTurnoverGrid.indexOf(candidate.minimumRebalanceTurnover);
  const neighborhoodThresholds = minimumTurnoverGrid.slice(
    Math.max(1, candidateIndex - 1),
    Math.min(minimumTurnoverGrid.length, candidateIndex + 2),
  );
  const neighborhood = neighborhoodThresholds.map((threshold) => results.find((item) => (
    item.rebalanceDays === 7
    && item.minimumRebalanceTurnover === threshold
    && item.costMultiplier === 1
  )));
  const neighborhoodPassed = neighborhood.filter((item) => (
    item.validation.positiveMonthRatio >= 0.80
    && item.validation.annualizedReturn >= 0.10
    && item.validation.maxDrawdown >= -0.15
  )).length;
  const checks = {
    validationPositiveMonthsNotLower:
      candidate.validation.positiveMonths >= baseline.validation.positiveMonths,
    validationAnnualizedReturnNotLower:
      candidate.validation.annualizedReturn >= baseline.validation.annualizedReturn,
    validationDrawdownNotWorse:
      candidate.validation.maxDrawdown >= baseline.validation.maxDrawdown,
    historicalAnnualizedReturnNotLower:
      candidate.historical.annualizedReturn >= baseline.historical.annualizedReturn,
    turnoverReducedByTenPercent:
      candidate.crossRisk.totalTurnover <= baseline.crossRisk.totalTurnover * 0.90,
    doubleCostMonthlyTarget: stressed.validation.positiveMonthRatio >= 0.80,
    doubleCostAnnualizedTarget: stressed.validation.annualizedReturn >= 0.10,
    doubleCostDrawdownLimit: stressed.validation.maxDrawdown >= -0.15,
    neighborhoodMajorityPassed:
      neighborhoodPassed >= Math.ceil(neighborhood.length * 0.80),
  };
  return {
    baseline,
    candidate,
    stressed,
    neighborhood,
    neighborhoodPassed,
    checks,
    qualifiedForNewShadow: Object.values(checks).every(Boolean),
  };
}

function markdown(report) {
  const rows = report.results.filter((item) => item.costMultiplier === 1);
  return [
    '# 模拟盘调仓周期与换手稳健性研究',
    '',
    `- 数据截止：${report.dataEndDate}`,
    `- 开发区间：${developmentPeriod.startMonth} 至 ${developmentPeriod.endMonth}`,
    `- 冻结验证：${validationPeriod.startMonth} 至 ${validationPeriod.endMonth}`,
    `- 试验数量：${report.trialCount}`,
    `- 新影子准入：${report.decision.qualifiedForNewShadow ? '通过' : '未通过'}`,
    '',
    '| 调仓周期 | 最低换手 | 开发盈利月 | 开发年化 | 验证盈利月 | 验证年化 | 验证回撤 | 历史换手 |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map((item) => (
      `| ${item.rebalanceDays}天 | ${item.minimumRebalanceTurnover.toFixed(3)} | ${item.development.positiveMonths}/${item.development.monthCount} | ${percent(item.development.annualizedReturn)} | ${item.validation.positiveMonths}/${item.validation.monthCount} | ${percent(item.validation.annualizedReturn)} | ${percent(item.validation.maxDrawdown)} | ${item.crossRisk.totalTurnover.toFixed(2)} |`
    )),
    '',
    '## 准入检查',
    '',
    ...(report.decision.candidate
      ? Object.entries(report.decision.checks).map(([key, passed]) => `- ${passed ? '通过' : '未通过'}：${key}`)
      : ['- 未产生满足开发期收益、回撤及换手约束的候选。']),
    '',
    '> 候选只按开发区间选择，冻结验证只用于一次性准入判断；未通过时不修改基准。',
    '',
  ].join('\n');
}

const { manifest, endDate, seriesBySymbol } = await loadMarket();
const results = [];
const configurations = [
  ...rebalanceDaysGrid.map((rebalanceDays) => ({ rebalanceDays, minimumRebalanceTurnover: 0 })),
  ...minimumTurnoverGrid.slice(1).map((minimumRebalanceTurnover) => ({
    rebalanceDays: 7,
    minimumRebalanceTurnover,
  })),
];
for (const { rebalanceDays, minimumRebalanceTurnover } of configurations) {
  for (const costMultiplier of costMultipliers) {
    results.push(evaluate(
      seriesBySymbol,
      endDate,
      rebalanceDays,
      minimumRebalanceTurnover,
      costMultiplier,
    ));
  }
}
const decision = candidateChecks(results);
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  dataEndDate: endDate,
  manifestRequestedEndTimeUtc: manifest.requestedEndTimeUtc,
  developmentPeriod,
  validationPeriod,
  historicalPeriod: { startDate: historicalStartDate, endDate },
  trialCount: results.length,
  rebalanceDaysGrid,
  minimumTurnoverGrid,
  costMultipliers,
  results,
  decision,
  targetDisclaimer: '年化10%和80%盈利月为研究准入目标，不是收益或胜率保证。',
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, 'turnover-latest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(path.join(outputDir, 'turnover-latest.md'), `${markdown(report)}\n`, 'utf8');

console.table(Object.fromEntries(results
  .filter((item) => item.costMultiplier === 1)
  .map((item) => [`${item.rebalanceDays}天/${item.minimumRebalanceTurnover.toFixed(3)}`, {
    '开发盈利月': `${item.development.positiveMonths}/${item.development.monthCount}`,
    '开发年化': percent(item.development.annualizedReturn),
    '验证盈利月': `${item.validation.positiveMonths}/${item.validation.monthCount}`,
    '验证年化': percent(item.validation.annualizedReturn),
    '验证回撤': percent(item.validation.maxDrawdown),
    '历史换手': item.crossRisk.totalTurnover.toFixed(2),
  }])));
console.table(decision.checks);
console.log(JSON.stringify({
  dataEndDate: endDate,
  trialCount: results.length,
  qualifiedForNewShadow: decision.qualifiedForNewShadow,
  candidate: decision.candidate,
  doubleCost: decision.stressed,
  neighborhoodPassed: decision.neighborhood
    ? `${decision.neighborhoodPassed}/${decision.neighborhood.length}`
    : '0/0',
}));
