import assert from 'node:assert/strict';
import test from 'node:test';
import { NewsService } from '../src/news-service.js';

const feeds = [{ id: 'one', name: 'one', url: 'https://one.test/rss', baseCredibility: 80 }];
const xml = '<rss><channel><item><title>Bitcoin ETF approval</title><link>https://one.test/a</link><pubDate>Sat, 05 Sep 2026 01:00:00 GMT</pubDate></item></channel></rss>';
const options = { feeds, now: () => Date.parse('2026-09-05T01:05:00Z'), retryDelayMs: 0 };

test('瞬时超时后恢复新闻来源，并记录两次尝试', async () => {
  let calls = 0;
  const service = new NewsService({ ...options, fetchImpl: async () => {
    if (++calls === 1) throw new DOMException('timeout', 'TimeoutError');
    return new Response(xml);
  } });
  const result = await service.getNews();
  assert.equal(result.status, 'live');
  assert.equal(result.sourceStatus[0].attempts, 2);
  assert.equal(result.items.length, 1);
  await service.getNews();
  assert.equal(calls, 2);
});

test('持久超时最多两次，不把旧新闻伪装为实时新闻', async () => {
  let calls = 0;
  const service = new NewsService({ ...options, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return new Response(xml);
    throw new DOMException('timeout', 'TimeoutError');
  } });
  const first = await service.getNews();
  const result = await service.getNews({ forceRefresh: true });
  assert.equal(calls, 3);
  assert.equal(result.status, 'stale');
  assert.equal(result.updatedAt, first.updatedAt);
  assert.equal(result.sourceStatus[0].ok, false);
  assert.equal(result.sourceStatus[0].attempts, 2);
});

test('HTTP 403和429不会立即重复请求', async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    const result = await new NewsService({ ...options, fetchImpl: async () => {
      calls += 1;
      return new Response('', { status });
    } }).getNews();
    assert.equal(calls, 1);
    assert.equal(result.status, 'unavailable');
  }
});
