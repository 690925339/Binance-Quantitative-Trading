import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addUtcDays,
  MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE,
  MONTHLY_ACCURACY_PAPER_PROFILE,
} from '../src/monthly-accuracy-paper.js';
import {
  buildPaperStrategyReview,
  PAPER_SHADOW_PROFILES,
} from '../src/paper-strategy-review.js';

function initialization(profile, cycleDate, dayReturn = -0.001) {
  return {
    id: `${profile.id}-${cycleDate}-initial`,
    kind: 'initialization',
    cycleDate,
    dayReturn,
    dayPnl: dayReturn * 10_000,
    positions: [{ symbol: 'BTCUSDT', weight: 0.2 }],
    modelGrossExposure: 1,
  };
}

function daily(profile, cycleDate, dayReturn, withAttribution = false) {
  return {
    id: `${profile.id}-${cycleDate}`,
    kind: 'daily',
    cycleDate,
    dayReturn,
    dayPnl: dayReturn * 10_000,
    pricePnl: dayReturn * 10_000,
    tradingCost: 0,
    carryCost: 0,
    positions: [{ symbol: 'BTCUSDT', weight: 0.2 }],
    modelGrossExposure: 1,
    ...(withAttribution ? {
      componentAttribution: {
        marketNeutral: { totalPnl: -30, pricePnl: -30, tradingCost: 0, carryCost: 0 },
        trend: { totalPnl: 10, pricePnl: 10, tradingCost: 0, carryCost: 0 },
      },
      symbolAttribution: [
        {
          symbol: 'ETHUSDT',
          assetReturn: -0.02,
          marketNeutralWeight: 0.5,
          trendWeight: -0.02,
          marketNeutralPricePnl: -100,
          trendPricePnl: 4,
          totalPricePnl: -96,
        },
        {
          symbol: 'SOLUSDT',
          assetReturn: -0.01,
          marketNeutralWeight: -0.5,
          trendWeight: -0.02,
          marketNeutralPricePnl: 50,
          trendPricePnl: 2,
          totalPricePnl: 52,
        },
      ],
    } : {}),
  };
}

function stateFor(profile, {
  startCycleDate = '2024-01-01',
  observations = 0,
  dailyReturn = 0.0002,
  entryReturn = -0.001,
  attribution = false,
} = {}) {
  const reports = [initialization(profile, startCycleDate, entryReturn)];
  for (let index = 1; index <= observations; index += 1) {
    reports.push(daily(
      profile,
      addUtcDays(startCycleDate, index),
      dailyReturn,
      attribution && index === observations,
    ));
  }
  const latestReport = reports.at(-1);
  return {
    version: 1,
    mode: 'PAPER',
    status: 'running',
    strategyProfileId: profile.id,
    strategyName: profile.name,
    startedAt: `${startCycleDate}T01:00:00.000Z`,
    startCycleDate,
    lastCycleDate: latestReport.cycleDate,
    firstFullMonth: addUtcDays(`${startCycleDate.slice(0, 7)}-01`, 32).slice(0, 7),
    initialCapital: 10_000,
    equity: 10_000,
    reports,
    latestReport,
  };
}

test('共同结算期比较排除不同启动日的初始化费用且不改写账本', () => {
  const profile = PAPER_SHADOW_PROFILES.find(p => p.id === 'shadow-continuous-diversified-capped-v1');
  const baseline = stateFor(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, {
    observations: 5, dailyReturn: 0.001, entryReturn: -0.05,
  });
  const candidate = stateFor(profile, {
    startCycleDate: '2024-01-03', observations: 3, dailyReturn: 0.001, entryReturn: -0.01,
  });
  const before = JSON.stringify([baseline, candidate]);
  const result = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [candidate] })
    .candidates.find(p => p.id === profile.id);
  assert.equal(result.metrics.observations, 3);
  assert.equal(result.metrics.totalReturn, 0.003003);
  assert.equal(result.metrics.baselineTotalReturn, 0.003003);
  assert.equal(result.metrics.pairedExcessReturn, 0);
  assert.equal(result.comparison.initializationFeesIncluded, false);
  assert.equal(result.comparison.candidateInitializationCostReturn, -0.01);
  assert.equal(result.comparison.baselineInitializationCostReturn, -0.05);
  assert.equal(result.comparison.startCycleDate, '2024-01-04');
  assert.equal(JSON.stringify([baseline, candidate]), before);
});

test('价差风控与同日对照配对而非旧主盘，对照不参与候选试验数量', () => {
  const profile = PAPER_SHADOW_PROFILES.find(p => p.comparisonControlId);
  const controlProfile = PAPER_SHADOW_PROFILES.find(p => p.id === profile.comparisonControlId);
  const baseline = stateFor(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, { observations: 3, dailyReturn: 0.1 });
  const candidate = stateFor(profile, { observations: 3, dailyReturn: 0.001 });
  const control = stateFor(controlProfile, { observations: 3, dailyReturn: 0.001 });
  candidate.reports[1].settledLocks = { trend: 'loss' };
  candidate.reports[2].settledProfitDeRisk = { marketNeutral: { scale: 0.1 } };
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [candidate, control] });
  const result = review.candidates.find(p => p.id === profile.id);
  assert.equal(result.metrics.pairedExcessReturn, 0);
  assert.equal(result.comparison.benchmarkId, controlProfile.id);
  assert.equal(result.comparison.synchronizedControl, true);
  assert.deepEqual(result.comparison.riskStateMismatchDates, ['2024-01-02', '2024-01-03']);
  assert.equal(result.comparison.riskStateMismatchDays, 2);
  assert.equal(review.candidates.some(p => p.id === controlProfile.id), false);
  assert.equal(review.trialCount, PAPER_SHADOW_PROFILES.filter(p => p.role !== 'control').length);
});

test('同期对照缺失或启动日不同不回退到旧主盘做晋级判断', () => {
  const profile = PAPER_SHADOW_PROFILES.find(p => p.comparisonControlId);
  const controlProfile = PAPER_SHADOW_PROFILES.find(p => p.id === profile.comparisonControlId);
  const baseline = stateFor(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, { observations: 3 });
  const candidate = stateFor(profile, { observations: 3 });
  const mismatchedControl = stateFor(controlProfile, { startCycleDate: '2024-01-02', observations: 2 });
  for (const shadowStates of [[candidate], [candidate, mismatchedControl]]) {
    const result = buildPaperStrategyReview({ baselineState: baseline, shadowStates })
      .candidates.find(p => p.id === profile.id);
    assert.equal(result.metrics, undefined);
    assert.match(result.statusReason, /同期对照账本缺失或启动日不一致/);
  }
});

test('影子候选启动后保持独立ID，并在小样本阶段只采样不晋级', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_PAPER_PROFILE, {
    observations: 2,
    dailyReturn: 0.001,
    attribution: true,
  });
  const shadows = PAPER_SHADOW_PROFILES.map((profile) => stateFor(profile, {
    observations: 2,
    dailyReturn: 0.0011,
  }));
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: shadows });
  assert.equal(review.baseline.frozen, true);
  assert.equal(review.promotionMode, 'MANUAL_REVIEW_ONLY');
  const legacyCandidates = review.candidates.filter((item) => (
    item.profile.baselineProfileId === MONTHLY_ACCURACY_PAPER_PROFILE.id
  ));
  const continuousCandidate = review.candidates.find((item) => (
    item.id === 'shadow-continuous-diversified-v1'
  ));
  assert.ok(legacyCandidates.every((item) => item.status === 'collecting'));
  assert.equal(continuousCandidate.status, 'archived');
  assert.equal(review.candidates[0].metrics.observations, 2);
  assert.equal(review.latestAttribution.largestDetractor.symbol, 'ETHUSDT');
  assert.match(review.latestAttribution.diagnostics.join(' '), /横截面/);
});

test('当前v3基准只统计迁移后epoch，旧影子归档且同源分散影子重新起跑', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, {
    observations: 5,
    dailyReturn: 0.001,
  });
  baseline.strategyChanges = [{
    fromProfileId: MONTHLY_ACCURACY_PAPER_PROFILE.id,
    toProfileId: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.id,
    effectiveFromCycleDate: '2024-01-04',
  }];
  for (const report of baseline.reports.filter((item) => item.kind === 'daily')) {
    report.strategyProfileId = report.cycleDate >= '2024-01-04'
      ? MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.id
      : MONTHLY_ACCURACY_PAPER_PROFILE.id;
  }
  const continuousProfile = PAPER_SHADOW_PROFILES.find((item) => (
    item.id === 'shadow-continuous-diversified-v1'
  ));
  const continuousShadow = stateFor(continuousProfile, {
    observations: 5,
    dailyReturn: 0.0009,
  });
  const legacyProfile = PAPER_SHADOW_PROFILES.find((item) => (
    item.baselineProfileId === MONTHLY_ACCURACY_PAPER_PROFILE.id
  ));
  const legacyShadow = stateFor(legacyProfile, {
    observations: 5,
    dailyReturn: 0.0011,
  });

  const review = buildPaperStrategyReview({
    baselineState: baseline,
    shadowStates: [continuousShadow, legacyShadow],
  });
  const continuousResult = review.candidates.find((item) => item.id === continuousProfile.id);
  const legacyResult = review.candidates.find((item) => item.id === legacyProfile.id);
  const continuousNewsResult = review.candidates.find((item) => (
    item.id === 'shadow-continuous-news-specific-risk-v1'
  ));

  assert.equal(review.baseline.epochStartCycleDate, '2024-01-04');
  assert.equal(review.baseline.firstFullMonth, '2024-02');
  assert.equal(review.baseline.metrics.observations, 3);
  assert.equal(review.baseline.metrics.directionalHits, 3);
  assert.equal(review.baseline.metrics.directionalHitRate, 1);
  assert.equal(review.accuracyComparison.previousStrategies.directionalHits, 2);
  assert.equal(review.accuracyComparison.currentStrategy.directionalHits, 3);
  assert.match(review.accuracyComparison.definition.directionalHitRate, /价格盈亏/);
  assert.equal(continuousResult.status, 'collecting');
  assert.equal(continuousResult.metrics.observations, 3);
  assert.equal(continuousNewsResult.status, 'not_started');
  assert.equal(continuousNewsResult.profile.newsOverlay.newsWeightMode, 'risk_veto');
  assert.equal(
    continuousNewsResult.profile.newsOverlay.riskEvidenceMode,
    'confirmed_or_independent_event',
  );
  assert.equal(legacyResult.status, 'archived');
  assert.equal(legacyResult.metrics.pairedExcessReturn, null);
  assert.match(legacyResult.statusReason, /保留历史账本但停止晋级比较/);
  assert.equal(continuousProfile.marketNeutral.monthlyProfitDeRiskScale, 0.1);
  assert.equal(continuousProfile.marketNeutral.positionsPerSide, 2);
});

test('正确率对比会区分空仓持平日、活跃盈利日和价格方向命中', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, {
    observations: 3,
    dailyReturn: 0.001,
  });
  const reports = baseline.reports.filter((item) => item.kind === 'daily');
  reports[1].dayReturn = 0;
  reports[1].dayPnl = 0;
  reports[1].pricePnl = 0;
  reports[1].modelGrossExposure = 0;
  reports[1].positions = [];
  reports[2].dayReturn = -0.001;
  reports[2].dayPnl = -10;
  reports[2].pricePnl = -10;

  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [] });
  const metrics = review.accuracyComparison.currentStrategy;
  assert.equal(metrics.observations, 3);
  assert.equal(metrics.profitableDays, 1);
  assert.equal(metrics.activeDayObservations, 2);
  assert.equal(metrics.activeProfitableDays, 1);
  assert.equal(metrics.directionalObservations, 2);
  assert.equal(metrics.directionalHits, 1);
  assert.equal(metrics.directionalHitRate, 0.5);
});

test('趋势月度锁定后复盘会提示横截面独自承担主要风险', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_PAPER_PROFILE, {
    observations: 2,
    dailyReturn: -0.002,
    attribution: true,
  });
  baseline.latestReport.settledLocks = { marketNeutral: null, trend: 'profit' };
  const shadows = PAPER_SHADOW_PROFILES.map((profile) => stateFor(profile, {
    observations: 2,
    dailyReturn: -0.001,
  }));
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: shadows });
  assert.equal(review.latestAttribution.trendLockReason, 'profit');
  assert.match(review.latestAttribution.diagnostics.join(' '), /趋势子策略已触发月度止盈锁定/);
});

test('双子策略止盈后复盘会记录连续空仓和本月锁定收益', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_PAPER_PROFILE, {
    observations: 3,
    dailyReturn: 0.001,
    attribution: true,
  });
  const reports = baseline.reports.filter((report) => report.kind === 'daily');
  for (const report of reports.slice(-2)) {
    report.settledLocks = { marketNeutral: 'profit', trend: 'profit' };
    report.modelGrossExposure = 0;
    report.positions = [];
  }
  baseline.components = {
    marketNeutral: {
      baseWeights: { ETHUSDT: 0.5, SOLUSDT: -0.5 },
    },
  };
  baseline.profileSnapshot = MONTHLY_ACCURACY_PAPER_PROFILE;
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [] });
  assert.deepEqual(review.monthlyLockReview, {
    month: '2024-01',
    marketNeutralLockReason: 'profit',
    trendLockReason: 'profit',
    bothProfitLocked: true,
    bothProfitLockedSince: '2024-01-03',
    consecutiveIdleDays: 2,
    monthToDatePnl: 30,
    monthToDateReturn: 0.003003,
    currentGrossExposure: 0,
    profitLocksEnabled: true,
    profitDeRisk: {
      marketNeutral: null,
      trend: null,
    },
    pendingStrategyChange: null,
    lockedMarketNeutralHoldCounterfactual: {
      method: 'frozen_market_neutral_weights_after_dual_lock',
      observations: 1,
      grossExposure: 1,
      componentReturn: -0.00505,
      portfolioReturn: -0.0042925,
      portfolioPnl: -42.925,
    },
  });
  assert.match(review.latestAttribution.diagnostics.join(' '), /连续空仓 2 个结算日/);
  assert.match(review.latestAttribution.diagnostics.join(' '), /事后代理收益/);
});

test('持续交易降风险启用后复盘会说明保留敞口而非盈利空仓', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_PAPER_PROFILE, {
    observations: 2,
    dailyReturn: 0.001,
    attribution: true,
  });
  baseline.profileSnapshot = {
    ...MONTHLY_ACCURACY_PAPER_PROFILE,
    marketNeutral: { ...MONTHLY_ACCURACY_PAPER_PROFILE.marketNeutral, monthlyProfitLock: null },
    trend: { ...MONTHLY_ACCURACY_PAPER_PROFILE.trend, monthlyProfitLock: null },
  };
  baseline.components = {
    marketNeutral: {
      lockReason: null,
      lastProfitDeRisk: { active: true, scale: 0.1, threshold: 0.0075 },
    },
    trend: {
      lockReason: null,
      lastProfitDeRisk: { active: true, scale: 0.1, threshold: 0.01 },
    },
  };
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [] });
  assert.equal(review.monthlyLockReview.profitLocksEnabled, false);
  assert.equal(review.monthlyLockReview.profitDeRisk.marketNeutral.active, true);
  assert.match(review.latestAttribution.diagnostics.join(' '), /保留10%敞口/);
});

test('趋势空头遇到多标的同步上涨时复盘会标明反向行情', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_PAPER_PROFILE, {
    observations: 2,
    dailyReturn: -0.01,
    attribution: true,
  });
  baseline.latestReport.componentAttribution.trend.totalPnl = -120;
  for (const item of baseline.latestReport.symbolAttribution) {
    item.assetReturn = 0.08;
    item.trendPricePnl = -60;
    item.totalPricePnl = -60;
  }
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [] });
  assert.match(review.latestAttribution.diagnostics.join(' '), /同步上涨标的/);
});

test('高换手日复盘会拆分价格收益、成本拖累和子策略换手', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_PAPER_PROFILE, {
    observations: 2,
    dailyReturn: 0.001,
    attribution: true,
  });
  baseline.latestReport.pricePnl = 26;
  baseline.latestReport.dayPnl = 12;
  baseline.latestReport.tradingCost = 13;
  baseline.latestReport.carryCost = 1;
  baseline.latestReport.turnover = { marketNeutral: 2.1, trend: 0.8 };
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [] });
  assert.equal(review.latestAttribution.costShareOfAbsolutePricePnl, 0.53846154);
  assert.equal(review.latestAttribution.tradingCostShareOfAbsolutePricePnl, 0.5);
  assert.deepEqual(review.latestAttribution.turnover, {
    marketNeutral: 2.1,
    trend: 0.8,
    total: 2.9,
  });
  assert.match(review.latestAttribution.diagnostics.join(' '), /本次调仓总换手 2.90 倍/);
});

test('新闻影子会统计真实触发天数而不是把价格回退当作新闻贡献', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_PAPER_PROFILE, {
    observations: 3,
    dailyReturn: 0.001,
  });
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-adaptive-v1');
  const candidate = stateFor(profile, {
    observations: 3,
    dailyReturn: 0.0011,
  });
  const reports = candidate.reports.filter((report) => report.kind === 'daily');
  reports[0].settledNewsOverlay = {
    enabled: true,
    fallbackToPriceOnly: true,
    fallbackReason: '新闻未通过门槛',
    appliedNewsWeightPercent: 0,
  };
  reports[1].settledNewsOverlay = {
    enabled: true,
    fallbackToPriceOnly: false,
    appliedNewsWeightPercent: 18,
  };
  reports[2].settledNewsOverlay = {
    enabled: true,
    fallbackToPriceOnly: true,
    fallbackReason: '新闻未通过门槛',
    appliedNewsWeightPercent: 0,
  };
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [candidate] });
  const result = review.candidates.find((item) => item.id === profile.id);
  assert.deepEqual(result.newsEvidence, {
    evaluatedDays: 3,
    liveDays: 0,
    staleDays: 0,
    unavailableDays: 0,
    missingDays: 3,
    liveCoverageRatio: 0,
    activeDays: 1,
    fallbackDays: 2,
    activationRatio: 0.33333333,
    averageAppliedNewsWeightPercent: 6,
    riskVetoDays: 0,
    averageAppliedRiskGrossExposureScale: 1,
    dominantFallbackReason: '新闻未通过门槛',
  });
});

test('新闻风险影子把降敞口计为风控触发而不是方向新闻权重', () => {
  const baseline = stateFor(MONTHLY_ACCURACY_PAPER_PROFILE, {
    observations: 2,
    dailyReturn: 0.001,
  });
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-risk-veto-v1');
  const candidate = stateFor(profile, {
    observations: 2,
    dailyReturn: 0.0008,
  });
  const reports = candidate.reports.filter((report) => report.kind === 'daily');
  reports[0].settledNewsOverlay = {
    enabled: true,
    fallbackToPriceOnly: false,
    appliedNewsWeightPercent: 0,
    riskVetoTriggered: true,
    appliedRiskGrossExposureScale: 0.75,
  };
  reports[1].settledNewsOverlay = {
    enabled: true,
    fallbackToPriceOnly: true,
    fallbackReason: '没有持仓方向冲突',
    appliedNewsWeightPercent: 0,
    riskVetoTriggered: false,
    appliedRiskGrossExposureScale: 1,
  };
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [candidate] });
  const result = review.candidates.find((item) => item.id === profile.id);
  assert.equal(result.newsEvidence.activeDays, 1);
  assert.equal(result.newsEvidence.riskVetoDays, 1);
  assert.equal(result.newsEvidence.activationRatio, 0.5);
  assert.equal(result.newsEvidence.averageAppliedNewsWeightPercent, 0);
  assert.equal(result.newsEvidence.averageAppliedRiskGrossExposureScale, 0.875);
});

test('长期前向指标全部达标也只标记为人工晋级复核', () => {
  const observations = 580;
  const baseline = stateFor(MONTHLY_ACCURACY_PAPER_PROFILE, {
    observations,
    dailyReturn: 0.00025,
    entryReturn: -0.0015,
  });
  const promotedProfile = PAPER_SHADOW_PROFILES[0];
  const candidate = stateFor(promotedProfile, {
    observations,
    dailyReturn: 0.0004,
    entryReturn: -0.0012,
  });
  const review = buildPaperStrategyReview({ baselineState: baseline, shadowStates: [candidate] });
  const result = review.candidates.find((item) => item.id === promotedProfile.id);
  assert.equal(result.status, 'promotable');
  assert.ok(result.metrics.fullMonthCount >= 18);
  assert.ok(result.metrics.positiveMonthRatio >= 0.8);
  assert.ok(result.metrics.annualizedReturn >= 0.10);
  assert.equal(review.baseline.id, MONTHLY_ACCURACY_PAPER_PROFILE.id);
  assert.equal(review.baseline.frozen, true);
});
