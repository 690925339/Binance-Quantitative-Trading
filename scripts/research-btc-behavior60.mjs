import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { btcBehaviorCandidates, createBtcBehaviorSignal } from '../src/btc-behavior-signals.js';
import { btcLearningCandidates, createBtcLearningSignal } from '../src/btc-behavior-learning.js';
import { replayBtcBehavior } from '../src/btc-behavior-replay.js';
import { BTC_DAILY_TARGET, dailyWinMetrics, evaluateDailyCandidate } from '../src/btc-daily-target.js';
import { addUtcDays, fetchPaperMarketData, latestCompletePaperCycleDate } from '../src/monthly-accuracy-paper.js';
import { loadPaperResearchReplayMarket, paperResearchPeriodMetrics } from '../src/paper-research-replay.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endDate = process.argv.find(arg => arg.startsWith('--through='))?.slice(10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate || '') || endDate < '2026-07-01'
  || !Number.isFinite(Date.parse(`${endDate}T00:00:00Z`))
  || new Date(`${endDate}T00:00:00Z`).toISOString().slice(0, 10) !== endDate
  || endDate > latestCompletePaperCycleDate(Date.now())) throw new Error('请指定已完成周期 --through=YYYY-MM-DD');
const outputDir = path.join(rootDir, 'data/runtime/paper-research');
const candidates = [...btcBehaviorCandidates(), ...btcLearningCandidates()]
  .map(c => ({ ...c, profile: { ...c.profile, id: `btc-behavior60-${c.id}`, name: c.name } }));
const periods = { development: { startDate: '2023-01-01', endDate: '2024-12-31' },
  validation: { startDate: '2025-01-01', endDate: '2026-06-30' },
  recent: { startDate: '2026-07-01', endDate }, full: { startDate: '2023-01-01', endDate } };
const protocol = { id: 'btc-behavior60-fixed-nine-v1', endDate, candidates, periods,
  costMultipliers: [1, 2], target: BTC_DAILY_TARGET,
  executionModel: 'btc-signed-quantity-post-fee-equity-v1',
  baselineId: 'T0', referenceOnly: ['L0'], commonWarmupIntervals: 180,
  selection: 'highest_development_calendar_net_win_rate_then_net_return_excluding_T0_L0',
  newsMode: 'none_historical_point_in_time_news_unavailable',
  learnedLabels: '09:00_to_next_09:00_direction_only_outcomes_ending_no_later_than_decision',
  allowAutomaticPromotion: false,
};
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
await fs.mkdir(outputDir, { recursive: true });
const protocolFile = path.join(outputDir, `btc-behavior60-protocol-${endDate}.json`);
try { await fs.writeFile(protocolFile, `${JSON.stringify(protocol, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (hash(JSON.parse(await fs.readFile(protocolFile, 'utf8'))) !== hash(protocol)) throw new Error('冻结协议不一致，禁止事后覆盖候选参数');
}
const liveLedgerFile = path.join(rootDir, 'data/runtime/btc-single-asset-paper.json');
const ledgerBefore = await fs.readFile(liveLedgerFile, 'utf8');
const market = await loadPaperResearchReplayMarket({ rootDir, symbols: ['BTCUSDT'],
  profiles: [{ id: 'common-180', trend: { lookbackDays: [180], volatilityWindowDays: 30 } }] });
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
  for (const row of tail.seriesBySymbol.BTCUSDT) {
    if (rows.has(row.date) && Math.abs(rows.get(row.date) - row.close) > 1e-8) throw new Error(`signal overlap mismatch ${row.date}`);
    rows.set(row.date, row.close);
  }
  market.seriesBySymbol.BTCUSDT = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
  for (const [date, prices] of Object.entries(tail.markPricesByCycleDate)) {
    const previous = market.markPricesByCycleDate[date]?.BTCUSDT;
    if (previous !== undefined && Math.abs(previous - prices.BTCUSDT) > 1e-8) throw new Error(`mark overlap mismatch ${date}`);
    market.markPricesByCycleDate[date] = prices;
  }
}
market.seriesBySymbol.BTCUSDT = market.seriesBySymbol.BTCUSDT.filter(r => r.date < endDate);
market.markPricesByCycleDate = Object.fromEntries(Object.entries(market.markPricesByCycleDate).filter(([date]) => date <= endDate));
market.throughCycleDate = endDate;
const results = [], states = new Map();
for (const candidate of candidates) for (const costMultiplier of protocol.costMultipliers) {
  const signalFn = candidate.profile.mode ? createBtcLearningSignal(candidate.profile, market) : createBtcBehaviorSignal(candidate.profile);
  const state = replayBtcBehavior({ market, profile: candidate.profile, signalFn, throughCycleDate: endDate, costMultiplier });
  const metrics = Object.fromEntries(Object.entries(periods).map(([key, period]) => {
    const reports = state.reports.filter(r => r.kind === 'daily' && r.cycleDate >= period.startDate && r.cycleDate <= period.endDate);
    const sideMetrics = side => {
      const subset = reports.filter(r => Math.sign(r.settledWeight) === side);
      const directional = subset.filter(r => r.assetReturn !== 0 && side !== 0);
      return { days: subset.length, profitableDays: subset.filter(r => r.dayPnl > 0).length,
        netPnl: subset.reduce((sum, r) => sum + r.dayPnl, 0),
        directionalDays: directional.length, directionalHits: directional.filter(r => r.pricePnl > 0).length,
        directionalHitRate: directional.length ? directional.filter(r => r.pricePnl > 0).length / directional.length : null,
        tradingCost: subset.reduce((sum, r) => sum + r.tradingCost, 0), carryCost: subset.reduce((sum, r) => sum + r.carryCost, 0),
        worstDay: subset.length ? Math.min(...subset.map(r => r.dayReturn)) : null };
    };
    const sides = { long: sideMetrics(1), short: sideMetrics(-1), flat: sideMetrics(0) };
    const directionalDays = sides.long.directionalDays + sides.short.directionalDays;
    return [key, { ...paperResearchPeriodMetrics(state, period), ...dailyWinMetrics(reports, period), sides,
      directionalHitRate: directionalDays ? (sides.long.directionalHits + sides.short.directionalHits) / directionalDays : null,
      decisionSideSwitches: reports.filter(r => r.settledWeight * r.nextWeight < 0).length,
      trainingWarmupDays: reports.filter(r => r.diagnostics?.reason === 'training_warmup').length,
      attribution: 'net PnL including today next-position costs grouped by the previously held side' }];
  }));
  const result = { id: candidate.id, name: candidate.name, costMultiplier, metrics,
    initializationDate: state.startCycleDate, initializationTradingCost: state.initializationTradingCost,
    fromInitializationReturnIncludingAllCosts: state.cumulativeReturn };
  results.push(result);
  if (costMultiplier === 1) states.set(candidate.id, state);
  console.log(JSON.stringify({ id: candidate.id, costMultiplier, developmentWin: metrics.development.profitableDayRatio,
    validationWin: metrics.validation.profitableDayRatio, validationAnnualized: metrics.validation.annualizedReturn,
    recentWin: metrics.recent.profitableDayRatio, longDays: metrics.validation.sides.long.days, shortDays: metrics.validation.sides.short.days }));
}
const baseline = results.find(r => r.id === 'T0' && r.costMultiplier === 1);
const stressBaseline = results.find(r => r.id === 'T0' && r.costMultiplier === 2);
const activeCandidates = results.filter(r => !['T0', 'L0'].includes(r.id) && r.costMultiplier === 1);
for (const candidate of activeCandidates) {
  const stressed = results.find(r => r.id === candidate.id && r.costMultiplier === 2);
  candidate.gates = Object.fromEntries(Object.keys(periods).map(key => [key,
    evaluateDailyCandidate(candidate.metrics[key], baseline.metrics[key], stressed.metrics[key], stressBaseline.metrics[key]) ]));
}
const nominee = [...activeCandidates].sort((a, b) => b.metrics.development.profitableDayRatio - a.metrics.development.profitableDayRatio
  || b.metrics.development.totalReturn - a.metrics.development.totalReturn || a.id.localeCompare(b.id))[0];
const eligible = activeCandidates.filter(r => Object.values(r.gates).every(g => g.eligibleForForward)
  && r.metrics.validation.sides.long.days >= 30 && r.metrics.validation.sides.short.days >= 30).map(r => r.id);
const selectedReports = states.get(nominee.id).reports;
const selectedStressedReports = replayBtcBehavior({ market, profile: candidates.find(c => c.id === nominee.id).profile,
  signalFn: candidates.find(c => c.id === nominee.id).profile.mode
    ? createBtcLearningSignal(candidates.find(c => c.id === nominee.id).profile, market)
    : createBtcBehaviorSignal(candidates.find(c => c.id === nominee.id).profile), throughCycleDate: endDate, costMultiplier: 2 }).reports;
const yearly = Object.fromEntries(['2023', '2024', '2025', '2026'].map(year => {
  const period = { startDate: `${year}-01-01`, endDate: year === endDate.slice(0, 4) ? endDate : `${year}-12-31` };
  return [year, { partialYear: year === endDate.slice(0, 4),
    standard: { ...paperResearchPeriodMetrics({ reports: selectedReports }, period), ...dailyWinMetrics(selectedReports, period) },
    doubled: { ...paperResearchPeriodMetrics({ reports: selectedStressedReports }, period), ...dailyWinMetrics(selectedStressedReports, period) } }];
}));
const ledgerAfter = await fs.readFile(liveLedgerFile, 'utf8');
if (ledgerAfter !== ledgerBefore) throw new Error('活跃账本在研究期间发生变化，请核对后重跑');
const sourceFiles = ['src/btc-behavior-replay.js', 'src/btc-behavior-signals.js', 'src/btc-behavior-learning.js',
  'src/btc-daily-target.js', 'src/paper-research-replay.js', 'scripts/research-btc-behavior60.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await fs.readFile(path.join(rootDir, file), 'utf8'))])));
const report = { generatedAt: new Date().toISOString(), endDate, protocolFile, protocolHash: hash(protocol),
  marketHash: hash({ series: market.seriesBySymbol, marks: market.markPricesByCycleDate }), sourceHashes,
  activeLedgerHash: hash(ledgerAfter), activeLedgerUnchanged: true, nominatedByDevelopment: nominee.id,
  eligibleCandidates: eligible, decision: 'research_only_no_active_strategy_migration', results, nomineeYearly: yearly,
  limitations: [
    '全部完整日历日计入分母，空仓不算盈利；模型训练预热也不从评估区间剔除。',
    '所有方案使用同一数量持仓执行器和当前已知行情；旧模拟盘收益不与新执行器结果直接混作参数提升证据。',
    '2023-2024只做开发提名，2025之后仍是已观察的回溯诊断，不是未接触的样本外。',
    '两个滚动模型只训练结果已到期样本；输出概率未做独立校准，不是可信度或未来盈利保证。',
    '滚动模型可读取当日09:00刚完成的标签且按同一边界价成交，隐含零计算/传输延迟，不构成真实可成交性证明。',
    '现货价格负持仓仅为合成做空；固定持仓成本不是借币利息或永续资金费，也未模拟标记价强平。',
    '采用09:00边界价，无法证明盘中止损/止盈和盘口滑点；此轮没有加入不满足因果时间的新闻。',
    '九方案是固定有限探索，存在多重比较偏差；任何60%点估计仍需独立前向样本验证。',
  ] };
const reportFile = path.join(outputDir, `btc-behavior60-${endDate}.json`);
await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(outputDir, `btc-behavior60-${endDate}-${nominee.id}-research-daily.json`), `${JSON.stringify(selectedReports, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ reportFile, nominatedByDevelopment: nominee.id, eligible, activeLedgerUnchanged: true }));
