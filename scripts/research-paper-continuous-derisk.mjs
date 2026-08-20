import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE,
  MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE,
} from '../src/monthly-accuracy-paper.js';
import {
  loadPaperResearchReplayMarket,
  paperProfileWithCostMultiplier,
  paperResearchPeriodMetrics,
  replayPaperResearchProfile,
} from '../src/paper-research-replay.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'data', 'runtime', 'paper-research');
const developmentPeriod = Object.freeze({ startDate: '2023-01-01', endDate: '2024-12-31' });
const validationPeriod = Object.freeze({ startDate: '2025-01-01', endDate: '2026-06-30' });

function percent(value) {
  return value === null || value === undefined ? '--' : `${(Number(value) * 100).toFixed(2)}%`;
}

function evaluation(profile, market, period, costMultiplier = 1) {
  const effectiveProfile = costMultiplier === 1
    ? profile
    : paperProfileWithCostMultiplier(profile, costMultiplier, `continuous-derisk-${costMultiplier}x`);
  const state = replayPaperResearchProfile({ profile: effectiveProfile, market });
  const reports = state.reports.filter((report) => (
    report.kind === 'daily'
      && report.cycleDate >= period.startDate
      && report.cycleDate <= period.endDate
  ));
  const activeDeRiskReports = reports.filter((report) => (
    report.nextProfitDeRisk?.marketNeutral?.active
      || report.nextProfitDeRisk?.trend?.active
  ));
  const sleeveStillExposed = (report) => {
    const positions = Array.isArray(report.positions) ? report.positions : [];
    const marketNeutralActive = report.nextProfitDeRisk?.marketNeutral?.active === true;
    const trendActive = report.nextProfitDeRisk?.trend?.active === true;
    const marketNeutralExposure = positions.reduce(
      (sum, position) => sum + Math.abs(Number(position.marketNeutralWeight || 0)),
      0,
    );
    const trendExposure = positions.reduce(
      (sum, position) => sum + Math.abs(Number(position.trendWeight || 0)),
      0,
    );
    return (!marketNeutralActive || marketNeutralExposure > 0)
      && (!trendActive || trendExposure > 0);
  };
  return {
    profileId: effectiveProfile.id,
    costMultiplier,
    metrics: paperResearchPeriodMetrics(state, period),
    deRiskActivity: {
      activeDays: activeDeRiskReports.length,
      activeDaysWithExposure: activeDeRiskReports.filter(sleeveStillExposed).length,
    },
  };
}

function row(label, result) {
  const metrics = result.metrics;
  return `| ${label} | ${metrics.positiveMonths}/${metrics.monthCount} | ${percent(metrics.annualizedReturn)} | ${percent(metrics.maxDrawdown)} | ${percent(metrics.worstDayReturn)} | ${result.deRiskActivity.activeDaysWithExposure}/${result.deRiskActivity.activeDays} |`;
}

const profiles = [
  MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE,
  MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE,
];
const market = await loadPaperResearchReplayMarket({
  rootDir,
  profiles,
  developmentStartDate: developmentPeriod.startDate,
});
const historicalPeriod = {
  startDate: developmentPeriod.startDate,
  endDate: market.throughCycleDate,
};
const results = {
  development: {
    baseline: evaluation(MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE, market, developmentPeriod),
    candidate: evaluation(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, market, developmentPeriod),
  },
  validation: {
    baseline: evaluation(MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE, market, validationPeriod),
    candidate: evaluation(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, market, validationPeriod),
  },
  historical: {
    baseline: evaluation(MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE, market, historicalPeriod),
    candidate: evaluation(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, market, historicalPeriod),
  },
  doubleCostValidation: {
    baseline: evaluation(MONTHLY_ACCURACY_NO_PROFIT_LOCK_PROFILE, market, validationPeriod, 2),
    candidate: evaluation(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, market, validationPeriod, 2),
  },
};
const checks = {
  developmentPositiveMonthsNotLower:
    results.development.candidate.metrics.positiveMonths
      >= results.development.baseline.metrics.positiveMonths,
  developmentAnnualizedAbove10:
    results.development.candidate.metrics.annualizedReturn >= 0.10,
  developmentDrawdownImproved:
    results.development.candidate.metrics.maxDrawdown
      > results.development.baseline.metrics.maxDrawdown,
  validationPositiveMonthTarget:
    results.validation.candidate.metrics.positiveMonthRatio >= 0.80,
  validationAnnualizedAbove10:
    results.validation.candidate.metrics.annualizedReturn >= 0.10,
  validationDrawdownLimit:
    results.validation.candidate.metrics.maxDrawdown >= -0.15,
  historicalPositiveMonthTarget:
    results.historical.candidate.metrics.positiveMonthRatio >= 0.80,
  historicalAnnualizedAbove10:
    results.historical.candidate.metrics.annualizedReturn >= 0.10,
  historicalDrawdownImproved:
    results.historical.candidate.metrics.maxDrawdown
      > results.historical.baseline.metrics.maxDrawdown,
  doubleCostPositiveMonthTarget:
    results.doubleCostValidation.candidate.metrics.positiveMonthRatio >= 0.80,
  doubleCostAnnualizedAbove10:
    results.doubleCostValidation.candidate.metrics.annualizedReturn >= 0.10,
  doubleCostDrawdownLimit:
    results.doubleCostValidation.candidate.metrics.maxDrawdown >= -0.15,
  continuousExposureWhenDeRisked:
    results.historical.candidate.deRiskActivity.activeDays > 0
      && results.historical.candidate.deRiskActivity.activeDaysWithExposure
        === results.historical.candidate.deRiskActivity.activeDays,
};
const qualified = Object.values(checks).every(Boolean);
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  dataEndCycleDate: market.throughCycleDate,
  developmentPeriod,
  validationPeriod,
  historicalPeriod,
  timing: {
    timezone: 'Asia/Shanghai',
    signalBoundary: 'previous_utc_day_23_59_close',
    executionBoundary: 'cycle_utc_00_59_close',
    initializationSignalDate: market.initializationSignalDate,
    initializationCycleDate: market.initializationCycleDate,
  },
  candidate: {
    id: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.id,
    marketNeutral: {
      threshold: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.marketNeutral
        .monthlyProfitDeRiskThreshold,
      scale: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.marketNeutral.monthlyProfitDeRiskScale,
    },
    trend: {
      threshold: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.trend
        .monthlyProfitDeRiskThreshold,
      scale: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.trend.monthlyProfitDeRiskScale,
    },
    monthlyProfitLocksDisabled: true,
  },
  results,
  checks,
  evidenceStatus: 'exploratory_historical_confirmation_requires_forward_validation',
  selectionDisclosure: '阈值来自本次探索性历史比较，冻结区间不是全新的未观察样本；迁移后仍需以前向模拟盘确认。',
  qualifiedForFormalMigration: qualified,
  decisionReason: qualified
    ? '固定候选通过开发、冻结、全历史、双倍成本和持续持仓检查，可作为风险修复进入前向验证。'
    : '候选未通过全部风险与成本检查，不应迁移正式盘。',
  disclaimer: '该研究只能验证历史执行口径，不保证未来收益；最差单日仍受横截面价差风险影响。',
};
const lines = [
  '# 持续交易月内降风险研究',
  '',
  `- 数据截止cycle：${report.dataEndCycleDate}`,
  '- 候选：横截面月收益达到0.75%、趋势达到1.00%后，各自保留10%实际敞口继续交易，不进入盈利空仓。',
  `- 证据边界：${report.selectionDisclosure}`,
  `- 正式迁移准入：${qualified ? '通过' : '未通过'}`,
  '',
  '| 区间 | 盈利月 | 年化 | 最大回撤 | 最差日 | 降风险日仍有敞口 |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  row('无盈利锁基准｜开发', results.development.baseline),
  row('持续交易降风险｜开发', results.development.candidate),
  row('无盈利锁基准｜冻结验证', results.validation.baseline),
  row('持续交易降风险｜冻结验证', results.validation.candidate),
  row('持续交易降风险｜全历史', results.historical.candidate),
  row('持续交易降风险｜2x成本冻结验证', results.doubleCostValidation.candidate),
  '',
  '## 准入检查',
  '',
  ...Object.entries(checks).map(([key, passed]) => `- ${passed ? '通过' : '失败'}：${key}`),
  '',
  report.decisionReason,
  report.selectionDisclosure,
  report.disclaimer,
  '',
];

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, 'continuous-derisk-latest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(
  path.join(outputDir, 'continuous-derisk-latest.md'),
  `${lines.join('\n')}\n`,
  'utf8',
);
console.table({
  无盈利锁基准冻结: {
    盈利月: `${results.validation.baseline.metrics.positiveMonths}/${results.validation.baseline.metrics.monthCount}`,
    年化: percent(results.validation.baseline.metrics.annualizedReturn),
    回撤: percent(results.validation.baseline.metrics.maxDrawdown),
  },
  持续交易降风险冻结: {
    盈利月: `${results.validation.candidate.metrics.positiveMonths}/${results.validation.candidate.metrics.monthCount}`,
    年化: percent(results.validation.candidate.metrics.annualizedReturn),
    回撤: percent(results.validation.candidate.metrics.maxDrawdown),
  },
  持续交易降风险双倍成本: {
    盈利月: `${results.doubleCostValidation.candidate.metrics.positiveMonths}/${results.doubleCostValidation.candidate.metrics.monthCount}`,
    年化: percent(results.doubleCostValidation.candidate.metrics.annualizedReturn),
    回撤: percent(results.doubleCostValidation.candidate.metrics.maxDrawdown),
  },
});
console.log(JSON.stringify({ qualifiedForFormalMigration: qualified, checks }));
