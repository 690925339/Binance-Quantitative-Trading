import fs from 'node:fs/promises';
import path from 'node:path';
import { addUtcDays, fetchPaperMarketData, latestCompletePaperCycleDate } from './monthly-accuracy-paper.js';
import { loadPaperResearchReplayMarket } from './paper-research-replay.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SOURCE = 'https://data-api.binance.vision/api/v3/klines';

function checkBar(bar) {
  if (!bar || !/^\d{4}-\d{2}-\d{2}$/.test(bar.date || '')
    || !Number.isFinite(Date.parse(`${bar.date}T00:00:00Z`))
    || new Date(`${bar.date}T00:00:00Z`).toISOString().slice(0, 10) !== bar.date
    || ['open', 'high', 'low', 'close'].some(key => !Number.isFinite(bar[key]) || bar[key] <= 0)
    || !Number.isFinite(bar.volume) || bar.volume < 0
    || bar.high < Math.max(bar.open, bar.close, bar.low)
    || bar.low > Math.min(bar.open, bar.close, bar.high)) throw new Error(`Invalid daily OHLC: ${bar?.date}`);
}

export function validateBtcDailyBars(bars) {
  if (!Array.isArray(bars) || !bars.length) throw new Error('Daily OHLC is empty');
  for (const [index, bar] of bars.entries()) {
    checkBar(bar);
    if (index > 0 && bar.date !== addUtcDays(bars[index - 1].date, 1)) throw new Error(`Nonconsecutive daily OHLC: ${bar.date}`);
  }
  return bars;
}

/** Derive actual UTC daily OHLC from every hourly bar, never from close-only data. */
export function aggregateBtcHourlyCsv(text, { officialDailyOverrides = [] } = {}) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const keys = header.split(',');
  for (const field of ['symbol', 'interval', 'open_time', 'open_time_utc', 'open', 'high', 'low', 'close', 'volume', 'close_time']) {
    if (!keys.includes(field)) throw new Error(`Hourly CSV missing ${field}`);
  }
  let previousTime = null;
  const groups = new Map();
  const overrides = new Map(officialDailyOverrides.map(bar => { checkBar(bar); return [bar.date, bar]; }));
  for (const line of lines) {
    const values = line.split(',');
    const row = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
    const time = Number(row.open_time);
    const closeTime = Number(row.close_time);
    const officialDay = overrides.has(row.open_time_utc?.slice(0, 10));
    if (row.symbol !== 'BTCUSDT' || row.interval !== '1h' || !Number.isSafeInteger(time)
      || time % HOUR !== 0 || !Number.isSafeInteger(closeTime) || closeTime < time || closeTime >= time + HOUR
      || (closeTime !== time + HOUR - 1 && !officialDay)
      || !row.open_time_utc || Date.parse(row.open_time_utc) !== time
      || (previousTime !== null && (time <= previousTime || (time !== previousTime + HOUR
        && (new Date(previousTime).toISOString().slice(0, 10) !== new Date(time).toISOString().slice(0, 10)
          || !overrides.has(new Date(time).toISOString().slice(0, 10))))))) throw new Error(`Invalid or missing hourly BTC bar: ${row.open_time_utc}, close time ${row.close_time}`);
    previousTime = time;
    const date = new Date(time).toISOString().slice(0, 10);
    const bar = { date, hour: new Date(time).getUTCHours(), ...Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(key => [key, Number(row[key])])) };
    checkBar(bar);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(bar);
  }
  const daily = [...groups].map(([date, rows]) => {
    const aggregate = { date, open: rows[0].open, high: Math.max(...rows.map(row => row.high)),
      low: Math.min(...rows.map(row => row.low)), close: rows.at(-1).close,
      volume: rows.reduce((sum, row) => sum + row.volume, 0) };
    if (rows.length === 24) return aggregate;
    const official = overrides.get(date);
    if (!official) throw new Error(`Incomplete UTC day: ${date}`);
    if ((rows[0].hour === 0 && Math.abs(official.open - aggregate.open) > 1e-8)
      || (rows.at(-1).hour === 23 && Math.abs(official.close - aggregate.close) > 1e-8)
      || official.high < aggregate.high - 1e-8 || official.low > aggregate.low + 1e-8
      || official.volume < aggregate.volume - Math.max(1, aggregate.volume) * 1e-8) {
      throw new Error(`Official daily bar contradicts available hours: ${date}`);
    }
    return { ...official };
  });
  return validateBtcDailyBars(daily);
}

export function parseBtcDailyKlines(rows, startDate, endDate) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Daily kline response is empty');
  const bars = rows.map(row => {
    if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] % DAY !== 0
      || row[6] !== row[0] + DAY - 1) throw new Error('Invalid daily kline timestamp');
    return { date: new Date(row[0]).toISOString().slice(0, 10), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) };
  });
  validateBtcDailyBars(bars);
  if (bars[0].date !== startDate || bars.at(-1).date !== endDate) throw new Error('Incomplete daily kline response range');
  return bars;
}

export function mergeBtcDailyBars(local, tail) {
  validateBtcDailyBars(local);
  validateBtcDailyBars(tail);
  const merged = new Map(local.map(bar => [bar.date, bar]));
  let overlap = 0;
  for (const bar of tail) {
    if (merged.has(bar.date)) {
      overlap += 1;
      for (const key of ['open', 'high', 'low', 'close', 'volume']) {
        const prior = merged.get(bar.date)[key];
        const tolerance = key === 'volume' ? Math.max(1, Math.abs(prior)) * 1e-8 : 1e-8;
        if (Math.abs(prior - bar[key]) > tolerance) throw new Error(`OHLC overlap mismatch: ${bar.date} ${key}`);
      }
    }
    merged.set(bar.date, bar);
  }
  if (!overlap) throw new Error('Daily OHLC tail must overlap local history');
  return validateBtcDailyBars([...merged.values()].sort((a, b) => a.date.localeCompare(b.date)));
}

export function validateCompletedSnapshot(endDate, retrievedAt, now = Date.now(), isMark = false) {
  const completedAt = Date.parse(`${endDate}T00:00:00Z`) + (isMark ? HOUR : DAY);
  const retrieved = Date.parse(retrievedAt);
  if (!Number.isFinite(completedAt) || !Number.isFinite(retrieved)
    || retrieved < completedAt || retrieved > now || completedAt > now) throw new Error('Snapshot predates complete market data or is future-dated');
}

async function dailySnapshot(outputDir, startDate, endDate, now) {
  const cacheFile = path.join(outputDir, `btc-official-daily-${startDate}-${endDate}.json`);
  let cache;
  try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const query = new URLSearchParams({ symbol: 'BTCUSDT', interval: '1d',
      startTime: String(Date.parse(`${startDate}T00:00:00Z`)),
      endTime: String(Date.parse(`${endDate}T00:00:00Z`) + DAY - 1), limit: '1000' });
    const response = await fetch(`${SOURCE}?${query}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Public BTC daily data HTTP ${response.status}`);
    const raw = await response.json();
    parseBtcDailyKlines(raw, startDate, endDate);
    cache = { source: SOURCE, symbol: 'BTCUSDT', interval: '1d', startDate, endDate,
      retrievedAt: new Date().toISOString(), raw };
    validateCompletedSnapshot(endDate, cache.retrievedAt, Math.max(now, Date.now()));
    await fs.writeFile(cacheFile, JSON.stringify(cache), 'utf8');
  }
  if (cache.source !== SOURCE || cache.symbol !== 'BTCUSDT' || cache.interval !== '1d'
    || cache.startDate !== startDate || cache.endDate !== endDate) throw new Error('Daily OHLC cache metadata mismatch');
  validateCompletedSnapshot(endDate, cache.retrievedAt, Math.max(now, Date.now()));
  return { bars: parseBtcDailyKlines(cache.raw, startDate, endDate), cacheFile, retrievedAt: cache.retrievedAt };
}

export async function loadBtcOpenSourceMarket({ rootDir, outputDir, endDate, profile, now = Date.now() }) {
  if (endDate > latestCompletePaperCycleDate(now)) throw new Error('Requested BTC cycle is not complete');
  const market = await loadPaperResearchReplayMarket({ rootDir, symbols: ['BTCUSDT'], profiles: [profile] });
  const manifest = JSON.parse(await fs.readFile(path.join(rootDir, 'data/market/spot/1h/manifest.json'), 'utf8'));
  const dataset = manifest.datasets.find(item => item.symbol === 'BTCUSDT');
  const officialDailyOverrides = [], gapReplacements = [];
  const gapDates = new Set();
  for (const gap of dataset.quality?.gapRanges || []) {
    for (let date = gap.fromOpenTimeUtc.slice(0, 10); date <= gap.toOpenTimeUtc.slice(0, 10); date = addUtcDays(date, 1)) gapDates.add(date);
  }
  for (const date of [...gapDates].sort()) {
    const snapshot = await dailySnapshot(outputDir, date, date, now);
    officialDailyOverrides.push(...snapshot.bars);
    gapReplacements.push({ date, cacheFile: snapshot.cacheFile, retrievedAt: snapshot.retrievedAt });
  }
  let dailyBars = aggregateBtcHourlyCsv(await fs.readFile(path.join(rootDir, 'data/market/spot/1h', dataset.file), 'utf8'), { officialDailyOverrides });
  const cutoff = addUtcDays(endDate, -1);
  const provenance = { hourlyFile: dataset.file, dailySource: SOURCE, dailyInterval: '1d', signalCutoff: cutoff, gapReplacements };
  if (endDate > market.throughCycleDate) {
    const tailFile = path.join(outputDir, `btc-open-source-market-tail-${endDate}.json`);
    let snapshot;
    try { snapshot = JSON.parse(await fs.readFile(tailFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const tail = await fetchPaperMarketData({ symbols: ['BTCUSDT'], historyStartDate: market.signalEndDate,
        signalEndDate: cutoff, markStartCycleDate: market.throughCycleDate, markEndCycleDate: endDate });
      snapshot = { source: SOURCE, endDate, retrievedAt: new Date().toISOString(), tail };
      await fs.writeFile(tailFile, JSON.stringify(snapshot), 'utf8');
    }
    if (snapshot.source !== SOURCE || snapshot.endDate !== endDate) throw new Error('Mark tail metadata mismatch');
    validateCompletedSnapshot(endDate, snapshot.retrievedAt, Math.max(now, Date.now()), true);
    const tail = snapshot.tail;
    const rows = new Map(market.seriesBySymbol.BTCUSDT.map(row => [row.date, row.close]));
    for (const row of tail.seriesBySymbol.BTCUSDT) {
      if (!Number.isFinite(row.close) || row.close <= 0) throw new Error('Invalid signal tail price');
      if (rows.has(row.date) && Math.abs(rows.get(row.date) - row.close) > 1e-8) throw new Error(`Signal overlap mismatch: ${row.date}`);
      rows.set(row.date, row.close);
    }
    market.seriesBySymbol.BTCUSDT = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
    for (const [date, prices] of Object.entries(tail.markPricesByCycleDate)) {
      const previous = market.markPricesByCycleDate[date]?.BTCUSDT;
      if (previous !== undefined && Math.abs(previous - prices.BTCUSDT) > 1e-8) throw new Error(`Mark overlap mismatch: ${date}`);
      market.markPricesByCycleDate[date] = prices;
    }
    provenance.markTailFile = tailFile;
    provenance.markTailRetrievedAt = snapshot.retrievedAt;
  }
  if (dailyBars.at(-1).date < cutoff) {
    const startDate = dailyBars.at(-1).date;
    const snapshot = await dailySnapshot(outputDir, startDate, cutoff, now);
    dailyBars = mergeBtcDailyBars(dailyBars, snapshot.bars);
    provenance.dailyTailFile = snapshot.cacheFile;
    provenance.dailyTailRetrievedAt = snapshot.retrievedAt;
  }
  dailyBars = dailyBars.filter(bar => bar.date <= cutoff);
  market.seriesBySymbol.BTCUSDT = market.seriesBySymbol.BTCUSDT.filter(row => row.date <= cutoff);
  market.markPricesByCycleDate = Object.fromEntries(Object.entries(market.markPricesByCycleDate).filter(([date]) => date <= endDate));
  market.throughCycleDate = endDate;
  market.signalEndDate = cutoff;
  if (dailyBars.length !== market.seriesBySymbol.BTCUSDT.length || dailyBars.at(-1).date !== cutoff) throw new Error('OHLC/signal history length mismatch');
  for (const [index, bar] of dailyBars.entries()) {
    const signal = market.seriesBySymbol.BTCUSDT[index];
    if (bar.date !== signal.date || Math.abs(bar.close - signal.close) > 1e-8) throw new Error(`OHLC/signal close mismatch: ${bar.date}`);
  }
  return { market, dailyBars, provenance };
}
