import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceBtcPaperState, initializeBtcPaperState, BTC_SINGLE_ASSET_PAPER_PROFILE } from '../src/btc-paper.js';
import { addUtcDays, fetchPaperMarketData, latestCompletePaperCycleDate } from '../src/monthly-accuracy-paper.js';
import { loadPaperResearchReplayMarket, paperResearchPeriodMetrics } from '../src/paper-research-replay.js';
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = BTC_SINGLE_ASSET_PAPER_PROFILE;
const market = await loadPaperResearchReplayMarket({ rootDir, profiles: [base], symbols: ['BTCUSDT'] });
const outputDir = path.join(rootDir, 'data/runtime/paper-research');
const endDate = latestCompletePaperCycleDate(Date.now());
const tailFile = path.join(outputDir, `btc-market-tail-${endDate}.json`);
let tail;
try { tail = JSON.parse(await fs.readFile(tailFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  tail = await fetchPaperMarketData({ symbols: ['BTCUSDT'], historyStartDate: market.signalEndDate,
    signalEndDate: addUtcDays(endDate, -1), markStartCycleDate: market.throughCycleDate, markEndCycleDate: endDate });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(tailFile, JSON.stringify(tail), 'utf8');
}
const rows = new Map(market.seriesBySymbol.BTCUSDT.map(r => [r.date, r.close]));
for (const r of tail.seriesBySymbol.BTCUSDT) {
  if (rows.has(r.date) && Math.abs(rows.get(r.date) - r.close) > 1e-8) throw new Error(`signal overlap mismatch ${r.date}`);
  rows.set(r.date, r.close);
}
market.seriesBySymbol.BTCUSDT = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
for (const [date, prices] of Object.entries(tail.markPricesByCycleDate)) {
  const old = market.markPricesByCycleDate[date]?.BTCUSDT;
  if (old !== undefined && Math.abs(old - prices.BTCUSDT) > 1e-8) throw new Error(`mark overlap mismatch ${date}`);
  market.markPricesByCycleDate[date] = prices;
}
for (let date = market.throughCycleDate; date <= endDate; date = addUtcDays(date, 1)) {
  if (!rows.has(addUtcDays(date, -1)) || !(market.markPricesByCycleDate[date]?.BTCUSDT > 0)) throw new Error(`missing ${date}`);
}
const periods = { development: { startDate: '2023-01-01', endDate: '2024-12-31' },
  validation: { startDate: '2025-01-01', endDate: '2026-06-30' },
  recent: { startDate: '2026-07-01', endDate }, full: { startDate: '2023-01-01', endDate } };
const results = [];
for (const threshold of [0, 0.02]) for (const multiplier of [1, 2]) {
  const profile = structuredClone(base);
  profile.minimumWeightIncrease = threshold;
  profile.id += threshold ? '-min-add-2pct-research' : '-baseline';
  profile.tradingCostRate *= multiplier;
  profile.dailyCarryCostRate *= multiplier;
  const state = initializeBtcPaperState({ seriesBySymbol: market.seriesBySymbol,
    cycleDate: market.initializationCycleDate, markPrice: market.markPricesByCycleDate[market.initializationCycleDate].BTCUSDT,
    profile, entryMode: 'historical_09_00_mark' });
  advanceBtcPaperState({ state, seriesBySymbol: market.seriesBySymbol, markPricesByCycleDate: market.markPricesByCycleDate,
    throughCycleDate: endDate, profile });
  const metrics = Object.fromEntries(Object.entries(periods).map(([key, period]) => {
    const reports = state.reports.filter(r => r.kind === 'daily' && r.cycleDate >= period.startDate && r.cycleDate <= period.endDate);
    return [key, { ...paperResearchPeriodMetrics(state, period),
      profitableDays: reports.filter(r => r.dayPnl > 0).length, observations: reports.length,
      tradingCost: reports.reduce((n, r) => n + r.tradingCost, 0),
      deferredAdds: reports.filter(r => r.rebalance?.deferred).length }];
  }));
  results.push({ threshold, multiplier, metrics });
  console.log(JSON.stringify({ threshold, multiplier, metrics }));
}
const report = { generatedAt: new Date().toISOString(), endDate, periods, results,
  limitation: 'Retrospective comparison, not untouched out-of-sample. Historical BTC news unavailable. Fixed cost model, not realized fills. Does not alter any active ledger.' };
await fs.writeFile(path.join(outputDir, `btc-execution-${endDate}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
