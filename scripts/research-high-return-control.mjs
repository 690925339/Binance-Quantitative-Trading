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

const baseline = LONG_SHORT_RISK_PROFILES.baseline;
const multiplierValues = [2, 2.1, 2.2, 2.3, 2.4];
const startValues = [0.08, 0.10, 0.12, 0.15];
const fullValues = [0.16, 0.20, 0.25, 0.30];
const floorValues = [0.25, 0.50, 0.75];
const candidates = [];

for (const multiplier of multiplierValues) {
  for (const drawdownControlStart of startValues) {
    for (const drawdownControlFull of fullValues) {
      if (drawdownControlFull <= drawdownControlStart) continue;
      for (const minimumRiskScale of floorValues) {
        const result = runLongShortTrendBacktest(seriesBySymbol, {
          targetVolatility: baseline.targetVolatility * multiplier,
          maxGrossExposure: baseline.maxGrossExposure * multiplier,
          maxAssetExposure: baseline.maxAssetExposure * multiplier,
          drawdownControlStart,
          drawdownControlFull,
          minimumRiskScale,
        });
        candidates.push({
          multiplier,
          drawdownControlStart,
          drawdownControlFull,
          minimumRiskScale,
          metrics: result.metrics,
        });
      }
    }
  }
}

const uncontrolled = runLongShortTrendBacktest(seriesBySymbol, {
  targetVolatility: baseline.targetVolatility * 2,
  maxGrossExposure: baseline.maxGrossExposure * 2,
  maxAssetExposure: baseline.maxAssetExposure * 2,
});
const eligible = candidates
  .filter((candidate) => candidate.metrics.annualizedReturn >= 0.10)
  .sort((left, right) => right.metrics.maxDrawdown - left.metrics.maxDrawdown
    || right.metrics.minimumRolling365DayReturn - left.metrics.minimumRolling365DayReturn
    || right.metrics.annualizedReturn - left.metrics.annualizedReturn);
const percent = (value) => `${(value * 100).toFixed(2)}%`;
const rows = [
  { name: '2.00× 无回撤控制', multiplier: 2, start: '-', full: '-', floor: '-', metrics: uncontrolled.metrics },
  ...eligible.slice(0, 15).map((candidate, index) => ({
    name: `候选 ${index + 1}`,
    multiplier: candidate.multiplier,
    start: percent(candidate.drawdownControlStart),
    full: percent(candidate.drawdownControlFull),
    floor: percent(candidate.minimumRiskScale),
    metrics: candidate.metrics,
  })),
];

console.table(Object.fromEntries(rows.map((row) => [row.name, {
  '风险倍数': row.multiplier,
  '开始减仓': row.start,
  '完全减仓': row.full,
  '最低风险': row.floor,
  '长期年化': percent(row.metrics.annualizedReturn),
  '2025收益': percent(row.metrics.annualReturns['2025']),
  '最大回撤': percent(row.metrics.maxDrawdown),
  '最差滚动365日': percent(row.metrics.minimumRolling365DayReturn),
  '减仓天数': row.metrics.deleveragedDays,
}])));
console.log(JSON.stringify({
  testedCandidates: candidates.length,
  eligibleCandidates: eligible.length,
  uncontrolled: uncontrolled.metrics,
  bestByDrawdown: eligible[0] || null,
}));
