import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';
import { downloadSymbol, inspectKlines, parseUtcDate } from '../scripts/download-market-data.mjs';

function kline(openTime, interval = 3_600_000, close = '100') {
  return [
    openTime, '99', '102', '98', close, '10', openTime + interval - 1,
    '1000', 12, '5', '500', '0',
  ];
}

test('UTC 日期按自然日起点解析', () => {
  assert.equal(parseUtcDate('2023-01-01'), 1_672_531_200_000);
  assert.equal(new Date(parseUtcDate('2023-01-01', true)).toISOString(), '2023-01-01T23:59:59.999Z');
});

test('质量检查识别时间缺口、重复和非法 OHLC', () => {
  const rows = [kline(0), kline(3_600_000), kline(3_600_000), kline(10_800_000)];
  rows[3][2] = '90';
  const quality = inspectKlines(rows, 3_600_000);
  assert.equal(quality.duplicates, 1);
  assert.equal(quality.gaps, 1);
  assert.equal(quality.invalidOhlc, 1);
  assert.deepEqual(quality.gapRanges, [{
    fromOpenTimeUtc: '1970-01-01T02:00:00.000Z',
    toOpenTimeUtc: '1970-01-01T02:00:00.000Z',
    missingCandles: 1,
  }]);
});

test('下载器分页、过滤未收盘 K 线并生成 UTF-8 CSV', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quantflow-data-'));
  const pages = [
    [kline(0), kline(3_600_000)],
    [kline(7_200_000), kline(10_800_000)],
  ];
  let call = 0;
  const fetchImpl = async () => new Response(JSON.stringify(pages[call++] || []), {
    headers: { 'content-type': 'application/json' },
  });

  const result = await downloadSymbol({
    symbol: 'BTCUSDT',
    interval: '1h',
    startTime: 0,
    endTime: 10_799_999,
    outputDir,
    fetchImpl,
  });

  assert.equal(result.rows, 2);
  assert.equal(result.quality.gaps, 0);
  const csv = await fs.readFile(path.join(outputDir, 'BTCUSDT-1h.csv'), 'utf8');
  assert.match(csv, /^symbol,interval,open_time/);
  assert.match(csv, /1970-01-01T00:00:00.000Z/);
});
