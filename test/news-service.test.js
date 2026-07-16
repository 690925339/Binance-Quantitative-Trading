import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeHeadline, NewsService, parseNewsFeed } from '../src/news-service.js';

const NOW = Date.parse('2026-07-15T10:00:00.000Z');

function rss(items) {
  return `<?xml version="1.0"?><rss><channel>${items.map((item) => `
    <item><title><![CDATA[${item.title}]]></title><link>${item.url}</link><pubDate>${item.publishedAt}</pubDate></item>
  `).join('')}</channel></rss>`;
}

test('标题分析识别利多、利空、方向置信度和关联交易对', () => {
  const bullish = analyzeHeadline('SEC approves spot Bitcoin ETF as inflows surge');
  assert.equal(bullish.sentiment, 'bullish');
  assert.ok(bullish.confidence >= 70);
  assert.equal(bullish.positiveMatchCount, 3);
  assert.match(bullish.directionReason, /利多事件词/);
  assert.deepEqual(bullish.symbols, ['BTCUSDT']);

  const bearish = analyzeHeadline('Ethereum protocol hacked after critical exploit');
  assert.equal(bearish.sentiment, 'bearish');
  assert.ok(bearish.sentimentScore < 0);
  assert.equal(bearish.negativeMatchCount, 2);
  assert.deepEqual(bearish.symbols, ['ETHUSDT']);
});

test('RSS 解析只保留有效标题和 http 链接', () => {
  const items = parseNewsFeed(rss([{ title: 'Bitcoin rallies', url: 'https://example.com/a', publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT' }]), {
    id: 'test', name: 'Test Source', baseCredibility: 98, sourceTier: 'official', fixedSymbols: ['BTCUSDT'],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Bitcoin rallies');
  assert.equal(items[0].publishedAt, '2026-07-15T09:00:00.000Z');
  assert.equal(items[0].sourceTier, 'official');
  assert.deepEqual(items[0].fixedSymbols, ['BTCUSDT']);
});

test('新闻服务聚合多来源、提高交叉印证可信度并缓存结果', async () => {
  const title = 'SEC approves spot Bitcoin ETF as inflows surge';
  const feeds = [
    { id: 'one', name: 'Source One', url: 'https://one.test/rss', baseCredibility: 82 },
    { id: 'two', name: 'Source Two', url: 'https://two.test/rss', baseCredibility: 80 },
  ];
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return new Response(rss([{
      title,
      url: `${String(url).replace('/rss', '')}/story`,
      publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
    }]), { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };
  const service = new NewsService({ feeds, fetchImpl, now: () => NOW, cacheTtlMs: 60_000 });
  const first = await service.getNews();
  const second = await service.getNews();

  assert.equal(first.status, 'live');
  assert.equal(first.items.length, 1);
  assert.ok(first.items[0].credibility >= 86);
  assert.deepEqual(first.items[0].corroboratingSources, ['Source Two']);
  assert.equal(first.items[0].confirmationStatus, 'corroborated');
  assert.equal(first.summary.bySymbol.BTCUSDT.confirmedArticleCount, 0);
  assert.ok(first.summary.bySymbol.BTCUSDT.score > 0);
  assert.equal(second.updatedAt, first.updatedAt);
  assert.equal(calls, 2);
});

test('官方直发和匹配官方公告的媒体报道均标记为官方确认', async () => {
  const feeds = [
    { id: 'official', name: 'Official Authority', url: 'https://official.test/rss', baseCredibility: 98, sourceTier: 'official', fixedSymbols: ['BTCUSDT'] },
    { id: 'media', name: 'Media Desk', url: 'https://media.test/rss', baseCredibility: 82, sourceTier: 'media' },
  ];
  const fetchImpl = async (url) => new Response(rss([String(url).includes('official') ? {
    title: 'SEC approves spot Bitcoin exchange traded products',
    url: 'https://official.test/release',
    publishedAt: 'Wed, 15 Jul 2026 08:45:00 GMT',
  } : {
    title: 'SEC approves spot Bitcoin ETF products as market reacts',
    url: 'https://media.test/story',
    publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
  }]), { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  const result = await new NewsService({ feeds, fetchImpl, now: () => NOW }).getNews();
  const official = result.items.find((item) => item.sourceTier === 'official');
  const media = result.items.find((item) => item.sourceTier === 'media');

  assert.equal(official.confirmationStatus, 'confirmed');
  assert.deepEqual(official.officialSources, ['Official Authority']);
  assert.equal(media.confirmationStatus, 'confirmed');
  assert.deepEqual(media.officialSources, ['Official Authority']);
  assert.equal(result.summary.bySymbol.BTCUSDT.confirmedArticleCount, 2);
});

test('官方消息仍按发布主体、自述立场和不确定性评估可信度与方向', async () => {
  const feeds = [
    { id: 'regulator', name: 'Official Regulator', url: 'https://regulator.test/rss', baseCredibility: 98, sourceTier: 'official', sourceCategory: 'regulator' },
    { id: 'project', name: 'Official Project', url: 'https://project.test/rss', baseCredibility: 96, sourceTier: 'official', sourceCategory: 'project', fixedSymbols: ['BTCUSDT'] },
  ];
  const fetchImpl = async (url) => new Response(rss([String(url).includes('regulator') ? {
    title: 'SEC charges Bitcoin exchange with fraud',
    url: 'https://regulator.test/release',
    publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
  } : {
    title: 'Bitcoin project may launch partnership upgrade',
    url: 'https://project.test/release',
    publishedAt: 'Wed, 15 Jul 2026 09:15:00 GMT',
  }]), { status: 200 });
  const result = await new NewsService({ feeds, fetchImpl, now: () => NOW }).getNews();
  const regulator = result.items.find((item) => item.sourceCategory === 'regulator');
  const project = result.items.find((item) => item.sourceCategory === 'project');

  assert.equal(regulator.confirmationStatus, 'confirmed');
  assert.equal(regulator.sentiment, 'bearish');
  assert.equal(regulator.credibility, 98);
  assert.equal(regulator.evidenceStrength, 'strong');
  assert.equal(project.confirmationStatus, 'confirmed');
  assert.equal(project.sentiment, 'bullish');
  assert.equal(project.credibility, 76);
  assert.equal(project.evidenceStrength, 'weak');
  assert.match(project.credibilityReason, /项目自述/);
  assert.match(project.directionReason, /不确定性表达/);
});

test('单一媒体消息在没有官方匹配时保持待确认并降低可信度', async () => {
  const service = new NewsService({
    feeds: [{ id: 'media', name: 'Media Desk', url: 'https://media.test/rss', baseCredibility: 82, sourceTier: 'media' }],
    fetchImpl: async () => new Response(rss([{
      title: 'Bitcoin reportedly may launch a new feature',
      url: 'https://media.test/rumor',
      publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
    }]), { status: 200 }),
    now: () => NOW,
  });
  const result = await service.getNews();
  assert.equal(result.items[0].confirmationStatus, 'unconfirmed');
  assert.equal(result.items[0].credibility, 60);
  assert.equal(result.summary.bySymbol.BTCUSDT.confirmedArticleCount, 0);
});

test('全部新闻源失败时返回不可用状态而不是伪造新闻信号', async () => {
  const service = new NewsService({
    feeds: [{ id: 'bad', name: 'Bad Source', url: 'https://bad.test/rss', baseCredibility: 80 }],
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
    now: () => NOW,
  });
  const result = await service.getNews();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.items.length, 0);
  assert.equal(result.summary.bySymbol.BTCUSDT.score, 0);
});
