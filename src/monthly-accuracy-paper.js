import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  calculateCrossSectionalWeights,
  isCalendarRebalanceDay,
  shouldSuppressSmallRebalance,
} from './cross-sectional-backtest.js';
import { evaluateNewsGate } from './composite-strategies.js';
import { calculateLongShortTrendWeights } from './long-short-trend.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DEFAULT_BASE_URL = 'https://data-api.binance.vision';
const MAX_REPORTS = 4_000;

export const PAPER_SYMBOLS = Object.freeze([
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
]);

export const MONTHLY_ACCURACY_PAPER_PROFILE = Object.freeze({
  id: 'monthly-accuracy-85-15-v1',
  name: '90% 盈利月多空组合模拟盘',
  marketNeutralWeight: 0.85,
  trendWeight: 0.15,
  allocationTradingCostRate: 0.0007,
  marketNeutral: Object.freeze({
    mode: 'momentum',
    lookbackDays: 10,
    rebalanceDays: 7,
    positionsPerSide: 1,
    baseGrossExposure: 0.5,
    maxGrossExposure: 1.5,
    dynamicLeverageEnabled: true,
    dynamicLeverageMax: 3,
    dispersionTarget: 0.15,
    minimumRebalanceTurnover: 0,
    tradingCostRate: 0.0007,
    dailyCarryCostRate: 0.00005,
    monthlyProfitLock: 0.01,
    monthlyLossLimit: null,
  }),
  trend: Object.freeze({
    positionMode: 'both',
    lookbackDays: [45, 90, 180],
    minimumTrendVotes: 2,
    minimumActiveSignals: 1,
    minimumTrendStrength: 0.02,
    targetVolatility: 0.10,
    maxGrossExposure: 1,
    maxAssetExposure: 0.30,
    dynamicLeverageEnabled: true,
    dynamicLeverageMin: 1,
    dynamicLeverageMax: 3,
    dynamicLeverageStrengthTarget: 0.20,
    volatilityWindowDays: 30,
    rebalanceDays: 1,
    tradingCostRate: 0.0007,
    dailyCarryCostRate: 0.00005,
    monthlyProfitLock: 0.0125,
    monthlyLossLimit: 0.015,
  }),
});

export const MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE = Object.freeze({
  ...MONTHLY_ACCURACY_PAPER_PROFILE,
  id: 'monthly-accuracy-85-15-no-profit-lock-v2',
  name: '动态多空组合模拟盘（无月度盈利锁）',
  marketNeutral: Object.freeze({
    ...MONTHLY_ACCURACY_PAPER_PROFILE.marketNeutral,
    monthlyProfitLock: null,
  }),
  trend: Object.freeze({
    ...MONTHLY_ACCURACY_PAPER_PROFILE.trend,
    monthlyProfitLock: null,
  }),
});

export const MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE = Object.freeze({
  ...MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE,
  id: 'monthly-accuracy-continuous-derisk-v3',
  name: '动态多空组合模拟盘（持续交易降风险）',
  marketNeutral: Object.freeze({
    ...MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE.marketNeutral,
    monthlyProfitDeRiskThreshold: 0.0075,
    monthlyProfitDeRiskScale: 0.10,
  }),
  trend: Object.freeze({
    ...MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE.trend,
    monthlyProfitDeRiskThreshold: 0.01,
    monthlyProfitDeRiskScale: 0.10,
  }),
});

function round(value, digits = 8) {
  return Number(Number(value).toFixed(digits));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function zeroWeights(symbols = PAPER_SYMBOLS) {
  return Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
}

function sumAbsolute(weights) {
  return Object.values(weights).reduce((sum, value) => sum + Math.abs(Number(value) || 0), 0);
}

function profileSnapshot(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function turnover(previousWeights, nextWeights, symbols = PAPER_SYMBOLS) {
  return symbols.reduce((sum, symbol) => (
    sum + Math.abs((nextWeights[symbol] || 0) - (previousWeights[symbol] || 0))
  ), 0);
}

function utcDate(value) {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time)) {
    throw new Error(`无效 UTC 日期：${value}`);
  }
  return time;
}

export function addUtcDays(value, days) {
  return new Date(utcDate(value) + days * DAY_MS).toISOString().slice(0, 10);
}

export function migratePaperStateToNoProfitLock(
  state,
  {
    now = Date.now(),
    targetProfile = MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE,
  } = {},
) {
  if (!state || state.version !== 1) throw new Error('模拟盘状态版本不兼容');
  if (state.strategyProfileId === targetProfile.id) return state;
  if (state.strategyProfileId !== MONTHLY_ACCURACY_PAPER_PROFILE.id) {
    throw new Error(`不支持从 ${state.strategyProfileId || 'unknown'} 迁移到无盈利锁版本`);
  }
  const changedAt = new Date(Number(now)).toISOString();
  const effectiveFromCycleDate = addUtcDays(state.lastCycleDate, 1);
  const change = {
    fromProfileId: state.strategyProfileId,
    toProfileId: targetProfile.id,
    requestedAt: changedAt,
    effectiveFromCycleDate,
    reason: '用户要求取消月度盈利止盈锁，按实际信号继续运行',
    clearProfitLocks: true,
    preserveLossLocks: true,
  };
  for (const component of Object.values(state.components || {})) {
    if (component?.lockReason === 'profit') component.lockReason = null;
  }
  state.strategyProfileId = targetProfile.id;
  state.strategyName = targetProfile.name;
  state.profileSnapshot = profileSnapshot(targetProfile);
  state.forceRebalanceNextCycle = true;
  state.pendingStrategyChange = change;
  state.strategyChanges = [...(state.strategyChanges || []), change];
  state.updatedAt = changedAt;
  return state;
}

export function migratePaperStateToContinuousDeRisk(
  state,
  {
    now = Date.now(),
    targetProfile = MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE,
  } = {},
) {
  if (!state || state.version !== 1) throw new Error('模拟盘状态版本不兼容');
  if (state.strategyProfileId === targetProfile.id) return state;
  const supportedSources = new Set([
    MONTHLY_ACCURACY_PAPER_PROFILE.id,
    MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE.id,
  ]);
  if (!supportedSources.has(state.strategyProfileId)) {
    throw new Error(`不支持从 ${state.strategyProfileId || 'unknown'} 迁移到持续交易降风险版本`);
  }
  const changedAt = new Date(Number(now)).toISOString();
  const effectiveFromCycleDate = addUtcDays(state.lastCycleDate, 1);
  const change = {
    fromProfileId: state.strategyProfileId,
    toProfileId: targetProfile.id,
    requestedAt: changedAt,
    effectiveFromCycleDate,
    reason: '复盘单日挤空损失后，取消空仓式止盈并改为保留10%敞口持续交易',
    clearProfitLocks: true,
    preserveLossLocks: true,
    continuousTrading: true,
  };
  for (const component of Object.values(state.components || {})) {
    if (component?.lockReason === 'profit') component.lockReason = null;
  }
  state.strategyProfileId = targetProfile.id;
  state.strategyName = targetProfile.name;
  state.profileSnapshot = profileSnapshot(targetProfile);
  state.forceRebalanceNextCycle = true;
  state.pendingStrategyChange = change;
  state.strategyChanges = [...(state.strategyChanges || []), change];
  state.updatedAt = changedAt;
  return state;
}

export function latestCompletePaperCycleDate(now = Date.now()) {
  const value = Number(now);
  if (!Number.isFinite(value)) throw new Error('当前时间无效');
  const date = new Date(value);
  const utcDateText = date.toISOString().slice(0, 10);
  return date.getUTCHours() >= 1 ? utcDateText : addUtcDays(utcDateText, -1);
}

function firstMonthAfter(value) {
  const date = new Date(utcDate(value));
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return date.toISOString().slice(0, 7);
}

function validatePrices(prices, symbols = PAPER_SYMBOLS) {
  for (const symbol of symbols) {
    if (!Number.isFinite(prices?.[symbol]) || prices[symbol] <= 0) {
      throw new Error(`${symbol} 模拟估值价格无效`);
    }
  }
}

function normalizeDailyMarket(seriesBySymbol, symbols = PAPER_SYMBOLS) {
  const entries = symbols.map((symbol) => [symbol, seriesBySymbol?.[symbol]]);
  const dates = entries[0]?.[1]?.map((item) => item.date);
  if (!dates?.length) throw new Error('纸面盘日线行情为空');
  const closesBySymbol = {};
  for (const [symbol, series] of entries) {
    if (!Array.isArray(series) || series.length !== dates.length) {
      throw new Error(`${symbol} 日线行情长度不一致`);
    }
    closesBySymbol[symbol] = series.map((item, index) => {
      if (item.date !== dates[index]) throw new Error(`${symbol} 日线日期未对齐`);
      const close = Number(item.close);
      if (!Number.isFinite(close) || close <= 0) throw new Error(`${symbol} 日线收盘价无效`);
      return close;
    });
  }
  return {
    dates,
    dateIndex: new Map(dates.map((date, index) => [date, index])),
    closesBySymbol,
    symbols,
  };
}

export function buildPaperNewsSignalContext(newsSnapshot, symbols, profile, {
  decisionCycleDate = null,
} = {}) {
  const settings = profile?.newsOverlay;
  if (!settings?.enabled) return { signalContext: {}, decision: null };
  const expectedDecisionAt = decisionCycleDate
    ? Date.parse(`${decisionCycleDate}T01:00:00.000Z`)
    : null;
  const capturedAt = Date.parse(
    newsSnapshot?.capturedForDecisionAt || newsSnapshot?.updatedAt || '',
  );
  const cycleMatches = !decisionCycleDate
    || newsSnapshot?.paperCycleDate === undefined
    || newsSnapshot?.paperCycleDate === decisionCycleDate;
  const capturedInWindow = !decisionCycleDate || (
    Number.isFinite(capturedAt)
    && capturedAt >= expectedDecisionAt
    && capturedAt <= expectedDecisionAt + 15 * 60_000
  );
  const signalFresh = newsSnapshot?.status === 'live' && cycleMatches && capturedInWindow;
  const live = signalFresh;
  const newsWeightMode = settings.newsWeightMode || 'fixed';
  const rankingEnabled = newsWeightMode !== 'risk_veto'
    && Number(settings.newsSignalWeight) > 0;
  const riskVetoEnabled = settings.riskVetoEnabled === true;
  const riskSignalScope = settings.riskSignalScope === 'symbol_specific'
    ? 'symbol_specific'
    : 'combined';
  const riskEvidenceMode = settings.riskEvidenceMode === 'confirmed_or_independent_event'
    ? 'confirmed_or_independent_event'
    : 'legacy_article_count';
  const riskMinimumCredibility = Number(settings.riskMinimumCredibility || 65);
  const riskMinimumConfidence = Number(settings.riskMinimumConfidence || 50);
  const riskMinimumArticleCount = Number(settings.riskMinimumArticleCount || 3);
  const riskMinimumAbsoluteScore = Number(settings.riskMinimumAbsoluteScore || 0.15);
  const riskGrossExposureScale = Math.min(
    1,
    Math.max(0, Number(settings.riskGrossExposureScale ?? 0.75)),
  );
  const configuredDirectionStrength = Number(settings.directionStrengthFullWeight);
  const directionStrengthFullWeight = Number.isFinite(configuredDirectionStrength)
    && configuredDirectionStrength > 0
    ? configuredDirectionStrength
    : 0.5;
  const evaluated = symbols.map((symbol) => {
    const summary = newsSnapshot?.summary?.bySymbol?.[symbol] || null;
    const gate = evaluateNewsGate(settings, summary);
    const score = Number(summary?.score || 0);
    const riskScore = riskSignalScope === 'symbol_specific'
      ? Number(summary?.symbolSpecificScore || 0)
      : score;
    const riskDirection = riskSignalScope === 'symbol_specific'
      ? summary?.symbolSpecificDirection || 'neutral'
      : summary?.direction || 'neutral';
    const riskCredibility = riskSignalScope === 'symbol_specific'
      ? Number(summary?.symbolSpecificCredibility || 0)
      : Number(summary?.credibility || 0);
    const riskConfidence = riskSignalScope === 'symbol_specific'
      ? Number(summary?.symbolSpecificConfidence || 0)
      : Number(summary?.confidence || 0);
    const riskArticleCount = riskSignalScope === 'symbol_specific'
      ? Number(summary?.symbolSpecificArticleCount || 0)
      : Number(summary?.articleCount || 0);
    const riskDirectionalEvidence = riskSignalScope === 'symbol_specific'
      ? summary?.symbolSpecificDirectionalEvidence?.[riskDirection] || null
      : summary?.directionalEvidence?.[riskDirection] || null;
    const riskEvidencePassed = riskEvidenceMode !== 'confirmed_or_independent_event'
      || Number(riskDirectionalEvidence?.confirmedEventCount || 0) >= 1
      || Number(riskDirectionalEvidence?.corroboratedEventCount || 0) >= 1;
    const eligible = rankingEnabled
      && live
      && gate.eligible
      && Number.isFinite(score)
      && Math.abs(score) >= settings.minimumAbsoluteScore;
    const riskEligible = riskVetoEnabled
      && live
      && Number.isFinite(riskScore)
      && Math.abs(riskScore) >= riskMinimumAbsoluteScore
      && ['bullish', 'bearish'].includes(riskDirection)
      && riskCredibility >= riskMinimumCredibility
      && riskConfidence >= riskMinimumConfidence
      && riskArticleCount >= riskMinimumArticleCount
      && riskEvidencePassed;
    const qualityMultiplier = eligible && newsWeightMode === 'quality'
      ? Math.min(1, Math.max(0, Number(summary?.credibility || 0) / 100))
        * Math.min(1, Math.max(0, Number(summary?.confidence || 0) / 100))
        * Math.min(1, Math.abs(score) / directionStrengthFullWeight)
      : eligible ? 1 : 0;
    const appliedNewsWeightPercent = round(settings.newsSignalWeight * qualityMultiplier, 2);
    return {
      symbol,
      score: round(score, 4),
      riskScore: round(riskScore, 4),
      eligible,
      riskEligible,
      gate,
      direction: summary?.direction || 'neutral',
      riskDirection,
      articleCount: summary?.articleCount || 0,
      riskArticleCount,
      credibility: Number(summary?.credibility || 0),
      riskCredibility,
      confidence: Number(summary?.confidence || 0),
      riskConfidence,
      riskSignalScope,
      riskEvidenceMode,
      riskDirectionalEvidence,
      riskEvidencePassed,
      qualityMultiplier: round(qualityMultiplier, 4),
      appliedNewsWeightPercent,
    };
  });
  const eligible = evaluated.filter((item) => item.eligible);
  const riskEligible = evaluated.filter((item) => item.riskEligible);
  const newsScoresBySymbol = Object.fromEntries(eligible.map((item) => [item.symbol, item.score]));
  const newsWeightsBySymbol = Object.fromEntries(eligible.map((item) => [
    item.symbol,
    item.appliedNewsWeightPercent / 100,
  ]));
  const newsRiskScoresBySymbol = Object.fromEntries(riskEligible.map((item) => [
    item.symbol,
    item.riskScore,
  ]));
  const sourceStatus = newsSnapshot?.sourceStatus || [];
  const fingerprint = eligible.length || riskEligible.length
    ? JSON.stringify({
      ranking: eligible.map((item) => [
        item.symbol,
        item.score,
        item.appliedNewsWeightPercent,
      ]),
      riskSignalScope,
      riskEvidenceMode,
      risk: riskEligible.map((item) => [item.symbol, item.riskScore]),
    })
    : `price-only:${newsSnapshot?.status || 'missing'}`;
  const appliedWeights = eligible.map((item) => item.appliedNewsWeightPercent);
  return {
    signalContext: {
      newsSignalWeight: eligible.length && newsWeightMode === 'fixed'
        ? settings.newsSignalWeight / 100
        : 0,
      newsScoresBySymbol,
      newsWeightsBySymbol: newsWeightMode === 'quality' ? newsWeightsBySymbol : {},
      newsRiskScoresBySymbol,
      newsRiskGrossExposureScale: riskGrossExposureScale,
    },
    decision: {
      enabled: true,
      newsWeightMode,
      status: newsSnapshot?.status || 'missing',
      capturedAt: newsSnapshot?.updatedAt || null,
      expectedDecisionAt: Number.isFinite(expectedDecisionAt)
        ? new Date(expectedDecisionAt).toISOString()
        : null,
      snapshotAgeMinutes: Number.isFinite(expectedDecisionAt) && Number.isFinite(capturedAt)
        ? round((capturedAt - expectedDecisionAt) / 60_000, 2)
        : null,
      signalFresh,
      requestedNewsWeightPercent: settings.newsSignalWeight,
      appliedNewsWeightPercent: appliedWeights.length ? round(Math.max(...appliedWeights), 2) : 0,
      averageAppliedNewsWeightPercent: appliedWeights.length
        ? round(mean(appliedWeights), 2)
        : 0,
      riskVetoEnabled,
      riskSignalScope,
      riskEvidenceMode,
      requestedRiskGrossExposureScale: riskGrossExposureScale,
      riskEligibleSymbols: riskEligible,
      riskVetoTriggered: false,
      riskVetoConflictSymbols: [],
      appliedRiskGrossExposureScale: 1,
      fallbackToPriceOnly: eligible.length === 0,
      fallbackReason: !live
        ? newsSnapshot?.status === 'live' && !signalFresh
          ? '新闻快照周期或捕获时点不符合决策窗口'
          : '新闻快照不可用或不是实时状态'
        : eligible.length
          ? null
          : riskVetoEnabled && riskEligible.length
            ? '新闻风控信号未与已选持仓方向冲突'
            : riskVetoEnabled
              ? '没有通过新闻风控门槛的消息'
              : '没有同时通过可信度、方向置信度、官方确认和方向强度门槛的消息',
      eligibleSymbols: eligible,
      evaluatedSymbols: evaluated,
      sourceAvailability: {
        available: sourceStatus.filter((item) => item.ok).length,
        total: sourceStatus.length,
      },
      fingerprint,
    },
  };
}

function marketReturn(weights, previousPrices, currentPrices, symbols = PAPER_SYMBOLS) {
  return symbols.reduce((sum, symbol) => (
    sum + (weights[symbol] || 0) * (currentPrices[symbol] / previousPrices[symbol] - 1)
  ), 0);
}

export function updateMonthlyLock(component, settings, {
  settlementStartEquity = component.equity,
  currentWeights = {},
  closeWillExecute = true,
} = {}) {
  const grossMonthlyReturn = component.equity / component.monthStartEquity - 1;
  const monthlyProfitLockNetOfExitCost = settings.monthlyProfitLockNetOfExitCost === true;
  const estimatedExitTurnover = closeWillExecute ? sumAbsolute(currentWeights) : 0;
  const estimatedExitTradingCostReturn = estimatedExitTurnover
    * Number(settings.tradingCostRate || 0);
  const projectedPostExitEquity = component.equity
    - settlementStartEquity * estimatedExitTradingCostReturn;
  const projectedNetMonthlyReturn = projectedPostExitEquity / component.monthStartEquity - 1;
  const profitComparisonMonthlyReturn = monthlyProfitLockNetOfExitCost
    ? projectedNetMonthlyReturn
    : grossMonthlyReturn;
  const profitLockActionable = !monthlyProfitLockNetOfExitCost || closeWillExecute;
  const previousLockReason = component.lockReason;
  if (component.lockReason === null
    && settings.monthlyProfitLock !== null
    && profitLockActionable
    && profitComparisonMonthlyReturn >= settings.monthlyProfitLock) {
    component.lockReason = 'profit';
  } else if (component.lockReason === null
    && settings.monthlyLossLimit !== null
    && grossMonthlyReturn <= -settings.monthlyLossLimit) {
    component.lockReason = 'loss';
  }
  return {
    mode: monthlyProfitLockNetOfExitCost ? 'net_of_exit_cost' : 'gross',
    monthlyProfitLockNetOfExitCost,
    grossMonthlyReturn,
    projectedNetMonthlyReturn,
    profitComparisonMonthlyReturn,
    estimatedExitTurnover,
    estimatedExitTradingCostReturn,
    closeWillExecute,
    profitLockActionable,
    triggeredLockReason: previousLockReason === null ? component.lockReason : null,
    lockReason: component.lockReason,
  };
}

function lockEvaluationSnapshot(evaluation) {
  return {
    ...evaluation,
    grossMonthlyReturn: round(evaluation.grossMonthlyReturn),
    projectedNetMonthlyReturn: round(evaluation.projectedNetMonthlyReturn),
    profitComparisonMonthlyReturn: round(evaluation.profitComparisonMonthlyReturn),
    estimatedExitTurnover: round(evaluation.estimatedExitTurnover),
    estimatedExitTradingCostReturn: round(evaluation.estimatedExitTradingCostReturn),
  };
}

function resetMonthIfNeeded(component, upcomingResultDate) {
  const month = upcomingResultDate.slice(0, 7);
  if (component.currentMonth === month) return false;
  component.currentMonth = month;
  component.monthStartEquity = component.equity;
  component.lockReason = null;
  return true;
}

function monthlyProfitDeRisk(component, settings) {
  const threshold = settings.monthlyProfitDeRiskThreshold;
  const configuredScale = settings.monthlyProfitDeRiskScale;
  const enabled = Number.isFinite(threshold)
    && threshold > 0
    && Number.isFinite(configuredScale)
    && configuredScale > 0
    && configuredScale < 1;
  const monthlyReturn = component.equity / component.monthStartEquity - 1;
  const active = enabled && monthlyReturn >= threshold;
  return {
    enabled,
    active,
    threshold: enabled ? threshold : null,
    scale: active ? configuredScale : 1,
    configuredScale: enabled ? configuredScale : 1,
    monthlyReturn,
  };
}

function prepareMarketNeutral({
  component,
  market,
  signalDate,
  upcomingResultDate,
  profile,
  force = false,
  newsSnapshot = null,
}) {
  const settings = profile.marketNeutral;
  const signalIndex = market.dateIndex.get(signalDate);
  const warmupDays = Math.max(
    settings.lookbackDays,
    ...(settings.adaptiveBreadthEnabled ? settings.confirmationLookbackDays : []),
    settings.adaptiveBreadthEnabled ? settings.adaptiveVolatilityWindowDays : 0,
    settings.spreadRiskEnabled ? settings.spreadVolatilityWindowDays : 0,
  );
  if (!Number.isInteger(signalIndex) || signalIndex < warmupDays) {
    throw new Error(`${signalDate} 横截面信号预热不足`);
  }
  const monthChanged = resetMonthIfNeeded(component, upcomingResultDate);
  const scheduled = isCalendarRebalanceDay(signalDate, settings.rebalanceDays);
  const news = buildPaperNewsSignalContext(newsSnapshot, market.symbols, profile, {
    decisionCycleDate: addUtcDays(upcomingResultDate, -1),
  });
  const newsDecisionChanged = Boolean(
    news.decision
    && component.lastNewsDecision?.fingerprint !== news.decision.fingerprint
  );
  let proposedBaseWeights = component.baseWeights;
  let proposedLeverage = component.dynamicLeverage;
  let allocation = null;
  if (component.lockReason === null
    && (force || monthChanged || scheduled || newsDecisionChanged)) {
    allocation = calculateCrossSectionalWeights(
      market.closesBySymbol,
      market.symbols,
      signalIndex,
      settings,
      {
        ...news.signalContext,
        currentWeights: component.baseWeights,
      },
    );
    proposedBaseWeights = allocation.weights;
    proposedLeverage = allocation.leverage;
  }
  let proposedWeights = component.lockReason === null
    ? { ...proposedBaseWeights }
    : zeroWeights(market.symbols);
  const profitDeRisk = monthlyProfitDeRisk(component, settings);
  if (component.lockReason === null && profitDeRisk.active) {
    proposedWeights = Object.fromEntries(Object.entries(proposedWeights).map(([symbol, weight]) => [
      symbol,
      weight * profitDeRisk.scale,
    ]));
  }
  const previousProfitDeRiskActive = component.lastProfitDeRisk?.active === true;
  const profitDeRiskChanged = previousProfitDeRiskActive !== profitDeRisk.active;
  const needsLockClose = component.lockReason !== null
    && sumAbsolute(component.weights) > 0;
  const proposedTurnover = turnover(component.weights, proposedWeights, market.symbols);
  const suppressed = shouldSuppressSmallRebalance({
    scheduled,
    force,
    monthChanged,
    needsLockClose,
    referenceScaleChanged: newsDecisionChanged || profitDeRiskChanged,
    proposedTurnover,
    minimumRebalanceTurnover: settings.minimumRebalanceTurnover || 0,
  });
  const nextWeights = suppressed ? component.weights : proposedWeights;
  const changed = force
    || monthChanged
    || newsDecisionChanged
    || profitDeRiskChanged
    || (scheduled && !suppressed)
    || turnover(component.weights, nextWeights, market.symbols) > 0;
  const nextTurnover = changed ? turnover(component.weights, nextWeights, market.symbols) : 0;
  if (!suppressed && component.lockReason === null) {
    component.baseWeights = proposedBaseWeights;
    component.dynamicLeverage = proposedLeverage;
    if (allocation?.adaptiveRisk) {
      component.lastAdaptiveRisk = {
        ...allocation.adaptiveRisk,
        rankStability: round(allocation.adaptiveRisk.rankStability, 4),
        selectionGap: allocation.adaptiveRisk.selectionGap === null
          ? null
          : round(allocation.adaptiveRisk.selectionGap, 4),
        marketVolatility: allocation.adaptiveRisk.marketVolatility === null
          ? null
          : round(allocation.adaptiveRisk.marketVolatility, 4),
        requestedGrossExposure: round(allocation.adaptiveRisk.requestedGrossExposure, 4),
        grossExposure: round(allocation.adaptiveRisk.grossExposure, 4),
        maximumSingleAssetExposure: round(
          allocation.adaptiveRisk.maximumSingleAssetExposure,
          4,
        ),
      };
    }
  }
  component.weights = nextWeights;
  component.lastProfitDeRisk = profitDeRisk;
  if (news.decision) {
    const previousNewsDecision = component.lastNewsDecision || null;
    const riskVetoTriggered = component.lockReason === null && (allocation
      ? Boolean(allocation.adaptiveRisk?.newsRiskVetoTriggered)
      : Boolean(previousNewsDecision?.riskVetoTriggered));
    component.lastNewsDecision = {
      ...news.decision,
      riskVetoTriggered,
      riskVetoConflictSymbols: riskVetoTriggered
        ? (allocation
          ? allocation.adaptiveRisk?.newsRiskConflictSymbols || []
          : previousNewsDecision?.riskVetoConflictSymbols || [])
        : [],
      appliedRiskGrossExposureScale: riskVetoTriggered
        ? (allocation
          ? allocation.adaptiveRisk?.newsRiskGrossExposureScale ?? 1
          : previousNewsDecision?.appliedRiskGrossExposureScale ?? 1)
        : 1,
      fallbackToPriceOnly: news.decision.fallbackToPriceOnly && !riskVetoTriggered,
      fallbackReason: riskVetoTriggered ? null : news.decision.fallbackReason,
      selectedLongSymbols: Object.entries(nextWeights)
        .filter(([, weight]) => weight > 0)
        .map(([symbol]) => symbol),
      selectedShortSymbols: Object.entries(nextWeights)
        .filter(([, weight]) => weight < 0)
        .map(([symbol]) => symbol),
      ranking: allocation?.ranking?.map((item) => ({
        symbol: item.symbol,
        priceScore: round(item.priceScore, 4),
        newsScore: round(item.newsScore, 4),
        newsWeightPercent: round((item.newsWeight || 0) * 100, 2),
        newsEligible: item.newsEligible,
        rankingScore: round(item.rankingScore, 4),
      })) || previousNewsDecision?.ranking || null,
    };
  }
  return {
    turnover: nextTurnover,
    scheduled,
    suppressed,
    monthChanged,
    dynamicLeverage: component.dynamicLeverage,
    newsDecision: component.lastNewsDecision || null,
    adaptiveRisk: component.lastAdaptiveRisk || null,
    profitDeRisk,
  };
}

function prepareTrend({
  component,
  market,
  signalDate,
  upcomingResultDate,
  profile,
}) {
  const settings = profile.trend;
  const signalIndex = market.dateIndex.get(signalDate);
  const warmup = Math.max(
    ...settings.lookbackDays,
    settings.volatilityWindowDays,
    settings.shortConfirmationLookbackDays || 0,
  );
  if (!Number.isInteger(signalIndex) || signalIndex < warmup) {
    throw new Error(`${signalDate} 趋势信号预热不足`);
  }
  const monthChanged = resetMonthIfNeeded(component, upcomingResultDate);
  const allocation = component.lockReason === null
    ? calculateLongShortTrendWeights(
      market.closesBySymbol,
      market.symbols,
      signalIndex,
      settings,
    )
    : {
      weights: zeroWeights(market.symbols),
      dynamicLeverage: 1,
      activeSignalCount: 0,
      averageSignalStrength: 0,
      shortConfirmation: {
        enabled: Number.isInteger(settings.shortConfirmationLookbackDays),
        lookbackDays: settings.shortConfirmationLookbackDays || null,
        minimumReturn: settings.shortConfirmationMinimumReturn || 0,
        rejectedSymbols: [],
      },
    };
  const profitDeRisk = monthlyProfitDeRisk(component, settings);
  if (component.lockReason === null && profitDeRisk.active) {
    for (const symbol of market.symbols) allocation.weights[symbol] *= profitDeRisk.scale;
  }
  const nextTurnover = turnover(component.weights, allocation.weights, market.symbols);
  component.weights = allocation.weights;
  component.dynamicLeverage = allocation.dynamicLeverage;
  component.activeSignalCount = allocation.activeSignalCount;
  component.averageSignalStrength = allocation.averageSignalStrength;
  component.shortConfirmation = allocation.shortConfirmation || null;
  component.lastProfitDeRisk = profitDeRisk;
  return {
    turnover: nextTurnover,
    monthChanged,
    dynamicLeverage: component.dynamicLeverage,
    activeSignalCount: component.activeSignalCount,
    shortConfirmation: component.shortConfirmation,
    profitDeRisk,
  };
}

function currentPositions(state, prices, profile) {
  const positions = PAPER_SYMBOLS.map((symbol) => {
    const marketNeutralWeight = profile.marketNeutralWeight
      * (state.components.marketNeutral.weights[symbol] || 0);
    const trendWeight = profile.trendWeight * (state.components.trend.weights[symbol] || 0);
    const weight = marketNeutralWeight + trendWeight;
    const markPrice = prices[symbol];
    const notional = state.equity * weight;
    return {
      symbol,
      side: weight > 0 ? 'LONG' : weight < 0 ? 'SHORT' : 'FLAT',
      weight: round(weight),
      weightPercent: round(weight * 100, 4),
      marketNeutralWeight: round(marketNeutralWeight),
      trendWeight: round(trendWeight),
      markPrice: round(markPrice),
      notional: round(notional, 4),
      quantity: round(markPrice ? notional / markPrice : 0, 8),
    };
  }).filter((item) => item.side !== 'FLAT');
  const modelGrossExposure = profile.marketNeutralWeight
    * sumAbsolute(state.components.marketNeutral.weights)
    + profile.trendWeight * sumAbsolute(state.components.trend.weights);
  const nettedGrossExposure = positions.reduce((sum, item) => sum + Math.abs(item.weight), 0);
  const netExposure = positions.reduce((sum, item) => sum + item.weight, 0);
  return {
    positions,
    modelGrossExposure: round(modelGrossExposure),
    nettedGrossExposure: round(nettedGrossExposure),
    netExposure: round(netExposure),
  };
}

function reportSummary(state, report) {
  return {
    ...report,
    mode: state.mode,
    status: state.status,
    strategyType: state.strategyType,
    strategyName: state.strategyName,
    timezone: state.timezone,
    schedule: state.schedule,
    initialCapital: state.initialCapital,
    equity: state.equity,
    totalPnl: round(state.equity - state.initialCapital, 4),
    totalReturn: round(state.equity / state.initialCapital - 1),
    maxDrawdown: state.maxDrawdown,
    positions: state.positions,
    modelGrossExposure: state.modelGrossExposure,
    nettedGrossExposure: state.nettedGrossExposure,
    netExposure: state.netExposure,
    componentState: {
      marketNeutral: {
        currentMonth: state.components.marketNeutral.currentMonth,
        monthlyReturn: round(
          state.components.marketNeutral.equity
            / state.components.marketNeutral.monthStartEquity - 1,
        ),
        lockReason: state.components.marketNeutral.lockReason,
        dynamicLeverage: state.components.marketNeutral.dynamicLeverage,
        newsOverlay: state.components.marketNeutral.lastNewsDecision || null,
        adaptiveRisk: state.components.marketNeutral.lastAdaptiveRisk || null,
        profitDeRisk: state.components.marketNeutral.lastProfitDeRisk || null,
      },
      trend: {
        currentMonth: state.components.trend.currentMonth,
        monthlyReturn: round(
          state.components.trend.equity / state.components.trend.monthStartEquity - 1,
        ),
        lockReason: state.components.trend.lockReason,
        dynamicLeverage: state.components.trend.dynamicLeverage,
        shortConfirmation: state.components.trend.shortConfirmation || null,
        profitDeRisk: state.components.trend.lastProfitDeRisk || null,
      },
    },
  };
}

export function initializePaperState({
  seriesBySymbol,
  cycleDate,
  markPrices,
  initialCapital = 10_000,
  now = Date.now(),
  profile = MONTHLY_ACCURACY_PAPER_PROFILE,
  newsSnapshot = null,
}) {
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new Error('模拟盘初始资金必须大于 0');
  }
  validatePrices(markPrices);
  const market = normalizeDailyMarket(seriesBySymbol);
  const signalDate = addUtcDays(cycleDate, -1);
  const upcomingResultDate = addUtcDays(cycleDate, 1);
  const state = {
    version: 1,
    mode: 'PAPER',
    status: 'running',
    strategyType: 'monthlyAccuracyPortfolio',
    strategyName: profile.name,
    strategyProfileId: profile.id,
    profileSnapshot: profileSnapshot(profile),
    timezone: 'Asia/Shanghai',
    schedule: '09:00',
    startedAt: new Date(now).toISOString(),
    startCycleDate: cycleDate,
    lastCycleDate: cycleDate,
    startSignalDate: signalDate,
    partialStartMonth: cycleDate.slice(0, 7),
    firstFullMonth: firstMonthAfter(cycleDate),
    initialCapital: round(initialCapital, 4),
    equity: round(initialCapital, 4),
    peakEquity: round(initialCapital, 4),
    maxDrawdown: 0,
    latestPrices: { ...markPrices },
    components: {
      marketNeutral: {
        equity: 1,
        monthStartEquity: 1,
        currentMonth: null,
        lockReason: null,
        baseWeights: zeroWeights(),
        weights: zeroWeights(),
        dynamicLeverage: 1,
        lastNewsDecision: null,
        lastAdaptiveRisk: null,
        lastProfitDeRisk: null,
      },
      trend: {
        equity: 1,
        monthStartEquity: 1,
        currentMonth: null,
        lockReason: null,
        weights: zeroWeights(),
        dynamicLeverage: 1,
        activeSignalCount: 0,
        averageSignalStrength: 0,
        shortConfirmation: null,
        lastProfitDeRisk: null,
      },
    },
    reports: [],
    updatedAt: new Date(now).toISOString(),
  };

  const marketNeutralTrade = prepareMarketNeutral({
    component: state.components.marketNeutral,
    market,
    signalDate,
    upcomingResultDate,
    profile,
    force: true,
    newsSnapshot,
  });
  const trendTrade = prepareTrend({
    component: state.components.trend,
    market,
    signalDate,
    upcomingResultDate,
    profile,
  });
  const marketNeutralTradingReturn = -marketNeutralTrade.turnover
    * profile.marketNeutral.tradingCostRate;
  const trendTradingReturn = -trendTrade.turnover
    * profile.trend.tradingCostRate;
  state.components.marketNeutral.equity *= 1 + marketNeutralTradingReturn;
  state.components.trend.equity *= 1 + trendTradingReturn;
  const deployedWeight = profile.marketNeutralWeight + profile.trendWeight;
  const allocationTradingReturn = -profile.allocationTradingCostRate * deployedWeight;
  const initialReturn = profile.marketNeutralWeight
      * marketNeutralTradingReturn
    + profile.trendWeight * trendTradingReturn
    + allocationTradingReturn;
  const startingEquity = state.equity;
  state.equity = round(startingEquity * (1 + initialReturn), 4);
  state.peakEquity = Math.max(state.peakEquity, state.equity);
  state.maxDrawdown = round(Math.min(0, state.equity / state.peakEquity - 1));
  const exposure = currentPositions(state, markPrices, profile);
  Object.assign(state, exposure);

  const report = reportSummary(state, {
    id: `paper-${cycleDate}-initial`,
    kind: 'initialization',
    cycleDate,
    signalDate,
    periodStart: null,
    periodEnd: `${cycleDate}T00:59:59.999Z`,
    reportedAt: new Date(now).toISOString(),
    startingEquity,
    endingEquity: state.equity,
    dayPnl: round(state.equity - startingEquity, 4),
    dayReturn: round(initialReturn),
    pricePnl: 0,
    carryCost: 0,
    tradingCost: round(-startingEquity * initialReturn, 4),
    marketNeutralReturn: round(marketNeutralTradingReturn),
    trendReturn: round(trendTradingReturn),
    componentAttribution: {
      marketNeutral: {
        pricePnl: 0,
        carryCost: 0,
        tradingCost: round(-startingEquity * profile.marketNeutralWeight
          * marketNeutralTradingReturn, 4),
        totalPnl: round(startingEquity * profile.marketNeutralWeight
          * marketNeutralTradingReturn, 4),
      },
      trend: {
        pricePnl: 0,
        carryCost: 0,
        tradingCost: round(-startingEquity * profile.trendWeight * trendTradingReturn, 4),
        totalPnl: round(startingEquity * profile.trendWeight * trendTradingReturn, 4),
      },
      allocation: {
        tradingCost: round(-startingEquity * allocationTradingReturn, 4),
        totalPnl: round(startingEquity * allocationTradingReturn, 4),
      },
    },
    symbolAttribution: [],
    settledNewsOverlay: null,
    settledAdaptiveRisk: null,
    settledProfitDeRisk: null,
    nextNewsOverlay: marketNeutralTrade.newsDecision,
    nextAdaptiveRisk: marketNeutralTrade.adaptiveRisk,
    nextProfitDeRisk: {
      marketNeutral: marketNeutralTrade.profitDeRisk,
      trend: trendTrade.profitDeRisk,
    },
    notes: [
      '今天只建立模拟仓位基线，不回填开始日前收益。',
      `${state.partialStartMonth} 为月中启动的不完整月份，不计入盈利月统计。`,
      ...(marketNeutralTrade.newsDecision
        ? [marketNeutralTrade.newsDecision.fallbackToPriceOnly
          ? `新闻增强未触发：${marketNeutralTrade.newsDecision.fallbackReason}。`
          : `新闻增强已应用 ${marketNeutralTrade.newsDecision.appliedNewsWeightPercent}% 权重。`]
        : []),
    ],
  });
  state.latestReport = report;
  state.reports.push(report);
  return state;
}

function prepareAfterSettlement({
  state,
  market,
  cycleDate,
  profile,
  newsSnapshot = null,
  forceMarketNeutralRebalance = false,
}) {
  const signalDate = addUtcDays(cycleDate, -1);
  const upcomingResultDate = addUtcDays(cycleDate, 1);
  const marketNeutralTrade = prepareMarketNeutral({
    component: state.components.marketNeutral,
    market,
    signalDate,
    upcomingResultDate,
    profile,
    force: forceMarketNeutralRebalance,
    newsSnapshot,
  });
  const trendTrade = prepareTrend({
    component: state.components.trend,
    market,
    signalDate,
    upcomingResultDate,
    profile,
  });
  return { signalDate, marketNeutralTrade, trendTrade };
}

export function advancePaperState({
  state,
  seriesBySymbol,
  markPricesByCycleDate,
  throughCycleDate,
  now = Date.now(),
  profile = state?.profileSnapshot || MONTHLY_ACCURACY_PAPER_PROFILE,
  newsSnapshotsByCycleDate = {},
}) {
  if (!state || state.version !== 1 || state.strategyProfileId !== profile.id) {
    throw new Error('模拟盘状态版本不兼容');
  }
  if (!state.profileSnapshot) state.profileSnapshot = profileSnapshot(profile);
  const market = normalizeDailyMarket(seriesBySymbol);
  let cycleDate = addUtcDays(state.lastCycleDate, 1);
  while (cycleDate <= throughCycleDate) {
    const pendingStrategyChange = state.pendingStrategyChange || null;
    const activatingStrategyChange = state.forceRebalanceNextCycle === true
      && (!pendingStrategyChange?.effectiveFromCycleDate
        || pendingStrategyChange.effectiveFromCycleDate <= cycleDate);
    const currentPrices = markPricesByCycleDate[cycleDate];
    validatePrices(currentPrices);
    validatePrices(state.latestPrices);
    if (state.components.marketNeutral.currentMonth !== cycleDate.slice(0, 7)
      || state.components.trend.currentMonth !== cycleDate.slice(0, 7)) {
      throw new Error(`${cycleDate} 模拟盘月份状态不一致`);
    }

    const startingEquity = state.equity;
    const marketNeutralStart = state.components.marketNeutral.equity;
    const trendStart = state.components.trend.equity;
    const marketNeutralMarketReturn = marketReturn(
      state.components.marketNeutral.weights,
      state.latestPrices,
      currentPrices,
    );
    const trendMarketReturn = marketReturn(
      state.components.trend.weights,
      state.latestPrices,
      currentPrices,
    );
    const symbolAttribution = PAPER_SYMBOLS.map((symbol) => {
      const assetReturn = currentPrices[symbol] / state.latestPrices[symbol] - 1;
      const marketNeutralWeight = profile.marketNeutralWeight
        * (state.components.marketNeutral.weights[symbol] || 0);
      const trendWeight = profile.trendWeight * (state.components.trend.weights[symbol] || 0);
      const marketNeutralPricePnl = startingEquity * marketNeutralWeight * assetReturn;
      const trendPricePnl = startingEquity * trendWeight * assetReturn;
      return {
        symbol,
        previousMarkPrice: round(state.latestPrices[symbol]),
        currentMarkPrice: round(currentPrices[symbol]),
        assetReturn: round(assetReturn),
        marketNeutralWeight: round(marketNeutralWeight),
        trendWeight: round(trendWeight),
        combinedWeight: round(marketNeutralWeight + trendWeight),
        marketNeutralPricePnl: round(marketNeutralPricePnl, 4),
        trendPricePnl: round(trendPricePnl, 4),
        totalPricePnl: round(marketNeutralPricePnl + trendPricePnl, 4),
      };
    });
    const marketNeutralCarryReturn = -sumAbsolute(state.components.marketNeutral.weights)
      * profile.marketNeutral.dailyCarryCostRate;
    const trendCarryReturn = -sumAbsolute(state.components.trend.weights)
      * profile.trend.dailyCarryCostRate;

    state.components.marketNeutral.equity = marketNeutralStart
      * (1 + marketNeutralMarketReturn + marketNeutralCarryReturn);
    state.components.trend.equity = trendStart * (1 + trendMarketReturn + trendCarryReturn);
    const upcomingResultDate = addUtcDays(cycleDate, 1);
    const closeWillExecute = upcomingResultDate.slice(0, 7) === cycleDate.slice(0, 7);
    const settledMarketNeutralLockEvaluation = updateMonthlyLock(
      state.components.marketNeutral,
      profile.marketNeutral,
      {
        settlementStartEquity: marketNeutralStart,
        currentWeights: state.components.marketNeutral.weights,
        closeWillExecute,
      },
    );
    const settledTrendLockEvaluation = updateMonthlyLock(
      state.components.trend,
      profile.trend,
      {
        settlementStartEquity: trendStart,
        currentWeights: state.components.trend.weights,
        closeWillExecute,
      },
    );
    const settledLocks = {
      marketNeutral: state.components.marketNeutral.lockReason,
      trend: state.components.trend.lockReason,
    };
    const settledNewsOverlay = state.components.marketNeutral.lastNewsDecision || null;
    const settledAdaptiveRisk = state.components.marketNeutral.lastAdaptiveRisk || null;
    const settledProfitDeRisk = {
      marketNeutral: state.components.marketNeutral.lastProfitDeRisk || null,
      trend: state.components.trend.lastProfitDeRisk || null,
    };

    const { signalDate, marketNeutralTrade, trendTrade } = prepareAfterSettlement({
      state,
      market,
      cycleDate,
      profile,
      forceMarketNeutralRebalance: activatingStrategyChange,
      newsSnapshot: newsSnapshotsByCycleDate[cycleDate] || null,
    });
    const marketNeutralTradingReturn = -marketNeutralTrade.turnover
      * profile.marketNeutral.tradingCostRate;
    const trendTradingReturn = -trendTrade.turnover
      * profile.trend.tradingCostRate;
    const marketNeutralReturn = marketNeutralMarketReturn
      + marketNeutralCarryReturn
      + marketNeutralTradingReturn;
    const trendReturn = trendMarketReturn + trendCarryReturn + trendTradingReturn;
    state.components.marketNeutral.equity = marketNeutralStart * (1 + marketNeutralReturn);
    state.components.trend.equity = trendStart * (1 + trendReturn);

    const portfolioPriceReturn = profile.marketNeutralWeight
        * marketNeutralMarketReturn
      + profile.trendWeight * trendMarketReturn;
    const portfolioCarryReturn = profile.marketNeutralWeight
        * marketNeutralCarryReturn
      + profile.trendWeight * trendCarryReturn;
    const portfolioTradingReturn = profile.marketNeutralWeight
        * marketNeutralTradingReturn
      + profile.trendWeight * trendTradingReturn;
    const dayReturn = portfolioPriceReturn + portfolioCarryReturn + portfolioTradingReturn;
    state.equity = round(startingEquity * (1 + dayReturn), 4);
    state.peakEquity = round(Math.max(state.peakEquity, state.equity), 4);
    state.maxDrawdown = round(Math.min(
      state.maxDrawdown,
      state.equity / state.peakEquity - 1,
    ));
    state.latestPrices = { ...currentPrices };
    state.lastCycleDate = cycleDate;
    state.updatedAt = new Date(now).toISOString();
    const exposure = currentPositions(state, currentPrices, profile);
    Object.assign(state, exposure);

    const report = reportSummary(state, {
      id: `paper-${cycleDate}`,
      kind: 'daily',
      cycleDate,
      signalDate,
      periodStart: `${addUtcDays(cycleDate, -1)}T00:59:59.999Z`,
      periodEnd: `${cycleDate}T00:59:59.999Z`,
      reportedAt: new Date(now).toISOString(),
      startingEquity,
      endingEquity: state.equity,
      dayPnl: round(state.equity - startingEquity, 4),
      dayReturn: round(dayReturn),
      pricePnl: round(startingEquity * portfolioPriceReturn, 4),
      carryCost: round(-startingEquity * portfolioCarryReturn, 4),
      tradingCost: round(-startingEquity * portfolioTradingReturn, 4),
      marketNeutralReturn: round(marketNeutralReturn),
      trendReturn: round(trendReturn),
      componentAttribution: {
        marketNeutral: {
          pricePnl: round(startingEquity * profile.marketNeutralWeight
            * marketNeutralMarketReturn, 4),
          carryCost: round(-startingEquity * profile.marketNeutralWeight
            * marketNeutralCarryReturn, 4),
          tradingCost: round(-startingEquity * profile.marketNeutralWeight
            * marketNeutralTradingReturn, 4),
          totalPnl: round(startingEquity * profile.marketNeutralWeight
            * marketNeutralReturn, 4),
        },
        trend: {
          pricePnl: round(startingEquity * profile.trendWeight * trendMarketReturn, 4),
          carryCost: round(-startingEquity * profile.trendWeight * trendCarryReturn, 4),
          tradingCost: round(-startingEquity * profile.trendWeight
            * trendTradingReturn, 4),
          totalPnl: round(startingEquity * profile.trendWeight * trendReturn, 4),
        },
        allocation: {
          tradingCost: 0,
          totalPnl: 0,
        },
      },
      symbolAttribution,
      settledMonth: cycleDate.slice(0, 7),
      settledMonthReturns: {
        marketNeutral: round(settledMarketNeutralLockEvaluation.grossMonthlyReturn),
        trend: round(settledTrendLockEvaluation.grossMonthlyReturn),
      },
      settledLockEvaluation: {
        marketNeutral: lockEvaluationSnapshot(settledMarketNeutralLockEvaluation),
        trend: lockEvaluationSnapshot(settledTrendLockEvaluation),
      },
      settledLocks,
      settledNewsOverlay,
      settledAdaptiveRisk,
      settledProfitDeRisk,
      nextNewsOverlay: marketNeutralTrade.newsDecision,
      nextAdaptiveRisk: marketNeutralTrade.adaptiveRisk,
      nextProfitDeRisk: {
        marketNeutral: marketNeutralTrade.profitDeRisk,
        trend: trendTrade.profitDeRisk,
      },
      turnover: {
        marketNeutral: round(marketNeutralTrade.turnover),
        trend: round(trendTrade.turnover),
      },
      strategyChangeApplied: activatingStrategyChange
        ? {
          ...(pendingStrategyChange || {}),
          appliedAt: new Date(now).toISOString(),
          appliedCycleDate: cycleDate,
        }
        : null,
      notes: activatingStrategyChange
        ? [`本周期启用${profile.name}，并按最新完整信号重新计算横截面与趋势仓位。`]
        : [],
    });
    state.latestReport = report;
    state.reports.push(report);
    state.reports = state.reports.slice(-MAX_REPORTS);
    if (activatingStrategyChange) {
      state.forceRebalanceNextCycle = false;
      state.pendingStrategyChange = null;
    }
    cycleDate = addUtcDays(cycleDate, 1);
  }
  return state;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, fetchImpl, attempt = 1) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    if (attempt < 5) {
      await wait(250 * (2 ** (attempt - 1)));
      return fetchJson(url, fetchImpl, attempt + 1);
    }
    throw new Error(`请求 Binance 纸面盘行情失败：${error.message}`, { cause: error });
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 5) {
    const retryAfter = Number(response.headers.get('retry-after')) * 1000;
    await wait(Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : 250 * (2 ** (attempt - 1)));
    return fetchJson(url, fetchImpl, attempt + 1);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error(`Binance 纸面盘行情返回异常：${response.status} ${payload?.msg || ''}`.trim());
  }
  return payload;
}

async function fetchKlines({
  symbol,
  interval,
  startTime,
  endTime,
  baseUrl,
  fetchImpl,
}) {
  const intervalMs = interval === '1d' ? DAY_MS : HOUR_MS;
  const rows = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const query = new URLSearchParams({
      symbol,
      interval,
      startTime: String(cursor),
      endTime: String(endTime),
      limit: '1000',
    });
    const page = await fetchJson(`${baseUrl}/api/v3/klines?${query}`, fetchImpl);
    if (!page.length) break;
    rows.push(...page.filter((item) => Number(item[6]) <= endTime));
    const nextCursor = Number(page.at(-1)[0]) + intervalMs;
    if (nextCursor <= cursor) throw new Error(`${symbol} ${interval} 行情游标未前进`);
    cursor = nextCursor;
    if (page.length < 1000) break;
    await wait(40);
  }
  return rows;
}

export async function fetchPaperMarketData({
  historyStartDate,
  signalEndDate,
  markStartCycleDate,
  markEndCycleDate,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  symbols = PAPER_SYMBOLS,
}) {
  const dailyStart = utcDate(historyStartDate);
  const dailyEnd = utcDate(signalEndDate) + DAY_MS - 1;
  const markStart = utcDate(markStartCycleDate);
  const markEnd = utcDate(markEndCycleDate) + HOUR_MS - 1;
  const result = await Promise.all(symbols.map(async (symbol) => {
    const [dailyRows, hourlyRows] = await Promise.all([
      fetchKlines({
        symbol,
        interval: '1d',
        startTime: dailyStart,
        endTime: dailyEnd,
        baseUrl,
        fetchImpl,
      }),
      fetchKlines({
        symbol,
        interval: '1h',
        startTime: markStart,
        endTime: markEnd,
        baseUrl,
        fetchImpl,
      }),
    ]);
    const daily = dailyRows.map((item) => ({
      date: new Date(Number(item[0])).toISOString().slice(0, 10),
      close: Number(item[4]),
    }));
    const marks = Object.fromEntries(hourlyRows
      .filter((item) => new Date(Number(item[0])).getUTCHours() === 0)
      .map((item) => [
        new Date(Number(item[0])).toISOString().slice(0, 10),
        Number(item[4]),
      ]));
    return { symbol, daily, marks };
  }));

  const dailyDates = result.map((item) => new Set(item.daily.map((row) => row.date)))
    .reduce((intersection, dates) => (
      new Set([...intersection].filter((date) => dates.has(date)))
    ));
  const seriesBySymbol = Object.fromEntries(result.map((item) => [
    item.symbol,
    item.daily.filter((row) => dailyDates.has(row.date)),
  ]));
  const markPricesByCycleDate = {};
  for (let cycleDate = markStartCycleDate; cycleDate <= markEndCycleDate; cycleDate = addUtcDays(cycleDate, 1)) {
    const prices = Object.fromEntries(result.map((item) => [item.symbol, item.marks[cycleDate]]));
    validatePrices(prices, symbols);
    markPricesByCycleDate[cycleDate] = prices;
  }
  return { seriesBySymbol, markPricesByCycleDate };
}

async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export class PaperPortfolioStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.lockStaleMs = Number(options.lockStaleMs || 15 * 60_000);
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async run(mutator) {
    const release = await this.#acquireLock();
    try {
      const current = await this.read();
      const next = await mutator(current);
      if (next !== undefined && next !== null) {
        await atomicWrite(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
      }
      return next;
    } finally {
      await release();
    }
  }

  async #acquireLock() {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    try {
      const handle = await fs.open(this.lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
      await handle.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stats = await fs.stat(this.lockPath).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > this.lockStaleMs) {
        await fs.rm(this.lockPath, { force: true });
        return this.#acquireLock();
      }
      throw new Error('模拟盘正在由另一个进程结算，请稍后重试');
    }
    return async () => {
      await fs.rm(this.lockPath, { force: true });
    };
  }
}

export function paperPortfolioSnapshot(state) {
  if (!state) {
    return {
      mode: 'PAPER',
      status: 'not_started',
      strategyType: 'monthlyAccuracyPortfolio',
      strategyName: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.name,
      timezone: 'Asia/Shanghai',
      schedule: '09:00',
      nextReportAt: null,
      reports: [],
      positions: [],
    };
  }
  const nextCycleDate = addUtcDays(state.lastCycleDate, 1);
  return {
    mode: state.mode,
    status: state.status,
    strategyType: state.strategyType,
    strategyName: state.strategyName,
    strategyProfileId: state.strategyProfileId,
    timezone: state.timezone,
    schedule: state.schedule,
    startedAt: state.startedAt,
    startCycleDate: state.startCycleDate,
    lastCycleDate: state.lastCycleDate,
    nextReportAt: `${nextCycleDate}T09:00:00+08:00`,
    partialStartMonth: state.partialStartMonth,
    firstFullMonth: state.firstFullMonth,
    initialCapital: state.initialCapital,
    equity: state.equity,
    totalPnl: round(state.equity - state.initialCapital, 4),
    totalReturn: round(state.equity / state.initialCapital - 1),
    maxDrawdown: state.maxDrawdown,
    modelGrossExposure: state.modelGrossExposure,
    nettedGrossExposure: state.nettedGrossExposure,
    netExposure: state.netExposure,
    positions: state.positions || [],
    latestReport: state.latestReport || null,
    reports: state.reports || [],
    componentState: state.components ? {
      marketNeutral: {
        currentMonth: state.components.marketNeutral.currentMonth,
        monthlyReturn: round(
          state.components.marketNeutral.equity
            / state.components.marketNeutral.monthStartEquity - 1,
        ),
        lockReason: state.components.marketNeutral.lockReason,
        dynamicLeverage: state.components.marketNeutral.dynamicLeverage,
        newsOverlay: state.components.marketNeutral.lastNewsDecision || null,
        adaptiveRisk: state.components.marketNeutral.lastAdaptiveRisk || null,
        profitDeRisk: state.components.marketNeutral.lastProfitDeRisk || null,
      },
      trend: {
        currentMonth: state.components.trend.currentMonth,
        monthlyReturn: round(
          state.components.trend.equity / state.components.trend.monthStartEquity - 1,
        ),
        lockReason: state.components.trend.lockReason,
        dynamicLeverage: state.components.trend.dynamicLeverage,
        shortConfirmation: state.components.trend.shortConfirmation || null,
        profitDeRisk: state.components.trend.lastProfitDeRisk || null,
      },
    } : null,
    monthlyProfitLockEnabled: {
      marketNeutral: state.profileSnapshot?.marketNeutral?.monthlyProfitLock !== null,
      trend: state.profileSnapshot?.trend?.monthlyProfitLock !== null,
    },
    pendingStrategyChange: state.pendingStrategyChange || null,
    latestStrategyChange: state.strategyChanges?.at(-1) || null,
    updatedAt: state.updatedAt,
  };
}

export async function writePaperReportArtifacts(rootDir, state) {
  const reportDir = path.join(rootDir, 'data', 'runtime', 'paper-reports');
  const latest = state.latestReport;
  if (!latest) return;
  const sign = (value) => Number(value) > 0 ? '+' : '';
  const percent = (value) => `${sign(value)}${(Number(value) * 100).toFixed(2)}%`;
  const money = (value) => `${sign(value)}${Number(value).toFixed(2)} USDT`;
  const lines = [
    `# QuantFlow 模拟盘日报 ${latest.cycleDate}`,
    '',
    `- 策略：${state.strategyName}`,
    `- 模式：${state.mode}（不会真实下单）`,
    `- 报告时间：北京时间每日 ${state.schedule}`,
    `- 当日盈亏：${money(latest.dayPnl)}（${percent(latest.dayReturn)}）`,
    `- 当前净值：${Number(state.equity).toFixed(2)} USDT`,
    `- 累计盈亏：${money(state.equity - state.initialCapital)}（${percent(state.equity / state.initialCapital - 1)}）`,
    `- 最大回撤：${percent(state.maxDrawdown)}`,
    `- 价格贡献：${money(latest.pricePnl)}`,
    `- 交易成本：-${Number(latest.tradingCost).toFixed(2)} USDT`,
    `- 持仓成本：-${Number(latest.carryCost).toFixed(2)} USDT`,
    `- 模型总敞口：${(Number(state.modelGrossExposure) * 100).toFixed(2)}%`,
    '',
    '## 当前模拟仓位',
    '',
    '| 交易对 | 方向 | 目标权重 | 名义金额 | 估值价 |',
    '| --- | --- | ---: | ---: | ---: |',
    ...(state.positions.length ? state.positions.map((position) => (
      `| ${position.symbol} | ${position.side === 'LONG' ? '多' : '空'} | ${position.weightPercent.toFixed(2)}% | ${position.notional.toFixed(2)} USDT | ${position.markPrice} |`
    )) : ['| - | 空仓 | 0.00% | 0.00 USDT | - |']),
    '',
    '> 这是纸面模拟结果，使用公开行情和固定成本模型，不代表真实成交或未来收益。',
    '',
  ];
  await atomicWrite(
    path.join(reportDir, `${latest.cycleDate}.json`),
    `${JSON.stringify(latest, null, 2)}\n`,
  );
  await atomicWrite(path.join(reportDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  await atomicWrite(path.join(reportDir, 'latest.md'), `${lines.join('\n')}\n`);
}
