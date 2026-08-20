import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateLongShortTrendWeights,
  LONG_SHORT_RISK_PROFILES,
  runLongShortTrendBacktest,
} from '../src/long-short-trend.js';

function syntheticSeries() {
  const symbols = ['AAAUSDT', 'BBBUSDT'];
  const values = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  let prices = [100, 80];
  for (let index = 0; index < 460; index += 1) {
    const trend = index < 230 ? 0.0025 : -0.0025;
    prices = prices.map((price, symbolIndex) => price * Math.exp(trend + Math.sin(index + symbolIndex) * 0.0015));
    const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
    symbols.forEach((symbol, symbolIndex) => values[symbol].push({ date, close: prices[symbolIndex] }));
  }
  return values;
}

const options = {
  lookbackDays: [10, 20, 40],
  volatilityWindowDays: 10,
  targetVolatility: 0.1,
  minimumTrendStrength: 0.01,
  maxGrossExposure: 0.5,
  maxAssetExposure: 0.25,
  tradingCostRate: 0,
  dailyCarryCostRate: 0,
};

test('多空趋势回测会在趋势反转后同时覆盖多仓与空仓阶段', () => {
  const result = runLongShortTrendBacktest(syntheticSeries(), options);
  assert.ok(result.metrics.longExposureDays > 100);
  assert.ok(result.metrics.shortExposureDays > 100);
  assert.ok(result.metrics.totalReturn > 0);
});

test('方向模式可限制为仅做多或仅做空', () => {
  const longOnly = runLongShortTrendBacktest(syntheticSeries(), { ...options, positionMode: 'longOnly' });
  const shortOnly = runLongShortTrendBacktest(syntheticSeries(), { ...options, positionMode: 'shortOnly' });
  assert.equal(longOnly.metrics.shortExposureDays, 0);
  assert.equal(shortOnly.metrics.longExposureDays, 0);
});

test('交易成本会降低同一行情和信号下的回测收益', () => {
  const withoutCost = runLongShortTrendBacktest(syntheticSeries(), options);
  const withCost = runLongShortTrendBacktest(syntheticSeries(), { ...options, tradingCostRate: 0.002 });
  assert.ok(withCost.metrics.totalReturn < withoutCost.metrics.totalReturn);
});

test('收益增强预设保持信号不变并将三个风险预算同步提高到 1.5 倍', () => {
  const baseline = LONG_SHORT_RISK_PROFILES.baseline;
  const enhanced = LONG_SHORT_RISK_PROFILES.enhanced;
  assert.ok(Math.abs(enhanced.targetVolatility / baseline.targetVolatility - 1.5) < 1e-12);
  assert.ok(Math.abs(enhanced.maxGrossExposure / baseline.maxGrossExposure - 1.5) < 1e-12);
  assert.ok(Math.abs(enhanced.maxAssetExposure / baseline.maxAssetExposure - 1.5) < 1e-12);

  const baselineResult = runLongShortTrendBacktest(syntheticSeries(), {
    ...options,
    targetVolatility: baseline.targetVolatility,
    maxGrossExposure: baseline.maxGrossExposure,
    maxAssetExposure: baseline.maxAssetExposure,
  });
  const enhancedResult = runLongShortTrendBacktest(syntheticSeries(), {
    ...options,
    targetVolatility: enhanced.targetVolatility,
    maxGrossExposure: enhanced.maxGrossExposure,
    maxAssetExposure: enhanced.maxAssetExposure,
  });
  assert.ok(enhancedResult.metrics.totalReturn > baselineResult.metrics.totalReturn);
  assert.ok(enhancedResult.metrics.annualizedVolatility > baselineResult.metrics.annualizedVolatility);
});

test('高收益预设将三个风险预算同步提高到基准的 2 倍', () => {
  const baseline = LONG_SHORT_RISK_PROFILES.baseline;
  const highReturn = LONG_SHORT_RISK_PROFILES.highReturn;
  assert.ok(Math.abs(highReturn.targetVolatility / baseline.targetVolatility - 2) < 1e-12);
  assert.ok(Math.abs(highReturn.maxGrossExposure / baseline.maxGrossExposure - 2) < 1e-12);
  assert.ok(Math.abs(highReturn.maxAssetExposure / baseline.maxAssetExposure - 2) < 1e-12);
  assert.equal(highReturn.maxLeverage, 3);
});

test('动态回撤控制只使用当时净值并在触发后降低风险', () => {
  const uncontrolled = runLongShortTrendBacktest(syntheticSeries(), options);
  const controlled = runLongShortTrendBacktest(syntheticSeries(), {
    ...options,
    drawdownControlStart: 0.01,
    drawdownControlFull: 0.03,
    minimumRiskScale: 0.25,
  });
  assert.ok(controlled.metrics.deleveragedDays > 0);
  assert.ok(controlled.metrics.averageRiskScale < 1);
  assert.ok(controlled.metrics.maxDrawdown >= uncontrolled.metrics.maxDrawdown);
});

test('高一致性信号可以按趋势强度动态提高风险预算', () => {
  const uncappedOptions = {
    ...options,
    minimumTrendVotes: 3,
    maxGrossExposure: 2,
    maxAssetExposure: 1,
  };
  const fixed = runLongShortTrendBacktest(syntheticSeries(), uncappedOptions);
  const dynamic = runLongShortTrendBacktest(syntheticSeries(), {
    ...uncappedOptions,
    dynamicLeverageEnabled: true,
    dynamicLeverageMin: 1,
    dynamicLeverageMax: 2,
    dynamicLeverageStrengthTarget: 0.05,
  });
  assert.ok(dynamic.metrics.dynamicLeveragedDays > 0);
  assert.ok(dynamic.metrics.averageDynamicLeverage > 1);
  assert.equal(dynamic.metrics.maximumDynamicLeverage, 2);
  assert.ok(dynamic.metrics.averageGrossExposure > fixed.metrics.averageGrossExposure);
});

test('活跃信号不足时保持空仓且动态杠杆回到 1 倍', () => {
  const result = runLongShortTrendBacktest(syntheticSeries(), {
    ...options,
    minimumActiveSignals: 3,
    dynamicLeverageEnabled: true,
    dynamicLeverageMax: 3,
  });
  assert.equal(result.metrics.totalReturn, 0);
  assert.equal(result.metrics.longExposureDays, 0);
  assert.equal(result.metrics.shortExposureDays, 0);
  assert.equal(result.metrics.maximumDynamicLeverage, 1);
});

test('动态杠杆配置拒绝超过 3 倍或倒置的区间', () => {
  assert.throws(
    () => runLongShortTrendBacktest(syntheticSeries(), { ...options, dynamicLeverageMax: 4 }),
    /dynamicLeverageMax 必须在 1 到 3 之间/,
  );
  assert.throws(
    () => runLongShortTrendBacktest(syntheticSeries(), {
      ...options,
      dynamicLeverageMin: 2,
      dynamicLeverageMax: 1.5,
    }),
    /dynamicLeverageMin 不能大于 dynamicLeverageMax/,
  );
});

test('短周期未确认下跌时拒绝滞后的趋势空头', () => {
  const series = syntheticSeries();
  const closesBySymbol = Object.fromEntries(Object.entries(series).map(([symbol, rows]) => [
    symbol,
    rows.map((row) => row.close),
  ]));
  const allocation = calculateLongShortTrendWeights(
    closesBySymbol,
    Object.keys(closesBySymbol),
    250,
    {
      ...options,
      positionMode: 'both',
      minimumTrendVotes: 2,
      dynamicLeverageEnabled: false,
      shortConfirmationLookbackDays: 5,
      shortConfirmationMinimumReturn: 0.02,
    },
  );
  assert.equal(allocation.shortConfirmation.enabled, true);
  assert.ok(allocation.shortConfirmation.rejectedSymbols.length > 0);
  for (const symbol of allocation.shortConfirmation.rejectedSymbols) {
    assert.equal(allocation.weights[symbol], 0);
  }
});

test('短周期确认配置拒绝无效窗口和阈值', () => {
  assert.throws(
    () => runLongShortTrendBacktest(syntheticSeries(), {
      ...options,
      shortConfirmationLookbackDays: 1,
    }),
    /shortConfirmationLookbackDays/,
  );
  assert.throws(
    () => runLongShortTrendBacktest(syntheticSeries(), {
      ...options,
      shortConfirmationMinimumReturn: -0.01,
    }),
    /shortConfirmationMinimumReturn/,
  );
});

test('月度止盈锁定只在达到当月目标后停止后续交易', () => {
  const result = runLongShortTrendBacktest(syntheticSeries(), {
    ...options,
    monthlyProfitLock: 0.005,
  });
  assert.ok(result.metrics.monthlyProfitLockCount > 0);
  assert.ok(result.metrics.monthlyLockedDays > result.metrics.monthlyProfitLockCount);
});

test('月度保护参数拒绝零、负数和不合理的大比例', () => {
  for (const invalid of [0, -0.01, 1]) {
    assert.throws(
      () => runLongShortTrendBacktest(syntheticSeries(), { ...options, monthlyProfitLock: invalid }),
      /monthlyProfitLock 必须大于 0 且小于 1，或设为 null/,
    );
  }
});
