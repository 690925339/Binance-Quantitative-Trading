import fs from 'node:fs/promises';
import path from 'node:path';
import {
  addUtcDays,
  advancePaperState,
  initializePaperState,
  PAPER_SYMBOLS,
} from './monthly-accuracy-paper.js';

const DAY_MS = 86_400_000;

function round(value, digits = 8) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0)
    / (values.length - 1));
}

function percentile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1));
  return sorted[index];
}

function expectedShortfall95(returns) {
  if (!returns.length) return 0;
  const sorted = [...returns].sort((left, right) => left - right);
  const count = Math.max(1, Math.ceil(sorted.length * 0.05));
  return Math.max(0, -mean(sorted.slice(0, count)));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortedKeys(map) {
  return [...map.keys()].sort((left, right) => left.localeCompare(right));
}

function assertSameDates(reference, candidate, label) {
  if (reference.length !== candidate.length
    || reference.some((date, index) => date !== candidate[index])) {
    throw new Error(`${label} 的边界K线日期不一致`);
  }
}

function assertConsecutiveDates(dates, label) {
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index] !== addUtcDays(dates[index - 1], 1)) {
      throw new Error(`${label} 在 ${dates[index - 1]} 与 ${dates[index]} 之间不连续`);
    }
  }
}

function parseBoundaryRows(text, fileName) {
  const [headerLine, ...rows] = String(text).trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const dateIndex = headers.indexOf('open_time_utc');
  const closeIndex = headers.indexOf('close');
  if (dateIndex < 0 || closeIndex < 0) {
    throw new Error(`${fileName} 缺少 open_time_utc 或 close 字段`);
  }
  const dailyCloseByDate = new Map();
  const markCloseByCycleDate = new Map();
  for (const row of rows) {
    const columns = row.split(',');
    const timestamp = columns[dateIndex];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp || '')) {
      throw new Error(`${fileName} 包含无效 open_time_utc`);
    }
    const boundary = timestamp.slice(11, 19);
    if (boundary !== '00:00:00' && boundary !== '23:00:00') continue;
    const date = timestamp.slice(0, 10);
    const close = Number(columns[closeIndex]);
    if (!Number.isFinite(close) || close <= 0) {
      throw new Error(`${fileName} ${timestamp} 的 close 无效`);
    }
    const target = boundary === '00:00:00' ? markCloseByCycleDate : dailyCloseByDate;
    if (target.has(date)) throw new Error(`${fileName} ${date} 存在重复的 ${boundary} 边界K线`);
    target.set(date, close);
  }
  if (!dailyCloseByDate.size || !markCloseByCycleDate.size) {
    throw new Error(`${fileName} 缺少研究所需的00:00或23:00边界K线`);
  }
  assertConsecutiveDates(sortedKeys(dailyCloseByDate), `${fileName} 日线信号`);
  assertConsecutiveDates(sortedKeys(markCloseByCycleDate), `${fileName} 09:00估值`);
  return { dailyCloseByDate, markCloseByCycleDate };
}

export function paperProfileWarmupDays(profile) {
  const marketNeutral = profile?.marketNeutral || {};
  const trend = profile?.trend || {};
  const marketNeutralWindows = [Number(marketNeutral.lookbackDays || 0)];
  if (marketNeutral.adaptiveBreadthEnabled) {
    marketNeutralWindows.push(
      ...(marketNeutral.confirmationLookbackDays || []).map(Number),
      Number(marketNeutral.adaptiveVolatilityWindowDays || 0),
    );
  }
  if (marketNeutral.spreadRiskEnabled) {
    marketNeutralWindows.push(Number(marketNeutral.spreadVolatilityWindowDays || 0));
  }
  const trendWindows = [
    ...(trend.lookbackDays || []).map(Number),
    Number(trend.volatilityWindowDays || 0),
    Number(trend.shortConfirmationLookbackDays || 0),
  ];
  const warmupDays = Math.max(0, ...marketNeutralWindows, ...trendWindows);
  if (!Number.isInteger(warmupDays) || warmupDays < 1) {
    throw new Error(`策略 ${profile?.id || 'unknown'} 的预热窗口无效`);
  }
  return warmupDays;
}

export function paperProfileWithCostMultiplier(profile, multiplier, idSuffix = null) {
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error('成本倍数必须大于0');
  const next = clone(profile);
  const suffix = idSuffix || `cost-${multiplier}`;
  next.id = `${profile.id}-${suffix}`;
  next.name = `${profile.name}｜${multiplier}x成本研究`;
  next.allocationTradingCostRate = Number(next.allocationTradingCostRate || 0) * multiplier;
  for (const componentName of ['marketNeutral', 'trend']) {
    const component = next[componentName];
    component.tradingCostRate = Number(component.tradingCostRate || 0) * multiplier;
    component.dailyCarryCostRate = Number(component.dailyCarryCostRate || 0) * multiplier;
  }
  return next;
}

export async function loadPaperResearchReplayMarket({
  rootDir,
  profiles,
  developmentStartDate = '2023-01-01',
  throughCycleDate = null,
  symbols = PAPER_SYMBOLS,
}) {
  if (!Array.isArray(profiles) || !profiles.length) throw new Error('至少需要一个研究策略');
  const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
  const manifest = JSON.parse(await fs.readFile(path.join(marketDir, 'manifest.json'), 'utf8'));
  const datasetBySymbol = new Map((manifest.datasets || []).map((item) => [item.symbol, item]));
  const loaded = await Promise.all(symbols.map(async (symbol) => {
    const dataset = datasetBySymbol.get(symbol);
    if (!dataset) throw new Error(`行情清单缺少 ${symbol}`);
    const text = await fs.readFile(path.join(marketDir, dataset.file), 'utf8');
    return { symbol, dataset, ...parseBoundaryRows(text, dataset.file) };
  }));

  const dailyDates = sortedKeys(loaded[0].dailyCloseByDate);
  const markDates = sortedKeys(loaded[0].markCloseByCycleDate);
  for (const item of loaded.slice(1)) {
    assertSameDates(dailyDates, sortedKeys(item.dailyCloseByDate), `${item.symbol} 日线信号`);
    assertSameDates(markDates, sortedKeys(item.markCloseByCycleDate), `${item.symbol} 09:00估值`);
  }
  const dailyDateSet = new Set(dailyDates);
  const markDateSet = new Set(markDates);
  const availableCycleDates = markDates.filter((cycleDate) => (
    dailyDateSet.has(addUtcDays(cycleDate, -1))
  ));
  const latestCycleDate = availableCycleDates.at(-1);
  const resolvedThroughCycleDate = throughCycleDate || latestCycleDate;
  if (!markDateSet.has(resolvedThroughCycleDate)
    || !dailyDateSet.has(addUtcDays(resolvedThroughCycleDate, -1))) {
    throw new Error(`研究截止 ${resolvedThroughCycleDate} 缺少信号或09:00边界K线`);
  }
  if (resolvedThroughCycleDate > latestCycleDate) {
    throw new Error(`研究截止 ${resolvedThroughCycleDate} 晚于可用周期 ${latestCycleDate}`);
  }

  const commonWarmupDays = Math.max(...profiles.map(paperProfileWarmupDays));
  let initializationSignalDate = null;
  let initializationCycleDate = null;
  for (let index = commonWarmupDays; index < dailyDates.length; index += 1) {
    const signalDate = dailyDates[index];
    const cycleDate = addUtcDays(signalDate, 1);
    if (cycleDate >= developmentStartDate) break;
    if (markDateSet.has(cycleDate)) {
      initializationSignalDate = signalDate;
      initializationCycleDate = cycleDate;
      break;
    }
  }
  if (!initializationCycleDate) {
    throw new Error(`现有历史不足以在 ${developmentStartDate} 前完成 ${commonWarmupDays} 天共同预热`);
  }

  const signalEndDate = addUtcDays(resolvedThroughCycleDate, -1);
  const includedDailyDates = dailyDates.filter((date) => date <= signalEndDate);
  const includedCycleDates = markDates.filter((date) => (
    date >= initializationCycleDate && date <= resolvedThroughCycleDate
  ));
  const seriesBySymbol = Object.fromEntries(loaded.map((item) => [
    item.symbol,
    includedDailyDates.map((date) => ({ date, close: item.dailyCloseByDate.get(date) })),
  ]));
  const markPricesByCycleDate = Object.fromEntries(includedCycleDates.map((cycleDate) => [
    cycleDate,
    Object.fromEntries(loaded.map((item) => [
      item.symbol,
      item.markCloseByCycleDate.get(cycleDate),
    ])),
  ]));

  return {
    symbols: [...symbols],
    seriesBySymbol,
    markPricesByCycleDate,
    initializationSignalDate,
    initializationCycleDate,
    commonWarmupDays,
    latestCycleDate,
    throughCycleDate: resolvedThroughCycleDate,
    signalEndDate,
    source: {
      generatedAt: manifest.generatedAt || null,
      requestedStartTimeUtc: manifest.requestedStartTimeUtc || null,
      requestedEndTimeUtc: manifest.requestedEndTimeUtc || null,
      datasets: loaded.map((item) => ({
        symbol: item.symbol,
        file: item.dataset.file,
        sha256: item.dataset.sha256 || null,
      })),
    },
  };
}

function marketThroughCycle(market, throughCycleDate) {
  if (throughCycleDate < market.initializationCycleDate
    || throughCycleDate > market.throughCycleDate) {
    throw new Error(`重放截止 ${throughCycleDate} 超出行情范围`);
  }
  const signalEndDate = addUtcDays(throughCycleDate, -1);
  return {
    seriesBySymbol: Object.fromEntries(Object.entries(market.seriesBySymbol).map(([symbol, series]) => [
      symbol,
      series.filter((item) => item.date <= signalEndDate),
    ])),
    markPricesByCycleDate: Object.fromEntries(Object.entries(market.markPricesByCycleDate)
      .filter(([cycleDate]) => cycleDate <= throughCycleDate)),
  };
}

export function replayPaperResearchProfile({
  profile,
  market,
  throughCycleDate = market.throughCycleDate,
  initialCapital = 10_000,
  newsSnapshotsByCycleDate = null,
}) {
  if (profile?.newsOverlay?.enabled && newsSnapshotsByCycleDate === null) {
    throw new Error('新闻策略历史重放必须提供逐时点新闻快照，禁止用事后新闻回填');
  }
  const replayProfile = clone(profile);
  const sliced = marketThroughCycle(market, throughCycleDate);
  const initializedAt = Date.parse(`${market.initializationCycleDate}T01:00:00.000Z`);
  const reportedAt = Date.parse(`${throughCycleDate}T01:00:00.000Z`);
  let state = initializePaperState({
    seriesBySymbol: sliced.seriesBySymbol,
    cycleDate: market.initializationCycleDate,
    markPrices: sliced.markPricesByCycleDate[market.initializationCycleDate],
    initialCapital,
    now: initializedAt,
    profile: replayProfile,
    newsSnapshot: newsSnapshotsByCycleDate?.[market.initializationCycleDate] || null,
  });
  state = advancePaperState({
    state,
    seriesBySymbol: sliced.seriesBySymbol,
    markPricesByCycleDate: sliced.markPricesByCycleDate,
    throughCycleDate,
    now: reportedAt,
    profile: replayProfile,
    newsSnapshotsByCycleDate: newsSnapshotsByCycleDate || {},
  });
  return state;
}

function isFullCalendarMonth(startDate, endDate, month) {
  return startDate <= `${month}-01`
    && addUtcDays(endDate, 1).slice(0, 7) !== month;
}

export function paperResearchPeriodMetrics(state, { startDate, endDate }) {
  const reports = (state?.reports || [])
    .filter((report) => report.kind === 'daily')
    .filter((report) => report.cycleDate >= startDate && report.cycleDate <= endDate)
    .sort((left, right) => left.cycleDate.localeCompare(right.cycleDate));
  if (!reports.length) throw new Error(`研究区间 ${startDate} 至 ${endDate} 没有正式引擎日报`);
  const returns = reports.map((report) => Number(report.dayReturn));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const firstDate = reports[0].cycleDate;
  const lastDate = reports.at(-1).cycleDate;
  const elapsedDays = Math.round((Date.parse(`${lastDate}T00:00:00.000Z`)
    - Date.parse(`${firstDate}T00:00:00.000Z`)) / DAY_MS) + 1;
  const monthlyGroups = new Map();
  for (const report of reports) {
    const month = report.cycleDate.slice(0, 7);
    if (!monthlyGroups.has(month)) monthlyGroups.set(month, []);
    monthlyGroups.get(month).push(Number(report.dayReturn));
  }
  const monthly = [...monthlyGroups.entries()]
    .filter(([month]) => isFullCalendarMonth(startDate, endDate, month))
    .map(([month, values]) => ({
      month,
      return: round(values.reduce((value, dailyReturn) => value * (1 + dailyReturn), 1) - 1),
    }));
  const positiveMonths = monthly.filter((item) => item.return > 0).length;
  const logReturns = returns.map((value) => Math.log1p(value));
  const grossExposures = reports.map((report) => Number(report.modelGrossExposure || 0));
  const assetExposures = reports.map((report) => Math.max(
    0,
    ...(report.positions || []).map((position) => Math.abs(Number(position.weight || 0))),
  ));
  return {
    startDate: firstDate,
    endDate: lastDate,
    observations: reports.length,
    expectedDays: elapsedDays,
    dataCoverage: round(reports.length / elapsedDays),
    totalReturn: round(equity - 1),
    annualizedReturn: round(equity > 0 ? equity ** (365 / elapsedDays) - 1 : -1),
    annualizedVolatility: round(standardDeviation(logReturns) * Math.sqrt(365)),
    maxDrawdown: round(maxDrawdown),
    worstDayReturn: round(Math.min(...returns)),
    expectedShortfall95: round(expectedShortfall95(returns)),
    monthCount: monthly.length,
    positiveMonths,
    positiveMonthRatio: monthly.length ? round(positiveMonths / monthly.length) : null,
    monthly,
    peakGrossExposure: round(Math.max(0, ...grossExposures)),
    p95AssetExposure: round(percentile(assetExposures, 0.95)),
    totalTradingCost: round(reports.reduce(
      (sum, report) => sum + Number(report.tradingCost || 0),
      0,
    ), 4),
    totalCarryCost: round(reports.reduce(
      (sum, report) => sum + Number(report.carryCost || 0),
      0,
    ), 4),
  };
}
