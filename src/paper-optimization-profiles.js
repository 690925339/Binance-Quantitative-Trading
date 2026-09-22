import { BTC_SINGLE_ASSET_PAPER_PROFILE } from './btc-paper.js';
import { MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE } from './monthly-accuracy-paper.js';

// Predeclared candidates: keep IDs immutable after forward tracking starts.
export const BTC_GRADUAL_RISK_PROFILE = Object.freeze({
  ...BTC_SINGLE_ASSET_PAPER_PROFILE,
  id: 'btc-gradual-risk-shadow-v1',
  name: 'BTC渐进减仓影子盘',
  monthlyProfitDeRiskMode: 'linear',
  monthlyProfitDeRiskThreshold: 0.01,
  monthlyProfitDeRiskFullAt: 0.03,
  monthlyProfitDeRiskScale: 0.5,
});

export const DIVERSIFIED_CAPPED_PROFILE = Object.freeze({
  ...MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE,
  id: 'shadow-continuous-diversified-capped-v1',
  baselineProfileId: MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.id,
  name: '分散限仓影子｜每侧2币＋横截面总敞口100%',
  role: 'risk_adjusted',
  hypothesis: '分散价差并限制横截面总敞口，检验净收益和尾部风险。',
  marketNeutral: Object.freeze({
    ...MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE.marketNeutral,
    positionsPerSide: 2,
    maxGrossExposure: 1,
  }),
});

export const DIVERSIFIED_DRAWDOWN_PROFILE = Object.freeze({
  ...DIVERSIFIED_CAPPED_PROFILE,
  id: 'shadow-diversified-drawdown-v1',
  name: '分散回撤减仓影子｜20日回撤动态限仓',
  hypothesis: '在分散限仓基础上，20日回撤从2%到5%时逐渐降至25%敞口，检验尾部损失和恢复能力。',
  marketNeutral: Object.freeze({
    ...DIVERSIFIED_CAPPED_PROFILE.marketNeutral,
    rollingDrawdownRiskEnabled: true,
    rollingDrawdownWindowDays: 20,
    rollingDrawdownStart: 0.02,
    rollingDrawdownFull: 0.05,
    rollingDrawdownMinimumScale: 0.25,
  }),
});

export const DIVERSIFIED_SPREAD_RISK_PROFILE = Object.freeze({
  ...DIVERSIFIED_CAPPED_PROFILE,
  id: 'shadow-diversified-spread-risk-v1',
  name: '分散价差风控影子｜20日价差波动限仓',
  comparisonControlId: 'shadow-diversified-spread-control-v1',
  hypothesis: '按调仓时已知的20日多空价差波动率缩减敞口，检验是否能在亏损发生前限制高波动价差风险。',
  marketNeutral: Object.freeze({
    ...DIVERSIFIED_CAPPED_PROFILE.marketNeutral,
    spreadRiskEnabled: true,
    spreadVolatilityWindowDays: 20,
    spreadVolatilityTarget: 0.35,
    minimumSpreadRiskScale: 0.25,
  }),
});

export const DIVERSIFIED_SPREAD_CONTROL_PROFILE = Object.freeze({
  ...DIVERSIFIED_CAPPED_PROFILE,
  id: 'shadow-diversified-spread-control-v1',
  name: '价差风控同期对照｜原分散限仓规则',
  role: 'control',
  hypothesis: '与价差风控候选同日初始化，保持原分散限仓参数，用于配对比较。',
});
