import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateHighConfidenceRelease,
  rankHighConfidenceCandidates,
  runHighConfidenceBacktest,
} from '../src/high-confidence-walk-forward.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const manifest = JSON.parse(await fs.readFile(path.join(marketDir, 'manifest.json'), 'utf8'));

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

const candidates = [];
const lookbackSets = [[7, 21, 63], [14, 42, 84], [21, 63, 126], [30, 90, 180]];
for (const lookbackDays of lookbackSets) {
  for (const predictionHorizonDays of [7, 14, 21, 28]) {
    for (const minimumConfidence of [0.15, 0.25, 0.35, 0.45, 0.55, 0.65]) {
      for (const marketWeight of [0, 0.25, 0.5]) {
        for (const requireMarketConfirmation of [false, true]) {
          for (const maxSelectedAssets of [1, 2, 3]) {
            candidates.push({
              lookbackDays,
              predictionHorizonDays,
              decisionIntervalDays: predictionHorizonDays,
              minimumConfidence,
              marketWeight,
              requireMarketConfirmation,
              maxSelectedAssets,
            });
          }
        }
      }
    }
  }
}

const developmentPeriod = { startDate: '2023-07-01', endDate: '2024-12-31' };
const holdoutPeriod = { startDate: '2025-01-01', endDate: '2026-06-30' };
const constraints = {
  minimumActiveDecisions: 20,
  minimumDirectionForecasts: 8,
  minimumCoverage: 0.2,
  minimumAnnualizedReturn: 0.05,
  maximumDrawdown: -0.2,
};
const ranked = rankHighConfidenceCandidates(seriesBySymbol, candidates, developmentPeriod, constraints);
if (!ranked.length) throw new Error('没有候选参数通过最低样本约束');
const selected = ranked[0];
const holdout = runHighConfidenceBacktest(seriesBySymbol, selected.settings, holdoutPeriod);
const releaseGate = evaluateHighConfidenceRelease(holdout.metrics);
const percent = (value) => `${(value * 100).toFixed(2)}%`;

function displayResult(label, result) {
  console.log(`\n${label}：${result.period.startDate} 至 ${result.period.endDate}`);
  console.table({
    '组合方向命中率': percent(result.metrics.portfolioAccuracy),
    '命中率95%下界': percent(result.metrics.portfolioAccuracyWilson95Lower),
    '单币方向命中率': percent(result.metrics.assetAccuracy),
    '有效决策数': result.metrics.activeDecisionCount,
    '信号覆盖率': percent(result.metrics.signalCoverage),
    '做多预测数': result.metrics.longForecastCount,
    '做空预测数': result.metrics.shortForecastCount,
    '区间收益': percent(result.metrics.totalReturn),
    '年化收益': percent(result.metrics.annualizedReturn),
    '最大回撤': percent(result.metrics.maxDrawdown),
  });
}

console.log(`候选参数数：${candidates.length}`);
console.log('固定参数（只由开发区间选择）：');
console.log(JSON.stringify(selected.settings, null, 2));
displayResult('开发区间', selected);
displayResult('冻结参数后的样本外区间', holdout);
console.table({
  '样本外组合命中率达到80%': holdout.metrics.portfolioAccuracy >= 0.8 ? 'PASS' : 'FAIL',
  '样本外单币命中率达到80%': holdout.metrics.assetAccuracy >= 0.8 ? 'PASS' : 'FAIL',
  '样本外至少12个有效决策': holdout.metrics.activeDecisionCount >= 12 ? 'PASS' : 'FAIL',
  '样本外多空预测均不少于3个': Math.min(holdout.metrics.longForecastCount, holdout.metrics.shortForecastCount) >= 3 ? 'PASS' : 'FAIL',
  '样本外收益为正': holdout.metrics.totalReturn > 0 ? 'PASS' : 'FAIL',
  '全部发布门槛': releaseGate.passed ? 'PASS' : 'FAIL',
});
if (!releaseGate.passed) {
  console.log(`研究状态：未通过 ${releaseGate.failedChecks.join('、')}，不得晋级自动执行。`);
}
console.log(JSON.stringify({ development: selected.metrics, holdout: holdout.metrics, releaseGate }));
