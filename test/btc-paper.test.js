import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceBtcPaperState,
  btcPaperSnapshot,
  BTC_SINGLE_ASSET_PAPER_PROFILE,
  evaluateBtcNewsRisk,
  evaluateBtcProfitDeRisk,
  evaluateBtcNewsDataGuard,
  evaluateBtcRebalance,
  evaluateBtcEntryGuard,
  queueBtcNewsDataGuard,
  initializeBtcPaperState,
} from '../src/btc-paper.js';
import { BTC_GRADUAL_RISK_PROFILE } from '../src/paper-optimization-profiles.js';
import { addUtcDays } from '../src/monthly-accuracy-paper.js';

test('新闻缺失保护不加仓不开仓，减仓和平仓不受阻；新鲜但中性新闻不触发', () => {
  for (const [old, target, expected] of [[0, 0.5, 0], [0.2, 0.5, 0.2], [0.5, 0.2, 0.2],
    [-0.2, -0.5, -0.2], [-0.5, -0.2, -0.2], [0.2, -0.3, 0], [-0.2, 0.3, 0], [0.5, 0, 0]]) {
    const result = evaluateBtcNewsDataGuard(old, target, { signalFresh: false }, true);
    assert.equal(result.targetWeight, expected);
    assert.equal(result.active, true);
  }
  assert.equal(evaluateBtcNewsDataGuard(0.1, 0.5, { signalFresh: true, eligible: false }, true).targetWeight, 0.5);
  assert.equal(evaluateBtcNewsDataGuard(0.1, 0.5, null, false).targetWeight, 0.5);
});

test('研究用加仓过滤不延迟风险减仓、平仓、反向；默认关闭', () => {
  assert.equal(evaluateBtcRebalance(0.2, 0.21, 0.02).executedWeight, 0.2);
  assert.equal(evaluateBtcRebalance(-0.2, -0.21, 0.02).executedWeight, -0.2);
  for (const target of [0.19, 0, -0.2, 0.25]) assert.equal(evaluateBtcRebalance(0.2, target, 0.02).executedWeight, target);
  assert.equal(evaluateBtcRebalance(0.2, 0.21).executedWeight, 0.21);
  assert.throws(() => evaluateBtcRebalance(0, 0.2, -1));
});

test('研究用每日加仓上限限制新增风险，不限制减仓和平仓', () => {
  for (const [previous, target, expected] of [
    [0, 0.8, 0.1], [0, -0.8, -0.1],
    [0.2, 0.8, 0.3], [-0.2, -0.8, -0.3],
    [0.8, 0.2, 0.2], [-0.8, -0.2, -0.2],
    [0.8, 0, 0], [-0.8, 0, 0],
    [0.8, -0.7, -0.1], [-0.8, 0.7, 0.1],
    [0.8, -0.05, -0.05], [-0.8, 0.05, 0.05],
  ]) {
    const result = evaluateBtcRebalance(previous, target, 0, 0.1);
    assert.ok(Math.abs(result.executedWeight - expected) < 1e-12);
    assert.equal(result.targetWeight, target);
    assert.equal(result.maximumIncrease, 0.1);
    assert.equal(result.increaseCapped, Math.abs(expected - target) > 1e-12);
  }
  assert.equal(evaluateBtcRebalance(0.2, 0.21, 0.02, 0.1).executedWeight, 0.2);
  assert.equal(evaluateBtcRebalance(0.2, -0.8).executedWeight, -0.8);
  for (const maximum of [0, -0.1, 1.01, Infinity, NaN, '0.1']) {
    assert.throws(() => evaluateBtcRebalance(0.2, 0.3, 0, maximum), /上限无效/);
  }
  assert.throws(() => evaluateBtcRebalance(0.2, 0.3, 0.03, 0.02), /上限无效/);
});

test('短期逆向过滤对多空对称，阈值边界仅禁止加仓而不阻止退出', () => {
  for (const [previous, target, recentReturn, expected, active] of [
    [0, 0.8, -0.02, 0, true], [0, -0.8, 0.02, 0, true],
    [0.2, 0.8, -0.02, 0.2, true], [-0.2, -0.8, 0.02, -0.2, true],
    [0.8, 0.2, -0.03, 0.2, true], [-0.8, -0.2, 0.03, -0.2, true],
    [0.8, 0, -0.03, 0, false], [-0.8, 0, 0.03, 0, false],
    [0.8, -0.7, 0.02, 0, true], [-0.8, 0.7, -0.02, 0, true],
    [0.2, 0.8, -0.019, 0.8, false], [-0.2, -0.8, 0.019, -0.8, false],
    [0.2, 0.8, 0.03, 0.8, false], [-0.2, -0.8, -0.03, -0.8, false],
  ]) {
    const result = evaluateBtcEntryGuard(previous, target, recentReturn, 0.02);
    assert.equal(result.targetWeight, expected);
    assert.equal(result.active, active);
  }
  assert.equal(evaluateBtcEntryGuard(0, 0.8, null).targetWeight, 0.8);
  for (const threshold of [0, -0.01, Infinity, NaN, '0.02']) {
    assert.throws(() => evaluateBtcEntryGuard(0, 0.8, -0.03, threshold), /参数无效/);
  }
  for (const recentReturn of [null, undefined, Infinity, NaN, '-0.03']) {
    assert.throws(() => evaluateBtcEntryGuard(0, 0.8, recentReturn, 0.02), /参数无效/);
  }
});

test('新闻保护升级仅在下个未来决策生效，补跑不回写既有策略历史', () => {
  const series = btcSeries('2025-11-01', '2026-09-23');
  const state = initializeBtcPaperState({ seriesBySymbol: series, cycleDate: '2026-09-20', markPrice: 45000 });
  const historical = JSON.stringify(state.reports);
  const equity = state.equity;
  queueBtcNewsDataGuard(state, Date.parse('2026-09-22T02:00:00Z'));
  assert.equal(state.pendingStrategyChange.effectiveFromCycleDate, '2026-09-23');
  assert.equal(state.equity, equity);
  assert.equal(JSON.stringify(state.reports), historical);
  const marks = { '2026-09-21': { BTCUSDT: 45000 }, '2026-09-22': { BTCUSDT: 45000 }, '2026-09-23': { BTCUSDT: 45000 } };
  advanceBtcPaperState({ state, seriesBySymbol: series, markPricesByCycleDate: marks, throughCycleDate: '2026-09-22' });
  assert.equal(state.strategyProfileId, BTC_SINGLE_ASSET_PAPER_PROFILE.id);
  const priorReports = JSON.stringify(state.reports);
  advanceBtcPaperState({ state, seriesBySymbol: series, markPricesByCycleDate: marks, throughCycleDate: '2026-09-23' });
  assert.equal(state.profileSnapshot.newsDataQualityGuardEnabled, true);
  assert.equal(state.latestReport.dataQualityRisk.active, true);
  assert.equal(state.latestReport.settledStrategyProfileId, BTC_SINGLE_ASSET_PAPER_PROFILE.id);
  assert.equal(JSON.stringify(state.reports.slice(0, -1)), priorReports);
  assert.equal(state.strategyChanges.length, 1);
});

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

test('渐进减仓在1%至3%收益间连续变化，旧策略仍保持原规则', () => {
  const state = (returnRate) => ({ equity: 10000 * (1 + returnRate), monthStartEquity: 10000 });
  for (const [ret, expected] of [[-0.02, 1], [0.01, 1], [0.02, 0.75], [0.03, 0.5], [0.1, 0.5]]) {
    assert.ok(Math.abs(evaluateBtcProfitDeRisk(state(ret), BTC_GRADUAL_RISK_PROFILE).scale - expected) < 1e-10);
  }
  assert.equal(evaluateBtcProfitDeRisk(state(0.02)).scale, 0.1);
  assert.throws(() => evaluateBtcProfitDeRisk(state(0.02), {
    ...BTC_GRADUAL_RISK_PROFILE, monthlyProfitDeRiskFullAt: 0.005,
  }), /参数无效/);
});

test('新闻诊断完整列出未通过项，不把缺少证据的消息当作入场依据', () => {
  const risk = evaluateBtcNewsRisk(null, 0.5, '2026-09-05');
  assert.deepEqual(risk.failedChecks, ['fresh', 'directionStrength', 'credibility', 'confidence', 'articles', 'directionalEvidence']);
  assert.equal(risk.appliedGrossExposureScale, 1);
});

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

test('可选研究机制显式关闭与默认策略具有相同财务结果', () => {
  const series = btcSeries('2025-11-01', '2026-07-18');
  const disabled = {
    ...BTC_SINGLE_ASSET_PAPER_PROFILE,
    maximumWeightIncrease: null,
    entryGuardLookbackDays: null,
    entryGuardAdverseMove: null,
    monthlyLossContinuationScale: 0,
  };
  const run = (profile) => {
    const state = initializeBtcPaperState({
      seriesBySymbol: series, cycleDate: '2026-07-16', markPrice: 45_000,
      now: Date.parse('2026-07-16T01:00:00Z'), profile,
    });
    advanceBtcPaperState({
      state, seriesBySymbol: series,
      markPricesByCycleDate: { '2026-07-17': 45_100, '2026-07-18': 43_000 },
      throughCycleDate: '2026-07-18', now: Date.parse('2026-07-18T01:00:00Z'),
    });
    return state;
  };
  const original = run(BTC_SINGLE_ASSET_PAPER_PROFILE);
  const explicitlyDisabled = run(disabled);
  assert.deepEqual(explicitlyDisabled.reports, original.reports);
  assert.equal(explicitlyDisabled.equity, original.equity);
  assert.equal(explicitlyDisabled.weight, original.weight);
  assert.equal(original.weight, 0);
  assert.equal(original.lockReason, 'loss');
  assert.equal(BTC_SINGLE_ASSET_PAPER_PROFILE.monthlyLossContinuationScale, undefined);
  assert.equal(BTC_SINGLE_ASSET_PAPER_PROFILE.maximumWeightIncrease, undefined);
  assert.equal(BTC_SINGLE_ASSET_PAPER_PROFILE.entryGuardAdverseMove, undefined);
});

test('每日加仓上限也适用于月界重置，不能一次跳回完整风险', () => {
  const series = btcSeries('2025-11-01', '2026-08-01');
  const profile = { ...BTC_SINGLE_ASSET_PAPER_PROFILE, maximumWeightIncrease: 0.1 };
  const state = initializeBtcPaperState({
    seriesBySymbol: series, cycleDate: '2026-07-30', markPrice: 45_000, profile,
  });
  assert.equal(state.weight, 0.1);
  state.weight = 0.05;
  state.equity = state.monthStartEquity * 1.02;
  advanceBtcPaperState({
    state, seriesBySymbol: series,
    markPricesByCycleDate: { '2026-07-31': 45_000 }, throughCycleDate: '2026-07-31',
  });
  assert.equal(state.latestReport.monthChanged, true);
  assert.equal(state.latestReport.profitDeRisk.active, false);
  assert.equal(state.latestReport.rebalance.increaseCapped, true);
  assert.equal(state.weight, 0.15);
});

test('短期过滤验证启用窗口并把该窗口纳入行情预热', () => {
  const series = btcSeries('2025-11-01', '2026-07-16');
  const initialize = (extra) => initializeBtcPaperState({
    seriesBySymbol: series, cycleDate: '2026-07-16', markPrice: 45_000,
    profile: { ...BTC_SINGLE_ASSET_PAPER_PROFILE, entryGuardAdverseMove: 0.02, ...extra },
  });
  for (const lookback of [null, undefined, 0, -1, 1.5, Infinity, NaN, '3']) {
    assert.throws(() => initialize({ entryGuardLookbackDays: lookback }), /窗口无效/);
  }
  assert.throws(() => initialize({ entryGuardLookbackDays: 300 }), /预热不足/);
  assert.equal(initialize({ entryGuardLookbackDays: 3 }).lastEntryGuard.active, false);
});

test('研究过滤只使用决策时点已知行情，未来价格变化不影响此前决策', () => {
  const series = btcSeries('2025-11-01', '2026-08-01');
  for (const row of series.BTCUSDT) {
    const factor = { '2026-07-13': 0.98, '2026-07-14': 0.96, '2026-07-15': 0.94, '2026-07-16': 0.92 }[row.date];
    if (factor) row.close *= factor;
  }
  const altered = structuredClone(series);
  for (const [index, row] of altered.BTCUSDT.entries()) {
    if (row.date >= '2026-07-17') row.close = index % 2 ? 100 : 1_000_000;
  }
  const profile = {
    ...BTC_SINGLE_ASSET_PAPER_PROFILE, maximumWeightIncrease: 0.1,
    entryGuardLookbackDays: 3, entryGuardAdverseMove: 0.02,
    monthlyLossContinuationScale: 0.1,
  };
  const run = (seriesBySymbol) => {
    const state = initializeBtcPaperState({
      seriesBySymbol, cycleDate: '2026-07-16', markPrice: 45_000, profile,
      now: Date.parse('2026-07-16T01:00:00Z'),
    });
    advanceBtcPaperState({
      state, seriesBySymbol, markPricesByCycleDate: { '2026-07-17': 45_100 },
      throughCycleDate: '2026-07-17', now: Date.parse('2026-07-17T01:00:00Z'),
    });
    return state;
  };
  const before = run(series);
  const after = run(altered);
  assert.equal(before.lastEntryGuard.active, true);
  assert.equal(before.weight, 0);
  assert.deepEqual(after.reports, before.reports);
  assert.equal(after.equity, before.equity);
});

test('研究用月损继续交易对多空均保持绝对10%上限且不解除亏损锁', () => {
  for (const direction of [1, -1]) {
    const series = btcSeries('2025-11-01', '2026-07-18', direction * 0.002);
    const profile = {
      ...BTC_SINGLE_ASSET_PAPER_PROFILE,
      tradingCostRate: 0, dailyCarryCostRate: 0,
      monthlyLossContinuationScale: 0.1,
      trend: { ...BTC_SINGLE_ASSET_PAPER_PROFILE.trend, maxAssetExposure: 3, maxGrossExposure: 3 },
    };
    const state = initializeBtcPaperState({
      seriesBySymbol: series, cycleDate: '2026-07-16', markPrice: 45_000, profile,
    });
    assert.ok(Math.abs(state.weight) > 1);
    state.equity = state.monthStartEquity * 0.98;
    advanceBtcPaperState({
      state, seriesBySymbol: series,
      markPricesByCycleDate: { '2026-07-17': 45_000, '2026-07-18': 45_000 },
      throughCycleDate: '2026-07-18',
    });
    for (const report of state.reports.filter((item) => item.kind === 'daily')) {
      assert.equal(report.settledLockReason, 'loss');
      assert.equal(report.lockReason, 'loss');
      assert.equal(report.nextWeight, direction * 0.1);
      assert.ok(Math.abs(report.nextWeight) <= 0.1);
    }
    assert.equal(state.lockReason, 'loss');
    assert.equal(state.positions[0].side, direction > 0 ? 'LONG' : 'SHORT');
  }
});

test('月损继续交易拒绝超限或非数值比例', () => {
  const series = btcSeries('2025-11-01', '2026-07-16');
  for (const scale of [-0.01, 0.10001, 1, Infinity, NaN, '0.1']) {
    assert.throws(() => initializeBtcPaperState({
      seriesBySymbol: series, cycleDate: '2026-07-16', markPrice: 45_000,
      profile: { ...BTC_SINGLE_ASSET_PAPER_PROFILE, monthlyLossContinuationScale: scale },
    }), /敞口比例/);
  }
});

test('月损继续交易按原目标乘以配置比例，不把小仓位直接放大至上限', () => {
  for (const direction of [1, -1]) {
    const series = btcSeries('2025-11-01', '2026-07-17', direction * 0.002);
    for (const scale of [0, 0.05, 0.1]) {
      const profile = {
        ...BTC_SINGLE_ASSET_PAPER_PROFILE,
        tradingCostRate: 0, dailyCarryCostRate: 0,
        monthlyLossContinuationScale: scale,
        trend: { ...BTC_SINGLE_ASSET_PAPER_PROFILE.trend, maxAssetExposure: 0.4, maxGrossExposure: 0.4 },
      };
      const state = initializeBtcPaperState({
        seriesBySymbol: series, cycleDate: '2026-07-16', markPrice: 45_000, profile,
      });
      assert.equal(state.weight, direction * 0.4);
      state.equity = state.monthStartEquity * 0.98;
      advanceBtcPaperState({
        state, seriesBySymbol: series,
        markPricesByCycleDate: { '2026-07-17': 45_000 }, throughCycleDate: '2026-07-17',
      });
      assert.ok(Math.abs(state.weight - direction * 0.4 * scale) < 1e-12);
      assert.equal(state.lockReason, 'loss');
    }
  }
});
