import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCrossSectionalBacktest } from '../src/cross-sectional-backtest.js';
import { runLongShortTrendBacktest } from '../src/long-short-trend.js';
import { MONTHLY_ACCURACY_PAPER_PROFILE } from '../src/monthly-accuracy-paper.js';

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expandedUniverseMode = process.argv.includes('--expanded-universe');
const marketDir = expandedUniverseMode
  ? path.join(rootDir, 'data', 'runtime', 'expanded-universe', 'spot', '1h')
  : path.join(rootDir, 'data', 'market', 'spot', '1h');
const outputDir = path.join(rootDir, 'data', 'runtime', 'paper-research');
const outputStem = expandedUniverseMode
  ? 'expanded-universe-latest'
  : 'diversification-latest';
const developmentPeriod = Object.freeze({ startMonth: '2023-01', endMonth: '2024-12' });
const validationPeriod = Object.freeze({ startMonth: '2025-01', endMonth: '2026-06' });
const historicalStartDate = '2023-01-01';
const positionsGrid = Object.freeze([1, 2, 3]);
const diversifiedShareGrid = Object.freeze([0, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60]);
const costMultipliers = Object.freeze([1, 1.5, 2]);

function round(value, digits = 8) {
  return Number(Number(value).toFixed(digits));
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
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
    symbols: manifest.datasets.map((dataset) => dataset.symbol),
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
    return { month, value: round(value) };
  });
}

function lastCompleteMonth(endDate) {
  const date = new Date(`${endDate}T00:00:00.000Z`);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  if (date.getUTCDate() === lastDay) return endDate.slice(0, 7);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 7);
}

function rangeMetrics(result, startDate, endDate, monthRange = null) {
  const startingEquity = result.equityCurve.filter((point) => point.date < startDate).at(-1)?.equity || 1;
  const daily = result.equityCurve.filter((point) => point.date >= startDate && point.date <= endDate);
  if (!daily.length) throw new Error(`回测范围 ${startDate} 至 ${endDate} 没有净值数据`);
  let peak = startingEquity;
  let previousEquity = startingEquity;
  let maxDrawdown = 0;
  const dailyReturns = [];
  for (const point of daily) {
    dailyReturns.push(point.equity / previousEquity - 1);
    previousEquity = point.equity;
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
  }
  const totalReturn = daily.at(-1).equity / startingEquity - 1;
  const elapsedDays = Math.max(1, (Date.parse(endDate) - Date.parse(startDate)) / DAY_MS);
  const effectiveMonthRange = monthRange || {
    startMonth: startDate.slice(0, 7),
    endMonth: lastCompleteMonth(endDate),
  };
  const monthly = monthlyReturns(result.equityCurve).filter((item) => (
    item.month >= effectiveMonthRange.startMonth && item.month <= effectiveMonthRange.endMonth
  ));
  const positiveMonths = monthly.filter((item) => item.value > 0).length;
  return {
    totalReturn: round(totalReturn),
    annualizedReturn: round((1 + totalReturn) ** (DAYS_PER_YEAR / elapsedDays) - 1),
    annualizedVolatility: round(sampleStandardDeviation(dailyReturns) * Math.sqrt(DAYS_PER_YEAR)),
    maxDrawdown: round(maxDrawdown),
    monthCount: monthly.length,
    positiveMonths,
    positiveMonthRatio: round(positiveMonths / monthly.length),
    monthly,
  };
}

function periodMetrics(result, period) {
  return rangeMetrics(result, `${period.startMonth}-01`, `${period.endMonth}-30`, period);
}

function yearlyMetrics(result, endDate) {
  return [2023, 2024, 2025, 2026].map((year) => {
    const startDate = `${year}-01-01`;
    const yearEnd = year === 2026 ? endDate : `${year}-12-31`;
    return { year, ...rangeMetrics(result, startDate, yearEnd) };
  });
}

function runPositionStrategy(
  seriesBySymbol,
  positionsPerSide,
  costMultiplier,
  marketNeutralOverrides = {},
) {
  const profile = MONTHLY_ACCURACY_PAPER_PROFILE;
  const marketNeutralResult = runCrossSectionalBacktest(seriesBySymbol, {
    ...profile.marketNeutral,
    positionsPerSide,
    ...marketNeutralOverrides,
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
  return { combined, marketNeutralResult };
}

function evaluate(
  seriesBySymbol,
  endDate,
  positionsPerSide,
  costMultiplier,
  marketNeutralOverrides = {},
) {
  const profile = MONTHLY_ACCURACY_PAPER_PROFILE;
  const { combined, marketNeutralResult } = runPositionStrategy(
    seriesBySymbol,
    positionsPerSide,
    costMultiplier,
    marketNeutralOverrides,
  );
  return {
    positionsPerSide,
    costMultiplier,
    development: periodMetrics(combined, developmentPeriod),
    validation: periodMetrics(combined, validationPeriod),
    historical: rangeMetrics(combined, historicalStartDate, endDate),
    yearly: yearlyMetrics(combined, endDate),
    concentration: {
      maximumSingleAssetWeight: round(
        profile.marketNeutralWeight * profile.marketNeutral.maxGrossExposure / 2 / positionsPerSide,
      ),
      averageSingleAssetWeight: round(
        profile.marketNeutralWeight * marketNeutralResult.metrics.averageGrossExposure / 2 / positionsPerSide,
      ),
    },
    crossRisk: {
      totalTurnover: marketNeutralResult.metrics.totalTurnover,
      averageGrossExposure: marketNeutralResult.metrics.averageGrossExposure,
      averageDynamicLeverage: marketNeutralResult.metrics.averageDynamicLeverage,
      averageReferenceScale: marketNeutralResult.metrics.averageReferenceScale,
      referenceFilteredDays: marketNeutralResult.metrics.referenceFilteredDays,
    },
  };
}

function fixedRiskFilterDecision(results, referenceBaseline) {
  if (!results?.length) return null;
  const candidate = results.find((item) => item.costMultiplier === 1);
  const stressed = results.find((item) => item.costMultiplier === 2);
  const checks = {
    concentrationReducedByFortyPercent:
      candidate.concentration.maximumSingleAssetWeight
        <= referenceBaseline.concentration.maximumSingleAssetWeight * 0.60,
    developmentMonthlyTarget: candidate.development.positiveMonthRatio >= 0.80,
    developmentAnnualizedTarget: candidate.development.annualizedReturn >= 0.10,
    validationMonthlyTarget: candidate.validation.positiveMonthRatio >= 0.80,
    validationAnnualizedTarget: candidate.validation.annualizedReturn >= 0.10,
    validationDrawdownLimit: candidate.validation.maxDrawdown >= -0.15,
    historicalAnnualizedTarget: candidate.historical.annualizedReturn >= 0.10,
    historicalDrawdownImproved:
      candidate.historical.maxDrawdown > referenceBaseline.historical.maxDrawdown,
    doubleCostMonthlyTarget: stressed.validation.positiveMonthRatio >= 0.80,
    doubleCostAnnualizedTarget: stressed.validation.annualizedReturn >= 0.10,
    doubleCostDrawdownLimit: stressed.validation.maxDrawdown >= -0.15,
  };
  return {
    baseline: referenceBaseline,
    candidate,
    stressed,
    checks,
    historicallyQualified: Object.values(checks).every(Boolean),
  };
}

function candidateChecks(results, referenceBaseline = null) {
  const find = (positionsPerSide, costMultiplier) => results.find((item) => (
    item.positionsPerSide === positionsPerSide && item.costMultiplier === costMultiplier
  ));
  const baseline = referenceBaseline || find(1, 1);
  const candidate = find(2, 1);
  const stressed = find(2, 2);
  const checks = {
    concentrationReducedByFortyPercent:
      candidate.concentration.maximumSingleAssetWeight
        <= baseline.concentration.maximumSingleAssetWeight * 0.60,
    developmentMonthlyTarget: candidate.development.positiveMonthRatio >= 0.80,
    developmentAnnualizedTarget: candidate.development.annualizedReturn >= 0.10,
    validationMonthlyTarget: candidate.validation.positiveMonthRatio >= 0.80,
    validationAnnualizedTarget: candidate.validation.annualizedReturn >= 0.10,
    validationDrawdownLimit: candidate.validation.maxDrawdown >= -0.15,
    historicalAnnualizedTarget: candidate.historical.annualizedReturn >= 0.10,
    historicalDrawdownImproved: candidate.historical.maxDrawdown > baseline.historical.maxDrawdown,
    doubleCostMonthlyTarget: stressed.validation.positiveMonthRatio >= 0.80,
    doubleCostAnnualizedTarget: stressed.validation.annualizedReturn >= 0.10,
    doubleCostDrawdownLimit: stressed.validation.maxDrawdown >= -0.15,
  };
  return {
    baseline,
    candidate,
    stressed,
    checks,
    historicallyQualified: Object.values(checks).every(Boolean),
  };
}

function evaluateBlend(seriesBySymbol, endDate, diversifiedShare, costMultiplier) {
  const profile = MONTHLY_ACCURACY_PAPER_PROFILE;
  const concentrated = runPositionStrategy(seriesBySymbol, 1, costMultiplier);
  const diversified = runPositionStrategy(seriesBySymbol, 2, costMultiplier);
  const concentratedShare = 1 - diversifiedShare;
  const combined = combineResults(
    [concentrated.combined, diversified.combined],
    [concentratedShare, diversifiedShare],
  );
  const concentratedMax = profile.marketNeutralWeight
    * profile.marketNeutral.maxGrossExposure / 2;
  const diversifiedMax = concentratedMax / 2;
  return {
    diversifiedShare,
    concentratedShare,
    costMultiplier,
    development: periodMetrics(combined, developmentPeriod),
    validation: periodMetrics(combined, validationPeriod),
    historical: rangeMetrics(combined, historicalStartDate, endDate),
    yearly: yearlyMetrics(combined, endDate),
    concentration: {
      maximumSingleAssetWeight: round(
        concentratedShare * concentratedMax + diversifiedShare * diversifiedMax,
      ),
    },
    crossRisk: {
      estimatedTotalTurnover: round(
        concentratedShare * concentrated.marketNeutralResult.metrics.totalTurnover
          + diversifiedShare * diversified.marketNeutralResult.metrics.totalTurnover,
      ),
    },
  };
}

function blendCandidateChecks(results) {
  const normal = results.filter((item) => item.costMultiplier === 1);
  const baseline = normal.find((item) => item.diversifiedShare === 0);
  const eligible = normal.filter((item) => (
    item.diversifiedShare > 0
    && item.development.positiveMonthRatio >= 0.80
    && item.development.annualizedReturn >= 0.10
    && item.development.maxDrawdown >= baseline.development.maxDrawdown
    && item.concentration.maximumSingleAssetWeight
      <= baseline.concentration.maximumSingleAssetWeight * 0.90
  )).sort((left, right) => right.diversifiedShare - left.diversifiedShare);
  const candidate = eligible[0] || null;
  if (!candidate) {
    return { baseline, candidate: null, checks: {}, historicallyQualified: false };
  }
  const stressed = results.find((item) => (
    item.diversifiedShare === candidate.diversifiedShare && item.costMultiplier === 2
  ));
  const candidateIndex = diversifiedShareGrid.indexOf(candidate.diversifiedShare);
  const neighborhoodShares = diversifiedShareGrid.slice(
    Math.max(1, candidateIndex - 1),
    Math.min(diversifiedShareGrid.length, candidateIndex + 2),
  );
  const neighborhood = neighborhoodShares.map((share) => normal.find((item) => (
    item.diversifiedShare === share
  )));
  const neighborhoodPassed = neighborhood.filter((item) => (
    item.validation.positiveMonthRatio >= 0.80
    && item.validation.annualizedReturn >= 0.10
    && item.validation.maxDrawdown >= -0.15
  )).length;
  const checks = {
    concentrationReducedByTenPercent:
      candidate.concentration.maximumSingleAssetWeight
        <= baseline.concentration.maximumSingleAssetWeight * 0.90,
    validationMonthlyTarget: candidate.validation.positiveMonthRatio >= 0.80,
    validationAnnualizedTarget: candidate.validation.annualizedReturn >= 0.10,
    validationDrawdownImproved: candidate.validation.maxDrawdown > baseline.validation.maxDrawdown,
    historicalAnnualizedTarget: candidate.historical.annualizedReturn >= 0.10,
    historicalDrawdownImproved: candidate.historical.maxDrawdown > baseline.historical.maxDrawdown,
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
    historicallyQualified: Object.values(checks).every(Boolean),
  };
}

function markdown(report) {
  const normalRows = report.results.filter((item) => item.costMultiplier === 1);
  const blendRows = report.blendResults.filter((item) => item.costMultiplier === 1);
  const baseline = report.decision.baseline;
  const candidate = report.decision.candidate;
  return [
    `# ${expandedUniverseMode ? '扩展交易池' : '分散横截面持仓'}历史验证`,
    '',
    `- 交易对：${report.symbols.join('、')}`,
    `- 交易池模式：${expandedUniverseMode ? '12币种隔离研究，对比六币种冻结基准' : '六币种冻结交易池'}`,
    `- 数据截止：${report.dataEndDate}`,
    `- 开发区间：${developmentPeriod.startMonth} 至 ${developmentPeriod.endMonth}`,
    `- 冻结验证：${validationPeriod.startMonth} 至 ${validationPeriod.endMonth}`,
    `- 试验数量：${report.trialCount}`,
    `- 全分散历史准入：${report.decision.historicallyQualified ? '通过' : '未通过'}`,
    `- 部分分散历史准入：${report.blendDecision.historicallyQualified ? '通过' : '未通过'}`,
    '',
    '| 每侧持仓 | 验证盈利月 | 验证年化 | 验证波动 | 验证回撤 | 历史年化 | 历史回撤 | 单币最大权重 | 换手 |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...normalRows.map((item) => (
      `| ${item.positionsPerSide} | ${item.validation.positiveMonths}/${item.validation.monthCount} | ${percent(item.validation.annualizedReturn)} | ${percent(item.validation.annualizedVolatility)} | ${percent(item.validation.maxDrawdown)} | ${percent(item.historical.annualizedReturn)} | ${percent(item.historical.maxDrawdown)} | ${percent(item.concentration.maximumSingleAssetWeight)} | ${item.crossRisk.totalTurnover.toFixed(2)} |`
    )),
    '',
    '## 每侧2个标的年度收益',
    '',
    '| 年份 | 收益 | 最大回撤 |',
    '| ---: | ---: | ---: |',
    ...candidate.yearly.map((item) => `| ${item.year} | ${percent(item.totalReturn)} | ${percent(item.maxDrawdown)} |`),
    '',
    '## 与每侧1个标的基准比较',
    '',
    `- 单币最大模型权重：${percent(baseline.concentration.maximumSingleAssetWeight)} → ${percent(candidate.concentration.maximumSingleAssetWeight)}`,
    `- 冻结验证年化：${percent(baseline.validation.annualizedReturn)} → ${percent(candidate.validation.annualizedReturn)}`,
    `- 冻结验证最大回撤：${percent(baseline.validation.maxDrawdown)} → ${percent(candidate.validation.maxDrawdown)}`,
    `- 全历史年化：${percent(baseline.historical.annualizedReturn)} → ${percent(candidate.historical.annualizedReturn)}`,
    `- 全历史最大回撤：${percent(baseline.historical.maxDrawdown)} → ${percent(candidate.historical.maxDrawdown)}`,
    '',
    '## 部分分散组合',
    '',
    '| 分散资金占比 | 验证盈利月 | 验证年化 | 验证波动 | 验证回撤 | 历史年化 | 历史回撤 | 单币最大权重 |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...blendRows.map((item) => (
      `| ${percent(item.diversifiedShare)} | ${item.validation.positiveMonths}/${item.validation.monthCount} | ${percent(item.validation.annualizedReturn)} | ${percent(item.validation.annualizedVolatility)} | ${percent(item.validation.maxDrawdown)} | ${percent(item.historical.annualizedReturn)} | ${percent(item.historical.maxDrawdown)} | ${percent(item.concentration.maximumSingleAssetWeight)} |`
    )),
    '',
    '## 全分散准入检查',
    '',
    ...Object.entries(report.decision.checks).map(([key, passed]) => `- ${passed ? '通过' : '未通过'}：${key}`),
    '',
    '## 部分分散准入检查',
    '',
    ...(report.blendDecision.candidate
      ? Object.entries(report.blendDecision.checks).map(([key, passed]) => `- ${passed ? '通过' : '未通过'}：${key}`)
      : ['- 开发区间没有产生满足最低收益、盈利月和集中度要求的候选。']),
    ...(report.fixedRiskFilterDecision ? [
      '',
      '## 固定高波动过滤器复核',
      '',
      '- 规则来源：沿用既有六币研究的开发期胜出规则，不针对扩容验证期重新选参。',
      '- 规则：20日市场年化波动超过60%时，横截面仓位降为零；趋势子策略不变。',
      `- 开发盈利月：${report.fixedRiskFilterDecision.candidate.development.positiveMonths}/${report.fixedRiskFilterDecision.candidate.development.monthCount}`,
      `- 验证盈利月：${report.fixedRiskFilterDecision.candidate.validation.positiveMonths}/${report.fixedRiskFilterDecision.candidate.validation.monthCount}`,
      `- 验证年化：${percent(report.fixedRiskFilterDecision.candidate.validation.annualizedReturn)}`,
      `- 验证回撤：${percent(report.fixedRiskFilterDecision.candidate.validation.maxDrawdown)}`,
      `- 2x成本验证年化：${percent(report.fixedRiskFilterDecision.stressed.validation.annualizedReturn)}`,
      `- 历史准入：${report.fixedRiskFilterDecision.historicallyQualified ? '通过' : '未通过'}`,
      '',
      ...Object.entries(report.fixedRiskFilterDecision.checks)
        .map(([key, passed]) => `- ${passed ? '通过' : '未通过'}：${key}`),
    ] : []),
    '',
    '> 历史通过也不能替代新的前向样本；影子候选不会自动替换冻结基准。',
    '',
  ].join('\n');
}

const { manifest, endDate, symbols, seriesBySymbol } = await loadMarket();
const results = [];
for (const positionsPerSide of positionsGrid) {
  for (const costMultiplier of costMultipliers) {
    results.push(evaluate(seriesBySymbol, endDate, positionsPerSide, costMultiplier));
  }
}
let referenceBaseline = null;
if (expandedUniverseMode) {
  const referenceReport = JSON.parse(await fs.readFile(
    path.join(outputDir, 'diversification-latest.json'),
    'utf8',
  ));
  referenceBaseline = referenceReport.decision.baseline;
}
const decision = candidateChecks(results, referenceBaseline);
const blendResults = [];
for (const diversifiedShare of diversifiedShareGrid) {
  for (const costMultiplier of costMultipliers) {
    blendResults.push(evaluateBlend(
      seriesBySymbol,
      endDate,
      diversifiedShare,
      costMultiplier,
    ));
  }
}
const blendDecision = blendCandidateChecks(blendResults);
const fixedRiskFilterSettings = Object.freeze({
  referenceFilterEnabled: true,
  referenceWindowDays: 20,
  maximumMarketVolatility: 0.60,
  maximumBreadthImbalance: null,
  referenceOutsideScale: 0,
});
const fixedRiskFilterResults = expandedUniverseMode
  ? costMultipliers.map((costMultiplier) => evaluate(
    seriesBySymbol,
    endDate,
    2,
    costMultiplier,
    fixedRiskFilterSettings,
  ))
  : [];
const riskFilterDecision = expandedUniverseMode
  ? fixedRiskFilterDecision(fixedRiskFilterResults, referenceBaseline)
  : null;
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  dataEndDate: endDate,
  manifestRequestedEndTimeUtc: manifest.requestedEndTimeUtc,
  symbols,
  expandedUniverseMode,
  developmentPeriod,
  validationPeriod,
  historicalPeriod: { startDate: historicalStartDate, endDate },
  trialCount: results.length + blendResults.length + fixedRiskFilterResults.length,
  positionsGrid,
  diversifiedShareGrid,
  costMultipliers,
  results,
  decision,
  blendResults,
  blendDecision,
  fixedRiskFilterSettings: expandedUniverseMode ? fixedRiskFilterSettings : null,
  fixedRiskFilterResults,
  fixedRiskFilterDecision: riskFilterDecision,
  targetDisclaimer: '历史回测不是未来收益保证；年化10%和80%盈利月只是研究准入目标。',
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, `${outputStem}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(
  path.join(outputDir, `${outputStem}.md`),
  `${markdown(report)}\n`,
  'utf8',
);

console.table(Object.fromEntries(results
  .filter((item) => item.costMultiplier === 1)
  .map((item) => [`每侧${item.positionsPerSide}个`, {
    '验证盈利月': `${item.validation.positiveMonths}/${item.validation.monthCount}`,
    '验证年化': percent(item.validation.annualizedReturn),
    '验证波动': percent(item.validation.annualizedVolatility),
    '验证回撤': percent(item.validation.maxDrawdown),
    '历史年化': percent(item.historical.annualizedReturn),
    '历史回撤': percent(item.historical.maxDrawdown),
    '单币最大权重': percent(item.concentration.maximumSingleAssetWeight),
  }])));
console.table(decision.checks);
console.table(Object.fromEntries(blendResults
  .filter((item) => item.costMultiplier === 1)
  .map((item) => [`分散${percent(item.diversifiedShare)}`, {
    '开发盈利月': `${item.development.positiveMonths}/${item.development.monthCount}`,
    '验证盈利月': `${item.validation.positiveMonths}/${item.validation.monthCount}`,
    '验证年化': percent(item.validation.annualizedReturn),
    '验证回撤': percent(item.validation.maxDrawdown),
    '历史年化': percent(item.historical.annualizedReturn),
    '历史回撤': percent(item.historical.maxDrawdown),
    '单币最大权重': percent(item.concentration.maximumSingleAssetWeight),
  }])));
console.table(blendDecision.checks);
console.log(JSON.stringify({
  dataEndDate: endDate,
  trialCount: report.trialCount,
  historicallyQualified: decision.historicallyQualified,
  blendHistoricallyQualified: blendDecision.historicallyQualified,
  blendCandidate: blendDecision.candidate,
  blendDoubleCost: blendDecision.stressed,
  baseline: {
    validation: decision.baseline.validation,
    historical: decision.baseline.historical,
    concentration: decision.baseline.concentration,
  },
  candidate: {
    development: decision.candidate.development,
    validation: decision.candidate.validation,
    historical: decision.candidate.historical,
    yearly: decision.candidate.yearly,
    concentration: decision.candidate.concentration,
  },
  doubleCost: {
    validation: decision.stressed.validation,
    historical: decision.stressed.historical,
  },
}));
