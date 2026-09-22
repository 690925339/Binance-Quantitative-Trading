import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PAPER_SHADOW_PROFILES } from '../src/paper-strategy-review.js';
import { paperRunHealth, runScheduledPaper } from '../scripts/paper-trade-scheduled.mjs';

const now = Date.parse('2026-09-16T01:30:00Z');
const ledgerFiles = ['monthly-accuracy-paper.json', 'btc-single-asset-paper.json',
  ...PAPER_SHADOW_PROFILES.map(p => `paper-shadow/${p.id}.json`)];
const artifactFiles = ['paper-reports/latest.json', 'btc-paper-reports/latest.json', 'btc-paper-review.json'];

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-scheduled-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, content) => {
    const target = path.join(root, 'data/runtime', file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(content), 'utf8');
  };
  const settle = async date => {
    for (const file of ledgerFiles) await write(file, { lastCycleDate: date, equity: 10001 });
    for (const file of artifactFiles) await write(file, { cycleDate: date });
  };
  await settle('2026-09-16');
  return { root, write, settle };
}

test('已结算的重复检查不调用行情/结算或重复通知，账本字节不变', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'data/runtime/monthly-accuracy-paper.json');
  const before = await fs.readFile(file, 'utf8');
  const result = await runScheduledPaper({ rootDir: root, now, notify: true,
    runImpl: async () => assert.fail('should not settle twice') });
  assert.equal(result.status, 'up_to_date');
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('只有BTC落后时执行补跑，并在写完所有产物后判定成功', async t => {
  const { root, write } = await fixture(t);
  await write('btc-single-asset-paper.json', { lastCycleDate: '2026-09-15' });
  let calls = 0;
  const result = await runScheduledPaper({ rootDir: root, now, runImpl: async options => {
    calls += 1;
    assert.equal(options.now, now);
    await write('btc-single-asset-paper.json', { lastCycleDate: '2026-09-16' });
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'settled');
  assert.equal(result.health.pending.length, 0);
});

test('账本已更新但日报陈旧时仍执行修复', async t => {
  const { root, write } = await fixture(t);
  await write('btc-paper-review.json', { cycleDate: '2026-09-15' });
  const result = await runScheduledPaper({ rootDir: root, now, runImpl: async () => {
    await write('btc-paper-review.json', { cycleDate: '2026-09-16' });
  } });
  assert.equal(result.status, 'settled');
});

test('网络失败落盘错误记录并抛错，下一次检查可恢复', async t => {
  const { root, settle } = await fixture(t);
  await settle('2026-09-15');
  await assert.rejects(runScheduledPaper({ rootDir: root, now,
    runImpl: async () => { throw new Error('test network unavailable'); } }), /network unavailable/);
  const statusFile = path.join(root, 'data/runtime/paper-job-status.json');
  const failure = JSON.parse(await fs.readFile(statusFile, 'utf8'));
  assert.equal(failure.status, 'failed');
  const recovered = await runScheduledPaper({ rootDir: root, now, runImpl: () => settle('2026-09-16') });
  assert.equal(recovered.status, 'settled');
  assert.match(recovered.lastFailure.message, /network unavailable/);
});

test('执行器未真正推进BTC账本时不得报告结算成功', async t => {
  const { root, write } = await fixture(t);
  await write('btc-single-asset-paper.json', { lastCycleDate: '2026-09-15' });
  await assert.rejects(runScheduledPaper({ rootDir: root, now, runImpl: async () => {} }), /结算后仍有延迟/);
});

test('北京时间09:00以前检查上一周期，09:00以后检查今日', async t => {
  const { root, settle } = await fixture(t);
  await settle('2026-09-15');
  const before = await paperRunHealth(root, Date.parse('2026-09-16T00:59:59Z'));
  const after = await paperRunHealth(root, Date.parse('2026-09-16T01:00:00Z'));
  assert.equal(before.pending.length, 0);
  assert.equal(before.cycleDate, '2026-09-15');
  assert.deepEqual(after.pending, ['btc-single-asset-paper.json']);
  assert.equal(after.cycleDate, '2026-09-16');
});

test('09:00任务与恢复任务同时触发时只允许一个执行器推进', async t => {
  const { root, settle } = await fixture(t);
  await settle('2026-09-15');
  let signalStarted;
  let finish;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  const first = runScheduledPaper({ rootDir: root, now, runImpl: async () => {
    signalStarted();
    await release;
    await settle('2026-09-16');
  } });
  await started;
  try {
    await assert.rejects(runScheduledPaper({ rootDir: root, now,
      runImpl: async () => assert.fail('concurrent settlement') }), /另一个进程/);
  } finally { finish(); }
  assert.equal((await first).status, 'settled');
});
