import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceBtcPaperState,
  btcPaperSnapshot,
  BTC_SINGLE_ASSET_PAPER_PROFILE,
  evaluateBtcNewsRisk,
  initializeBtcPaperState,
} from '../src/btc-paper.js';
import { addUtcDays } from '../src/monthly-accuracy-paper.js';

function btcSeries(startDate, endDate, dailyReturn = 0.002) {
  const rows = [];
  let date = startDate;
  let price = 30_000;
  while (date <= endDate) {
    rows.push({ date, close: price });
    price *= 1 + dailyReturn;
    date = addUtcDays(date, 1);
  }
  return { BTCUSDT: rows };
}

test('BTC单币策略只建立BTC仓位并沿用多周期动态趋势参数', () => {
  const profile = BTC_SINGLE_ASSET_PAPER_PROFILE;
  assert.equal(profile.symbol, 'BTCUSDT');
  assert.deepEqual(profile.trend.lookbackDays, [45, 90, 180]);
  assert.equal(profile.trend.minimumTrendVotes, 2);
  assert.equal(profile.trend.dynamicLeverageMax, 3);
  assert.equal(profile.monthlyProfitLock, null);
  assert.equal(profile.monthlyLossLimit, 0.015);

  const series = btcSeries('2025-11-01', '2026-07-16');
  const state = initializeBtcPaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrice: 45_000,
    now: Date.parse('2026-07-16T02:12:00.000Z'),
  });
  const snapshot = btcPaperSnapshot(state);
  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.positions[0].symbol, 'BTCUSDT');
  assert.equal(snapshot.positions[0].side, 'LONG');
  assert.ok(snapshot.modelGrossExposure > 0);
  assert.ok(snapshot.modelGrossExposure <= 1);
  assert.deepEqual(snapshot.accuracy, {
    observations: 0,
    profitableDays: 0,
    profitableDayRatio: null,
    directionalObservations: 0,
    directionalHits: 0,
    directionalHitRate: null,
  });
  assert.equal(snapshot.latestReport.pricePnl, 0);
  assert.ok(snapshot.latestReport.tradingCost > 0);
  assert.match(snapshot.latestReport.notes.join(' '), /不回填/);
});

test('BTC下跌趋势可建立单币空仓', () => {
  const series = btcSeries('2025-11-01', '2026-07-16', -0.002);
  const state = initializeBtcPaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrice: 20_000,
  });
  assert.equal(state.positions.length, 1);
  assert.equal(state.positions[0].side, 'SHORT');
  assert.ok(state.weight < 0);
});

test('BTC专属新闻只有同方向事件证据与价格仓位冲突时才降风险', () => {
  const snapshot = {
    status: 'live',
    paperCycleDate: '2026-07-16',
    capturedForDecisionAt: '2026-07-16T01:05:00.000Z',
    summary: {
      bySymbol: {
        BTCUSDT: {
          symbolSpecificScore: -0.30,
          symbolSpecificCredibility: 80,
          symbolSpecificConfidence: 70,
          symbolSpecificArticleCount: 2,
          symbolSpecificDirectionalEvidence: {
            bearish: {
              confirmedEventCount: 1,
              corroboratedEventCount: 0,
            },
          },
        },
      },
    },
  };
  const conflict = evaluateBtcNewsRisk(snapshot, 0.5, '2026-07-16');
  assert.equal(conflict.eligible, true);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.appliedGrossExposureScale, 0.75);

  snapshot.summary.bySymbol.BTCUSDT.symbolSpecificDirectionalEvidence.bearish.confirmedEventCount = 0;
  const unconfirmed = evaluateBtcNewsRisk(snapshot, 0.5, '2026-07-16');
  assert.equal(unconfirmed.eligible, false);
  assert.equal(unconfirmed.appliedGrossExposureScale, 1);

  snapshot.summary.bySymbol.BTCUSDT.symbolSpecificDirectionalEvidence.bearish.confirmedEventCount = 1;
  const sameDirection = evaluateBtcNewsRisk(snapshot, -0.5, '2026-07-16');
  assert.equal(sameDirection.eligible, true);
  assert.equal(sameDirection.conflict, false);
  assert.equal(sameDirection.appliedGrossExposureScale, 1);
});

test('BTC模拟盘每日结算真实价格盈亏并在盈利阈值后保留10%敞口', () => {
  const series = btcSeries('2025-11-01', '2026-07-17');
  const state = initializeBtcPaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrice: 45_000,
  });
  const originalWeight = Math.abs(state.weight);
  state.equity = state.monthStartEquity * 1.02;
  advanceBtcPaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: { '2026-07-17': { BTCUSDT: 45_100 } },
    throughCycleDate: '2026-07-17',
    now: Date.parse('2026-07-17T01:05:00.000Z'),
  });
  assert.equal(state.latestReport.kind, 'daily');
  assert.equal(state.latestReport.profitDeRisk.active, true);
  assert.ok(Math.abs(state.weight) > 0);
  assert.ok(Math.abs(state.weight) <= originalWeight * 0.11);
  assert.equal(state.lockReason, null);
  assert.equal(state.latestReport.positions[0].symbol, 'BTCUSDT');
});

test('BTC模拟盘保留1.5%月度亏损保护并实际平仓', () => {
  const series = btcSeries('2025-11-01', '2026-07-17');
  const state = initializeBtcPaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrice: 45_000,
  });
  state.equity = state.monthStartEquity * 0.98;
  advanceBtcPaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: { '2026-07-17': { BTCUSDT: 45_000 } },
    throughCycleDate: '2026-07-17',
  });
  assert.equal(state.lockReason, 'loss');
  assert.equal(state.weight, 0);
  assert.deepEqual(state.positions, []);
  assert.equal(state.latestReport.settledLockReason, 'loss');
  assert.ok(state.latestReport.tradingCost > 0);
});

test('BTC模拟盘后续推进默认沿用初始化时冻结的策略快照', () => {
  const series = btcSeries('2025-11-01', '2026-07-17');
  const profile = {
    ...BTC_SINGLE_ASSET_PAPER_PROFILE,
    id: 'btc-single-asset-frozen-test-v1',
    name: 'BTC冻结配置测试',
    tradingCostRate: 0,
    dailyCarryCostRate: 0,
    monthlyLossLimit: 0.50,
    monthlyProfitDeRiskThreshold: 0.50,
    trend: {
      ...BTC_SINGLE_ASSET_PAPER_PROFILE.trend,
      maxGrossExposure: 0.05,
      maxAssetExposure: 0.05,
      tradingCostRate: 0,
      dailyCarryCostRate: 0,
    },
  };
  const state = initializeBtcPaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrice: 45_000,
    profile,
  });

  assert.equal(state.latestReport.strategyProfileId, profile.id);
  assert.ok(Math.abs(state.weight) <= 0.05);

  advanceBtcPaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: { '2026-07-17': { BTCUSDT: 45_100 } },
    throughCycleDate: '2026-07-17',
  });

  assert.equal(state.latestReport.strategyProfileId, profile.id);
  assert.equal(state.latestReport.tradingCost, 0);
  assert.equal(state.latestReport.carryCost, 0);
  assert.ok(Math.abs(state.weight) <= 0.05);
});
