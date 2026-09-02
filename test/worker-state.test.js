import assert from 'node:assert/strict';
import test from 'node:test';

import {
  combinePaperPortfolioState,
  runtimeStateFreshness,
  selectRuntimeState,
} from '../worker/index.js';

function state(cycleDate, updatedAt, reportCount = 1) {
  return {
    status: 'running',
    lastCycleDate: cycleDate,
    updatedAt,
    reports: Array.from({ length: reportCount }, (_, index) => ({
      cycleDate,
      reportedAt: updatedAt,
      index,
    })),
  };
}

test('部署seed周期更新时优先采用并要求回写D1', () => {
  const stored = state('2026-08-21', '2026-08-21T01:00:02.000Z');
  const seeded = state('2026-08-25', '2026-08-25T01:00:03.000Z');
  assert.deepEqual(selectRuntimeState(stored, seeded), {
    state: seeded,
    source: 'seed',
    shouldPersist: true,
  });
});

test('seed周期未更新时保留D1状态且不回写', () => {
  const stored = state('2026-08-25', '2026-08-25T01:00:03.000Z');
  const seeded = structuredClone(stored);
  assert.deepEqual(selectRuntimeState(stored, seeded), {
    state: stored,
    source: 'stored',
    shouldPersist: false,
  });
});

test('D1周期更新于seed时绝不被旧部署覆盖', () => {
  const stored = state('2026-08-26', '2026-08-26T01:00:03.000Z');
  const seeded = state('2026-08-25', '2026-08-25T01:00:03.000Z');
  assert.equal(selectRuntimeState(stored, seeded).state, stored);
  assert.equal(selectRuntimeState(stored, seeded).shouldPersist, false);
});

test('同一周期仅在seed结算时间更晚时采用seed', () => {
  const stored = state('2026-08-25', '2026-08-25T01:00:02.000Z');
  const seeded = state('2026-08-25', '2026-08-25T01:00:03.000Z');
  assert.equal(selectRuntimeState(stored, seeded).state, seeded);
  assert.equal(selectRuntimeState(stored, seeded).shouldPersist, true);
});

test('同一周期的标准快照版本升级可修复旧D1响应结构', () => {
  const stored = state('2026-08-25', '2026-08-25T01:00:03.000Z');
  const seeded = {
    ...structuredClone(stored),
    runtimeSnapshotVersion: 2,
    totalPnl: 172.54,
    totalReturn: 0.017254,
  };
  assert.equal(selectRuntimeState(stored, seeded).state, seeded);
  assert.equal(selectRuntimeState(stored, seeded).shouldPersist, true);
});

test('同一结算时点的正确率快照v3会替换缺少统计字段的v2', () => {
  const stored = {
    ...state('2026-09-02', '2026-09-02T01:00:02.000Z'),
    runtimeSnapshotVersion: 2,
  };
  const seeded = {
    ...structuredClone(stored),
    runtimeSnapshotVersion: 3,
    accuracy: {
      observations: 13,
      directionalHits: 7,
      directionalObservations: 12,
      directionalHitRate: 7 / 12,
    },
  };
  const selected = selectRuntimeState(stored, seeded);
  assert.equal(selected.state, seeded);
  assert.equal(selected.shouldPersist, true);
});

test('同周期高版本seed不得覆盖结算时间更晚的D1账本', () => {
  const stored = {
    ...state('2026-08-25', '2026-08-25T01:10:00.000Z'),
    equity: 10_100,
  };
  const seeded = {
    ...state('2026-08-25', '2026-08-25T01:00:00.000Z'),
    equity: 9_900,
    runtimeSnapshotVersion: 2,
  };
  assert.equal(selectRuntimeState(stored, seeded).state, stored);
  assert.equal(selectRuntimeState(stored, seeded).shouldPersist, false);
});

test('无周期fallback不会覆盖已有账本', () => {
  const stored = state('2026-08-25', '2026-08-25T01:00:03.000Z');
  const fallback = { status: 'not_started', reports: [], positions: [] };
  assert.equal(selectRuntimeState(stored, fallback).state, stored);
  assert.equal(selectRuntimeState(stored, fallback).shouldPersist, false);
});

test('新状态的周期和时间可从最新日报推导', () => {
  const freshness = runtimeStateFreshness({
    reports: [
      { cycleDate: '2026-08-24', reportedAt: '2026-08-24T01:00:02.000Z' },
      { cycleDate: '2026-08-25', reportedAt: '2026-08-25T01:00:03.000Z' },
    ],
  });
  assert.equal(freshness.cycleDate, '2026-08-25');
  assert.equal(freshness.timestamp, Date.parse('2026-08-25T01:00:03.000Z'));
  assert.equal(freshness.reportCount, 2);
});

test('云端组合盘响应会合并BTC账本和影子复盘', () => {
  const paper = { status: 'running', totalPnl: 172.54 };
  const btc = { status: 'running', totalPnl: 327.15 };
  const review = { status: 'running', candidates: [{ id: 'shadow-v3' }] };
  assert.deepEqual(combinePaperPortfolioState(paper, btc, review), {
    ...paper,
    btcPortfolio: btc,
    optimizationReview: review,
  });
});
