import assert from 'node:assert/strict';
import test from 'node:test';
import { BTC_DAILY_TARGET, buildBtcDailyTarget, dailyWinMetrics, evaluateDailyCandidate } from '../src/btc-daily-target.js';
import { addUtcDays } from '../src/monthly-accuracy-paper.js';
import { reportText } from '../scripts/paper-trade-daily.mjs';

function daily(date, pnl = 1, profile = 'v2', settled = profile) {
  return { kind: 'daily', cycleDate: date, dayPnl: pnl, dayReturn: pnl / 10000,
    strategyProfileId: profile, settledStrategyProfileId: settled };
}

function range(start, end, profile = 'v2') {
  const reports = [];
  for (let date = start; date <= end; date = addUtcDays(date, 1)) reports.push(daily(date, 1, profile));
  return reports;
}

const interval = { startDate: '2026-10-01', endDate: '2026-10-05' };
const metric = overrides => ({ dataComplete: true, profitableDayRatio: 0.6, totalReturn: 0.2,
  maxDrawdown: -0.08, worstDayReturn: -0.02, expectedShortfall95: 0.01, annualizedReturn: 0.12, ...overrides });

test('盈利日按净盈亏和完整自然日计算，空仓持平及浮亏均不剔除', () => {
  const reports = [daily('2026-10-05'), daily('2026-10-01'), daily('2026-10-02', -1),
    daily('2026-10-03', 0), { ...daily('2026-10-04', -2), pricePnl: 10, realizedPnl: 10 },
    { kind: 'initialization', cycleDate: '2026-09-30', dayPnl: 100 }];
  const original = JSON.stringify(reports);
  const result = dailyWinMetrics(reports, interval);
  assert.equal(result.profitableDayRatio, 0.4);
  assert.equal(result.profitableDays, 2);
  assert.equal(result.lossDays, 2);
  assert.equal(result.flatDays, 1);
  assert.equal(result.observations, 5);
  assert.equal(result.expectedDays, 5);
  assert.equal(result.netPnl, -1);
  assert.equal(result.profitFactor, 2 / 3);
  assert.equal(result.pointTargetMet, false);
  assert.equal(JSON.stringify(reports), original);
});

test('达到60%只是点估计，置信区间不伪装长期证明', () => {
  const result = dailyWinMetrics([daily('2026-10-01'), daily('2026-10-02'), daily('2026-10-03'),
    daily('2026-10-04', -1), daily('2026-10-05', 0)], interval);
  assert.equal(result.profitableDayRatio, 0.6);
  assert.equal(result.pointTargetMet, true);
  assert.ok(result.wilson95.lower < 0.6 && result.wilson95.upper > 0.6);
  assert.match(result.wilson95.assumption, /not_proof/);
});

test('缺日保留在分母且禁止验收，不生成不完整样本置信区间', () => {
  const result = dailyWinMetrics([daily('2026-10-01'), daily('2026-10-02'), daily('2026-10-03')], interval);
  assert.equal(result.profitableDayRatio, 0.6);
  assert.deepEqual(result.missingDates, ['2026-10-04', '2026-10-05']);
  assert.equal(result.dataComplete, false);
  assert.equal(result.pointTargetMet, false);
  assert.equal(result.wilson95, null);
});

test('严格校验公历日期、区间、重复日报和非数值盈亏', () => {
  for (const date of ['2026-02-30', '2026-2-01', '2026-13-01', '', null]) {
    assert.throws(() => dailyWinMetrics([], { startDate: date, endDate: '2026-10-05' }), /无效结算日期/);
  }
  assert.throws(() => dailyWinMetrics([], { startDate: interval.endDate, endDate: interval.startDate }), /无效盈利日/);
  assert.throws(() => dailyWinMetrics([daily('2026-02-30')], interval), /无效结算日期/);
  assert.throws(() => dailyWinMetrics([daily('2026-10-01'), daily('2026-10-01')], interval), /重复结算日/);
  for (const change of [{ dayPnl: NaN }, { dayPnl: '1' }, { dayReturn: Infinity }, { dayReturn: -1 }, { dayReturn: -0.01 }]) {
    assert.throws(() => dailyWinMetrics([{ ...daily('2026-10-01'), ...change }], interval), /无效日盈亏/);
  }
  assert.throws(() => dailyWinMetrics(null, interval), /日报必须为数组/);
});

test('闰年和完整月准确识别，部分月份不冒充完整月', () => {
  const leap = dailyWinMetrics(range('2024-02-01', '2024-02-29'), { startDate: '2024-02-01', endDate: '2024-02-29' });
  assert.equal(leap.expectedDays, 29);
  assert.deepEqual(leap.completeCalendarMonths, ['2024-02']);
  const partial = dailyWinMetrics(range('2026-01-02', '2026-04-01'), { startDate: '2026-01-02', endDate: '2026-04-01' });
  assert.deepEqual(partial.completeCalendarMonths, ['2026-02', '2026-03']);
});

test('累计统计捕捉首日/末日缺失，不因日报无序改变起点', () => {
  const state = { startCycleDate: '2026-09-30', lastCycleDate: '2026-10-05', strategyProfileId: 'v2',
    reports: [daily('2026-10-04'), daily('2026-10-02'), daily('2026-10-03')] };
  const target = buildBtcDailyTarget(state);
  assert.equal(target.account.startDate, '2026-10-01');
  assert.equal(target.account.expectedDays, 5);
  assert.deepEqual(target.account.missingDates, ['2026-10-01', '2026-10-05']);
  assert.equal(target.currentVersion.dataComplete, false);
  assert.equal(target.forwardReview.sampleReady, false);
});

test('迁移日混合版本不归入新版本收益，同版本缺日不缩分母', () => {
  const target = buildBtcDailyTarget({ startCycleDate: '2026-09-30', lastCycleDate: '2026-10-05', strategyProfileId: 'v2',
    reports: [daily('2026-10-01', 1, 'v1'), daily('2026-10-02', 1, 'v2', 'v1'),
      daily('2026-10-04'), daily('2026-10-05')] });
  assert.equal(target.account.profitableDays, 4);
  assert.equal(target.currentVersion.startDate, '2026-10-03');
  assert.equal(target.currentVersion.expectedDays, 3);
  assert.equal(target.currentVersion.profitableDays, 2);
  assert.deepEqual(target.currentVersion.missingDates, ['2026-10-03']);
});

test('同一版本号回滚复用时只统计最后连续版本段，缺settled版本不能自动认同', () => {
  const target = buildBtcDailyTarget({ startCycleDate: '2026-09-30', lastCycleDate: '2026-10-05', strategyProfileId: 'v2',
    reports: [daily('2026-10-01'), daily('2026-10-02', 1, 'v1'), daily('2026-10-03', 1, 'v2', 'v1'),
      { ...daily('2026-10-04'), settledStrategyProfileId: undefined }, daily('2026-10-05')] });
  assert.equal(target.currentVersion.startDate, '2026-10-05');
  assert.equal(target.currentVersion.observations, 1);
});

test('90天且3完整月只触发复核，不自动上线且保留10%年化目标', () => {
  const target = buildBtcDailyTarget({ startCycleDate: '2025-12-31', lastCycleDate: '2026-03-31', strategyProfileId: 'v2',
    reports: range('2026-01-01', '2026-03-31') });
  assert.equal(target.currentVersion.observations, 90);
  assert.equal(target.currentVersion.fullMonthCount, 3);
  assert.equal(target.forwardReview.sampleReady, true);
  assert.equal(target.forwardReview.automaticPromotion, false);
  assert.equal(target.forwardReview.liveReady, false);
  assert.equal(target.forwardReview.annualized10Met, null);
  assert.equal(target.policy.retainedAnnualizedReturnTarget, 0.1);
  assert.equal(target.recent30.expectedDays, 30);
  const partial = buildBtcDailyTarget({ startCycleDate: '2026-01-01', lastCycleDate: '2026-04-01', strategyProfileId: 'v2',
    reports: range('2026-01-02', '2026-04-01') });
  assert.equal(partial.currentVersion.observations, 90);
  assert.equal(partial.forwardReview.sampleReady, false);
});

test('初始化与空数据不报达标，账本日期矛盾应拒绝', () => {
  const empty = buildBtcDailyTarget(null);
  assert.equal(empty.account, null);
  assert.equal(empty.forwardReview.sampleReady, false);
  assert.equal(empty.status, 'collecting');
  const missing = buildBtcDailyTarget({ startCycleDate: '2026-09-30', lastCycleDate: '2026-10-05', reports: [] });
  assert.equal(missing.account.missingDays, 5);
  assert.equal(missing.account.pointTargetMet, false);
  assert.throws(() => buildBtcDailyTarget({ reports: [daily('2026-10-01')] }), /缺少最新结算日/);
  assert.throws(() => buildBtcDailyTarget({ lastCycleDate: '2026-09-30', reports: [daily('2026-10-01')] }), /晚于/);
  assert.throws(() => buildBtcDailyTarget({ startCycleDate: '2026-10-03', lastCycleDate: '2026-10-01', reports: [] }), /起始日晚于/);
  assert.throws(() => buildBtcDailyTarget({ startCycleDate: '2026-10-01', lastCycleDate: '2026-10-03', reports: [daily('2026-10-01')] }), /早于/);
});

test('候选满足日比例、收益与尾部且保留10%年化后才允许前向研究，不自动晋级', () => {
  const baseline = metric({ profitableDayRatio: 0.5, totalReturn: 0.1 });
  const pressureBase = metric({ profitableDayRatio: 0.48, totalReturn: 0.05, maxDrawdown: -0.12 });
  const result = evaluateDailyCandidate(metric(), baseline, metric({ totalReturn: 0.15 }), pressureBase);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.annualized10Met, true);
  assert.equal(result.eligibleForForward, true);
  assert.equal(result.automaticPromotion, false);
  assert.equal(result.leverageIncreaseAllowed, false);
  assert.equal(result.doubleCostComparison, 'same_cost_baseline');
});

test('60%点目标通过不代表年化目标通过或可进入前向替换', () => {
  const result = evaluateDailyCandidate(metric({ annualizedReturn: 0.08 }),
    metric({ profitableDayRatio: 0.5, totalReturn: 0.1 }), metric({ annualizedReturn: 0.05 }));
  assert.equal(result.passed, true);
  assert.equal(result.annualized10Met, false);
  assert.equal(result.eligibleForForward, false);
});

test('高盈利日比例无法抵销缺日、亏损或压力成本尾部退化', () => {
  const baseline = metric({ profitableDayRatio: 0.5, totalReturn: 0.1 });
  const result = evaluateDailyCandidate(metric({ profitableDayRatio: 0.8, dataComplete: false }), baseline,
    metric({ profitableDayRatio: 0.8, totalReturn: -0.01, maxDrawdown: -0.2, worstDayReturn: -0.1, expectedShortfall95: 0.05 }), baseline);
  assert.equal(result.passed, false);
  for (const check of ['completeData', 'positiveDoubleCostReturn', 'noDoubleCostReturnDeterioration',
    'noDoubleCostDrawdownDeterioration', 'noDoubleCostTailDeterioration']) assert.ok(result.failedChecks.includes(check));
  assert.equal(result.eligibleForForward, false);
});

test('无效或遗漏的候选数值失败关闭，未提供压力基准时保守比较', () => {
  const baseline = metric({ profitableDayRatio: 0.5, totalReturn: 0.1 });
  for (const candidate of [null, {}, metric({ profitableDayRatio: 2 }), metric({ annualizedReturn: NaN }), metric({ maxDrawdown: 0.1 })]) {
    const result = evaluateDailyCandidate(candidate, baseline, metric());
    assert.equal(result.passed, false);
    assert.equal(result.eligibleForForward, false);
    assert.ok(result.failedChecks.includes('validMetrics'));
  }
  const fallback = evaluateDailyCandidate(metric(), baseline, metric({ maxDrawdown: -0.09 }));
  assert.equal(fallback.doubleCostComparison, 'standard_cost_baseline_conservative_fallback');
  assert.equal(fallback.checks.noDoubleCostDrawdownDeterioration, false);
});

test('文本日报明确60%净盈利日目标、分母与不自动上线', () => {
  const reports = [daily('2026-10-01'), daily('2026-10-02', 0), daily('2026-10-03', -1)];
  const state = { startCycleDate: '2026-09-30', lastCycleDate: '2026-10-03', strategyProfileId: 'v2', reports,
    latestReport: reports.at(-1), equity: 10000, initialCapital: 10000, maxDrawdown: -0.01, modelGrossExposure: 0, positions: [] };
  const text = reportText(state);
  assert.match(text, /净盈利日比例：33.33%（1\/3个自然结算日；目标60%/);
  assert.match(text, /空仓、持平计入分母/);
  assert.match(text, /不自动上线或增加杠杆/);
  assert.equal(Object.isFrozen(BTC_DAILY_TARGET), true);
});
