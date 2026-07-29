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
const dispersionTargets = Object.freeze([0.15, 0.18, 0.19, 0.20, 0.21]);
const monthlyLossLimits = Object.freeze([null, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05]);
const costMultipliers = Object.freeze([1, 1.5, 2]);

function round(value, digits = 8) {
  return Number(Number(value).toFixed(digits));
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function settingLabel(item) {
  const lossLimit = item.monthlyLossLimit === null ? '关闭' : percent(item.monthlyLossLimit);
  return `离散度${item.dispersionTarget.toFixed(2)} / 止损${lossLimit}`;
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

function lastCompleteMonth(endDate) {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const next = new Date(end.getTime() + DAY_MS);
  if (next.getUTCMonth() !== end.getUTCMonth()) return endDate.slice(0, 7);
  end.setUTCDate(0);
  return end.toISOString().slice(0, 7);
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
  const seriesBySymbol = Object.fromEntries(Object.entries(loaded).map(([symbol, series]) => [
    symbol,
    series.filter((item) => commonDates.has(item.date) && item.date <= endDate),
  ]));
  return { manifest, endDate, seriesBySymbol };
}

function dailyReturnMap(result) {
  let previousEquity = 1;
  return new Map(result.equityCurve.map((point) => {
    const dailyReturn = point.equity / previousEquity - 1;
    previousEquity = point.equity;
    return [point.date, dailyReturn];
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
    item.month >= monthRange.startMonth && item.month <= monthRange.endMonth
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

function evaluate(seriesBySymbol, endDate, dispersionTarget, monthlyLossLimit, costMultiplier) {
  const profile = MONTHLY_ACCURACY_PAPER_PROFILE;
  const crossResult = runCrossSectionalBacktest(seriesBySymbol, {
    ...profile.marketNeutral,
    dispersionTarget,
    monthlyLossLimit,
    tradingCostRate: profile.marketNeutral.tradingCostRate * costMultiplier,
    dailyCarryCostRate: profile.marketNeutral.dailyCarryCostRate * costMultiplier,
  });
  const trendResult = runLongShortTrendBacktest(seriesBySymbol, {
    ...profile.trend,
    tradingCostRate: profile.trend.tradingCostRate * costMultiplier,
    dailyCarryCostRate: profile.trend.dailyCarryCostRate * costMultiplier,
  });
  const combined = combineResults(
    [crossResult, trendResult],
    [profile.marketNeutralWeight, profile.trendWeight],
  );
  return {
    dispersionTarget,
    monthlyLossLimit,
    costMultiplier,
    development: rangeMetrics(
      combined,
      `${developmentPeriod.startMonth}-01`,
      `${developmentPeriod.endMonth}-31`,
      developmentPeriod,
    ),
    validation: rangeMetrics(
      combined,
      `${validationPeriod.startMonth}-01`,
      `${validationPeriod.endMonth}-30`,
      validationPeriod,
    ),
    historical: rangeMetrics(
      combined,
      historicalStartDate,
      endDate,
      { startMonth: historicalStartDate.slice(0, 7), endMonth: lastCompleteMonth(endDate) },
    ),
    crossRisk: {
      averageGrossExposure: crossResult.metrics.averageGrossExposure,
      averageDynamicLeverage: crossResult.metrics.averageDynamicLeverage,
      maximumDynamicLeverage: crossResult.metrics.maximumDynamicLeverage,
      totalTurnover: crossResult.metrics.totalTurnover,
      monthlyLockedDays: crossResult.metrics.monthlyLockedDays,
    },
  };
}

function selectCandidate(results) {
  const normalCost = results.filter((item) => item.costMultiplier === 1);
  const baseline = normalCost.find((item) => (
    item.dispersionTarget === 0.15 && item.monthlyLossLimit === null
  ));
  const developmentEligible = normalCost.filter((item) => (
    !(item.dispersionTarget === 0.15 && item.monthlyLossLimit === null)
    && item.development.positiveMonths >= baseline.development.positiveMonths
    && item.development.annualizedReturn >= 0.10
    && item.development.maxDrawdown >= -0.20
  ));
  developmentEligible.sort((left, right) => (
    right.development.positiveMonths - left.development.positiveMonths
    || right.development.maxDrawdown - left.development.maxDrawdown
    || right.development.annualizedReturn - left.development.annualizedReturn
  ));
  const candidate = developmentEligible[0] || null;
  if (!candidate) {
    return { baseline, candidate: null, stressed: null, checks: {}, qualifiedForNewShadow: false };
  }
  const stressed = results.find((item) => (
    item.dispersionTarget === candidate.dispersionTarget
    && item.monthlyLossLimit === candidate.monthlyLossLimit
    && item.costMultiplier === 2
  ));
  const checks = {
    validationPositiveMonthsNotLower:
      candidate.validation.positiveMonths >= baseline.validation.positiveMonths,
    validationAnnualizedReturnNotLower:
      candidate.validation.annualizedReturn >= baseline.validation.annualizedReturn,
    validationDrawdownImproved:
      candidate.validation.maxDrawdown > baseline.validation.maxDrawdown,
    historicalAnnualizedReturnNotLower:
      candidate.historical.annualizedReturn >= baseline.historical.annualizedReturn,
    historicalDrawdownImproved:
      candidate.historical.maxDrawdown > baseline.historical.maxDrawdown,
    doubleCostMonthlyTarget:
      stressed.validation.positiveMonthRatio >= 0.80,
    doubleCostAnnualizedTarget:
      stressed.validation.annualizedReturn >= 0.10,
    doubleCostDrawdownLimit:
      stressed.validation.maxDrawdown >= -0.15,
  };
  return {
    baseline,
    candidate,
    stressed,
    developmentEligibleCount: developmentEligible.length,
    checks,
    qualifiedForNewShadow: Object.values(checks).every(Boolean),
  };
}

function markdown(report) {
  const { baseline, candidate, stressed, checks, qualifiedForNewShadow } = report.decision;
  return [
    '# 模拟盘月度亏损保护研究',
    '',
    `- 数据截止：${report.dataEndDate}`,
    `- 开发选择：${developmentPeriod.startMonth} 至 ${developmentPeriod.endMonth}`,
    `- 冻结验证：${validationPeriod.startMonth} 至 ${validationPeriod.endMonth}`,
    `- 试验数量：${report.trialCount}`,
    `- 新影子准入：${qualifiedForNewShadow ? '通过' : '未通过'}`,
    '',
    '| 方案 | 开发盈利月 | 开发年化 | 验证盈利月 | 验证年化 | 验证回撤 | 历史年化 | 历史回撤 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| 基准 | ${baseline.development.positiveMonths}/${baseline.development.monthCount} | ${percent(baseline.development.annualizedReturn)} | ${baseline.validation.positiveMonths}/${baseline.validation.monthCount} | ${percent(baseline.validation.annualizedReturn)} | ${percent(baseline.validation.maxDrawdown)} | ${percent(baseline.historical.annualizedReturn)} | ${percent(baseline.historical.maxDrawdown)} |`,
    ...(candidate ? [
      `| ${settingLabel(candidate)} | ${candidate.development.positiveMonths}/${candidate.development.monthCount} | ${percent(candidate.development.annualizedReturn)} | ${candidate.validation.positiveMonths}/${candidate.validation.monthCount} | ${percent(candidate.validation.annualizedReturn)} | ${percent(candidate.validation.maxDrawdown)} | ${percent(candidate.historical.annualizedReturn)} | ${percent(candidate.historical.maxDrawdown)} |`,
      `| 候选2×成本 | ${stressed.development.positiveMonths}/${stressed.development.monthCount} | ${percent(stressed.development.annualizedReturn)} | ${stressed.validation.positiveMonths}/${stressed.validation.monthCount} | ${percent(stressed.validation.annualizedReturn)} | ${percent(stressed.validation.maxDrawdown)} | ${percent(stressed.historical.annualizedReturn)} | ${percent(stressed.historical.maxDrawdown)} |`,
    ] : []),
    '',
    '## 准入检查',
    '',
    ...(candidate
      ? Object.entries(checks).map(([key, passed]) => `- ${passed ? '通过' : '未通过'}：${key}`)
      : ['- 开发区间没有找到满足最低条件的候选。']),
    '',
    '> 参数选择不查看冻结验证结果；历史通过也只允许启动独立影子，不修改冻结基准。',
    '',
  ].join('\n');
}

const { manifest, endDate, seriesBySymbol } = await loadMarket();
const results = [];
for (const dispersionTarget of dispersionTargets) {
  for (const monthlyLossLimit of monthlyLossLimits) {
    for (const costMultiplier of costMultipliers) {
      results.push(evaluate(
        seriesBySymbol,
        endDate,
        dispersionTarget,
        monthlyLossLimit,
        costMultiplier,
      ));
    }
  }
}
const decision = selectCandidate(results);
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  dataEndDate: endDate,
  manifestRequestedEndTimeUtc: manifest.requestedEndTimeUtc,
  developmentPeriod,
  validationPeriod,
  historicalPeriod: { startDate: historicalStartDate, endDate },
  trialCount: results.length,
  dispersionTargets,
  monthlyLossLimits,
  costMultipliers,
  results,
  decision,
  targetDisclaimer: '历史回测不是未来收益保证；年化10%和80%盈利月只是研究准入目标。',
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, 'loss-guard-latest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(
  path.join(outputDir, 'loss-guard-latest.md'),
  `${markdown(report)}\n`,
  'utf8',
);

console.table(Object.fromEntries([
  ['基准', decision.baseline],
  ...(decision.candidate ? [['开发选择候选', decision.candidate]] : []),
  ...(decision.stressed ? [['候选2×成本', decision.stressed]] : []),
].map(([label, item]) => [label, {
  参数: settingLabel(item),
  开发盈利月: `${item.development.positiveMonths}/${item.development.monthCount}`,
  开发年化: percent(item.development.annualizedReturn),
  验证盈利月: `${item.validation.positiveMonths}/${item.validation.monthCount}`,
  验证年化: percent(item.validation.annualizedReturn),
  验证回撤: percent(item.validation.maxDrawdown),
  历史年化: percent(item.historical.annualizedReturn),
  历史回撤: percent(item.historical.maxDrawdown),
}])));
console.table(decision.checks);
console.log(JSON.stringify({
  dataEndDate: endDate,
  trialCount: results.length,
  developmentEligibleCount: decision.developmentEligibleCount || 0,
  qualifiedForNewShadow: decision.qualifiedForNewShadow,
  candidate: decision.candidate,
  doubleCost: decision.stressed,
}));
