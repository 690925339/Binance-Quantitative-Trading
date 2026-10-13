import fs from 'node:fs/promises';
import path from 'node:path';
import {
  calculateAnnualizedVolatility,
  calculateLongShortTrendWeights,
  calculateTrendSignal,
} from './long-short-trend.js';
import { addUtcDays, latestCompletePaperCycleDate } from './monthly-accuracy-paper.js';

const MAX_REPORTS = 4_000;
const BTC_SYMBOL = 'BTCUSDT';

export const BTC_SINGLE_ASSET_PAPER_PROFILE = Object.freeze({
  id: 'btc-single-asset-trend-news-v1',
  name: 'BTC单币动态多空模拟盘',
  symbol: BTC_SYMBOL,
  tradingCostRate: 0.0007,
  dailyCarryCostRate: 0.00005,
  monthlyProfitLock: null,
  monthlyLossLimit: 0.015,
  monthlyProfitDeRiskThreshold: 0.01,
  monthlyProfitDeRiskScale: 0.10,
  newsRiskGrossExposureScale: 0.75,
  newsRiskMinimumAbsoluteScore: 0.15,
  newsRiskMinimumCredibility: 65,
  newsRiskMinimumConfidence: 45,
  trend: Object.freeze({
    positionMode: 'both',
    lookbackDays: [45, 90, 180],
    minimumTrendVotes: 2,
    minimumActiveSignals: 1,
    minimumTrendStrength: 0.02,
    targetVolatility: 0.10,
    maxGrossExposure: 1,
    maxAssetExposure: 1,
    dynamicLeverageEnabled: true,
    dynamicLeverageMin: 1,
    dynamicLeverageMax: 3,
    dynamicLeverageStrengthTarget: 0.20,
    volatilityWindowDays: 30,
    rebalanceDays: 1,
    shortConfirmationLookbackDays: null,
    shortConfirmationMinimumReturn: 0,
    tradingCostRate: 0.0007,
    dailyCarryCostRate: 0.00005,
  }),
});

export const BTC_NEWS_DATA_GUARD_PROFILE = Object.freeze({
  ...BTC_SINGLE_ASSET_PAPER_PROFILE,
  id: 'btc-single-asset-trend-news-v2-data-guard',
  name: 'BTC单币动态多空｜新闻数据保护',
  newsDataQualityGuardEnabled: true,
});

export function queueBtcNewsDataGuard(state, now = Date.now()) {
  if (!state || state.profileSnapshot?.newsDataQualityGuardEnabled || state.pendingStrategyChange) return state;
  state.pendingStrategyChange = { fromProfileId: state.strategyProfileId,
    toProfileId: BTC_NEWS_DATA_GUARD_PROFILE.id, queuedAt: new Date(now).toISOString(),
    effectiveFromCycleDate: addUtcDays([state.lastCycleDate, latestCompletePaperCycleDate(now)].sort().at(-1), 1),
    reason: '新闻缺失或过期时禁止增加风险，保留减仓与退出；不更改杠杆、趋势或盈利降风险参数。' };
  return state;
}

export function evaluateBtcNewsDataGuard(previousWeight, proposedWeight, newsRisk, enabled = false) {
  const active = enabled && !newsRisk?.signalFresh;
  const targetWeight = active
    ? (previousWeight * proposedWeight > 0 ? Math.sign(proposedWeight) * Math.min(Math.abs(previousWeight), Math.abs(proposedWeight)) : 0)
    : proposedWeight;
  return { enabled, active, blockedIncrease: active && targetWeight !== proposedWeight,
    proposedWeight, targetWeight, reason: active ? 'news_missing_or_stale_no_new_risk' : null };
}

function round(value, digits = 8) {
  return Number(Number(value).toFixed(digits));
}

function utcDate(value) {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(timestamp)) {
    throw new Error(`无效 UTC 日期：${value}`);
  }
  return timestamp;
}

function firstMonthAfter(value) {
  const date = new Date(utcDate(value));
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return date.toISOString().slice(0, 7);
}

function profileSnapshot(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function normalizeSeries(seriesBySymbol, profile) {
  const series = seriesBySymbol?.[profile.symbol];
  if (!Array.isArray(series) || !series.length) throw new Error(`${profile.symbol} 行情不能为空`);
  const dates = [];
  const closes = [];
  const dateIndex = new Map();
  for (const item of series) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date || '')
      || !Number.isFinite(item.close)
      || item.close <= 0) {
      throw new Error(`${profile.symbol} 包含无效行情`);
    }
    if (dateIndex.has(item.date)) throw new Error(`${profile.symbol} ${item.date} 行情重复`);
    dateIndex.set(item.date, dates.length);
    dates.push(item.date);
    closes.push(item.close);
  }
  return { dates, closes, dateIndex };
}

function validatePrice(price, label = 'BTC估值价') {
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) throw new Error(`${label}无效`);
  return Number(price);
}

function captureTime(newsSnapshot) {
  return newsSnapshot?.capturedForDecisionAt || newsSnapshot?.updatedAt || null;
}

function newsIsFresh(newsSnapshot, cycleDate) {
  if (newsSnapshot?.status !== 'live') return false;
  if (newsSnapshot.paperCycleDate && newsSnapshot.paperCycleDate !== cycleDate) return false;
  const capturedAt = captureTime(newsSnapshot);
  if (!capturedAt) return false;
  const time = Date.parse(capturedAt);
  const startsAt = Date.parse(`${cycleDate}T01:00:00.000Z`);
  const endsAt = Date.parse(`${cycleDate}T01:15:00.000Z`);
  return Number.isFinite(time) && time >= startsAt && time <= endsAt;
}

export function evaluateBtcNewsRisk(newsSnapshot, proposedWeight, cycleDate, profile = BTC_SINGLE_ASSET_PAPER_PROFILE) {
  const summary = newsSnapshot?.summary?.bySymbol?.[profile.symbol] || null;
  const score = Number(summary?.symbolSpecificScore || 0);
  const direction = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
  const evidence = summary?.symbolSpecificDirectionalEvidence?.[direction] || null;
  const confirmedEventCount = Number(evidence?.confirmedEventCount || 0);
  const corroboratedEventCount = Number(evidence?.corroboratedEventCount || 0);
  const signalFresh = newsIsFresh(newsSnapshot, cycleDate);
  const credibility = Number(summary?.symbolSpecificCredibility || 0);
  const confidence = Number(summary?.symbolSpecificConfidence || 0);
  const articleCount = Number(summary?.symbolSpecificArticleCount || 0);
  const evidencePassed = confirmedEventCount >= 1 || corroboratedEventCount >= 1;
  const eligible = signalFresh
    && Math.abs(score) >= profile.newsRiskMinimumAbsoluteScore
    && credibility >= profile.newsRiskMinimumCredibility
    && confidence >= profile.newsRiskMinimumConfidence
    && articleCount >= 1
    && evidencePassed;
  const conflict = eligible && ((proposedWeight > 0 && score < 0)
    || (proposedWeight < 0 && score > 0));
  const checks = {
    fresh: signalFresh,
    directionStrength: Math.abs(score) >= profile.newsRiskMinimumAbsoluteScore,
    credibility: credibility >= profile.newsRiskMinimumCredibility,
    confidence: confidence >= profile.newsRiskMinimumConfidence,
    articles: articleCount >= 1,
    directionalEvidence: evidencePassed,
  };
  return {
    status: newsSnapshot?.status || 'missing',
    signalFresh,
    score: round(score),
    direction,
    credibility: round(credibility, 2),
    confidence: round(confidence, 2),
    articleCount,
    confirmedEventCount,
    corroboratedEventCount,
    evidencePassed,
    eligible,
    conflict,
    checks,
    failedChecks: Object.keys(checks).filter((key) => !checks[key]),
    appliedGrossExposureScale: conflict ? profile.newsRiskGrossExposureScale : 1,
    fallbackReason: eligible
      ? null
      : !signalFresh
        ? '缺少09:00决策窗口内的实时BTC新闻快照'
        : !evidencePassed
          ? '缺少同方向官方确认或独立多源事件证据'
          : 'BTC专属新闻未通过方向、可信度或置信度门槛',
    capturedAt: captureTime(newsSnapshot),
  };
}

function signalAllocation(seriesBySymbol, signalDate, profile) {
  const market = normalizeSeries(seriesBySymbol, profile);
  const signalIndex = market.dateIndex.get(signalDate);
  const settings = profile.trend;
  if (profile.entryGuardAdverseMove != null && (!Number.isInteger(profile.entryGuardLookbackDays)
    || profile.entryGuardLookbackDays < 1)) throw new Error('BTC短期逆向过滤窗口无效');
  const warmup = Math.max(...settings.lookbackDays, settings.volatilityWindowDays,
    settings.shortConfirmationLookbackDays || 0, profile.entryGuardLookbackDays || 0);
  if (!Number.isInteger(signalIndex) || signalIndex < warmup) {
    throw new Error(`${signalDate} BTC信号预热不足`);
  }
  const closesBySymbol = { [profile.symbol]: market.closes };
  const allocation = calculateLongShortTrendWeights(
    closesBySymbol,
    [profile.symbol],
    signalIndex,
    settings,
  );
  const signal = calculateTrendSignal(market.closes, signalIndex, settings);
  return {
    rawWeight: allocation.weights[profile.symbol] || 0,
    entryGuardReturn: profile.entryGuardLookbackDays
      ? market.closes[signalIndex] / market.closes[signalIndex - profile.entryGuardLookbackDays] - 1 : null,
    dynamicLeverage: allocation.dynamicLeverage,
    activeSignalCount: allocation.activeSignalCount,
    averageSignalStrength: allocation.averageSignalStrength,
    signalDirection: signal.direction,
    signalStrength: signal.strength,
    agreeingVotes: signal.agreeingVotes,
    volatility: calculateAnnualizedVolatility(
      market.closes,
      signalIndex,
      settings.volatilityWindowDays,
    ),
  };
}

export function evaluateBtcProfitDeRisk(state, profile = BTC_SINGLE_ASSET_PAPER_PROFILE) {
  const monthlyReturn = state.equity / state.monthStartEquity - 1;
  const active = monthlyReturn >= profile.monthlyProfitDeRiskThreshold;
  const mode = profile.monthlyProfitDeRiskMode || 'step';
  let scale = active ? profile.monthlyProfitDeRiskScale : 1;
  if (mode === 'linear') {
    const fullAt = profile.monthlyProfitDeRiskFullAt;
    if (!Number.isFinite(fullAt) || fullAt <= profile.monthlyProfitDeRiskThreshold
      || !(profile.monthlyProfitDeRiskScale > 0 && profile.monthlyProfitDeRiskScale <= 1)) {
      throw new Error('BTC渐进减仓参数无效');
    }
    const progress = Math.max(0, Math.min(1,
      (monthlyReturn - profile.monthlyProfitDeRiskThreshold)
        / (fullAt - profile.monthlyProfitDeRiskThreshold)));
    scale = 1 - progress * (1 - profile.monthlyProfitDeRiskScale);
  } else if (mode !== 'step') {
    throw new Error('未知BTC减仓模式');
  }
  return {
    enabled: true,
    active,
    mode,
    threshold: profile.monthlyProfitDeRiskThreshold,
    configuredScale: profile.monthlyProfitDeRiskScale,
    scale,
    monthlyReturn: round(monthlyReturn),
  };
}

function positionFor(state, price, profile) {
  if (!state.weight) return [];
  const notional = state.equity * state.weight;
  return [{
    symbol: profile.symbol,
    side: state.weight > 0 ? 'LONG' : 'SHORT',
    weight: round(state.weight),
    weightPercent: round(state.weight * 100, 4),
    markPrice: round(price),
    notional: round(notional, 4),
    quantity: round(notional / price, 8),
  }];
}

function signalSnapshot(allocation) {
  return {
    direction: allocation.signalDirection > 0
      ? 'LONG'
      : allocation.signalDirection < 0
        ? 'SHORT'
        : 'FLAT',
    agreeingVotes: allocation.agreeingVotes,
    strength: round(allocation.signalStrength),
    annualizedVolatility: round(allocation.volatility),
    dynamicLeverage: round(allocation.dynamicLeverage),
    rawWeight: round(allocation.rawWeight),
  };
}

export function evaluateBtcRebalance(previousWeight, proposedWeight, minimumIncrease = 0, maximumIncrease = null) {
  if (!Number.isFinite(minimumIncrease) || minimumIncrease < 0 || minimumIncrease > 0.1) {
    throw new Error('BTC最小加仓阈值必须在0至10%之间');
  }
  const sameDirection = previousWeight * proposedWeight > 0;
  const increase = Math.abs(proposedWeight) - Math.abs(previousWeight);
  const deferred = sameDirection && increase > 0 && increase < minimumIncrease;
  if (maximumIncrease !== null && (!Number.isFinite(maximumIncrease) || maximumIncrease <= 0 || maximumIncrease > 1
    || maximumIncrease < minimumIncrease)) throw new Error('BTC每日加仓上限无效');
  let executedWeight = deferred ? previousWeight : proposedWeight;
  if (maximumIncrease !== null) {
    const existingSameSide = sameDirection ? Math.abs(previousWeight) : 0;
    executedWeight = Math.sign(executedWeight) * Math.min(Math.abs(executedWeight), existingSameSide + maximumIncrease);
  }
  // Reductions and exits are immediate; new opposite-side risk can still be capped.
  return { minimumIncrease, maximumIncrease, deferred, targetWeight: proposedWeight,
    executedWeight, increaseCapped: executedWeight !== (deferred ? previousWeight : proposedWeight) };
}

export function evaluateBtcEntryGuard(previousWeight, proposedWeight, recentReturn, threshold = null) {
  if (threshold === null) return { active: false, targetWeight: proposedWeight };
  if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(recentReturn)) throw new Error('BTC短期逆向过滤参数无效');
  const active = proposedWeight !== 0 && Math.sign(proposedWeight) * recentReturn <= -threshold;
  const targetWeight = active
    ? previousWeight * proposedWeight > 0 ? Math.sign(proposedWeight) * Math.min(Math.abs(previousWeight), Math.abs(proposedWeight)) : 0
    : proposedWeight;
  return { active, targetWeight, recentReturn, threshold };
}

function applyNextSignal({ state, seriesBySymbol, signalDate, cycleDate, newsSnapshot, profile }) {
  const allocation = signalAllocation(seriesBySymbol, signalDate, profile);
  const deRisk = evaluateBtcProfitDeRisk(state, profile);
  const lossContinuationScale = profile.monthlyLossContinuationScale ?? 0;
  if (!Number.isFinite(lossContinuationScale) || lossContinuationScale < 0 || lossContinuationScale > 0.1) {
    throw new Error('BTC月损后研究敞口比例只能在0至10%之间');
  }
  const lossScale = state.lockReason === null ? 1 : state.lockReason === 'loss' ? lossContinuationScale : 0;
  let proposedWeight = lossScale ? allocation.rawWeight * deRisk.scale * lossScale : 0;
  if (state.lockReason === 'loss') {
    proposedWeight = Math.sign(proposedWeight) * Math.min(Math.abs(proposedWeight), lossContinuationScale);
  }
  const entryGuard = evaluateBtcEntryGuard(state.weight, proposedWeight, allocation.entryGuardReturn, profile.entryGuardAdverseMove ?? null);
  proposedWeight = entryGuard.targetWeight;
  const newsRisk = evaluateBtcNewsRisk(newsSnapshot, proposedWeight, cycleDate, profile);
  proposedWeight *= newsRisk.appliedGrossExposureScale;
  const dataQualityRisk = evaluateBtcNewsDataGuard(state.weight, proposedWeight, newsRisk, profile.newsDataQualityGuardEnabled);
  proposedWeight = dataQualityRisk.targetWeight;
  const rebalance = evaluateBtcRebalance(state.weight, proposedWeight, profile.minimumWeightIncrease || 0, profile.maximumWeightIncrease ?? null);
  return {
    allocation,
    profitDeRisk: deRisk,
    newsRisk,
    proposedWeight: rebalance.executedWeight,
    rebalance,
    dataQualityRisk,
    entryGuard,
  };
}

function stateSnapshotFields(state, profile) {
  return {
    modelGrossExposure: round(Math.abs(state.weight)),
    nettedGrossExposure: round(Math.abs(state.weight)),
    netExposure: round(state.weight),
    positions: positionFor(state, state.latestPrice, profile),
  };
}

export function initializeBtcPaperState({
  seriesBySymbol,
  cycleDate,
  markPrice,
  initialCapital = 10_000,
  now = Date.now(),
  profile = BTC_SINGLE_ASSET_PAPER_PROFILE,
  newsSnapshot = null,
  entryMode = 'live_mark',
}) {
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new Error('BTC模拟盘初始资金必须大于0');
  }
  const price = validatePrice(markPrice);
  const signalDate = addUtcDays(cycleDate, -1);
  const reportedAt = new Date(Number(now)).toISOString();
  const state = {
    version: 1,
    mode: 'PAPER',
    status: 'running',
    strategyType: 'btcSingleAssetTrend',
    strategyName: profile.name,
    strategyProfileId: profile.id,
    profileSnapshot: profileSnapshot(profile),
    symbol: profile.symbol,
    timezone: 'Asia/Shanghai',
    schedule: '09:00',
    startedAt: reportedAt,
    startCycleDate: cycleDate,
    lastCycleDate: cycleDate,
    startSignalDate: signalDate,
    partialStartMonth: cycleDate.slice(0, 7),
    firstFullMonth: firstMonthAfter(cycleDate),
    initialCapital: round(initialCapital, 4),
    equity: round(initialCapital, 4),
    peakEquity: round(initialCapital, 4),
    maxDrawdown: 0,
    latestPrice: price,
    weight: 0,
    currentMonth: addUtcDays(cycleDate, 1).slice(0, 7),
    monthStartEquity: round(initialCapital, 4),
    lockReason: null,
    lastSignal: null,
    lastNewsRisk: null,
    lastProfitDeRisk: null,
    reports: [],
    updatedAt: reportedAt,
  };
  const next = applyNextSignal({
    state,
    seriesBySymbol,
    signalDate,
    cycleDate,
    newsSnapshot,
    profile,
  });
  const turnover = Math.abs(next.proposedWeight);
  const tradingCost = initialCapital * turnover * profile.tradingCostRate;
  state.equity = round(initialCapital - tradingCost, 4);
  state.weight = round(next.proposedWeight);
  state.lastSignal = signalSnapshot(next.allocation);
  state.lastNewsRisk = next.newsRisk;
  state.lastProfitDeRisk = next.profitDeRisk;
  state.lastRebalance = next.rebalance;
  state.lastDataQualityRisk = next.dataQualityRisk;
  state.lastEntryGuard = next.entryGuard;
  state.maxDrawdown = round(state.equity / state.peakEquity - 1);
  Object.assign(state, stateSnapshotFields(state, profile));
  const report = {
    id: `btc-paper-${cycleDate}-initial`,
    kind: 'initialization',
    strategyProfileId: state.strategyProfileId,
    cycleDate,
    signalDate,
    periodStart: reportedAt,
    periodEnd: reportedAt,
    reportedAt,
    entryMode,
    startingEquity: round(initialCapital, 4),
    endingEquity: state.equity,
    equity: state.equity,
    dayPnl: round(-tradingCost, 4),
    dayReturn: round(-tradingCost / initialCapital),
    pricePnl: 0,
    carryCost: 0,
    tradingCost: round(tradingCost, 4),
    assetReturn: 0,
    turnover: round(turnover),
    previousWeight: 0,
    nextWeight: state.weight,
    signal: state.lastSignal,
    newsRisk: state.lastNewsRisk,
    profitDeRisk: state.lastProfitDeRisk,
    rebalance: state.lastRebalance,
    dataQualityRisk: state.lastDataQualityRisk,
    entryGuard: state.lastEntryGuard,
    lockReason: state.lockReason,
    positions: state.positions,
    modelGrossExposure: state.modelGrossExposure,
    notes: [
      '只建立BTC模拟仓位基线，不回填启动前收益。',
      '进场价格使用创建模拟仓时取得的公开实时BTC价格。',
    ],
  };
  state.latestReport = report;
  state.reports.push(report);
  return state;
}

export function advanceBtcPaperState({
  state,
  seriesBySymbol,
  markPricesByCycleDate,
  throughCycleDate,
  now = Date.now(),
  profile = state?.profileSnapshot ?? BTC_SINGLE_ASSET_PAPER_PROFILE,
  newsSnapshotsByCycleDate = {},
}) {
  if (!state || state.version !== 1 || state.strategyProfileId !== profile.id) {
    throw new Error('BTC模拟盘状态或策略版本不兼容');
  }
  let cycleDate = addUtcDays(state.lastCycleDate, 1);
  while (cycleDate <= throughCycleDate) {
    const settledStrategyProfileId = state.strategyProfileId;
    if (state.pendingStrategyChange && cycleDate >= state.pendingStrategyChange.effectiveFromCycleDate) {
      const change = state.pendingStrategyChange;
      if (change.toProfileId !== BTC_NEWS_DATA_GUARD_PROFILE.id) throw new Error('未知BTC待生效策略');
      profile = { ...profile, id: change.toProfileId, name: BTC_NEWS_DATA_GUARD_PROFILE.name, newsDataQualityGuardEnabled: true };
      state.strategyProfileId = profile.id;
      state.strategyName = profile.name;
      state.profileSnapshot = profileSnapshot(profile);
      state.strategyChanges = [...(state.strategyChanges || []), { ...change, appliedAt: new Date(now).toISOString() }];
      state.pendingStrategyChange = null;
    }
    const signalDate = addUtcDays(cycleDate, -1);
    const currentPrice = validatePrice(
      markPricesByCycleDate?.[cycleDate]?.[profile.symbol]
        ?? markPricesByCycleDate?.[cycleDate],
      `${cycleDate} BTC估值价`,
    );
    const startingEquity = state.equity;
    const previousWeight = state.weight;
    const assetReturn = currentPrice / state.latestPrice - 1;
    const priceReturn = previousWeight * assetReturn;
    const carryReturn = -Math.abs(previousWeight) * profile.dailyCarryCostRate;
    state.equity = startingEquity * (1 + priceReturn + carryReturn);
    if (state.lockReason === null
      && state.equity / state.monthStartEquity - 1 <= -profile.monthlyLossLimit) {
      state.lockReason = 'loss';
    }
    const settledLockReason = state.lockReason;
    const upcomingResultDate = addUtcDays(cycleDate, 1);
    const upcomingMonth = upcomingResultDate.slice(0, 7);
    let monthChanged = false;
    if (state.currentMonth !== upcomingMonth) {
      state.currentMonth = upcomingMonth;
      state.monthStartEquity = state.equity;
      state.lockReason = null;
      monthChanged = true;
    }
    const next = applyNextSignal({
      state,
      seriesBySymbol,
      signalDate,
      cycleDate,
      newsSnapshot: newsSnapshotsByCycleDate[cycleDate] || null,
      profile,
    });
    const turnover = Math.abs(next.proposedWeight - previousWeight);
    const tradingReturn = -turnover * profile.tradingCostRate;
    const tradingCost = startingEquity * -tradingReturn;
    state.equity += startingEquity * tradingReturn;
    state.equity = round(state.equity, 4);
    state.weight = round(next.proposedWeight);
    state.latestPrice = currentPrice;
    state.lastSignal = signalSnapshot(next.allocation);
    state.lastNewsRisk = next.newsRisk;
    state.lastProfitDeRisk = next.profitDeRisk;
    state.lastRebalance = next.rebalance;
    state.lastDataQualityRisk = next.dataQualityRisk;
    state.lastEntryGuard = next.entryGuard;
    state.peakEquity = round(Math.max(state.peakEquity, state.equity), 4);
    state.maxDrawdown = round(Math.min(state.maxDrawdown, state.equity / state.peakEquity - 1));
    state.lastCycleDate = cycleDate;
    state.updatedAt = new Date(Number(now)).toISOString();
    Object.assign(state, stateSnapshotFields(state, profile));
    const dayReturn = state.equity / startingEquity - 1;
    const report = {
      id: `btc-paper-${cycleDate}`,
      kind: 'daily',
      strategyProfileId: state.strategyProfileId,
      settledStrategyProfileId,
      cycleDate,
      signalDate,
      periodStart: state.latestReport?.periodEnd || null,
      periodEnd: `${cycleDate}T00:59:59.999Z`,
      reportedAt: state.updatedAt,
      startingEquity: round(startingEquity, 4),
      endingEquity: state.equity,
      equity: state.equity,
      dayPnl: round(state.equity - startingEquity, 4),
      dayReturn: round(dayReturn),
      pricePnl: round(startingEquity * priceReturn, 4),
      carryCost: round(-startingEquity * carryReturn, 4),
      tradingCost: round(tradingCost, 4),
      assetReturn: round(assetReturn),
      turnover: round(turnover),
      previousWeight: round(previousWeight),
      nextWeight: state.weight,
      signal: state.lastSignal,
      newsRisk: state.lastNewsRisk,
      profitDeRisk: state.lastProfitDeRisk,
      rebalance: state.lastRebalance,
      dataQualityRisk: state.lastDataQualityRisk,
      entryGuard: state.lastEntryGuard,
      settledLockReason,
      lockReason: state.lockReason,
      monthChanged,
      positions: state.positions,
      modelGrossExposure: state.modelGrossExposure,
      notes: state.lockReason === 'loss'
        ? [profile.monthlyLossContinuationScale > 0
          ? '研究模式：月损保护后仅保留缩减风险，绝对仓位不超过10%；不适用于当前模拟盘。'
          : 'BTC趋势袖套已触发1.5%月度亏损保护，本月剩余时间保持空仓。']
        : [],
    };
    state.latestReport = report;
    state.reports.push(report);
    state.reports = state.reports.slice(-MAX_REPORTS);
    cycleDate = addUtcDays(cycleDate, 1);
  }
  return state;
}

export function btcPaperSnapshot(state) {
  if (!state) {
    return {
      mode: 'PAPER',
      status: 'not_started',
      strategyType: 'btcSingleAssetTrend',
      strategyName: BTC_SINGLE_ASSET_PAPER_PROFILE.name,
      symbol: BTC_SYMBOL,
      timezone: 'Asia/Shanghai',
      schedule: '09:00',
      positions: [],
      reports: [],
      accuracy: null,
      nextReportAt: null,
    };
  }
  const nextCycleDate = addUtcDays(state.lastCycleDate, 1);
  const dailyReports = (state.reports || []).filter((report) => report.kind === 'daily');
  const directionalReports = dailyReports.filter((report) => (
    Math.abs(Number(report.pricePnl || 0)) > 1e-12
  ));
  const profitableDays = dailyReports.filter((report) => Number(report.dayReturn) > 0).length;
  const directionalHits = directionalReports.filter((report) => Number(report.pricePnl) > 0).length;
  return {
    mode: state.mode,
    status: state.status,
    strategyType: state.strategyType,
    strategyName: state.strategyName,
    strategyProfileId: state.strategyProfileId,
    symbol: state.symbol,
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
    currentMonth: state.currentMonth,
    monthlyReturn: round(state.equity / state.monthStartEquity - 1),
    lockReason: state.lockReason,
    signal: state.lastSignal,
    newsRisk: state.lastNewsRisk,
    profitDeRisk: state.lastProfitDeRisk,
    rebalance: state.lastRebalance || null,
    dataQualityRisk: state.lastDataQualityRisk || null,
    entryGuard: state.lastEntryGuard || null,
    pendingStrategyChange: state.pendingStrategyChange || null,
    strategyChanges: state.strategyChanges || [],
    accuracy: {
      observations: dailyReports.length,
      profitableDays,
      profitableDayRatio: dailyReports.length ? round(profitableDays / dailyReports.length) : null,
      directionalObservations: directionalReports.length,
      directionalHits,
      directionalHitRate: directionalReports.length
        ? round(directionalHits / directionalReports.length)
        : null,
    },
    updatedAt: state.updatedAt,
  };
}

export function btcPaperStatePath(rootDir) {
  return path.join(rootDir, 'data', 'runtime', 'btc-single-asset-paper.json');
}

export async function writeBtcPaperReportArtifacts(rootDir, state) {
  if (!state?.latestReport) return;
  const reportDir = path.join(rootDir, 'data', 'runtime', 'btc-paper-reports');
  await fs.mkdir(reportDir, { recursive: true });
  const snapshot = btcPaperSnapshot(state);
  const content = `${JSON.stringify(snapshot.latestReport, null, 2)}\n`;
  await fs.writeFile(path.join(reportDir, `${state.latestReport.cycleDate}.json`), content, 'utf8');
  await fs.writeFile(path.join(reportDir, 'latest.json'), content, 'utf8');
}
