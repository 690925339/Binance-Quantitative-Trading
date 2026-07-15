import assert from 'node:assert/strict';
import test from 'node:test';
import { BinanceClient, BinanceApiError, createSignature } from '../src/binance-client.js';

test('HMAC 签名与 Binance 官方示例一致', () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const query = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(
    createSignature(secret, query),
    'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71',
  );
});

test('签名请求使用服务端时间、API Key 请求头并过滤空参数', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/api/v3/time')) {
      return new Response(JSON.stringify({ serverTime: Date.now() }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ canTrade: true, balances: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new BinanceClient({ apiKey: 'test-api-key', apiSecret: 'test-secret-key', fetchImpl });

  await client.signedRequest('GET', '/api/v3/account', { omitZeroBalances: true, ignored: '' });

  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /omitZeroBalances=true/);
  assert.doesNotMatch(calls[1].url, /ignored/);
  assert.match(calls[1].url, /signature=[a-f0-9]{64}/);
  assert.equal(calls[1].options.headers['X-MBX-APIKEY'], 'test-api-key');
});

test('Binance 错误响应转换为安全的领域错误', async () => {
  const client = new BinanceClient({
    fetchImpl: async () => new Response(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    client.publicRequest('/api/v3/ticker/24hr', { symbol: 'UNKNOWN' }),
    (error) => error instanceof BinanceApiError && error.code === -1121 && error.status === 400,
  );
});
