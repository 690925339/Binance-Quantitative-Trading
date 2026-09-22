import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activePaperSnapshot, buildBtcReview } from '../worker/paper-scope.js';
import { runPaperDaily } from '../scripts/paper-trade-daily.mjs';
import { paperRunHealth } from '../scripts/paper-trade-scheduled.mjs';
import { initializeBtcPaperState } from '../src/btc-paper.js';
import { addUtcDays } from '../src/monthly-accuracy-paper.js';

test('BTC是唯一本金和盈亏来源；旧新闻结构正确纳入覆盖统计', () => {
  const btc = { status: 'running', equity: 10610, initialCapital: 10000, totalPnl: 610,
    reports: [{ kind: 'daily', dayPnl: 3, pricePnl: 4, newsRisk: { signalFresh: true } },
      { kind: 'daily', dayPnl: -1, pricePnl: 0, newsRisk: { signalFresh: false } }] };
  const active = activePaperSnapshot(btc);
  assert.equal(active.equity, 10610);
  assert.equal(active.initialCapital, 10000);
  assert.equal(active.optimizationReview.recent.newsMissingDays, 1);
  assert.equal(buildBtcReview(btc).recent.costOnlyLosses, 1);
  assert.deepEqual(active.activeSymbols, ['BTCUSDT']);
});

test('每日入口不读取、创建或改写组合与影子账本，重复运行不请求行情', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'btc-only-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'data/runtime');
  await fs.mkdir(path.join(runtime, 'paper-shadow'), { recursive: true });
  const retired = ['monthly-accuracy-paper.json', 'paper-shadow/retired.json'];
  for (const file of retired) await fs.writeFile(path.join(runtime, file), 'invalid JSON proves never read', 'utf8');
  const rows = [];
  for (let date = '2025-11-01', close = 30000; date <= '2026-09-22'; date = addUtcDays(date, 1), close *= 1.002) rows.push({ date, close });
  const state = initializeBtcPaperState({ seriesBySymbol: { BTCUSDT: rows }, cycleDate: '2026-09-22', markPrice: 85000 });
  const oldReports = JSON.stringify(state.reports);
  await fs.writeFile(path.join(runtime, 'btc-single-asset-paper.json'), JSON.stringify(state));
  const result = await runPaperDaily({ rootDir: root, now: Date.parse('2026-09-22T02:00:00Z'),
    fetchImpl: async () => assert.fail('unexpected market request'), newsFetchImpl: async () => assert.fail('unexpected news request') });
  assert.equal(result.scope, 'btc_only');
  assert.equal(result.equity, state.equity);
  assert.equal(JSON.stringify(result.reports), oldReports);
  assert.equal(result.pendingStrategyChange.effectiveFromCycleDate, '2026-09-23');
  for (const file of retired) assert.equal(await fs.readFile(path.join(runtime, file), 'utf8'), 'invalid JSON proves never read');
  assert.deepEqual(await fs.readdir(path.join(runtime, 'paper-shadow')), ['retired.json']);
  const health = await paperRunHealth(root, Date.parse('2026-09-22T02:00:00Z'));
  assert.equal(health.ledgers.length, 1);
  assert.deepEqual(health.pending, []);
  assert.deepEqual(health.staleArtifacts, []);
});
