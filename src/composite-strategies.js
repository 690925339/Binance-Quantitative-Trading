import {
  evaluateAccuracyLeverage,
  STABLE_ACCURACY_LEVERAGE_DEFAULTS,
} from './accuracy-leverage.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export const COMPOSITE_STRATEGY_PROFILES = Object.freeze({
  stableComposite: Object.freeze({
    type: 'stableComposite',
    name: '稳健新闻趋势组合',
    priceSignalWeight: 75,
    newsSignalWeight: 25,
    minimumNewsCredibility: 75,
    minimumNewsConfidence: 65,
    minimumConfirmedArticles: 1,
    entryThreshold: 0.24,
    targetVolatilityPercent: 6,
    maxGrossExposurePercent: 30,
    maxAssetExposurePercent: 10,
    maxLeverage: 3,
    defaultLeverage: 1,
    portfolioDrawdownLimitPercent: 8,
    accuracyLeverage: STABLE_ACCURACY_LEVERAGE_DEFAULTS,
  }),
  aggressiveComposite: Object.freeze({
    type: 'aggressiveComposite',
    name: '进取新闻趋势组合',
    priceSignalWeight: 55,
    newsSignalWeight: 45,
    minimumNewsCredibility: 65,
    minimumNewsConfidence: 58,
    minimumConfirmedArticles: 1,
    entryThreshold: 0.18,
    targetVolatilityPercent: 15,
    maxGrossExposurePercent: 100,
    maxAssetExposurePercent: 25,
    maxLeverage: 5,
    defaultLeverage: 2,
    portfolioDrawdownLimitPercent: 20,
  }),
});

export function calculatePriceTrendScore(klines) {
  const closes = klines.map((item) => Number(Array.isArray(item) ? item[4] : item.close));
  if (closes.length < 127 || closes.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('价格趋势至少需要 127 根有效的 4 小时 K 线');
  }
  const current = closes.at(-1);
  const components = [
    { lookback: 6, scale: 0.03, label: '24小时' },
    { lookback: 42, scale: 0.08, label: '7天' },
    { lookback: 126, scale: 0.20, label: '21天' },
  ].map(({ lookback, scale, label }) => {
    const value = current / closes.at(-1 - lookback) - 1;
    return { label, return: value, score: Math.tanh(value / scale) };
  });
  const score = components.reduce((sum, item) => sum + item.score, 0) / components.length;
  return {
    score: Number(clamp(score, -1, 1).toFixed(4)),
    label: score > 0.12 ? '价格偏多' : score < -0.12 ? '价格偏空' : '价格中性',
    components: components.map((item) => ({ ...item, return: Number(item.return.toFixed(6)), score: Number(item.score.toFixed(4)) })),
  };
}

export function calculateCompositeSignal(profile, priceSignal, newsSummary, performance = null) {
  if (!profile || !Number.isFinite(priceSignal?.score)) throw new Error('组合策略价格信号无效');
  const qualifiedConfirmedArticleCount = (newsSummary?.confirmedAssessments || []).filter((item) => (
    item.credibility >= profile.minimumNewsCredibility
    && item.confidence >= profile.minimumNewsConfidence
    && item.evidenceStrength !== 'weak'
  )).length;
  const newsEligible = Boolean(
    newsSummary?.articleCount
    && newsSummary.credibility >= profile.minimumNewsCredibility
    && newsSummary.confidence >= profile.minimumNewsConfidence
    && qualifiedConfirmedArticleCount >= profile.minimumConfirmedArticles
  );
  const priceWeight = newsEligible ? profile.priceSignalWeight / 100 : 1;
  const newsWeight = newsEligible ? profile.newsSignalWeight / 100 : 0;
  const newsScore = newsEligible ? clamp(Number(newsSummary.score) || 0, -1, 1) : 0;
  const combinedScore = clamp(priceSignal.score * priceWeight + newsScore * newsWeight, -1, 1);
  const action = combinedScore >= profile.entryThreshold
    ? 'LONG'
    : combinedScore <= -profile.entryThreshold
      ? 'SHORT'
      : 'WAIT';
  const baseTargetGrossExposurePercent = action === 'WAIT'
    ? 0
    : profile.maxGrossExposurePercent * Math.min(1, Math.abs(combinedScore));
  const accuracyLeverage = profile.accuracyLeverage
    ? evaluateAccuracyLeverage({ strategyType: profile.type, ...(performance || {}) }, profile.accuracyLeverage)
    : null;
  const appliedLeverage = accuracyLeverage?.appliedLeverage || 1;
  const targetGrossExposurePercent = baseTargetGrossExposurePercent * appliedLeverage;
  return {
    strategyType: profile.type,
    strategyName: profile.name,
    action,
    actionLabel: action === 'LONG' ? '偏多' : action === 'SHORT' ? '偏空' : '观望',
    combinedScore: Number(combinedScore.toFixed(4)),
    priceScore: priceSignal.score,
    newsScore,
    appliedWeights: {
      pricePercent: Math.round(priceWeight * 100),
      newsPercent: Math.round(newsWeight * 100),
    },
    newsEligible,
    newsGate: {
      credibility: newsSummary?.credibility || 0,
      confidence: newsSummary?.confidence || 0,
      minimumCredibility: profile.minimumNewsCredibility,
      minimumConfidence: profile.minimumNewsConfidence,
      confirmedArticleCount: newsSummary?.confirmedArticleCount || 0,
      qualifiedConfirmedArticleCount,
      minimumConfirmedArticles: profile.minimumConfirmedArticles,
    },
    risk: {
      targetVolatilityPercent: profile.targetVolatilityPercent,
      maxGrossExposurePercent: profile.maxGrossExposurePercent,
      effectiveMaxGrossExposurePercent: Number((profile.maxGrossExposurePercent * appliedLeverage).toFixed(2)),
      baseTargetGrossExposurePercent: Number(baseTargetGrossExposurePercent.toFixed(2)),
      targetGrossExposurePercent: Number(targetGrossExposurePercent.toFixed(2)),
      maxLeverage: profile.maxLeverage,
      appliedLeverage,
      accuracyLeverage,
      portfolioDrawdownLimitPercent: profile.portfolioDrawdownLimitPercent,
    },
  };
}
