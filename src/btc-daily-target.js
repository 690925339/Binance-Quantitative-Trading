import { addUtcDays } from './monthly-accuracy-paper.js';

const DAY_MS = 86_400_000;

export const BTC_DAILY_TARGET = Object.freeze({
  id: 'btc-profitable-days-60-v1', effectiveFrom: '2026-10-04', targetRatio: 0.6,
  retainedAnnualizedReturnTarget: 0.1, minimumForwardDays: 90, minimumFullMonths: 3,
  definition: 'net_profitable_days_over_all_calendar_settlement_days',
  flatDaysCountAsWins: false, allowAutomaticPromotion: false,
});

function dateTimestamp(value) {
  const timestamp = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T00:00:00.000Z`) : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`无效结算日期：${value}`);
  }
  return timestamp;
}

function dailyReports(reports) {
  if (!Array.isArray(reports)) throw new Error('日报必须为数组');
  return reports.filter(report => report?.kind === 'daily').map(report => {
    dateTimestamp(report.cycleDate);
    return report;
  }).sort((left, right) => left.cycleDate.localeCompare(right.cycleDate));
}

function fullCalendarMonths(startDate, endDate, presentDates) {
  const months = [];
  let first = `${startDate.slice(0, 7)}-01`;
  if (first < startDate) {
    const date = new Date(dateTimestamp(first));
    date.setUTCMonth(date.getUTCMonth() + 1);
    first = date.toISOString().slice(0, 10);
  }
  while (first <= endDate) {
    const next = new Date(dateTimestamp(first));
    next.setUTCMonth(next.getUTCMonth() + 1);
    const nextDate = next.toISOString().slice(0, 10);
    if (addUtcDays(nextDate, -1) > endDate) break;
    let complete = true;
    for (let date = first; date < nextDate; date = addUtcDays(date, 1)) {
      if (!presentDates.has(date)) complete = false;
    }
    if (complete) months.push(first.slice(0, 7));
    first = nextDate;
  }
  return months;
}

export function dailyWinMetrics(reports, { startDate, endDate }) {
  const expectedDays = (dateTimestamp(endDate) - dateTimestamp(startDate)) / DAY_MS + 1;
  if (!Number.isInteger(expectedDays) || expectedDays < 1) throw new Error('无效盈利日评估区间');
  const daily = dailyReports(reports).filter(r => r.cycleDate >= startDate && r.cycleDate <= endDate);
  const dates = new Set();
  let profitableDays = 0, lossDays = 0, flatDays = 0, netPnl = 0, grossProfit = 0, grossLoss = 0;
  for (const r of daily) {
    if (dates.has(r.cycleDate)) throw new Error(`重复结算日：${r.cycleDate}`);
    if (!Number.isFinite(r.dayPnl) || !Number.isFinite(r.dayReturn)
      || r.dayReturn <= -1 || r.dayPnl * r.dayReturn < 0) throw new Error(`无效日盈亏：${r.cycleDate}`);
    dates.add(r.cycleDate);
    netPnl += r.dayPnl;
    if (r.dayPnl > 0) { profitableDays++; grossProfit += r.dayPnl; }
    else if (r.dayPnl < 0) { lossDays++; grossLoss -= r.dayPnl; }
    else flatDays++;
  }
  const missingDates = [];
  for (let date = startDate; date <= endDate; date = addUtcDays(date, 1)) if (!dates.has(date)) missingDates.push(date);
  const dataComplete = missingDates.length === 0;
  const ratio = profitableDays / expectedDays;
  const z = 1.959963984540054;
  const denominator = 1 + z * z / expectedDays;
  const center = (ratio + z * z / (2 * expectedDays)) / denominator;
  const radius = z * Math.sqrt(ratio * (1 - ratio) / expectedDays + z * z / (4 * expectedDays ** 2)) / denominator;
  const completeMonths = fullCalendarMonths(startDate, endDate, dates);
  return { startDate, endDate, expectedDays, observations: daily.length,
    profitableDays, lossDays, flatDays, missingDays: missingDates.length, missingDates,
    dataComplete, profitableDayRatio: ratio, completeCalendarMonths: completeMonths,
    fullMonthCount: completeMonths.length,
    netPnl, grossProfit, grossLoss, profitFactor: grossLoss ? grossProfit / grossLoss : null,
    meanWin: profitableDays ? grossProfit / profitableDays : null,
    meanLoss: lossDays ? grossLoss / lossDays : null,
    pointTargetMet: dataComplete && ratio >= BTC_DAILY_TARGET.targetRatio,
    wilson95: dataComplete ? { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius),
      assumption: 'iid_approximation_not_proof_of_long_run_rate' } : null };
}

export function buildBtcDailyTarget(state) {
  const daily = dailyReports(state?.reports || []);
  const endDate = state?.lastCycleDate || null;
  if (endDate) dateTimestamp(endDate);
  if (daily.length && !endDate) throw new Error('账户缺少最新结算日');
  if (daily.some(r => r.cycleDate > endDate)) throw new Error('日报晚于账户最新结算日');
  if (state?.startCycleDate) dateTimestamp(state.startCycleDate);
  if (state?.startCycleDate && endDate && state.startCycleDate > endDate) throw new Error('账户起始日晚于最新结算日');
  const startDate = state?.startCycleDate ? addUtcDays(state.startCycleDate, 1) : daily[0]?.cycleDate;
  const account = startDate && endDate && startDate <= endDate
    ? dailyWinMetrics(daily, { startDate, endDate }) : null;
  if ((daily.length && !account) || daily.some(r => r.cycleDate < startDate)) throw new Error('日报早于账户首个完整结算日');
  const sameVersion = r => Boolean(state?.strategyProfileId)
    && r.settledStrategyProfileId === state.strategyProfileId && r.strategyProfileId === state.strategyProfileId;
  const lastDifferent = daily.filter(r => !sameVersion(r)).at(-1);
  const versionStart = lastDifferent ? addUtcDays(lastDifferent.cycleDate, 1) : startDate;
  const current = daily.filter(r => sameVersion(r) && r.cycleDate >= versionStart);
  const currentVersion = current.length && versionStart && endDate && versionStart <= endDate
    ? dailyWinMetrics(current, { startDate: versionStart, endDate }) : null;
  const sampleReady = Boolean(currentVersion?.dataComplete
    && currentVersion.observations >= BTC_DAILY_TARGET.minimumForwardDays
    && currentVersion.fullMonthCount >= BTC_DAILY_TARGET.minimumFullMonths);
  return { cycleDate: endDate, policy: BTC_DAILY_TARGET, status: account ? 'research_only' : 'collecting', account,
    recent30: account ? dailyWinMetrics(daily, { startDate: [startDate, addUtcDays(endDate, -29)].sort().at(-1), endDate }) : null,
    currentVersion, strategyProfileId: state?.strategyProfileId || null,
    forwardReview: { sampleReady, pointTargetMet: Boolean(currentVersion?.pointTargetMet),
      minimumDays: BTC_DAILY_TARGET.minimumForwardDays, minimumFullMonths: BTC_DAILY_TARGET.minimumFullMonths,
      automaticPromotion: false, liveReady: false, annualized10Met: null },
    gapToPointTarget: account ? Math.max(0, Math.ceil(account.expectedDays * BTC_DAILY_TARGET.targetRatio) - account.profitableDays) : null,
    note: '盈利日按含空仓、持平的完整自然日计算；账户累计与同版本样本分开。90天及3完整月仅供复核，不自动上线；仍保留年化10%目标，不增加杠杆。' };
}

function validCandidateMetrics(metrics) {
  return Boolean(metrics && ['profitableDayRatio', 'totalReturn', 'maxDrawdown', 'worstDayReturn',
    'expectedShortfall95', 'annualizedReturn'].every(key => Number.isFinite(metrics[key]))
    && metrics.profitableDayRatio >= 0 && metrics.profitableDayRatio <= 1
    && metrics.maxDrawdown <= 0 && metrics.maxDrawdown >= -1 && metrics.expectedShortfall95 >= 0);
}

export function evaluateDailyCandidate(candidate, baseline, doubledCost, doubleCostBaseline = null) {
  const pressureBaseline = doubleCostBaseline || baseline;
  const validMetrics = [candidate, baseline, doubledCost, pressureBaseline].every(validCandidateMetrics);
  const checks = {
    validMetrics,
    completeData: [candidate, baseline, doubledCost, pressureBaseline].every(metrics => metrics?.dataComplete === true),
    profitableDays60: validMetrics && candidate.profitableDayRatio >= BTC_DAILY_TARGET.targetRatio,
    improvement: validMetrics && candidate.profitableDayRatio > baseline.profitableDayRatio,
    positiveNetReturn: validMetrics && candidate.totalReturn > 0,
    noReturnDeterioration: validMetrics && candidate.totalReturn >= baseline.totalReturn,
    noDrawdownDeterioration: validMetrics && candidate.maxDrawdown >= baseline.maxDrawdown,
    noTailDeterioration: validMetrics && candidate.worstDayReturn >= baseline.worstDayReturn && candidate.expectedShortfall95 <= baseline.expectedShortfall95,
    positiveDoubleCostReturn: validMetrics && doubledCost.totalReturn > 0,
    doubleCostProfitableDays60: validMetrics && doubledCost.profitableDayRatio >= BTC_DAILY_TARGET.targetRatio,
    noDoubleCostReturnDeterioration: validMetrics && doubledCost.totalReturn >= pressureBaseline.totalReturn,
    noDoubleCostDrawdownDeterioration: validMetrics && doubledCost.maxDrawdown >= pressureBaseline.maxDrawdown,
    noDoubleCostTailDeterioration: validMetrics && doubledCost.worstDayReturn >= pressureBaseline.worstDayReturn
      && doubledCost.expectedShortfall95 <= pressureBaseline.expectedShortfall95,
  };
  const passed = Object.values(checks).every(Boolean);
  const annualized10Met = validMetrics && candidate.annualizedReturn >= BTC_DAILY_TARGET.retainedAnnualizedReturnTarget
    && doubledCost.annualizedReturn >= BTC_DAILY_TARGET.retainedAnnualizedReturnTarget;
  return { passed, checks, failedChecks: Object.keys(checks).filter(key => !checks[key]),
    annualized10Met, eligibleForForward: passed && annualized10Met,
    doubleCostComparison: doubleCostBaseline ? 'same_cost_baseline' : 'standard_cost_baseline_conservative_fallback',
    automaticPromotion: false, leverageIncreaseAllowed: false };
}
