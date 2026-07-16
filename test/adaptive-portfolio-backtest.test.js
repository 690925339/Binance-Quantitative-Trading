import assert from 'node:assert/strict';
import test from 'node:test';
import { runAdaptivePortfolioBacktest } from '../src/adaptive-portfolio-backtest.js';

function fixtures({ oneSidedBreadth = false, trendReturns = null, neutralReturns = null } = {}) {
  const dates = Array.from({ length: 80 }, (_, index) => (
    new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)
  ));
  const seriesBySymbol = Object.fromEntries(['AAA', 'BBB', 'CCC', 'DDD'].map((symbol, symbolIndex) => {
    let close = 100;
    return [symbol, dates.map((date, index) => {
      const direction = oneSidedBreadth ? 1 : symbolIndex < 2 ? 1 : -1;
      close *= 1 + direction * 0.002 + Math.sin(index / 8 + symbolIndex) * 0.0002;
      return { date, close };
    })];
  }));
  function resultFromReturns(values) {
    let equity = 1;
    return {
      equityCurve: dates.map((date, index) => {
        equity *= 1 + (values?.[index] ?? 0.001);
        return { date, equity };
      }),
    };
  }
  return {
    dates,
    seriesBySymbol,
    trendResult: resultFromReturns(trendReturns),
    marketNeutralResult: resultFromReturns(neutralReturns),
    fearGreedByDate: Object.fromEntries(dates.map((date) => [date, 50])),
  };
}

test('市场宽度越单边，动态分配给趋势仓位的权重越高', () => {
  const balanced = runAdaptivePortfolioBacktest(fixtures(), {
    baseTrendWeight: 0.15,
    minimumTrendWeight: 0.05,
    maximumTrendWeight: 0.25,
    stateAllocationEnabled: true,
    allocationTradingCostRate: 0,
  });
  const oneSided = runAdaptivePortfolioBacktest(fixtures({ oneSidedBreadth: true }), {
    baseTrendWeight: 0.15,
    minimumTrendWeight: 0.05,
    maximumTrendWeight: 0.25,
    stateAllocationEnabled: true,
    allocationTradingCostRate: 0,
  });
  assert.ok(oneSided.metrics.averageTrendWeight > balanced.metrics.averageTrendWeight);
});

test('组合回撤控制只根据上一日净值降低后续风险', () => {
  const losses = Array.from({ length: 80 }, (_, index) => (index < 25 ? 0.002 : index < 45 ? -0.02 : 0.001));
  const input = fixtures({ trendReturns: losses, neutralReturns: losses });
  const uncontrolled = runAdaptivePortfolioBacktest(input, { allocationTradingCostRate: 0 });
  const controlled = runAdaptivePortfolioBacktest(input, {
    drawdownControlStart: 0.05,
    drawdownControlFull: 0.15,
    minimumDrawdownScale: 0.25,
    allocationTradingCostRate: 0,
  });
  assert.ok(controlled.metrics.drawdownScaledDays > 0);
  assert.ok(controlled.metrics.maxDrawdown > uncontrolled.metrics.maxDrawdown);
});

test('恐惧指数严格使用决策日前一日数据', () => {
  const input = fixtures();
  const settings = {
    referenceRiskEnabled: true,
    fearGreedMinimum: 20,
    fearGreedMaximum: 80,
    maximumMarketVolatility: 10,
    referenceOutsideScale: 0,
    allocationTradingCostRate: 0,
  };
  const baseline = runAdaptivePortfolioBacktest(input, settings);
  const changedInput = {
    ...input,
    fearGreedByDate: { ...input.fearGreedByDate, '2024-02-01': 100 },
  };
  const changed = runAdaptivePortfolioBacktest(changedInput, settings);
  const baselineMap = new Map(baseline.equityCurve.map((item) => [item.date, item.equity]));
  const changedMap = new Map(changed.equityCurve.map((item) => [item.date, item.equity]));
  assert.equal(changedMap.get('2024-02-02'), baselineMap.get('2024-02-02'));
  assert.notEqual(changedMap.get('2024-02-03'), baselineMap.get('2024-02-03'));
});
