import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateCompositeSignal,
  calculatePriceTrendScore,
  COMPOSITE_STRATEGY_PROFILES,
} from '../src/composite-strategies.js';

function priceSeries(multiplier) {
  return Array.from({ length: 140 }, (_, index) => ({ close: 100 * (multiplier ** index) }));
}

test('价格趋势分数能区分上涨与下跌行情', () => {
  assert.ok(calculatePriceTrendScore(priceSeries(1.002)).score > 0.5);
  assert.ok(calculatePriceTrendScore(priceSeries(0.998)).score < -0.5);
});

test('高可信新闻按组合档位参与权重并影响最终方向', () => {
  const priceSignal = { score: 0.2 };
  const news = {
    score: 0.8,
    credibility: 88,
    confidence: 82,
    articleCount: 4,
    confirmedArticleCount: 2,
    confirmedAssessments: [{ credibility: 92, confidence: 85, evidenceStrength: 'strong' }],
  };
  const stable = calculateCompositeSignal(COMPOSITE_STRATEGY_PROFILES.stableComposite, priceSignal, news);
  const aggressive = calculateCompositeSignal(COMPOSITE_STRATEGY_PROFILES.aggressiveComposite, priceSignal, news);

  assert.deepEqual(stable.appliedWeights, { pricePercent: 75, newsPercent: 25 });
  assert.deepEqual(aggressive.appliedWeights, { pricePercent: 55, newsPercent: 45 });
  assert.ok(aggressive.combinedScore > stable.combinedScore);
  assert.equal(aggressive.action, 'LONG');
});

test('新闻低于可信度门槛时自动退化为纯价格信号', () => {
  const result = calculateCompositeSignal(
    COMPOSITE_STRATEGY_PROFILES.stableComposite,
    { score: -0.5 },
    {
      score: 1,
      credibility: 60,
      confidence: 90,
      articleCount: 8,
      confirmedArticleCount: 2,
      confirmedAssessments: [{ credibility: 60, confidence: 90, evidenceStrength: 'strong' }],
    },
  );
  assert.equal(result.newsEligible, false);
  assert.deepEqual(result.appliedWeights, { pricePercent: 100, newsPercent: 0 });
  assert.equal(result.combinedScore, -0.5);
  assert.equal(result.action, 'SHORT');
});

test('没有官方确认时即使媒体评分很高也退化为纯价格信号', () => {
  const result = calculateCompositeSignal(
    COMPOSITE_STRATEGY_PROFILES.aggressiveComposite,
    { score: 0.3 },
    { score: -1, credibility: 95, confidence: 95, articleCount: 12, confirmedArticleCount: 0, confirmedAssessments: [] },
  );
  assert.equal(result.newsEligible, false);
  assert.deepEqual(result.appliedWeights, { pricePercent: 100, newsPercent: 0 });
  assert.equal(result.combinedScore, 0.3);
});

test('官方已确认但证据强度弱时不允许新闻进入组合', () => {
  const result = calculateCompositeSignal(
    COMPOSITE_STRATEGY_PROFILES.stableComposite,
    { score: 0.25 },
    {
      score: 1,
      credibility: 90,
      confidence: 90,
      articleCount: 5,
      confirmedArticleCount: 1,
      confirmedAssessments: [{ credibility: 90, confidence: 90, evidenceStrength: 'weak' }],
    },
  );
  assert.equal(result.newsEligible, false);
  assert.equal(result.newsGate.qualifiedConfirmedArticleCount, 0);
  assert.deepEqual(result.appliedWeights, { pricePercent: 100, newsPercent: 0 });
});

test('稳健组合只有历史准确率和低风险门槛全部达标才应用 1.25 倍敞口', () => {
  const priceSignal = { score: 0.6 };
  const withoutHistory = calculateCompositeSignal(
    COMPOSITE_STRATEGY_PROFILES.stableComposite,
    priceSignal,
    null,
  );
  const qualified = calculateCompositeSignal(
    COMPOSITE_STRATEGY_PROFILES.stableComposite,
    priceSignal,
    null,
    {
      settledSignalCount: 100,
      correctSignalCount: 90,
      recentSignalCount: 20,
      recentCorrectSignalCount: 18,
      annualizedVolatility: 0.06,
      currentDrawdown: -0.03,
    },
  );
  assert.equal(withoutHistory.risk.appliedLeverage, 1);
  assert.equal(qualified.risk.appliedLeverage, 1.25);
  assert.equal(
    qualified.risk.targetGrossExposurePercent,
    Number((withoutHistory.risk.targetGrossExposurePercent * 1.25).toFixed(2)),
  );
  assert.equal(qualified.risk.effectiveMaxGrossExposurePercent, 37.5);
});
