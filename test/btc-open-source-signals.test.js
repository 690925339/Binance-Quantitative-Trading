import assert from 'node:assert/strict';
import test from 'node:test';
import { addUtcDays } from '../src/monthly-accuracy-paper.js';
import { btcOpenSourceCandidates, btcOpenSourceIndicators, createBtcOpenSourceDirection } from '../src/btc-open-source-signals.js';

function barsFromCloses(closes, start = '2020-01-01', width = 0.2) {
  return closes.map((close, index) => {
    const open = index ? closes[index - 1] : close;
    return { date: addUtcDays(start, index), open, high: Math.max(open, close) + width,
      low: Math.min(open, close) - width, close, volume: 100 };
  });
}

function scenario() {
  return barsFromCloses(Array.from({ length: 500 }, (_, i) => 200 + 20 * Math.sin(i / 30) + 0.01 * i));
}

function profile(id) { return btcOpenSourceCandidates().find(candidate => candidate.id === id).profile; }
function input(bars, i, extra = {}) {
  return { closes: bars.slice(0, i + 1).map(bar => bar.close), index: i,
    cycleDate: addUtcDays(bars[i].date, 1), ...extra };
}

test('frozen candidates are independent, symmetric policies with explicit sources and thresholds', () => {
  const first = btcOpenSourceCandidates();
  const second = btcOpenSourceCandidates();
  assert.deepEqual(first.map(x => x.id), ['B0', 'F1', 'F2', 'Q1', 'F3']);
  assert.deepEqual(first, second);
  assert.equal(profile('F1').adxExit, 30);
  assert.equal(profile('F2').adxExit, 20);
  assert.equal(profile('F2').adxEntry, 30);
  for (const candidate of first) {
    assert.equal(candidate.profile.warmupDays, 180);
    assert.equal(candidate.profile.researchOnly, true);
  }
  first[1].profile.sourceRefs.push('mutated');
  first[2].profile.adxEntry = 99;
  assert.equal(second[1].profile.sourceRefs.length, 1);
  assert.equal(first[2].profile.sourceRefs.length, 1);
  assert.equal(second[2].profile.adxEntry, 30);
});

test('Wilder ADX initializes at index 2p-1 and matches a hand-computable monotone series', () => {
  const bars = Array.from({ length: 50 }, (_, i) => ({ date: addUtcDays('2020-01-01', i),
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  const indicators = btcOpenSourceIndicators(bars);
  assert.equal(indicators[13].plusDi, null);
  assert.equal(indicators[14].plusDi, 50);
  assert.equal(indicators[14].minusDi, 0);
  assert.equal(indicators[26].adx, null);
  assert.equal(indicators[27].adx, 100);
  assert.equal(indicators[49].adx, 100);
  assert.equal(indicators[47].slowSma, 123.5);
  assert.equal(indicators[47].fastSma, 141.5);
});

test('flat OHLC has zero finite DI and ADX without inventing a price range', () => {
  const bars = barsFromCloses(Array(200).fill(100), '2020-01-01', 0);
  const last = btcOpenSourceIndicators(bars).at(-1);
  assert.equal(last.plusDi, 0);
  assert.equal(last.minusDi, 0);
  assert.equal(last.dx, 0);
  assert.equal(last.adx, 0);
  assert.equal(createBtcOpenSourceDirection(profile('F2'), bars)(input(bars, 199, { previousWeight: -0.3 })).direction, 0);
});

test('indicator recursion is prefix stable and ignores future numeric data', () => {
  const bars = scenario();
  const expected = btcOpenSourceIndicators(bars.slice(0, 250));
  const future = { date: bars[250].date, get close() { throw new Error('future OHLC read'); } };
  assert.deepEqual(btcOpenSourceIndicators([...bars.slice(0, 250), future], { throughDate: bars[249].date }), expected);
  const whole = btcOpenSourceIndicators(bars);
  assert.deepEqual(whole.slice(0, 250), expected);
  // The recursive estimate converges with a long warmup; this is not a reseed
  // every window, which would make the ADX depend on the requested last index.
  const trimmed = btcOpenSourceIndicators(bars.slice(80));
  assert.ok(Math.abs(whole.at(-1).adx - trimmed.at(-1).adx) < 1e-7);
});

test('known OHLC rejects illegal ranges, duplicates, missing or out-of-order days', () => {
  const bars = scenario().slice(0, 200);
  for (const bad of [{ high: 0 }, { low: 9999 }, { close: NaN }, { volume: -1 }, { open: '200' }, { date: '2020-02-30' }]) {
    assert.throws(() => btcOpenSourceIndicators([{ ...bars[0], ...bad }, ...bars.slice(1)]));
  }
  assert.throws(() => btcOpenSourceIndicators([bars[0], bars[0], ...bars.slice(1)]), /duplicate/);
  assert.throws(() => btcOpenSourceIndicators([bars[0], ...bars.slice(2)]), /Missing/);
  assert.throws(() => btcOpenSourceIndicators([bars[1], bars[0], ...bars.slice(2)]), /unordered/);
});

test('all policies enforce 180 completed intervals and date-aligned OHLC closes', () => {
  const bars = scenario();
  for (const { profile: p } of btcOpenSourceCandidates()) {
    const fn = createBtcOpenSourceDirection(p, bars);
    assert.equal(fn(input(bars, 179, { originalDirection: 1 })).diagnostics.reason, 'warmup');
    assert.notEqual(fn(input(bars, 180, { originalDirection: 1 })).diagnostics.reason, 'warmup');
  }
  const shorterBars = bars.slice(20);
  const fn = createBtcOpenSourceDirection(profile('B0'), shorterBars);
  const result = fn(input(bars, 220, { originalDirection: -1 }));
  assert.equal(result.direction, -1);
  assert.equal(result.diagnostics.knownBarCount, 201);
  assert.throws(() => createBtcOpenSourceDirection(profile('F1'), bars.slice(0, 200))(input(bars, 201)), /Missing completed/);
  const badCloses = input(bars, 210);
  badCloses.closes[210] += 1;
  assert.throws(() => createBtcOpenSourceDirection(profile('B0'), bars)(badCloses), /does not match/);
});

test('ADX crossover strategies take both directions and never chase a pre-existing trend when flat', () => {
  const bars = scenario();
  const fn = createBtcOpenSourceDirection(profile('F2'), bars);
  const directions = new Set();
  let weight = 0;
  for (let i = 180; i < bars.length; i += 1) {
    const result = fn(input(bars, i, { previousWeight: weight }));
    if (result.direction !== 0 && weight === 0) assert.ok(result.diagnostics.crossUp || result.diagnostics.crossDown);
    weight = result.direction * 0.3;
    directions.add(result.direction);
  }
  assert.ok(directions.has(-1) && directions.has(1));
  const upward = barsFromCloses(Array.from({ length: 230 }, (_, i) => 100 + i));
  assert.equal(createBtcOpenSourceDirection(profile('F2'), upward)(input(upward, 220)).direction, 0);
  assert.equal(createBtcOpenSourceDirection(profile('F2'), upward)(input(upward, 220, { previousWeight: 0.4 })).direction, 1);
});

test('exit threshold is independent of entry threshold and has priority', () => {
  const bars = barsFromCloses(Array.from({ length: 500 }, (_, i) => 200 + 20 * Math.sin(i / 3)));
  const indicators = btcOpenSourceIndicators(bars);
  const index = indicators.findIndex((row, i) => i >= 180 && row.adx > 20 && row.adx < 30
    && Math.sign(row.fastSma - row.slowSma) === Math.sign(indicators[i - 1].fastSma - indicators[i - 1].slowSma));
  assert.ok(index >= 180);
  for (const side of [-1, 1]) {
    const f1 = createBtcOpenSourceDirection(profile('F1'), bars)(input(bars, index, { previousWeight: side * 0.3 }));
    const f2 = createBtcOpenSourceDirection(profile('F2'), bars)(input(bars, index, { previousWeight: side * 0.3 }));
    assert.equal(f1.direction, 0);
    assert.equal(f1.diagnostics.reason, 'adx_exit');
    assert.equal(f2.direction, side);
  }
});

test('strict ADX entry and exit threshold boundaries are respected', () => {
  const bars = scenario();
  const indicators = btcOpenSourceIndicators(bars);
  const index = indicators.findIndex((row, i) => i >= 180 && row.adx > 30
    && row.fastSma > row.slowSma && indicators[i - 1].fastSma <= indicators[i - 1].slowSma);
  assert.ok(index >= 180);
  const adx = indicators[index].adx;
  const atEntry = { ...profile('F2'), adxEntry: adx };
  const belowEntry = { ...profile('F2'), adxEntry: adx - 1e-8 };
  assert.equal(createBtcOpenSourceDirection(atEntry, bars)(input(bars, index)).direction, 0);
  assert.equal(createBtcOpenSourceDirection(belowEntry, bars)(input(bars, index)).direction, 1);
  const atExit = { ...profile('F2'), adxEntry: 100, adxExit: adx };
  const aboveExit = { ...profile('F2'), adxEntry: 100, adxExit: adx + 1e-8 };
  assert.equal(createBtcOpenSourceDirection(atExit, bars)(input(bars, index, { previousWeight: -0.2 })).direction, -1);
  assert.equal(createBtcOpenSourceDirection(aboveExit, bars)(input(bars, index, { previousWeight: -0.2 })).direction, 0);
});

test('long and short state machines are symmetric under an OHLC price reflection', () => {
  const bars = scenario();
  const reflected = bars.map(bar => ({ ...bar, open: 500 - bar.open, high: 500 - bar.low,
    low: 500 - bar.high, close: 500 - bar.close }));
  for (const id of ['F1', 'F2', 'F3']) {
    const direct = createBtcOpenSourceDirection(profile(id), bars);
    const inverse = createBtcOpenSourceDirection(profile(id), reflected);
    let weight = 0;
    for (let i = 180; i < bars.length; i += 1) {
      const a = direct(input(bars, i, { previousWeight: weight }));
      const b = inverse(input(reflected, i, { previousWeight: -weight }));
      assert.equal(a.direction + b.direction, 0);
      assert.ok(Math.abs(a.diagnostics.adx - b.diagnostics.adx) < 1e-10);
      assert.equal(a.diagnostics.pendingDirection + b.diagnostics.pendingDirection, 0);
      weight = a.direction * 0.3;
    }
  }
});

test('Q1 closes first, confirms next day, and waits for the actual old position to close', () => {
  const bars = scenario();
  for (const side of [-1, 1]) {
    const fn = createBtcOpenSourceDirection(profile('Q1'), bars);
    const close = fn(input(bars, 200, { previousWeight: side * 0.3, originalDirection: -side }));
    assert.equal(close.direction, 0);
    assert.equal(close.diagnostics.reason, 'close_before_reverse');
    const stillHeld = fn(input(bars, 201, { previousWeight: side * 0.3, originalDirection: -side }));
    assert.equal(stillHeld.direction, 0);
    assert.equal(stillHeld.diagnostics.reason, 'await_actual_flat');
    const open = fn(input(bars, 202, { previousWeight: 0, originalDirection: -side }));
    assert.equal(open.direction, -side);
    assert.equal(open.diagnostics.reason, 'confirmed_entry_after_flat');
    assert.equal(open.diagnostics.pendingDirection, 0);
  }
});

test('pending reversal is cancelled by neutral or changed direction, not treated as an executed position', () => {
  const bars = scenario();
  const fn = createBtcOpenSourceDirection(profile('Q1'), bars);
  fn(input(bars, 200, { previousWeight: 0.3, originalDirection: -1 }));
  const neutral = fn(input(bars, 201, { previousWeight: 0, originalDirection: 0 }));
  assert.equal(neutral.direction, 0);
  assert.equal(neutral.diagnostics.pendingDirection, 0);
  const actualNew = fn(input(bars, 202, { previousWeight: 0, originalDirection: 1 }));
  assert.equal(actualNew.direction, 1);
  assert.equal(actualNew.diagnostics.reason, 'direction_entry');
  const stillFlat = fn(input(bars, 203, { previousWeight: 0, originalDirection: 0 }));
  assert.equal(stillFlat.direction, 0);
  assert.equal(stillFlat.diagnostics.heldDirection, 0);
});

test('F3 requires an actual flat day before opening an opposite confirmed trend', () => {
  const bars = scenario();
  const indicators = btcOpenSourceIndicators(bars);
  const index = indicators.findIndex((row, i) => i >= 180 && row.adx > 30
    && row.fastSma > row.slowSma && indicators[i - 1].fastSma <= indicators[i - 1].slowSma);
  assert.ok(index >= 180);
  const fn = createBtcOpenSourceDirection(profile('F3'), bars);
  const close = fn(input(bars, index, { previousWeight: -0.3 }));
  assert.equal(close.direction, 0);
  assert.equal(close.diagnostics.pendingDirection, 1);
  const next = fn(input(bars, index + 1, { previousWeight: 0 }));
  assert.equal(next.direction, 1);
  assert.equal(next.diagnostics.reason, 'confirmed_entry_after_flat');
  // If a risk wrapper blocks the proposed entry, a flat actual position is not
  // silently assumed filled and the consumed pending order cannot chase later.
  const blocked = fn(input(bars, index + 2, { previousWeight: 0 }));
  assert.equal(blocked.direction, 0);
  assert.equal(blocked.diagnostics.pendingDirection, 0);
});

test('signal output is invariant to appended future bars and duplicated calls are idempotent', () => {
  const bars = scenario();
  const prefix = bars.slice(0, 220);
  const future = { date: bars[220].date, get close() { throw new Error('future inspected'); } };
  for (const { profile: p } of btcOpenSourceCandidates()) {
    const fn = createBtcOpenSourceDirection(p, [...prefix, future]);
    const ctx = input(prefix, 219, { originalDirection: 1 });
    const expected = createBtcOpenSourceDirection(p, prefix)(ctx);
    assert.deepEqual(fn(ctx), expected);
    const result = fn(ctx);
    result.diagnostics.reason = 'mutated';
    assert.deepEqual(fn(ctx), expected);
    assert.throws(() => fn({ ...ctx, previousWeight: 0.2 }), /Conflicting/);
    assert.throws(() => fn(input(prefix, 218)), /chronological/);
  }
});

test('invalid profiles and context fail closed; closures clone their configuration', () => {
  const bars = scenario();
  for (const bad of [{ mode: 'random' }, { warmupDays: 100 }, { adxPeriod: 200 }, { adxEntry: 10 },
    { adxExit: -1 }, { fastPeriod: 48 }, { reverseFlatFirst: 'yes' }]) {
    assert.throws(() => createBtcOpenSourceDirection({ ...profile('F2'), ...bad }, bars));
  }
  const p = profile('B0');
  const fn = createBtcOpenSourceDirection(p, bars);
  p.mode = 'invalid';
  assert.equal(fn(input(bars, 200, { originalDirection: 1 })).direction, 1);
  for (const bad of [{ originalDirection: 2 }, { previousWeight: NaN }, { index: -1 }, { cycleDate: '2026-02-30' }]) {
    assert.throws(() => createBtcOpenSourceDirection(profile('B0'), bars)({ ...input(bars, 200), ...bad }));
  }
});
