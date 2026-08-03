const TESTNET_API_BASE = 'https://testnet.binance.vision';
const NEWS_FEEDS = [
  { name: '美国 SEC', url: 'https://www.sec.gov/news/pressreleases.rss', credibility: 98, tier: 'official' },
  { name: 'Bitcoin Core', url: 'https://github.com/bitcoin/bitcoin/releases.atom', credibility: 96, tier: 'official', symbols: ['BTCUSDT'] },
  { name: 'Ethereum Foundation', url: 'https://blog.ethereum.org/feed.xml', credibility: 96, tier: 'official', symbols: ['ETHUSDT'] },
  { name: 'BNB Chain', url: 'https://github.com/bnb-chain/bsc/releases.atom', credibility: 96, tier: 'official', symbols: ['BNBUSDT'] },
  { name: 'Solana Status', url: 'https://status.solana.com/history.atom', credibility: 98, tier: 'official', symbols: ['SOLUSDT'] },
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', credibility: 84, tier: 'media' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', credibility: 80, tier: 'media' },
];
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
const POSITIVE = /approve|approval|adopt|launch|partner|upgrade|inflow|rally|breakout|recovery|bullish|获批|批准|采用|上线|合作|升级|资金流入|上涨|反弹/gi;
const NEGATIVE = /hack|exploit|breach|ban|lawsuit|charge|liquidat|outage|bankrupt|fraud|investigat|reject|delist|outflow|sell.?off|crash|bearish|slide|slump|drop|fall|tumble|plunge|decline|黑客|漏洞|攻击|被盗|禁止|诉讼|指控|清算|宕机|破产|欺诈|调查|拒绝|下架|资金流出|暴跌|利空/gi;
let schemaReady;
let newsCache;

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  return json({ error: status < 500 ? error.message : '服务器暂时不可用', code: error?.code || null }, status);
}

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!SYMBOLS.includes(symbol)) throw httpError('当前不支持该交易对');
  return symbol;
}

function countMatches(value, pattern) {
  return [...String(value || '').matchAll(pattern)].length;
}

function escapeXml(value = '') {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match) return escapeXml(match[1]);
  }
  return '';
}

function itemSymbols(title, fixedSymbols = []) {
  if (fixedSymbols.length) return fixedSymbols;
  const text = String(title || '').toLowerCase();
  const matches = [
    ['BTCUSDT', /bitcoin|\bbtc\b/], ['ETHUSDT', /ethereum|\beth\b|ether/],
    ['BNBUSDT', /binance coin|bnb chain|\bbnb\b/], ['SOLUSDT', /solana|\bsol\b/],
    ['XRPUSDT', /ripple|\bxrp\b/], ['DOGEUSDT', /dogecoin|\bdoge\b/],
  ].filter(([, expression]) => expression.test(text)).map(([symbol]) => symbol);
  return matches.length ? matches : ['MARKET'];
}

function analyzeNewsItem(raw, source) {
  const positive = countMatches(raw.title, POSITIVE);
  const negative = countMatches(raw.title, NEGATIVE);
  const score = positive === negative ? 0 : Math.sign(positive - negative) * Math.min(1, 0.45 + Math.abs(positive - negative) * 0.18);
  const sentiment = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
  const confidence = score === 0 ? 42 : Math.min(94, 58 + Math.abs(positive - negative) * 9);
  const official = source.tier === 'official';
  return {
    id: `${source.name}:${raw.url || raw.title}`.slice(0, 240),
    title: raw.title,
    url: raw.url,
    publishedAt: raw.publishedAt,
    source: source.name,
    sourceTier: source.tier,
    sourceCategory: official ? 'project' : 'media',
    symbols: itemSymbols(raw.title, source.symbols || []),
    sentiment,
    sentimentLabel: sentiment === 'bullish' ? '利多' : sentiment === 'bearish' ? '利空' : '中性',
    sentimentScore: score,
    confidence,
    credibility: source.credibility,
    credibilityLabel: source.credibility >= 90 ? '高' : source.credibility >= 75 ? '中高' : '中',
    evidenceStrength: official ? 'strong' : 'weak',
    evidenceStrengthLabel: official ? '强' : '弱',
    confirmationStatus: official ? 'confirmed' : 'unconfirmed',
    confirmationLabel: official ? '官方确认' : '待确认',
    confirmationReason: official ? `来自${source.name}官方发布` : '尚未匹配官方发布或独立媒体交叉来源',
    credibilityReason: official ? '官方原始发布，作为可追溯一手来源处理' : '单一媒体线索，未进入方向交易权重',
    directionReason: score === 0 ? '标题未识别到明确的利多或利空事件词' : `标题识别到 ${positive} 个利多词和 ${negative} 个利空词`,
  };
}

function parseFeed(xml, source) {
  const blocks = [...(xml.match(/<item\b[\s\S]*?<\/item>/gi) || []), ...(xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [])];
  return blocks.map((block) => {
    const atomLink = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || '';
    const title = tagValue(block, ['title']);
    const url = tagValue(block, ['link', 'guid']) || atomLink;
    const published = tagValue(block, ['pubDate', 'published', 'updated', 'dc:date']);
    const publishedAt = Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null;
    return title && /^https?:/i.test(url) ? analyzeNewsItem({ title, url, publishedAt }, source) : null;
  }).filter(Boolean);
}

function newsSummary(items, symbol) {
  const relevant = items.filter((item) => symbol === 'MARKET' || item.symbols.includes(symbol) || item.symbols.includes('MARKET'));
  const weighted = relevant.filter((item) => item.confirmationStatus === 'confirmed');
  const denominator = weighted.reduce((sum, item) => sum + item.confidence * item.credibility, 0);
  const score = denominator ? weighted.reduce((sum, item) => sum + item.sentimentScore * item.confidence * item.credibility, 0) / denominator : 0;
  const credibility = denominator ? Math.round(weighted.reduce((sum, item) => sum + item.credibility * item.confidence * item.credibility, 0) / denominator) : 0;
  const confidence = denominator ? Math.round(weighted.reduce((sum, item) => sum + item.confidence * item.confidence * item.credibility, 0) / denominator) : 0;
  return {
    score: Number(score.toFixed(4)),
    direction: score > 0.12 ? 'bullish' : score < -0.12 ? 'bearish' : 'neutral',
    label: score > 0.12 ? '偏利多' : score < -0.12 ? '偏利空' : '中性',
    credibility,
    confidence,
    articleCount: relevant.length,
    scoredArticleCount: weighted.length,
    confirmedArticleCount: weighted.length,
    confirmedAssessments: weighted.map((item) => ({ credibility: item.credibility, confidence: item.confidence, evidenceStrength: item.evidenceStrength, sentiment: item.sentiment })),
    corroboratedArticleCount: 0,
    unconfirmedArticleCount: relevant.filter((item) => item.confirmationStatus === 'unconfirmed').length,
    confirmationRate: relevant.length ? Math.round(weighted.length / relevant.length * 100) : 0,
  };
}

async function getNews() {
  if (newsCache && Date.now() - newsCache.fetchedAt < 60_000) return newsCache.payload;
  const results = await Promise.allSettled(NEWS_FEEDS.map(async (source) => {
    const response = await fetch(source.url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { source, items: parseFeed((await response.text()).slice(0, 2_000_000), source) };
  }));
  const sourceStatus = results.map((result, index) => ({
    source: NEWS_FEEDS[index].name,
    sourceTier: NEWS_FEEDS[index].tier,
    sourceCategory: NEWS_FEEDS[index].tier === 'official' ? 'project' : 'media',
    ok: result.status === 'fulfilled',
    count: result.status === 'fulfilled' ? result.value.items.length : 0,
    error: result.status === 'rejected' ? result.reason.message : null,
  }));
  const deduped = new Map();
  results.filter((result) => result.status === 'fulfilled').flatMap((result) => result.value.items).forEach((item) => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    if (!deduped.has(key) || deduped.get(key).credibility < item.credibility) deduped.set(key, item);
  });
  const items = [...deduped.values()].filter((item) => !item.publishedAt || Date.now() - Date.parse(item.publishedAt) < 7 * 86_400_000)
    .sort((left, right) => Date.parse(right.publishedAt || 0) - Date.parse(left.publishedAt || 0)).slice(0, 50);
  const payload = {
    status: items.length ? 'live' : 'unavailable', updatedAt: new Date().toISOString(), refreshAfterSeconds: 60, sourceStatus, items,
    summary: { overall: newsSummary(items, 'MARKET'), bySymbol: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, newsSummary(items, symbol)])) },
  };
  newsCache = { fetchedAt: Date.now(), payload };
  return payload;
}

async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS strategy_records (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_strategy_records_updated_at ON strategy_records(updated_at DESC)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS runtime_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)'),
    ]).then(() => undefined).catch((error) => { schemaReady = undefined; throw error; });
  }
  await schemaReady;
}

async function seededJson(request, env, name, fallback) {
  const response = await env.ASSETS.fetch(new Request(new URL(`/seed/${name}.json`, request.url)));
  if (!response.ok) return fallback;
  return response.json();
}

async function readState(request, env, key, seedName, fallback) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT payload FROM runtime_state WHERE state_key = ?').bind(key).first();
  if (row?.payload) return JSON.parse(row.payload);
  const seeded = await seededJson(request, env, seedName, fallback);
  await env.DB.prepare('INSERT OR REPLACE INTO runtime_state (state_key, payload, updated_at) VALUES (?, ?, ?)')
    .bind(key, JSON.stringify(seeded), new Date().toISOString()).run();
  return seeded;
}

async function catalog(request, env) {
  return seededJson(request, env, 'strategy-catalog', { strategies: [], symbols: SYMBOLS.map((value) => ({ value, label: value })) });
}

function genericRisk(config = {}) {
  const leverage = Math.min(125, Math.max(1, Number(config.leverage) || 1));
  const margin = Math.max(0, Number(config.marginBudget ?? config.maxInvestment ?? config.orderAmount) || 0);
  const maximum = Math.round(margin * leverage * 100) / 100;
  return { estimatedMaxInvestment: margin, estimatedMaxExposure: maximum, leverage, metrics: [{ label: '杠杆倍数', value: leverage, unit: '×' }, { label: '最大名义敞口', value: maximum, unit: 'USDT' }], warnings: ['线上版本仅用于策略配置、行情与模拟盘观察，不会自动下单。'] };
}

async function parseBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 16_384) throw httpError('请求内容过大', 413);
  try { return await request.json(); } catch { throw httpError('请求 JSON 格式无效'); }
}

async function listStrategies(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare('SELECT payload FROM strategy_records ORDER BY updated_at DESC').all();
  return results.map((row) => JSON.parse(row.payload));
}

async function createStrategy(request, env) {
  const input = await parseBody(request);
  const type = String(input.type || '').trim();
  const name = String(input.name || '').trim();
  const symbol = validSymbol(input.symbol);
  if (!type || name.length < 2 || name.length > 40) throw httpError('策略名称需为 2 到 40 个字符');
  const now = new Date().toISOString();
  const strategy = { id: crypto.randomUUID(), type, name, symbol, enabled: false, config: input.config || {}, riskSummary: genericRisk(input.config), createdAt: now, updatedAt: now };
  await ensureSchema(env);
  await env.DB.prepare('INSERT INTO strategy_records (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(strategy.id, JSON.stringify(strategy), now, now).run();
  return strategy;
}

async function updateStrategy(request, env, id, patch) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT payload FROM strategy_records WHERE id = ?').bind(id).first();
  if (!row?.payload) throw httpError('策略不存在', 404);
  const prior = JSON.parse(row.payload);
  const next = { ...prior, ...patch, id: prior.id, enabled: patch.enabled ?? prior.enabled, updatedAt: new Date().toISOString() };
  next.name = String(next.name || '').trim();
  next.symbol = validSymbol(next.symbol);
  if (next.name.length < 2 || next.name.length > 40) throw httpError('策略名称需为 2 到 40 个字符');
  next.riskSummary = genericRisk(next.config);
  await env.DB.prepare('UPDATE strategy_records SET payload = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(next), next.updatedAt, id).run();
  return next;
}

async function market(symbol) {
  const base = new URL(TESTNET_API_BASE);
  const tickerUrl = new URL('/api/v3/ticker/24hr', base); tickerUrl.searchParams.set('symbol', symbol);
  const klinesUrl = new URL('/api/v3/klines', base); klinesUrl.search = new URLSearchParams({ symbol, interval: '15m', limit: '60' }).toString();
  const [tickerResponse, klinesResponse] = await Promise.all([fetch(tickerUrl), fetch(klinesUrl)]);
  if (!tickerResponse.ok || !klinesResponse.ok) throw Object.assign(new Error('无法连接 Binance 测试网'), { status: 502 });
  const [ticker, klines] = await Promise.all([tickerResponse.json(), klinesResponse.json()]);
  return { symbol, ticker: { lastPrice: ticker.lastPrice, priceChangePercent: ticker.priceChangePercent, highPrice: ticker.highPrice, lowPrice: ticker.lowPrice, quoteVolume: ticker.quoteVolume }, candles: klines.map((item) => ({ time: item[0], open: item[1], high: item[2], low: item[3], close: item[4], volume: item[5] })) };
}

async function compositeSignals(symbol) {
  const [liveMarket, news] = await Promise.all([market(symbol), getNews()]);
  const closes = liveMarket.candles.map((item) => Number(item.close));
  const tail = closes.slice(-20); const baseline = tail.reduce((sum, value) => sum + value, 0) / Math.max(1, tail.length);
  const priceScore = Math.max(-1, Math.min(1, (closes.at(-1) - baseline) / baseline * 12));
  const summary = news.summary.bySymbol[symbol];
  const newsEligible = summary.credibility >= 75 && summary.confidence >= 65 && summary.confirmedArticleCount >= 1 && Math.abs(summary.score) >= 0.12;
  const profiles = [
    { strategyType: 'stableComposite', strategyName: '稳健价格＋新闻组合', pricePercent: 75, newsPercent: 25, max: 125, target: 45 },
    { strategyType: 'aggressiveComposite', strategyName: '进攻价格＋新闻组合', pricePercent: 55, newsPercent: 45, max: 200, target: 75 },
  ];
  return { symbol, updatedAt: new Date().toISOString(), priceSignal: priceScore, newsSummary: summary, accuracyTracking: { horizonHours: 168, recorded: false, settledCount: 0 }, strategies: profiles.map((profile) => {
    const combinedScore = priceScore * profile.pricePercent / 100 + (newsEligible ? summary.score * profile.newsPercent / 100 : 0);
    const action = combinedScore > 0.08 ? 'BUY' : combinedScore < -0.08 ? 'SELL' : 'HOLD';
    return { ...profile, action, actionLabel: action === 'BUY' ? '偏多观察' : action === 'SELL' ? '偏空观察' : '观望', combinedScore, priceScore, newsScore: summary.score, newsEligible, appliedWeights: { pricePercent: newsEligible ? profile.pricePercent : 100, newsPercent: newsEligible ? profile.newsPercent : 0 }, newsGate: { qualifiedConfirmedArticleCount: summary.confirmedArticleCount, minimumConfirmedArticles: 1, minimumCredibility: 75, minimumConfidence: 65 }, risk: { targetGrossExposurePercent: profile.target, effectiveMaxGrossExposurePercent: profile.max, maxLeverage: 3, accuracyLeverage: profile.strategyType === 'stableComposite' ? { eligible: false, accuracy: 0, settledSignalCount: 0, minimumSamples: 100 } : null, appliedLeverage: 1 } };
  }) };
}

async function api(request, env, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ status: 'ok', environment: 'sites-research-worker', executionMode: 'RESEARCH_ONLY' });
  if (request.method === 'GET' && url.pathname === '/api/market') return json(await market(validSymbol(url.searchParams.get('symbol') || 'BTCUSDT')));
  if (request.method === 'GET' && url.pathname === '/api/news') return json(await getNews());
  if (request.method === 'GET' && url.pathname === '/api/composite-signals') return json(await compositeSignals(validSymbol(url.searchParams.get('symbol') || 'BTCUSDT')));
  if (request.method === 'GET' && url.pathname === '/api/strategies/catalog') {
    const value = await catalog(request, env);
    return json({ executionMode: 'CONFIG_ONLY', warning: '线上版本仅用于观察、配置与模拟盘，不会自动下单，也不会接收 API Secret。', symbols: value.symbols, strategies: value.strategies });
  }
  if (request.method === 'GET' && url.pathname === '/api/strategies') return json({ strategies: await listStrategies(env) });
  if (request.method === 'POST' && url.pathname === '/api/strategies') return json({ strategy: await createStrategy(request, env) }, 201);
  const strategyMatch = url.pathname.match(/^\/api\/strategies\/([a-f0-9-]+)$/);
  if (strategyMatch && request.method === 'PUT') return json({ strategy: await updateStrategy(request, env, strategyMatch[1], await parseBody(request)) });
  if (strategyMatch && request.method === 'PATCH') {
    const body = await parseBody(request);
    if (typeof body.enabled !== 'boolean') throw httpError('启停状态无效');
    return json({ strategy: await updateStrategy(request, env, strategyMatch[1], { enabled: body.enabled }) });
  }
  if (strategyMatch && request.method === 'DELETE') {
    await ensureSchema(env);
    const result = await env.DB.prepare('DELETE FROM strategy_records WHERE id = ?').bind(strategyMatch[1]).run();
    if (!result.meta.changes) throw httpError('策略不存在', 404);
    return json({ deleted: true });
  }
  const cloneMatch = url.pathname.match(/^\/api\/strategies\/([a-f0-9-]+)\/clone$/);
  if (cloneMatch && request.method === 'POST') {
    await ensureSchema(env);
    const row = await env.DB.prepare('SELECT payload FROM strategy_records WHERE id = ?').bind(cloneMatch[1]).first();
    if (!row?.payload) throw httpError('策略不存在', 404);
    const source = JSON.parse(row.payload);
    return json({ strategy: await createStrategy(new Request(request.url, { method: 'POST', body: JSON.stringify({ ...source, name: `${source.name} 副本`, enabled: false }) }), env) }, 201);
  }
  if (request.method === 'GET' && url.pathname === '/api/paper-portfolio') return json(await readState(request, env, 'paper-portfolio', 'paper-portfolio', { status: 'not_started', reports: [], positions: [] }));
  if (request.method === 'GET' && url.pathname === '/api/paper-portfolio/review') return json(await readState(request, env, 'paper-review', 'paper-review', { status: 'not_started', candidates: [] }));
  if (request.method === 'GET' && url.pathname === '/api/paper-portfolio/reports') {
    const limit = Number(url.searchParams.get('limit') || 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 365) throw httpError('日报数量必须在 1 到 365 之间');
    const paper = await readState(request, env, 'paper-portfolio', 'paper-portfolio', { reports: [] });
    return json({ reports: (paper.reports || []).slice(-limit).reverse() });
  }
  if (request.method === 'GET' && url.pathname === '/api/session') {
    return json({ connected: false, apiKeyHint: null, environment: '云端研究版：不接收 API Key 或 Secret' });
  }
  if (url.pathname === '/api/session' || url.pathname === '/api/account' || url.pathname === '/api/orders/test') {
    return json({ error: '云端研究版不接收 API Key 或 Secret；测试网账户连接和订单校验仅在本地版提供。' }, 403);
  }
  return json({ error: '接口不存在' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      const response = await env.ASSETS.fetch(request);
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...securityHeaders() } });
    } catch (error) {
      return errorResponse(error);
    }
  },
};
