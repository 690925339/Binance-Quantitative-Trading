import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BTC_SINGLE_ASSET_PAPER_PROFILE } from '../src/btc-paper.js';
import { btcOpenSourceCandidates, createBtcOpenSourceDirection } from '../src/btc-open-source-signals.js';
import { createBtcOriginalRiskSignal } from '../src/btc-original-risk.js';
import { loadBtcOpenSourceMarket } from '../src/btc-open-source-market.js';
import { replayBtcBehavior } from '../src/btc-behavior-replay.js';
import { selectBtcResearchCandidate } from '../src/btc-research-selection.js';
import { BTC_DAILY_TARGET, dailyWinMetrics, evaluateDailyCandidate } from '../src/btc-daily-target.js';
import { latestCompletePaperCycleDate } from '../src/monthly-accuracy-paper.js';
import { paperResearchPeriodMetrics } from '../src/paper-research-replay.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endDate = process.argv.find(arg => arg.startsWith('--through='))?.slice(10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate || '') || endDate < '2026-07-01'
  || !Number.isFinite(Date.parse(`${endDate}T00:00:00Z`))
  || new Date(`${endDate}T00:00:00Z`).toISOString().slice(0, 10) !== endDate
  || endDate > latestCompletePaperCycleDate(Date.now())) throw new Error('请指定已完成周期 --through=YYYY-MM-DD');
const outputDir = path.join(rootDir, 'data/runtime/paper-research');
const candidates = btcOpenSourceCandidates();
const riskProfile = structuredClone(BTC_SINGLE_ASSET_PAPER_PROFILE);
const periods = {
  development: { startDate: '2023-01-01', endDate: '2024-12-31' },
  validation: { startDate: '2025-01-01', endDate: '2026-06-30' },
  recent: { startDate: '2026-07-01', endDate }, full: { startDate: '2023-01-01', endDate },
};
const protocol = {
  id: 'btc-open-source-daily60-fixed-five-v1', endDate, candidates, riskProfile, periods,
  costMultipliers: [1, 2], target: BTC_DAILY_TARGET, baselineId: 'B0',
  executionModel: 'btc-signed-quantity-post-fee-equity-v1', commonWarmupIntervals: 180,
  signalTime: 'completed UTC previous-day OHLC', executionTime: 'next Beijing 09:00 hourly close proxy',
  adaptation: 'daily adaptation of hourly SMA/ADX concepts; not an upstream strategy reproduction',
  riskPolicy: 'original absolute trend allocation budget, monthly loss lock and profit de-risk preserved; candidate replaces direction only',
  selection: 'development only; baseline retained in ranking; no nomination unless all development gates pass',
  finalGate: 'nominated development candidate also passes validation, recent and full gates, with >=30 long and >=30 short validation days',
  lookaheadCutoffs: ['2024-12-31', '2026-06-30'],
  newsMode: 'price_only_no_point_in_time_historical_news', allowAutomaticPromotion: false,
};
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
await fs.mkdir(outputDir, { recursive: true });
const protocolFile = path.join(outputDir, `btc-open-source60-protocol-${endDate}.json`);
try { await fs.writeFile(protocolFile, `${JSON.stringify(protocol, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (hash(JSON.parse(await fs.readFile(protocolFile, 'utf8'))) !== hash(protocol)) throw new Error('冻结协议不一致，禁止事后覆盖候选参数');
}
const ledgerFile = path.join(rootDir, 'data/runtime/btc-single-asset-paper.json');
const ledgerBefore = await fs.readFile(ledgerFile, 'utf8');
console.log('Protocol frozen; loading and cross-checking actual BTC OHLC and 09:00 marks.');
const { market, dailyBars, provenance } = await loadBtcOpenSourceMarket({ rootDir, outputDir, endDate, profile: riskProfile });

function run(candidate, costMultiplier, throughCycleDate = endDate, bars = dailyBars) {
  return replayBtcBehavior({ market, profile: { id: `btc-open-source60-${candidate.id}`,
    maxGrossExposure: riskProfile.trend.maxGrossExposure,
    tradingCostRate: riskProfile.tradingCostRate, dailyCarryCostRate: riskProfile.dailyCarryCostRate },
  signalFn: createBtcOriginalRiskSignal({ profile: riskProfile,
    directionSignal: createBtcOpenSourceDirection(candidate.profile, bars) }),
  throughCycleDate, costMultiplier });
}

function metricsFor(state, period) {
  const reports = state.reports.filter(row => row.kind === 'daily' && row.cycleDate >= period.startDate && row.cycleDate <= period.endDate);
  const sides = Object.fromEntries([['long', 1], ['short', -1], ['flat', 0]].map(([name, side]) => {
    const rows = reports.filter(row => Math.sign(row.settledWeight) === side);
    const directional = rows.filter(row => side !== 0 && row.assetReturn !== 0);
    return [name, { days: rows.length, profitableDays: rows.filter(row => row.dayPnl > 0).length,
      netPnl: rows.reduce((sum, row) => sum + row.dayPnl, 0), directionalDays: directional.length,
      directionalHits: directional.filter(row => row.pricePnl > 0).length,
      directionalHitRate: directional.length ? directional.filter(row => row.pricePnl > 0).length / directional.length : null }];
  }));
  const reasons = Object.create(null);
  for (const row of reports) {
    const reason = row.diagnostics?.signal?.details?.reason || 'unknown';
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return { ...paperResearchPeriodMetrics(state, period), ...dailyWinMetrics(reports, period), sides, signalReasons: reasons,
    monthlyLossLockedDecisions: reports.filter(row => row.diagnostics?.originalRisk?.lockReason === 'loss').length,
    zeroOriginalBudgetDecisions: reports.filter(row => row.diagnostics?.originalRisk?.rawWeight === 0).length,
    tradingCost: reports.reduce((sum, row) => sum + row.tradingCost, 0),
    carryCost: reports.reduce((sum, row) => sum + row.carryCost, 0),
    attribution: 'net PnL including next-position costs grouped by previously settled side' };
}

const results = [], states = new Map();
for (const candidate of candidates) for (const costMultiplier of protocol.costMultipliers) {
  const state = run(candidate, costMultiplier);
  states.set(`${candidate.id}:${costMultiplier}`, state);
  const metrics = Object.fromEntries(Object.entries(periods).map(([key, period]) => [key, metricsFor(state, period)]));
  if (Object.values(metrics).some(value => !value.dataComplete)) throw new Error('Incomplete calendar evaluation, refusing report');
  results.push({ id: candidate.id, name: candidate.name, costMultiplier, metrics,
    initializationDate: state.startCycleDate, initializationTradingCost: state.initializationTradingCost,
    fromInitializationReturnIncludingAllCosts: state.cumulativeReturn });
  console.log(JSON.stringify({ id: candidate.id, costMultiplier,
    developmentWin: metrics.development.profitableDayRatio, validationWin: metrics.validation.profitableDayRatio,
    validationAnnualized: metrics.validation.annualizedReturn, recentWin: metrics.recent.profitableDayRatio,
    fullWin: metrics.full.profitableDayRatio, fullAnnualized: metrics.full.annualizedReturn }));
}
const selection = selectBtcResearchCandidate(results);
const resultFor = (id, cost) => results.find(row => row.id === id && row.costMultiplier === cost);
for (const candidate of results.filter(row => row.costMultiplier === 1)) {
  candidate.gates = Object.fromEntries(Object.keys(periods).map(key => [key,
    evaluateDailyCandidate(candidate.metrics[key], resultFor('B0', 1).metrics[key],
      resultFor(candidate.id, 2).metrics[key], resultFor('B0', 2).metrics[key]) ]));
}
const nominatedId = selection.nominatedCandidate?.id ?? null;
const nominated = nominatedId ? resultFor(nominatedId, 1) : null;
const eligibleCandidates = nominated && Object.values(nominated.gates).every(gate => gate.eligibleForForward)
  && nominated.metrics.validation.sides.long.days >= 30 && nominated.metrics.validation.sides.short.days >= 30 ? [nominatedId] : [];

// Compare complete executed histories, not only an indicator's final value.
// This tests triggered paths at two cutoffs; it is not proof of all possible paths.
const prefixChecks = [];
for (const candidate of candidates) for (const cutoff of protocol.lookaheadCutoffs) {
  const fullPrefix = states.get(`${candidate.id}:1`).reports.filter(row => row.cycleDate <= cutoff);
  const truncated = run(candidate, 1, cutoff, dailyBars.filter(row => row.date < cutoff)).reports;
  const passed = hash(fullPrefix) === hash(truncated);
  prefixChecks.push({ id: candidate.id, cutoff, days: truncated.length, passed });
  if (!passed) throw new Error(`Historical prefix changed: ${candidate.id} ${cutoff}`);
}
const yearly = Object.fromEntries(candidates.map(candidate => [candidate.id,
  Object.fromEntries(['2023', '2024', '2025', '2026'].map(year => {
    const period = { startDate: `${year}-01-01`, endDate: year === endDate.slice(0, 4) ? endDate : `${year}-12-31` };
    return [year, { partialYear: year === endDate.slice(0, 4),
      standard: metricsFor(states.get(`${candidate.id}:1`), period),
      doubled: metricsFor(states.get(`${candidate.id}:2`), period) }];
  })) ]));
const ledgerAfter = await fs.readFile(ledgerFile, 'utf8');
if (ledgerAfter !== ledgerBefore) throw new Error('活跃账本在研究期间发生变化，请核对后重跑');
const sourceFiles = ['src/btc-paper.js', 'src/long-short-trend.js', 'src/btc-behavior-replay.js', 'src/btc-original-risk.js',
  'src/btc-open-source-signals.js', 'src/btc-open-source-market.js', 'src/btc-research-selection.js', 'src/btc-daily-target.js',
  'src/paper-research-replay.js', 'scripts/research-btc-open-source60.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await fs.readFile(path.join(rootDir, file), 'utf8'))])));
const report = { generatedAt: new Date().toISOString(), endDate, protocolFile, protocolHash: hash(protocol),
  marketHash: hash({ series: market.seriesBySymbol, marks: market.markPricesByCycleDate, dailyBars }), provenance, sourceHashes,
  activeLedgerHash: hash(ledgerAfter), activeLedgerUnchanged: true, selection, nominatedByDevelopment: nominatedId,
  eligibleCandidates, decision: 'research_only_no_active_strategy_migration', prefixChecks, results, yearly,
  limitations: [
    '60%指扣成本盈利日占所有完整日历结算日，空仓/持平日也进入分母；不是交易胜率或持仓方向命中率。',
    'B0恢复原价格信号、仓位预算与月度风控；财务执行器为数量持仓/费用后权益模型，不等于旧引擎或活跃v2新闻模拟盘。',
    '所有候选只改方向，沿用原绝对仓位预算；预算为零时不能开仓，月损锁定与盈利降仓可能减少信号实施机会。',
    'F1/F2/F3是Freqtrade小时级SMA/ADX机制的日线适配，Q1/F3借鉴QuantDinger先平后反手；不是原项目完整策略的复制回测。',
    '2023-2024只用于开发提名；2025以后此前已被观察，不是全新盲测。固定五方案也存在多重比较偏差。',
    '历史新闻缺少当时可获得时间与版本档案，未将今天抓取的新闻倒填历史，也不声称回测验证了新闻权重。',
    '每日09:00边界价格只是执行代理，未模拟延迟、盘口、盘中止损/止盈、部分成交或流动性冲击。',
    '现货价格负持仓仅为合成做空；固定持仓成本不是借币费用或永续资金费，也未模拟保证金与强平。',
    '前缀一致检查仅覆盖已触发路径及两个截止日；统计区间不是未来收益保证。',
  ] };
const reportFile = path.join(outputDir, `btc-open-source60-${endDate}.json`);
await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(outputDir, `btc-open-source60-${endDate}-research-daily.json`),
  `${JSON.stringify(Object.fromEntries([...states].map(([key, state]) => [key, state.reports])), null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ reportFile, nominatedByDevelopment: nominatedId, eligibleCandidates,
  bestDiagnosticCandidate: selection.bestDiagnosticCandidate?.id, prefixChecksPassed: prefixChecks.length,
  activeLedgerUnchanged: true }));
