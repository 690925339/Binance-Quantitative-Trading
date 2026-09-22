import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureDecisionNewsSnapshot,
  isTimelyPaperNews,
  paperNewsDecisionWindow,
  pendingPaperNewsStates,
} from '../scripts/paper-trade-daily.mjs';

const CYCLE_DATE = '2026-07-16';
const NOW = Date.parse('2026-07-16T01:05:00.000Z');

test('仅BTC待结算时仍要求采集新闻，已结算时不重复采集', () => {
  const current = { lastCycleDate: CYCLE_DATE };
  const previous = { lastCycleDate: '2026-07-15' };
  const args = { profiles: [{ newsOverlay: { enabled: true } }], states: [current], latestCycleDate: CYCLE_DATE };
  assert.deepEqual(pendingPaperNewsStates({ ...args, btcState: previous }), [previous]);
  assert.deepEqual(pendingPaperNewsStates({ ...args, btcState: current }), []);
  assert.deepEqual(pendingPaperNewsStates({ ...args, btcState: null }), [null]);
});

test('新闻待结算列表忽略已停用的组合盘和全部影子盘', () => {
  const previous = { lastCycleDate: '2026-07-13' };
  assert.deepEqual(pendingPaperNewsStates({
    profiles: [{}, { newsOverlay: { enabled: true } }, { newsOverlay: { enabled: true } }],
    states: [previous, previous, null], btcState: { lastCycleDate: CYCLE_DATE }, latestCycleDate: CYCLE_DATE,
  }), []);
});

test('新闻决策窗口严格限定在北京时间09:00至09:15', () => {
  const window = paperNewsDecisionWindow(CYCLE_DATE);
  assert.equal(window.startsAt, Date.parse('2026-07-16T01:00:00.000Z'));
  assert.equal(window.endsAt, Date.parse('2026-07-16T01:15:00.000Z'));
  assert.equal(isTimelyPaperNews({ status: 'live', updatedAt: '2026-07-16T01:15:00.000Z' }, CYCLE_DATE), true);
  assert.equal(isTimelyPaperNews({ status: 'live', updatedAt: '2026-07-16T01:15:00.001Z' }, CYCLE_DATE), false);
  assert.equal(isTimelyPaperNews({ status: 'stale', updatedAt: '2026-07-16T01:05:00.000Z' }, CYCLE_DATE), false);
});

test('新闻首次不可用时强制刷新重试且只保存实时快照', async () => {
  const forceRefreshCalls = [];
  const responses = [
    {
      status: 'unavailable',
      updatedAt: '2026-07-16T01:03:00.000Z',
      sourceStatus: [{ source: 'A', ok: false }],
    },
    {
      status: 'live',
      updatedAt: '2026-07-16T01:04:00.000Z',
      sourceStatus: [{ source: 'A', ok: true }],
      items: [{ id: 'event' }],
    },
  ];
  const saved = [];
  const audits = [];
  const newsService = {
    async getNews(options) {
      forceRefreshCalls.push(options.forceRefresh);
      return responses.shift();
    },
  };
  const result = await captureDecisionNewsSnapshot({
    cycleDate: CYCLE_DATE,
    newsService,
    retryDelaysMs: [0, 0, 0],
    waitImpl: async () => {},
    writeSnapshot: async (cycleDate, news) => {
      saved.push({ cycleDate, news });
      return { ...news, paperCycleDate: cycleDate };
    },
    writeAudit: async (cycleDate, audit) => audits.push({ cycleDate, audit }),
    now: NOW,
  });

  assert.deepEqual(forceRefreshCalls, [false, true]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].news.captureAttemptCount, 2);
  assert.equal(result.status, 'live');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].audit.success, true);
  assert.equal(audits[0].audit.attempts.length, 2);
});

test('超出时效窗口的live结果不会写入正式快照', async () => {
  let saved = false;
  let audit = null;
  const result = await captureDecisionNewsSnapshot({
    cycleDate: CYCLE_DATE,
    newsService: {
      async getNews() {
        return { status: 'live', updatedAt: '2026-07-16T01:16:00.000Z', sourceStatus: [] };
      },
    },
    retryDelaysMs: [0],
    writeSnapshot: async () => { saved = true; },
    writeAudit: async (_cycleDate, value) => { audit = value; },
    now: NOW,
  });

  assert.equal(result, null);
  assert.equal(saved, false);
  assert.equal(audit.success, false);
  assert.equal(audit.attempts[0].timely, false);
});
