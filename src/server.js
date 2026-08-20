import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BinanceApiError, BinanceClient, TESTNET_API_BASE } from './binance-client.js';
import { SignalAccuracyStore } from './accuracy-leverage.js';
import { calculateCompositeSignal, calculatePriceTrendScore, COMPOSITE_STRATEGY_PROFILES } from './composite-strategies.js';
import { NewsService } from './news-service.js';
import { PaperPortfolioStore, paperPortfolioSnapshot } from './monthly-accuracy-paper.js';
import { btcPaperSnapshot, btcPaperStatePath } from './btc-paper.js';
import {
  buildPaperStrategyReview,
  PAPER_SHADOW_PROFILES,
  paperShadowStatePath,
} from './paper-strategy-review.js';
import { STRATEGY_CATALOG, STRATEGY_SYMBOLS, StrategyStore } from './strategies.js';
import { UserStore } from './user-store.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(rootDir, 'public');
const port = Number(process.env.PORT || 3173);
const host = process.env.HOST || '127.0.0.1';
const sessionTtlMs = Number(process.env.SESSION_TTL_MINUTES || 30) * 60_000;
const appSessionTtlMs = Number(process.env.APP_SESSION_TTL_HOURS || 8) * 3_600_000;
const apiBase = process.env.BINANCE_API_BASE || TESTNET_API_BASE;
const strategyStore = new StrategyStore(path.join(rootDir, 'data', 'config', 'strategies.json'));
const signalAccuracyStore = new SignalAccuracyStore(path.join(rootDir, 'data', 'runtime', 'signal-accuracy.json'));
const paperPortfolioStore = new PaperPortfolioStore(
  path.join(rootDir, 'data', 'runtime', 'monthly-accuracy-paper.json'),
);
const btcPaperPortfolioStore = new PaperPortfolioStore(btcPaperStatePath(rootDir));
const paperShadowStores = PAPER_SHADOW_PROFILES.map((profile) => (
  new PaperPortfolioStore(paperShadowStatePath(rootDir, profile.id))
));
const newsService = new NewsService({
  cryptoPanicToken: process.env.CRYPTOPANIC_API_TOKEN || '',
  cryptoPanicPlan: process.env.CRYPTOPANIC_API_PLAN || 'growth',
});
const sessions = new Map();
const appUserStore = new UserStore(
  process.env.QUANTFLOW_USER_STORE_PATH || path.join(rootDir, 'data', 'runtime', 'users.json'),
);
const requestBuckets = new Map();
const marketSignalCache = new Map();
const defaultAppContext = {
  userStore: appUserStore,
  sessions: new Map(),
  sessionTtlMs: appSessionTtlMs,
  bootstrap: {
    username: process.env.QUANTFLOW_ADMIN_USERNAME || '',
    password: process.env.QUANTFLOW_ADMIN_PASSWORD || '',
    displayName: process.env.QUANTFLOW_ADMIN_DISPLAY_NAME || '系统管理员',
  },
};

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { ...securityHeaders(), Location: location });
  res.end();
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求 JSON 格式无效'), { status: 400 });
  }
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key]) => key)
      .map(([key, value]) => [key, decodeURIComponent(value || '')]),
  );
}

function sessionFor(req) {
  const id = cookies(req).qsession;
  const session = id ? sessions.get(id) : null;
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + sessionTtlMs;
  return { id, ...session };
}

function requireSession(req) {
  const session = sessionFor(req);
  if (!session) throw Object.assign(new Error('API 会话已失效，请重新连接'), { status: 401 });
  return session;
}

function secureRequest(req) {
  return Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
}

function appSessionCookie(req, value, maxAgeSeconds) {
  return `quantflow_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secureRequest(req) ? '; Secure' : ''}`;
}

async function appSessionFor(req, context) {
  const id = cookies(req).quantflow_session;
  const session = id ? context.sessions.get(id) : null;
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    context.sessions.delete(id);
    return null;
  }
  const user = await context.userStore.findById(session.userId);
  if (!user || user.status !== 'active') {
    context.sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + context.sessionTtlMs;
  return { id, user };
}

async function requireAppSession(req, context) {
  const session = await appSessionFor(req, context);
  if (!session) throw Object.assign(new Error('请先登录系统'), { status: 401, code: 'AUTH_REQUIRED' });
  return session;
}

function requireAdmin(session) {
  if (session.user.role !== 'admin') {
    throw Object.assign(new Error('仅管理员可以执行此操作'), { status: 403, code: 'ADMIN_REQUIRED' });
  }
  return session;
}

function clientFor(session = {}) {
  return new BinanceClient({
    apiKey: session.apiKey,
    apiSecret: session.apiSecret,
    baseUrl: apiBase,
  });
}

function validateSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    throw Object.assign(new Error('交易对格式无效'), { status: 400 });
  }
  return symbol;
}

function configuredCompositeProfile(profile, strategies) {
  const configured = strategies.find((strategy) => strategy.enabled && strategy.type === profile.type);
  if (!configured) return profile;
  const config = configured.config;
  const accuracyLeverage = profile.accuracyLeverage && config.accuracyLeverageEnabled !== 'disabled'
    ? {
      ...profile.accuracyLeverage,
      minimumAccuracy: (config.accuracyLeverageThresholdPercent ?? profile.accuracyLeverage.minimumAccuracy * 100) / 100,
      minimumSamples: config.accuracyLeverageMinimumSamples ?? profile.accuracyLeverage.minimumSamples,
      performanceWindow: Math.max(
        profile.accuracyLeverage.performanceWindow,
        config.accuracyLeverageMinimumSamples ?? profile.accuracyLeverage.minimumSamples,
      ),
      minimumRecentAccuracy: (config.accuracyLeverageRecentThresholdPercent
        ?? profile.accuracyLeverage.minimumRecentAccuracy * 100) / 100,
      leverageMultiplier: config.accuracyLeverageMultiplier ?? profile.accuracyLeverage.leverageMultiplier,
      maximumAnnualizedVolatility: (config.accuracyLeverageMaxVolatilityPercent
        ?? profile.accuracyLeverage.maximumAnnualizedVolatility * 100) / 100,
      maximumDrawdownMagnitude: (config.accuracyLeverageMaxDrawdownPercent
        ?? profile.accuracyLeverage.maximumDrawdownMagnitude * 100) / 100,
    }
    : null;
  return {
    ...profile,
    name: configured.name,
    positionMode: config.positionMode,
    priceSignalWeight: config.priceSignalWeight,
    newsSignalWeight: config.newsSignalWeight,
    minimumNewsCredibility: config.minimumNewsCredibility,
    minimumNewsConfidence: config.minimumNewsConfidence,
    targetVolatilityPercent: config.targetVolatilityPercent,
    maxGrossExposurePercent: config.maxGrossExposurePercent,
    maxAssetExposurePercent: config.maxAssetExposurePercent,
    portfolioDrawdownLimitPercent: config.portfolioDrawdownLimitPercent,
    defaultLeverage: config.leverage,
    accuracyLeverage,
  };
}

async function livePriceSignal(symbol) {
  const cached = marketSignalCache.get(symbol);
  if (cached && Date.now() - cached.updatedAt < 60_000) return cached.observation;
  const klines = await clientFor().publicRequest('/api/v3/klines', { symbol, interval: '4h', limit: 180 });
  const now = Date.now();
  const closedKlines = klines.filter((item) => Number(item[6]) <= now);
  const signal = calculatePriceTrendScore(closedKlines);
  const lastClosed = closedKlines.at(-1);
  const observation = {
    signal,
    referencePrice: Number(lastClosed[4]),
    observedAt: Number(lastClosed[6]),
    candles: closedKlines.map((item) => ({ closedAt: Number(item[6]), close: Number(item[4]) })),
  };
  marketSignalCache.set(symbol, { updatedAt: now, observation });
  return observation;
}

function rateLimited(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = requestBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt > 60_000) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  requestBuckets.set(key, bucket);
  return bucket.count > 120;
}

async function currentPaperPortfolio() {
  const [baselineState, btcState, shadowStates] = await Promise.all([
    paperPortfolioStore.read(),
    btcPaperPortfolioStore.read(),
    Promise.all(paperShadowStores.map((store) => store.read())),
  ]);
  return {
    ...paperPortfolioSnapshot(baselineState),
    optimizationReview: buildPaperStrategyReview({ baselineState, shadowStates }),
    btcPortfolio: btcPaperSnapshot(btcState),
  };
}

async function apiRoute(req, res, url, appContext) {
  if (rateLimited(req)) return sendJson(res, 429, { error: '请求过于频繁，请稍后重试' });

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok', environment: 'spot-testnet' });
  }

  const setup = await appContext.userStore.initialize(appContext.bootstrap);

  if (req.method === 'GET' && url.pathname === '/api/auth/session') {
    const session = await appSessionFor(req, appContext);
    return sendJson(res, 200, {
      authenticated: Boolean(session),
      setupRequired: setup.setupRequired,
      user: session?.user || null,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (setup.setupRequired) {
      throw Object.assign(new Error('系统尚未初始化管理员，请先配置启动环境变量'), {
        status: 503,
        code: 'SETUP_REQUIRED',
      });
    }
    const body = await readJson(req);
    const user = await appContext.userStore.authenticate(body.username, body.password);
    const id = crypto.randomUUID();
    appContext.sessions.set(id, { userId: user.id, expiresAt: Date.now() + appContext.sessionTtlMs });
    return sendJson(res, 200, { authenticated: true, user }, {
      'Set-Cookie': appSessionCookie(req, id, Math.floor(appContext.sessionTtlMs / 1000)),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const id = cookies(req).quantflow_session;
    if (id) appContext.sessions.delete(id);
    return sendJson(res, 200, { authenticated: false }, {
      'Set-Cookie': appSessionCookie(req, '', 0),
    });
  }

  const appSession = await requireAppSession(req, appContext);

  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    requireAdmin(appSession);
    return sendJson(res, 200, { users: await appContext.userStore.list() });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/users') {
    requireAdmin(appSession);
    const body = await readJson(req);
    const user = await appContext.userStore.create({
      username: body.username,
      displayName: body.displayName,
      password: body.password,
      role: body.role,
    });
    return sendJson(res, 201, { user });
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/);
  if (req.method === 'PATCH' && adminUserMatch) {
    requireAdmin(appSession);
    const id = adminUserMatch[1];
    const current = await appContext.userStore.findById(id);
    if (!current) throw Object.assign(new Error('用户不存在'), { status: 404 });
    const body = await readJson(req);
    if (id === appSession.user.id && (body.status === 'disabled' || body.role === 'user')) {
      throw Object.assign(new Error('不能停用自己或取消自己的管理员权限'), { status: 400 });
    }
    const removesActiveAdmin = current.role === 'admin' && current.status === 'active'
      && (body.status === 'disabled' || body.role === 'user');
    if (removesActiveAdmin && await appContext.userStore.activeAdminCount() <= 1) {
      throw Object.assign(new Error('系统必须保留至少一名启用中的管理员'), { status: 400 });
    }
    const user = await appContext.userStore.update(id, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    if (user.status === 'disabled') {
      for (const [sessionId, session] of appContext.sessions) {
        if (session.userId === user.id) appContext.sessions.delete(sessionId);
      }
    }
    return sendJson(res, 200, { user });
  }

  const resetPasswordMatch = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)\/reset-password$/);
  if (req.method === 'POST' && resetPasswordMatch) {
    requireAdmin(appSession);
    const body = await readJson(req);
    const user = await appContext.userStore.resetPassword(resetPasswordMatch[1], body.password);
    for (const [sessionId, session] of appContext.sessions) {
      if (session.userId === user.id && sessionId !== appSession.id) appContext.sessions.delete(sessionId);
    }
    return sendJson(res, 200, { user });
  }

  if (req.method === 'GET' && url.pathname === '/api/strategies/catalog') {
    return sendJson(res, 200, {
      executionMode: 'CONFIG_ONLY',
      warning: '启用仅代表进入观察状态，当前不会自动下单',
      symbols: STRATEGY_SYMBOLS,
      strategies: Object.values(STRATEGY_CATALOG),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/strategies') {
    return sendJson(res, 200, { strategies: await strategyStore.list() });
  }

  if (req.method === 'GET' && url.pathname === '/api/paper-portfolio') {
    return sendJson(res, 200, await currentPaperPortfolio());
  }

  if (req.method === 'GET' && url.pathname === '/api/paper-portfolio/btc') {
    return sendJson(res, 200, btcPaperSnapshot(await btcPaperPortfolioStore.read()));
  }

  if (req.method === 'GET' && url.pathname === '/api/paper-portfolio/review') {
    const paper = await currentPaperPortfolio();
    return sendJson(res, 200, paper.optimizationReview);
  }

  if (req.method === 'GET' && url.pathname === '/api/paper-portfolio/reports') {
    const rawLimit = url.searchParams.get('limit') || '30';
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 365) {
      throw Object.assign(new Error('日报数量必须在 1 到 365 之间'), { status: 400 });
    }
    const snapshot = paperPortfolioSnapshot(await paperPortfolioStore.read());
    return sendJson(res, 200, {
      reports: snapshot.reports.slice(-Number(rawLimit)).reverse(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/news') {
    return sendJson(res, 200, await newsService.getNews());
  }

  if (req.method === 'GET' && url.pathname === '/api/composite-signals') {
    const symbol = validateSymbol(url.searchParams.get('symbol') || 'BTCUSDT');
    if (!STRATEGY_SYMBOLS.some((item) => item.value === symbol)) {
      throw Object.assign(new Error('组合策略暂不支持该交易对'), { status: 400 });
    }
    const [news, marketObservation, storedStrategies] = await Promise.all([
      newsService.getNews(),
      livePriceSignal(symbol),
      strategyStore.list(),
    ]);
    const { signal: priceSignal } = marketObservation;
    const newsSummary = news.summary.bySymbol[symbol];
    const profiles = Object.values(COMPOSITE_STRATEGY_PROFILES)
      .map((profile) => configuredCompositeProfile(profile, storedStrategies));
    const stableProfile = profiles.find((profile) => profile.type === 'stableComposite');
    const stableSignal = calculateCompositeSignal(stableProfile, priceSignal, newsSummary);
    const accuracyObservation = await signalAccuracyStore.observe({
      strategyType: stableProfile.type,
      symbol,
      action: stableSignal.action,
      targetGrossExposurePercent: stableSignal.risk.baseTargetGrossExposurePercent,
      referencePrice: marketObservation.referencePrice,
      observedAt: marketObservation.observedAt,
      candles: marketObservation.candles,
    }, stableProfile.accuracyLeverage || COMPOSITE_STRATEGY_PROFILES.stableComposite.accuracyLeverage);
    return sendJson(res, 200, {
      symbol,
      updatedAt: new Date().toISOString(),
      priceSignal,
      newsSummary,
      strategies: profiles.map((profile) => (
        calculateCompositeSignal(
          profile,
          priceSignal,
          newsSummary,
          profile.type === stableProfile.type ? accuracyObservation.performance : null,
        )
      )),
      accuracyTracking: {
        horizonHours: COMPOSITE_STRATEGY_PROFILES.stableComposite.accuracyLeverage.horizonHours,
        recorded: accuracyObservation.recorded,
        settledCount: accuracyObservation.settledCount,
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/strategies') {
    const strategy = await strategyStore.create(await readJson(req));
    return sendJson(res, 201, { strategy });
  }

  const strategyMatch = url.pathname.match(/^\/api\/strategies\/([a-f0-9-]+)$/);
  if (strategyMatch) {
    const id = strategyMatch[1];
    if (req.method === 'PUT') {
      return sendJson(res, 200, { strategy: await strategyStore.update(id, await readJson(req)) });
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('启停状态无效'), { status: 400 });
      return sendJson(res, 200, { strategy: await strategyStore.setEnabled(id, body.enabled) });
    }
    if (req.method === 'DELETE') {
      await strategyStore.delete(id);
      return sendJson(res, 200, { deleted: true });
    }
  }

  const cloneMatch = url.pathname.match(/^\/api\/strategies\/([a-f0-9-]+)\/clone$/);
  if (req.method === 'POST' && cloneMatch) {
    return sendJson(res, 201, { strategy: await strategyStore.clone(cloneMatch[1]) });
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const session = sessionFor(req);
    return sendJson(res, 200, {
      connected: Boolean(session),
      apiKeyHint: session ? `${session.apiKey.slice(0, 4)}••••${session.apiKey.slice(-4)}` : null,
      environment: 'Binance Spot Testnet',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    const { apiKey, apiSecret } = await readJson(req);
    if (typeof apiKey !== 'string' || apiKey.trim().length < 16) {
      throw Object.assign(new Error('请输入有效的 API Key'), { status: 400 });
    }
    if (typeof apiSecret !== 'string' || apiSecret.trim().length < 16) {
      throw Object.assign(new Error('请输入有效的 Secret Key'), { status: 400 });
    }

    const credentials = { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
    const client = clientFor(credentials);
    const account = await client.account();
    const id = crypto.randomUUID();
    sessions.set(id, { ...credentials, expiresAt: Date.now() + sessionTtlMs });
    return sendJson(
      res,
      201,
      { connected: true, canTrade: account.canTrade, accountType: account.accountType },
      { 'Set-Cookie': `qsession=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}` },
    );
  }

  if (req.method === 'DELETE' && url.pathname === '/api/session') {
    const session = sessionFor(req);
    if (session) sessions.delete(session.id);
    return sendJson(res, 200, { connected: false }, {
      'Set-Cookie': 'qsession=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/market') {
    const symbol = validateSymbol(url.searchParams.get('symbol') || 'BTCUSDT');
    const client = clientFor();
    const [ticker, klines] = await Promise.all([
      client.publicRequest('/api/v3/ticker/24hr', { symbol }),
      client.publicRequest('/api/v3/klines', { symbol, interval: '15m', limit: 60 }),
    ]);
    return sendJson(res, 200, {
      symbol,
      ticker: {
        lastPrice: ticker.lastPrice,
        priceChangePercent: ticker.priceChangePercent,
        highPrice: ticker.highPrice,
        lowPrice: ticker.lowPrice,
        quoteVolume: ticker.quoteVolume,
      },
      candles: klines.map((item) => ({
        time: item[0], open: item[1], high: item[2], low: item[3], close: item[4], volume: item[5],
      })),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/account') {
    const account = await clientFor(requireSession(req)).account();
    const balances = account.balances
      .filter((item) => Number(item.free) || Number(item.locked))
      .sort((a, b) => Number(b.free) + Number(b.locked) - Number(a.free) - Number(a.locked));
    return sendJson(res, 200, {
      canTrade: account.canTrade,
      accountType: account.accountType,
      balances,
      updatedAt: account.updateTime || Date.now(),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/orders/test') {
    const session = requireSession(req);
    const body = await readJson(req);
    const symbol = validateSymbol(body.symbol);
    const side = String(body.side || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) {
      throw Object.assign(new Error('买卖方向无效'), { status: 400 });
    }
    const amount = String(body.amount || '').trim();
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
      throw Object.assign(new Error('下单数量必须大于 0'), { status: 400 });
    }

    const order = { symbol, side, type: 'MARKET' };
    if (side === 'BUY') order.quoteOrderQty = amount;
    else order.quantity = amount;
    const client = clientFor(session);
    const [ticker] = await Promise.all([
      client.publicRequest('/api/v3/ticker/24hr', { symbol }),
      client.testOrder(order),
    ]);
    return sendJson(res, 200, {
      validated: true,
      message: '测试订单校验通过，未进入撮合，也不会产生真实成交',
      order,
      execution: {
        referencePrice: ticker.lastPrice,
        pnl: null,
        pnlStatus: 'not_applicable',
      },
      testedAt: Date.now(),
    });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

async function staticRoute(req, res, url, appContext) {
  if (!['GET', 'HEAD'].includes(req.method)) return sendJson(res, 405, { error: '请求方法不支持' });
  await appContext.userStore.initialize(appContext.bootstrap);
  const session = await appSessionFor(req, appContext);
  if ((url.pathname === '/' || url.pathname === '/index.html') && !session) {
    return redirect(res, '/login.html?next=%2F');
  }
  if (url.pathname === '/admin.html' && !session) {
    return redirect(res, '/login.html?next=%2Fadmin.html');
  }
  if (url.pathname === '/admin.html' && session.user.role !== 'admin') return redirect(res, '/');
  if (url.pathname === '/login.html' && session) return redirect(res, session.user.role === 'admin' ? '/admin.html' : '/');
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.resolve(publicDir, `.${requested}`);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) return sendJson(res, 403, { error: '拒绝访问' });
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      ...securityHeaders(),
      'Cache-Control': requested === '/index.html' ? 'no-cache' : 'public, max-age=3600',
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(res, 404, { error: '页面不存在' });
    throw error;
  }
}

export function createServer(options = {}) {
  const appContext = {
    userStore: options.userStore || defaultAppContext.userStore,
    sessions: options.sessions || new Map(),
    sessionTtlMs: options.sessionTtlMs || defaultAppContext.sessionTtlMs,
    bootstrap: options.bootstrap || defaultAppContext.bootstrap,
  };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) await apiRoute(req, res, url, appContext);
      else await staticRoute(req, res, url, appContext);
    } catch (error) {
      const status = error.status || 500;
      const message = error instanceof BinanceApiError ? error.message : (status < 500 ? error.message : '服务器暂时不可用');
      if (status >= 500 && status !== 503) console.error('[server]', error.name, error.message);
      sendJson(res, status, { error: message, code: error.code || null });
    }
  });
}

export const server = createServer({ sessions: defaultAppContext.sessions });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    console.log(`QuantFlow 已启动：http://${host}:${port}`);
    console.log('当前环境：Binance Spot Testnet（测试网）');
  });
}
