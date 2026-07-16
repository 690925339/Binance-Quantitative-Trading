import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFearGreedPayload } from '../scripts/download-fear-greed.mjs';

test('恐惧指数解析会校验范围、按日期排序并过滤非法值', () => {
  const result = parseFearGreedPayload({
    data: [
      { value: '80', value_classification: 'Extreme Greed', timestamp: String(Date.parse('2023-01-03T00:00:00Z') / 1000) },
      { value: '20', value_classification: 'Extreme Fear', timestamp: String(Date.parse('2023-01-01T00:00:00Z') / 1000) },
      { value: '101', value_classification: 'Invalid', timestamp: String(Date.parse('2023-01-02T00:00:00Z') / 1000) },
    ],
    metadata: { error: null },
  }, { startDate: '2023-01-01', endDate: '2023-01-03' });
  assert.deepEqual(result.map((item) => item.date), ['2023-01-01', '2023-01-03']);
  assert.equal(result[0].value, 20);
});

test('恐惧指数接口错误不会被当作空数据继续使用', () => {
  assert.throws(
    () => parseFearGreedPayload({ data: [], metadata: { error: 'rate limited' } }),
    /恐惧指数接口错误/,
  );
});
