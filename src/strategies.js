import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMPOSITE_STRATEGY_PROFILES } from './composite-strategies.js';
import { LONG_SHORT_RISK_PROFILES } from './long-short-trend.js';

const SYMBOL_OPTIONS = [
  { value: 'BTCUSDT', label: 'BTC / USDT' },
  { value: 'ETHUSDT', label: 'ETH / USDT' },
  { value: 'BNBUSDT', label: 'BNB / USDT' },
  { value: 'SOLUSDT', label: 'SOL / USDT' },
  { value: 'XRPUSDT', label: 'XRP / USDT' },
  { value: 'DOGEUSDT', label: 'DOGE / USDT' },
];

const LONG_SHORT_STRATEGY_TYPES = ['longShortTrend', 'longShortEnhanced', 'longShortHighReturn'];
const MONTHLY_ACCURACY_STRATEGY_TYPE = 'monthlyAccuracyPortfolio';

const leverageField = (overrides = {}) => ({
  key: 'leverage',
  label: '杠杆倍数',
  type: 'number',
  unit: '×',
  min: 1,
  max: 125,
  step: 1,
  integer: true,
  default: 1,
  help: '按保证金估算最大名义敞口；实际可用上限须由合约交易对规则校验。',
  ...overrides,
});

const compositeFields = (profile) => [
  { key: 'positionMode', label: '交易方向', type: 'select', default: 'both', options: [
    { value: 'both', label: '双向（做多 / 做空）' },
    { value: 'longOnly', label: '仅做多' },
    { value: 'shortOnly', label: '仅做空' },
  ] },
  { key: 'priceSignalWeight', label: '价格信号权重', type: 'number', unit: '%', min: 0, max: 100, step: 1, default: profile.priceSignalWeight },
  { key: 'newsSignalWeight', label: '新闻信号权重', type: 'number', unit: '%', min: 0, max: 100, step: 1, default: profile.newsSignalWeight },
  { key: 'minimumNewsCredibility', label: '新闻最低可信度', type: 'number', unit: '%', min: 50, max: 100, step: 1, default: profile.minimumNewsCredibility },
  { key: 'minimumNewsConfidence', label: '方向最低置信度', type: 'number', unit: '%', min: 40, max: 100, step: 1, default: profile.minimumNewsConfidence },
  { key: 'targetVolatilityPercent', label: '目标年化波动', type: 'number', unit: '%', min: 2, max: 40, step: 0.5, default: profile.targetVolatilityPercent },
  { key: 'maxGrossExposurePercent', label: '最大总敞口', type: 'number', unit: '%', min: 10, max: 200, step: 1, default: profile.maxGrossExposurePercent },
  { key: 'maxAssetExposurePercent', label: '单币最大敞口', type: 'number', unit: '%', min: 1, max: 100, step: 1, default: profile.maxAssetExposurePercent },
  { key: 'portfolioDrawdownLimitPercent', label: '组合回撤熔断', type: 'number', unit: '%', min: 3, max: 50, step: 1, default: profile.portfolioDrawdownLimitPercent },
  ...(profile.accuracyLeverage ? [
    { key: 'accuracyLeverageEnabled', label: '90% 条件杠杆', type: 'select', default: 'enabled', options: [
      { value: 'enabled', label: '启用条件判断' },
      { value: 'disabled', label: '始终保持 1×' },
    ], help: '只统计已经走完 7 天预测窗口的真实信号结果。' },
    { key: 'accuracyLeverageThresholdPercent', label: '最低滚动准确率', type: 'number', unit: '%', min: 90, max: 99, step: 0.1, default: profile.accuracyLeverage.minimumAccuracy * 100 },
    { key: 'accuracyLeverageMinimumSamples', label: '最少已结算信号', type: 'number', unit: '条', min: 100, max: 1_000, step: 1, integer: true, default: profile.accuracyLeverage.minimumSamples },
    { key: 'accuracyLeverageRecentThresholdPercent', label: '最近 20 条最低准确率', type: 'number', unit: '%', min: 80, max: 99, step: 0.1, default: profile.accuracyLeverage.minimumRecentAccuracy * 100 },
    { key: 'accuracyLeverageMultiplier', label: '达标后部分杠杆', type: 'number', unit: '×', min: 1, max: 1.5, step: 0.05, default: profile.accuracyLeverage.leverageMultiplier },
    { key: 'accuracyLeverageMaxVolatilityPercent', label: '允许最高年化波动', type: 'number', unit: '%', min: 2, max: 15, step: 0.5, default: profile.accuracyLeverage.maximumAnnualizedVolatility * 100 },
    { key: 'accuracyLeverageMaxDrawdownPercent', label: '允许最大当前回撤', type: 'number', unit: '%', min: 2, max: 8, step: 0.5, default: profile.accuracyLeverage.maximumDrawdownMagnitude * 100 },
  ] : []),
  { key: 'marginBudget', label: '保证金预算', type: 'number', unit: 'USDT', min: 10, max: 10_000_000, step: 0.01, default: 1_000 },
  leverageField({ max: profile.maxLeverage, default: profile.defaultLeverage, help: `该组合最多允许 ${profile.maxLeverage}× 杠杆。` }),
];

const longShortFields = (profile) => [
  { key: 'positionMode', label: '交易方向', type: 'select', default: 'both', options: [
    { value: 'both', label: '双向（做多 / 做空）' },
    { value: 'longOnly', label: '仅做多' },
    { value: 'shortOnly', label: '仅做空' },
  ], help: '双向模式允许不同交易对同时持有多仓和空仓。' },
  { key: 'shortLookbackDays', label: '短周期回看', type: 'number', unit: '天', min: 5, max: 120, step: 1, integer: true, default: 30 },
  { key: 'mediumLookbackDays', label: '中周期回看', type: 'number', unit: '天', min: 10, max: 240, step: 1, integer: true, default: 90 },
  { key: 'longLookbackDays', label: '长周期回看', type: 'number', unit: '天', min: 20, max: 365, step: 1, integer: true, default: 180 },
  { key: 'volatilityWindowDays', label: '波动率窗口', type: 'number', unit: '天', min: 10, max: 120, step: 1, integer: true, default: 30 },
  { key: 'targetVolatilityPercent', label: '目标年化波动', type: 'number', unit: '%', min: 2, max: 30, step: 0.5, default: profile.targetVolatility * 100 },
  { key: 'maxGrossExposurePercent', label: '最大总敞口', type: 'number', unit: '%', min: 10, max: 200, step: 1, default: profile.maxGrossExposure * 100 },
  { key: 'maxAssetExposurePercent', label: '单币最大敞口', type: 'number', unit: '%', min: 1, max: 100, step: 0.5, default: profile.maxAssetExposure * 100 },
  { key: 'minimumTrendStrengthPercent', label: '最小趋势强度', type: 'number', unit: '%', min: 0, max: 20, step: 0.1, default: 2 },
  { key: 'rebalanceDays', label: '调仓间隔', type: 'number', unit: '天', min: 1, max: 30, step: 1, integer: true, default: 1 },
  { key: 'marginBudget', label: '保证金预算', type: 'number', unit: 'USDT', min: 10, max: 10_000_000, step: 0.01, default: 1_000 },
  leverageField({
    max: profile.maxLeverage,
    default: profile.defaultLeverage,
    help: profile.maxLeverage === 125
      ? '按保证金估算最大名义敞口；实际可用上限须由合约交易对规则校验。'
      : `该风险档最多允许 ${profile.maxLeverage}× 杠杆，仓位仍受 ${profile.maxGrossExposure * 100}% 总敞口上限约束。`,
  }),
];

const monthlyAccuracyFields = () => [
  { key: 'marketNeutralWeightPercent', label: '市场中性仓位权重', type: 'number', unit: '%', min: 50, max: 100, step: 1, default: 85 },
  { key: 'trendWeightPercent', label: '动态趋势仓位权重', type: 'number', unit: '%', min: 0, max: 50, step: 1, default: 15 },
  { key: 'relativeMomentumLookbackDays', label: '相对强弱回看', type: 'number', unit: '天', min: 3, max: 60, step: 1, integer: true, default: 10 },
  { key: 'rebalanceDays', label: '市场中性调仓间隔', type: 'number', unit: '天', min: 1, max: 14, step: 1, integer: true, default: 7 },
  { key: 'positionsPerSide', label: '每侧持仓数量', type: 'number', unit: '个', min: 1, max: 2, step: 1, integer: true, default: 1 },
  { key: 'monthlyProfitLockPercent', label: '市场中性月度盈利锁定', type: 'number', unit: '%', min: 0.2, max: 5, step: 0.1, default: 1 },
  { key: 'marketNeutralBaseGrossExposurePercent', label: '市场中性基础总敞口', type: 'number', unit: '%', min: 10, max: 100, step: 1, default: 50 },
  { key: 'maxGrossExposurePercent', label: '组合最大总敞口', type: 'number', unit: '%', min: 25, max: 200, step: 1, default: 143 },
  { key: 'dynamicMarketNeutralMaxLeverage', label: '市场中性动态倍率上限', type: 'number', unit: '×', min: 1, max: 3, step: 0.1, default: 3 },
  { key: 'relativeDispersionTargetPercent', label: '相对强弱价差目标', type: 'number', unit: '%', min: 1, max: 50, step: 0.5, default: 15 },
  { key: 'dynamicTrendMaxLeverage', label: '趋势仓位动态倍率上限', type: 'number', unit: '×', min: 1, max: 3, step: 0.1, default: 3 },
  { key: 'adaptiveAllocationEnabled', label: '市场宽度动态配比', type: 'select', default: 'disabled', options: [
    { value: 'disabled', label: '关闭（准确率优先默认）' },
    { value: 'enabled', label: '开启（低回撤观察）' },
  ], help: '开启后根据20日市场宽度，在市场中性与趋势仓位之间动态分配；当前研究降低回撤但没有提高盈利月。' },
  { key: 'minimumTrendWeightPercent', label: '动态趋势最小权重', type: 'number', unit: '%', min: 0, max: 50, step: 1, default: 5 },
  { key: 'maximumTrendWeightPercent', label: '动态趋势最大权重', type: 'number', unit: '%', min: 0, max: 50, step: 1, default: 25 },
  { key: 'portfolioDrawdownControlEnabled', label: '组合回撤动态减仓', type: 'select', default: 'disabled', options: [
    { value: 'disabled', label: '关闭（准确率优先默认）' },
    { value: 'enabled', label: '开启（低回撤观察）' },
  ], help: '只使用上一日净值计算回撤，达到起始线后逐步减仓。当前开发选择参数没有通过准确率优先发布门槛。' },
  { key: 'drawdownControlStartPercent', label: '组合减仓起始回撤', type: 'number', unit: '%', min: 1, max: 50, step: 0.5, default: 3 },
  { key: 'drawdownControlFullPercent', label: '组合完全减仓回撤', type: 'number', unit: '%', min: 2, max: 80, step: 0.5, default: 10 },
  { key: 'minimumDrawdownScalePercent', label: '回撤后最低仓位权重', type: 'number', unit: '%', min: 0, max: 100, step: 1, default: 75 },
  { key: 'referenceFilterEnabled', label: '市场状态参考过滤', type: 'select', default: 'disabled', options: [
    { value: 'disabled', label: '关闭（当前冻结默认）' },
    { value: 'enabled', label: '开启（仅观察）' },
  ], help: '启用后以前一日恐惧指数、20日市场波动率和市场宽度缩放市场中性仓位；当前冻结验证未通过，默认关闭。' },
  { key: 'referenceWindowDays', label: '市场状态窗口', type: 'number', unit: '天', min: 5, max: 90, step: 1, integer: true, default: 20 },
  { key: 'fearGreedMinimum', label: '恐惧指数下限', type: 'number', unit: '', min: 0, max: 100, step: 1, default: 20 },
  { key: 'fearGreedMaximum', label: '恐惧指数上限', type: 'number', unit: '', min: 0, max: 100, step: 1, default: 80 },
  { key: 'maximumMarketVolatilityPercent', label: '市场年化波动上限', type: 'number', unit: '%', min: 5, max: 300, step: 1, default: 80 },
  { key: 'maximumBreadthImbalancePercent', label: '市场宽度失衡上限', type: 'number', unit: '%', min: 0, max: 100, step: 1, default: 67 },
  { key: 'referenceOutsideScalePercent', label: '越界后仓位权重', type: 'number', unit: '%', min: 0, max: 100, step: 1, default: 90 },
  { key: 'marginBudget', label: '保证金预算', type: 'number', unit: 'USDT', min: 10, max: 10_000_000, step: 0.01, default: 1_000 },
  leverageField({
    max: 3,
    default: 2,
    help: '只提供不超过 3× 的保证金容量；85/15冻结组合理论总绝对敞口约为净值的142.5%，配置上限取143%。',
  }),
];

export const STRATEGY_CATALOG = {
  grid: {
    type: 'grid',
    name: '现货网格',
    icon: '▦',
    riskLevel: '中风险',
    description: '在设定价格区间内分层低买高卖，适合震荡行情。',
    fields: [
      { key: 'gridMode', label: '网格模式', type: 'select', default: 'arithmetic', options: [
        { value: 'arithmetic', label: '等差网格' }, { value: 'geometric', label: '等比网格' },
      ], help: '等差使用固定价差，等比使用固定百分比。' },
      { key: 'lowerPrice', label: '区间下限', type: 'number', unit: 'USDT', min: 0.00000001, max: 1_000_000_000, step: 'any', default: 50_000 },
      { key: 'upperPrice', label: '区间上限', type: 'number', unit: 'USDT', min: 0.00000001, max: 1_000_000_000, step: 'any', default: 100_000 },
      { key: 'gridCount', label: '网格数量', type: 'number', unit: '格', min: 2, max: 200, step: 1, integer: true, default: 20 },
      { key: 'totalInvestment', label: '计划投入', type: 'number', unit: 'USDT', min: 10, max: 10_000_000, step: 0.01, default: 1_000 },
      leverageField(),
      { key: 'stopLossPrice', label: '止损价格', type: 'number', unit: 'USDT', min: 0, max: 1_000_000_000, step: 'any', default: 45_000, help: '填 0 表示不设置，建议低于区间下限。' },
      { key: 'takeProfitPrice', label: '止盈价格', type: 'number', unit: 'USDT', min: 0, max: 1_000_000_000, step: 'any', default: 105_000, help: '填 0 表示不设置，建议高于区间上限。' },
    ],
  },
  martingale: {
    type: 'martingale',
    name: '马丁补仓',
    icon: 'M',
    riskLevel: '高风险',
    description: '价格回撤时按倍率分批补仓，严格受最大资金上限约束。',
    fields: [
      { key: 'initialOrderAmount', label: '首单金额', type: 'number', unit: 'USDT', min: 5, max: 1_000_000, step: 0.01, default: 20 },
      { key: 'safetyOrderAmount', label: '首笔安全单', type: 'number', unit: 'USDT', min: 5, max: 1_000_000, step: 0.01, default: 20 },
      { key: 'priceDeviationPercent', label: '首次回撤触发', type: 'number', unit: '%', min: 0.1, max: 50, step: 0.1, default: 2 },
      { key: 'volumeMultiplier', label: '补仓金额倍率', type: 'number', unit: '倍', min: 1, max: 5, step: 0.1, default: 1.5 },
      { key: 'stepMultiplier', label: '回撤间距倍率', type: 'number', unit: '倍', min: 1, max: 5, step: 0.1, default: 1.2 },
      { key: 'maxSafetyOrders', label: '最大补仓次数', type: 'number', unit: '次', min: 1, max: 12, step: 1, integer: true, default: 5 },
      { key: 'takeProfitPercent', label: '整体止盈', type: 'number', unit: '%', min: 0.1, max: 100, step: 0.1, default: 1.5 },
      { key: 'stopLossPercent', label: '整体止损', type: 'number', unit: '%', min: 0.1, max: 100, step: 0.1, default: 15 },
      { key: 'maxInvestment', label: '最大资金上限', type: 'number', unit: 'USDT', min: 10, max: 10_000_000, step: 0.01, default: 500 },
      leverageField(),
    ],
  },
  dca: {
    type: 'dca',
    name: '定期定投',
    icon: 'D',
    riskLevel: '中低风险',
    description: '按固定时间间隔分批买入，降低一次性择时影响。',
    fields: [
      { key: 'orderAmount', label: '每次投入', type: 'number', unit: 'USDT', min: 5, max: 1_000_000, step: 0.01, default: 50 },
      { key: 'intervalHours', label: '投入间隔', type: 'number', unit: '小时', min: 1, max: 8_760, step: 1, integer: true, default: 24 },
      { key: 'maxOrders', label: '最多执行次数', type: 'number', unit: '次', min: 1, max: 1_000, step: 1, integer: true, default: 12 },
      { key: 'takeProfitPercent', label: '组合止盈', type: 'number', unit: '%', min: 0.1, max: 500, step: 0.1, default: 10 },
      { key: 'stopLossPercent', label: '组合止损', type: 'number', unit: '%', min: 0.1, max: 100, step: 0.1, default: 20 },
      { key: 'maxInvestment', label: '最大资金上限', type: 'number', unit: 'USDT', min: 5, max: 10_000_000, step: 0.01, default: 1_000 },
      leverageField(),
    ],
  },
  maCrossover: {
    type: 'maCrossover',
    name: '双均线趋势',
    icon: '⌁',
    riskLevel: '中风险',
    description: '快线穿越慢线时生成趋势信号，适合单边行情观察。',
    fields: [
      { key: 'timeframe', label: 'K线周期', type: 'select', default: '1h', options: [
        { value: '15m', label: '15 分钟' }, { value: '1h', label: '1 小时' },
        { value: '4h', label: '4 小时' }, { value: '1d', label: '1 天' },
      ] },
      { key: 'fastPeriod', label: '快线周期', type: 'number', unit: '根', min: 2, max: 200, step: 1, integer: true, default: 9 },
      { key: 'slowPeriod', label: '慢线周期', type: 'number', unit: '根', min: 3, max: 500, step: 1, integer: true, default: 21 },
      { key: 'orderAmount', label: '单次信号资金', type: 'number', unit: 'USDT', min: 5, max: 1_000_000, step: 0.01, default: 100 },
      { key: 'maxPositions', label: '最大同时仓位', type: 'number', unit: '个', min: 1, max: 20, step: 1, integer: true, default: 1 },
      { key: 'takeProfitPercent', label: '单仓止盈', type: 'number', unit: '%', min: 0.1, max: 200, step: 0.1, default: 8 },
      { key: 'stopLossPercent', label: '单仓止损', type: 'number', unit: '%', min: 0.1, max: 100, step: 0.1, default: 4 },
      { key: 'maxInvestment', label: '最大资金上限', type: 'number', unit: 'USDT', min: 5, max: 10_000_000, step: 0.01, default: 100 },
      leverageField(),
    ],
  },
  longShortTrend: {
    type: 'longShortTrend',
    name: '多空趋势组合',
    icon: '↕',
    riskLevel: '中高风险',
    description: '使用多周期趋势投票决定做多或做空，并按波动率分配仓位。',
    portfolio: true,
    universe: SYMBOL_OPTIONS.map((item) => item.value),
    fields: longShortFields(LONG_SHORT_RISK_PROFILES.baseline),
  },
  longShortEnhanced: {
    type: 'longShortEnhanced',
    name: '多空趋势组合（收益增强）',
    icon: '↟',
    riskLevel: '高风险',
    description: '保持原趋势信号不变，将风险预算提高到 1.5×；历史收益更高，但回撤同步放大。',
    portfolio: true,
    universe: SYMBOL_OPTIONS.map((item) => item.value),
    fields: longShortFields(LONG_SHORT_RISK_PROFILES.enhanced),
  },
  longShortHighReturn: {
    type: 'longShortHighReturn',
    name: '多空趋势组合（高收益）',
    icon: '⇈',
    riskLevel: '极高风险',
    description: '使用 2.0× 风险预算冲击 10% 以上长期年化；当前回测达标，但历史回撤接近 -28%。',
    portfolio: true,
    universe: SYMBOL_OPTIONS.map((item) => item.value),
    fields: longShortFields(LONG_SHORT_RISK_PROFILES.highReturn),
  },
  monthlyAccuracyPortfolio: {
    type: MONTHLY_ACCURACY_STRATEGY_TYPE,
    name: '90% 盈利月多空组合',
    icon: '◎',
    riskLevel: '高风险研究型',
    description: '85% 动态市场中性动量叠加15%动态趋势仓位；2023年至今盈利月为38/42，但不保证未来保持。',
    portfolio: true,
    universe: SYMBOL_OPTIONS.map((item) => item.value),
    fields: monthlyAccuracyFields(),
  },
  stableComposite: {
    type: 'stableComposite',
    name: COMPOSITE_STRATEGY_PROFILES.stableComposite.name,
    icon: 'S',
    riskLevel: '稳健型',
    description: '价格趋势为主，只有高可信新闻才以较低权重参与方向判断。',
    fields: compositeFields(COMPOSITE_STRATEGY_PROFILES.stableComposite),
  },
  aggressiveComposite: {
    type: 'aggressiveComposite',
    name: COMPOSITE_STRATEGY_PROFILES.aggressiveComposite.name,
    icon: 'A',
    riskLevel: '进取型',
    description: '提高新闻信号与风险预算，对高影响事件反应更快，回撤容忍度更高。',
    fields: compositeFields(COMPOSITE_STRATEGY_PROFILES.aggressiveComposite),
  },
};

export const STRATEGY_SYMBOLS = SYMBOL_OPTIONS;

export class StrategyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StrategyValidationError';
    this.status = 400;
  }
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function normalizeField(field, value) {
  if (field.type === 'select') {
    const normalized = String(value ?? field.default);
    if (!field.options.some((option) => option.value === normalized)) {
      throw new StrategyValidationError(`${field.label}选项无效`);
    }
    return normalized;
  }
  const normalized = Number(value ?? field.default);
  if (!Number.isFinite(normalized)) throw new StrategyValidationError(`${field.label}必须是有效数字`);
  if (normalized < field.min || normalized > field.max) {
    throw new StrategyValidationError(`${field.label}必须在 ${field.min} 到 ${field.max} 之间`);
  }
  if (field.integer && !Number.isInteger(normalized)) {
    throw new StrategyValidationError(`${field.label}必须是整数`);
  }
  return normalized;
}

function estimateRisk(type, config) {
  const warnings = [];
  let estimatedMaxInvestment = 0;
  let metrics = [];
  if (type === 'grid') {
    estimatedMaxInvestment = config.totalInvestment;
    const perGrid = config.totalInvestment / config.gridCount;
    const spacing = config.gridMode === 'arithmetic'
      ? (config.upperPrice - config.lowerPrice) / config.gridCount
      : ((config.upperPrice / config.lowerPrice) ** (1 / config.gridCount) - 1) * 100;
    metrics = [
      { label: '单格资金', value: round(perGrid), unit: 'USDT' },
      { label: config.gridMode === 'arithmetic' ? '单格价差' : '单格间距', value: round(spacing, 4), unit: config.gridMode === 'arithmetic' ? 'USDT' : '%' },
    ];
    if (perGrid < 10) warnings.push('单格资金较小，后续执行时可能低于交易对最小名义价值。');
  }
  if (type === 'martingale') {
    let safetyTotal = 0;
    let currentOrder = config.safetyOrderAmount;
    for (let index = 0; index < config.maxSafetyOrders; index += 1) {
      safetyTotal += currentOrder;
      currentOrder *= config.volumeMultiplier;
    }
    estimatedMaxInvestment = config.initialOrderAmount + safetyTotal;
    const maxDeviation = config.priceDeviationPercent
      * Array.from({ length: config.maxSafetyOrders }, (_, index) => config.stepMultiplier ** index)
        .reduce((sum, value) => sum + value, 0);
    metrics = [
      { label: '预计最大占用', value: round(estimatedMaxInvestment), unit: 'USDT' },
      { label: '末级累计回撤', value: round(maxDeviation), unit: '%' },
    ];
    if (config.volumeMultiplier >= 2) warnings.push('补仓倍率达到 2 倍或以上，尾部资金占用增长很快。');
    if (config.maxSafetyOrders >= 8) warnings.push('补仓层级较多，需重点评估极端单边行情。');
  }
  if (type === 'dca') {
    estimatedMaxInvestment = config.orderAmount * config.maxOrders;
    metrics = [
      { label: '计划总投入', value: round(estimatedMaxInvestment), unit: 'USDT' },
      { label: '计划周期', value: round(config.intervalHours * config.maxOrders / 24, 1), unit: '天' },
    ];
  }
  if (type === 'maCrossover') {
    estimatedMaxInvestment = config.orderAmount * config.maxPositions;
    metrics = [
      { label: '最大仓位资金', value: round(estimatedMaxInvestment), unit: 'USDT' },
      { label: '均线组合', value: `${config.fastPeriod} / ${config.slowPeriod}`, unit: '根' },
    ];
  }
  if (LONG_SHORT_STRATEGY_TYPES.includes(type)) {
    estimatedMaxInvestment = config.marginBudget;
    metrics = [
      { label: '交易组合', value: '六币组合', unit: '' },
      { label: '交易方向', value: config.positionMode === 'both' ? '多空双向' : config.positionMode === 'longOnly' ? '仅做多' : '仅做空', unit: '' },
      { label: '目标年化波动', value: config.targetVolatilityPercent, unit: '%' },
      { label: '最大总敞口', value: config.maxGrossExposurePercent, unit: '%' },
    ];
    warnings.push('当前仅提供配置与回测；接入合约执行器前必须补齐资金费率、强平距离和订单状态风控。');
    if (type === 'longShortEnhanced') {
      warnings.unshift('收益增强档的历史最大回撤为 -21.68%；收益提升来自放大风险预算，不代表信号预测能力提高。');
    }
    if (type === 'longShortHighReturn') {
      warnings.unshift('高收益档当前长期年化回测为 10.51%，但历史最大回撤为 -27.91%、最差滚动 365 日为 -21.98%；未来收益不保证超过 10%。');
    }
  }
  if (type === MONTHLY_ACCURACY_STRATEGY_TYPE) {
    estimatedMaxInvestment = config.marginBudget;
    metrics = [
      { label: '市场中性 / 趋势', value: `${config.marketNeutralWeightPercent} / ${config.trendWeightPercent}`, unit: '%' },
      { label: '相对强弱 / 调仓', value: `${config.relativeMomentumLookbackDays} / ${config.rebalanceDays}`, unit: '天' },
      { label: '中性基础 / 组合上限', value: `${config.marketNeutralBaseGrossExposurePercent} / ${config.maxGrossExposurePercent}`, unit: '%' },
      { label: '月度盈利锁定', value: config.monthlyProfitLockPercent, unit: '%' },
      { label: '市场状态参考', value: config.referenceFilterEnabled === 'enabled' ? '观察开启' : '冻结关闭', unit: '' },
      { label: '冻结验证盈利月', value: '17 / 18', unit: '' },
      { label: '冻结验证年化', value: 12.28, unit: '%' },
      { label: '冻结验证最大回撤', value: -11.71, unit: '%' },
      { label: '2023 至今盈利月', value: '38 / 42', unit: '' },
      { label: '2023 至今年化', value: 20.69, unit: '%' },
      { label: '2023 至今最大回撤', value: -22.96, unit: '%' },
    ];
    warnings.push('94.44% 是 2025-01 至 2026-06 的历史盈利月比例，不是未来月份获利概率或收益保证。');
    warnings.push('准确率优先85/15配置相对旧80/20配置将验证回撤扩大0.41个百分点、长期回撤扩大1.15个百分点。');
    if (config.adaptiveAllocationEnabled === 'enabled'
      || config.portfolioDrawdownControlEnabled === 'enabled') {
      warnings.push('全部条件低回撤观察档的开发胜出参数在冻结验证为16/18个盈利月、年化10.03%、最大回撤-10.40%，未超过准确率优先默认。');
    }
    if (config.referenceFilterEnabled === 'enabled') {
      metrics.push(
        { label: '恐惧指数范围', value: `${config.fearGreedMinimum} - ${config.fearGreedMaximum}`, unit: '' },
        { label: '波动 / 宽度失衡上限', value: `${config.maximumMarketVolatilityPercent} / ${config.maximumBreadthImbalancePercent}`, unit: '%' },
        { label: '越界后仓位权重', value: config.referenceOutsideScalePercent, unit: '%' },
      );
      warnings.push('参考过滤器在本轮冻结验证只有 14/18 个盈利月、年化 3.05%、最大回撤 -17.51%，不应据此自动实盘。');
    }
    warnings.push('验证区间已被多轮研究观察，正式使用前至少需要新的前向纸面交易期；当前仍然不会自动下单。');
    warnings.push('市场中性是名义金额中性，不等于完全没有市场、资金费率、基差、流动性或多腿成交风险。');
  }
  if (['stableComposite', 'aggressiveComposite'].includes(type)) {
    estimatedMaxInvestment = config.marginBudget;
    metrics = [
      { label: '价格 / 新闻', value: `${config.priceSignalWeight} / ${config.newsSignalWeight}`, unit: '%' },
      { label: '新闻可信门槛', value: config.minimumNewsCredibility, unit: '%' },
      { label: '目标年化波动', value: config.targetVolatilityPercent, unit: '%' },
      { label: '回撤熔断', value: config.portfolioDrawdownLimitPercent, unit: '%' },
    ];
    warnings.push('新闻评分仅作为辅助权重；新闻不可用或低于门槛时自动退化为纯价格信号。');
    if (type === 'stableComposite' && config.accuracyLeverageEnabled === 'enabled') {
      metrics.push(
        { label: '条件杠杆门槛', value: config.accuracyLeverageThresholdPercent, unit: '%' },
        { label: '达标后敞口倍率', value: config.accuracyLeverageMultiplier, unit: '×' },
      );
      warnings.push(`仅当至少 ${config.accuracyLeverageMinimumSamples} 条已结算信号同时通过准确率、近期表现、波动和回撤门槛时，才使用 ${config.accuracyLeverageMultiplier}×；否则保持 1×。`);
    }
  }
  const leverageCapacity = estimatedMaxInvestment * config.leverage;
  const conditionalExposureMultiplier = type === 'stableComposite' && config.accuracyLeverageEnabled === 'enabled'
    ? config.accuracyLeverageMultiplier
    : 1;
  const strategyExposureCap = [...LONG_SHORT_STRATEGY_TYPES, MONTHLY_ACCURACY_STRATEGY_TYPE, 'stableComposite', 'aggressiveComposite'].includes(type)
    ? estimatedMaxInvestment * config.maxGrossExposurePercent / 100 * conditionalExposureMultiplier
    : leverageCapacity;
  const estimatedMaxExposure = round(Math.min(leverageCapacity, strategyExposureCap));
  metrics = [
    { label: '杠杆倍数', value: config.leverage, unit: '×' },
    { label: '最大名义敞口', value: estimatedMaxExposure, unit: 'USDT' },
    ...metrics,
  ];
  if (config.leverage >= 10) warnings.unshift('杠杆达到 10× 或以上，价格小幅波动也可能显著放大损益与强平风险。');
  return {
    estimatedMaxInvestment: round(estimatedMaxInvestment),
    estimatedMaxExposure,
    leverage: config.leverage,
    metrics,
    warnings,
  };
}

export function validateStrategyInput(input) {
  const type = String(input?.type || '');
  const definition = STRATEGY_CATALOG[type];
  if (!definition) throw new StrategyValidationError('策略类型无效');
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 40) throw new StrategyValidationError('策略名称需为 2 到 40 个字符');
  const symbol = String(input.symbol || '').trim().toUpperCase();
  if (!SYMBOL_OPTIONS.some((item) => item.value === symbol)) throw new StrategyValidationError('当前不支持该交易对');
  const config = Object.fromEntries(
    definition.fields.map((field) => [field.key, normalizeField(field, input.config?.[field.key])]),
  );

  if (type === 'grid') {
    if (config.lowerPrice >= config.upperPrice) throw new StrategyValidationError('网格区间下限必须低于上限');
    if (config.stopLossPrice > 0 && config.stopLossPrice >= config.lowerPrice) {
      throw new StrategyValidationError('网格止损价格应低于区间下限，或填写 0');
    }
    if (config.takeProfitPrice > 0 && config.takeProfitPrice <= config.upperPrice) {
      throw new StrategyValidationError('网格止盈价格应高于区间上限，或填写 0');
    }
  }
  if (type === 'maCrossover' && config.fastPeriod >= config.slowPeriod) {
    throw new StrategyValidationError('快线周期必须小于慢线周期');
  }
  if (LONG_SHORT_STRATEGY_TYPES.includes(type)) {
    if (!(config.shortLookbackDays < config.mediumLookbackDays && config.mediumLookbackDays < config.longLookbackDays)) {
      throw new StrategyValidationError('多空趋势回看周期必须满足短周期 < 中周期 < 长周期');
    }
    if (config.maxAssetExposurePercent > config.maxGrossExposurePercent) {
      throw new StrategyValidationError('单币最大敞口不能超过组合最大总敞口');
    }
  }
  if (type === MONTHLY_ACCURACY_STRATEGY_TYPE
    && config.marketNeutralWeightPercent + config.trendWeightPercent !== 100) {
    throw new StrategyValidationError('市场中性仓位权重与动态趋势仓位权重之和必须为 100%');
  }
  if (type === MONTHLY_ACCURACY_STRATEGY_TYPE
    && config.fearGreedMinimum > config.fearGreedMaximum) {
    throw new StrategyValidationError('恐惧指数下限不能高于上限');
  }
  if (type === MONTHLY_ACCURACY_STRATEGY_TYPE
    && (config.minimumTrendWeightPercent > config.trendWeightPercent
      || config.maximumTrendWeightPercent < config.trendWeightPercent
      || config.minimumTrendWeightPercent > config.maximumTrendWeightPercent)) {
    throw new StrategyValidationError('动态趋势权重范围必须包含当前趋势仓位权重');
  }
  if (type === MONTHLY_ACCURACY_STRATEGY_TYPE
    && config.drawdownControlStartPercent >= config.drawdownControlFullPercent) {
    throw new StrategyValidationError('组合减仓起始回撤必须小于完全减仓回撤');
  }
  if (['stableComposite', 'aggressiveComposite'].includes(type)) {
    if (config.priceSignalWeight + config.newsSignalWeight !== 100) {
      throw new StrategyValidationError('价格信号权重与新闻信号权重之和必须为 100%');
    }
    if (config.maxAssetExposurePercent > config.maxGrossExposurePercent) {
      throw new StrategyValidationError('单币最大敞口不能超过组合最大总敞口');
    }
    if (type === 'stableComposite'
      && config.accuracyLeverageRecentThresholdPercent > config.accuracyLeverageThresholdPercent) {
      throw new StrategyValidationError('最近 20 条准确率门槛不能高于长期准确率门槛');
    }
  }
  const riskSummary = estimateRisk(type, config);
  if ('maxInvestment' in config && riskSummary.estimatedMaxInvestment > config.maxInvestment + 0.000001) {
    throw new StrategyValidationError(`预计最大资金占用 ${riskSummary.estimatedMaxInvestment} USDT，已超过资金上限`);
  }
  return {
    type,
    name,
    symbol,
    enabled: Boolean(input.enabled),
    config,
    riskSummary,
  };
}

export class StrategyStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeQueue = Promise.resolve();
  }

  async list() {
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return Array.isArray(payload) ? payload : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async get(id) {
    return (await this.list()).find((item) => item.id === id) || null;
  }

  async create(input) {
    return this.#mutate((items) => {
      const normalized = validateStrategyInput(input);
      const now = new Date().toISOString();
      const strategy = { id: crypto.randomUUID(), ...normalized, enabled: false, createdAt: now, updatedAt: now };
      items.unshift(strategy);
      return strategy;
    });
  }

  async update(id, input) {
    return this.#mutate((items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw Object.assign(new Error('策略不存在'), { status: 404 });
      const normalized = validateStrategyInput({ ...items[index], ...input, enabled: items[index].enabled });
      items[index] = { ...items[index], ...normalized, updatedAt: new Date().toISOString() };
      return items[index];
    });
  }

  async setEnabled(id, enabled) {
    return this.#mutate((items) => {
      const strategy = items.find((item) => item.id === id);
      if (!strategy) throw Object.assign(new Error('策略不存在'), { status: 404 });
      strategy.enabled = Boolean(enabled);
      strategy.updatedAt = new Date().toISOString();
      return strategy;
    });
  }

  async clone(id) {
    const source = await this.get(id);
    if (!source) throw Object.assign(new Error('策略不存在'), { status: 404 });
    return this.create({ ...source, name: `${source.name} 副本`, enabled: false });
  }

  async delete(id) {
    return this.#mutate((items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw Object.assign(new Error('策略不存在'), { status: 404 });
      const [removed] = items.splice(index, 1);
      return removed;
    });
  }

  async #mutate(mutator) {
    const operation = this.writeQueue.then(async () => {
      const items = await this.list();
      const result = mutator(items);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPath, this.filePath);
      return result;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}
