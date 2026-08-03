import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  addUtcDays,
  advancePaperState,
  initializePaperState,
  latestCompletePaperCycleDate,
  PaperPortfolioStore,
  paperPortfolioSnapshot,
} from '../src/monthly-accuracy-paper.js';
import { PAPER_SHADOW_PROFILES } from '../src/paper-strategy-review.js';

const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

function syntheticSeries(startDate, endDate) {
  const values = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  const prices = Object.fromEntries(symbols.map((symbol, index) => [symbol, 100 + index * 10]));
  let date = startDate;
  let cursor = 0;
  while (date <= endDate) {
    symbols.forEach((symbol, index) => {
      const drift = (2.5 - index) * 0.0007;
      prices[symbol] *= Math.exp(drift + Math.sin(cursor / 11 + index) * 0.002);
      values[symbol].push({ date, close: prices[symbol] });
    });
    cursor += 1;
    date = addUtcDays(date, 1);
  }
  return values;
}

function markPrices(seriesBySymbol, date, multiplier = 1) {
  return Object.fromEntries(symbols.map((symbol) => {
    const row = seriesBySymbol[symbol].find((item) => item.date === date);
    return [symbol, row.close * multiplier];
  }));
}

test('纸面盘从启动日建立基线，不回填此前收益', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  const snapshot = paperPortfolioSnapshot(state);
  assert.equal(snapshot.startCycleDate, '2026-07-16');
  assert.equal(snapshot.lastCycleDate, '2026-07-16');
  assert.equal(snapshot.latestReport.kind, 'initialization');
  assert.equal(snapshot.reports.length, 1);
  assert.ok(snapshot.equity < 10_000);
  assert.ok(snapshot.positions.some((item) => item.side === 'LONG'));
  assert.ok(snapshot.positions.some((item) => item.side === 'SHORT'));
  assert.equal(snapshot.partialStartMonth, '2026-07');
  assert.equal(snapshot.firstFullMonth, '2026-08');
});

test('每日推进只结算未处理日期，重复执行保持幂等', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: {
      '2026-07-17': markPrices(series, '2026-07-16', 1.002),
    },
    throughCycleDate: '2026-07-17',
    now: Date.parse('2026-07-17T01:05:00.000Z'),
  });
  const reportsAfterFirstRun = state.reports.length;
  const equityAfterFirstRun = state.equity;
  assert.equal(state.lastCycleDate, '2026-07-17');
  assert.equal(state.latestReport.kind, 'daily');
  assert.ok(Number.isFinite(state.latestReport.dayPnl));
  assert.equal(
    Number(state.latestReport.symbolAttribution
      .reduce((sum, item) => sum + item.totalPricePnl, 0).toFixed(3)),
    Number(state.latestReport.pricePnl.toFixed(3)),
  );
  assert.equal(
    Number((state.latestReport.componentAttribution.marketNeutral.totalPnl
      + state.latestReport.componentAttribution.trend.totalPnl).toFixed(3)),
    Number(state.latestReport.dayPnl.toFixed(3)),
  );
  assert.equal(reportsAfterFirstRun, 2);

  advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: {},
    throughCycleDate: '2026-07-17',
    now: Date.parse('2026-07-17T01:06:00.000Z'),
  });
  assert.equal(state.reports.length, reportsAfterFirstRun);
  assert.equal(state.equity, equityAfterFirstRun);
});

test('北京时间09点之后才使用当天固定估值周期', () => {
  assert.equal(
    latestCompletePaperCycleDate(Date.parse('2026-07-16T00:59:59.999Z')),
    '2026-07-15',
  );
  assert.equal(
    latestCompletePaperCycleDate(Date.parse('2026-07-16T01:00:00.000Z')),
    '2026-07-16',
  );
});

test('分散影子使用独立冻结参数并持有每侧两个横截面标的', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id.includes('diversified'));
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
  });
  assert.equal(state.strategyProfileId, profile.id);
  assert.equal(state.profileSnapshot.marketNeutral.positionsPerSide, 2);
  assert.equal(
    state.positions.filter((position) => position.marketNeutralWeight !== 0).length,
    4,
  );
});

test('新闻增强影子只在可信新闻达标时应用45%权重并记录决策', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-45-v1');
  const emptySummary = {
    score: 0,
    direction: 'neutral',
    credibility: 0,
    confidence: 0,
    articleCount: 0,
    confirmedArticleCount: 0,
    confirmedAssessments: [],
  };
  const newsSnapshot = {
    status: 'live',
    updatedAt: '2026-07-16T01:00:00.000Z',
    sourceStatus: [{ source: 'Official', ok: true }],
    summary: {
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, symbol === 'ETHUSDT' ? {
        score: 1,
        direction: 'bullish',
        credibility: 92,
        confidence: 85,
        articleCount: 1,
        confirmedArticleCount: 1,
        confirmedAssessments: [{ credibility: 92, confidence: 85, evidenceStrength: 'strong' }],
      } : emptySummary])),
    },
  };
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
    newsSnapshot,
  });
  assert.equal(state.latestReport.nextNewsOverlay.appliedNewsWeightPercent, 45);
  assert.equal(state.latestReport.nextNewsOverlay.fallbackToPriceOnly, false);
  const ethRanking = state.latestReport.nextNewsOverlay.ranking
    .find((item) => item.symbol === 'ETHUSDT');
  assert.equal(ethRanking.newsEligible, true);
  assert.equal(ethRanking.newsScore, 1);
  assert.ok(state.latestReport.nextNewsOverlay.selectedLongSymbols.length > 0);
});

test('新闻质量影子根据可信度、置信度和方向强度降低边界消息权重', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-adaptive-v1');
  const emptySummary = {
    score: 0,
    direction: 'neutral',
    credibility: 0,
    confidence: 0,
    articleCount: 0,
    confirmedArticleCount: 0,
    confirmedAssessments: [],
  };
  const newsSnapshot = {
    status: 'live',
    updatedAt: '2026-07-16T01:00:00.000Z',
    sourceStatus: [{ source: 'Official', ok: true }],
    summary: {
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, symbol === 'ETHUSDT' ? {
        score: 0.20,
        direction: 'bullish',
        credibility: 80,
        confidence: 70,
        articleCount: 1,
        confirmedArticleCount: 1,
        confirmedAssessments: [{ credibility: 80, confidence: 70, evidenceStrength: 'strong' }],
      } : emptySummary])),
    },
  };
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
    newsSnapshot,
  });
  const decision = state.latestReport.nextNewsOverlay;
  const ethRanking = decision.ranking.find((item) => item.symbol === 'ETHUSDT');
  assert.equal(decision.newsWeightMode, 'quality');
  assert.equal(decision.appliedNewsWeightPercent, 10.08);
  assert.equal(ethRanking.newsWeightPercent, 10.08);
  assert.ok(decision.appliedNewsWeightPercent > 0);
  assert.ok(decision.appliedNewsWeightPercent < decision.requestedNewsWeightPercent);
});

test('新闻风险影子不改变多空选择，只在方向冲突时降低敞口', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const baseline = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  const baselineLong = baseline.positions.find((item) => item.marketNeutralWeight > 0).symbol;
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-risk-veto-v1');
  const emptySummary = {
    score: 0,
    direction: 'neutral',
    credibility: 0,
    confidence: 0,
    articleCount: 0,
    confirmedArticleCount: 0,
    confirmedAssessments: [],
  };
  const newsSnapshot = {
    status: 'live',
    updatedAt: '2026-07-16T01:00:00.000Z',
    sourceStatus: [{ source: 'Official', ok: true }],
    summary: {
      bySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, symbol === baselineLong ? {
        score: -0.30,
        direction: 'bearish',
        credibility: 68,
        confidence: 50,
        articleCount: 3,
        confirmedArticleCount: 0,
        confirmedAssessments: [],
      } : emptySummary])),
    },
  };
  const guarded = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
    newsSnapshot,
  });
  assert.deepEqual(
    guarded.positions.map((item) => [item.symbol, Math.sign(item.weight)]),
    baseline.positions.map((item) => [item.symbol, Math.sign(item.weight)]),
  );
  assert.equal(guarded.latestReport.nextNewsOverlay.riskVetoTriggered, true);
  assert.deepEqual(guarded.latestReport.nextNewsOverlay.riskVetoConflictSymbols, [baselineLong]);
  assert.equal(guarded.latestReport.nextNewsOverlay.appliedRiskGrossExposureScale, 0.75);
  assert.ok(guarded.modelGrossExposure < baseline.modelGrossExposure);
});

test('新闻增强影子在新闻不可用时回退为原价格排名', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const profile = PAPER_SHADOW_PROFILES.find((item) => item.id === 'shadow-news-45-v1');
  const baseline = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  const fallback = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
    profile,
    newsSnapshot: { status: 'unavailable', updatedAt: '2026-07-16T01:00:00.000Z' },
  });
  assert.equal(fallback.latestReport.nextNewsOverlay.appliedNewsWeightPercent, 0);
  assert.equal(fallback.latestReport.nextNewsOverlay.fallbackToPriceOnly, true);
  assert.deepEqual(
    fallback.positions.map((item) => [item.symbol, Math.sign(item.weight)]),
    baseline.positions.map((item) => [item.symbol, Math.sign(item.weight)]),
  );
});

test('纸面盘状态使用锁文件和原子写入持久化', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quantflow-paper-'));
  const filePath = path.join(directory, 'paper.json');
  const store = new PaperPortfolioStore(filePath);
  await store.run((current) => ({ version: 1, count: (current?.count || 0) + 1 }));
  await store.run((current) => ({ ...current, count: current.count + 1 }));
  await store.run((current) => {
    current.count += 1;
    return current;
  });
  assert.deepEqual(await store.read(), { version: 1, count: 3 });
  assert.equal(await fs.stat(`${filePath}.lock`).catch(() => null), null);
  await fs.rm(directory, { recursive: true, force: true });
});
