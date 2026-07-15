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

test('四类基础策略默认参数均可通过校验并生成风险摘要', () => {
  for (const type of ['grid', 'martingale', 'dca', 'maCrossover']) {
    const strategy = validateStrategyInput(defaults(type));
    assert.equal(strategy.type, type);
    assert.ok(strategy.riskSummary.estimatedMaxInvestment > 0);
    assert.ok(strategy.riskSummary.metrics.length >= 2);
  }
});

test('马丁配置拒绝超过最大资金上限', () => {
  assert.throws(
    () => validateStrategyInput(defaults('martingale', { volumeMultiplier: 3, maxSafetyOrders: 8, maxInvestment: 500 })),
    (error) => error instanceof StrategyValidationError && /超过资金上限/.test(error.message),
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
