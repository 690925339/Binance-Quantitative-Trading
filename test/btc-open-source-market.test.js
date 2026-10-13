import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateBtcHourlyCsv, mergeBtcDailyBars, parseBtcDailyKlines, validateBtcDailyBars, validateCompletedSnapshot } from '../src/btc-open-source-market.js';

const day = 86_400_000;
const start = Date.parse('2026-07-31T00:00:00Z');
const header = 'symbol,interval,open_time,open_time_utc,open,high,low,close,volume,close_time';
const rows = Array.from({ length: 24 }, (_, i) => {
  const time = start + i * 3_600_000;
  return `BTCUSDT,1h,${time},${new Date(time).toISOString()},100,${110 + i},90,105,2,${time + 3_600_000 - 1}`;
});
const csv = values => [header, ...values].join('\n');
const bar = { date: '2026-07-31', open: 100, high: 133, low: 90, close: 105, volume: 48 };
test('aggregates all 24 actual hourly bars into UTC OHLCV', () => {
  assert.deepEqual(aggregateBtcHourlyCsv(csv(rows)), [bar]);
});
test('rejects missing, duplicate, partial and invalid hourly data', () => {
  assert.throws(() => aggregateBtcHourlyCsv(csv(rows.filter((_, i) => i !== 5))), /hourly/);
  assert.throws(() => aggregateBtcHourlyCsv(csv([...rows, rows[23]])), /hourly/);
  assert.throws(() => aggregateBtcHourlyCsv(csv(rows.slice(1))), /Incomplete/);
  assert.throws(() => aggregateBtcHourlyCsv(csv(rows.map((row, i) => i ? row : row.replace(',110,', ',99,')))), /OHLC/);
});
test('parses only complete, exactly ranged daily klines', () => {
  const raw = [[start, '100', '133', '90', '105', '48', start + day - 1]];
  assert.deepEqual(parseBtcDailyKlines(raw, '2026-07-31', '2026-07-31'), [bar]);
  assert.throws(() => parseBtcDailyKlines(raw, '2026-07-31', '2026-08-01'), /range/);
  assert.throws(() => parseBtcDailyKlines([[...raw[0].slice(0, 6), start + day]], '2026-07-31', '2026-07-31'), /timestamp/);
});
test('tail overlap must match real high/low as well as close', () => {
  const next = { ...bar, date: '2026-08-01' };
  assert.deepEqual(mergeBtcDailyBars([bar], [bar, next]), [bar, next]);
  assert.throws(() => mergeBtcDailyBars([bar], [{ ...bar, high: 140 }, next]), /overlap mismatch/);
  assert.throws(() => mergeBtcDailyBars([bar], [next]), /must overlap/);
});
test('rejects daily gaps, invalid calendars, non-finite prices and volume', () => {
  assert.throws(() => validateBtcDailyBars([bar, { ...bar, date: '2026-08-02' }]), /Nonconsecutive/);
  for (const update of [{ date: '2026-02-30' }, { close: NaN }, { low: 106 }, { volume: -1 }]) {
    assert.throws(() => validateBtcDailyBars([{ ...bar, ...update }]), /Invalid/);
  }
});
test('only an official full daily bar can bridge declared missing hours, and must contain observed prices', () => {
  const incomplete = csv(rows.filter((_, i) => i !== 13));
  assert.deepEqual(aggregateBtcHourlyCsv(incomplete, { officialDailyOverrides: [bar] }), [bar]);
  const shortenedHour = incomplete.replace(String(start + 13 * 3_600_000 - 1), String(start + 12 * 3_600_000 + 1800_000));
  assert.deepEqual(aggregateBtcHourlyCsv(shortenedHour, { officialDailyOverrides: [bar] }), [bar]);
  for (const update of [{ open: 101 }, { high: 130 }, { close: 104 }, { volume: 20 }]) {
    assert.throws(() => aggregateBtcHourlyCsv(incomplete, { officialDailyOverrides: [{ ...bar, ...update }] }), /contradicts/);
  }
  assert.throws(() => aggregateBtcHourlyCsv(csv([...rows, rows[23]]), { officialDailyOverrides: [bar] }), /hourly/);
});
test('snapshot must be retrieved after actual daily or 09:00 cycle completion and not in the future', () => {
  const now = Date.parse('2026-08-02T12:00:00Z');
  assert.doesNotThrow(() => validateCompletedSnapshot('2026-08-01', '2026-08-02T01:00:00Z', now));
  assert.throws(() => validateCompletedSnapshot('2026-08-01', '2026-08-01T23:59:59Z', now), /Snapshot/);
  assert.throws(() => validateCompletedSnapshot('2026-08-01', '2026-08-03T00:00:00Z', now), /Snapshot/);
  assert.throws(() => validateCompletedSnapshot('2026-08-02', '2026-08-02T00:59:59Z', now, true), /Snapshot/);
  assert.doesNotThrow(() => validateCompletedSnapshot('2026-08-02', '2026-08-02T01:00:00Z', now, true));
});
