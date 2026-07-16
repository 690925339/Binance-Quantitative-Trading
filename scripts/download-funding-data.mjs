import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
const DEFAULT_BASE_URL = 'https://fapi.binance.com';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const [key, inlineValue] = item.slice(2).split('=', 2);
    options[key] = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

function parseDate(value, endOfDay = false) {
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}${suffix}` : value);
  if (!Number.isFinite(time)) throw new Error(`无效日期：${value}`);
  return time;
}

async function fetchPage(url, attempt = 1) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    if (attempt < 5) return fetchPage(url, attempt + 1);
    throw new Error(`资金费率请求失败：${error.message}`, { cause: error });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
      return fetchPage(url, attempt + 1);
    }
    throw new Error(`Binance 返回 ${response.status}：${payload?.msg || '未知错误'}`);
  }
  if (!Array.isArray(payload)) throw new Error('资金费率响应格式异常');
  return payload;
}

async function downloadSymbol(symbol, startTime, endTime, baseUrl) {
  const rows = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const query = new URLSearchParams({
      symbol,
      startTime: String(cursor),
      endTime: String(endTime),
      limit: '1000',
    });
    const page = await fetchPage(`${baseUrl}/fapi/v1/fundingRate?${query}`);
    if (!page.length) break;
    rows.push(...page.filter((item) => Number(item.fundingTime) >= startTime && Number(item.fundingTime) <= endTime));
    const nextCursor = Number(page.at(-1).fundingTime) + 1;
    if (nextCursor <= cursor) throw new Error(`${symbol} 资金费率分页游标未前进`);
    cursor = nextCursor;
    if (page.length < 1000) break;
  }
  return rows.sort((left, right) => Number(left.fundingTime) - Number(right.fundingTime));
}

const args = parseArgs(process.argv.slice(2));
const symbols = (args.symbols || DEFAULT_SYMBOLS.join(',')).split(',').map((item) => item.trim().toUpperCase());
const startTime = parseDate(args.start || '2023-01-01');
const endTime = parseDate(args.end || new Date().toISOString(), true);
const baseUrl = args['base-url'] || DEFAULT_BASE_URL;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(rootDir, args.output || path.join('data', 'market', 'funding'));
await fs.mkdir(outputDir, { recursive: true });

const datasets = [];
for (const symbol of symbols) {
  console.log(`[${symbol}] 下载资金费率`);
  const rows = await downloadSymbol(symbol, startTime, endTime, baseUrl);
  const header = 'symbol,funding_time,funding_time_utc,funding_rate,mark_price';
  const csv = `${header}\n${rows.map((item) => [
    symbol,
    item.fundingTime,
    new Date(Number(item.fundingTime)).toISOString(),
    item.fundingRate,
    item.markPrice,
  ].join(',')).join('\n')}\n`;
  const file = `${symbol}-funding.csv`;
  await fs.writeFile(path.join(outputDir, file), csv, 'utf8');
  datasets.push({
    symbol,
    file,
    rows: rows.length,
    firstFundingTimeUtc: rows.length ? new Date(Number(rows[0].fundingTime)).toISOString() : null,
    lastFundingTimeUtc: rows.length ? new Date(Number(rows.at(-1).fundingTime)).toISOString() : null,
    sha256: crypto.createHash('sha256').update(csv, 'utf8').digest('hex'),
  });
  console.log(`[${symbol}] ${rows.length} 条`);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  source: `${baseUrl}/fapi/v1/fundingRate`,
  requestedStartTimeUtc: new Date(startTime).toISOString(),
  requestedEndTimeUtc: new Date(endTime).toISOString(),
  datasets,
};
await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`清单已写入：${path.join(outputDir, 'manifest.json')}`);
