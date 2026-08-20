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
  assert.equal(bullish.positiveMatchCount, 2);
  assert.match(bullish.directionReason, /利多事件词/);
  assert.deepEqual(bullish.symbols, ['BTCUSDT']);

  const bearish = analyzeHeadline('Ethereum protocol hacked after critical exploit');
  assert.equal(bearish.sentiment, 'bearish');
  assert.ok(bearish.sentimentScore < 0);
  assert.equal(bearish.negativeMatchCount, 2);
  assert.deepEqual(bearish.symbols, ['ETHUSDT']);
});

test('币价下跌和避险资产上冲不会被 surge 误判为利多', () => {
  const result = analyzeHeadline('Bitcoin slides below $65K as Iran conflict fuels oil and bond-yield surge');
  assert.equal(result.sentiment, 'bearish');
  assert.ok(result.sentimentScore < 0);
  assert.ok(result.negativeMatchCount >= 2);
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
  assert.equal(first.items[0].eventArticleCount, 2);
  assert.deepEqual(first.items[0].eventSourceIds, ['one', 'two']);
  assert.equal(first.items[0].directionConsistentSourceCount, 2);
  assert.equal(first.items[0].directionCorroborated, true);
  assert.equal(first.summary.bySymbol.BTCUSDT.confirmedArticleCount, 0);
  assert.ok(first.summary.bySymbol.BTCUSDT.score > 0);
  assert.deepEqual(first.summary.bySymbol.BTCUSDT.directionalEvidence.bullish, {
    uniqueEventCount: 1,
    confirmedEventCount: 0,
    corroboratedEventCount: 1,
    independentSourceCount: 2,
  });
  assert.equal(second.updatedAt, first.updatedAt);
  assert.equal(calls, 2);
});

test('同一来源的相似报道按一个事件去重但不构成独立来源印证', async () => {
  const feeds = [
    { id: 'single', name: 'Single Desk', url: 'https://single.test/rss', baseCredibility: 82, sourceTier: 'media' },
  ];
  const result = await new NewsService({
    feeds,
    fetchImpl: async () => new Response(rss([
      {
        title: 'Bitcoin ETF approval drives record inflows',
        url: 'https://single.test/first',
        publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
      },
      {
        title: 'Bitcoin ETF approval drives fresh inflows',
        url: 'https://single.test/second',
        publishedAt: 'Wed, 15 Jul 2026 09:15:00 GMT',
      },
    ]), { status: 200 }),
    now: () => NOW,
  }).getNews();
  const summary = result.summary.bySymbol.BTCUSDT;

  assert.equal(result.items.length, 2);
  assert.equal(new Set(result.items.map((item) => item.eventId)).size, 1);
  assert.ok(result.items.every((item) => item.eventArticleCount === 2));
  assert.ok(result.items.every((item) => item.directionConsistentSourceCount === 1));
  assert.ok(result.items.every((item) => item.directionCorroborated === false));
  assert.deepEqual(summary.directionalEvidence.bullish, {
    uniqueEventCount: 1,
    confirmedEventCount: 0,
    corroboratedEventCount: 0,
    independentSourceCount: 1,
  });
});

test('事件聚类要求12小时窗口且显式标的相交', async () => {
  const feeds = [
    { id: 'btc-now', name: 'BTC Now', url: 'https://btc-now.test/rss', baseCredibility: 82, sourceTier: 'media' },
    { id: 'eth-now', name: 'ETH Now', url: 'https://eth-now.test/rss', baseCredibility: 82, sourceTier: 'media' },
    { id: 'btc-old', name: 'BTC Old', url: 'https://btc-old.test/rss', baseCredibility: 82, sourceTier: 'media' },
  ];
  const stories = {
    'btc-now': {
      title: 'Bitcoin ETF market approval drives inflows',
      url: 'https://btc-now.test/story',
      publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
    },
    'eth-now': {
      title: 'Ethereum ETF market approval drives inflows',
      url: 'https://eth-now.test/story',
      publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
    },
    'btc-old': {
      title: 'Bitcoin ETF market approval drives record inflows',
      url: 'https://btc-old.test/story',
      publishedAt: 'Tue, 14 Jul 2026 20:00:00 GMT',
    },
  };
  const result = await new NewsService({
    feeds,
    fetchImpl: async (url) => {
      const id = new URL(url).hostname.split('.')[0];
      return new Response(rss([stories[id]]), { status: 200 });
    },
    now: () => NOW,
  }).getNews();

  assert.equal(result.items.length, 3);
  assert.equal(new Set(result.items.map((item) => item.eventId)).size, 3);
  assert.equal(result.summary.overall.directionalEvidence.bullish.uniqueEventCount, 3);
  assert.equal(result.summary.overall.directionalEvidence.bullish.corroboratedEventCount, 0);
});

test('相似事件中的反向媒体判断和中性官方消息不会伪造方向一致确认', async () => {
  const feeds = [
    { id: 'official', name: 'Official Desk', url: 'https://official.test/rss', baseCredibility: 98, sourceTier: 'official', sourceCategory: 'regulator', fixedSymbols: ['BTCUSDT'] },
    { id: 'bull', name: 'Bull Desk', url: 'https://bull.test/rss', baseCredibility: 82, sourceTier: 'media' },
    { id: 'bear', name: 'Bear Desk', url: 'https://bear.test/rss', baseCredibility: 82, sourceTier: 'media' },
  ];
  const stories = {
    official: {
      title: 'Bitcoin ETF market security update report',
      url: 'https://official.test/report',
      publishedAt: 'Wed, 15 Jul 2026 08:50:00 GMT',
    },
    bull: {
      title: 'Bitcoin ETF market security update approval drives inflows',
      url: 'https://bull.test/story',
      publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
    },
    bear: {
      title: 'Bitcoin ETF market security update after fraud investigation',
      url: 'https://bear.test/story',
      publishedAt: 'Wed, 15 Jul 2026 09:05:00 GMT',
    },
  };
  const result = await new NewsService({
    feeds,
    fetchImpl: async (url) => {
      const id = new URL(url).hostname.split('.')[0];
      return new Response(rss([stories[id]]), { status: 200 });
    },
    now: () => NOW,
  }).getNews();
  const directionalItems = result.items.filter((item) => item.sentiment !== 'neutral');
  const evidence = result.summary.bySymbol.BTCUSDT.directionalEvidence;

  assert.equal(new Set(result.items.map((item) => item.eventId)).size, 1);
  assert.ok(directionalItems.every((item) => item.confirmationStatus === 'confirmed'));
  assert.ok(directionalItems.every((item) => item.directionConfirmed === false));
  assert.ok(directionalItems.every((item) => item.directionCorroborated === false));
  assert.equal(evidence.bullish.confirmedEventCount, 0);
  assert.equal(evidence.bullish.corroboratedEventCount, 0);
  assert.equal(evidence.bearish.confirmedEventCount, 0);
  assert.equal(evidence.bearish.corroboratedEventCount, 0);
});

test('超过72小时的旧消息保留旧计数字段但不进入方向事件证据', async () => {
  const result = await new NewsService({
    feeds: [{
      id: 'official-old',
      name: 'Official Old',
      url: 'https://old.test/rss',
      baseCredibility: 98,
      sourceTier: 'official',
      sourceCategory: 'regulator',
      fixedSymbols: ['BTCUSDT'],
    }],
    fetchImpl: async () => new Response(rss([{
      title: 'Bitcoin ETF approval drives record inflows',
      url: 'https://old.test/release',
      publishedAt: 'Sat, 11 Jul 2026 09:00:00 GMT',
    }]), { status: 200 }),
    now: () => NOW,
  }).getNews();
  const summary = result.summary.bySymbol.BTCUSDT;

  assert.equal(summary.articleCount, 1);
  assert.equal(summary.confirmedArticleCount, 1);
  assert.equal(summary.scoredArticleCount, 0);
  assert.deepEqual(summary.directionalEvidence.bullish, {
    uniqueEventCount: 0,
    confirmedEventCount: 0,
    corroboratedEventCount: 0,
    independentSourceCount: 0,
  });
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

test('标的专属摘要排除只有泛市场关联的新闻', async () => {
  const feeds = [
    { id: 'regulator', name: 'Official Regulator', url: 'https://regulator.test/rss', baseCredibility: 98, sourceTier: 'official', sourceCategory: 'regulator' },
    { id: 'bitcoin', name: 'Bitcoin Project', url: 'https://bitcoin.test/rss', baseCredibility: 96, sourceTier: 'official', sourceCategory: 'project', fixedSymbols: ['BTCUSDT'] },
  ];
  const fetchImpl = async (url) => new Response(rss([String(url).includes('regulator') ? {
    title: 'SEC charges crypto exchange with fraud',
    url: 'https://regulator.test/release',
    publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
  } : {
    title: 'Bitcoin protocol upgrade launches',
    url: 'https://bitcoin.test/release',
    publishedAt: 'Wed, 15 Jul 2026 09:05:00 GMT',
  }]), { status: 200 });
  const result = await new NewsService({ feeds, fetchImpl, now: () => NOW }).getNews();
  const summary = result.summary.bySymbol.BTCUSDT;

  assert.equal(summary.articleCount, 2);
  assert.equal(summary.symbolSpecificArticleCount, 1);
  assert.equal(summary.symbolSpecificConfirmedArticleCount, 1);
  assert.ok(summary.symbolSpecificScore > 0);
  assert.ok(summary.score < summary.symbolSpecificScore);
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

test('forceRefresh 可以绕过不可用结果缓存重新抓取新闻', async () => {
  let calls = 0;
  const service = new NewsService({
    feeds: [{ id: 'retry', name: 'Retry Source', url: 'https://retry.test/rss', baseCredibility: 82 }],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('unavailable', { status: 503 });
      return new Response(rss([{
        title: 'Bitcoin ETF approval drives inflows',
        url: 'https://retry.test/story',
        publishedAt: 'Wed, 15 Jul 2026 09:00:00 GMT',
      }]), { status: 200 });
    },
    now: () => NOW,
    cacheTtlMs: 60_000,
  });

  const unavailable = await service.getNews();
  const cached = await service.getNews();
  const refreshed = await service.getNews({ forceRefresh: true });

  assert.equal(unavailable.status, 'unavailable');
  assert.equal(cached.status, 'unavailable');
  assert.equal(refreshed.status, 'live');
  assert.equal(refreshed.items.length, 1);
  assert.equal(calls, 2);
});

test('发布时间晚于抓取时点的新闻不会进入当时快照', async () => {
  const service = new NewsService({
    feeds: [{ id: 'future', name: 'Future Feed', url: 'https://future.test/rss', baseCredibility: 98, sourceTier: 'official' }],
    fetchImpl: async () => new Response(rss([{
      title: 'SEC approves spot Bitcoin ETF',
      url: 'https://future.test/release',
      publishedAt: 'Wed, 15 Jul 2026 11:00:00 GMT',
    }]), { status: 200 }),
    now: () => NOW,
  });
  const result = await service.getNews();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.items.length, 0);
});
