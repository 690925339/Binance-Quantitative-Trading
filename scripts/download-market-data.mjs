import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
export const DEFAULT_BASE_URL = 'https://data-api.binance.vision';

export const INTERVAL_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};

const CSV_HEADER = [
  'symbol',
  'interval',
  'open_time',
  'open_time_utc',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'close_time',
  'close_time_utc',
  'quote_volume',
  'trades',
  'taker_buy_base_volume',
  'taker_buy_quote_volume',
].join(',');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const [rawKey, inlineValue] = item.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    options[key] = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

export function parseUtcDate(value, endOfDay = false) {
  if (value === undefined || value === null || value === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const time = Date.parse(`${value}${suffix}`);
    if (Number.isFinite(time)) return time;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`无效日期：${value}`);
  return time;
}

function lastCompleteCloseTime(now, intervalMs) {
  return Math.floor(now / intervalMs) * intervalMs - 1;
}

function iso(time) {
  return new Date(Number(time)).toISOString();
}

function csvRow(symbol, interval, item) {
  return [
    symbol,
    interval,
    item[0],
    iso(item[0]),
    item[1],
    item[2],
    item[3],
    item[4],
    item[5],
    item[6],
    iso(item[6]),
    item[7],
    item[8],
    item[9],
    item[10],
  ].join(',');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, fetchImpl = fetch, attempt = 1) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    if (attempt < 5) {
      await wait(300 * (2 ** (attempt - 1)));
      return fetchJson(url, fetchImpl, attempt + 1);
    }
    throw new Error(`请求 Binance 行情失败：${error.message}`, { cause: error });
  }

  if (response.status === 429 || response.status >= 500) {
    if (attempt < 5) {
      const retryAfter = Number(response.headers.get('retry-after')) * 1000;
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 300 * (2 ** (attempt - 1)));
      return fetchJson(url, fetchImpl, attempt + 1);
    }
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Binance 返回 ${response.status}：${payload?.msg || '未知错误'}`);
  }
  return payload;
}

export function inspectKlines(rows, intervalMs) {
  let gaps = 0;
  let duplicates = 0;
  let invalidOhlc = 0;
  let nonPositivePrice = 0;
  const gapRanges = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    if ([open, high, low, close].some((value) => value <= 0 || !Number.isFinite(value))) nonPositivePrice += 1;
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) invalidOhlc += 1;
    if (index === 0) continue;
    const difference = Number(row[0]) - Number(rows[index - 1][0]);
    if (difference === 0) duplicates += 1;
    else if (difference !== intervalMs) {
      const missingCandles = Math.max(1, Math.round(difference / intervalMs) - 1);
      gaps += missingCandles;
      gapRanges.push({
        fromOpenTimeUtc: iso(Number(rows[index - 1][0]) + intervalMs),
        toOpenTimeUtc: iso(Number(row[0]) - intervalMs),
        missingCandles,
      });
    }
  }
  return { gaps, gapRanges, duplicates, invalidOhlc, nonPositivePrice };
}

export async function downloadSymbol({
  symbol,
  interval,
  startTime,
  endTime,
  outputDir,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  progress = () => {},
}) {
  const intervalMs = INTERVAL_MS[interval];
  const rows = [];
  let cursor = startTime;
  let page = 0;

  while (cursor <= endTime) {
    const query = new URLSearchParams({
      symbol,
      interval,
      startTime: String(cursor),
      endTime: String(endTime),
      limit: '1000',
    });
    const url = `${baseUrl}/api/v3/klines?${query}`;
    let pageRows = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      pageRows = await fetchJson(url, fetchImpl);
      if (Array.isArray(pageRows)) break;
      if (attempt < 5) await wait(500 * (2 ** (attempt - 1)));
    }
    if (!Array.isArray(pageRows)) {
      throw new Error(`${symbol} K线响应格式异常：${pageRows?.msg || '未知响应'}`);
    }
    if (pageRows.length === 0) break;

    for (const row of pageRows) {
      const openTime = Number(row[0]);
      const closeTime = Number(row[6]);
      if (openTime >= startTime && closeTime <= endTime) rows.push(row);
    }
    page += 1;
    progress({ symbol, page, rows: rows.length, lastTime: Number(pageRows.at(-1)[0]) });

    const nextCursor = Number(pageRows.at(-1)[0]) + intervalMs;
    if (nextCursor <= cursor) throw new Error(`${symbol} 分页游标未前进`);
    cursor = nextCursor;
    if (pageRows.length < 1000) break;
    await wait(40);
  }

  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  const quality = inspectKlines(rows, intervalMs);
  const csv = `${CSV_HEADER}\n${rows.map((row) => csvRow(symbol, interval, row)).join('\n')}\n`;
  await fs.mkdir(outputDir, { recursive: true });
  const fileName = `${symbol}-${interval}.csv`;
  const filePath = path.join(outputDir, fileName);
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, csv, 'utf8');
  await fs.rename(temporaryPath, filePath);
  const sha256 = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');

  return {
    symbol,
    interval,
    file: fileName,
    rows: rows.length,
    firstOpenTime: rows.length ? Number(rows[0][0]) : null,
    firstOpenTimeUtc: rows.length ? iso(rows[0][0]) : null,
    lastOpenTime: rows.length ? Number(rows.at(-1)[0]) : null,
    lastOpenTimeUtc: rows.length ? iso(rows.at(-1)[0]) : null,
    sha256,
    quality,
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const interval = args.interval || '1h';
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) throw new Error(`暂不支持的周期：${interval}`);
  const symbols = (args.symbols || DEFAULT_SYMBOLS.join(','))
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length || symbols.some((item) => !/^[A-Z0-9]{5,20}$/.test(item))) {
    throw new Error('交易对参数无效');
  }

  const startTime = parseUtcDate(args.start || '2022-07-01');
  const requestedEnd = parseUtcDate(args.end, true);
  const endTime = Math.min(requestedEnd ?? Number.MAX_SAFE_INTEGER, lastCompleteCloseTime(Date.now(), intervalMs));
  if (startTime > endTime) throw new Error('开始时间必须早于结束时间');

  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outputDir = path.resolve(rootDir, args.output || path.join('data', 'market', 'spot', interval));
  const baseUrl = args.baseUrl || DEFAULT_BASE_URL;

  console.log(`开始下载：${symbols.join(', ')} | ${interval}`);
  console.log(`UTC 范围：${iso(startTime)} → ${iso(endTime)}`);
  const results = await mapLimit(symbols, Number(args.concurrency || 3), async (symbol) => {
    console.log(`[${symbol}] 开始`);
    const result = await downloadSymbol({
      symbol,
      interval,
      startTime,
      endTime,
      outputDir,
      baseUrl,
      progress: ({ page, rows }) => {
        if (page === 1 || page % 10 === 0) console.log(`[${symbol}] 第 ${page} 页，${rows} 行`);
      },
    });
    console.log(`[${symbol}] 完成：${result.rows} 行，缺口 ${result.quality.gaps}`);
    return result;
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: `${baseUrl}/api/v3/klines`,
    market: 'Binance Spot',
    quoteAsset: 'USDT',
    interval,
    requestedStartTimeUtc: iso(startTime),
    requestedEndTimeUtc: iso(endTime),
    columns: CSV_HEADER.split(','),
    datasets: results,
  };
  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`清单已写入：${path.join(outputDir, 'manifest.json')}`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
