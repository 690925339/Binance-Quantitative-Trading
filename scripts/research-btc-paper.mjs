import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advanceBtcPaperState,
  BTC_SINGLE_ASSET_PAPER_PROFILE,
  initializeBtcPaperState,
} from '../src/btc-paper.js';
import {
  loadPaperResearchReplayMarket,
  paperResearchPeriodMetrics,
} from '../src/paper-research-replay.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const developmentPeriod = Object.freeze({ startDate: '2023-01-01', endDate: '2024-12-31' });
const validationPeriod = Object.freeze({ startDate: '2025-01-01', endDate: '2026-06-30' });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function costProfile(multiplier) {
  const profile = clone(BTC_SINGLE_ASSET_PAPER_PROFILE);
  profile.id = `${profile.id}-${multiplier}x-cost`;
  profile.name = `${profile.name}｜${multiplier}x成本`;
  profile.tradingCostRate *= multiplier;
  profile.dailyCarryCostRate *= multiplier;
  profile.trend.tradingCostRate *= multiplier;
  profile.trend.dailyCarryCostRate *= multiplier;
  return profile;
}

function replay(profile, market) {
  const state = initializeBtcPaperState({
    seriesBySymbol: market.seriesBySymbol,
    cycleDate: market.initializationCycleDate,
    markPrice: market.markPricesByCycleDate[market.initializationCycleDate].BTCUSDT,
    initialCapital: 10_000,
    now: Date.parse(`${market.initializationCycleDate}T01:00:00.000Z`),
    profile,
    entryMode: 'historical_09_00_mark',
  });
  advanceBtcPaperState({
    state,
    seriesBySymbol: market.seriesBySymbol,
    markPricesByCycleDate: market.markPricesByCycleDate,
    throughCycleDate: market.throughCycleDate,
    now: Date.parse(`${market.throughCycleDate}T01:00:00.000Z`),
    profile,
  });
  return state;
}

function buyHoldMetrics(market, period) {
  const dates = Object.keys(market.markPricesByCycleDate)
    .filter((date) => date >= period.startDate && date <= period.endDate)
    .sort();
  const prices = dates.map((date) => market.markPricesByCycleDate[date].BTCUSDT);
  let peak = prices[0];
  let maxDrawdown = 0;
  for (const price of prices) {
    peak = Math.max(peak, price);
    maxDrawdown = Math.min(maxDrawdown, price / peak - 1);
  }
  const elapsedDays = Math.max(1, Math.round(
    (Date.parse(`${dates.at(-1)}T00:00:00.000Z`) - Date.parse(`${dates[0]}T00:00:00.000Z`))
      / 86_400_000,
  ) + 1);
  const totalReturn = prices.at(-1) / prices[0] - 1;
  return {
    startDate: dates[0],
    endDate: dates.at(-1),
    totalReturn,
    annualizedReturn: (1 + totalReturn) ** (365 / elapsedDays) - 1,
    maxDrawdown,
  };
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function row(label, metrics) {
  return `| ${label} | ${metrics.positiveMonths ?? '--'}/${metrics.monthCount ?? '--'} | ${percent(metrics.totalReturn)} | ${percent(metrics.annualizedReturn)} | ${percent(metrics.maxDrawdown)} | ${metrics.peakGrossExposure === undefined ? '--' : percent(metrics.peakGrossExposure)} |`;
}

const loaderProfile = {
  id: 'btc-paper-research-loader',
  marketNeutral: { lookbackDays: 1 },
  trend: BTC_SINGLE_ASSET_PAPER_PROFILE.trend,
};
const market = await loadPaperResearchReplayMarket({
  rootDir,
  profiles: [loaderProfile],
  developmentStartDate: developmentPeriod.startDate,
});
const historicalPeriod = {
  startDate: developmentPeriod.startDate,
  endDate: market.throughCycleDate,
};
const standardState = replay(BTC_SINGLE_ASSET_PAPER_PROFILE, market);
const doubleCostState = replay(costProfile(2), market);
const results = {
  development: paperResearchPeriodMetrics(standardState, developmentPeriod),
  validation: paperResearchPeriodMetrics(standardState, validationPeriod),
  historical: paperResearchPeriodMetrics(standardState, historicalPeriod),
  doubleCostValidation: paperResearchPeriodMetrics(doubleCostState, validationPeriod),
  buyHoldValidation: buyHoldMetrics(market, validationPeriod),
};
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  dataEndCycleDate: market.throughCycleDate,
  developmentPeriod,
  validationPeriod,
  historicalPeriod,
  profile: BTC_SINGLE_ASSET_PAPER_PROFILE,
  timing: {
    timezone: 'Asia/Shanghai',
    signalBoundary: 'previous_utc_day_23_59_close',
    executionBoundary: 'cycle_utc_00_59_close',
    initializationSignalDate: market.initializationSignalDate,
    initializationCycleDate: market.initializationCycleDate,
  },
  results,
  evidenceStatus: 'fixed_previous_strategy_parameters_forward_paper_only',
  decision: '该单币盘是独立前向实验，不替换组合正式盘；历史结果只用于披露风险。',
  disclaimer: 'BTC单币持仓缺少横截面分散，可能出现长期回撤；历史收益不保证未来表现。',
};
const lines = [
  '# BTC单币动态多空模拟盘研究',
  '',
  `- 数据截止cycle：${market.throughCycleDate}`,
  '- 参数来源：沿用既有45/90/180日趋势、2票确认、10%波动率目标、1至3倍动态风险预算、1.5%月度亏损保护。',
  '- 新闻：历史没有逐时点快照，因此回测只验证价格信号；前向盘仅在BTC专属同方向官方确认或独立多源事件与仓位冲突时降至75%。',
  '- 定位：独立实验盘，不替换85/15组合盘。',
  '',
  '| 区间 | 盈利月 | 累计 | 年化 | 最大回撤 | 峰值敞口 |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  row('BTC策略｜开发', results.development),
  row('BTC策略｜验证', results.validation),
  row('BTC策略｜全历史', results.historical),
  row('BTC策略｜2x成本验证', results.doubleCostValidation),
  `| BTC买入持有｜验证 | --/-- | ${percent(results.buyHoldValidation.totalReturn)} | ${percent(results.buyHoldValidation.annualizedReturn)} | ${percent(results.buyHoldValidation.maxDrawdown)} | 100.00% |`,
  '',
  report.decision,
  report.disclaimer,
  '',
];
const outputDir = path.join(rootDir, 'data', 'runtime', 'paper-research');
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, 'btc-single-asset-latest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(
  path.join(outputDir, 'btc-single-asset-latest.md'),
  `${lines.join('\n')}\n`,
  'utf8',
);
console.table({
  开发: {
    盈利月: `${results.development.positiveMonths}/${results.development.monthCount}`,
    年化: percent(results.development.annualizedReturn),
    回撤: percent(results.development.maxDrawdown),
  },
  验证: {
    盈利月: `${results.validation.positiveMonths}/${results.validation.monthCount}`,
    年化: percent(results.validation.annualizedReturn),
    回撤: percent(results.validation.maxDrawdown),
  },
  双倍成本验证: {
    盈利月: `${results.doubleCostValidation.positiveMonths}/${results.doubleCostValidation.monthCount}`,
    年化: percent(results.doubleCostValidation.annualizedReturn),
    回撤: percent(results.doubleCostValidation.maxDrawdown),
  },
});
