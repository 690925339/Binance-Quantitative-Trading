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

test('策略目录包含四类可配置策略且明确不自动下单', async () => {
  const response = await fetch(`${origin}/api/strategies/catalog`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.executionMode, 'CONFIG_ONLY');
  assert.deepEqual(payload.strategies.map((item) => item.type), ['grid', 'martingale', 'dca', 'maCrossover']);
  assert.ok(payload.strategies.every((item) => item.fields.length > 0));
});
