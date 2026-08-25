import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  addUtcDays,
  advancePaperState,
  buildPaperNewsSignalContext,
  initializePaperState,
  latestCompletePaperCycleDate,
  migratePaperStateToContinuousDeRisk,
  migratePaperStateToNoProfitLock,
  MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE,
  MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE,
  MONTHLY_ACCURACY_PAPER_PROFILE,
  PaperPortfolioStore,
  paperPortfolioSnapshot,
  updateMonthlyLock,
} from '../src/monthly-accuracy-paper.js';
import { PAPER_SHADOW_PROFILES } from '../src/paper-strategy-review.js';

const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

function syntheticSeries(startDate, endDate) {
  const values = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  const prices = Object.fromEntries(symbols.map((symbol, index) => [symbol, 100 + index * 10]));
  let date = startDate;
  let cursor = 0;
  while (date <= endDate) {
    symbols.forEach((symbol, index) => {
      const drift = (2.5 - index) * 0.0007;
      prices[symbol] *= Math.exp(drift + Math.sin(cursor / 11 + index) * 0.002);
      values[symbol].push({ date, close: prices[symbol] });
    });
    cursor += 1;
    date = addUtcDays(date, 1);
  }
  return values;
}

function markPrices(seriesBySymbol, date, multiplier = 1) {
  return Object.fromEntries(symbols.map((symbol) => {
    const row = seriesBySymbol[symbol].find((item) => item.date === date);
    return [symbol, row.close * multiplier];
  }));
}

function lockTestComponent(equity) {
  return {
    equity,
    monthStartEquity: 1,
    lockReason: null,
  };
}

function netExitLockProfile(id) {
  return {
    ...MONTHLY_ACCURACY_PAPER_PROFILE,
    id,
    name: id,
    marketNeutral: {
      ...MONTHLY_ACCURACY_PAPER_PROFILE.marketNeutral,
      rebalanceDays: 1,
      minimumRebalanceTurnover: 2,
      monthlyProfitLockNetOfExitCost: true,
    },
    trend: {
      ...MONTHLY_ACCURACY_PAPER_PROFILE.trend,
      monthlyProfitLock: null,
      monthlyLossLimit: null,
      monthlyProfitLockNetOfExitCost: true,
    },
  };
}

function prepareControlledLockState(state) {
  state.equity = 10_000;
  state.peakEquity = 10_000;
  state.maxDrawdown = 0;
  state.latestPrices = Object.fromEntries(symbols.map((symbol) => [symbol, 100]));
  state.components.marketNeutral.equity = 1;
  state.components.marketNeutral.monthStartEquity = 1;
  state.components.marketNeutral.lockReason = null;
  state.components.marketNeutral.weights = Object.fromEntries(symbols.map((symbol) => [
    symbol,
    symbol === 'BTCUSDT' ? 0.5 : symbol === 'ETHUSDT' ? -0.5 : 0,
  ]));
  state.components.marketNeutral.baseWeights = {
    ...state.components.marketNeutral.weights,
  };
  state.components.trend.equity = 1;
  state.components.trend.monthStartEquity = 1;
  state.components.trend.lockReason = 'profit';
  state.components.trend.weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
}

function controlledSettlementPrices() {
  return Object.fromEntries(symbols.map((symbol) => [
    symbol,
    symbol === 'BTCUSDT' ? 102.2 : 100,
  ]));
}

test('无盈利锁正式配置取消止盈但保留趋势亏损保护', () => {
  assert.equal(MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE.marketNeutral.monthlyProfitLock, null);
  assert.equal(MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE.trend.monthlyProfitLock, null);
  assert.equal(MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE.trend.monthlyLossLimit, 0.015);
  assert.equal(MONTHLY_ACCURACY_PAPER_PROFILE.marketNeutral.monthlyProfitLock, 0.01);
  assert.equal(MONTHLY_ACCURACY_PAPER_PROFILE.trend.monthlyProfitLock, 0.0125);
});

test('持续交易降风险配置不做盈利空仓并保留趋势亏损保护', () => {
  const profile = MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE;
  assert.equal(profile.marketNeutral.monthlyProfitLock, null);
  assert.equal(profile.trend.monthlyProfitLock, null);
  assert.equal(profile.marketNeutral.monthlyProfitDeRiskThreshold, 0.0075);
  assert.equal(profile.trend.monthlyProfitDeRiskThreshold, 0.01);
  assert.equal(profile.marketNeutral.monthlyProfitDeRiskScale, 0.1);
  assert.equal(profile.trend.monthlyProfitDeRiskScale, 0.1);
  assert.equal(profile.trend.monthlyLossLimit, 0.015);
});

test('持续交易降风险迁移保留历史和已有亏损锁并从下一周期生效', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-17');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-17',
    markPrices: markPrices(series, '2026-07-16'),
    profile: MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE,
  });
  state.components.marketNeutral.lockReason = 'profit';
  state.components.trend.lockReason = 'loss';
  const reportsBefore = JSON.stringify(state.reports);
  const equityBefore = state.equity;

  migratePaperStateToContinuousDeRisk(state, {
    now: Date.parse('2026-07-17T03:00:00.000Z'),
  });

  assert.equal(state.strategyProfileId, MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.id);
  assert.equal(state.components.marketNeutral.lockReason, null);
  assert.equal(state.components.trend.lockReason, 'loss');
  assert.equal(state.equity, equityBefore);
  assert.equal(JSON.stringify(state.reports), reportsBefore);
  assert.equal(state.pendingStrategyChange.effectiveFromCycleDate, '2026-07-18');
  assert.equal(state.strategyEpochStartCycleDate, '2026-07-18');
  assert.equal(state.pendingStrategyChange.continuousTrading, true);
  assert.equal(state.forceRebalanceNextCycle, true);
});

test('达到月内收益阈值后按信号保留10%敞口而不是盈利空仓', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-17');
  const initialize = (profile) => initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15'),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
  });
  const baseline = initialize(MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE);
  const candidate = initialize(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE);
  for (const state of [baseline, candidate]) {
    state.components.marketNeutral.equity = 1.02;
    state.components.marketNeutral.monthStartEquity = 1;
    state.components.trend.equity = 1.02;
    state.components.trend.monthStartEquity = 1;
  }
  const advance = (state, profile) => advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: { '2026-07-17': markPrices(series, '2026-07-16') },
    throughCycleDate: '2026-07-17',
    now: Date.parse('2026-07-17T01:05:00.000Z'),
    profile,
  });
  advance(baseline, MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE);
  advance(candidate, MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE);

  assert.equal(candidate.latestReport.nextProfitDeRisk.marketNeutral.active, true);
  assert.equal(candidate.latestReport.nextProfitDeRisk.trend.active, true);
  assert.equal(candidate.components.marketNeutral.lockReason, null);
  assert.equal(candidate.components.trend.lockReason, null);
  assert.ok(candidate.positions.some((position) => position.marketNeutralWeight !== 0));
  assert.ok(candidate.positions.some((position) => position.trendWeight !== 0));
  assert.ok(candidate.modelGrossExposure > 0);
  assert.ok(candidate.modelGrossExposure < baseline.modelGrossExposure * 0.11);
});

test('正式账本迁移不回写历史并在下一周期按最新信号恢复仓位', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-18');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-17',
    markPrices: markPrices(series, '2026-07-16'),
    initialCapital: 10_000,
    now: Date.parse('2026-07-17T01:05:00.000Z'),
  });
  state.components.marketNeutral.lockReason = 'profit';
  state.components.trend.lockReason = 'profit';
  state.components.marketNeutral.baseWeights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  state.components.marketNeutral.weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  state.components.trend.weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  state.positions = [];
  state.modelGrossExposure = 0;
  state.nettedGrossExposure = 0;
  state.netExposure = 0;
  const historyBefore = JSON.stringify(state.reports);
  const equityBefore = state.equity;
  const migrated = migratePaperStateToNoProfitLock(state, {
    now: Date.parse('2026-07-17T03:00:00.000Z'),
  });

  assert.equal(migrated, state);
  assert.equal(state.strategyProfileId, MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE.id);
  assert.equal(state.components.marketNeutral.lockReason, null);
  assert.equal(state.components.trend.lockReason, null);
  assert.equal(state.equity, equityBefore);
  assert.equal(JSON.stringify(state.reports), historyBefore);
  assert.equal(state.pendingStrategyChange.effectiveFromCycleDate, '2026-07-18');
  assert.equal(state.forceRebalanceNextCycle, true);
  assert.equal(paperPortfolioSnapshot(state).componentState.marketNeutral.lockReason, null);

  advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: {
      '2026-07-18': markPrices(series, '2026-07-17'),
    },
    throughCycleDate: '2026-07-18',
    now: Date.parse('2026-07-18T01:05:00.000Z'),
    profile: MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE,
  });

  assert.equal(state.pendingStrategyChange, null);
  assert.equal(state.forceRebalanceNextCycle, false);
  assert.equal(state.latestReport.strategyChangeApplied.appliedCycleDate, '2026-07-18');
  assert.match(state.latestReport.notes[0], /最新完整信号/);
  assert.equal(state.latestReport.settledLocks.marketNeutral, null);
  assert.equal(state.latestReport.settledLocks.trend, null);
  assert.ok(state.positions.length > 0);
  assert.ok(state.latestReport.turnover.marketNeutral > 0);
});

test('迁移只解除盈利锁，不绕过亏损风控', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-17');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-17',
    markPrices: markPrices(series, '2026-07-16'),
  });
  state.components.marketNeutral.lockReason = 'profit';
  state.components.trend.lockReason = 'loss';
  migratePaperStateToNoProfitLock(state);
  assert.equal(state.components.marketNeutral.lockReason, null);
  assert.equal(state.components.trend.lockReason, 'loss');
});

test('月度止盈净退出成本模式保持旧行为并审计边界', () => {
  const settings = {
    monthlyProfitLock: 0.01,
    monthlyLossLimit: 0.015,
    tradingCostRate: 0.0007,
  };
  const context = {
    settlementStartEquity: 1,
    currentWeights: { LONG: 0.5, SHORT: -0.5 },
    closeWillExecute: true,
  };
  const missingFlag = lockTestComponent(1.0105);
  const explicitFalse = lockTestComponent(1.0105);
  const missingEvaluation = updateMonthlyLock(missingFlag, settings, context);
  const falseEvaluation = updateMonthlyLock(explicitFalse, {
    ...settings,
    monthlyProfitLockNetOfExitCost: false,
  }, context);
  assert.equal(missingFlag.lockReason, 'profit');
  assert.equal(explicitFalse.lockReason, 'profit');
  assert.equal(missingEvaluation.mode, 'gross');
  assert.equal(falseEvaluation.mode, 'gross');
  assert.equal(
    missingEvaluation.profitComparisonMonthlyReturn,
    falseEvaluation.profitComparisonMonthlyReturn,
  );

  const blocked = lockTestComponent(1.0105);
  const blockedEvaluation = updateMonthlyLock(blocked, {
    ...settings,
    monthlyProfitLockNetOfExitCost: true,
  }, context);
  assert.equal(blocked.lockReason, null);
  assert.ok(blockedEvaluation.grossMonthlyReturn >= 0.01);
  assert.ok(blockedEvaluation.projectedNetMonthlyReturn < 0.01);

  const passed = lockTestComponent(1.0108);
  const passedEvaluation = updateMonthlyLock(passed, {
    ...settings,
    monthlyProfitLockNetOfExitCost: true,
  }, context);
  assert.equal(passed.lockReason, 'profit');
  assert.equal(passedEvaluation.triggeredLockReason, 'profit');
  assert.ok(passedEvaluation.projectedNetMonthlyReturn >= 0.01);

  const loss = lockTestComponent(0.9849);
  updateMonthlyLock(loss, {
    ...settings,
    monthlyProfitLockNetOfExitCost: true,
  }, {
    ...context,
    closeWillExecute: false,
  });
  assert.equal(loss.lockReason, 'loss');

  const monthEnd = lockTestComponent(1.02);
  const monthEndEvaluation = updateMonthlyLock(monthEnd, {
    ...settings,
    monthlyProfitLockNetOfExitCost: true,
  }, {
    ...context,
    closeWillExecute: false,
  });
  assert.equal(monthEnd.lockReason, null);
  assert.equal(monthEndEvaluation.profitLockActionable, false);
  assert.equal(monthEndEvaluation.estimatedExitTurnover, 0);
});

test('净退出成本止盈在完整推进中平仓且只扣一次成本', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-17');
  const profile = netExitLockProfile('test-net-exit-lock');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15'),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
  });
  prepareControlledLockState(state);

  advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: { '2026-07-17': controlledSettlementPrices() },
    throughCycleDate: '2026-07-17',
    now: Date.parse('2026-07-17T01:05:00.000Z'),
    profile,
  });

  const report = state.latestReport;
  assert.equal(report.settledLocks.marketNeutral, 'profit');
  assert.equal(report.settledLockEvaluation.marketNeutral.mode, 'net_of_exit_cost');
  assert.equal(report.settledLockEvaluation.marketNeutral.estimatedExitTurnover, 1);
  assert.equal(report.settledLockEvaluation.marketNeutral.triggeredLockReason, 'profit');
  assert.equal(report.turnover.marketNeutral, 1);
  assert.equal(report.settledMonthReturns.marketNeutral, 0.01095);
  assert.equal(report.settledLockEvaluation.marketNeutral.projectedNetMonthlyReturn, 0.01025);
  assert.equal(report.componentState.marketNeutral.monthlyReturn, 0.01025);
  assert.equal(report.componentAttribution.marketNeutral.tradingCost, 5.95);
  assert.equal(state.components.marketNeutral.weights.BTCUSDT, 0);
  assert.equal(state.components.marketNeutral.weights.ETHUSDT, 0);
});

test('月末推进把净退出成本止盈标记为不可执行', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-31');
  const profile = netExitLockProfile('test-net-exit-lock-month-end');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-30',
    markPrices: markPrices(series, '2026-07-29'),
    initialCapital: 10_000,
    now: Date.parse('2026-07-30T01:05:00.000Z'),
    profile,
  });
  prepareControlledLockState(state);

  advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: { '2026-07-31': controlledSettlementPrices() },
    throughCycleDate: '2026-07-31',
    now: Date.parse('2026-07-31T01:05:00.000Z'),
    profile,
  });

  const evaluation = state.latestReport.settledLockEvaluation.marketNeutral;
  assert.equal(evaluation.closeWillExecute, false);
  assert.equal(evaluation.profitLockActionable, false);
  assert.equal(evaluation.estimatedExitTurnover, 0);
  assert.equal(state.latestReport.settledLocks.marketNeutral, null);
});

test('纸面盘从启动日建立基线，不回填此前收益', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  const snapshot = paperPortfolioSnapshot(state);
  assert.equal(snapshot.startCycleDate, '2026-07-16');
  assert.equal(snapshot.lastCycleDate, '2026-07-16');
  assert.equal(snapshot.latestReport.kind, 'initialization');
  assert.equal(snapshot.reports.length, 1);
  assert.ok(snapshot.equity < 10_000);
  assert.ok(snapshot.positions.some((item) => item.side === 'LONG'));
  assert.ok(snapshot.positions.some((item) => item.side === 'SHORT'));
  assert.equal(snapshot.partialStartMonth, '2026-07');
  assert.equal(snapshot.firstFullMonth, '2026-08');
});

test('每日推进只结算未处理日期，重复执行保持幂等', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: {
      '2026-07-17': markPrices(series, '2026-07-16', 1.002),
    },
    throughCycleDate: '2026-07-17',
    now: Date.parse('2026-07-17T01:05:00.000Z'),
  });
  const reportsAfterFirstRun = state.reports.length;
  const equityAfterFirstRun = state.equity;
  assert.equal(state.lastCycleDate, '2026-07-17');
  assert.equal(state.latestReport.kind, 'daily');
  assert.equal(state.latestReport.strategyProfileId, MONTHLY_ACCURACY_PAPER_PROFILE.id);
  assert.equal(state.latestReport.strategyEpochStartCycleDate, '2026-07-16');
  assert.ok(Number.isFinite(state.latestReport.dayPnl));
  assert.equal(
    Number(state.latestReport.symbolAttribution
      .reduce((sum, item) => sum + item.totalPricePnl, 0).toFixed(3)),
    Number(state.latestReport.pricePnl.toFixed(3)),
  );
  assert.equal(
    Number((state.latestReport.componentAttribution.marketNeutral.totalPnl
      + state.latestReport.componentAttribution.trend.totalPnl).toFixed(3)),
    Number(state.latestReport.dayPnl.toFixed(3)),
  );
  assert.equal(reportsAfterFirstRun, 2);

  advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: {},
    throughCycleDate: '2026-07-17',
    now: Date.parse('2026-07-17T01:06:00.000Z'),
  });
  assert.equal(state.reports.length, reportsAfterFirstRun);
  assert.equal(state.equity, equityAfterFirstRun);
});

test('北京时间09点之后才使用当天固定估值周期', () => {
  assert.equal(
    latestCompletePaperCycleDate(Date.parse('2026-07-16T00:59:59.999Z')),
    '2026-07-15',
  );
  assert.equal(
    latestCompletePaperCycleDate(Date.parse('2026-07-16T01:00:00.000Z')),
    '2026-07-16',
  );
});

test('分散影子使用独立冻结参数并持有每侧两个横截面标的', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id.includes('diversified'));
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
  });
  assert.equal(state.strategyProfileId, profile.id);
  assert.equal(state.profileSnapshot.marketNeutral.positionsPerSide, 2);
  assert.equal(
    state.positions.filter((position) => position.marketNeutralWeight !== 0).length,
    4,
  );
});

test('新闻增强影子只在可信新闻达标时应用45%权重并记录决策', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-45-v1');
  const emptySummary = {
    score: 0,
    direction: 'neutral',
    credibility: 0,
    confidence: 0,
    articleCount: 0,
    confirmedArticleCount: 0,
    confirmedAssessments: [],
  };
  const newsSnapshot = {
    status: 'live',
    updatedAt: '2026-07-16T01:00:00.000Z',
    sourceStatus: [{ source: 'Official', ok: true }],
    summary: {
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, symbol === 'ETHUSDT' ? {
        score: 1,
        direction: 'bullish',
        credibility: 92,
        confidence: 85,
        articleCount: 1,
        confirmedArticleCount: 1,
        confirmedAssessments: [{ credibility: 92, confidence: 85, evidenceStrength: 'strong' }],
      } : emptySummary])),
    },
  };
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
    newsSnapshot,
  });
  assert.equal(state.latestReport.nextNewsOverlay.appliedNewsWeightPercent, 45);
  assert.equal(state.latestReport.nextNewsOverlay.fallbackToPriceOnly, false);
  const ethRanking = state.latestReport.nextNewsOverlay.ranking
    .find((item) => item.symbol === 'ETHUSDT');
  assert.equal(ethRanking.newsEligible, true);
  assert.equal(ethRanking.newsScore, 1);
  assert.ok(state.latestReport.nextNewsOverlay.selectedLongSymbols.length > 0);
});

test('新闻质量影子根据可信度、置信度和方向强度降低边界消息权重', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-adaptive-v1');
  const emptySummary = {
    score: 0,
    direction: 'neutral',
    credibility: 0,
    confidence: 0,
    articleCount: 0,
    confirmedArticleCount: 0,
    confirmedAssessments: [],
  };
  const newsSnapshot = {
    status: 'live',
    updatedAt: '2026-07-16T01:00:00.000Z',
    sourceStatus: [{ source: 'Official', ok: true }],
    summary: {
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, symbol === 'ETHUSDT' ? {
        score: 0.20,
        direction: 'bullish',
        credibility: 80,
        confidence: 70,
        articleCount: 1,
        confirmedArticleCount: 1,
        confirmedAssessments: [{ credibility: 80, confidence: 70, evidenceStrength: 'strong' }],
      } : emptySummary])),
    },
  };
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
    newsSnapshot,
  });
  const decision = state.latestReport.nextNewsOverlay;
  const ethRanking = decision.ranking.find((item) => item.symbol === 'ETHUSDT');
  assert.equal(decision.newsWeightMode, 'quality');
  assert.equal(decision.appliedNewsWeightPercent, 10.08);
  assert.equal(ethRanking.newsWeightPercent, 10.08);
  assert.ok(decision.appliedNewsWeightPercent > 0);
  assert.ok(decision.appliedNewsWeightPercent < decision.requestedNewsWeightPercent);
});

test('新闻风险影子不改变多空选择，只在方向冲突时降低敞口', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const baseline = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  const baselineLong = baseline.positions.find((item) => item.marketNeutralWeight > 0).symbol;
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-risk-veto-v1');
  const emptySummary = {
    score: 0,
    direction: 'neutral',
    credibility: 0,
    confidence: 0,
    articleCount: 0,
    confirmedArticleCount: 0,
    confirmedAssessments: [],
  };
  const newsSnapshot = {
    status: 'live',
    updatedAt: '2026-07-16T01:00:00.000Z',
    sourceStatus: [{ source: 'Official', ok: true }],
    summary: {
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, symbol === baselineLong ? {
        score: -0.30,
        direction: 'bearish',
        credibility: 68,
        confidence: 50,
        articleCount: 3,
        confirmedArticleCount: 0,
        confirmedAssessments: [],
      } : emptySummary])),
    },
  };
  const guarded = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
    newsSnapshot,
  });
  assert.deepEqual(
    guarded.positions.map((item) => [item.symbol, Math.sign(item.weight)]),
    baseline.positions.map((item) => [item.symbol, Math.sign(item.weight)]),
  );
  assert.equal(guarded.latestReport.nextNewsOverlay.riskVetoTriggered, true);
  assert.deepEqual(guarded.latestReport.nextNewsOverlay.riskVetoConflictSymbols, [baselineLong]);
  assert.equal(guarded.latestReport.nextNewsOverlay.appliedRiskGrossExposureScale, 0.75);
  assert.ok(guarded.modelGrossExposure < baseline.modelGrossExposure);
});

test('标的专属新闻风控不会被只有泛市场依据的综合分数触发', () => {
  const combinedProfile = PAPER_SHADOW_PROFILES
    .find((item) => item.id === 'shadow-news-risk-veto-v1');
  const specificProfile = PAPER_SHADOW_PROFILES
    .find((item) => item.id === 'shadow-news-specific-risk-v1');
  const summary = {
    score: -0.30,
    direction: 'bearish',
    credibility: 68,
    confidence: 50,
    articleCount: 3,
    confirmedArticleCount: 0,
    confirmedAssessments: [],
    symbolSpecificScore: 0,
    symbolSpecificDirection: 'neutral',
    symbolSpecificCredibility: 0,
    symbolSpecificConfidence: 0,
    symbolSpecificArticleCount: 0,
  };
  const newsSnapshot = {
    status: 'live',
    updatedAt: '2026-07-16T01:00:00.000Z',
    sourceStatus: [{ source: 'Official', ok: true }],
    summary: { bySymbol: { BTCUSDT: summary } },
  };

  const combined = buildPaperNewsSignalContext(newsSnapshot, ['BTCUSDT'], combinedProfile);
  const specific = buildPaperNewsSignalContext(newsSnapshot, ['BTCUSDT'], specificProfile);
  assert.equal(combined.signalContext.newsRiskScoresBySymbol.BTCUSDT, -0.3);
  assert.deepEqual(specific.signalContext.newsRiskScoresBySymbol, {});
  assert.equal(specific.decision.riskSignalScope, 'symbol_specific');

  summary.symbolSpecificScore = -0.30;
  summary.symbolSpecificDirection = 'bearish';
  summary.symbolSpecificCredibility = 68;
  summary.symbolSpecificConfidence = 50;
  summary.symbolSpecificArticleCount = 3;
  const triggered = buildPaperNewsSignalContext(newsSnapshot, ['BTCUSDT'], specificProfile);
  assert.equal(triggered.signalContext.newsRiskScoresBySymbol.BTCUSDT, -0.3);
  assert.equal(triggered.decision.riskEligibleSymbols[0].riskArticleCount, 3);
});

test('未来新闻风控候选可要求同方向官方确认或独立多源事件证据', () => {
  const baseProfile = PAPER_SHADOW_PROFILES
    .find((item) => item.id === 'shadow-continuous-news-specific-risk-v1');
  const profile = JSON.parse(JSON.stringify(baseProfile));
  profile.id = 'research-event-evidence';
  assert.equal(profile.newsOverlay.riskEvidenceMode, 'confirmed_or_independent_event');
  const directionalEvidence = {
    bullish: { uniqueEventCount: 0, confirmedEventCount: 0, corroboratedEventCount: 0, independentSourceCount: 0 },
    bearish: { uniqueEventCount: 1, confirmedEventCount: 0, corroboratedEventCount: 0, independentSourceCount: 1 },
  };
  const summary = {
    score: -0.3,
    direction: 'bearish',
    credibility: 80,
    confidence: 70,
    articleCount: 3,
    confirmedArticleCount: 0,
    confirmedAssessments: [],
    symbolSpecificScore: -0.3,
    symbolSpecificDirection: 'bearish',
    symbolSpecificCredibility: 80,
    symbolSpecificConfidence: 70,
    symbolSpecificArticleCount: 3,
    symbolSpecificDirectionalEvidence: directionalEvidence,
  };
  const snapshot = {
    status: 'live',
    updatedAt: '2026-07-16T01:05:00.000Z',
    summary: { bySymbol: { BTCUSDT: summary } },
  };

  const blocked = buildPaperNewsSignalContext(snapshot, ['BTCUSDT'], profile);
  assert.deepEqual(blocked.signalContext.newsRiskScoresBySymbol, {});
  assert.equal(blocked.decision.evaluatedSymbols[0].riskEvidencePassed, false);

  directionalEvidence.bearish.confirmedEventCount = 1;
  const confirmed = buildPaperNewsSignalContext(snapshot, ['BTCUSDT'], profile);
  assert.equal(confirmed.signalContext.newsRiskScoresBySymbol.BTCUSDT, -0.3);
  assert.equal(confirmed.decision.evaluatedSymbols[0].riskEvidencePassed, true);

  directionalEvidence.bearish.confirmedEventCount = 0;
  directionalEvidence.bearish.corroboratedEventCount = 1;
  directionalEvidence.bearish.independentSourceCount = 2;
  const corroborated = buildPaperNewsSignalContext(snapshot, ['BTCUSDT'], profile);
  assert.equal(corroborated.signalContext.newsRiskScoresBySymbol.BTCUSDT, -0.3);
});

test('新闻增强影子在新闻不可用时回退为原价格排名', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-45-v1');
  const baseline = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  const fallback = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
    newsSnapshot: { status: 'unavailable', updatedAt: '2026-07-16T01:00:00.000Z' },
  });
  assert.equal(fallback.latestReport.nextNewsOverlay.appliedNewsWeightPercent, 0);
  assert.equal(fallback.latestReport.nextNewsOverlay.fallbackToPriceOnly, true);
  assert.deepEqual(
    fallback.positions.map((item) => [item.symbol, Math.sign(item.weight)]),
    baseline.positions.map((item) => [item.symbol, Math.sign(item.weight)]),
  );
});

test('新闻live快照周期或捕获窗口不匹配时仍强制回退价格信号', () => {
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-45-v1');
  const summary = {
    score: 1,
    direction: 'bullish',
    credibility: 92,
    confidence: 85,
    articleCount: 1,
    confirmedArticleCount: 1,
    confirmedAssessments: [{ credibility: 92, confidence: 85, evidenceStrength: 'strong' }],
  };
  const late = buildPaperNewsSignalContext({
    status: 'live',
    updatedAt: '2026-07-16T01:16:00.000Z',
    paperCycleDate: '2026-07-16',
    capturedForDecisionAt: '2026-07-16T01:16:00.000Z',
    summary: { bySymbol: { BTCUSDT: summary } },
  }, ['BTCUSDT'], profile, { decisionCycleDate: '2026-07-16' });
  const wrongCycle = buildPaperNewsSignalContext({
    status: 'live',
    updatedAt: '2026-07-16T01:05:00.000Z',
    paperCycleDate: '2026-07-15',
    capturedForDecisionAt: '2026-07-16T01:05:00.000Z',
    summary: { bySymbol: { BTCUSDT: summary } },
  }, ['BTCUSDT'], profile, { decisionCycleDate: '2026-07-16' });

  for (const result of [late, wrongCycle]) {
    assert.equal(result.decision.status, 'live');
    assert.equal(result.decision.signalFresh, false);
    assert.equal(result.decision.fallbackToPriceOnly, true);
    assert.deepEqual(result.signalContext.newsScoresBySymbol, {});
    assert.match(result.decision.fallbackReason, /决策窗口/);
  }
});

test('纸面盘状态使用锁文件和原子写入持久化', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quantflow-paper-'));
  const filePath = path.join(directory, 'paper.json');
  const store = new PaperPortfolioStore(filePath);
  await store.run((current) => ({ version: 1, count: (current?.count || 0) + 1 }));
  await store.run((current) => ({ ...current, count: current.count + 1 }));
  await store.run((current) => {
    current.count += 1;
    return current;
  });
  assert.deepEqual(await store.read(), { version: 1, count: 3 });
  assert.equal(await fs.stat(`${filePath}.lock`).catch(() => null), null);
  await fs.rm(directory, { recursive: true, force: true });
});
