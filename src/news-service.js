import crypto from 'node:crypto';

const HOUR_MS = 3_600_000;
const OFFICIAL_CRYPTO_PATTERN = /\b(?:bitcoin|btc|ethereum|ether|eth|bnb|solana|sol|xrp|ripple|dogecoin|doge|crypto(?:currency| asset)?|digital asset|blockchain|stablecoin|tokeni[sz](?:e|ed|ation)|exchange[- ]traded (?:fund|product)|spot etf)\b/i;
const UNCERTAINTY_PATTERN = /\?$|\b(?:may|might|could|reportedly|rumor|plans?|expects?|targets?)\b|或将|可能|传闻|计划|预计|目标/i;
const PROJECT_SELF_INTEREST_PATTERN = /\b(?:partner(?:s|ed|ship)?|adopt(?:s|ed|ion)?|launch(?:es|ed)?|record|milestone|growth|ecosystem|breakthrough)\b|合作|采用|上线|创纪录|里程碑|增长|生态|突破/i;
const MACRO_RISK_PATTERN = /\b(?:war|armed conflict|missile|sanctions?|tariffs?|recession|sovereign default)\b|战争|武装冲突|导弹|制裁|关税|衰退|主权违约/i;
const RISK_OFF_SURGE_PATTERN = /\b(?:oil|crude|bond[- ]yield|treasury yields?|dollar|dxy)\b.{0,32}\b(?:surge[sd]?|spike[sd]?|jump(?:s|ed)?|soar(?:s|ed)?)\b/i;
const SYMBOL_PATTERNS = {
  BTCUSDT: /\b(?:btc|bitcoin)\b/i,
  ETHUSDT: /\b(?:eth|ethereum|ether)\b/i,
  BNBUSDT: /\b(?:bnb|binance coin|bnb chain)\b/i,
  SOLUSDT: /\b(?:sol|solana)\b/i,
  XRPUSDT: /\b(?:xrp|ripple)\b/i,
  DOGEUSDT: /\b(?:doge|dogecoin)\b/i,
};

const POSITIVE_PATTERNS = [
  /\b(?:approve[sd]?|approval|authoriz(?:e|ed|ation)|adopt(?:s|ed|ion)|launch(?:es|ed)?|partner(?:s|ed|ship)|upgrade[sd]?)\b/gi,
  /\b(?:record (?:high|inflow)|all[- ]time high|inflows?|rall(?:y|ies|ied)|breakout|recovery|bullish)\b/gi,
  /获批|批准|采用|上线|合作|升级|创下新高|资金流入|上涨|反弹|利多/g,
];

const NEGATIVE_PATTERNS = [
  /\b(?:hack(?:ed|s)?|exploit(?:ed|s)?|breach(?:ed)?|ban(?:ned|s)?|lawsuit|sue[sd]?|charges?)\b/gi,
  /\b(?:liquidat(?:e|ed|ion)s?|outages?|bankrupt(?:cy)?|fraud|investigat(?:e|ed|ion)|reject(?:s|ed|ion))\b/gi,
  /\b(?:delist(?:s|ed|ing)|outflows?|sell[- ]?off|crash(?:es|ed)?|bearish)\b/gi,
  /\b(?:slide[sd]?|slump(?:s|ed)?|drop(?:s|ped)?|fall(?:s|en)?|tumble[sd]?|plunge[sd]?|decline[sd]?|weak(?:en|ens|ened))\b/gi,
  /黑客|漏洞|攻击|被盗|禁止|诉讼|指控|清算|宕机|破产|欺诈|调查|拒绝|下架|资金流出|暴跌|利空/g,
];

export const OFFICIAL_NEWS_FEEDS = Object.freeze([
  { id: 'sec', name: '美国 SEC', url: 'https://www.sec.gov/news/pressreleases.rss', baseCredibility: 98, sourceTier: 'official', sourceCategory: 'regulator', relevancePattern: OFFICIAL_CRYPTO_PATTERN },
  { id: 'cftc-general', name: '美国 CFTC', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', baseCredibility: 98, sourceTier: 'official', sourceCategory: 'regulator', relevancePattern: OFFICIAL_CRYPTO_PATTERN },
  { id: 'cftc-enforcement', name: 'CFTC 执法公告', url: 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml', baseCredibility: 98, sourceTier: 'official', sourceCategory: 'regulator', relevancePattern: OFFICIAL_CRYPTO_PATTERN },
  { id: 'bitcoin-core', name: 'Bitcoin Core', url: 'https://github.com/bitcoin/bitcoin/releases.atom', baseCredibility: 96, sourceTier: 'official', sourceCategory: 'project', fixedSymbols: ['BTCUSDT'] },
  { id: 'ethereum-foundation', name: 'Ethereum Foundation', url: 'https://blog.ethereum.org/feed.xml', baseCredibility: 96, sourceTier: 'official', sourceCategory: 'project', fixedSymbols: ['ETHUSDT'] },
  { id: 'bnb-chain', name: 'BNB Chain', url: 'https://github.com/bnb-chain/bsc/releases.atom', baseCredibility: 96, sourceTier: 'official', sourceCategory: 'project', fixedSymbols: ['BNBUSDT'] },
  { id: 'solana-status', name: 'Solana Status', url: 'https://status.solana.com/history.atom', baseCredibility: 98, sourceTier: 'official', sourceCategory: 'status', fixedSymbols: ['SOLUSDT'] },
  { id: 'anza-agave', name: 'Anza Agave', url: 'https://github.com/anza-xyz/agave/releases.atom', baseCredibility: 96, sourceTier: 'official', sourceCategory: 'project', fixedSymbols: ['SOLUSDT'] },
  { id: 'xrpl', name: 'XRP Ledger Foundation', url: 'https://github.com/XRPLF/rippled/releases.atom', baseCredibility: 96, sourceTier: 'official', sourceCategory: 'project', fixedSymbols: ['XRPUSDT'] },
  { id: 'dogecoin-core', name: 'Dogecoin Core', url: 'https://github.com/dogecoin/dogecoin/releases.atom', baseCredibility: 96, sourceTier: 'official', sourceCategory: 'project', fixedSymbols: ['DOGEUSDT'] },
]);

export const MEDIA_NEWS_FEEDS = Object.freeze([
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', baseCredibility: 84, sourceTier: 'media', sourceCategory: 'media' },
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', baseCredibility: 80, sourceTier: 'media', sourceCategory: 'media' },
  { id: 'bitcoinmagazine', name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed', baseCredibility: 80, sourceTier: 'media', sourceCategory: 'media' },
]);

export const DEFAULT_NEWS_FEEDS = Object.freeze([...OFFICIAL_NEWS_FEEDS, ...MEDIA_NEWS_FEEDS]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function decodeXml(value = '') {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match) return decodeXml(match[1]);
  }
  return '';
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function parseNewsFeed(xml, source) {
  const rssItems = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const atomEntries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return [...rssItems, ...atomEntries].map((block) => {
    const atomLink = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || '';
    const title = tagValue(block, ['title']);
    const url = safeUrl(tagValue(block, ['link', 'guid']) || decodeXml(atomLink));
    const publishedValue = tagValue(block, ['pubDate', 'published', 'updated', 'dc:date']);
    const publishedAt = Number.isFinite(Date.parse(publishedValue)) ? new Date(publishedValue).toISOString() : null;
    return {
      id: crypto.createHash('sha256').update(`${source.id}|${url}|${title}`).digest('hex').slice(0, 24),
      title,
      url,
      publishedAt,
      source: source.name,
      sourceId: source.id,
      baseCredibility: source.baseCredibility,
      sourceTier: source.sourceTier || 'media',
      sourceCategory: source.sourceCategory || (source.sourceTier === 'official' ? 'project' : 'media'),
      fixedSymbols: source.fixedSymbols || [],
    };
  }).filter((item) => (
    item.title
    && item.url
    && (!source.relevancePattern || source.relevancePattern.test(item.title))
  ));
}

function matchCount(text, patterns) {
  return patterns.reduce((count, pattern) => count + [...text.matchAll(pattern)].length, 0);
}

function symbolsFor(title) {
  const symbols = Object.entries(SYMBOL_PATTERNS)
    .filter(([, pattern]) => pattern.test(title))
    .map(([symbol]) => symbol);
  return symbols.length ? symbols : ['MARKET'];
}

export function analyzeHeadline(title) {
  const positiveMatches = matchCount(title, POSITIVE_PATTERNS);
  let negativeMatches = matchCount(title, NEGATIVE_PATTERNS);
  if (MACRO_RISK_PATTERN.test(title)) negativeMatches += 1;
  if (RISK_OFF_SURGE_PATTERN.test(title)) negativeMatches += 1;
  const difference = positiveMatches - negativeMatches;
  const sentiment = difference > 0 ? 'bullish' : difference < 0 ? 'bearish' : 'neutral';
  let confidence = difference === 0 ? 42 : clamp(58 + Math.abs(difference) * 9, 58, 94);
  const uncertaintyDetected = UNCERTAINTY_PATTERN.test(title);
  if (uncertaintyDetected) confidence -= 12;
  const sentimentScore = difference === 0 ? 0 : Math.sign(difference) * clamp(0.45 + Math.abs(difference) * 0.18, 0, 1);
  const directionReason = difference > 0
    ? `标题识别到 ${positiveMatches} 个利多事件词${negativeMatches ? `、${negativeMatches} 个利空事件词` : ''}`
    : difference < 0
      ? `标题识别到 ${negativeMatches} 个利空事件词${positiveMatches ? `、${positiveMatches} 个利多事件词` : ''}`
      : '标题未识别到明确的利多或利空事件词';
  return {
    sentiment,
    sentimentLabel: sentiment === 'bullish' ? '利多' : sentiment === 'bearish' ? '利空' : '中性',
    sentimentScore,
    confidence: Math.round(clamp(confidence, 30, 94)),
    positiveMatchCount: positiveMatches,
    negativeMatchCount: negativeMatches,
    uncertaintyDetected,
    directionReason: `${directionReason}${uncertaintyDetected ? '；含不确定性表达，已降低方向置信度' : ''}`,
    symbols: symbolsFor(title),
  };
}

function titleTokens(title) {
  const stopwords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'after', 'over', 'crypto']);
  return new Set(title.toLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}/g)?.filter((token) => !stopwords.has(token)) || []);
}

function titleSimilarity(left, right) {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function analyzeItem(item) {
  const analysis = analyzeHeadline(item.title);
  const fixedSymbols = item.fixedSymbols || [];
  return {
    ...item,
    ...analysis,
    symbols: fixedSymbols.length
      ? [...new Set([...fixedSymbols, ...analysis.symbols.filter((symbol) => symbol !== 'MARKET')])]
      : analysis.symbols,
  };
}

function sharesExplicitSymbol(left, right) {
  return left.symbols.some((symbol) => symbol !== 'MARKET' && right.symbols.includes(symbol));
}

function confirmationFor(item, items, publishedMs) {
  if (item.sourceTier === 'official') {
    return {
      confirmationStatus: 'confirmed',
      confirmationLabel: '官方确认',
      confirmationReason: `来自${item.source}官方发布`,
      officialSources: [item.source],
    };
  }
  const officialMatches = items.filter((candidate) => {
    if (candidate.sourceTier !== 'official' || publishedMs === null || !candidate.publishedAt) return false;
    const similarity = titleSimilarity(candidate.title, item.title);
    const closeEnough = Math.abs(Date.parse(candidate.publishedAt) - publishedMs) <= 48 * HOUR_MS;
    return closeEnough && similarity >= 0.25 && (sharesExplicitSymbol(candidate, item) || similarity >= 0.45);
  });
  const officialSources = [...new Set(officialMatches.map((candidate) => candidate.source))];
  if (officialSources.length) {
    return {
      confirmationStatus: 'confirmed',
      confirmationLabel: '官方确认',
      confirmationReason: `已匹配${officialSources.join('、')}官方发布`,
      officialSources,
    };
  }
  return null;
}

function credibilityAssessment(item, confirmation, publishedMs) {
  let adjustment = 0;
  let evidenceStrength = 'medium';
  const reasons = [];

  if (item.sourceTier === 'official') {
    if (item.sourceCategory === 'regulator') {
      evidenceStrength = 'strong';
      reasons.push('监管机构原始发布，对监管行为和文件出处具有一手权威性');
    } else if (item.sourceCategory === 'status') {
      evidenceStrength = 'strong';
      reasons.push('官方状态通报，对网络运行事件具有一手权威性');
    } else {
      adjustment -= 4;
      reasons.push('项目方原始发布，但项目自述可能带有自身立场');
    }
    if (item.sourceCategory === 'project' && item.sentiment === 'bullish' && PROJECT_SELF_INTEREST_PATTERN.test(item.title)) {
      adjustment -= 6;
      reasons.push('包含项目合作、上线或增长类自述，已折减可信度');
    }
  } else if (confirmation.confirmationStatus === 'confirmed') {
    adjustment += 8;
    evidenceStrength = 'medium-high';
    reasons.push('媒体报道已匹配官方原文');
  } else if (confirmation.confirmationStatus === 'corroborated') {
    adjustment += 4;
    reasons.push('已有独立媒体交叉印证，但尚无官方原文');
  } else {
    adjustment -= 12;
    evidenceStrength = 'weak';
    reasons.push('单一媒体或聚合线索，尚未获得官方或多源印证');
  }

  if (item.uncertaintyDetected) {
    adjustment -= 10;
    evidenceStrength = 'weak';
    reasons.push('标题含可能、计划或传闻等不确定表述');
  }
  if (publishedMs === null) {
    adjustment -= 8;
    reasons.push('缺少有效发布时间');
  }

  const credibility = Math.round(clamp(item.baseCredibility + adjustment, 35, 99));
  return {
    credibility,
    credibilityLabel: credibility >= 90 ? '高' : credibility >= 75 ? '中高' : credibility >= 60 ? '中' : '低',
    evidenceStrength,
    evidenceStrengthLabel: evidenceStrength === 'strong' ? '强' : evidenceStrength === 'medium-high' ? '中高' : evidenceStrength === 'medium' ? '中' : '弱',
    credibilityReason: reasons.join('；'),
  };
}

function enrichCredibility(rawItems, nowMs) {
  const items = rawItems.map(analyzeItem);
  return items.map((item) => {
    const publishedMs = item.publishedAt ? Date.parse(item.publishedAt) : null;
    const corroboratingSources = new Set(items.filter((candidate) => (
      candidate.id !== item.id
      && candidate.sourceId !== item.sourceId
      && publishedMs !== null
      && candidate.publishedAt
      && Math.abs(Date.parse(candidate.publishedAt) - publishedMs) <= 12 * HOUR_MS
      && titleSimilarity(candidate.title, item.title) >= 0.35
    )).map((candidate) => candidate.source));
    const officialConfirmation = confirmationFor(item, items, publishedMs);
    const confirmation = officialConfirmation || (corroboratingSources.size
      ? {
        confirmationStatus: 'corroborated',
        confirmationLabel: '多源印证',
        confirmationReason: `${corroboratingSources.size + 1} 个独立媒体来源报道，尚未匹配官方发布`,
        officialSources: [],
      }
      : {
        confirmationStatus: 'unconfirmed',
        confirmationLabel: '待确认',
        confirmationReason: '尚未匹配官方发布或独立媒体交叉来源',
        officialSources: [],
      });
    const ageHours = publishedMs === null ? null : Math.max(0, (nowMs - publishedMs) / HOUR_MS);
    const credibility = credibilityAssessment(item, confirmation, publishedMs);
    return {
      ...item,
      ...confirmation,
      ...credibility,
      corroboratingSources: [...corroboratingSources],
      ageHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
    };
  });
}

function summaryFor(items, symbol, nowMs) {
  const relevantItems = symbol === 'MARKET'
    ? items
    : items.filter((item) => item.symbols.includes(symbol) || item.symbols.includes('MARKET'));
  let signedTotal = 0;
  let weightTotal = 0;
  let credibilityTotal = 0;
  let confidenceTotal = 0;
  let scoredArticleCount = 0;
  for (const item of relevantItems) {
    const publishedMs = item.publishedAt ? Date.parse(item.publishedAt) : nowMs - 48 * HOUR_MS;
    const ageHours = Math.max(0, (nowMs - publishedMs) / HOUR_MS);
    if (ageHours > 72) continue;
    const freshness = 0.5 ** (ageHours / 24);
    const relevance = item.symbols.includes(symbol) ? 1 : 0.6;
    const confirmationWeight = item.confirmationStatus === 'confirmed' ? 1 : item.confirmationStatus === 'corroborated' ? 0.55 : 0.2;
    const weight = item.confidence / 100 * item.credibility / 100 * freshness * relevance * confirmationWeight;
    signedTotal += item.sentimentScore * weight;
    weightTotal += weight;
    credibilityTotal += item.credibility * weight;
    confidenceTotal += item.confidence * weight;
    scoredArticleCount += 1;
  }
  const score = weightTotal ? clamp(signedTotal / weightTotal, -1, 1) : 0;
  const confirmedArticleCount = relevantItems.filter((item) => item.confirmationStatus === 'confirmed').length;
  const corroboratedArticleCount = relevantItems.filter((item) => item.confirmationStatus === 'corroborated').length;
  const unconfirmedArticleCount = relevantItems.filter((item) => item.confirmationStatus === 'unconfirmed').length;
  const confirmedAssessments = relevantItems
    .filter((item) => item.confirmationStatus === 'confirmed')
    .map((item) => ({
      credibility: item.credibility,
      confidence: item.confidence,
      evidenceStrength: item.evidenceStrength,
      sentiment: item.sentiment,
    }));
  return {
    score: Number(score.toFixed(4)),
    direction: score > 0.12 ? 'bullish' : score < -0.12 ? 'bearish' : 'neutral',
    label: score > 0.12 ? '偏利多' : score < -0.12 ? '偏利空' : '中性',
    credibility: weightTotal ? Math.round(credibilityTotal / weightTotal) : 0,
    confidence: weightTotal ? Math.round(confidenceTotal / weightTotal) : 0,
    articleCount: relevantItems.length,
    scoredArticleCount,
    confirmedArticleCount,
    confirmedAssessments,
    corroboratedArticleCount,
    unconfirmedArticleCount,
    confirmationRate: relevantItems.length ? Math.round(confirmedArticleCount / relevantItems.length * 100) : 0,
  };
}

export function summarizeNews(items, nowMs = Date.now()) {
  const bySymbol = Object.fromEntries(Object.keys(SYMBOL_PATTERNS).map((symbol) => [symbol, summaryFor(items, symbol, nowMs)]));
  return { overall: summaryFor(items, 'MARKET', nowMs), bySymbol };
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
      'User-Agent': 'QuantFlow-News/0.1 (+local research terminal)',
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 2_000_000) throw new Error('新闻响应内容过大');
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('新闻响应内容过大');
  return text;
}

function normalizeCryptoPanic(payload) {
  return (payload.results || payload.data || []).map((item) => ({
    id: String(item.id || crypto.randomUUID()),
    title: String(item.title || ''),
    url: safeUrl(item.original_url || item.url || ''),
    publishedAt: Number.isFinite(Date.parse(item.published_at || item.created_at))
      ? new Date(item.published_at || item.created_at).toISOString()
      : null,
    source: item.source?.title || item.source?.name || 'CryptoPanic',
    sourceId: `cryptopanic:${item.source?.code || item.source?.title || 'aggregate'}`,
    baseCredibility: 76,
    sourceTier: 'media',
    sourceCategory: 'aggregator',
    fixedSymbols: [],
  })).filter((item) => item.title && item.url);
}

export class NewsService {
  constructor({
    feeds = DEFAULT_NEWS_FEEDS,
    cryptoPanicToken = '',
    cryptoPanicPlan = 'growth',
    fetchImpl = fetch,
    now = () => Date.now(),
    cacheTtlMs = 60_000,
  } = {}) {
    this.feeds = feeds;
    this.cryptoPanicToken = cryptoPanicToken;
    this.cryptoPanicPlan = cryptoPanicPlan;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = null;
    this.refreshPromise = null;
  }

  async getNews() {
    const nowMs = this.now();
    if (this.cache && nowMs - this.cache.fetchedAtMs < this.cacheTtlMs) return this.cache.payload;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.#refresh(nowMs).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async #refresh(nowMs) {
    const requests = this.feeds.map(async (source) => ({
      source: source.name,
      sourceTier: source.sourceTier || 'media',
      sourceCategory: source.sourceCategory || 'media',
      items: parseNewsFeed(await fetchText(source.url, this.fetchImpl), source),
    }));
    if (this.cryptoPanicToken) {
      const url = new URL(`https://cryptopanic.com/api/${this.cryptoPanicPlan}/v2/posts/`);
      url.searchParams.set('auth_token', this.cryptoPanicToken);
      url.searchParams.set('public', 'true');
      requests.push((async () => {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { source: 'CryptoPanic', sourceTier: 'media', sourceCategory: 'aggregator', items: normalizeCryptoPanic(await response.json()) };
      })());
    }
    const settled = await Promise.allSettled(requests);
    const sourceStatus = settled.map((result, index) => ({
      source: result.status === 'fulfilled' ? result.value.source : (this.feeds[index]?.name || 'CryptoPanic'),
      sourceTier: result.status === 'fulfilled' ? result.value.sourceTier : (this.feeds[index]?.sourceTier || 'media'),
      sourceCategory: result.status === 'fulfilled' ? result.value.sourceCategory : (this.feeds[index]?.sourceCategory || 'aggregator'),
      ok: result.status === 'fulfilled',
      count: result.status === 'fulfilled' ? result.value.items.length : 0,
      error: result.status === 'rejected' ? result.reason.message : null,
    }));
    const rawItems = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value.items : [])
      .filter((item) => !item.publishedAt || Date.parse(item.publishedAt) <= nowMs);
    const enrichedItems = enrichCredibility(rawItems, nowMs);
    const unique = new Map();
    for (const item of enrichedItems) {
      const key = item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
      if (!unique.has(key) || unique.get(key).credibility < item.credibility) unique.set(key, item);
    }
    const items = [...unique.values()]
      .filter((item) => !item.publishedAt || nowMs - Date.parse(item.publishedAt) <= 7 * 24 * HOUR_MS)
      .sort((left, right) => Date.parse(right.publishedAt || 0) - Date.parse(left.publishedAt || 0))
      .slice(0, 50);
    if (!items.length && this.cache) return { ...this.cache.payload, status: 'stale', sourceStatus };
    const payload = {
      status: items.length ? 'live' : 'unavailable',
      updatedAt: new Date(nowMs).toISOString(),
      refreshAfterSeconds: Math.round(this.cacheTtlMs / 1_000),
      sourceStatus,
      summary: summarizeNews(items, nowMs),
      items,
    };
    this.cache = { fetchedAtMs: nowMs, payload };
    return payload;
  }
}
