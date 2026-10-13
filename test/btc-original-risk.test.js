import test from 'node:test';
import assert from 'node:assert/strict';
import { createBtcOriginalRiskSignal } from '../src/btc-original-risk.js';
import { replayBtcBehavior } from '../src/btc-behavior-replay.js';
import { BTC_SINGLE_ASSET_PAPER_PROFILE, initializeBtcPaperState, advanceBtcPaperState } from '../src/btc-paper.js';
import { calculateLongShortTrendWeights } from '../src/long-short-trend.js';
import { addUtcDays } from '../src/monthly-accuracy-paper.js';

function near(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

function closesFor(length = 201) {
  return Array.from({ length }, (_, index) => 100 * Math.exp(index * 0.001 + Math.sin(index / 5) * 0.008));
}

function context({ date = '2026-01-10', equity = 10_000, startingEquity = 10_000,
  previousWeight = 0, closes = closesFor(), ...rest } = {}) {
  return { cycleDate: date, closes, index: closes.length - 1, startingEquity,
    equityBeforeTrade: equity, previousWeight, daysInPosition: 0, lastDirection: 0,
    previousTargetWeight: previousWeight, settledWeight: previousWeight, markPrice: closes.at(-1), ...rest };
}

function marketFor(prices, start = '2026-01-28') {
  const closes = closesFor(200 + prices.length);
  return {
    initializationCycleDate: start,
    throughCycleDate: addUtcDays(start, prices.length - 1),
    seriesBySymbol: { BTCUSDT: closes.map((close, index) => ({ date: addUtcDays(start, index - 201), close })) },
    markPricesByCycleDate: Object.fromEntries(prices.map((price, index) => [addUtcDays(start, index), { BTCUSDT: price }])),
  };
}

test('default adapter exactly preserves original price allocation and labels missing news evidence', () => {
  const ctx = context();
  const expected = calculateLongShortTrendWeights({ BTCUSDT: ctx.closes }, ['BTCUSDT'], ctx.index,
    BTC_SINGLE_ASSET_PAPER_PROFILE.trend);
  const result = createBtcOriginalRiskSignal()(ctx);
  near(result.targetWeight, expected.weights.BTCUSDT);
  near(result.diagnostics.originalRisk.riskBudget, Math.abs(expected.weights.BTCUSDT));
  assert.equal(result.diagnostics.originalRisk.evidenceScope, 'price_only');
  assert.equal(result.diagnostics.originalRisk.monthStartEquity, 10_000);
  assert.equal(result.diagnostics.signal.details.source, 'original_price_trend');
});

test('direction candidates can independently long, short or exit but cannot alter original risk size', () => {
  const original = createBtcOriginalRiskSignal()(context()).targetWeight;
  assert.ok(original > 0);
  for (const direction of [-1, 0, 1]) {
    const result = createBtcOriginalRiskSignal({ directionSignal: (ctx) => {
      assert.equal(ctx.originalDirection, 1);
      near(ctx.originalRawWeight, original);
      return { direction, diagnostics: { strategy: 'direction_only' }, targetWeight: 5 };
    } })(context());
    near(result.targetWeight, direction * Math.abs(original));
    assert.equal(result.diagnostics.signal.details.strategy, 'direction_only');
  }
});

test('original risk allocation is genuinely short on a sustained downtrend', () => {
  const closes = closesFor().map((price) => 10_000 / price);
  const result = createBtcOriginalRiskSignal()(context({ closes }));
  assert.ok(result.targetWeight < 0);
  assert.equal(result.diagnostics.originalRisk.originalDirection, -1);
});

test('monthly loss lock persists after equity recovery and candidate direction changes', () => {
  let direction = 1;
  const signal = createBtcOriginalRiskSignal({ directionSignal: () => ({ direction }) });
  assert.ok(signal(context()).targetWeight > 0);
  const loss = signal(context({ date: '2026-01-11', equity: 9800, previousWeight: 0.4 }));
  assert.equal(loss.targetWeight, 0);
  assert.equal(loss.diagnostics.originalRisk.lockReason, 'loss');
  direction = -1;
  const recovered = signal(context({ date: '2026-01-12', equity: 10_050 }));
  assert.equal(recovered.targetWeight, 0);
  assert.equal(recovered.diagnostics.originalRisk.lockReason, 'loss');
  assert.equal(recovered.diagnostics.signal.direction, -1);
});

test('loss is checked before next-result-month reset and reset occurs on the final calendar day', () => {
  const signal = createBtcOriginalRiskSignal();
  signal(context({ date: '2026-01-29' }));
  const locked = signal(context({ date: '2026-01-30', equity: 9800 }));
  assert.equal(locked.diagnostics.originalRisk.currentMonth, '2026-01');
  assert.equal(locked.targetWeight, 0);
  const reset = signal(context({ date: '2026-01-31', equity: 9700 }));
  assert.equal(reset.diagnostics.originalRisk.currentMonth, '2026-02');
  assert.equal(reset.diagnostics.originalRisk.settledLockReason, 'loss');
  assert.equal(reset.diagnostics.originalRisk.lockReason, null);
  assert.equal(reset.diagnostics.originalRisk.monthStartEquity, 9700);
  assert.equal(reset.diagnostics.originalRisk.monthChanged, true);
  assert.ok(reset.targetWeight > 0);
  const next = signal(context({ date: '2026-02-01', equity: 9700 }));
  assert.equal(next.diagnostics.originalRisk.monthChanged, false);
  assert.equal(next.diagnostics.originalRisk.monthStartEquity, 9700);
});

test('a new loss on the reset day is retained in settled diagnostics then cleared for the new month', () => {
  const signal = createBtcOriginalRiskSignal();
  signal(context({ date: '2026-01-30' }));
  const reset = signal(context({ date: '2026-01-31', equity: 9700 }));
  assert.equal(reset.diagnostics.originalRisk.settledLockReason, 'loss');
  assert.equal(reset.diagnostics.originalRisk.lockReason, null);
  assert.ok(reset.targetWeight > 0);
});

test('profit de-risk reduces original size at one percent and clears only through original rules', () => {
  const signal = createBtcOriginalRiskSignal();
  const first = signal(context({ date: '2026-01-29' }));
  const derisk = signal(context({ date: '2026-01-30', equity: 10_100 }));
  near(derisk.targetWeight, first.targetWeight * 0.1);
  assert.equal(derisk.diagnostics.originalRisk.profitDeRisk.active, true);
  const reset = signal(context({ date: '2026-01-31', equity: 10_100 }));
  near(reset.targetWeight, first.targetWeight);
  assert.equal(reset.diagnostics.originalRisk.monthStartEquity, 10_100);
  assert.equal(reset.diagnostics.originalRisk.profitDeRisk.active, false);
});

test('direction callback sees immutable actual position even with zero risk budget', () => {
  const observed = [];
  const signal = createBtcOriginalRiskSignal({ directionSignal: (ctx) => {
    observed.push(ctx.previousWeight);
    assert.ok(Object.isFrozen(ctx));
    assert.ok(Object.isFrozen(ctx.closes));
    assert.throws(() => { ctx.previousWeight = 10; }, TypeError);
    assert.throws(() => { ctx.closes[0] = 10; }, TypeError);
    return { direction: -1 };
  } });
  const flat = signal(context({ closes: Array(201).fill(100), previousWeight: 0.25 }));
  assert.equal(flat.targetWeight, 0);
  assert.equal(flat.diagnostics.originalRisk.riskBudget, 0);
  const locked = signal(context({ date: '2026-01-11', equity: 9800, previousWeight: -0.3 }));
  assert.equal(locked.targetWeight, 0);
  signal(context({ date: '2026-01-12', equity: 9800, previousWeight: 0 }));
  assert.deepEqual(observed, [0.25, -0.3, 0]);
});

test('explicit direction exit is not blocked by profit de-risk', () => {
  let direction = 1;
  const signal = createBtcOriginalRiskSignal({ directionSignal: () => ({ direction }) });
  signal(context());
  direction = 0;
  const result = signal(context({ date: '2026-01-11', equity: 10_200, previousWeight: 0.5 }));
  assert.equal(result.targetWeight, 0);
  assert.equal(result.diagnostics.originalRisk.profitDeRisk.active, true);
});

test('zero-cost original-rule baseline matches legacy rules across profit de-risk and month boundaries', () => {
  const profile = { ...BTC_SINGLE_ASSET_PAPER_PROFILE, tradingCostRate: 0, dailyCarryCostRate: 0 };
  const market = marketFor([100, 103, 99, 97, 101, 105, 98, 96, 100]);
  const newState = replayBtcBehavior({ market, profile, signalFn: createBtcOriginalRiskSignal({ profile }) });
  const oldState = initializeBtcPaperState({ seriesBySymbol: market.seriesBySymbol,
    cycleDate: market.initializationCycleDate, markPrice: 100, profile, now: 0 });
  advanceBtcPaperState({ state: oldState, seriesBySymbol: market.seriesBySymbol,
    markPricesByCycleDate: market.markPricesByCycleDate, throughCycleDate: market.throughCycleDate, profile, now: 0 });
  for (let index = 0; index < newState.reports.length; index += 1) {
    const actual = newState.reports[index];
    const expected = oldState.reports[index];
    near(actual.nextWeight, expected.nextWeight, 6e-9);
    near(actual.equity, expected.equity, 0.001);
    assert.equal(actual.diagnostics.originalRisk.lockReason, expected.lockReason);
    assert.equal(actual.diagnostics.originalRisk.profitDeRisk.active, expected.profitDeRisk.active);
  }
});

test('future rows cannot change adapter replay or any earlier decision', () => {
  const market = marketFor([100, 103, 99, 97, 101]);
  const options = { market, profile: { ...BTC_SINGLE_ASSET_PAPER_PROFILE }, throughCycleDate: '2026-01-30' };
  const before = replayBtcBehavior({ ...options, signalFn: createBtcOriginalRiskSignal() });
  market.seriesBySymbol.BTCUSDT.filter((row) => row.date > '2026-01-29').forEach((row) => { row.close = 1e10; });
  market.markPricesByCycleDate['2026-01-31'].BTCUSDT = 1;
  const after = replayBtcBehavior({ ...options, signalFn: createBtcOriginalRiskSignal() });
  assert.deepEqual(after, before);
});

test('adapter rejects future-bearing contexts, duplicate replays and invalid candidate directions', () => {
  const signal = createBtcOriginalRiskSignal();
  assert.throws(() => signal(context({ index: 180 })), /past-only/);
  assert.throws(() => signal(context({ closes: [100, 101] })), /past-only/);
  assert.throws(() => signal(context({ equity: NaN })), /equityBeforeTrade/);
  signal(context());
  assert.throws(() => signal(context()), /fresh closure/);
  assert.throws(() => signal(context({ date: '2026-01-12' })), /consecutive/);
  for (const direction of [null, undefined, 0.5, 2, NaN, '1']) {
    assert.throws(() => createBtcOriginalRiskSignal({ directionSignal: () => ({ direction }) })(context()), /direction/);
  }
  assert.throws(() => createBtcOriginalRiskSignal({ directionSignal: async () => ({ direction: 1 }) })(context()), /synchronously/);
});
