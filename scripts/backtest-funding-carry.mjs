import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateFundingCarryRelease,
  rankFundingCarryCandidates,
  runFundingCarryBacktest,
} from '../src/funding-carry-backtest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fundingDir = path.join(rootDir, 'data', 'market', 'funding');
const spotDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const manifest = JSON.parse(await fs.readFile(path.join(fundingDir, 'manifest.json'), 'utf8'));

async function loadSpotOpenByTime(symbol) {
  const text = await fs.readFile(path.join(spotDir, `${symbol}-1h.csv`), 'utf8');
  const [headerLine, ...rows] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const timeIndex = headers.indexOf('open_time');
  const openIndex = headers.indexOf('open');
  return new Map(rows.map((row) => {
    const columns = row.split(',');
    return [Number(columns[timeIndex]), Number(columns[openIndex])];
  }));
}

async function loadFundingSeries(dataset) {
  const [text, spotByTime] = await Promise.all([
    fs.readFile(path.join(fundingDir, dataset.file), 'utf8'),
    loadSpotOpenByTime(dataset.symbol),
  ]);
  const [headerLine, ...rows] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const timeIndex = headers.indexOf('funding_time');
  const rateIndex = headers.indexOf('funding_rate');
  const markIndex = headers.indexOf('mark_price');
  return rows.map((row) => {
    const columns = row.split(',');
    const fundingTime = Number(columns[timeIndex]);
    const spotTime = Math.floor(fundingTime / 3_600_000) * 3_600_000;
    return {
      fundingTime,
      fundingRate: Number(columns[rateIndex]),
      markPrice: Number(columns[markIndex]),
      spotPrice: spotByTime.get(spotTime),
    };
  }).filter((item) => Number.isFinite(item.spotPrice));
}

const seriesBySymbol = Object.fromEntries(await Promise.all(manifest.datasets.map(async (dataset) => [
  dataset.symbol,
  await loadFundingSeries(dataset),
])));

const candidates = [];
for (const lookbackIntervals of [2, 3, 6]) {
  for (const minimumAverageFundingRate of [0.00005, 0.0001]) {
    for (const exitAfterWeakIntervals of [1, 3, 6]) {
      candidates.push({ lookbackIntervals, minimumAverageFundingRate, exitAfterWeakIntervals });
    }
  }
}

const developmentPeriod = {
  startTime: Date.parse('2023-07-01T00:00:00.000Z'),
  endTime: Date.parse('2024-12-31T23:59:59.999Z'),
};
const validationPeriod = {
  startTime: Date.parse('2025-01-01T00:00:00.000Z'),
  endTime: Date.parse('2026-06-30T23:59:59.999Z'),
};
const ranked = rankFundingCarryCandidates(seriesBySymbol, candidates, developmentPeriod, {
  minimumCycles: 10,
  minimumProfitFactor: 1,
});
const percent = (value) => `${(value * 100).toFixed(2)}%`;

function display(label, result) {
  console.log(`\n${label}`);
  console.table({
    '成本后周期胜率': percent(result.metrics.cycleWinRate),
    '胜率95%下界': percent(result.metrics.cycleWinRateWilson95Lower),
    '完整持仓周期': result.metrics.cycleCount,
    '下一资金费率方向正确率': percent(result.metrics.fundingPredictionAccuracy),
    '资金结算预测数': result.metrics.fundingPredictionCount,
    '利润因子': Number.isFinite(result.metrics.profitFactor) ? result.metrics.profitFactor.toFixed(2) : '∞',
    '平均周期收益': percent(result.metrics.averageCycleReturn),
    '累计收益': percent(result.metrics.totalReturn),
    '年化收益': percent(result.metrics.annualizedReturn),
    '最大回撤': percent(result.metrics.maxDrawdown),
  });
}

console.log(`预注册参数：${candidates.length} 组`);
if (!ranked.length) {
  const diagnostic = candidates.map((settings) => runFundingCarryBacktest(seriesBySymbol, settings, developmentPeriod))
    .sort((left, right) => right.metrics.profitFactor - left.metrics.profitFactor)[0];
  display('开发区间最佳诊断结果', diagnostic);
  throw new Error('没有资金费率候选通过开发区间最低约束');
}

const selected = ranked[0];
const validation = runFundingCarryBacktest(seriesBySymbol, selected.settings, validationPeriod);
const release = evaluateFundingCarryRelease(validation.metrics);
console.log('只由开发区间选出的冻结参数：');
console.log(JSON.stringify(selected.settings, null, 2));
display('开发区间', selected);
display('冻结参数验证区间', validation);
console.table({
  '周期胜率达到80%': release.checks.cycleWinRate ? 'PASS' : 'FAIL',
  '资金方向正确率达到80%': release.checks.fundingPredictionAccuracy ? 'PASS' : 'FAIL',
  '利润因子达到1.2': release.checks.profitFactor ? 'PASS' : 'FAIL',
  '年化收益位于5%–10%': release.checks.minimumAnnualizedReturn && release.checks.maximumAnnualizedReturn ? 'PASS' : 'FAIL',
  '最大回撤不低于-15%': release.checks.maximumDrawdown ? 'PASS' : 'FAIL',
  '全部发布门槛': release.passed ? 'PASS' : 'FAIL',
});
if (!release.passed) console.log(`研究状态：未通过 ${release.failedChecks.join('、')}。`);
console.log(JSON.stringify({
  settings: selected.settings,
  development: selected.metrics,
  validation: validation.metrics,
  release,
}));
