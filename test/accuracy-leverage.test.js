import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  evaluateAccuracyLeverage,
  SignalAccuracyStore,
} from '../src/accuracy-leverage.js';

const qualifiedPerformance = {
  strategyType: 'stableComposite',
  settledSignalCount: 100,
  correctSignalCount: 90,
  recentSignalCount: 20,
  recentCorrectSignalCount: 18,
  annualizedVolatility: 0.06,
  currentDrawdown: -0.03,
};

test('稳健策略满 100 条且准确率达 90% 后只增加到 1.25 倍', () => {
  const result = evaluateAccuracyLeverage(qualifiedPerformance);
  assert.equal(result.eligible, true);
  assert.equal(result.appliedLeverage, 1.25);
  assert.ok(result.wilson95Lower >= 0.82);
});

test('样本、准确率、波动或回撤任一不达标都会保持 1 倍', () => {
  const cases = [
    { settledSignalCount: 99, correctSignalCount: 90 },
    { correctSignalCount: 89 },
    { annualizedVolatility: 0.081 },
    { currentDrawdown: -0.051 },
    { strategyType: 'aggressiveComposite' },
  ];
  for (const overrides of cases) {
    const result = evaluateAccuracyLeverage({ ...qualifiedPerformance, ...overrides });
    assert.equal(result.eligible, false);
    assert.equal(result.appliedLeverage, 1);
  }
});

test('准确率台账按七天窗口结算方向并避免同交易对重叠记录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quantflow-accuracy-'));
  const store = new SignalAccuracyStore(path.join(directory, 'ledger.json'));
  const openedAt = Date.UTC(2026, 0, 1);
  const dueAt = openedAt + 168 * 60 * 60 * 1_000;
  const opened = await store.observe({
    strategyType: 'stableComposite',
    symbol: 'BTCUSDT',
    action: 'LONG',
    targetGrossExposurePercent: 30,
    referencePrice: 100,
    observedAt: openedAt,
    candles: [{ closedAt: openedAt, close: 100 }],
  });
  assert.equal(opened.recorded, true);
  assert.equal(opened.performance.settledSignalCount, 0);

  const duplicate = await store.observe({
    strategyType: 'stableComposite',
    symbol: 'BTCUSDT',
    action: 'LONG',
    targetGrossExposurePercent: 30,
    referencePrice: 101,
    observedAt: openedAt + 4 * 60 * 60 * 1_000,
    candles: [{ closedAt: openedAt + 4 * 60 * 60 * 1_000, close: 101 }],
  });
  assert.equal(duplicate.recorded, false);

  const settled = await store.observe({
    strategyType: 'stableComposite',
    symbol: 'BTCUSDT',
    action: 'WAIT',
    targetGrossExposurePercent: 0,
    referencePrice: 110,
    observedAt: dueAt,
    candles: [{ closedAt: dueAt, close: 110 }],
  });
  assert.equal(settled.settledCount, 1);
  assert.equal(settled.performance.settledSignalCount, 1);
  assert.equal(settled.performance.correctSignalCount, 1);
});
