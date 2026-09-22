import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceBtcPaperState, initializeBtcPaperState, BTC_SINGLE_ASSET_PAPER_PROFILE } from '../src/btc-paper.js';
import { MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, addUtcDays, fetchPaperMarketData, latestCompletePaperCycleDate, initializePaperState, advancePaperState } from '../src/monthly-accuracy-paper.js';
import { BTC_GRADUAL_RISK_PROFILE, DIVERSIFIED_CAPPED_PROFILE, DIVERSIFIED_DRAWDOWN_PROFILE, DIVERSIFIED_SPREAD_RISK_PROFILE } from '../src/paper-optimization-profiles.js';
import { loadPaperResearchReplayMarket, replayPaperResearchProfile, paperResearchPeriodMetrics } from '../src/paper-research-replay.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drawdownReview = process.argv.includes('--drawdown-review');
const profiles = [MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, DIVERSIFIED_CAPPED_PROFILE,
  ...(drawdownReview ? [DIVERSIFIED_DRAWDOWN_PROFILE, DIVERSIFIED_SPREAD_RISK_PROFILE] : [BTC_SINGLE_ASSET_PAPER_PROFILE, BTC_GRADUAL_RISK_PROFILE])];
const market = await loadPaperResearchReplayMarket({ rootDir, profiles: profiles.slice(0, 2), developmentStartDate: '2023-01-01' });
const outputDir = path.join(rootDir, 'data/runtime/paper-research');
const tailArgument = process.argv.find(arg => arg.startsWith('--tail='))?.slice(7);
let tail;
if (process.argv.includes('--refresh-tail')) {
  const endDate = latestCompletePaperCycleDate(Date.now());
  const data = await fetchPaperMarketData({
    historyStartDate: market.signalEndDate, signalEndDate: addUtcDays(endDate, -1),
    markStartCycleDate: market.throughCycleDate, markEndCycleDate: endDate,
  });
  tail = { fetchedAt: new Date().toISOString(), endDate, data };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, `risk-market-tail-${endDate}.json`), `${JSON.stringify(tail)}\n`, 'utf8');
} else if (tailArgument) tail = JSON.parse(await fs.readFile(path.resolve(rootDir, tailArgument), 'utf8'));
if (tail) {
  for (const symbol of market.symbols) {
    const rows = new Map(market.seriesBySymbol[symbol].map(row => [row.date, row.close]));
    for (const row of tail.data.seriesBySymbol[symbol]) {
      if (rows.has(row.date) && Math.abs(rows.get(row.date) - row.close) > 1e-8) throw new Error(`${symbol} overlapping close differs`);
      rows.set(row.date, row.close);
    }
    market.seriesBySymbol[symbol] = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
  }
  for (const [date, prices] of Object.entries(tail.data.markPricesByCycleDate)) {
    for (const symbol of market.symbols) {
      const old = market.markPricesByCycleDate[date]?.[symbol];
      if (old !== undefined && Math.abs(old - prices[symbol]) > 1e-8) throw new Error(`${symbol} overlapping mark differs`);
    }
    market.markPricesByCycleDate[date] = prices;
  }
  const dailyDates = Object.fromEntries(market.symbols.map(s => [s, new Set(market.seriesBySymbol[s].map(r => r.date))]));
  for (let date = market.throughCycleDate; date <= tail.endDate; date = addUtcDays(date, 1)) {
    for (const symbol of market.symbols) {
      if (!dailyDates[symbol].has(addUtcDays(date, -1)) || !(market.markPricesByCycleDate[date]?.[symbol] > 0)) throw new Error(`${symbol} missing boundary ${date}`);
    }
  }
  market.throughCycleDate = tail.endDate;
  market.source.tail = { endDate: tail.endDate, fetchedAt: tail.fetchedAt,
    sha256: crypto.createHash('sha256').update(JSON.stringify(tail)).digest('hex') };
}
const periods = {
  development: { startDate: '2023-01-01', endDate: '2024-12-31' },
  validation: { startDate: '2025-01-01', endDate: '2026-06-30' },
  recent: { startDate: '2026-07-01', endDate: market.throughCycleDate },
  full: { startDate: '2023-01-01', endDate: market.throughCycleDate },
};
const results = [];
for (const profile of profiles) {
  for (const costMultiplier of [1, 2]) {
    const p = structuredClone(profile);
    for (const settings of [p, p.marketNeutral, p.trend].filter(Boolean)) {
      if (settings.tradingCostRate !== undefined) settings.tradingCostRate *= costMultiplier;
      if (settings.dailyCarryCostRate !== undefined) settings.dailyCarryCostRate *= costMultiplier;
      if (settings.allocationTradingCostRate !== undefined) settings.allocationTradingCostRate *= costMultiplier;
    }
    let state;
    if (p.symbol === 'BTCUSDT') {
      state = initializeBtcPaperState({ seriesBySymbol: market.seriesBySymbol,
        cycleDate: market.initializationCycleDate,
        markPrice: market.markPricesByCycleDate[market.initializationCycleDate].BTCUSDT,
        profile: p, now: Date.parse(`${market.initializationCycleDate}T01:00:00Z`), entryMode: 'historical_09_00_mark' });
      advanceBtcPaperState({ state, seriesBySymbol: market.seriesBySymbol,
        markPricesByCycleDate: market.markPricesByCycleDate,
        throughCycleDate: market.throughCycleDate, profile: p,
        now: Date.parse(`${market.throughCycleDate}T01:00:00Z`) });
    } else state = replayPaperResearchProfile({ profile: p, market });
    const metrics = Object.fromEntries(Object.entries(periods).map(([key, period]) => {
      const m = paperResearchPeriodMetrics(state, period);
      const daily = state.reports.filter(r => r.kind === 'daily' && r.cycleDate >= period.startDate && r.cycleDate <= period.endDate);
      return [key, { ...m, profitableDayRatio: daily.filter(r => r.dayPnl > 0).length / daily.length }];
    }));
    let cohort = null;
    if (drawdownReview && market.throughCycleDate >= '2026-09-07') {
      const pairedState = initializePaperState({ seriesBySymbol: market.seriesBySymbol,
        cycleDate: '2026-09-06', markPrices: market.markPricesByCycleDate['2026-09-06'],
        profile: p, now: Date.parse('2026-09-06T01:00:00Z') });
      advancePaperState({ state: pairedState, seriesBySymbol: market.seriesBySymbol,
        markPricesByCycleDate: market.markPricesByCycleDate, profile: p,
        throughCycleDate: market.throughCycleDate, now: Date.parse(`${market.throughCycleDate}T01:00:00Z`) });
      cohort = { ...paperResearchPeriodMetrics(pairedState, { startDate: '2026-09-07', endDate: market.throughCycleDate }),
        initializationReturn: pairedState.reports[0].dayReturn,
        daily: pairedState.reports.filter(r => r.kind === 'daily').map(r => ({
          date: r.cycleDate, pnl: r.dayPnl, nextDrawdownRisk: r.nextDrawdownRisk,
        })) };
    }
    results.push({ id: profile.id, costMultiplier, metrics, cohort });
    const compact = m => ({ annualizedReturn: m.annualizedReturn, totalReturn: m.totalReturn,
      maxDrawdown: m.maxDrawdown, positiveMonthRatio: m.positiveMonthRatio,
      profitableDayRatio: m.profitableDayRatio, p95AssetExposure: m.p95AssetExposure });
    console.log(JSON.stringify({ id: profile.id, costMultiplier, validation: compact(metrics.validation), recent: compact(metrics.recent), full: compact(metrics.full), cohort: cohort ? compact(cohort) : null }));
  }
}
const output = { generatedAt: new Date().toISOString(), source: market.source, periods,
  limitation: 'Historical news unavailable: all BTC variants use price signals only. Previously inspected periods are retrospective validation, not untouched holdout. No live ledger is altered.',
  decision: drawdownReview ? {
    automaticPromotion: false,
    status: 'shadow_only',
    selectedProfileId: DIVERSIFIED_SPREAD_RISK_PROFILE.id,
    comparisonControlId: DIVERSIFIED_SPREAD_RISK_PROFILE.comparisonControlId,
    rejectedProfileId: DIVERSIFIED_DRAWDOWN_PROFILE.id,
    reason: 'Prefer pre-trade spread-volatility sizing for forward testing. Realized-drawdown sizing impaired recovery. Historical targets do not establish future performance; paired forward ledgers remain separate from the main account.',
  } : {
    portfolio: 'Forward shadow only: lower drawdown, but 2x-cost validation misses 10% annualized and 80% positive months.',
    btc: 'Research only: reject gradual reduction because full-period drawdown and recent returns deteriorate.',
    automaticPromotion: false,
  },
  profiles, results };
const dir = path.join(rootDir, 'data/runtime/paper-research');
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(dir, drawdownReview ? `drawdown-optimization-${market.throughCycleDate}.json` : 'risk-optimization-latest.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
