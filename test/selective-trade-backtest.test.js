import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateSelectiveTradeRelease,
  runSelectiveTradeBacktest,
} from '../src/selective-trade-backtest.js';

function pullbackSeries() {
  const result = { AAAUSDT: [], BBBUSDT: [] };
  let up = 100;
  let down = 200;
  for (let index = 0; index < 260; index += 1) {
    const pullback = index % 12 === 8 ? -0.04 : 0.006;
    const bounce = index % 12 === 8 ? 0.04 : -0.006;
    up *= 1 + pullback;
    down *= 1 + bounce;
    const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
    result.AAAUSDT.push({ date, open: up, high: up * 1.06, low: up * 0.94, close: up });
    result.BBBUSDT.push({ date, open: down, high: down * 1.06, low: down * 0.94, close: down });
  }
  return result;
}

test('同一日同时触发止盈止损时按止损处理', () => {
  const result = runSelectiveTradeBacktest(pullbackSeries(), {
    trendLookbackDays: 30,
    pullbackLookbackDays: 3,
    minimumTrendPercent: 0.01,
    pullbackThresholdPercent: 0.01,
    takeProfitPercent: 0.01,
    stopLossPercent: 0.02,
    maxHoldingDays: 5,
    riskPerTrade: 0.002,
    maxAssetExposure: 0.1,
    maxGrossExposure: 0.2,
    maxConcurrentTrades: 2,
    tradingCostRate: 0,
    dailyCarryCostRate: 0,
  });
  assert.ok(result.metrics.tradeCount > 5);
  assert.ok(result.trades.every((trade) => trade.reason === 'stopLoss'));
  assert.equal(result.metrics.winRate, 0);
});

test('选择性交易发布门槛不会让80%胜率掩盖负期望', () => {
  const release = evaluateSelectiveTradeRelease({
    winRate: 0.82,
    winRateWilson95Lower: 0.7,
    tradeCount: 100,
    longTradeCount: 60,
    shortTradeCount: 40,
    profitFactor: 0.8,
    expectancy: -0.001,
    annualizedReturn: -0.02,
    maxDrawdown: -0.1,
  });
  assert.equal(release.passed, false);
  assert.equal(release.checks.winRate, true);
  assert.equal(release.checks.profitFactor, false);
  assert.equal(release.checks.positiveExpectancy, false);
});
