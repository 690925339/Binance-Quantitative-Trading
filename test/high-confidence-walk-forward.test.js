import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateHighConfidenceRelease,
  runHighConfidenceBacktest,
} from '../src/high-confidence-walk-forward.js';

function trendingSeries() {
  const values = { AAAUSDT: [], BBBUSDT: [] };
  let prices = [100, 80];
  for (let index = 0; index < 420; index += 1) {
    const direction = Math.floor(index / 105) % 2 === 0 ? 1 : -1;
    prices = prices.map((price, symbolIndex) => (
      price * Math.exp(direction * 0.012 + Math.sin(index + symbolIndex) * 0.0005)
    ));
    const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
    Object.keys(values).forEach((symbol, symbolIndex) => {
      values[symbol].push({ date, close: prices[symbolIndex] });
    });
  }
  return values;
}

const options = {
  lookbackDays: [5, 10, 20],
  predictionHorizonDays: 5,
  decisionIntervalDays: 5,
  volatilityWindowDays: 10,
  minimumConfidence: 0.1,
  marketWeight: 0.25,
  requireMarketConfirmation: true,
  maxSelectedAssets: 2,
  grossExposure: 0.2,
  tradingCostRate: 0.0001,
  dailyCarryCostRate: 0,
};

test('高置信度回测使用未来窗口验证多空方向并报告覆盖率', () => {
  const result = runHighConfidenceBacktest(trendingSeries(), options);
  assert.ok(result.metrics.activeDecisionCount > 50);
  assert.ok(result.metrics.longForecastCount > 20);
  assert.ok(result.metrics.shortForecastCount > 20);
  assert.ok(result.metrics.portfolioAccuracy > 0.8);
  assert.ok(result.metrics.signalCoverage > 0.8);
});

test('指定回测截止日期后，更远未来价格不会改变已完成的样本结果', () => {
  const original = trendingSeries();
  const changed = structuredClone(original);
  for (const series of Object.values(changed)) {
    for (let index = 260; index < series.length; index += 1) series[index].close *= 10;
  }
  const period = { startDate: '2024-03-01', endDate: '2024-08-31' };
  const first = runHighConfidenceBacktest(original, options, period);
  const second = runHighConfidenceBacktest(changed, options, period);
  assert.deepEqual(second.metrics, first.metrics);
  assert.deepEqual(second.events, first.events);
});

test('80%发布门槛同时约束命中率、样本量、收益和回撤', () => {
  const failing = evaluateHighConfidenceRelease({
    portfolioAccuracy: 0.79,
    assetAccuracy: 0.85,
    activeDecisionCount: 30,
    assetForecastCount: 60,
    longForecastCount: 30,
    shortForecastCount: 30,
    signalCoverage: 0.5,
    annualizedReturn: 0.07,
    maxDrawdown: -0.1,
  });
  assert.equal(failing.passed, false);
  assert.deepEqual(failing.failedChecks, ['portfolioAccuracy']);

  const passing = evaluateHighConfidenceRelease({
    portfolioAccuracy: 0.82,
    assetAccuracy: 0.81,
    activeDecisionCount: 30,
    assetForecastCount: 60,
    longForecastCount: 30,
    shortForecastCount: 30,
    signalCoverage: 0.5,
    annualizedReturn: 0.07,
    maxDrawdown: -0.1,
  });
  assert.equal(passing.passed, true);
});

test('拒绝相互重叠的预测窗口，避免重复标签夸大样本量', () => {
  assert.throws(() => runHighConfidenceBacktest(trendingSeries(), {
    ...options,
    predictionHorizonDays: 10,
    decisionIntervalDays: 5,
  }), /决策间隔不能短于预测窗口/);
});
