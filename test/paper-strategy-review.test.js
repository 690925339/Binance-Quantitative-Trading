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
