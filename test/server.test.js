import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { server } from '../src/server.js';

let origin;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('健康检查明确返回现货测试网环境', async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', environment: 'spot-testnet' });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('首页可访问且包含移动端视口', async () => {
  const response = await fetch(origin);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /QuantFlow/);
  assert.match(html, /id="paperPage"/);
});

test('未连接时私有账户接口返回 401', async () => {
  const response = await fetch(`${origin}/api/account`);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /API 会话/);
});

test('拒绝无效交易对格式', async () => {
  const response = await fetch(`${origin}/api/market?symbol=BTC%2FUSDT`);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /交易对格式/);
});

test('策略目录包含十类可配置策略且明确不自动下单', async () => {
  const response = await fetch(`${origin}/api/strategies/catalog`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.executionMode, 'CONFIG_ONLY');
  assert.deepEqual(payload.strategies.map((item) => item.type), [
    'grid', 'martingale', 'dca', 'maCrossover', 'longShortTrend', 'longShortEnhanced', 'longShortHighReturn', 'monthlyAccuracyPortfolio', 'stableComposite', 'aggressiveComposite',
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
  assert.equal(payload.strategies.find((item) => item.type === 'stableComposite').riskLevel, '稳健型');
  assert.equal(
    payload.strategies.find((item) => item.type === 'stableComposite').fields
      .find((item) => item.key === 'accuracyLeverageThresholdPercent').default,
    90,
  );
  assert.equal(payload.strategies.find((item) => item.type === 'aggressiveComposite').riskLevel, '进取型');
});

test('模拟盘接口无需测试网会话且日报数量参数受限', async () => {
  const response = await fetch(`${origin}/api/paper-portfolio`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.mode, 'PAPER');
  assert.equal(payload.strategyType, 'monthlyAccuracyPortfolio');

  const invalid = await fetch(`${origin}/api/paper-portfolio/reports?limit=0`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /1 到 365/);
});
