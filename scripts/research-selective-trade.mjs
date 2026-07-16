import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankSelectiveTradeCandidates } from '../src/selective-trade-backtest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const manifest = JSON.parse(await fs.readFile(path.join(marketDir, 'manifest.json'), 'utf8'));

async function loadDailySeries(dataset) {
  const text = await fs.readFile(path.join(marketDir, dataset.file), 'utf8');
  const [headerLine, ...rows] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const indices = Object.fromEntries(['open_time_utc', 'open', 'high', 'low', 'close']
    .map((key) => [key, headers.indexOf(key)]));
  const byDate = new Map();
  for (const row of rows) {
    const columns = row.split(',');
    const date = columns[indices.open_time_utc].slice(0, 10);
    const current = byDate.get(date);
    const open = Number(columns[indices.open]);
    const high = Number(columns[indices.high]);
    const low = Number(columns[indices.low]);
    const close = Number(columns[indices.close]);
    if (!current) byDate.set(date, { date, open, high, low, close });
    else {
      current.high = Math.max(current.high, high);
      current.low = Math.min(current.low, low);
      current.close = close;
    }
  }
  return [...byDate.values()];
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
for (const trendLookbackDays of [42, 84]) {
  for (const pullbackLookbackDays of [3, 5]) {
    for (const pullbackThresholdPercent of [0.01, 0.02]) {
      for (const takeProfitPercent of [0.015, 0.02]) {
        for (const stopLossPercent of [0.04, 0.05]) {
          candidates.push({
            trendLookbackDays,
            pullbackLookbackDays,
            pullbackThresholdPercent,
            takeProfitPercent,
            stopLossPercent,
          });
        }
      }
    }
  }
}
for (const trendLookbackDays of [42, 84]) {
  for (const pullbackThresholdPercent of [0.03, 0.04]) {
    for (const takeProfitPercent of [0.02, 0.025, 0.03]) {
      candidates.push({
        trendLookbackDays,
        pullbackLookbackDays: 5,
        pullbackThresholdPercent,
        takeProfitPercent,
        stopLossPercent: 0.05,
      });
    }
  }
}

const developmentPeriod = { startDate: '2023-07-01', endDate: '2024-12-31' };
const ranked = rankSelectiveTradeCandidates(seriesBySymbol, candidates, developmentPeriod, {
  minimumTrades: 20,
  minimumDirectionTrades: 3,
  minimumProfitFactor: 1,
  maximumDrawdown: -0.2,
});
if (!ranked.length) {
  const diagnosticPool = rankSelectiveTradeCandidates(seriesBySymbol, candidates, developmentPeriod, {
    minimumTrades: 1,
    minimumDirectionTrades: 0,
    minimumProfitFactor: 0,
    maximumDrawdown: -1,
  });
  const byWinRate = diagnosticPool.slice(0, 3).map((result) => ({
    settings: result.settings,
    metrics: result.metrics,
  }));
  const byProfitFactor = diagnosticPool.slice().sort((left, right) => (
    right.metrics.profitFactor - left.metrics.profitFactor
  )).slice(0, 3).map((result) => ({
    settings: result.settings,
    metrics: result.metrics,
  }));
  console.dir({ byWinRate, byProfitFactor }, { depth: null });
  console.log('研究状态：没有候选参数通过开发期最低约束，不得接入执行策略。');
  process.exit(0);
}
const selected = ranked[0];
const percent = (value) => `${(value * 100).toFixed(2)}%`;

console.log(`预注册候选参数：${candidates.length} 组`);
console.log('开发区间选出的冻结参数：');
console.log(JSON.stringify(selected.settings, null, 2));
console.table({
  '交易胜率': percent(selected.metrics.winRate),
  '胜率95%下界': percent(selected.metrics.winRateWilson95Lower),
  '交易数': selected.metrics.tradeCount,
  '做多/做空': `${selected.metrics.longTradeCount}/${selected.metrics.shortTradeCount}`,
  '利润因子': selected.metrics.profitFactor.toFixed(2),
  '单笔期望': percent(selected.metrics.expectancy),
  '年化收益': percent(selected.metrics.annualizedReturn),
  '最大回撤': percent(selected.metrics.maxDrawdown),
});
console.log(JSON.stringify({ settings: selected.settings, metrics: selected.metrics }));
