import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addUtcDays, MONTHLY_ACCURACY_PAPER_PROFILE } from '../src/monthly-accuracy-paper.js';
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
  assert.deepEqual(
    review.candidates.map((item) => item.status),
    PAPER_SHADOW_PROFILES.map(() => 'collecting'),
  );
  assert.equal(review.candidates[0].metrics.observations, 2);
  assert.equal(review.latestAttribution.largestDetractor.symbol, 'ETHUSDT');
  assert.match(review.latestAttribution.diagnostics.join(' '), /横截面/);
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
