import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCrossSectionalBacktest } from '../src/cross-sectional-backtest.js';
import { runLongShortTrendBacktest } from '../src/long-short-trend.js';
import { MONTHLY_ACCURACY_PAPER_PROFILE } from '../src/monthly-accuracy-paper.js';

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const outputDir = path.join(rootDir, 'data', 'runtime', 'paper-research');
const developmentPeriod = Object.freeze({ startMonth: '2023-01', endMonth: '2024-12' });
const validationPeriod = Object.freeze({ startMonth: '2025-01', endMonth: '2026-06' });
const historicalStartDate = '2023-01-01';
const windowGrid = Object.freeze([10, 20, 30]);
const targetGrid = Object.freeze([0.35, 0.45, 0.55, 0.65, 0.75]);
const minimumScaleGrid = Object.freeze([0, 0.25, 0.50, 0.75]);
const diversifiedScaleGrid = Object.freeze([0.75, 1]);
const allMinimumScales = Object.freeze([0, 0.25, 0.50, 0.75, 1]);

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
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0)
    / (values.length - 1));
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
    const dailyReturn = point.equity / previousEquity - 1;
    previousEquity = point.equity;
    return [point.date, dailyReturn];
  }));
}

function combineResults(results, weights) {
  const maps = results.map(dailyReturnMap);
  const dates = [...maps[0].keys()].filter((date) => maps.every((item) => item.has(date)));
  let equity = 1;
  return {
    equityCurve: dates.map((date) => {
      const dailyReturn = maps.reduce((sum, returns, index) => (
        sum + returns.get(date) * weights[index]
      ), 0);
      equity *= 1 + dailyReturn;
      return { date, equity };
    }),
  };
}

function monthEndDate(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
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
  const monthly = monthlyReturns(result.equityCurve).filter((item) => (
    !monthRange || (item.month >= monthRange.startMonth && item.month <= monthRange.endMonth)
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
  return rangeMetrics(result, `${period.startMonth}-01`, monthEndDate(period.endMonth), period);
}

function evaluate(seriesBySymbol, endDate, id, settings, costMultiplier = 1) {
  const profile = MONTHLY_ACCURACY_PAPER_PROFILE;
  const cross = runCrossSectionalBacktest(seriesBySymbol, {
    ...profile.marketNeutral,
    ...settings,
    tradingCostRate: profile.marketNeutral.tradingCostRate * costMultiplier,
    dailyCarryCostRate: profile.marketNeutral.dailyCarryCostRate * costMultiplier,
  });
  const trend = runLongShortTrendBacktest(seriesBySymbol, {
    ...profile.trend,
    tradingCostRate: profile.trend.tradingCostRate * costMultiplier,
    dailyCarryCostRate: profile.trend.dailyCarryCostRate * costMultiplier,
  });
  const combined = combineResults([cross, trend], [profile.marketNeutralWeight, profile.trendWeight]);
  return {
    id,
    settings,
    costMultiplier,
    development: periodMetrics(combined, developmentPeriod),
    validation: periodMetrics(combined, validationPeriod),
    historical: rangeMetrics(combined, historicalStartDate, endDate),
    crossRisk: {
      spreadRiskScaledDays: cross.metrics.spreadRiskScaledDays,
      spreadRiskTriggeredDays: cross.metrics.spreadRiskTriggeredDays,
      averageSpreadRiskScale: cross.metrics.averageSpreadRiskScale,
      p95SelectedSpreadVolatility: cross.metrics.p95SelectedSpreadVolatility,
      averageGrossExposure: cross.metrics.averageGrossExposure,
      p95SingleAssetExposure: cross.metrics.p95SingleAssetExposure,
      maximumSingleAssetExposure: cross.metrics.maximumSingleAssetExposure,
      totalTurnover: cross.metrics.totalTurnover,
    },
  };
}

function candidates() {
  return windowGrid.flatMap((spreadVolatilityWindowDays) => targetGrid.flatMap(
    (spreadVolatilityTarget) => [
      ...minimumScaleGrid.map((minimumSpreadRiskScale) => ({
        id: `spread-shrink-w${spreadVolatilityWindowDays}-target${spreadVolatilityTarget}-floor${minimumSpreadRiskScale}`,
        settings: {
          spreadRiskEnabled: true,
          spreadVolatilityWindowDays,
          spreadVolatilityTarget,
          minimumSpreadRiskScale,
          spreadRiskPositionsPerSide: null,
        },
      })),
      ...diversifiedScaleGrid.map((minimumSpreadRiskScale) => ({
        id: `spread-breadth2-w${spreadVolatilityWindowDays}-target${spreadVolatilityTarget}-floor${minimumSpreadRiskScale}`,
        settings: {
          spreadRiskEnabled: true,
          spreadVolatilityWindowDays,
          spreadVolatilityTarget,
          minimumSpreadRiskScale,
          spreadRiskPositionsPerSide: 2,
        },
      })),
    ],
  ));
}

function selectDevelopment(results, baseline) {
  return results.filter((item) => (
    item.development.positiveMonths >= baseline.development.positiveMonths
    && item.development.annualizedReturn >= baseline.development.annualizedReturn * 0.95
    && item.development.maxDrawdown >= baseline.development.maxDrawdown - 0.01
    && item.crossRisk.spreadRiskScaledDays > 0
  )).sort((left, right) => (
    right.development.positiveMonths - left.development.positiveMonths
    || right.development.annualizedReturn - left.development.annualizedReturn
    || right.development.maxDrawdown - left.development.maxDrawdown
  ));
}

function neighborResults(selected, results) {
  if (!selected) return [];
  const windowIndex = windowGrid.indexOf(selected.settings.spreadVolatilityWindowDays);
  const targetIndex = targetGrid.indexOf(selected.settings.spreadVolatilityTarget);
  const floorIndex = allMinimumScales.indexOf(selected.settings.minimumSpreadRiskScale);
  return results.filter((item) => {
    if (item.id === selected.id) return false;
    const windowDistance = Math.abs(windowGrid.indexOf(item.settings.spreadVolatilityWindowDays) - windowIndex);
    const targetDistance = Math.abs(targetGrid.indexOf(item.settings.spreadVolatilityTarget) - targetIndex);
    const floorDistance = Math.abs(allMinimumScales.indexOf(item.settings.minimumSpreadRiskScale) - floorIndex);
    const sameBreadthMode = item.settings.spreadRiskPositionsPerSide
      === selected.settings.spreadRiskPositionsPerSide;
    return sameBreadthMode && windowDistance + targetDistance + floorDistance === 1;
  });
}

function makeDecision(baseline, selected, stressed, neighbors) {
  if (!selected || !stressed) {
    return { qualifiedForNewShadow: false, checks: {}, reason: '开发期没有候选通过预设门槛' };
  }
  const neighborPassed = neighbors.filter((item) => (
    item.validation.positiveMonths >= baseline.validation.positiveMonths
    && item.validation.annualizedReturn >= baseline.validation.annualizedReturn * 0.95
    && item.validation.maxDrawdown >= baseline.validation.maxDrawdown - 0.01
  )).length;
  const neighborPassRatio = neighbors.length ? neighborPassed / neighbors.length : 0;
  const checks = {
    validationPositiveMonthsNotLower:
      selected.validation.positiveMonths >= baseline.validation.positiveMonths,
    validationAnnualizedNotLower:
      selected.validation.annualizedReturn >= baseline.validation.annualizedReturn,
    validationDrawdownImproved:
      selected.validation.maxDrawdown > baseline.validation.maxDrawdown,
    historicalAnnualizedNotLower:
      selected.historical.annualizedReturn >= baseline.historical.annualizedReturn,
    historicalDrawdownImproved:
      selected.historical.maxDrawdown > baseline.historical.maxDrawdown,
    p95ConcentrationImproved:
      selected.crossRisk.p95SingleAssetExposure < baseline.crossRisk.p95SingleAssetExposure,
    doubleCostPositiveMonthTarget: stressed.validation.positiveMonthRatio >= 0.80,
    doubleCostAnnualizedTarget: stressed.validation.annualizedReturn >= 0.10,
    doubleCostDrawdownLimit: stressed.validation.maxDrawdown >= -0.15,
    neighborhoodMajorityPassed: neighbors.length >= 2 && neighborPassRatio >= 0.60,
  };
  return {
    qualifiedForNewShadow: Object.values(checks).every(Boolean),
    checks,
    neighborCount: neighbors.length,
    neighborPassed,
    neighborPassRatio: round(neighborPassRatio),
    reason: Object.values(checks).every(Boolean) ? null : '冻结验证、成本压力或参数邻域门槛未全部通过',
  };
}

function row(item) {
  return {
    '开发盈利月': `${item.development.positiveMonths}/${item.development.monthCount}`,
    '开发年化': percent(item.development.annualizedReturn),
    '验证盈利月': `${item.validation.positiveMonths}/${item.validation.monthCount}`,
    '验证年化': percent(item.validation.annualizedReturn),
    '验证回撤': percent(item.validation.maxDrawdown),
    '历史年化': percent(item.historical.annualizedReturn),
    '历史回撤': percent(item.historical.maxDrawdown),
    'P95单币': percent(item.crossRisk.p95SingleAssetExposure),
    '触发日': item.crossRisk.spreadRiskTriggeredDays,
  };
}

function markdown(report) {
  const displayed = [report.baseline, ...(report.selected ? [report.selected] : []), ...report.topDevelopment];
  const unique = [...new Map(displayed.map((item) => [item.id, item])).values()];
  return [
    '# 选中价差波动缩放研究',
    '',
    `- 数据截止：${report.dataEndDate}`,
    `- 开发区间：${developmentPeriod.startMonth} 至 ${developmentPeriod.endMonth}`,
    `- 冻结验证：${validationPeriod.startMonth} 至 ${validationPeriod.endMonth}`,
    `- 参数候选：${report.candidateCount}`,
    `- 开发期合格候选：${report.developmentEligibleCount}`,
    `- 新影子准入：${report.decision.qualifiedForNewShadow ? '通过' : '未通过'}`,
    '',
    '| 策略 | 开发盈利月 | 开发年化 | 验证盈利月 | 验证年化 | 验证回撤 | 历史年化 | 历史回撤 | P95单币 | 触发日 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...unique.map((item) => `| ${item.id} | ${item.development.positiveMonths}/${item.development.monthCount} | ${percent(item.development.annualizedReturn)} | ${item.validation.positiveMonths}/${item.validation.monthCount} | ${percent(item.validation.annualizedReturn)} | ${percent(item.validation.maxDrawdown)} | ${percent(item.historical.annualizedReturn)} | ${percent(item.historical.maxDrawdown)} | ${percent(item.crossRisk.p95SingleAssetExposure)} | ${item.crossRisk.spreadRiskTriggeredDays} |`),
    '',
    '## 准入检查',
    '',
    ...(Object.entries(report.decision.checks).length
      ? Object.entries(report.decision.checks).map(([key, passed]) => `- ${passed ? '通过' : '失败'}：${key}`)
      : [`- ${report.decision.reason}`]),
    '',
    `- 参数邻域通过：${report.decision.neighborPassed || 0}/${report.decision.neighborCount || 0}`,
    '',
    '候选只用开发区间排序；冻结验证不参与选参。未通过时保留默认关闭，不修改正式基准或新增影子。',
  ].join('\n');
}

const market = await loadMarket();
const baseline = evaluate(market.seriesBySymbol, market.endDate, 'monthly-accuracy-85-15-v1', {
  spreadRiskEnabled: false,
}, 1);
const candidateList = candidates();
const results = candidateList.map((candidate) => evaluate(
  market.seriesBySymbol,
  market.endDate,
  candidate.id,
  candidate.settings,
  1,
));
const developmentEligible = selectDevelopment(results, baseline);
const selected = developmentEligible[0] || null;
const stressed = selected
  ? evaluate(market.seriesBySymbol, market.endDate, selected.id, selected.settings, 2)
  : null;
const neighbors = neighborResults(selected, results);
const decision = makeDecision(baseline, selected, stressed, neighbors);
const report = {
  generatedAt: new Date().toISOString(),
  dataEndDate: market.endDate,
  developmentPeriod,
  validationPeriod,
  selectionRule: '只按2023-2024盈利月、年化和回撤选择价差波动参数',
  candidateCount: candidateList.length,
  developmentEligibleCount: developmentEligible.length,
  baseline,
  selected,
  stressed,
  neighbors,
  decision,
  topDevelopment: developmentEligible.slice(0, 5),
  allResults: results,
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, 'spread-risk-latest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(
  path.join(outputDir, 'spread-risk-latest.md'),
  `${markdown(report)}\n`,
  'utf8',
);

console.table({
  基准: row(baseline),
  ...(selected ? { 开发期选择候选: row(selected), 双倍成本候选: row(stressed) } : {}),
});
console.table(decision.checks);
console.log(`候选数量：${candidateList.length}；开发期合格：${developmentEligible.length}；新影子准入：${decision.qualifiedForNewShadow ? '通过' : '未通过'}`);
