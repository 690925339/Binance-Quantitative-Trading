import fs from 'node:fs/promises';
import path from 'node:path';
import {
  calculateAnnualizedVolatility,
  calculateLongShortTrendWeights,
  calculateTrendSignal,
} from './long-short-trend.js';
import { addUtcDays } from './monthly-accuracy-paper.js';

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
  const warmup = Math.max(...settings.lookbackDays, settings.volatilityWindowDays);
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

function profitDeRisk(state, profile) {
  const monthlyReturn = state.equity / state.monthStartEquity - 1;
  const active = monthlyReturn >= profile.monthlyProfitDeRiskThreshold;
  return {
    enabled: true,
    active,
    threshold: profile.monthlyProfitDeRiskThreshold,
    configuredScale: profile.monthlyProfitDeRiskScale,
    scale: active ? profile.monthlyProfitDeRiskScale : 1,
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

function applyNextSignal({ state, seriesBySymbol, signalDate, cycleDate, newsSnapshot, profile }) {
  const allocation = signalAllocation(seriesBySymbol, signalDate, profile);
  const deRisk = profitDeRisk(state, profile);
  let proposedWeight = state.lockReason === null
    ? allocation.rawWeight * deRisk.scale
    : 0;
  const newsRisk = evaluateBtcNewsRisk(newsSnapshot, proposedWeight, cycleDate, profile);
  proposedWeight *= newsRisk.appliedGrossExposureScale;
  return {
    allocation,
    profitDeRisk: deRisk,
    newsRisk,
    proposedWeight,
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
      settledLockReason,
      lockReason: state.lockReason,
      monthChanged,
      positions: state.positions,
      modelGrossExposure: state.modelGrossExposure,
      notes: state.lockReason === 'loss'
        ? ['BTC趋势袖套已触发1.5%月度亏损保护，本月剩余时间保持空仓。']
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
