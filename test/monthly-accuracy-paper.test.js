import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  addUtcDays,
  advancePaperState,
  initializePaperState,
  latestCompletePaperCycleDate,
  PaperPortfolioStore,
  paperPortfolioSnapshot,
} from '../src/monthly-accuracy-paper.js';

const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

function syntheticSeries(startDate, endDate) {
  const values = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  const prices = Object.fromEntries(symbols.map((symbol, index) => [symbol, 100 + index * 10]));
  let date = startDate;
  let cursor = 0;
  while (date <= endDate) {
    symbols.forEach((symbol, index) => {
      const drift = (2.5 - index) * 0.0007;
      prices[symbol] *= Math.exp(drift + Math.sin(cursor / 11 + index) * 0.002);
      values[symbol].push({ date, close: prices[symbol] });
    });
    cursor += 1;
    date = addUtcDays(date, 1);
  }
  return values;
}

function markPrices(seriesBySymbol, date, multiplier = 1) {
  return Object.fromEntries(symbols.map((symbol) => {
    const row = seriesBySymbol[symbol].find((item) => item.date === date);
    return [symbol, row.close * multiplier];
  }));
}

test('纸面盘从启动日建立基线，不回填此前收益', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  const snapshot = paperPortfolioSnapshot(state);
  assert.equal(snapshot.startCycleDate, '2026-07-16');
  assert.equal(snapshot.lastCycleDate, '2026-07-16');
  assert.equal(snapshot.latestReport.kind, 'initialization');
  assert.equal(snapshot.reports.length, 1);
  assert.ok(snapshot.equity < 10_000);
  assert.ok(snapshot.positions.some((item) => item.side === 'LONG'));
  assert.ok(snapshot.positions.some((item) => item.side === 'SHORT'));
  assert.equal(snapshot.partialStartMonth, '2026-07');
  assert.equal(snapshot.firstFullMonth, '2026-08');
});

test('每日推进只结算未处理日期，重复执行保持幂等', () => {
  const series = syntheticSeries('2025-11-01', '2026-07-16');
  const state = initializePaperState({
    seriesBySymbol: series,
    cycleDate: '2026-07-16',
    markPrices: markPrices(series, '2026-07-15', 1.001),
    initialCapital: 10_000,
    now: Date.parse('2026-07-16T01:05:00.000Z'),
  });
  advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: {
      '2026-07-17': markPrices(series, '2026-07-16', 1.002),
    },
    throughCycleDate: '2026-07-17',
    now: Date.parse('2026-07-17T01:05:00.000Z'),
  });
  const reportsAfterFirstRun = state.reports.length;
  const equityAfterFirstRun = state.equity;
  assert.equal(state.lastCycleDate, '2026-07-17');
  assert.equal(state.latestReport.kind, 'daily');
  assert.ok(Number.isFinite(state.latestReport.dayPnl));
  assert.equal(reportsAfterFirstRun, 2);

  advancePaperState({
    state,
    seriesBySymbol: series,
    markPricesByCycleDate: {},
    throughCycleDate: '2026-07-17',
    now: Date.parse('2026-07-17T01:06:00.000Z'),
  });
  assert.equal(state.reports.length, reportsAfterFirstRun);
  assert.equal(state.equity, equityAfterFirstRun);
});

test('北京时间09点之后才使用当天固定估值周期', () => {
  assert.equal(
    latestCompletePaperCycleDate(Date.parse('2026-07-16T00:59:59.999Z')),
    '2026-07-15',
  );
  assert.equal(
    latestCompletePaperCycleDate(Date.parse('2026-07-16T01:00:00.000Z')),
    '2026-07-16',
  );
});

test('纸面盘状态使用锁文件和原子写入持久化', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quantflow-paper-'));
  const filePath = path.join(directory, 'paper.json');
  const store = new PaperPortfolioStore(filePath);
  await store.run((current) => ({ version: 1, count: (current?.count || 0) + 1 }));
  await store.run((current) => ({ ...current, count: current.count + 1 }));
  assert.deepEqual(await store.read(), { version: 1, count: 2 });
  assert.equal(await fs.stat(`${filePath}.lock`).catch(() => null), null);
  await fs.rm(directory, { recursive: true, force: true });
});
