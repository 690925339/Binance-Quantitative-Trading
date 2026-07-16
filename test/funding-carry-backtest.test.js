import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateFundingCarryRelease,
  runFundingCarryBacktest,
} from '../src/funding-carry-backtest.js';

function fundingSeries() {
  const result = {};
  for (const [symbol, offset] of [['AAAUSDT', 0], ['BBBUSDT', 10]]) {
    result[symbol] = [];
    for (let index = 0; index < 120; index += 1) {
      const cycleIndex = index % 24;
      const fundingRate = cycleIndex < 20 ? 0.001 : -0.0002;
      const price = 100 + offset + index * 0.1;
      result[symbol].push({
        fundingTime: Date.UTC(2025, 0, 1) + index * 8 * 3_600_000,
        fundingRate,
        spotPrice: price,
        markPrice: price,
      });
    }
  }
  return result;
}

const options = {
  lookbackIntervals: 2,
  exitAfterWeakIntervals: 2,
  minimumAverageFundingRate: 0.0005,
  notionalToCapital: 0.8,
  spotFeeRate: 0,
  futuresFeeRate: 0,
  slippageRatePerLeg: 0,
};

test('资金费率持续为正时，现货多头和永续空头组合获得正收益', () => {
  const result = runFundingCarryBacktest(fundingSeries(), options);
  assert.ok(result.metrics.cycleCount >= 8);
  assert.ok(result.metrics.fundingPredictionAccuracy >= 0.9);
  assert.equal(result.metrics.cycleWinRate, 1);
  assert.ok(result.metrics.totalReturn > 0);
});

test('现货、合约费用和滑点会降低资金费率组合收益', () => {
  const withoutCosts = runFundingCarryBacktest(fundingSeries(), options);
  const withCosts = runFundingCarryBacktest(fundingSeries(), {
    ...options,
    spotFeeRate: 0.001,
    futuresFeeRate: 0.0005,
    slippageRatePerLeg: 0.0002,
  });
  assert.ok(withCosts.metrics.totalReturn < withoutCosts.metrics.totalReturn);
});

test('80%资金策略发布门槛拒绝高方向正确率但亏损的组合', () => {
  const release = evaluateFundingCarryRelease({
    cycleWinRate: 0.2,
    cycleWinRateWilson95Lower: 0.1,
    cycleCount: 40,
    fundingPredictionAccuracy: 0.95,
    profitFactor: 0.5,
    annualizedReturn: -0.01,
    maxDrawdown: -0.05,
  });
  assert.equal(release.passed, false);
  assert.equal(release.checks.fundingPredictionAccuracy, true);
  assert.equal(release.checks.cycleWinRate, false);
  assert.equal(release.checks.profitFactor, false);
});
