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
const validationPeriod = Object.freeze({ startMonth: '2025-01', endMonth: '2026-06' });
const historicalStartDate = '2023-01-01';
const dispersionTargets = Object.freeze([0.15, 0.17, 0.18, 0.19, 0.20, 0.21, 0.22, 0.23, 0.25]);
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

function rangeMetrics(result, startDate, endDate, monthRange = null) {
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
  return {
    totalReturn: round(totalReturn),
    annualizedReturn: round((1 + totalReturn) ** (365 / elapsedDays) - 1),
    maxDrawdown: round(maxDrawdown),
    monthCount: monthly.length,
    positiveMonths: monthly.filter((item) => item.value > 0).length,
    positiveMonthRatio: monthly.length
      ? round(monthly.filter((item) => item.value > 0).length / monthly.length)
      : null,
  };
}

function validationMetrics(result) {
  return rangeMetrics(
    result,
    `${validationPeriod.startMonth}-01`,
    `${validationPeriod.endMonth}-30`,
    validationPeriod,
  );
}

function evaluate(seriesBySymbol, endDate, dispersionTarget, costMultiplier) {
  const profile = MONTHLY_ACCURACY_PAPER_PROFILE;
  const crossResult = runCrossSectionalBacktest(seriesBySymbol, {
    ...profile.marketNeutral,
    dispersionTarget,
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
    costMultiplier,
    validation: validationMetrics(combined),
    historical: rangeMetrics(combined, historicalStartDate, endDate),
    crossRisk: {
      averageGrossExposure: crossResult.metrics.averageGrossExposure,
      averageDynamicLeverage: crossResult.metrics.averageDynamicLeverage,
      maximumDynamicLeverage: crossResult.metrics.maximumDynamicLeverage,
      totalTurnover: crossResult.metrics.totalTurnover,
    },
  };
}

function candidateChecks(results) {
  const find = (target, cost) => results.find((item) => (
    item.dispersionTarget === target && item.costMultiplier === cost
  ));
  const baseline = find(0.15, 1);
  const candidate = find(0.20, 1);
  const stressed = find(0.20, 2);
  const neighborhood = [0.18, 0.19, 0.20, 0.21, 0.22].map((target) => find(target, 1));
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
  const rows = report.results.filter((item) => (
    item.costMultiplier === 1 || (item.dispersionTarget === 0.20 && item.costMultiplier > 1)
  ));
  return [
    '# 模拟盘 dispersionTarget 稳健性研究',
    '',
    `- 数据截止：${report.dataEndDate}`,
    `- 冻结验证：${validationPeriod.startMonth} 至 ${validationPeriod.endMonth}`,
    `- 试验数量：${report.trialCount}`,
    `- 新影子准入：${report.decision.qualifiedForNewShadow ? '通过' : '未通过'}`,
    '',
    '| dispersionTarget | 成本倍数 | 验证盈利月 | 验证年化 | 验证回撤 | 历史年化 | 历史回撤 | 横截面平均杠杆 |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map((item) => (
      `| ${item.dispersionTarget.toFixed(2)} | ${item.costMultiplier.toFixed(1)}× | ${item.validation.positiveMonths}/${item.validation.monthCount} | ${percent(item.validation.annualizedReturn)} | ${percent(item.validation.maxDrawdown)} | ${percent(item.historical.annualizedReturn)} | ${percent(item.historical.maxDrawdown)} | ${Number(item.crossRisk.averageDynamicLeverage).toFixed(2)}× |`
    )),
    '',
    '## 准入检查',
    '',
    ...Object.entries(report.decision.checks).map(([key, passed]) => `- ${passed ? '通过' : '未通过'}：${key}`),
    '',
    '> 该研究只决定是否启动新的纸面影子候选，不修改冻结基准，也不代表未来收益。',
    '',
  ].join('\n');
}

const { manifest, endDate, seriesBySymbol } = await loadMarket();
const results = [];
for (const dispersionTarget of dispersionTargets) {
  for (const costMultiplier of costMultipliers) {
    results.push(evaluate(seriesBySymbol, endDate, dispersionTarget, costMultiplier));
  }
}
const decision = candidateChecks(results);
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  dataEndDate: endDate,
  manifestRequestedEndTimeUtc: manifest.requestedEndTimeUtc,
  validationPeriod,
  historicalPeriod: { startDate: historicalStartDate, endDate },
  trialCount: results.length,
  dispersionTargets,
  costMultipliers,
  results,
  decision,
  targetDisclaimer: '年化10%和80%盈利月为研究准入目标，不是收益或胜率保证。',
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, 'dispersion-latest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(path.join(outputDir, 'dispersion-latest.md'), `${markdown(report)}\n`, 'utf8');

console.table(Object.fromEntries(results
  .filter((item) => item.costMultiplier === 1)
  .map((item) => [item.dispersionTarget.toFixed(2), {
    '验证盈利月': `${item.validation.positiveMonths}/${item.validation.monthCount}`,
    '验证年化': percent(item.validation.annualizedReturn),
    '验证回撤': percent(item.validation.maxDrawdown),
    '历史年化': percent(item.historical.annualizedReturn),
    '历史回撤': percent(item.historical.maxDrawdown),
    '平均动态杠杆': `${Number(item.crossRisk.averageDynamicLeverage).toFixed(2)}×`,
  }])));
console.table(decision.checks);
console.log(JSON.stringify({
  dataEndDate: endDate,
  trialCount: results.length,
  qualifiedForNewShadow: decision.qualifiedForNewShadow,
  candidate: decision.candidate,
  doubleCost: decision.stressed,
  neighborhoodPassed: `${decision.neighborhoodPassed}/${decision.neighborhood.length}`,
}));
