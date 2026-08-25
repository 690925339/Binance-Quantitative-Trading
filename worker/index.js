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
const AUTH_SESSION_TTL_SECONDS = 8 * 60 * 60;
const PASSWORD_ITERATIONS = 210_000;
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
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

function redirect(location) {
  return new Response(null, { status: 302, headers: { ...securityHeaders(), Location: location } });
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  return json({ error: status < 500 ? error.message : '服务器暂时不可用', code: error?.code || null }, status);
}

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function randomToken(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(salt), iterations }, key, 256);
  return base64Url(new Uint8Array(bits));
}

async function passwordHash(password) {
  const salt = randomToken(18);
  return { salt, hash: await derivePassword(password, salt), iterations: PASSWORD_ITERATIONS };
}

function validateUsername(value) {
  const username = String(value || '').trim();
  if (!USERNAME_PATTERN.test(username)) throw httpError('登录账号需为 3 到 32 位字母、数字、点、横线或下划线');
  return username;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 128) throw httpError('密码需为 10 到 128 个字符');
  return password;
}

function validateDisplayName(value, fallback) {
  const displayName = String(value || fallback || '').trim();
  if (!displayName || displayName.length > 40) throw httpError('用户名称需为 1 到 40 个字符');
  return displayName;
}

function validateRole(value) {
  const role = String(value || 'user');
  if (!['admin', 'user'].includes(role)) throw httpError('用户角色无效');
  return role;
}

function cookies(request) {
  return Object.fromEntries((request.headers.get('cookie') || '').split(';').map((part) => part.trim().split('=')).filter(([key]) => key).map(([key, value]) => [key, decodeURIComponent(value || '')]));
}

function authCookie(value, maxAge = AUTH_SESSION_TTL_SECONDS) {
  return `quantflow_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${maxAge}`;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    loginCount: Number(row.login_count || 0),
  };
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
      env.DB.prepare('CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN (\'admin\', \'user\')), status TEXT NOT NULL CHECK(status IN (\'active\', \'disabled\')), password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, password_iterations INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT, login_count INTEGER NOT NULL DEFAULT 0)'),
      env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_username ON app_users(username COLLATE NOCASE)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES app_users(id) ON DELETE CASCADE)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at)'),
    ]).then(() => undefined).catch((error) => { schemaReady = undefined; throw error; });
  }
  await schemaReady;
}

async function ensureAuthSetup(env) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM app_users').first();
  if (Number(row?.count || 0) > 0) return { setupRequired: false };
  const usernameValue = String(env.QUANTFLOW_ADMIN_USERNAME || '').trim();
  const passwordValue = String(env.QUANTFLOW_ADMIN_PASSWORD || '');
  if (!usernameValue || !passwordValue) return { setupRequired: true };
  const username = validateUsername(usernameValue);
  const password = await passwordHash(validatePassword(passwordValue));
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT OR IGNORE INTO app_users (id, username, display_name, role, status, password_salt, password_hash, password_iterations, created_at, updated_at, login_count) VALUES (?, ?, ?, \'admin\', \'active\', ?, ?, ?, ?, ?, 0)')
    .bind(crypto.randomUUID(), username, validateDisplayName(env.QUANTFLOW_ADMIN_DISPLAY_NAME, '系统管理员'), password.salt, password.hash, password.iterations, now, now).run();
  return { setupRequired: false };
}

async function authSession(request, env) {
  const token = cookies(request).quantflow_session;
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare('SELECT u.id, u.username, u.display_name, u.role, u.status, u.created_at, u.updated_at, u.last_login_at, u.login_count FROM auth_sessions s JOIN app_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .bind(tokenHash, now).first();
  if (!row || row.status !== 'active') {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?').bind(expiresAt, tokenHash).run();
  return { tokenHash, user: publicUser(row) };
}

async function requireAuth(request, env) {
  const session = await authSession(request, env);
  if (!session) throw Object.assign(httpError('请先登录系统', 401), { code: 'AUTH_REQUIRED' });
  return session;
}

function requireAdmin(session) {
  if (session.user.role !== 'admin') throw Object.assign(httpError('仅管理员可以执行此操作', 403), { code: 'ADMIN_REQUIRED' });
}

async function login(request, env) {
  const body = await parseBody(request);
  const username = String(body.username || '').trim();
  const row = await env.DB.prepare('SELECT * FROM app_users WHERE username = ? COLLATE NOCASE').bind(username).first();
  const matches = row && await derivePassword(String(body.password || ''), row.password_salt, Number(row.password_iterations)) === row.password_hash;
  if (!matches) throw Object.assign(httpError('账号或密码错误', 401), { code: 'INVALID_CREDENTIALS' });
  if (row.status !== 'active') throw Object.assign(httpError('该账号已停用，请联系管理员', 403), { code: 'USER_DISABLED' });
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE app_users SET last_login_at = ?, login_count = login_count + 1, updated_at = ? WHERE id = ?').bind(now, now, row.id),
    env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(tokenHash, row.id, now, expiresAt),
  ]);
  return { token, user: publicUser({ ...row, last_login_at: now, updated_at: now, login_count: Number(row.login_count || 0) + 1 }) };
}

async function listUsers(env) {
  const { results } = await env.DB.prepare('SELECT id, username, display_name, role, status, created_at, updated_at, last_login_at, login_count FROM app_users ORDER BY created_at').all();
  return results.map(publicUser);
}

async function createUser(request, env) {
  const body = await parseBody(request);
  const username = validateUsername(body.username);
  const displayName = validateDisplayName(body.displayName, username);
  const role = validateRole(body.role);
  const password = await passwordHash(validatePassword(body.password));
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO app_users (id, username, display_name, role, status, password_salt, password_hash, password_iterations, created_at, updated_at, login_count) VALUES (?, ?, ?, ?, \'active\', ?, ?, ?, ?, ?, 0)')
      .bind(id, username, displayName, role, password.salt, password.hash, password.iterations, now, now).run();
  } catch (error) {
    if (/unique/i.test(error.message)) throw Object.assign(httpError('该登录账号已存在', 409), { code: 'USERNAME_EXISTS' });
    throw error;
  }
  return publicUser({ id, username, display_name: displayName, role, status: 'active', created_at: now, updated_at: now, last_login_at: null, login_count: 0 });
}

async function updateUser(request, env, id, actor) {
  const body = await parseBody(request);
  const current = await env.DB.prepare('SELECT * FROM app_users WHERE id = ?').bind(id).first();
  if (!current) throw httpError('用户不存在', 404);
  const role = body.role === undefined ? current.role : validateRole(body.role);
  const status = body.status === undefined ? current.status : String(body.status);
  const displayName = body.displayName === undefined ? current.display_name : validateDisplayName(body.displayName, current.username);
  if (!['active', 'disabled'].includes(status)) throw httpError('用户状态无效');
  if (id === actor.user.id && (status === 'disabled' || role === 'user')) throw httpError('不能停用自己或取消自己的管理员权限');
  if (current.role === 'admin' && current.status === 'active' && (status === 'disabled' || role === 'user')) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM app_users WHERE role = \'admin\' AND status = \'active\'').first();
    if (Number(count?.count || 0) <= 1) throw httpError('系统必须保留至少一名启用中的管理员');
  }
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE app_users SET display_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?').bind(displayName, role, status, now, id).run();
  if (status === 'disabled') await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(id).run();
  return publicUser({ ...current, display_name: displayName, role, status, updated_at: now });
}

async function resetUserPassword(request, env, id, actor) {
  const body = await parseBody(request);
  const current = await env.DB.prepare('SELECT * FROM app_users WHERE id = ?').bind(id).first();
  if (!current) throw httpError('用户不存在', 404);
  const password = await passwordHash(validatePassword(body.password));
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE app_users SET password_salt = ?, password_hash = ?, password_iterations = ?, updated_at = ? WHERE id = ?')
    .bind(password.salt, password.hash, password.iterations, now, id).run();
  if (id === actor.user.id) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').bind(id, actor.tokenHash).run();
  } else {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(id).run();
  }
  return publicUser({ ...current, updated_at: now });
}

async function seededJson(request, env, name, fallback) {
  const response = await env.ASSETS.fetch(new Request(new URL(`/seed/${name}.json`, request.url)));
  if (!response.ok) return fallback;
  return response.json();
}

function validCycleDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
}

function validTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function runtimeStateFreshness(state) {
  if (!state || typeof state !== 'object') {
    return { cycleDate: null, timestamp: null, reportCount: 0 };
  }
  const reports = Array.isArray(state.reports) ? state.reports : [];
  const cycleDates = [
    state.lastCycleDate,
    state.cycleDate,
    state.latestReport?.cycleDate,
    ...reports.map((report) => report?.cycleDate),
  ].map(validCycleDate).filter(Boolean);
  const timestamps = [
    state.updatedAt,
    state.reportedAt,
    state.generatedAt,
    state.reviewedAt,
    state.latestReport?.reportedAt,
    ...reports.map((report) => report?.reportedAt),
  ].map(validTimestamp).filter((value) => value !== null);
  return {
    cycleDate: cycleDates.length ? cycleDates.sort().at(-1) : null,
    timestamp: timestamps.length ? Math.max(...timestamps) : null,
    reportCount: reports.length,
  };
}

export function selectRuntimeState(stored, seeded) {
  if (!stored || typeof stored !== 'object') {
    return { state: seeded, source: 'seed', shouldPersist: true };
  }
  if (!seeded || typeof seeded !== 'object') {
    return { state: stored, source: 'stored', shouldPersist: false };
  }
  const storedFreshness = runtimeStateFreshness(stored);
  const seedFreshness = runtimeStateFreshness(seeded);
  let seedIsNewer = false;
  if (seedFreshness.cycleDate && storedFreshness.cycleDate) {
    seedIsNewer = seedFreshness.cycleDate > storedFreshness.cycleDate;
    if (seedFreshness.cycleDate === storedFreshness.cycleDate) {
      const seedSnapshotVersion = Number(seeded.runtimeSnapshotVersion || 0);
      const storedSnapshotVersion = Number(stored.runtimeSnapshotVersion || 0);
      const seedIsNotOlderByTime = seedFreshness.timestamp !== null
        && (storedFreshness.timestamp === null
          || seedFreshness.timestamp >= storedFreshness.timestamp);
      seedIsNewer = seedSnapshotVersion > storedSnapshotVersion
        && seedIsNotOlderByTime;
      if (!seedIsNewer) {
        seedIsNewer = seedSnapshotVersion === storedSnapshotVersion
          && seedFreshness.timestamp !== null
          && (storedFreshness.timestamp === null
            || seedFreshness.timestamp > storedFreshness.timestamp);
      }
      if (!seedIsNewer && seedFreshness.timestamp === storedFreshness.timestamp) {
        seedIsNewer = seedFreshness.reportCount > storedFreshness.reportCount;
      }
    }
  } else if (seedFreshness.cycleDate) {
    seedIsNewer = true;
  } else if (!storedFreshness.cycleDate && seedFreshness.timestamp !== null) {
    seedIsNewer = storedFreshness.timestamp === null
      || seedFreshness.timestamp > storedFreshness.timestamp;
  }
  return seedIsNewer
    ? { state: seeded, source: 'seed', shouldPersist: true }
    : { state: stored, source: 'stored', shouldPersist: false };
}

export function combinePaperPortfolioState(paper, btcPortfolio, optimizationReview) {
  return {
    ...(paper || {}),
    btcPortfolio: btcPortfolio || null,
    optimizationReview: optimizationReview || null,
  };
}

async function readState(request, env, key, seedName, fallback) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT payload FROM runtime_state WHERE state_key = ?').bind(key).first();
  const seeded = await seededJson(request, env, seedName, fallback);
  let stored = null;
  if (row?.payload) {
    try {
      stored = JSON.parse(row.payload);
    } catch {
      stored = null;
    }
  }
  const selected = selectRuntimeState(stored, seeded);
  if (selected.shouldPersist) {
    await env.DB.prepare('INSERT OR REPLACE INTO runtime_state (state_key, payload, updated_at) VALUES (?, ?, ?)')
      .bind(key, JSON.stringify(selected.state), new Date().toISOString()).run();
  }
  return selected.state;
}

async function catalog(request, env) {
  return seededJson(request, env, 'strategy-catalog', { strategies: [], symbols: SYMBOLS.map((value) => ({ value, label: value })) });
}

function genericRisk(config = {}, type = '') {
  const leverage = Math.min(125, Math.max(1, Number(config.leverage) || 1));
  const margin = Math.max(0, Number(config.marginBudget ?? config.maxInvestment ?? config.orderAmount) || 0);
  const leverageCapacity = margin * leverage;
  const strategyCap = type === 'btcSingleAssetTrend'
    ? margin * Math.max(0, Number(config.maxGrossExposurePercent || 0)) / 100
    : leverageCapacity;
  const maximum = Math.round(Math.min(leverageCapacity, strategyCap) * 100) / 100;
  return { estimatedMaxInvestment: margin, estimatedMaxExposure: maximum, leverage, metrics: [{ label: '杠杆倍数', value: leverage, unit: '×' }, { label: '最大名义敞口', value: maximum, unit: 'USDT' }], warnings: [type === 'btcSingleAssetTrend' ? 'BTC单币策略仅用于独立模拟盘，不替换组合策略，也不会自动下单。' : '线上版本仅用于策略配置、行情与模拟盘观察，不会自动下单。'] };
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
  if (type === 'btcSingleAssetTrend' && symbol !== 'BTCUSDT') throw httpError('BTC单币策略只允许 BTCUSDT');
  const now = new Date().toISOString();
  const strategy = { id: crypto.randomUUID(), type, name, symbol, enabled: false, config: input.config || {}, riskSummary: genericRisk(input.config, type), createdAt: now, updatedAt: now };
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
  if (next.type === 'btcSingleAssetTrend' && next.symbol !== 'BTCUSDT') throw httpError('BTC单币策略只允许 BTCUSDT');
  next.riskSummary = genericRisk(next.config, next.type);
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
  const setup = await ensureAuthSetup(env);
  if (request.method === 'GET' && url.pathname === '/api/auth/session') {
    const session = await authSession(request, env);
    return json({ authenticated: Boolean(session), setupRequired: setup.setupRequired, user: session?.user || null });
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    if (setup.setupRequired) throw Object.assign(httpError('系统尚未初始化管理员，请先配置托管环境变量', 503), { code: 'SETUP_REQUIRED' });
    const result = await login(request, env);
    return json({ authenticated: true, user: result.user }, 200, { 'Set-Cookie': authCookie(result.token) });
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = cookies(request).quantflow_session;
    if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ authenticated: false }, 200, { 'Set-Cookie': authCookie('', 0) });
  }
  const session = await requireAuth(request, env);
  if (request.method === 'GET' && url.pathname === '/api/admin/users') {
    requireAdmin(session);
    return json({ users: await listUsers(env) });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/users') {
    requireAdmin(session);
    return json({ user: await createUser(request, env) }, 201);
  }
  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/);
  if (adminUserMatch && request.method === 'PATCH') {
    requireAdmin(session);
    return json({ user: await updateUser(request, env, adminUserMatch[1], session) });
  }
  const resetPasswordMatch = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)\/reset-password$/);
  if (resetPasswordMatch && request.method === 'POST') {
    requireAdmin(session);
    return json({ user: await resetUserPassword(request, env, resetPasswordMatch[1], session) });
  }
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
  if (request.method === 'GET' && url.pathname === '/api/paper-portfolio') {
    const [paper, btcPortfolio, optimizationReview] = await Promise.all([
      readState(request, env, 'paper-portfolio', 'paper-portfolio', { status: 'not_started', reports: [], positions: [] }),
      readState(request, env, 'btc-paper', 'btc-paper', { status: 'not_started', reports: [], positions: [], strategyType: 'btcSingleAssetTrend' }),
      readState(request, env, 'paper-review', 'paper-review', { status: 'not_started', candidates: [] }),
    ]);
    return json(combinePaperPortfolioState(paper, btcPortfolio, optimizationReview));
  }
  if (request.method === 'GET' && url.pathname === '/api/paper-portfolio/btc') return json(await readState(request, env, 'btc-paper', 'btc-paper', { status: 'not_started', reports: [], positions: [], strategyType: 'btcSingleAssetTrend' }));
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
      await ensureAuthSetup(env);
      const session = await authSession(request, env);
      if ((url.pathname === '/' || url.pathname === '/index.html') && !session) return redirect('/login.html?next=%2F');
      if (url.pathname === '/admin.html' && !session) return redirect('/login.html?next=%2Fadmin.html');
      if (url.pathname === '/admin.html' && session.user.role !== 'admin') return redirect('/');
      if (url.pathname === '/login.html' && session) return redirect(session.user.role === 'admin' ? '/admin.html' : '/');
      const response = await env.ASSETS.fetch(request);
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...securityHeaders() } });
    } catch (error) {
      return errorResponse(error);
    }
  },
};
