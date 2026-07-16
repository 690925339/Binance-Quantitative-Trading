import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LONG_SHORT_RISK_PROFILES, runLongShortTrendBacktest } from '../src/long-short-trend.js';

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

const profiles = [
  { name: '基准档 1.00×', multiplier: 1 },
  { name: '平衡增强 1.25×', multiplier: 1.25 },
  { name: '收益增强 1.50×', multiplier: 1.5 },
  { name: '高收益 2.00×', multiplier: 2 },
];
const baseline = LONG_SHORT_RISK_PROFILES.baseline;
const percent = (value) => `${(value * 100).toFixed(2)}%`;
const results = profiles.map((profile) => {
  const result = runLongShortTrendBacktest(seriesBySymbol, {
    targetVolatility: baseline.targetVolatility * profile.multiplier,
    maxGrossExposure: baseline.maxGrossExposure * profile.multiplier,
    maxAssetExposure: baseline.maxAssetExposure * profile.multiplier,
  });
  return { ...profile, result };
});

console.table(Object.fromEntries(results.map(({ name, result }) => [name, {
  '2025收益': percent(result.metrics.annualReturns['2025']),
  '长期年化': percent(result.metrics.annualizedReturn),
  '年化波动': percent(result.metrics.annualizedVolatility),
  '最大回撤': percent(result.metrics.maxDrawdown),
  '夏普': result.metrics.sharpeRatio.toFixed(2),
  '平均总敞口': percent(result.metrics.averageGrossExposure),
  '最差滚动365日': percent(result.metrics.minimumRolling365DayReturn),
}])));
console.log(JSON.stringify(Object.fromEntries(results.map(({ name, multiplier, result }) => [name, {
  multiplier,
  metrics: result.metrics,
}]))));
