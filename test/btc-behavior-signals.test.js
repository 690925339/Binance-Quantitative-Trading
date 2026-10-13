import assert from 'node:assert/strict';
import test from 'node:test';
import { btcBehaviorCandidates, createBtcBehaviorSignal } from '../src/btc-behavior-signals.js';

function prices(returns, initial = 100) {
  const values = [initial];
  for (const value of returns) values.push(values.at(-1) * Math.exp(value));
  return values;
}

function path(length = 240) {
  return prices(Array.from({ length }, (_, i) => 0.0004 + 0.018 * Math.sin(i * 1.7) + 0.006 * Math.cos(i * 0.23)));
}

function signal(id) {
  return createBtcBehaviorSignal(btcBehaviorCandidates().find(candidate => candidate.id === id).profile);
}

function input(closes, extra = {}) {
  return { closes, index: closes.length - 1, cycleDate: '2026-10-04', ...extra };
}

function closeEnough(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} not close to ${expected}`);
}

test('candidate protocol is fixed, bounded, research-only and independently owned', () => {
  const first = btcBehaviorCandidates();
  const second = btcBehaviorCandidates();
  assert.deepEqual(first.map(candidate => candidate.id), ['L0', 'T0', 'T1', 'R0', 'H0', 'H1', 'H2']);
  assert.deepEqual(first, second);
  for (const { profile } of first) {
    assert.equal(profile.researchOnly, true);
    assert.equal(profile.maxGrossExposure, 1);
    assert.equal(profile.positionCap, 0.5);
    assert.equal(profile.targetAnnualizedVolatility, 0.1);
    assert.equal(profile.tradingCostRate, 0.0007);
    assert.equal(profile.dailyCarryCostRate, 0.00005);
  }
  first.find(candidate => candidate.id === 'H0').profile.behavior.trendLookbacks[0] = 999;
  first[0].profile.positionCap = 0.1;
  assert.equal(first.find(candidate => candidate.id === 'H1').profile.behavior.trendLookbacks[0], 20);
  assert.equal(second.find(candidate => candidate.id === 'H0').profile.behavior.trendLookbacks[0], 20);
  assert.equal(second[0].profile.positionCap, 0.5);
});

test('all active strategies are reciprocal-price symmetric with both long and short signals', () => {
  const scenarios = [path(), prices(Array.from({ length: 240 }, (_, i) => 0.002 + 0.001 * Math.sin(i))),
    prices(Array.from({ length: 240 }, (_, i) => -0.002 + 0.001 * Math.sin(i)))];
  for (const { id, profile } of btcBehaviorCandidates().filter(candidate => candidate.id !== 'L0')) {
    const evaluate = createBtcBehaviorSignal(profile);
    const directions = new Set();
    for (const closes of scenarios) {
      for (const previousWeight of [-0.2, 0, 0.2]) {
        const direct = evaluate(input(closes, { previousWeight, daysInPosition: 1 }));
        const inverse = evaluate(input(closes.map(value => 10000 / value), { previousWeight: -previousWeight, daysInPosition: 1 }));
        closeEnough(direct.targetWeight, -inverse.targetWeight);
        closeEnough(direct.diagnostics.annualizedVolatility, inverse.diagnostics.annualizedVolatility);
        assert.ok(Math.abs(direct.targetWeight) <= profile.positionCap);
        directions.add(Math.sign(direct.targetWeight));
        assert.equal(direct.diagnostics.regime, inverse.diagnostics.regime);
      }
    }
    assert.ok(directions.has(1) && directions.has(-1), `${id} must support both directions`);
  }
});

test('future prices cannot influence signals or validation and are not even read', () => {
  const prefix = path(200);
  const extended = [...prefix, NaN, -1];
  Object.defineProperty(extended, prefix.length + 2, { get() { throw new Error('Read future price'); } });
  for (const { profile } of btcBehaviorCandidates()) {
    const evaluate = createBtcBehaviorSignal(profile);
    const expected = evaluate(input(prefix));
    assert.deepEqual(evaluate({ ...input(extended), index: prefix.length - 1 }), expected);
    assert.deepEqual(prefix, path(200));
  }
});

test('warmup requires 180 complete intervals and constant-price active markets stay flat', () => {
  for (const { id, profile } of btcBehaviorCandidates()) {
    const evaluate = createBtcBehaviorSignal(profile);
    assert.equal(evaluate(input(path(179))).targetWeight, 0);
    assert.equal(evaluate(input(path(179))).diagnostics.reason, 'warmup');
    const ready = evaluate(input(Array(181).fill(100)));
    if (id === 'L0') {
      assert.equal(ready.targetWeight, 0.3);
      assert.equal(ready.diagnostics.reason, 'constant_weight_long_benchmark');
    } else {
      assert.equal(ready.targetWeight, 0);
      assert.equal(ready.diagnostics.reason, 'flat_market');
    }
  }
});

test('trend and z-score reversal intentionally take opposite sides of extended moves', () => {
  const rising = prices(Array.from({ length: 220 }, (_, i) => 0.002 + 0.0005 * Math.sin(i)));
  assert.ok(signal('T0')(input(rising)).targetWeight > 0);
  assert.ok(signal('T1')(input(rising)).targetWeight > 0);
  assert.ok(signal('R0')(input(rising)).targetWeight < 0);
  const falling = rising.map(value => 10000 / value);
  assert.ok(signal('T0')(input(falling)).targetWeight < 0);
  assert.ok(signal('R0')(input(falling)).targetWeight > 0);
});

test('target volatility sets size and cap prevents leverage escalation', () => {
  const rising = prices(Array.from({ length: 220 }, (_, i) => 0.01 + 0.04 * Math.sin(i)));
  const result = signal('T0')(input(rising));
  const size = Math.min(0.5, 0.1 / result.diagnostics.annualizedVolatility);
  closeEnough(Math.abs(result.targetWeight), size);
  const smooth = prices(Array(220).fill(0.001));
  assert.equal(signal('T0')(input(smooth)).targetWeight, 0.5);
});

test('H1 RSI hysteresis holds only until the symmetric center exit', () => {
  const history = Array.from({ length: 206 }, (_, i) => i % 2 ? 0.02 : -0.02);
  const closes = prices([...history, ...Array.from({ length: 14 }, (_, i) => i % 2 ? 0.008 : -0.01)]);
  const h0 = signal('H0')(input(closes, { previousWeight: 0.2, daysInPosition: 2 }));
  const h1 = signal('H1')(input(closes, { previousWeight: 0.2, daysInPosition: 2 }));
  assert.equal(h1.diagnostics.regime, 'range');
  assert.ok(h1.diagnostics.rsi > 40 && h1.diagnostics.rsi < 50);
  assert.equal(h0.targetWeight, 0);
  assert.ok(h1.targetWeight > 0);
  assert.equal(h1.diagnostics.reason, 'range_rsi_hysteresis_hold');
  const inverse = closes.map(value => 10000 / value);
  assert.ok(signal('H1')(input(inverse, { previousWeight: -0.2, daysInPosition: 2 })).targetWeight < 0);
  assert.equal(signal('H1')(input(inverse, { previousWeight: 0.2, daysInPosition: 2 })).targetWeight, 0);
});

test('H2 time exit emits flat at three intervals and permits next-day reentry', () => {
  const closes = prices(Array.from({ length: 220 }, (_, i) => 0.002 + 0.0005 * Math.sin(i)));
  const evaluate = signal('H2');
  const two = evaluate(input(closes, { previousWeight: 0.2, daysInPosition: 2 }));
  assert.ok(two.targetWeight > 0);
  const three = evaluate(input(closes, { previousWeight: 0.2, daysInPosition: 3 }));
  assert.equal(three.targetWeight, 0);
  assert.equal(three.diagnostics.timeExit, true);
  assert.equal(three.diagnostics.reason, 'maximum_holding_exit');
  const nextDay = evaluate(input([...closes, closes.at(-1) * Math.exp(0.002)], { previousWeight: 0, daysInPosition: 0, lastDirection: 1 }));
  assert.ok(nextDay.targetWeight > 0);
  const opposite = closes.map(value => 10000 / value);
  const minimum = evaluate(input(opposite, { previousWeight: 0.2, daysInPosition: 0 }));
  assert.ok(minimum.targetWeight > 0);
  assert.equal(minimum.diagnostics.minimumHoldingApplied, true);
  assert.ok(evaluate(input(opposite, { previousWeight: 0.2, daysInPosition: 1 })).targetWeight < 0);
});

test('reject malformed prices, dates, metadata and unsafe/asymmetric configurations', () => {
  const evaluate = signal('T0');
  const valid = input(path());
  for (const override of [{ closes: null }, { closes: [] }, { index: -1 }, { index: 1.5 }, { index: 10000 },
    { previousWeight: NaN }, { previousTargetWeight: Infinity }, { daysInPosition: -1 }, { daysInPosition: 1.5 },
    { lastDirection: 2 }, { cycleDate: '2026-02-30' }, { cycleDate: '2026-2-03' }]) {
    assert.throws(() => evaluate({ ...valid, ...override }), /Invalid/);
  }
  for (const bad of [0, -1, NaN, Infinity, '100']) {
    assert.throws(() => evaluate(input([...path(200), bad])), /Invalid close/);
  }
  for (const override of [{ maxGrossExposure: 2 }, { positionCap: 2 }, { warmupIntervals: 30 }, { tradingCostRate: -1 },
    { dailyCarryCostRate: NaN }, { targetAnnualizedVolatility: 0 }, { volatilityLookback: 181 }]) {
    const profile = btcBehaviorCandidates().find(candidate => candidate.id === 'T0').profile;
    assert.throws(() => createBtcBehaviorSignal({ ...profile, ...override }));
  }
  const h = btcBehaviorCandidates().find(candidate => candidate.id === 'H0').profile;
  assert.throws(() => createBtcBehaviorSignal({ ...h, behavior: { ...h.behavior, rsiEntryHigh: 70 } }), /symmetric/);
  assert.throws(() => createBtcBehaviorSignal({ ...h, behavior: { ...h.behavior, maximumHoldingDays: 1, minimumHoldingDays: 1 } }), /holding-day/);
});

test('signal closures copy profiles and every evaluation returns independent diagnostics', () => {
  const profile = btcBehaviorCandidates().find(candidate => candidate.id === 'T0').profile;
  const evaluate = createBtcBehaviorSignal(profile);
  const closes = path();
  const expected = evaluate(input(closes));
  profile.behavior.trendLookbacks[0] = 10000;
  profile.positionCap = 0;
  const mutable = evaluate(input(closes));
  mutable.diagnostics.trend.returns[0] = 999;
  mutable.diagnostics.reason = 'mutated';
  assert.deepEqual(evaluate(input(closes)), expected);
});
