import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLongShortTrendBacktest } from '../src/long-short-trend.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const manifest = JSON.parse(await fs.readFile(path.join(marketDir, 'manifest.json'), 'utf8'));

async function loadDailySeries(dataset) {
  const text = await fs.readFile(path.join(marketDir, dataset.file), 'utf8');
  const [headerLine, ...rows] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const dateIndex = headers.indexOf('open_time_utc');
  const closeIndex = headers.indexOf('close');
  if (dateIndex < 0 || closeIndex < 0) throw new Error(`${dataset.file} 缺少日期或收盘价字段`);
  const byDate = new Map();
  for (const row of rows) {
    const columns = row.split(',');
    const date = columns[dateIndex].slice(0, 10);
    byDate.set(date, Number(columns[closeIndex]));
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

const result = runLongShortTrendBacktest(seriesBySymbol);
const percent = (value) => `${(value * 100).toFixed(2)}%`;

console.log(`${result.strategy}（${result.symbols.join('、')}）`);
console.log(`区间：${result.metrics.startDate} 至 ${result.metrics.endDate}`);
console.table({
  '累计收益': percent(result.metrics.totalReturn),
  '年化收益': percent(result.metrics.annualizedReturn),
  '年化波动': percent(result.metrics.annualizedVolatility),
  '最大回撤': percent(result.metrics.maxDrawdown),
  '夏普比率': result.metrics.sharpeRatio.toFixed(2),
  '平均总敞口': percent(result.metrics.averageGrossExposure),
  '最差滚动365日': percent(result.metrics.minimumRolling365DayReturn),
});
console.table(Object.fromEntries(Object.entries(result.metrics.annualReturns).map(([year, value]) => [year, percent(value)])));
console.table({
  '整体年化位于 5%–10%': result.metrics.annualizedReturn >= 0.05 && result.metrics.annualizedReturn <= 0.10 ? 'PASS' : 'FAIL',
  '当前自然年度片段均为正': Object.values(result.metrics.annualReturns).every((value) => value > 0) ? 'PASS' : 'FAIL',
  '任意滚动 365 日均为正': result.metrics.minimumRolling365DayReturn >= 0 ? 'PASS' : 'FAIL',
});
console.log('成本假设：单边换仓 7 bps；持仓每日保守计提 0.5 bps 资金/基差成本。');
console.log(JSON.stringify(result.metrics));
