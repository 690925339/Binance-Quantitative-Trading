import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=0&format=json';

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPayload(url, fetchImpl = fetch) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) return await response.json();
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Alternative.me 返回 ${response.status}`);
      }
    } catch (error) {
      if (attempt === 5) throw error;
    }
    await wait(500 * (2 ** (attempt - 1)));
  }
  throw new Error('Alternative.me 请求失败');
}

export function parseFearGreedPayload(payload, { startDate = '2022-07-01', endDate = '9999-12-31' } = {}) {
  if (payload?.metadata?.error) throw new Error(`恐惧指数接口错误：${payload.metadata.error}`);
  if (!Array.isArray(payload?.data)) throw new Error('恐惧指数响应格式异常');
  const byDate = new Map();
  for (const item of payload.data) {
    const value = Number(item.value);
    const timestamp = Number(item.timestamp);
    if (!Number.isFinite(value) || value < 0 || value > 100 || !Number.isFinite(timestamp)) continue;
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    if (date < startDate || date > endDate) continue;
    byDate.set(date, {
      date,
      value,
      classification: String(item.value_classification || ''),
      timestamp,
    });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export async function main(argv = process.argv.slice(2), fetchImpl = fetch) {
  const args = parseArgs(argv);
  const startDate = args.start || '2022-07-01';
  const endDate = args.end || new Date().toISOString().slice(0, 10);
  const url = args.url || DEFAULT_FEAR_GREED_URL;
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outputDir = path.resolve(rootDir, args.output || path.join('data', 'market', 'sentiment'));
  const payload = await fetchPayload(url, fetchImpl);
  const rows = parseFearGreedPayload(payload, { startDate, endDate });
  if (!rows.length) throw new Error('指定范围没有恐惧指数数据');
  const csv = `date,value,classification,timestamp\n${rows.map((item) => (
    `${item.date},${item.value},${JSON.stringify(item.classification)},${item.timestamp}`
  )).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: url,
    attribution: 'Data from Alternative.me Crypto Fear & Greed Index',
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    firstDate: rows[0].date,
    lastDate: rows.at(-1).date,
    rows: rows.length,
    file: 'fear-greed.csv',
    sha256,
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, manifest.file), csv, 'utf8');
  await fs.writeFile(path.join(outputDir, 'fear-greed-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`恐惧指数完成：${rows.length} 行 | ${rows[0].date} 至 ${rows.at(-1).date}`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
