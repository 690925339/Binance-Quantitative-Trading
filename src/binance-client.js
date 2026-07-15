import crypto from 'node:crypto';

export const TESTNET_API_BASE = 'https://testnet.binance.vision';

export class BinanceApiError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'BinanceApiError';
    this.status = options.status ?? 502;
    this.code = options.code ?? null;
    this.details = options.details ?? null;
  }
}

export function createSignature(secret, queryString) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function compactParams(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

export class BinanceClient {
  constructor({ apiKey = '', apiSecret = '', baseUrl = TESTNET_API_BASE, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeOffset = 0;
    this.timeSyncedAt = 0;
  }

  async publicRequest(path, params = {}) {
    const query = new URLSearchParams(compactParams(params)).toString();
    return this.#request(`${path}${query ? `?${query}` : ''}`);
  }

  async syncTime(force = false) {
    if (!force && Date.now() - this.timeSyncedAt < 30_000) return this.timeOffset;
    const startedAt = Date.now();
    const { serverTime } = await this.publicRequest('/api/v3/time');
    const endedAt = Date.now();
    this.timeOffset = Number(serverTime) - Math.round((startedAt + endedAt) / 2);
    this.timeSyncedAt = endedAt;
    return this.timeOffset;
  }

  async signedRequest(method, path, params = {}) {
    if (!this.apiKey || !this.apiSecret) {
      throw new BinanceApiError('尚未配置 Binance API 凭证', { status: 401 });
    }

    await this.syncTime();
    const signedParams = compactParams({
      ...params,
      recvWindow: 5000,
      timestamp: Date.now() + this.timeOffset,
    });
    const query = new URLSearchParams(signedParams).toString();
    const signature = createSignature(this.apiSecret, query);
    return this.#request(`${path}?${query}&signature=${signature}`, {
      method,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
  }

  async account() {
    return this.signedRequest('GET', '/api/v3/account', { omitZeroBalances: true });
  }

  async testOrder(order) {
    return this.signedRequest('POST', '/api/v3/order/test', order);
  }

  async #request(path, options = {}) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new BinanceApiError('连接 Binance 超时，请稍后重试', { cause: error });
      }
      throw new BinanceApiError('无法连接 Binance 测试网', { cause: error });
    }

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : { msg: await response.text() };

    if (!response.ok) {
      throw new BinanceApiError(payload.msg || 'Binance 请求失败', {
        status: response.status >= 500 ? 502 : 400,
        code: payload.code,
        details: payload,
      });
    }

    return payload;
  }
}
