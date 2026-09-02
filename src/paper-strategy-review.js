import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  addUtcDays,
  MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE,
  MONTHLY_ACCURACY_PAPER_PROFILE,
} from './monthly-accuracy-paper.js';

const DAY_MS = 86_400_000;
const BASELINE_ENTRY_REPORT_KIND = 'initialization';

function frozenProfile(overrides) {
  return Object.freeze({
    ...MONTHLY_ACCURACY_PAPER_PROFILE,
    baselineProfileId: MONTHLY_ACCURACY_PAPER_PROFILE.id,
    ...overrides,
    marketNeutral: Object.freeze({
      ...MONTHLY_ACCURACY_PAPER_PROFILE.marketNeutral,
      ...(overrides.marketNeutral || {}),
    }),
    trend: Object.freeze({
      ...MONTHLY_ACCURACY_PAPER_PROFILE.trend,
      ...(overrides.trend || {}),
    }),
    newsOverlay: overrides.newsOverlay
      ? Object.freeze({ ...overrides.newsOverlay })
      : null,
  });
}

function frozenContinuousProfile(overrides) {
  return Object.freeze({
    ...MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE,
    baselineProfileId: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.id,
    ...overrides,
    marketNeutral: Object.freeze({
      ...MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.marketNeutral,
      ...(overrides.marketNeutral || {}),
    }),
    trend: Object.freeze({
      ...MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.trend,
      ...(overrides.trend || {}),
    }),
    newsOverlay: overrides.newsOverlay
      ? Object.freeze({ ...overrides.newsOverlay })
      : null,
  });
}

export const PAPER_SHADOW_PROFILES = Object.freeze([
  frozenProfile({
    id: 'shadow-stable-cash-85-v1',
    name: '稳健影子｜85%横截面＋15%现金',
    role: 'stable',
    hypothesis: '用15%现金缓冲降低组合回撤，只检验资金分配变化。',
    marketNeutralWeight: 0.85,
    trendWeight: 0,
    cashWeight: 0.15,
  }),
  frozenProfile({
    id: 'shadow-diversified-cross-2-v1',
    name: '分散影子｜横截面每侧2个标的',
    role: 'risk_adjusted',
    hypothesis: '把横截面多空腿由各1个标的扩到各2个，检验单一价差集中风险。',
    marketNeutral: {
      positionsPerSide: 2,
    },
    cashWeight: 0,
  }),
  frozenProfile({
    id: 'shadow-news-45-v1',
    name: '新闻增强影子｜价格55%＋新闻45%',
    role: 'news_enhanced',
    hypothesis: '只在高可信、方向明确且官方确认的新闻出现时，以45%新闻分数调整横截面排名。',
    newsOverlay: {
      enabled: true,
      priceSignalWeight: 55,
      newsSignalWeight: 45,
      minimumNewsCredibility: 75,
      minimumNewsConfidence: 65,
      minimumConfirmedArticles: 1,
      minimumAbsoluteScore: 0.12,
    },
    cashWeight: 0,
  }),
  frozenProfile({
    id: 'shadow-news-adaptive-v1',
    name: '新闻质量影子｜自适应0%至45%',
    role: 'news_quality_weighted',
    hypothesis: '新闻刚过准入门槛时降低影响，仅让高可信、高置信且方向强的消息逐步接近45%权重。',
    newsOverlay: {
      enabled: true,
      newsWeightMode: 'quality',
      priceSignalWeight: 55,
      newsSignalWeight: 45,
      directionStrengthFullWeight: 0.50,
      minimumNewsCredibility: 75,
      minimumNewsConfidence: 65,
      minimumConfirmedArticles: 1,
      minimumAbsoluteScore: 0.12,
    },
    cashWeight: 0,
  }),
  frozenProfile({
    id: 'shadow-news-risk-veto-v1',
    name: '新闻风控影子｜方向冲突时敞口75%',
    role: 'news_risk_veto',
    hypothesis: '中等质量新闻不直接决定多空，只在与价格持仓方向冲突时将横截面总敞口降至75%。',
    newsOverlay: {
      enabled: true,
      newsWeightMode: 'risk_veto',
      priceSignalWeight: 100,
      newsSignalWeight: 0,
      minimumNewsCredibility: 75,
      minimumNewsConfidence: 65,
      minimumConfirmedArticles: 1,
      minimumAbsoluteScore: 0.12,
      riskVetoEnabled: true,
      riskMinimumCredibility: 65,
      riskMinimumConfidence: 50,
      riskMinimumArticleCount: 3,
      riskMinimumAbsoluteScore: 0.15,
      riskGrossExposureScale: 0.75,
    },
    cashWeight: 0,
  }),
  frozenProfile({
    id: 'shadow-news-specific-risk-v1',
    name: '新闻专属风控影子｜仅标的新闻冲突时敞口75%',
    role: 'news_specific_risk_veto',
    hypothesis: '排除泛市场新闻，仅在标的专属新闻与价格持仓方向冲突时缩减横截面敞口，减少伪相关误触发。',
    newsOverlay: {
      enabled: true,
      newsWeightMode: 'risk_veto',
      priceSignalWeight: 100,
      newsSignalWeight: 0,
      minimumNewsCredibility: 75,
      minimumNewsConfidence: 65,
      minimumConfirmedArticles: 1,
      minimumAbsoluteScore: 0.12,
      riskVetoEnabled: true,
      riskSignalScope: 'symbol_specific',
      riskMinimumCredibility: 65,
      riskMinimumConfidence: 50,
      riskMinimumArticleCount: 3,
      riskMinimumAbsoluteScore: 0.15,
      riskGrossExposureScale: 0.75,
    },
    cashWeight: 0,
  }),
  frozenContinuousProfile({
    id: 'shadow-continuous-diversified-v1',
    name: '持续降风险分散影子｜横截面每侧2个',
    role: 'risk_adjusted',
    hypothesis: '在持续交易降风险v3上，只把横截面多空腿从每侧1个扩到2个，验证能否降低单腿挤压风险。',
    marketNeutral: {
      positionsPerSide: 2,
    },
    cashWeight: 0,
  }),
  frozenContinuousProfile({
    id: 'shadow-continuous-news-specific-risk-v1',
    name: '持续降风险新闻影子｜标的事件冲突减仓',
    role: 'news_specific_risk_veto',
    hypothesis: '在持续交易降风险v3上，只启用标的专属高可信新闻冲突减仓，检验新闻风控能否降低错误方向的尾部损失。',
    newsOverlay: {
      enabled: true,
      newsWeightMode: 'risk_veto',
      priceSignalWeight: 100,
      newsSignalWeight: 0,
      minimumNewsCredibility: 75,
      minimumNewsConfidence: 65,
      minimumConfirmedArticles: 1,
      minimumAbsoluteScore: 0.12,
      riskVetoEnabled: true,
      riskSignalScope: 'symbol_specific',
      riskEvidenceMode: 'confirmed_or_independent_event',
      riskMinimumCredibility: 65,
      riskMinimumConfidence: 50,
      riskMinimumArticleCount: 3,
      riskMinimumAbsoluteScore: 0.15,
      riskGrossExposureScale: 0.75,
    },
    cashWeight: 0,
  }),
]);

export const PAPER_REVIEW_POLICY = Object.freeze({
  review: Object.freeze({
    minPairedDays: 90,
    minFullMonths: 3,
    minDataCoverage: 0.995,
  }),
  promotion: Object.freeze({
    minPairedDays: 540,
    minFullMonths: 18,
    minPositiveMonthRatio: 0.80,
    minPositiveMonths: 15,
    minMonthlyWilson95Lower: 0.60,
    minNetCagr: 0.10,
    maxAdjustedBootstrapP: 0.10,
    bootstrapSamples: 5_000,
    bootstrapBlockDays: 7,
    maxDrawdownMagnitude: 0.12,
    maxDrawdownWorsening: 0.01,
    maxAnnualizedVolatility: 0.15,
    maxVolatilityWorsening: 0.01,
    maxExpectedShortfallWorsening: 0.10,
    maxPeakGrossExposure: 1.50,
    maxP95AssetExposure: 0.40,
  }),
  rejection: Object.freeze({
    hardDrawdownMagnitude: 0.15,
    hardOneDayLoss: 0.05,
    earlyReviewDays: 180,
    maxDrawdownWorsening: 0.02,
  }),
});

function round(value, digits = 8) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0)
    / (values.length - 1));
}

function compound(values, initial = 1) {
  return values.reduce((equity, value) => equity * (1 + value), initial);
}

function daysBetween(startDate, endDate) {
  return Math.round((Date.parse(`${endDate}T00:00:00.000Z`)
    - Date.parse(`${startDate}T00:00:00.000Z`)) / DAY_MS);
}

function percentile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index];
}

function expectedShortfall95(returns) {
  if (!returns.length) return 0;
  const sorted = [...returns].sort((left, right) => left - right);
  const count = Math.max(1, Math.ceil(sorted.length * 0.05));
  return Math.max(0, -mean(sorted.slice(0, count)));
}

function wilsonLower(successes, observations, z = 1.959963984540054) {
  if (!observations) return 0;
  const ratio = successes / observations;
  const denominator = 1 + ((z ** 2) / observations);
  const centre = ratio + ((z ** 2) / (2 * observations));
  const margin = z * Math.sqrt(
    (ratio * (1 - ratio) / observations) + ((z ** 2) / (4 * (observations ** 2))),
  );
  return (centre - margin) / denominator;
}

function dailyReports(state) {
  return (state?.reports || [])
    .filter((report) => report.kind === 'daily')
    .sort((left, right) => left.cycleDate.localeCompare(right.cycleDate));
}

function reportMetricPoint(report) {
  const startingEquity = Number(report?.startingEquity || 0);
  const pricePnl = Number(report?.pricePnl || 0);
  const directionalReturn = startingEquity > 0
    ? pricePnl / startingEquity
    : pricePnl;
  const active = Math.abs(pricePnl) > 1e-12
    || Number(report?.carryCost || 0) > 0
    || Number(report?.tradingCost || 0) > 0;
  return {
    date: report.cycleDate,
    return: Number(report.dayReturn),
    directionalReturn,
    active,
  };
}

function firstFullMonthAfter(cycleDate) {
  const date = new Date(`${cycleDate}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return date.toISOString().slice(0, 7);
}

function currentProfileEpoch(state) {
  const change = [...(state?.strategyChanges || [])]
    .filter((item) => (
      item?.toProfileId === state?.strategyProfileId
      && /^\d{4}-\d{2}-\d{2}$/.test(item?.effectiveFromCycleDate || '')
    ))
    .sort((left, right) => (
      right.effectiveFromCycleDate.localeCompare(left.effectiveFromCycleDate)
    ))[0] || null;
  const startCycleDate = change?.effectiveFromCycleDate || state?.startCycleDate || null;
  const reports = dailyReports(state).filter((report) => {
    if (report.strategyProfileId) return report.strategyProfileId === state.strategyProfileId;
    return !startCycleDate || report.cycleDate >= startCycleDate;
  });
  return {
    startCycleDate,
    firstFullMonth: startCycleDate
      ? firstFullMonthAfter(startCycleDate)
      : state?.firstFullMonth,
    reports,
  };
}

function initializationReturn(state) {
  return Number((state?.reports || []).find((report) => (
    report.kind === BASELINE_ENTRY_REPORT_KIND
  ))?.dayReturn || 0);
}

function completeMonthReturns(series, firstFullMonth, latestDate) {
  const latestMonth = latestDate?.slice(0, 7);
  const groups = new Map();
  for (const item of series) {
    const month = item.date.slice(0, 7);
    if (month < firstFullMonth || month >= latestMonth) continue;
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(item.return);
  }
  return [...groups.entries()].map(([month, returns]) => ({
    month,
    return: round(compound(returns) - 1),
  }));
}

function exposureMetrics(state, acceptedDates = null) {
  const reports = (state?.reports || []).filter((report) => (
    !acceptedDates || acceptedDates.has(report.cycleDate)
  ));
  const gross = reports.map((report) => Number(report.modelGrossExposure || 0));
  const maximumAssets = reports.map((report) => Math.max(
    0,
    ...(report.positions || []).map((position) => Math.abs(Number(position.weight || 0))),
  ));
  return {
    peakGrossExposure: round(Math.max(0, ...gross)),
    p95AssetExposure: round(percentile(maximumAssets, 0.95)),
  };
}

function calculateMetrics(series, {
  entryReturn = 0,
  firstFullMonth,
  latestDate,
  exposure = {},
} = {}) {
  const returns = series.map((item) => Number(item.return));
  const activeSeries = series.filter((item) => item.active !== false);
  const directionalSeries = series.filter((item) => (
    Number.isFinite(Number(item.directionalReturn))
    && Math.abs(Number(item.directionalReturn)) > 1e-12
  ));
  const profitableDays = returns.filter((value) => value > 0).length;
  const activeProfitableDays = activeSeries.filter((item) => Number(item.return) > 0).length;
  const directionalHits = directionalSeries.filter((item) => (
    Number(item.directionalReturn) > 0
  )).length;
  let equity = 1 + Number(entryReturn || 0);
  let peak = 1;
  let maxDrawdown = Math.min(0, equity / peak - 1);
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const logReturns = returns.map((value) => Math.log1p(value));
  const elapsedDays = series.length
    ? Math.max(1, daysBetween(series[0].date, series.at(-1).date) + 1)
    : 0;
  const expectedDays = series.length ? elapsedDays : 0;
  const fullMonths = completeMonthReturns(series, firstFullMonth, latestDate);
  const positiveMonths = fullMonths.filter((item) => item.return > 0).length;
  const totalReturn = equity - 1;
  return {
    observations: series.length,
    dataCoverage: expectedDays ? round(series.length / expectedDays) : 0,
    totalReturn: round(totalReturn),
    annualizedReturn: elapsedDays ? round((equity ** (365 / elapsedDays)) - 1) : null,
    annualizedReturnProvisional: elapsedDays < 365,
    annualizedVolatility: round(standardDeviation(logReturns) * Math.sqrt(365)),
    sharpeLike: standardDeviation(logReturns)
      ? round(mean(logReturns) / standardDeviation(logReturns) * Math.sqrt(365))
      : null,
    maxDrawdown: round(maxDrawdown),
    worstDayReturn: returns.length ? round(Math.min(...returns)) : null,
    profitableDays,
    profitableDayRatio: returns.length ? round(profitableDays / returns.length) : null,
    activeDayObservations: activeSeries.length,
    activeProfitableDays,
    activeProfitableDayRatio: activeSeries.length
      ? round(activeProfitableDays / activeSeries.length)
      : null,
    directionalObservations: directionalSeries.length,
    directionalHits,
    directionalHitRate: directionalSeries.length
      ? round(directionalHits / directionalSeries.length)
      : null,
    directionalWilson95Lower: directionalSeries.length
      ? round(wilsonLower(directionalHits, directionalSeries.length))
      : null,
    expectedShortfall95: round(expectedShortfall95(returns)),
    completeMonths: fullMonths,
    fullMonthCount: fullMonths.length,
    positiveMonths,
    positiveMonthRatio: fullMonths.length ? round(positiveMonths / fullMonths.length) : null,
    monthlyWilson95Lower: fullMonths.length
      ? round(wilsonLower(positiveMonths, fullMonths.length))
      : null,
    ...exposure,
  };
}

function accuracySummary(reports) {
  const metrics = calculateMetrics(reports.map(reportMetricPoint));
  return {
    startCycleDate: reports[0]?.cycleDate || null,
    endCycleDate: reports.at(-1)?.cycleDate || null,
    observations: metrics.observations,
    totalReturn: metrics.totalReturn,
    profitableDays: metrics.profitableDays,
    profitableDayRatio: metrics.profitableDayRatio,
    activeDayObservations: metrics.activeDayObservations,
    activeProfitableDays: metrics.activeProfitableDays,
    activeProfitableDayRatio: metrics.activeProfitableDayRatio,
    directionalObservations: metrics.directionalObservations,
    directionalHits: metrics.directionalHits,
    directionalHitRate: metrics.directionalHitRate,
    directionalWilson95Lower: metrics.directionalWilson95Lower,
  };
}

function buildAccuracyComparison(state, baselineEpoch) {
  const reports = dailyReports(state);
  const priorReports = baselineEpoch.startCycleDate
    ? reports.filter((report) => report.cycleDate < baselineEpoch.startCycleDate)
    : [];
  const latestMonth = state.lastCycleDate?.slice(0, 7) || null;
  const completedMonths = [...new Set(reports
    .map((report) => report.cycleDate.slice(0, 7))
    .filter((month) => month >= state.firstFullMonth && month < latestMonth))]
    .sort();
  const latestFullMonth = completedMonths.at(-1) || null;
  const latestFullMonthReports = latestFullMonth
    ? reports.filter((report) => report.cycleDate.startsWith(latestFullMonth))
    : [];
  return {
    definition: {
      profitableDayRatio: '净收益大于0的结算日占全部结算日比例；空仓持平日计入分母。',
      activeProfitableDayRatio: '净收益大于0的结算日占实际发生价格盈亏或成本的活跃日比例。',
      directionalHitRate: '持仓价格盈亏大于0的活跃结算日占比；不含交易费和持仓费。',
      positiveMonthRatio: '完整自然月净收益大于0的月份比例。',
    },
    allSimulation: accuracySummary(reports),
    previousStrategies: accuracySummary(priorReports),
    currentStrategy: accuracySummary(baselineEpoch.reports),
    latestFullMonth: latestFullMonth ? {
      month: latestFullMonth,
      ...accuracySummary(latestFullMonthReports),
    } : null,
  };
}

function seededRandom(seedText) {
  let state = [...seedText].reduce((value, character) => (
    Math.imul(value ^ character.charCodeAt(0), 16777619)
  ), 2166136261) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function blockBootstrapP(excessReturns, candidateId) {
  if (excessReturns.length < PAPER_REVIEW_POLICY.review.minPairedDays) return null;
  const random = seededRandom(`${candidateId}:${excessReturns.length}`);
  const samples = PAPER_REVIEW_POLICY.promotion.bootstrapSamples;
  const blockDays = PAPER_REVIEW_POLICY.promotion.bootstrapBlockDays;
  let nonPositive = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    let count = 0;
    while (count < excessReturns.length) {
      const start = Math.floor(random() * excessReturns.length);
      for (let offset = 0; offset < blockDays && count < excessReturns.length; offset += 1) {
        total += excessReturns[(start + offset) % excessReturns.length];
        count += 1;
      }
    }
    if (total <= 0) nonPositive += 1;
  }
  return (nonPositive + 1) / (samples + 1);
}

function candidateGate(candidate, benchmark, adjustedBootstrapP) {
  const review = PAPER_REVIEW_POLICY.review;
  const promotion = PAPER_REVIEW_POLICY.promotion;
  const rejection = PAPER_REVIEW_POLICY.rejection;
  const drawdownMagnitude = Math.abs(Math.min(0, candidate.maxDrawdown));
  const benchmarkDrawdownMagnitude = Math.abs(Math.min(0, benchmark.maxDrawdown));

  if (drawdownMagnitude >= rejection.hardDrawdownMagnitude
    || Number(candidate.worstDayReturn || 0) <= -rejection.hardOneDayLoss
    || Number(candidate.peakGrossExposure || 0) > promotion.maxPeakGrossExposure) {
    return { status: 'reject', reason: '触发硬风控门槛，停止该候选继续晋级。' };
  }
  if (candidate.observations < review.minPairedDays
    || candidate.fullMonthCount < review.minFullMonths
    || candidate.dataCoverage < review.minDataCoverage) {
    return {
      status: 'collecting',
      reason: `共同前向样本 ${candidate.observations}/${review.minPairedDays} 天，完整月份 ${candidate.fullMonthCount}/${review.minFullMonths}。`,
    };
  }
  if (candidate.observations >= rejection.earlyReviewDays
    && candidate.totalReturn <= 0
    && candidate.totalReturn <= benchmark.totalReturn
    && drawdownMagnitude >= benchmarkDrawdownMagnitude + rejection.maxDrawdownWorsening) {
    return { status: 'reject', reason: '已具备早期复盘样本，但收益和回撤同时显著落后基准。' };
  }

  const expectedShortfallLimit = benchmark.expectedShortfall95 > 0
    ? benchmark.expectedShortfall95 * (1 + promotion.maxExpectedShortfallWorsening)
    : 0;
  const promotable = candidate.observations >= promotion.minPairedDays
    && candidate.fullMonthCount >= promotion.minFullMonths
    && candidate.positiveMonths >= promotion.minPositiveMonths
    && candidate.positiveMonthRatio >= promotion.minPositiveMonthRatio
    && candidate.monthlyWilson95Lower >= promotion.minMonthlyWilson95Lower
    && candidate.annualizedReturn >= promotion.minNetCagr
    && candidate.annualizedReturn >= benchmark.annualizedReturn
    && adjustedBootstrapP !== null
    && adjustedBootstrapP <= promotion.maxAdjustedBootstrapP
    && drawdownMagnitude <= Math.min(
      promotion.maxDrawdownMagnitude,
      benchmarkDrawdownMagnitude + promotion.maxDrawdownWorsening,
    )
    && candidate.annualizedVolatility <= Math.min(
      promotion.maxAnnualizedVolatility,
      benchmark.annualizedVolatility + promotion.maxVolatilityWorsening,
    )
    && candidate.expectedShortfall95 <= expectedShortfallLimit
    && candidate.p95AssetExposure <= promotion.maxP95AssetExposure;
  if (promotable) {
    return { status: 'promotable', reason: '达到人工晋级复核门槛；系统不会自动替换基准或增加杠杆。' };
  }
  return { status: 'reviewable', reason: '样本可用于诊断，但尚未同时满足长期收益、回撤和统计显著性门槛。' };
}

function newsEvidence(state, acceptedDates) {
  const decisions = dailyReports(state)
    .filter((report) => acceptedDates.has(report.cycleDate))
    .map((report) => report.settledNewsOverlay)
    .filter((decision) => decision?.enabled);
  if (!decisions.length) {
    return {
      evaluatedDays: 0,
      liveDays: 0,
      staleDays: 0,
      unavailableDays: 0,
      missingDays: 0,
      liveCoverageRatio: null,
      activeDays: 0,
      fallbackDays: 0,
      activationRatio: null,
      averageAppliedNewsWeightPercent: null,
      riskVetoDays: 0,
      averageAppliedRiskGrossExposureScale: null,
      dominantFallbackReason: null,
    };
  }
  const active = decisions.filter((decision) => (
    !decision.fallbackToPriceOnly
    && (Number(decision.appliedNewsWeightPercent || 0) > 0 || decision.riskVetoTriggered)
  ));
  const riskVeto = decisions.filter((decision) => decision.riskVetoTriggered);
  const fallback = decisions.filter((decision) => decision.fallbackToPriceOnly);
  const statusCount = (status) => decisions.filter((decision) => (
    (decision.status || 'missing') === status
  )).length;
  const liveDays = statusCount('live');
  const reasons = new Map();
  for (const decision of fallback) {
    const reason = decision.fallbackReason || '未记录回退原因';
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  const dominantFallbackReason = [...reasons.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || null;
  return {
    evaluatedDays: decisions.length,
    liveDays,
    staleDays: statusCount('stale'),
    unavailableDays: statusCount('unavailable'),
    missingDays: statusCount('missing'),
    liveCoverageRatio: round(liveDays / decisions.length),
    activeDays: active.length,
    fallbackDays: fallback.length,
    activationRatio: round(active.length / decisions.length),
    averageAppliedNewsWeightPercent: round(mean(decisions.map((decision) => (
      Number(decision.averageAppliedNewsWeightPercent
        ?? decision.appliedNewsWeightPercent
        ?? 0)
    ))), 4),
    riskVetoDays: riskVeto.length,
    averageAppliedRiskGrossExposureScale: round(mean(decisions.map((decision) => (
      Number(decision.appliedRiskGrossExposureScale ?? 1)
    )))),
    dominantFallbackReason,
  };
}

function matchedCandidate(baselineState, candidateState, profile, trialCount) {
  const baselineProfileId = profile.baselineProfileId || MONTHLY_ACCURACY_PAPER_PROFILE.id;
  const effectiveProfile = candidateState?.profileSnapshot || profile;
  const profileSummary = {
    baselineProfileId,
    marketNeutralWeight: effectiveProfile.marketNeutralWeight,
    trendWeight: effectiveProfile.trendWeight,
    cashWeight: effectiveProfile.cashWeight || 0,
    positionsPerSide: effectiveProfile.marketNeutral.positionsPerSide,
    newsOverlay: effectiveProfile.newsOverlay || null,
  };
  if (baselineProfileId !== baselineState.strategyProfileId) {
    const reports = candidateState ? dailyReports(candidateState) : [];
    const acceptedDates = new Set(reports.map((report) => report.cycleDate));
    const candidateMetrics = candidateState
      ? calculateMetrics(
        reports.map(reportMetricPoint),
        {
          entryReturn: initializationReturn(candidateState),
          firstFullMonth: candidateState.firstFullMonth,
          latestDate: candidateState.lastCycleDate,
          exposure: exposureMetrics(candidateState, acceptedDates),
        },
      )
      : null;
    return {
      id: effectiveProfile.id,
      name: effectiveProfile.name,
      role: effectiveProfile.role,
      hypothesis: effectiveProfile.hypothesis,
      profile: profileSummary,
      startedAt: candidateState?.startedAt || null,
      startCycleDate: candidateState?.startCycleDate || null,
      lastCycleDate: candidateState?.lastCycleDate || null,
      status: 'archived',
      statusReason: `候选基于 ${baselineProfileId}；当前正式基准为 ${baselineState.strategyProfileId}，保留历史账本但停止晋级比较。`,
      metrics: candidateMetrics ? {
        ...candidateMetrics,
        pairedExcessReturn: null,
        baselineTotalReturn: null,
        baselineAnnualizedReturn: null,
        baselineMaxDrawdown: null,
        bootstrapP: null,
        adjustedBootstrapP: null,
      } : null,
      newsEvidence: candidateState && effectiveProfile.newsOverlay?.enabled
        ? newsEvidence(candidateState, acceptedDates)
        : null,
      latestNewsDecision: candidateState?.components?.marketNeutral?.lastNewsDecision || null,
    };
  }
  if (!candidateState) {
    return {
      id: profile.id,
      name: profile.name,
      role: profile.role,
      hypothesis: profile.hypothesis,
      profile: profileSummary,
      status: 'not_started',
      statusReason: '影子账本尚未建立。',
    };
  }
  const candidateByDate = new Map(dailyReports(candidateState).map((report) => [report.cycleDate, report]));
  const baselineByDate = new Map(currentProfileEpoch(baselineState).reports
    .map((report) => [report.cycleDate, report]));
  const firstPairedDate = addUtcDays(candidateState.startCycleDate, 1);
  const dates = [...candidateByDate.keys()]
    .filter((date) => date >= firstPairedDate && baselineByDate.has(date))
    .sort();
  const acceptedDates = new Set(dates);
  const candidateSeries = dates.map((date) => reportMetricPoint(candidateByDate.get(date)));
  const benchmarkSeries = dates.map((date) => reportMetricPoint(baselineByDate.get(date)));
  const latestDate = dates.at(-1) || candidateState.lastCycleDate;
  const candidateMetrics = calculateMetrics(candidateSeries, {
    entryReturn: initializationReturn(candidateState),
    firstFullMonth: candidateState.firstFullMonth,
    latestDate,
    exposure: exposureMetrics(candidateState, acceptedDates),
  });
  const benchmarkMetrics = calculateMetrics(benchmarkSeries, {
    entryReturn: initializationReturn(baselineState),
    firstFullMonth: candidateState.firstFullMonth,
    latestDate,
    exposure: exposureMetrics(baselineState, acceptedDates),
  });
  const excessReturns = dates.map((date) => (
    Math.log1p(Number(candidateByDate.get(date).dayReturn))
      - Math.log1p(Number(baselineByDate.get(date).dayReturn))
  ));
  const bootstrapP = blockBootstrapP(excessReturns, effectiveProfile.id);
  const adjustedBootstrapP = bootstrapP === null ? null : Math.min(1, bootstrapP * trialCount);
  const gate = candidateGate(candidateMetrics, benchmarkMetrics, adjustedBootstrapP);
  return {
    id: effectiveProfile.id,
    name: effectiveProfile.name,
    role: effectiveProfile.role,
    hypothesis: effectiveProfile.hypothesis,
    profile: profileSummary,
    startedAt: candidateState.startedAt,
    startCycleDate: candidateState.startCycleDate,
    lastCycleDate: candidateState.lastCycleDate,
    status: gate.status,
    statusReason: gate.reason,
    metrics: {
      ...candidateMetrics,
      pairedExcessReturn: dates.length
        ? round(candidateMetrics.totalReturn - benchmarkMetrics.totalReturn)
        : null,
      baselineTotalReturn: benchmarkMetrics.totalReturn,
      baselineAnnualizedReturn: benchmarkMetrics.annualizedReturn,
      baselineMaxDrawdown: benchmarkMetrics.maxDrawdown,
      bootstrapP: round(bootstrapP),
      adjustedBootstrapP: round(adjustedBootstrapP),
    },
    newsEvidence: effectiveProfile.newsOverlay?.enabled
      ? newsEvidence(candidateState, acceptedDates)
      : null,
    latestNewsDecision: candidateState.components?.marketNeutral?.lastNewsDecision || null,
  };
}

function latestAttribution(state) {
  const report = state?.latestReport;
  if (!report || report.kind !== 'daily' || !report.symbolAttribution?.length) return null;
  const lockReview = monthlyLockReview(state);
  const symbols = [...report.symbolAttribution].sort((left, right) => (
    left.totalPricePnl - right.totalPricePnl
  ));
  const marketNeutral = report.componentAttribution?.marketNeutral;
  const trend = report.componentAttribution?.trend;
  const totalCost = Number(report.tradingCost || 0) + Number(report.carryCost || 0);
  const absolutePricePnl = Math.abs(Number(report.pricePnl || 0));
  const turnover = {
    marketNeutral: round(Number(report.turnover?.marketNeutral || 0)),
    trend: round(Number(report.turnover?.trend || 0)),
  };
  turnover.total = round(turnover.marketNeutral + turnover.trend);
  const marketNeutralGross = report.symbolAttribution.reduce((sum, item) => (
    sum + Math.abs(Number(item.marketNeutralWeight || 0))
  ), 0);
  const marketNeutralLongGross = report.symbolAttribution.reduce((sum, item) => (
    sum + Math.max(0, Number(item.marketNeutralWeight || 0))
  ), 0);
  const marketNeutralShortGross = report.symbolAttribution.reduce((sum, item) => (
    sum + Math.max(0, -Number(item.marketNeutralWeight || 0))
  ), 0);
  const marketNeutralLongReturn = marketNeutralLongGross
    ? report.symbolAttribution.reduce((sum, item) => (
      sum + Math.max(0, Number(item.marketNeutralWeight || 0)) * Number(item.assetReturn || 0)
    ), 0) / marketNeutralLongGross
    : null;
  const marketNeutralShortReturn = marketNeutralShortGross
    ? report.symbolAttribution.reduce((sum, item) => (
      sum + Math.max(0, -Number(item.marketNeutralWeight || 0)) * Number(item.assetReturn || 0)
    ), 0) / marketNeutralShortGross
    : null;
  const marketNeutralSpreadMove = marketNeutralLongReturn !== null
    && marketNeutralShortReturn !== null
    ? marketNeutralLongReturn - marketNeutralShortReturn
    : null;
  const largestTwoMarketNeutral = [...report.symbolAttribution]
    .map((item) => Math.abs(Number(item.marketNeutralWeight || 0)))
    .sort((left, right) => right - left)
    .slice(0, 2)
    .reduce((sum, value) => sum + value, 0);
  const diagnostics = [];
  const risingTrendShorts = report.symbolAttribution.filter((item) => (
    Number(item.trendWeight || 0) < 0 && Number(item.assetReturn || 0) > 0
  ));
  if (Number(trend?.totalPnl || 0) < 0 && risingTrendShorts.length >= 2) {
    diagnostics.push(`趋势袖套的滞后空头在 ${risingTrendShorts.length} 个同步上涨标的上遭遇反向行情，是本日趋势亏损的直接来源。`);
  }
  if (Number(marketNeutral?.totalPnl || 0) < 0 && Number(trend?.totalPnl || 0) > 0) {
    diagnostics.push('横截面相对价值腿失效，趋势空头提供了部分对冲。');
  }
  if (marketNeutralSpreadMove !== null && marketNeutralSpreadMove < 0) {
    diagnostics.push(`横截面多头相对空头跑输 ${Math.abs(marketNeutralSpreadMove * 100).toFixed(2)} 个百分点。`);
  }
  if (marketNeutralGross > 0 && largestTwoMarketNeutral / marketNeutralGross >= 0.75) {
    diagnostics.push('横截面风险集中在少数多空腿，普通价差反转会被动态杠杆放大。');
  }
  const trendLockReason = lockReview?.trendLockReason ?? report.settledLocks?.trend ?? null;
  if (lockReview?.pendingStrategyChange?.continuousTrading) {
    diagnostics.push(`持续交易降风险修复已登记，将于 ${lockReview.pendingStrategyChange.effectiveFromCycleDate} 的09:00周期按最新完整信号重新计算仓位；达到月内收益阈值后保留10%敞口，不会因盈利而空仓。`);
  } else if (lockReview?.pendingStrategyChange) {
    diagnostics.push(`月度盈利止盈已取消，将于 ${lockReview.pendingStrategyChange.effectiveFromCycleDate} 的09:00周期按最新完整信号重新计算仓位。`);
  } else if (lockReview?.bothProfitLocked && lockReview.currentGrossExposure === 0) {
    diagnostics.push(`横截面与趋势均已月度止盈，连续空仓 ${lockReview.consecutiveIdleDays} 个结算日；本月已锁定 ${(lockReview.monthToDateReturn * 100).toFixed(2)}%，下月自动重置。`);
    const holdProxy = lockReview.lockedMarketNeutralHoldCounterfactual;
    if (holdProxy?.observations) {
      diagnostics.push(`锁仓后继续冻结持有原横截面仓位的事后代理收益为 ${(holdProxy.portfolioReturn * 100).toFixed(2)}%（${holdProxy.portfolioPnl.toFixed(2)} USDT）；该值只复盘机会成本，不是可交易回测。`);
    }
  } else if (marketNeutralGross > 0 && trendLockReason === 'profit') {
    diagnostics.push('趋势子策略已触发月度止盈锁定，本月剩余时间由横截面仓位独自承担主要风险。');
  } else if (marketNeutralGross > 0 && trendLockReason === 'loss') {
    diagnostics.push('趋势子策略已触发月度止损锁定，本月剩余时间不再提供趋势对冲。');
  } else if (lockReview?.profitLocksEnabled === false
    && lockReview.currentGrossExposure === 0) {
    diagnostics.push('月度盈利止盈已关闭；当前空仓只可能来自最新信号未形成可执行仓位或保留的亏损风控。');
  }
  const activeDeRiskSleeves = [
    ['横截面', lockReview?.profitDeRisk?.marketNeutral],
    ['趋势', lockReview?.profitDeRisk?.trend],
  ].filter(([, value]) => value?.active === true);
  if (activeDeRiskSleeves.length) {
    diagnostics.push(`${activeDeRiskSleeves.map(([name]) => name).join('与')}已达到月内收益保护阈值，继续按最新信号交易并保留10%敞口。`);
  }
  if (Math.abs(Number(report.dayPnl || 0)) > 0 && totalCost / Math.abs(report.dayPnl) >= 0.25) {
    diagnostics.push('成本占当日波动较高，需要检查换手和持仓成本。');
  }
  if (turnover.total >= 1) {
    diagnostics.push(`本次调仓总换手 ${turnover.total.toFixed(2)} 倍，其中横截面 ${turnover.marketNeutral.toFixed(2)} 倍、趋势 ${turnover.trend.toFixed(2)} 倍。`);
  }
  if (!diagnostics.length) diagnostics.push('当前没有单一异常标签，继续积累前向样本。');
  return {
    cycleDate: report.cycleDate,
    dayPnl: report.dayPnl,
    dayReturn: report.dayReturn,
    pricePnl: report.pricePnl,
    tradingCost: report.tradingCost,
    carryCost: report.carryCost,
    costShareOfAbsolutePnl: Math.abs(Number(report.dayPnl || 0)) > 0
      ? round(totalCost / Math.abs(report.dayPnl))
      : null,
    costShareOfAbsolutePricePnl: absolutePricePnl > 0
      ? round(totalCost / absolutePricePnl)
      : null,
    tradingCostShareOfAbsolutePricePnl: absolutePricePnl > 0
      ? round(Number(report.tradingCost || 0) / absolutePricePnl)
      : null,
    turnover,
    marketNeutral,
    trend,
    largestDetractor: symbols[0],
    largestContributor: symbols.at(-1),
    marketNeutralTopTwoShare: marketNeutralGross
      ? round(largestTwoMarketNeutral / marketNeutralGross)
      : null,
    marketNeutralSpreadMove: round(marketNeutralSpreadMove),
    trendLockReason,
    lockReview,
    diagnostics,
    symbols,
  };
}

function lockedMarketNeutralHoldCounterfactual(state, reports, lockDate) {
  const weights = state?.components?.marketNeutral?.baseWeights;
  if (!weights || !lockDate) return null;
  const relevant = reports.filter((item) => (
    item.cycleDate > lockDate && item.symbolAttribution?.length
  ));
  if (!relevant.length) return null;
  const symbols = Object.keys(weights);
  const grossExposure = symbols.reduce((sum, symbol) => (
    sum + Math.abs(Number(weights[symbol] || 0))
  ), 0);
  const carryRate = Number(state.profileSnapshot?.marketNeutral?.dailyCarryCostRate || 0);
  const allocation = Number(state.profileSnapshot?.marketNeutralWeight || 0);
  let componentEquity = 1;
  let portfolioEquity = 1;
  for (const report of relevant) {
    const returns = new Map(report.symbolAttribution.map((item) => [
      item.symbol,
      Number(item.assetReturn || 0),
    ]));
    const marketReturn = symbols.reduce((sum, symbol) => (
      sum + Number(weights[symbol] || 0) * Number(returns.get(symbol) || 0)
    ), 0);
    const componentReturn = marketReturn - grossExposure * carryRate;
    componentEquity *= 1 + componentReturn;
    portfolioEquity *= 1 + allocation * componentReturn;
  }
  const startingEquity = Number(relevant[0].startingEquity || state.initialCapital || 0);
  return {
    method: 'frozen_market_neutral_weights_after_dual_lock',
    observations: relevant.length,
    grossExposure: round(grossExposure),
    componentReturn: round(componentEquity - 1),
    portfolioReturn: round(portfolioEquity - 1),
    portfolioPnl: round(startingEquity * (portfolioEquity - 1), 4),
  };
}

function monthlyLockReview(state) {
  const report = state?.latestReport;
  if (!report || report.kind !== 'daily') return null;
  const month = report.cycleDate.slice(0, 7);
  const reports = dailyReports(state).filter((item) => item.cycleDate.startsWith(month));
  const marketNeutralComponent = state.components?.marketNeutral;
  const trendComponent = state.components?.trend;
  const marketNeutralLockReason = marketNeutralComponent
    && Object.hasOwn(marketNeutralComponent, 'lockReason')
    ? marketNeutralComponent.lockReason
    : report.settledLocks?.marketNeutral || null;
  const trendLockReason = trendComponent && Object.hasOwn(trendComponent, 'lockReason')
    ? trendComponent.lockReason
    : report.settledLocks?.trend || null;
  const bothProfitLocked = marketNeutralLockReason === 'profit' && trendLockReason === 'profit';
  let consecutiveIdleDays = 0;
  if (bothProfitLocked) {
    for (let index = reports.length - 1; index >= 0; index -= 1) {
      const item = reports[index];
      const bothLocked = item.settledLocks?.marketNeutral === 'profit'
        && item.settledLocks?.trend === 'profit';
      if (!bothLocked || Number(item.modelGrossExposure || 0) !== 0) break;
      consecutiveIdleDays += 1;
    }
  }
  const firstDualLock = reports.find((item) => (
    item.settledLocks?.marketNeutral === 'profit'
    && item.settledLocks?.trend === 'profit'
    && Number(item.modelGrossExposure || 0) === 0
  ));
  const monthToDateReturn = reports.reduce((equity, item) => (
    equity * (1 + Number(item.dayReturn || 0))
  ), 1) - 1;
  return {
    month,
    marketNeutralLockReason,
    trendLockReason,
    bothProfitLocked,
    bothProfitLockedSince: bothProfitLocked ? firstDualLock?.cycleDate || null : null,
    consecutiveIdleDays,
    monthToDatePnl: round(reports.reduce((sum, item) => sum + Number(item.dayPnl || 0), 0), 4),
    monthToDateReturn: round(monthToDateReturn),
    currentGrossExposure: round(Number(state.modelGrossExposure || 0)),
    profitLocksEnabled: state.profileSnapshot?.marketNeutral?.monthlyProfitLock !== null
      || state.profileSnapshot?.trend?.monthlyProfitLock !== null,
    profitDeRisk: {
      marketNeutral: marketNeutralComponent?.lastProfitDeRisk || null,
      trend: trendComponent?.lastProfitDeRisk || null,
    },
    pendingStrategyChange: state.pendingStrategyChange || null,
    lockedMarketNeutralHoldCounterfactual: lockedMarketNeutralHoldCounterfactual(
      state,
      reports,
      firstDualLock?.cycleDate || null,
    ),
  };
}

function rollingReview(state, window, availableReports = currentProfileEpoch(state).reports) {
  const reports = availableReports.slice(-window);
  const metrics = calculateMetrics(
    reports.map(reportMetricPoint),
    {
      firstFullMonth: state.firstFullMonth,
      latestDate: reports.at(-1)?.cycleDate,
      exposure: exposureMetrics(state, new Set(reports.map((report) => report.cycleDate))),
    },
  );
  return {
    windowDays: window,
    observations: metrics.observations,
    netReturn: metrics.totalReturn,
    maxDrawdown: metrics.maxDrawdown,
    worstDayReturn: metrics.worstDayReturn,
    profitableDayRatio: metrics.profitableDayRatio,
    tradingCost: round(reports.reduce((sum, report) => sum + Number(report.tradingCost || 0), 0), 4),
    carryCost: round(reports.reduce((sum, report) => sum + Number(report.carryCost || 0), 0), 4),
  };
}

export function paperShadowStatePath(rootDir, profileId) {
  if (!/^[a-z0-9-]+$/.test(profileId)) throw new Error('影子策略ID无效');
  return path.join(rootDir, 'data', 'runtime', 'paper-shadow', `${profileId}.json`);
}

export function buildPaperStrategyReview({
  baselineState,
  shadowStates = [],
  now = Date.now(),
}) {
  if (!baselineState) {
    return {
      version: 1,
      status: 'not_started',
      generatedAt: new Date(now).toISOString(),
      baseline: {
        id: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.id,
        name: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.name,
        frozen: true,
        automaticParameterChanges: false,
        metrics: null,
      },
      candidates: [],
      trialCount: PAPER_SHADOW_PROFILES.length,
      policy: PAPER_REVIEW_POLICY,
      promotionMode: 'MANUAL_REVIEW_ONLY',
      targetDisclaimer: '年化10%和80%盈利月是候选晋级目标，不是收益或胜率保证。',
    };
  }
  const shadowById = new Map(shadowStates.filter(Boolean).map((state) => [
    state.strategyProfileId,
    state,
  ]));
  const baselineEpoch = currentProfileEpoch(baselineState);
  const baselineReports = baselineEpoch.reports;
  const baselineDates = new Set(baselineReports.map((report) => report.cycleDate));
  const baselineMetrics = calculateMetrics(
    baselineReports.map(reportMetricPoint),
    {
      entryReturn: baselineEpoch.startCycleDate === baselineState.startCycleDate
        ? initializationReturn(baselineState)
        : 0,
      firstFullMonth: baselineEpoch.firstFullMonth,
      latestDate: baselineReports.at(-1)?.cycleDate || baselineState.lastCycleDate,
      exposure: exposureMetrics(baselineState, baselineDates),
    },
  );
  const candidates = PAPER_SHADOW_PROFILES.map((profile) => matchedCandidate(
    baselineState,
    shadowById.get(profile.id),
    profile,
    PAPER_SHADOW_PROFILES.length,
  ));
  return {
    version: 1,
    status: 'running',
    generatedAt: new Date(now).toISOString(),
    cycleDate: baselineState.lastCycleDate,
    baseline: {
      id: baselineState.strategyProfileId,
      name: baselineState.strategyName,
      frozen: true,
      automaticParameterChanges: false,
      epochStartCycleDate: baselineEpoch.startCycleDate,
      firstFullMonth: baselineEpoch.firstFullMonth,
      metrics: baselineMetrics,
    },
    accuracyComparison: buildAccuracyComparison(baselineState, baselineEpoch),
    latestAttribution: latestAttribution(baselineState),
    monthlyLockReview: monthlyLockReview(baselineState),
    rolling: [7, 30, 90].map((window) => rollingReview(
      baselineState,
      window,
      baselineReports,
    )),
    candidates,
    trialCount: PAPER_SHADOW_PROFILES.length,
    policy: PAPER_REVIEW_POLICY,
    promotionMode: 'MANUAL_REVIEW_ONLY',
    targetDisclaimer: '年化10%和80%盈利月是候选晋级目标，不是收益或胜率保证。',
  };
}

async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

function money(value) {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${number.toFixed(2)} USDT`;
}

function percent(value) {
  if (value === null || value === undefined) return '--';
  if (!Number.isFinite(Number(value))) return '--';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${(number * 100).toFixed(2)}%`;
}

export async function writePaperReviewArtifacts(rootDir, review) {
  const reviewDir = path.join(rootDir, 'data', 'runtime', 'paper-reviews');
  const attribution = review.latestAttribution;
  const lines = [
    `# QuantFlow 模拟盘复盘 ${review.cycleDate || ''}`.trim(),
    '',
    `- 基准：${review.baseline?.name || '尚未启动'}（参数冻结）`,
    `- 晋级方式：${review.promotionMode === 'MANUAL_REVIEW_ONLY' ? '仅人工复核，不自动替换' : review.promotionMode}`,
    `- 目标边界：${review.targetDisclaimer || ''}`,
    '',
  ];
  const accuracy = review.accuracyComparison;
  if (accuracy) {
    const accuracyRows = [
      ['全部模拟期', accuracy.allSimulation],
      ['v3前策略', accuracy.previousStrategies],
      ['当前v3', accuracy.currentStrategy],
      [accuracy.latestFullMonth ? `最近完整月 ${accuracy.latestFullMonth.month}` : '最近完整月', accuracy.latestFullMonth],
    ];
    lines.push(
      '## 正确率对比',
      '',
      '| 区间 | 净收益 | 盈利日 | 活跃盈利日 | 方向命中 |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...accuracyRows.map(([label, item]) => (
        `| ${label} | ${percent(item?.totalReturn)} | ${item?.profitableDays ?? 0}/${item?.observations ?? 0}（${percent(item?.profitableDayRatio)}） | ${item?.activeProfitableDays ?? 0}/${item?.activeDayObservations ?? 0}（${percent(item?.activeProfitableDayRatio)}） | ${item?.directionalHits ?? 0}/${item?.directionalObservations ?? 0}（${percent(item?.directionalHitRate)}） |`
      )),
      '',
      '> 盈利日比例、方向命中率和盈利月比例是不同口径；短样本不用于自动晋级。',
      '',
    );
  }
  if (attribution) {
    lines.push(
      '## 最新损益归因',
      '',
      `- 当日盈亏：${money(attribution.dayPnl)}（${percent(attribution.dayReturn)}）`,
      `- 价格收益：${money(attribution.pricePnl)}`,
      `- 横截面子策略：${money(attribution.marketNeutral?.totalPnl)}`,
      `- 趋势子策略：${money(attribution.trend?.totalPnl)}`,
      `- 横截面多空价差变化：${percent(attribution.marketNeutralSpreadMove)}`,
      `- 最大拖累：${attribution.largestDetractor.symbol} ${money(attribution.largestDetractor.totalPricePnl)}`,
      `- 最大贡献：${attribution.largestContributor.symbol} ${money(attribution.largestContributor.totalPricePnl)}`,
      `- 成本占绝对盈亏：${percent(attribution.costShareOfAbsolutePnl)}`,
      `- 成本占价格收益：${percent(attribution.costShareOfAbsolutePricePnl)}`,
      `- 调仓换手：横截面 ${attribution.turnover.marketNeutral.toFixed(2)} 倍、趋势 ${attribution.turnover.trend.toFixed(2)} 倍、合计 ${attribution.turnover.total.toFixed(2)} 倍`,
      '',
      ...attribution.diagnostics.map((item) => `- 诊断：${item}`),
      '',
      '| 交易对 | 标的涨跌 | 横截面价格盈亏 | 趋势价格盈亏 | 合计 |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...attribution.symbols.map((item) => (
        `| ${item.symbol} | ${percent(item.assetReturn)} | ${money(item.marketNeutralPricePnl)} | ${money(item.trendPricePnl)} | ${money(item.totalPricePnl)} |`
      )),
      '',
    );
  }
  lines.push(
    '## 影子候选',
    '',
    '| 候选 | 状态 | 共同样本 | 完整月份 | 相对基准 |',
    '| --- | --- | ---: | ---: | ---: |',
    ...review.candidates.map((candidate) => (
      `| ${candidate.name} | ${candidate.status} | ${candidate.metrics?.observations || 0}天 | ${candidate.metrics?.fullMonthCount || 0} | ${percent(candidate.metrics?.pairedExcessReturn)} |`
    )),
    '',
    ...review.candidates.flatMap((candidate) => candidate.newsEvidence ? [
      `- ${candidate.name}新闻触发：${candidate.newsEvidence.activeDays}/${candidate.newsEvidence.evaluatedDays} 天（${percent(candidate.newsEvidence.activationRatio)}），平均实际权重 ${Number(candidate.newsEvidence.averageAppliedNewsWeightPercent || 0).toFixed(2)}%。`,
      `  - 已结算快照：实时 ${candidate.newsEvidence.liveDays}/${candidate.newsEvidence.evaluatedDays} 天（${percent(candidate.newsEvidence.liveCoverageRatio)}），缺失 ${candidate.newsEvidence.missingDays} 天、不可用 ${candidate.newsEvidence.unavailableDays} 天、陈旧 ${candidate.newsEvidence.staleDays} 天。`,
      ...(candidate.newsEvidence.riskVetoDays
        ? [`  - 风控降敞口：${candidate.newsEvidence.riskVetoDays} 天，平均敞口缩放 ${percent(candidate.newsEvidence.averageAppliedRiskGrossExposureScale)}。`]
        : []),
      ...(candidate.newsEvidence.dominantFallbackReason
        ? [`  - 主要回退原因：${candidate.newsEvidence.dominantFallbackReason}`]
        : []),
      ...(candidate.latestNewsDecision
        ? [`  - 下一周期新闻决策：${candidate.latestNewsDecision.status || 'missing'}${candidate.latestNewsDecision.signalFresh === false ? '（时效校验失败）' : ''}${candidate.latestNewsDecision.fallbackToPriceOnly ? `，价格回退：${candidate.latestNewsDecision.fallbackReason || '未记录原因'}` : ''}。`]
        : []),
    ] : []),
    '',
    '> 影子候选参数启动后保持冻结。任何参数变化必须创建新ID并重新积累前向样本。',
    '',
  );
  await atomicWrite(
    path.join(rootDir, 'data', 'runtime', 'paper-review.json'),
    `${JSON.stringify(review, null, 2)}\n`,
  );
  await atomicWrite(path.join(reviewDir, 'latest.md'), `${lines.join('\n')}\n`);
}
