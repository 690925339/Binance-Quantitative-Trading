import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeBtcPaperState, advanceBtcPaperState } from '../src/btc-paper.js';
import { btcDailyCandidates, btcCostProfile } from '../src/btc-daily-candidates.js';
import { BTC_DAILY_TARGET, buildBtcDailyTarget, dailyWinMetrics, evaluateDailyCandidate } from '../src/btc-daily-target.js';
import { addUtcDays, fetchPaperMarketData, latestCompletePaperCycleDate } from '../src/monthly-accuracy-paper.js';
import { loadPaperResearchReplayMarket, paperResearchPeriodMetrics } from '../src/paper-research-replay.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endDate = process.argv.find(arg => arg.startsWith('--through='))?.slice(10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate || '') || endDate < '2026-07-01'
  || new Date(`${endDate}T00:00:00Z`).toISOString().slice(0, 10) !== endDate
  || endDate > latestCompletePaperCycleDate(Date.now())) {
  throw new Error('请使用 --through=YYYY-MM-DD 指定已完成的截止周期（不早于2026-07-01）');
}
const outputDir = path.join(rootDir, 'data/runtime/paper-research');
const candidates = btcDailyCandidates();
const periods = {
  development: { startDate: '2023-01-01', endDate: '2024-12-31' },
  validation: { startDate: '2025-01-01', endDate: '2026-06-30' },
  recent: { startDate: '2026-07-01', endDate },
  full: { startDate: '2023-01-01', endDate },
};
const protocol = {
  id: 'btc-daily60-fixed-eight-v1', target: BTC_DAILY_TARGET, endDate, periods,
  candidates, costMultipliers: [1, 2],
  selection: 'development_only_max_profitable_day_ratio_then_total_return_among_nonbaseline',
  commonWarmupDays: 180, newsMode: 'price_only_no_historical_news',
  allowAutomaticPromotion: false,
};
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
await fs.mkdir(outputDir, { recursive: true });
const protocolFile = path.join(outputDir, `btc-daily60-protocol-${endDate}.json`);
try {
  // Persist the fixed search space before looking at any candidate result.
  await fs.writeFile(protocolFile, `${JSON.stringify(protocol, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (hash(JSON.parse(await fs.readFile(protocolFile, 'utf8'))) !== hash(protocol)) {
    throw new Error('已冻结实验协议不一致；禁止覆盖或事后扩大候选范围');
  }
}
const ledgerFile = path.join(rootDir, 'data/runtime/btc-single-asset-paper.json');
const ledgerBefore = hash(await fs.readFile(ledgerFile, 'utf8'));
const liveState = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
const market = await loadPaperResearchReplayMarket({ rootDir, profiles: candidates.map(c => c.profile), symbols: ['BTCUSDT'] });
if (endDate > market.throughCycleDate) {
  const tailFile = path.join(outputDir, `btc-market-tail-${endDate}.json`);
  let tail;
  try { tail = JSON.parse(await fs.readFile(tailFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    tail = await fetchPaperMarketData({ symbols: ['BTCUSDT'], historyStartDate: market.signalEndDate,
      signalEndDate: addUtcDays(endDate, -1), markStartCycleDate: market.throughCycleDate, markEndCycleDate: endDate });
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
}
for (let date = market.initializationCycleDate; date <= endDate; date = addUtcDays(date, 1)) {
  if (!market.seriesBySymbol.BTCUSDT.some(r => r.date === addUtcDays(date, -1))
    || !(market.markPricesByCycleDate[date]?.BTCUSDT > 0)) throw new Error(`missing ${date}`);
}
// Slice future rows even though the engine accesses signalIndex only.
market.seriesBySymbol.BTCUSDT = market.seriesBySymbol.BTCUSDT.filter(r => r.date < endDate);
market.markPricesByCycleDate = Object.fromEntries(Object.entries(market.markPricesByCycleDate).filter(([date]) => date <= endDate));
const marketHash = hash({ series: market.seriesBySymbol, marks: market.markPricesByCycleDate });
const results = [];
const reportsById = new Map();
for (const candidate of candidates) {
  for (const multiplier of protocol.costMultipliers) {
    const profile = btcCostProfile(candidate.profile, multiplier);
    const state = initializeBtcPaperState({ seriesBySymbol: market.seriesBySymbol,
      cycleDate: market.initializationCycleDate,
      markPrice: market.markPricesByCycleDate[market.initializationCycleDate].BTCUSDT,
      profile, now: Date.parse(`${market.initializationCycleDate}T01:00:00Z`), entryMode: 'historical_09_00_mark' });
    advanceBtcPaperState({ state, seriesBySymbol: market.seriesBySymbol, markPricesByCycleDate: market.markPricesByCycleDate,
      throughCycleDate: endDate, profile, now: Date.parse(`${endDate}T01:00:00Z`) });
    const metrics = Object.fromEntries(Object.entries(periods).map(([key, period]) => [key, {
      ...paperResearchPeriodMetrics(state, period), ...dailyWinMetrics(state.reports, period),
    }]));
    results.push({ id: candidate.id, name: candidate.name, multiplier, metrics });
    if (multiplier === 1) reportsById.set(candidate.id, state.reports.filter(r => r.kind === 'daily'));
    console.log(JSON.stringify({ id: candidate.id, multiplier, developmentWins: metrics.development.profitableDayRatio,
      validationWins: metrics.validation.profitableDayRatio, validationAnnualized: metrics.validation.annualizedReturn,
      recentWins: metrics.recent.profitableDayRatio, fullWins: metrics.full.profitableDayRatio }));
  }
}
const baseline = results.find(r => r.id === 'B0' && r.multiplier === 1);
const baselineStress = results.find(r => r.id === 'B0' && r.multiplier === 2);
for (const result of results.filter(r => r.multiplier === 1)) {
  const stress = results.find(r => r.id === result.id && r.multiplier === 2);
  result.gates = Object.fromEntries(Object.keys(periods).map(key => [key,
    evaluateDailyCandidate(result.metrics[key], baseline.metrics[key], stress.metrics[key], baselineStress.metrics[key]) ]));
}
// A diagnostic nominee, not an automatic winner: selection never consults validation/recent.
const nominated = results.filter(r => r.id !== 'B0' && r.multiplier === 1 && r.metrics.development.dataComplete)
  .sort((a, b) => b.metrics.development.profitableDayRatio - a.metrics.development.profitableDayRatio
    || b.metrics.development.totalReturn - a.metrics.development.totalReturn || a.id.localeCompare(b.id))[0];

function pairedBlockIntervals(candidate, baselineReports, period, blockLength, seed = 426040) {
  const rows = candidate.filter(r => r.cycleDate >= period.startDate && r.cycleDate <= period.endDate);
  const other = baselineReports.filter(r => r.cycleDate >= period.startDate && r.cycleDate <= period.endDate);
  if (rows.length !== other.length || rows.some((r, i) => r.cycleDate !== other[i].cycleDate)) throw new Error('bootstrap dates mismatch');
  const n = rows.length, winRatios = [], excessRatios = [];
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let sample = 0; sample < 1000; sample++) {
    let wins = 0, baselineWins = 0, count = 0;
    while (count < n) {
      const start = Math.floor(random() * n);
      for (let offset = 0; offset < blockLength && count < n; offset++, count++) {
        const index = (start + offset) % n;
        wins += Number(rows[index].dayPnl > 0);
        baselineWins += Number(other[index].dayPnl > 0);
      }
    }
    winRatios.push(wins / n); excessRatios.push((wins - baselineWins) / n);
  }
  const interval = values => { values.sort((a, b) => a - b); return { lower: values[24], upper: values[974] }; };
  return { blockLength, resamples: 1000, profitableDayRatio95: interval(winRatios), excessOverBaseline95: interval(excessRatios),
    limitation: 'Diagnostic circular block bootstrap; not selection-adjusted or proof of an unseen future regime.' };
}
const diagnostics = nominated ? Object.fromEntries(['validation', 'recent'].map(key => [key,
  [7, 14].map(length => pairedBlockIntervals(reportsById.get(nominated.id), reportsById.get('B0'), periods[key], length))])) : null;
const qualified = results.filter(r => r.id !== 'B0' && r.multiplier === 1
  && Object.values(r.gates).every(g => g.eligibleForForward)).map(r => r.id);
const ledgerAfter = hash(await fs.readFile(ledgerFile, 'utf8'));
if (ledgerBefore !== ledgerAfter) throw new Error('研究期间真实模拟盘发生变更，请检查外部日结并重新核对');
const liveDaily = liveState.reports.filter(r => r.kind === 'daily');
const largestProfitDays = [...liveDaily].sort((a, b) => b.dayPnl - a.dayPnl).slice(0, 3)
  .map(r => ({ cycleDate: r.cycleDate, dayPnl: r.dayPnl }));
const actualPaperReview = { ...buildBtcDailyTarget(liveState),
  equity: liveState.equity, initialCapital: liveState.initialCapital,
  totalPnl: liveState.equity - liveState.initialCapital, maxDrawdown: liveState.maxDrawdown,
  priceLossDays: liveDaily.filter(r => r.dayPnl < 0 && r.pricePnl < 0).length,
  costOnlyLossDays: liveDaily.filter(r => r.dayPnl < 0 && r.pricePnl >= 0).length,
  profitableDaysWithoutCosts: liveDaily.filter(r => r.pricePnl > 0).length,
  eligibleNewsDecisions: liveDaily.filter(r => r.newsRisk?.eligible).length,
  largestProfitDays, largestThreeTotalPnl: largestProfitDays.reduce((sum, r) => sum + r.dayPnl, 0),
  otherDaysPnl: liveDaily.reduce((sum, r) => sum + r.dayPnl, 0) - largestProfitDays.reduce((sum, r) => sum + r.dayPnl, 0),
};
const sourceHashes = Object.fromEntries(await Promise.all([
  'src/btc-paper.js', 'src/long-short-trend.js', 'src/btc-daily-candidates.js',
  'src/btc-daily-target.js', 'src/paper-research-replay.js', 'scripts/research-btc-daily60.mjs',
].map(async file => [file, hash(await fs.readFile(path.join(rootDir, file), 'utf8'))])));
const report = { generatedAt: new Date().toISOString(), endDate, protocolHash: hash(protocol), protocolFile,
  marketHash, sourceHashes, nodeVersion: process.version, actualPaperReview,
  activeLedgerUnchanged: true, activeLedgerHash: ledgerAfter, nominatedByDevelopment: nominated?.id || null,
  qualifiedCandidates: qualified,
  decision: 'research_only_no_live_profile_change', results, diagnostics,
  limitations: [
    '2023-2024仅用于候选提名；2025-2026及近期为已观察历史诊断，不是未接触的样本外验证。',
    '历史缺少逐时点新闻，因此研究仅比较价格信号；关闭新闻缺失保护，不能当作v2完整策略回测。',
    '当前新闻采集允许09:00-09:15，若未来有合格事件触发，必须先保证信息可用时刻不晚于实际模拟成交时刻。',
    '成交按09:00边界K线与固定成本模拟，不含真实滑点、资金费率、盘口和爆仓路径。',
    '既有换手模型使用目标权重减前一目标权重，未计涨跌后的持仓权重漂移；2倍成本压力不是完整真实执行成本验证。',
    '8个固定方案仍有多重比较偏差；bootstrap仅为诊断，不构成60%盈利日或10%年化承诺。',
    '任何新版本必须独立前向积累至少90个完整日和3个完整月，再人工复核，不自动迁移或加杠杆。',
  ] };
const reportFile = path.join(outputDir, `btc-daily60-${endDate}.json`);
await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ reportFile, nominatedByDevelopment: report.nominatedByDevelopment, qualifiedCandidates: qualified,
  activeLedgerUnchanged: true, decision: report.decision }));
