import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONTHLY_ACCURACY_PAPER_PROFILE } from '../src/monthly-accuracy-paper.js';
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
const fieldName = 'monthlyProfitLockNetOfExitCost';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function percent(value) {
  return value === null || value === undefined ? '--' : `${(Number(value) * 100).toFixed(2)}%`;
}

function candidateProfile({ id, name, marketNeutralEnabled, trendEnabled }) {
  const profile = clone(MONTHLY_ACCURACY_PAPER_PROFILE);
  profile.id = id;
  profile.name = name;
  profile.marketNeutral[fieldName] = marketNeutralEnabled;
  profile.trend[fieldName] = trendEnabled;
  return profile;
}

const baselineProfile = candidateProfile({
  id: 'paper-net-lock-baseline',
  name: '正式执行时点基准｜退出成本未计入止盈判断',
  marketNeutralEnabled: false,
  trendEnabled: false,
});
const primaryProfile = candidateProfile({
  id: 'paper-net-lock-both',
  name: '净退出成本止盈｜横截面与趋势同时开启',
  marketNeutralEnabled: true,
  trendEnabled: true,
});
const diagnosticProfiles = [
  candidateProfile({
    id: 'paper-net-lock-cross-only',
    name: '净退出成本止盈诊断｜仅横截面',
    marketNeutralEnabled: true,
    trendEnabled: false,
  }),
  candidateProfile({
    id: 'paper-net-lock-trend-only',
    name: '净退出成本止盈诊断｜仅趋势',
    marketNeutralEnabled: false,
    trendEnabled: true,
  }),
];

function behaviorFingerprint(state, period) {
  const behavior = (state.reports || [])
    .filter((report) => report.kind === 'daily')
    .filter((report) => (
      report.cycleDate >= period.startDate && report.cycleDate <= period.endDate
    ))
    .map((report) => ({
      date: report.cycleDate,
      dayReturn: report.dayReturn,
      settledLocks: report.settledLocks,
      turnover: report.turnover,
      modelGrossExposure: report.modelGrossExposure,
    }));
  return crypto.createHash('sha256').update(JSON.stringify(behavior)).digest('hex');
}

function lockEvaluationModes(state, period) {
  return [...new Set((state.reports || [])
    .filter((report) => report.kind === 'daily')
    .filter((report) => (
      report.cycleDate >= period.startDate && report.cycleDate <= period.endDate
    ))
    .flatMap((report) => [
      report.settledLockEvaluation?.marketNeutral?.mode,
      report.settledLockEvaluation?.trend?.mode,
    ])
    .filter(Boolean))].sort();
}

function replayEvaluation(profile, market, throughCycleDate, period) {
  const state = replayPaperResearchProfile({ profile, market, throughCycleDate });
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      marketNeutralNetLock: Boolean(profile.marketNeutral[fieldName]),
      trendNetLock: Boolean(profile.trend[fieldName]),
    },
    state,
    metrics: paperResearchPeriodMetrics(state, period),
    fingerprint: behaviorFingerprint(state, period),
    lockEvaluationModes: lockEvaluationModes(state, period),
  };
}

function developmentChecks(candidate, baseline) {
  return {
    behaviorChanged: candidate.fingerprint !== baseline.fingerprint,
    positiveMonthsNotLower:
      candidate.metrics.positiveMonths >= baseline.metrics.positiveMonths,
    annualizedReturnNotLower:
      candidate.metrics.annualizedReturn >= baseline.metrics.annualizedReturn,
    drawdownNotWorse:
      candidate.metrics.maxDrawdown >= baseline.metrics.maxDrawdown,
  };
}

function admissionDecision({
  engineFieldEffective,
  development,
  baselineFull,
  selectedFull,
  baselineDoubleCost,
  selectedDoubleCost,
}) {
  if (!engineFieldEffective) {
    return {
      qualifiedForNewShadow: false,
      checks: {},
      reason: `正式paper引擎尚未观察到 ${fieldName} 对行为的影响，按fail-closed处理。`,
    };
  }
  if (!development || !Object.values(development.checks).every(Boolean)) {
    return {
      qualifiedForNewShadow: false,
      checks: development?.checks || {},
      reason: '主候选未通过只看开发期的盈利月、年化与回撤门槛，冻结验证未用于选参。',
    };
  }
  const baselineValidation = baselineFull.validation;
  const selectedValidation = selectedFull.validation;
  const baselineHistorical = baselineFull.historical;
  const selectedHistorical = selectedFull.historical;
  const checks = {
    validationPositiveMonthsNotLower:
      selectedValidation.positiveMonths >= baselineValidation.positiveMonths,
    validationAnnualizedNotLower:
      selectedValidation.annualizedReturn >= baselineValidation.annualizedReturn,
    validationDrawdownNotWorse:
      selectedValidation.maxDrawdown >= baselineValidation.maxDrawdown,
    validationDrawdownPromotionLimit: selectedValidation.maxDrawdown >= -0.12,
    historicalAnnualizedNotLower:
      selectedHistorical.annualizedReturn >= baselineHistorical.annualizedReturn,
    historicalDrawdownNotWorse:
      selectedHistorical.maxDrawdown >= baselineHistorical.maxDrawdown,
    doubleCostPositiveMonthTarget: selectedDoubleCost.validation.positiveMonthRatio >= 0.80,
    doubleCostAnnualizedTarget: selectedDoubleCost.validation.annualizedReturn >= 0.10,
    doubleCostAnnualizedNotLower:
      selectedDoubleCost.validation.annualizedReturn
        >= baselineDoubleCost.validation.annualizedReturn,
    doubleCostDrawdownLimit: selectedDoubleCost.validation.maxDrawdown >= -0.15,
  };
  return {
    qualifiedForNewShadow: Object.values(checks).every(Boolean),
    checks,
    reason: Object.values(checks).every(Boolean)
      ? null
      : '冻结验证、全历史、12%回撤晋级上限或双倍成本门槛未全部通过。',
  };
}

function compactEvaluation(evaluation) {
  if (!evaluation) return null;
  return {
    profile: evaluation.profile,
    metrics: evaluation.metrics,
    fingerprint: evaluation.fingerprint,
    lockEvaluationModes: evaluation.lockEvaluationModes,
    behaviorChangedFromBaseline: evaluation.behaviorChangedFromBaseline,
    checks: evaluation.checks,
  };
}

function metricsRow(name, metrics) {
  return `| ${name} | ${metrics.positiveMonths}/${metrics.monthCount} | ${percent(metrics.annualizedReturn)} | ${percent(metrics.maxDrawdown)} | ${percent(metrics.totalReturn)} |`;
}

function markdown(report) {
  const lines = [
    '# 正式执行时点净退出成本止盈研究',
    '',
    `- 数据截止cycle：${report.dataEndCycleDate}`,
    `- 初始化signal/cycle：${report.timing.initializationSignalDate} / ${report.timing.initializationCycleDate}`,
    `- 开发区间：${developmentPeriod.startDate} 至 ${developmentPeriod.endDate}`,
    `- 冻结验证：${validationPeriod.startDate} 至 ${validationPeriod.endDate}`,
    '- 执行口径：前一UTC日23:59收盘形成信号，次日00:59（上海09:00）成交并估值。',
    `- 引擎字段已生效：${report.engineFieldEffective ? '是' : '否'}`,
    `- 新影子准入：${report.decision.qualifiedForNewShadow ? '通过' : '未通过'}`,
    '',
    '## 开发期（仅此区间参与候选选择）',
    '',
    '| 方案 | 盈利月 | 年化 | 最大回撤 | 累计 |',
    '| --- | ---: | ---: | ---: | ---: |',
    metricsRow(report.development.baseline.profile.name, report.development.baseline.metrics),
    metricsRow(report.development.primary.profile.name, report.development.primary.metrics),
    ...report.development.diagnostics.map((item) => metricsRow(item.profile.name, item.metrics)),
    '',
  ];
  if (report.selected) {
    lines.push(
      '## 冻结验证与成本压力',
      '',
      '| 方案 | 盈利月 | 年化 | 最大回撤 | 累计 |',
      '| --- | ---: | ---: | ---: | ---: |',
      metricsRow('基准1x冻结验证', report.full.baseline.validation),
      metricsRow('候选1x冻结验证', report.full.selected.validation),
      metricsRow('基准2x冻结验证', report.doubleCost.baseline.validation),
      metricsRow('候选2x冻结验证', report.doubleCost.selected.validation),
      metricsRow('基准1x全历史', report.full.baseline.historical),
      metricsRow('候选1x全历史', report.full.selected.historical),
      '',
    );
  }
  lines.push(
    '## 准入检查',
    '',
    ...(Object.keys(report.decision.checks).length
      ? Object.entries(report.decision.checks).map(([key, passed]) => `- ${passed ? '通过' : '失败'}：${key}`)
      : [`- ${report.decision.reason}`]),
    '',
    '候选只看开发期选择；冻结验证不会反向参与选参。2x成本使用fresh state完整重跑，不做线性扣减。',
    '未通过时不新增影子、不修改冻结基准，也不代表未来收益。',
    '',
  );
  return lines.join('\n');
}

const allProfiles = [baselineProfile, primaryProfile, ...diagnosticProfiles];
const market = await loadPaperResearchReplayMarket({
  rootDir,
  profiles: allProfiles,
  developmentStartDate: developmentPeriod.startDate,
});
const baselineDevelopment = replayEvaluation(
  baselineProfile,
  market,
  developmentPeriod.endDate,
  developmentPeriod,
);
const primaryDevelopment = replayEvaluation(
  primaryProfile,
  market,
  developmentPeriod.endDate,
  developmentPeriod,
);
primaryDevelopment.behaviorChangedFromBaseline =
  primaryDevelopment.fingerprint !== baselineDevelopment.fingerprint;
primaryDevelopment.checks = developmentChecks(primaryDevelopment, baselineDevelopment);
const diagnosticDevelopment = diagnosticProfiles.map((profile) => {
  const evaluation = replayEvaluation(profile, market, developmentPeriod.endDate, developmentPeriod);
  evaluation.behaviorChangedFromBaseline = evaluation.fingerprint !== baselineDevelopment.fingerprint;
  return evaluation;
});
const engineFieldEffective = baselineDevelopment.lockEvaluationModes.includes('gross')
  && primaryDevelopment.lockEvaluationModes.includes('net_of_exit_cost');
const selectedProfile = engineFieldEffective
  && Object.values(primaryDevelopment.checks).every(Boolean)
  ? primaryProfile
  : null;

function fullEvaluation(profile, costMultiplier = 1) {
  const effectiveProfile = costMultiplier === 1
    ? profile
    : paperProfileWithCostMultiplier(profile, costMultiplier, `net-lock-${costMultiplier}x`);
  const state = replayPaperResearchProfile({ profile: effectiveProfile, market });
  return {
    profile: {
      id: effectiveProfile.id,
      name: effectiveProfile.name,
      costMultiplier,
    },
    validation: paperResearchPeriodMetrics(state, validationPeriod),
    historical: paperResearchPeriodMetrics(state, {
      startDate: developmentPeriod.startDate,
      endDate: market.throughCycleDate,
    }),
  };
}

const baselineFull = fullEvaluation(baselineProfile);
const baselineDoubleCost = fullEvaluation(baselineProfile, 2);
const selectedFull = selectedProfile ? fullEvaluation(selectedProfile) : null;
const selectedDoubleCost = selectedProfile ? fullEvaluation(selectedProfile, 2) : null;
const decision = admissionDecision({
  engineFieldEffective,
  development: {
    checks: primaryDevelopment.checks,
  },
  baselineFull,
  selectedFull,
  baselineDoubleCost,
  selectedDoubleCost,
});
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  dataEndCycleDate: market.throughCycleDate,
  signalEndDate: market.signalEndDate,
  developmentPeriod,
  validationPeriod,
  historicalPeriod: {
    startDate: developmentPeriod.startDate,
    endDate: market.throughCycleDate,
  },
  timing: {
    timezone: 'Asia/Shanghai',
    schedule: '09:00',
    signalBoundary: 'previous_utc_day_23_59_close',
    executionBoundary: 'cycle_utc_00_59_close',
    initializationSignalDate: market.initializationSignalDate,
    initializationCycleDate: market.initializationCycleDate,
    commonWarmupDays: market.commonWarmupDays,
  },
  source: market.source,
  candidateField: fieldName,
  primaryCandidateId: primaryProfile.id,
  diagnosticCandidateIds: diagnosticProfiles.map((profile) => profile.id),
  engineFieldEffective,
  development: {
    baseline: compactEvaluation(baselineDevelopment),
    primary: compactEvaluation(primaryDevelopment),
    diagnostics: diagnosticDevelopment.map(compactEvaluation),
  },
  selected: selectedProfile ? {
    id: selectedProfile.id,
    name: selectedProfile.name,
  } : null,
  full: {
    baseline: baselineFull,
    selected: selectedFull,
  },
  doubleCost: {
    baseline: baselineDoubleCost,
    selected: selectedDoubleCost,
  },
  decision,
  targetDisclaimer: '年化10%、80%盈利月和回撤门槛是影子准入检查，不是收益或胜率保证。',
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, 'net-lock-latest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(path.join(outputDir, 'net-lock-latest.md'), `${markdown(report)}\n`, 'utf8');

console.table({
  基准开发: {
    盈利月: `${baselineDevelopment.metrics.positiveMonths}/${baselineDevelopment.metrics.monthCount}`,
    年化: percent(baselineDevelopment.metrics.annualizedReturn),
    回撤: percent(baselineDevelopment.metrics.maxDrawdown),
  },
  主候选开发: {
    盈利月: `${primaryDevelopment.metrics.positiveMonths}/${primaryDevelopment.metrics.monthCount}`,
    年化: percent(primaryDevelopment.metrics.annualizedReturn),
    回撤: percent(primaryDevelopment.metrics.maxDrawdown),
  },
  基准冻结: {
    盈利月: `${baselineFull.validation.positiveMonths}/${baselineFull.validation.monthCount}`,
    年化: percent(baselineFull.validation.annualizedReturn),
    回撤: percent(baselineFull.validation.maxDrawdown),
  },
});
console.log(JSON.stringify({
  dataEndCycleDate: report.dataEndCycleDate,
  engineFieldEffective,
  selected: report.selected?.id || null,
  qualifiedForNewShadow: decision.qualifiedForNewShadow,
  reason: decision.reason,
}));
