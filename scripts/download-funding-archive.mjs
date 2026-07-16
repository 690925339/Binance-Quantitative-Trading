import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const ARCHIVE_BASE_URL = 'https://data.binance.vision/data/futures/um/monthly';

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

function monthSequence(startMonth, endMonth) {
  if (!/^\d{4}-\d{2}$/.test(startMonth) || !/^\d{4}-\d{2}$/.test(endMonth)) {
    throw new Error('月份必须使用 YYYY-MM');
  }
  const [startYear, startValue] = startMonth.split('-').map(Number);
  const [endYear, endValue] = endMonth.split('-').map(Number);
  const months = [];
  const cursor = new Date(Date.UTC(startYear, startValue - 1, 1));
  const end = new Date(Date.UTC(endYear, endValue - 1, 1));
  while (cursor <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

async function fetchBuffer(url, attempt = 1) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    if (attempt < 4) return fetchBuffer(url, attempt + 1);
    throw new Error(`归档下载失败：${url}：${error.message}`, { cause: error });
  }
  if (!response.ok) throw new Error(`归档下载失败：${url}：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function extractSingleCsv(buffer, archiveName, temporaryRoot) {
  const archivePath = path.join(temporaryRoot, archiveName);
  const extractDir = path.join(temporaryRoot, `${archiveName}.files`);
  await fs.mkdir(extractDir, { recursive: true });
  await fs.writeFile(archivePath, buffer);
  const extracted = spawnSync('tar.exe', ['-xf', archivePath, '-C', extractDir], { encoding: 'utf8' });
  if (extracted.status !== 0) throw new Error(`解压失败：${archiveName}：${extracted.stderr}`);
  const files = (await fs.readdir(extractDir)).filter((file) => file.toLowerCase().endsWith('.csv'));
  if (files.length !== 1) throw new Error(`${archiveName} 应只包含一个 CSV`);
  return fs.readFile(path.join(extractDir, files[0]), 'utf8');
}

function parseFundingCsv(text) {
  const rows = text.trim().split(/\r?\n/).map((line) => line.split(','));
  const hasHeader = rows[0]?.[0] === 'calc_time';
  const data = hasHeader ? rows.slice(1) : rows;
  const timeIndex = hasHeader ? rows[0].indexOf('calc_time') : 0;
  const rateIndex = hasHeader ? rows[0].indexOf('last_funding_rate') : 2;
  if (timeIndex < 0 || rateIndex < 0) throw new Error('资金费率归档缺少 calc_time 或 last_funding_rate');
  return data.map((row) => ({ fundingTime: Number(row[timeIndex]), fundingRate: Number(row[rateIndex]) }))
    .filter((item) => Number.isFinite(item.fundingTime) && Number.isFinite(item.fundingRate));
}

function parseMarkPriceCsv(text) {
  const rows = text.trim().split(/\r?\n/).map((line) => line.split(','));
  const data = Number.isFinite(Number(rows[0]?.[0])) ? rows : rows.slice(1);
  return new Map(data.map((row) => [Number(row[0]), Number(row[1])])
    .filter(([time, price]) => Number.isFinite(time) && Number.isFinite(price) && price > 0));
}

const args = parseArgs(process.argv.slice(2));
const symbols = (args.symbols || DEFAULT_SYMBOLS.join(',')).split(',').map((item) => item.trim().toUpperCase());
const months = monthSequence(args.start || '2023-01', args.end || '2026-06');
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(rootDir, args.output || path.join('data', 'market', 'funding'));
const temporaryRoot = path.join(outputDir, '.archive-tmp');
const resolvedOutput = path.resolve(outputDir);
const resolvedTemporary = path.resolve(temporaryRoot);
if (!resolvedTemporary.startsWith(`${resolvedOutput}${path.sep}`)) throw new Error('临时目录越出资金费率输出目录');
await fs.mkdir(temporaryRoot, { recursive: true });

const datasets = [];
try {
  for (const symbol of symbols) {
    const merged = [];
    let sourceRows = 0;
    for (const month of months) {
      const fundingName = `${symbol}-fundingRate-${month}.zip`;
      const markName = `${symbol}-1h-${month}.zip`;
      const fundingUrl = `${ARCHIVE_BASE_URL}/fundingRate/${symbol}/${fundingName}`;
      const markUrl = `${ARCHIVE_BASE_URL}/markPriceKlines/${symbol}/1h/${markName}`;
      const [fundingBuffer, markBuffer] = await Promise.all([fetchBuffer(fundingUrl), fetchBuffer(markUrl)]);
      const [fundingText, markText] = await Promise.all([
        extractSingleCsv(fundingBuffer, fundingName, temporaryRoot),
        extractSingleCsv(markBuffer, `mark-${markName}`, temporaryRoot),
      ]);
      const markByTime = parseMarkPriceCsv(markText);
      const fundingRows = parseFundingCsv(fundingText);
      sourceRows += fundingRows.length;
      const rows = fundingRows.map((item) => ({
        ...item,
        markPrice: markByTime.get(Math.floor(item.fundingTime / 3_600_000) * 3_600_000),
      }))
        .filter((item) => Number.isFinite(item.markPrice));
      merged.push(...rows);
      console.log(`[${symbol}] ${month}：资金 ${fundingRows.length}，标记价 ${markByTime.size}，匹配 ${rows.length}`);
    }
    merged.sort((left, right) => left.fundingTime - right.fundingTime);
    const duplicateTimes = merged.length - new Set(merged.map((item) => item.fundingTime)).size;
    if (duplicateTimes) throw new Error(`${symbol} 存在 ${duplicateTimes} 个重复资金结算时间`);
    const header = 'symbol,funding_time,funding_time_utc,funding_rate,mark_price';
    const csv = `${header}\n${merged.map((item) => [
      symbol,
      item.fundingTime,
      new Date(item.fundingTime).toISOString(),
      item.fundingRate,
      item.markPrice,
    ].join(',')).join('\n')}\n`;
    const file = `${symbol}-funding.csv`;
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, file), csv, 'utf8');
    datasets.push({
      symbol,
      file,
      rows: merged.length,
      sourceRows,
      unmatchedRows: sourceRows - merged.length,
      duplicateTimes,
      firstFundingTimeUtc: merged.length ? new Date(merged[0].fundingTime).toISOString() : null,
      lastFundingTimeUtc: merged.length ? new Date(merged.at(-1).fundingTime).toISOString() : null,
      sha256: crypto.createHash('sha256').update(csv, 'utf8').digest('hex'),
    });
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: ARCHIVE_BASE_URL,
    requestedMonths: { start: months[0], end: months.at(-1) },
    datasets,
  };
  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`清单已写入：${path.join(outputDir, 'manifest.json')}`);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
