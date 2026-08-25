import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE } from '../src/monthly-accuracy-paper.js';
import { PAPER_SHADOW_PROFILES } from '../src/paper-strategy-review.js';
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
const candidatePositionsPerSide = 2;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function percent(value) {
  if (value === null || value === undefined) return '--';
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function profileWithoutMetadataAndCandidateField(profile) {
  const comparable = clone(profile);
  delete comparable.id;
  delete comparable.name;
  delete comparable.baselineProfileId;
  delete comparable.role;
  delete comparable.hypothesis;
  if (comparable.cashWeight === 0) delete comparable.cashWeight;
  if (comparable.newsOverlay === null) delete comparable.newsOverlay;
  delete comparable.marketNeutral.positionsPerSide;
  return comparable;
}

function assertSingleVariableCandidate(baseline, candidate) {
  const baselinePositions = baseline.marketNeutral.positionsPerSide;
  const candidatePositions = candidate.marketNeutral.positionsPerSide;
  if (baselinePositions !== 1 || candidatePositions !== candidatePositionsPerSide) {
    throw new Error('预注册候选必须且只能把 positionsPerSide 从1改为2');
  }
  if (JSON.stringify(profileWithoutMetadataAndCandidateField(baseline))
    !== JSON.stringify(profileWithoutMetadataAndCandidateField(candidate))) {
    throw new Error('预注册候选除 positionsPerSide 外还包含其他策略参数变化');
  }
}

function candidateProfile() {
  const profile = PAPER_SHADOW_PROFILES.find((item) => (
    item.id === 'shadow-continuous-diversified-v1'
  ));
  if (!profile) throw new Error('未找到待前向跟踪的v3分散影子配置');
  return clone(profile);
}

function evaluate(profile, market, historicalPeriod) {
  const state = replayPaperResearchProfile({
    profile,
    market,
    throughCycleDate: market.throughCycleDate,
  });
  return {
    development: paperResearchPeriodMetrics(state, developmentPeriod),
    validation: paperResearchPeriodMetrics(state, validationPeriod),
    historical: paperResearchPeriodMetrics(state, historicalPeriod),
  };
}

function admissionDecision({ baseline, candidate, baselineDoubleCost, candidateDoubleCost }) {
  const checks = {
    developmentPositiveMonthTarget: candidate.development.positiveMonthRatio >= 0.80,
    developmentAnnualizedTarget: candidate.development.annualizedReturn >= 0.10,
    developmentDrawdownLimit: candidate.development.maxDrawdown >= -0.20,
    developmentPositiveMonthsNotLower:
      candidate.development.positiveMonths >= baseline.development.positiveMonths,
    developmentDrawdownImproved:
      candidate.development.maxDrawdown > baseline.development.maxDrawdown,
    validationPositiveMonthTarget: candidate.validation.positiveMonthRatio >= 0.80,
    validationAnnualizedTarget: candidate.validation.annualizedReturn >= 0.10,
    validationDrawdownLimit: candidate.validation.maxDrawdown >= -0.15,
    validationPositiveMonthsNotLower:
      candidate.validation.positiveMonths >= baseline.validation.positiveMonths,
    validationAnnualizedReturnRetainsEightyPercent:
      candidate.validation.annualizedReturn >= baseline.validation.annualizedReturn * 0.80,
    validationDrawdownImproved:
      candidate.validation.maxDrawdown > baseline.validation.maxDrawdown,
    historicalPositiveMonthTarget: candidate.historical.positiveMonthRatio >= 0.80,
    historicalAnnualizedTarget: candidate.historical.annualizedReturn >= 0.10,
    historicalDrawdownLimit: candidate.historical.maxDrawdown >= -0.20,
    historicalDrawdownImproved:
      candidate.historical.maxDrawdown > baseline.historical.maxDrawdown,
    historicalWorstDayImproved:
      candidate.historical.worstDayReturn > baseline.historical.worstDayReturn,
    p95SingleAssetExposureReducedByFortyPercent:
      candidate.historical.p95AssetExposure <= baseline.historical.p95AssetExposure * 0.60,
    doubleCostPositiveMonthTarget: candidateDoubleCost.positiveMonthRatio >= 0.80,
    doubleCostAnnualizedTarget: candidateDoubleCost.annualizedReturn >= 0.10,
    doubleCostDrawdownLimit: candidateDoubleCost.maxDrawdown >= -0.15,
    doubleCostPositiveMonthsNotLower:
      candidateDoubleCost.positiveMonths >= baselineDoubleCost.positiveMonths,
    doubleCostAnnualizedReturnRetainsEightyPercent:
      candidateDoubleCost.annualizedReturn >= baselineDoubleCost.annualizedReturn * 0.80,
    doubleCostDrawdownImproved:
      candidateDoubleCost.maxDrawdown > baselineDoubleCost.maxDrawdown,
  };
  const qualifiedForNewShadow = Object.values(checks).every(Boolean);
  return {
    qualifiedForNewShadow,
    checks,
    reason: qualifiedForNewShadow
      ? null
      : '开发、冻结验证、全样本、集中度或2倍成本门槛未全部通过。',
  };
}

function metricsRow(label, metrics) {
  return `| ${label} | ${metrics.positiveMonths}/${metrics.monthCount} | ${percent(metrics.annualizedReturn)} | ${percent(metrics.maxDrawdown)} | ${percent(metrics.worstDayReturn)} | ${percent(metrics.p95AssetExposure)} |`;
}

function markdown(report) {
  const decisionLines = Object.entries(report.decision.checks).map(([key, passed]) => (
    `- ${passed ? '通过' : '失败'}：${key}`
  ));
  return [
    '# 持续交易降风险组合｜横截面分散单变量复验',
    '',
    `- 数据截止cycle：${report.dataEndCycleDate}`,
    `- 初始化signal/cycle：${report.timing.initializationSignalDate} / ${report.timing.initializationCycleDate}`,
    `- 开发区间：${developmentPeriod.startDate} 至 ${developmentPeriod.endDate}`,
    `- 冻结验证：${validationPeriod.startDate} 至 ${validationPeriod.endDate}`,
    `- 全样本：${report.historicalPeriod.startDate} 至 ${report.historicalPeriod.endDate}`,
    '- 唯一变量：横截面每侧持仓数 positionsPerSide 从1改为2。',
    '- 执行口径：前一UTC日23:59收盘形成信号，次日00:59（上海09:00）成交并估值。',
    '- 没有参数网格；但该验证区间在既往优化中已经查看过，不是未触碰的全新样本。',
    '- 因此历史结果只能授予新影子盘资格，不能直接替换正式盘。',
    `- 新影子准入：${report.decision.qualifiedForNewShadow ? '通过' : '未通过'}`,
    '',
    '| 区间与方案 | 盈利月 | 年化 | 最大回撤 | 最差日 | P95单币敞口 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    metricsRow('开发｜持续降风险基准｜每侧1币', report.standard.baseline.development),
    metricsRow('开发｜预注册候选｜每侧2币', report.standard.candidate.development),
    metricsRow('冻结验证｜持续降风险基准｜每侧1币', report.standard.baseline.validation),
    metricsRow('冻结验证｜预注册候选｜每侧2币', report.standard.candidate.validation),
    metricsRow('全样本｜持续降风险基准｜每侧1币', report.standard.baseline.historical),
    metricsRow('全样本｜预注册候选｜每侧2币', report.standard.candidate.historical),
    metricsRow('冻结验证2x成本｜持续降风险基准｜每侧1币', report.doubleCost.baseline),
    metricsRow('冻结验证2x成本｜预注册候选｜每侧2币', report.doubleCost.candidate),
    '',
    '## 准入检查',
    '',
    ...decisionLines,
    '',
    report.decision.qualifiedForNewShadow
      ? '候选只获得新增独立影子盘资格，不会自动替换正式盘或回写历史账本。'
      : '候选未通过时保持正式参数不变，不新增影子盘，也不迁移或重算模拟账本。',
    '',
    '历史结果只用于检验固定规则与风险边界，不保证未来收益或盈利月份。',
    '',
  ].join('\n');
}

const baselineProfile = clone(MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE);
const diversifiedProfile = candidateProfile();
assertSingleVariableCandidate(baselineProfile, diversifiedProfile);
const baselineDoubleCostProfile = paperProfileWithCostMultiplier(
  baselineProfile,
  2,
  'continuous-diversification-baseline-2x-cost',
);
const candidateDoubleCostProfile = paperProfileWithCostMultiplier(
  diversifiedProfile,
  2,
  'continuous-diversification-candidate-2x-cost',
);
const market = await loadPaperResearchReplayMarket({
  rootDir,
  profiles: [
    baselineProfile,
    diversifiedProfile,
    baselineDoubleCostProfile,
    candidateDoubleCostProfile,
  ],
  developmentStartDate: developmentPeriod.startDate,
});
const historicalPeriod = Object.freeze({
  startDate: developmentPeriod.startDate,
  endDate: market.throughCycleDate,
});
const baseline = evaluate(baselineProfile, market, historicalPeriod);
const candidate = evaluate(diversifiedProfile, market, historicalPeriod);
const baselineDoubleCostState = replayPaperResearchProfile({
  profile: baselineDoubleCostProfile,
  market,
  throughCycleDate: market.throughCycleDate,
});
const candidateDoubleCostState = replayPaperResearchProfile({
  profile: candidateDoubleCostProfile,
  market,
  throughCycleDate: market.throughCycleDate,
});
const baselineDoubleCost = paperResearchPeriodMetrics(
  baselineDoubleCostState,
  validationPeriod,
);
const candidateDoubleCost = paperResearchPeriodMetrics(
  candidateDoubleCostState,
  validationPeriod,
);
const decision = admissionDecision({
  baseline,
  candidate,
  baselineDoubleCost,
  candidateDoubleCost,
});
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  dataEndCycleDate: market.throughCycleDate,
  developmentPeriod,
  validationPeriod,
  historicalPeriod,
  preRegistration: {
    candidateId: diversifiedProfile.id,
    selectionMethod: 'single_variable_diagnostic_without_grid_search',
    parameterChanges: [{
      path: 'marketNeutral.positionsPerSide',
      baseline: baselineProfile.marketNeutral.positionsPerSide,
      candidate: diversifiedProfile.marketNeutral.positionsPerSide,
    }],
    validationPreviouslyObserved: true,
    validationCanAuthorizeFormalPromotion: false,
  },
  timing: {
    timezone: 'Asia/Shanghai',
    signalBoundary: 'previous_utc_day_23_59_close',
    executionBoundary: 'cycle_utc_00_59_close',
    initializationSignalDate: market.initializationSignalDate,
    initializationCycleDate: market.initializationCycleDate,
  },
  source: market.source,
  profiles: {
    baseline: baselineProfile,
    candidate: diversifiedProfile,
  },
  standard: { baseline, candidate },
  doubleCost: {
    period: validationPeriod,
    baseline: baselineDoubleCost,
    candidate: candidateDoubleCost,
  },
  admissionThresholds: {
    positiveMonthRatio: 0.80,
    annualizedReturn: 0.10,
    developmentMaxDrawdown: -0.20,
    validationMaxDrawdown: -0.15,
    historicalMaxDrawdown: -0.20,
    doubleCostMaxDrawdown: -0.15,
    p95SingleAssetExposureReduction: 0.40,
  },
  decision,
  disclaimer: '历史结果只用于检验固定规则与风险边界，不保证未来收益或盈利月份。',
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, 'continuous-diversification-latest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(
  path.join(outputDir, 'continuous-diversification-latest.md'),
  `${markdown(report)}\n`,
  'utf8',
);

console.table({
  '开发基准｜每侧1币': {
    盈利月: `${baseline.development.positiveMonths}/${baseline.development.monthCount}`,
    年化: percent(baseline.development.annualizedReturn),
    回撤: percent(baseline.development.maxDrawdown),
  },
  '开发候选｜每侧2币': {
    盈利月: `${candidate.development.positiveMonths}/${candidate.development.monthCount}`,
    年化: percent(candidate.development.annualizedReturn),
    回撤: percent(candidate.development.maxDrawdown),
  },
  '冻结基准｜每侧1币': {
    盈利月: `${baseline.validation.positiveMonths}/${baseline.validation.monthCount}`,
    年化: percent(baseline.validation.annualizedReturn),
    回撤: percent(baseline.validation.maxDrawdown),
  },
  '冻结候选｜每侧2币': {
    盈利月: `${candidate.validation.positiveMonths}/${candidate.validation.monthCount}`,
    年化: percent(candidate.validation.annualizedReturn),
    回撤: percent(candidate.validation.maxDrawdown),
  },
  '冻结2x成本候选｜每侧2币': {
    盈利月: `${candidateDoubleCost.positiveMonths}/${candidateDoubleCost.monthCount}`,
    年化: percent(candidateDoubleCost.annualizedReturn),
    回撤: percent(candidateDoubleCost.maxDrawdown),
  },
});
console.log(`新影子准入：${decision.qualifiedForNewShadow ? '通过' : '未通过'}`);
