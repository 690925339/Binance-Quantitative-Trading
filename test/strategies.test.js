import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STRATEGY_CATALOG, StrategyStore, StrategyValidationError, validateStrategyInput } from '../src/strategies.js';

function defaults(type, overrides = {}) {
  return {
    name: `${STRATEGY_CATALOG[type].name}测试`,
    type,
    symbol: 'BTCUSDT',
    config: {
      ...Object.fromEntries(STRATEGY_CATALOG[type].fields.map((field) => [field.key, field.default])),
      ...overrides,
    },
  };
}

test('十一类基础策略默认参数均可通过校验并生成风险摘要', () => {
  for (const type of ['grid', 'martingale', 'dca', 'maCrossover', 'longShortTrend', 'longShortEnhanced', 'longShortHighReturn', 'monthlyAccuracyPortfolio', 'btcSingleAssetTrend', 'stableComposite', 'aggressiveComposite']) {
    const strategy = validateStrategyInput(defaults(type));
    assert.equal(strategy.type, type);
    assert.ok(strategy.riskSummary.estimatedMaxInvestment > 0);
    assert.ok(strategy.riskSummary.metrics.length >= 2);
  }
});

test('BTC单币策略固定BTC并披露独立模拟风险', () => {
  const strategy = validateStrategyInput(defaults('btcSingleAssetTrend'));
  assert.equal(strategy.symbol, 'BTCUSDT');
  assert.equal(strategy.config.shortLookbackDays, 45);
  assert.equal(strategy.config.leverage, 2);
  assert.equal(strategy.riskSummary.estimatedMaxExposure, 10_000);
  assert.match(strategy.riskSummary.warnings.join(' '), /10\/18个盈利月/);
  assert.throws(
    () => validateStrategyInput({ ...defaults('btcSingleAssetTrend'), symbol: 'ETHUSDT' }),
    /只允许 BTCUSDT/,
  );
});

test('90% 盈利月组合固定准确率优先权重并限制杠杆不超过 3 倍', () => {
  const strategy = validateStrategyInput(defaults('monthlyAccuracyPortfolio'));
  assert.equal(strategy.config.marketNeutralWeightPercent, 85);
  assert.equal(strategy.config.trendWeightPercent, 15);
  assert.equal(strategy.config.marketNeutralBaseGrossExposurePercent, 50);
  assert.equal(strategy.config.maxGrossExposurePercent, 143);
  assert.equal(strategy.config.monthlyProfitLockPercent, 1);
  assert.equal(strategy.config.referenceFilterEnabled, 'disabled');
  assert.equal(strategy.riskSummary.estimatedMaxExposure, 1_430);
  assert.match(strategy.riskSummary.warnings.join(' '), /不是未来月份获利概率/);
  assert.throws(
    () => validateStrategyInput(defaults('monthlyAccuracyPortfolio', {
      marketNeutralWeightPercent: 70,
      trendWeightPercent: 20,
    })),
    /权重之和必须为 100%/,
  );
  assert.throws(
    () => validateStrategyInput(defaults('monthlyAccuracyPortfolio', { leverage: 4 })),
    /杠杆倍数必须在 1 到 3 之间/,
  );
  assert.throws(
    () => validateStrategyInput(defaults('monthlyAccuracyPortfolio', {
      fearGreedMinimum: 90,
      fearGreedMaximum: 20,
    })),
    /恐惧指数下限不能高于上限/,
  );
  const observing = validateStrategyInput(defaults('monthlyAccuracyPortfolio', {
    referenceFilterEnabled: 'enabled',
  }));
  assert.match(observing.riskSummary.warnings.join(' '), /冻结验证只有 14\/18 个盈利月/);
  assert.throws(
    () => validateStrategyInput(defaults('monthlyAccuracyPortfolio', {
      minimumTrendWeightPercent: 20,
    })),
    /动态趋势权重范围必须包含当前趋势仓位权重/,
  );
  assert.throws(
    () => validateStrategyInput(defaults('monthlyAccuracyPortfolio', {
      drawdownControlStartPercent: 15,
      drawdownControlFullPercent: 10,
    })),
    /组合减仓起始回撤必须小于完全减仓回撤/,
  );
});

test('马丁配置拒绝超过最大资金上限', () => {
  assert.throws(
    () => validateStrategyInput(defaults('martingale', { volumeMultiplier: 3, maxSafetyOrders: 8, maxInvestment: 500 })),
    (error) => error instanceof StrategyValidationError && /超过资金上限/.test(error.message),
  );
});

test('常规策略支持 1 到 125 倍整数杠杆，并按杠杆汇总名义敞口', () => {
  for (const type of ['grid', 'martingale', 'dca', 'maCrossover', 'longShortTrend']) {
    const strategy = validateStrategyInput(defaults(type, { leverage: 5 }));
    assert.equal(strategy.config.leverage, 5);
    assert.equal(strategy.riskSummary.leverage, 5);
    const expectedExposure = type === 'longShortTrend'
      ? strategy.riskSummary.estimatedMaxInvestment * strategy.config.maxGrossExposurePercent / 100
      : strategy.riskSummary.estimatedMaxInvestment * 5;
    assert.equal(strategy.riskSummary.estimatedMaxExposure, expectedExposure);
  }
  assert.throws(
    () => validateStrategyInput(defaults('grid', { leverage: 126 })),
    /杠杆倍数必须在 1 到 125 之间/,
  );
});

test('网格与双均线执行交叉字段校验', () => {
  assert.throws(
    () => validateStrategyInput(defaults('grid', { lowerPrice: 100_000, upperPrice: 50_000 })),
    /区间下限必须低于上限/,
  );
  assert.throws(
    () => validateStrategyInput(defaults('maCrossover', { fastPeriod: 30, slowPeriod: 20 })),
    /快线周期必须小于慢线周期/,
  );
});

test('多空趋势策略校验回看周期和组合敞口边界', () => {
  assert.throws(
    () => validateStrategyInput(defaults('longShortTrend', { shortLookbackDays: 90, mediumLookbackDays: 30 })),
    /短周期 < 中周期 < 长周期/,
  );
  assert.throws(
    () => validateStrategyInput(defaults('longShortTrend', { maxAssetExposurePercent: 60, maxGrossExposurePercent: 50 })),
    /单币最大敞口不能超过组合最大总敞口/,
  );
  const strategy = validateStrategyInput(defaults('longShortTrend', { marginBudget: 1_000, maxGrossExposurePercent: 50, leverage: 5 }));
  assert.equal(strategy.riskSummary.estimatedMaxExposure, 500);
});

test('收益增强档使用 1.5 倍风险预算并将杠杆硬限制为 3 倍', () => {
  const strategy = validateStrategyInput(defaults('longShortEnhanced'));
  assert.equal(strategy.config.targetVolatilityPercent, 15);
  assert.equal(strategy.config.maxGrossExposurePercent, 75);
  assert.equal(strategy.config.maxAssetExposurePercent, 22.5);
  assert.equal(strategy.config.leverage, 2);
  assert.equal(strategy.riskSummary.estimatedMaxExposure, 750);
  assert.match(strategy.riskSummary.warnings.join(' '), /历史最大回撤为 -21.68%/);
  assert.throws(
    () => validateStrategyInput(defaults('longShortEnhanced', { leverage: 4 })),
    /杠杆倍数必须在 1 到 3 之间/,
  );
});

test('高收益档使用 2 倍风险预算并明确展示历史回撤边界', () => {
  const strategy = validateStrategyInput(defaults('longShortHighReturn'));
  assert.equal(strategy.config.targetVolatilityPercent, 20);
  assert.equal(strategy.config.maxGrossExposurePercent, 100);
  assert.equal(strategy.config.maxAssetExposurePercent, 30);
  assert.equal(strategy.config.leverage, 2);
  assert.equal(strategy.riskSummary.estimatedMaxExposure, 1_000);
  assert.match(strategy.riskSummary.warnings.join(' '), /未来收益不保证超过 10%/);
  assert.throws(
    () => validateStrategyInput(defaults('longShortHighReturn', { leverage: 4 })),
    /杠杆倍数必须在 1 到 3 之间/,
  );
});

test('新闻组合策略校验信号权重和杠杆上限', () => {
  assert.throws(
    () => validateStrategyInput(defaults('stableComposite', { priceSignalWeight: 80, newsSignalWeight: 30 })),
    /权重之和必须为 100%/,
  );
  assert.throws(
    () => validateStrategyInput(defaults('stableComposite', { leverage: 4 })),
    /杠杆倍数必须在 1 到 3 之间/,
  );
  assert.equal(validateStrategyInput(defaults('aggressiveComposite')).config.leverage, 2);
});

test('稳健组合配置 90% 准确率条件杠杆并按 1.25 倍展示最大潜在敞口', () => {
  const enabled = validateStrategyInput(defaults('stableComposite'));
  assert.equal(enabled.config.accuracyLeverageThresholdPercent, 90);
  assert.equal(enabled.config.accuracyLeverageMinimumSamples, 100);
  assert.equal(enabled.config.accuracyLeverageMultiplier, 1.25);
  assert.equal(enabled.riskSummary.estimatedMaxExposure, 375);

  const disabled = validateStrategyInput(defaults('stableComposite', { accuracyLeverageEnabled: 'disabled' }));
  assert.equal(disabled.riskSummary.estimatedMaxExposure, 300);
  assert.throws(
    () => validateStrategyInput(defaults('stableComposite', {
      accuracyLeverageThresholdPercent: 90,
      accuracyLeverageRecentThresholdPercent: 95,
    })),
    /最近 20 条准确率门槛不能高于长期准确率门槛/,
  );
});

test('策略仓库支持创建、编辑、启停、复制与删除', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quantflow-strategies-'));
  const store = new StrategyStore(path.join(directory, 'strategies.json'));
  const created = await store.create(defaults('dca'));
  assert.equal(created.enabled, false);
  assert.equal((await store.list()).length, 1);

  const enabled = await store.setEnabled(created.id, true);
  assert.equal(enabled.enabled, true);
  const updated = await store.update(created.id, { ...defaults('dca'), name: 'BTC 长期定投' });
  assert.equal(updated.name, 'BTC 长期定投');
  assert.equal(updated.enabled, true);

  const cloned = await store.clone(created.id);
  assert.match(cloned.name, /副本$/);
  assert.equal(cloned.enabled, false);
  assert.equal((await store.list()).length, 2);

  await store.delete(created.id);
  assert.equal((await store.list()).length, 1);
});
