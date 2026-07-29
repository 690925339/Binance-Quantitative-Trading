import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateCrossSectionalWeights,
  runCrossSectionalBacktest,
  shouldSuppressSmallRebalance,
} from '../src/cross-sectional-backtest.js';

function syntheticSeries() {
  const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'];
  return Object.fromEntries(symbols.map((symbol, symbolIndex) => {
    let price = 100;
    const series = [];
    for (let index = 0; index < 180; index += 1) {
      const dailyTrend = (1.5 - symbolIndex) * 0.0015;
      price *= Math.exp(dailyTrend + Math.sin(index / 7 + symbolIndex) * 0.0005);
      const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
      series.push({ date, close: price });
    }
    return [symbol, series];
  }));
}

function prependHistory(seriesBySymbol, days = 21) {
  return Object.fromEntries(Object.entries(seriesBySymbol).map(([symbol, series], symbolIndex) => {
    const firstDate = Date.parse(`${series[0].date}T00:00:00.000Z`);
    const dailyTrend = (1.5 - symbolIndex) * 0.0015;
    const prefix = Array.from({ length: days }, (_, index) => ({
      date: new Date(firstDate - (days - index) * 86_400_000).toISOString().slice(0, 10),
      close: series[0].close * Math.exp(-dailyTrend * (days - index)),
    }));
    return [symbol, [...prefix, ...series]];
  }));
}

function dailyReturnMap(result) {
  let previousEquity = 1;
  return new Map(result.equityCurve.map((point) => {
    const value = point.equity / previousEquity - 1;
    previousEquity = point.equity;
    return [point.date, value];
  }));
}

test('横截面动量同时持有多仓和空仓并从持续分化中获利', () => {
  const result = runCrossSectionalBacktest(syntheticSeries(), {
    lookbackDays: 10,
    tradingCostRate: 0,
    dailyCarryCostRate: 0,
  });
  assert.ok(result.metrics.totalReturn > 0);
  assert.equal(result.metrics.averageGrossExposure, 0.5);
});

test('横截面价差扩大时动态杠杆不超过配置上限', () => {
  const result = runCrossSectionalBacktest(syntheticSeries(), {
    lookbackDays: 10,
    baseGrossExposure: 0.5,
    maxGrossExposure: 1.5,
    dynamicLeverageEnabled: true,
    dynamicLeverageMax: 3,
    dispersionTarget: 0.05,
    tradingCostRate: 0,
    dailyCarryCostRate: 0,
  });
  assert.ok(result.metrics.averageDynamicLeverage > 1);
  assert.ok(result.metrics.maximumDynamicLeverage <= 3);
  assert.ok(result.metrics.averageGrossExposure > 0.5);
});

test('自适应横截面在稳定信号中保留集中选择并限制单币权重', () => {
  const series = syntheticSeries();
  const symbols = Object.keys(series);
  const closesBySymbol = Object.fromEntries(symbols.map((symbol) => [
    symbol,
    series[symbol].map((item) => item.close),
  ]));
  const allocation = calculateCrossSectionalWeights(closesBySymbol, symbols, 60, {
    lookbackDays: 10,
    positionsPerSide: 1,
    mode: 'momentum',
    baseGrossExposure: 0.5,
    maxGrossExposure: 1.5,
    dynamicLeverageEnabled: true,
    dynamicLeverageMax: 3,
    dispersionTarget: 0.05,
    adaptiveBreadthEnabled: true,
    confirmationLookbackDays: [5, 10, 20],
    uncertainPositionsPerSide: 2,
    minimumRankStability: 0.7,
    minimumSelectionGap: 0,
    uncertainGrossExposureScale: 0.75,
    uncertainLeverageCap: 1.5,
    adaptiveVolatilityWindowDays: 20,
    maximumAdaptiveMarketVolatility: null,
    highVolatilityGrossExposureScale: 0.5,
    maximumSingleAssetExposure: 0.45,
  });
  assert.equal(allocation.adaptiveRisk.stable, true);
  assert.equal(allocation.adaptiveRisk.effectivePositionsPerSide, 1);
  assert.equal(Object.values(allocation.weights).filter((weight) => weight !== 0).length, 2);
  assert.ok(Math.max(...Object.values(allocation.weights).map(Math.abs)) <= 0.45);
});

test('自适应横截面在头尾差距不足时分散持仓并收紧杠杆', () => {
  const series = syntheticSeries();
  const symbols = Object.keys(series);
  const closesBySymbol = Object.fromEntries(symbols.map((symbol) => [
    symbol,
    series[symbol].map((item) => item.close),
  ]));
  const allocation = calculateCrossSectionalWeights(closesBySymbol, symbols, 60, {
    lookbackDays: 10,
    positionsPerSide: 1,
    mode: 'momentum',
    baseGrossExposure: 0.5,
    maxGrossExposure: 1.5,
    dynamicLeverageEnabled: true,
    dynamicLeverageMax: 3,
    dispersionTarget: 0.01,
    adaptiveBreadthEnabled: true,
    confirmationLookbackDays: [5, 10, 20],
    uncertainPositionsPerSide: 2,
    minimumRankStability: 0.7,
    minimumSelectionGap: 2,
    uncertainGrossExposureScale: 0.75,
    uncertainLeverageCap: 1.25,
    adaptiveVolatilityWindowDays: 20,
    maximumAdaptiveMarketVolatility: null,
    highVolatilityGrossExposureScale: 0.5,
    maximumSingleAssetExposure: null,
  });
  assert.equal(allocation.adaptiveRisk.stable, false);
  assert.equal(allocation.adaptiveRisk.effectivePositionsPerSide, 2);
  assert.equal(Object.values(allocation.weights).filter((weight) => weight !== 0).length, 4);
  assert.ok(allocation.leverage <= 1.25);
  assert.ok(allocation.adaptiveRisk.grossExposure < allocation.adaptiveRisk.requestedGrossExposure + 1e-12);
});

test('高可信新闻可以按45%权重改变横截面排名，缺少新闻时保持原排名', () => {
  const closesBySymbol = {
    AAAUSDT: [100, 110],
    BBBUSDT: [100, 106],
    CCCUSDT: [100, 98],
    DDDUSDT: [100, 90],
  };
  const symbols = Object.keys(closesBySymbol);
  const settings = {
    lookbackDays: 1,
    positionsPerSide: 1,
    mode: 'momentum',
    dynamicLeverageEnabled: false,
    dynamicLeverageMax: 1,
    dispersionTarget: 0.15,
    baseGrossExposure: 0.5,
    maxGrossExposure: 0.5,
  };
  const baseline = calculateCrossSectionalWeights(closesBySymbol, symbols, 1, settings);
  const newsAdjusted = calculateCrossSectionalWeights(
    closesBySymbol,
    symbols,
    1,
    settings,
    { newsSignalWeight: 0.45, newsScoresBySymbol: { BBBUSDT: 1 } },
  );
  assert.ok(baseline.weights.AAAUSDT > 0);
  assert.ok(newsAdjusted.weights.BBBUSDT > 0);
  assert.equal(newsAdjusted.newsAppliedSymbols[0], 'BBBUSDT');
  assert.deepEqual(
    calculateCrossSectionalWeights(closesBySymbol, symbols, 1, settings).weights,
    baseline.weights,
  );
});

test('月度盈利锁定会产生空仓日并降低平均敞口', () => {
  const unlocked = runCrossSectionalBacktest(syntheticSeries(), { lookbackDays: 10 });
  const locked = runCrossSectionalBacktest(syntheticSeries(), {
    lookbackDays: 10,
    monthlyProfitLock: 0.005,
  });
  assert.ok(locked.metrics.monthlyLockedDays > 0);
  assert.ok(locked.metrics.averageGrossExposure < unlocked.metrics.averageGrossExposure);
});

test('按 UTC 日历锚定调仓日，补充预热历史不会移动后续每周调仓', () => {
  const originalSeries = syntheticSeries();
  const settings = {
    lookbackDays: 10,
    rebalanceDays: 7,
    tradingCostRate: 0,
    dailyCarryCostRate: 0,
  };
  const original = dailyReturnMap(runCrossSectionalBacktest(originalSeries, settings));
  const prefixed = dailyReturnMap(runCrossSectionalBacktest(prependHistory(originalSeries), settings));
  const comparisonDates = [...original.keys()].filter((date) => date >= '2024-01-22');
  assert.ok(comparisonDates.length > 100);
  for (const date of comparisonDates) {
    assert.ok(Math.abs(original.get(date) - prefixed.get(date)) < 0.00001, date);
  }
});

test('最低换手门槛会跳过小幅仓位变化并保持月初和显著调仓', () => {
  const smallChange = {
    scheduled: true,
    proposedTurnover: 0.08,
    minimumRebalanceTurnover: 0.10,
  };
  assert.equal(shouldSuppressSmallRebalance(smallChange), true);
  assert.equal(shouldSuppressSmallRebalance({ ...smallChange, proposedTurnover: 0.12 }), false);
  assert.equal(shouldSuppressSmallRebalance({ ...smallChange, monthChanged: true }), false);
  assert.equal(shouldSuppressSmallRebalance({ ...smallChange, needsLockClose: true }), false);
  assert.equal(shouldSuppressSmallRebalance({ ...smallChange, force: true }), false);
});

test('恐惧指数只使用前一日值，不会让同日数据倒灌到交易信号', () => {
  const series = syntheticSeries();
  const settings = {
    lookbackDays: 10,
    fearGreedMinimum: 20,
    fearGreedMaximum: 80,
    referenceFilterEnabled: true,
    referenceOutsideScale: 0,
    tradingCostRate: 0,
    dailyCarryCostRate: 0,
  };
  const normalValues = Object.fromEntries(series.AAAUSDT.map((item) => [item.date, 50]));
  const changedSameDay = { ...normalValues, '2024-02-01': 100 };
  const baseline = dailyReturnMap(runCrossSectionalBacktest(
    series,
    settings,
    { fearGreedByDate: normalValues },
  ));
  const changed = dailyReturnMap(runCrossSectionalBacktest(
    series,
    settings,
    { fearGreedByDate: changedSameDay },
  ));
  assert.equal(changed.get('2024-02-01'), baseline.get('2024-02-01'));
  assert.equal(changed.get('2024-02-02'), baseline.get('2024-02-02'));
  assert.notEqual(changed.get('2024-02-03'), baseline.get('2024-02-03'));
});

test('极端情绪、过高波动或单边市场宽度会降低参考权重', () => {
  const series = syntheticSeries();
  const fearGreedByDate = Object.fromEntries(series.AAAUSDT.map((item) => [item.date, 5]));
  const result = runCrossSectionalBacktest(series, {
    lookbackDays: 10,
    referenceFilterEnabled: true,
    referenceWindowDays: 10,
    fearGreedMinimum: 20,
    fearGreedMaximum: 80,
    maximumMarketVolatility: 0.0001,
    maximumBreadthImbalance: 0.1,
    referenceOutsideScale: 0.25,
    tradingCostRate: 0,
    dailyCarryCostRate: 0,
  }, { fearGreedByDate });
  assert.ok(result.metrics.referenceFilteredDays > 100);
  assert.ok(result.metrics.averageReferenceScale <= 0.25);
  assert.ok(result.metrics.averageGrossExposure < 0.5);
});

test('参考过滤器默认关闭，缺少外部数据不会改变原有结果', () => {
  const series = syntheticSeries();
  const baseline = runCrossSectionalBacktest(series, { lookbackDays: 10 });
  const withUnusedReferences = runCrossSectionalBacktest(
    series,
    { lookbackDays: 10 },
    { fearGreedByDate: { '2024-01-01': 1 } },
  );
  assert.deepEqual(withUnusedReferences.equityCurve, baseline.equityCurve);
  assert.equal(withUnusedReferences.metrics.averageReferenceScale, 1);
  assert.equal(withUnusedReferences.metrics.referenceFilteredDays, 0);
});

test('自适应横截面默认关闭时不会改变冻结基准净值', () => {
  const series = syntheticSeries();
  const baseline = runCrossSectionalBacktest(series, { lookbackDays: 10 });
  const explicitlyDisabled = runCrossSectionalBacktest(series, {
    lookbackDays: 10,
    adaptiveBreadthEnabled: false,
  });
  assert.deepEqual(explicitlyDisabled.equityCurve, baseline.equityCurve);
});
