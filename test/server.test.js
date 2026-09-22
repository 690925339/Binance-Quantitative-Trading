import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer } from '../src/server.js';
import { UserStore } from '../src/user-store.js';

let origin;
let server;
let tempDir;
let adminCookie;

function authFetch(route, options = {}) {
  return fetch(`${origin}${route}`, {
    ...options,
    headers: { Cookie: adminCookie, ...options.headers },
  });
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quantflow-server-'));
  server = createServer({
    userStore: new UserStore(path.join(tempDir, 'users.json'), { iterations: 1_000 }),
    bootstrap: { username: 'admin', password: 'AdminPass-2026', displayName: '测试管理员' },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'AdminPass-2026' }),
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('健康检查明确返回现货测试网环境', async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', environment: 'spot-testnet' });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('未登录进入登录页，登录后首页包含移动端视口和模拟盘', async () => {
  const loginPage = await fetch(origin);
  const loginHtml = await loginPage.text();
  assert.match(loginPage.url, /\/login\.html/);
  assert.match(loginHtml, /id="loginForm"/);
  assert.doesNotMatch(loginHtml, /注册账号/);

  const response = await authFetch('/');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /QuantFlow/);
  assert.match(html, /id="paperPage"/);
  assert.match(html, /id="paperAttribution"/);
  assert.match(html, /id="paperCandidateList"/);
  assert.match(html, /id="btcPaperCard"/);
});

test('系统登录与测试网 API 会话使用独立保护', async () => {
  const anonymous = await fetch(`${origin}/api/account`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, 'AUTH_REQUIRED');

  const response = await authFetch('/api/account');
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /API 会话/);
});

test('拒绝无效交易对格式', async () => {
  const response = await authFetch('/api/market?symbol=BTC%2FUSDT');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /交易对格式/);
});

test('策略目录包含BTC单币在内的十一类可配置策略且明确不自动下单', async () => {
  const response = await authFetch('/api/strategies/catalog');
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.executionMode, 'CONFIG_ONLY');
  assert.deepEqual(payload.strategies.map((item) => item.type), [
    'grid', 'martingale', 'dca', 'maCrossover', 'longShortTrend', 'longShortEnhanced', 'longShortHighReturn', 'monthlyAccuracyPortfolio', 'btcSingleAssetTrend', 'stableComposite', 'aggressiveComposite',
  ]);
  assert.ok(payload.strategies.every((item) => item.fields.length > 0));
  const longShortTrend = payload.strategies.find((item) => item.type === 'longShortTrend');
  assert.ok(longShortTrend.fields.some((item) => item.key === 'positionMode'));
  assert.equal(longShortTrend.portfolio, true);
  assert.equal(longShortTrend.universe.length, 6);
  const longShortEnhanced = payload.strategies.find((item) => item.type === 'longShortEnhanced');
  assert.equal(longShortEnhanced.portfolio, true);
  assert.equal(longShortEnhanced.fields.find((item) => item.key === 'targetVolatilityPercent').default, 15);
  const longShortHighReturn = payload.strategies.find((item) => item.type === 'longShortHighReturn');
  assert.equal(longShortHighReturn.riskLevel, '极高风险');
  assert.equal(longShortHighReturn.fields.find((item) => item.key === 'targetVolatilityPercent').default, 20);
  const monthlyAccuracy = payload.strategies.find((item) => item.type === 'monthlyAccuracyPortfolio');
  assert.equal(monthlyAccuracy.portfolio, true);
  assert.equal(monthlyAccuracy.fields.find((item) => item.key === 'marketNeutralWeightPercent').default, 85);
  assert.equal(monthlyAccuracy.fields.find((item) => item.key === 'maxGrossExposurePercent').default, 143);
  const btcSingle = payload.strategies.find((item) => item.type === 'btcSingleAssetTrend');
  assert.deepEqual(btcSingle.universe, ['BTCUSDT']);
  assert.equal(btcSingle.fields.find((item) => item.key === 'shortLookbackDays').default, 45);
  assert.equal(payload.strategies.find((item) => item.type === 'stableComposite').riskLevel, '稳健型');
  assert.equal(
    payload.strategies.find((item) => item.type === 'stableComposite').fields
      .find((item) => item.key === 'accuracyLeverageThresholdPercent').default,
    90,
  );
  assert.equal(payload.strategies.find((item) => item.type === 'aggressiveComposite').riskLevel, '进取型');
});

test('模拟盘接口无需测试网会话且日报数量参数受限', async () => {
  const response = await authFetch('/api/paper-portfolio');
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.mode, 'PAPER');
  assert.equal(payload.strategyType, 'btcSingleAssetTrend');
  assert.equal(payload.scope, 'btc_only');
  assert.equal(payload.equity, payload.btcPortfolio.equity);
  assert.equal(payload.initialCapital, payload.btcPortfolio.initialCapital);
  assert.deepEqual(payload.optimizationReview.candidates, []);
  assert.equal(payload.btcPortfolio.strategyType, 'btcSingleAssetTrend');

  const btc = await authFetch('/api/paper-portfolio/btc');
  assert.equal(btc.status, 200);
  assert.equal((await btc.json()).strategyType, 'btcSingleAssetTrend');

  const review = await authFetch('/api/paper-portfolio/review');
  assert.equal(review.status, 200);
  assert.equal((await review.json()).scope, 'btc_only');

  const reports = await authFetch('/api/paper-portfolio/reports?limit=7');
  assert.deepEqual((await reports.json()).reports, payload.reports.slice(-7).reverse());

  const invalid = await authFetch('/api/paper-portfolio/reports?limit=0');
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /1 到 365/);
});

test('管理员可新增和停用用户，普通用户不能访问后台', async () => {
  const created = await authFetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', displayName: '观察员', role: 'user', password: 'ViewerPass-2026' }),
  });
  assert.equal(created.status, 201);
  const user = (await created.json()).user;

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: 'ViewerPass-2026' }),
  });
  const viewerCookie = login.headers.get('set-cookie').split(';')[0];
  const forbidden = await fetch(`${origin}/api/admin/users`, { headers: { Cookie: viewerCookie } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, 'ADMIN_REQUIRED');

  const disabled = await authFetch(`/api/admin/users/${user.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'disabled' }),
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).user.status, 'disabled');

  const expired = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: viewerCookie } });
  assert.equal((await expired.json()).authenticated, false);
});

test('管理员不能停用自己', async () => {
  const users = await (await authFetch('/api/admin/users')).json();
  const admin = users.users.find((user) => user.username === 'admin');
  const response = await authFetch(`/api/admin/users/${admin.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'disabled' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /不能停用自己/);
});
