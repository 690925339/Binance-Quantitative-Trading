import { BTC_SINGLE_ASSET_PAPER_PROFILE } from './btc-paper.js';

// Fixed before evaluating this experiment; do not extend this list to chase a result.
export function btcDailyCandidates() {
  const candidate = (id, name, override = {}, trendOverride = {}) => ({
    id, name, profile: { ...structuredClone(BTC_SINGLE_ASSET_PAPER_PROFILE),
      ...override, id: `btc-daily60-research-${id}`, name,
      newsDataQualityGuardEnabled: false,
      trend: { ...structuredClone(BTC_SINGLE_ASSET_PAPER_PROFILE.trend), ...trendOverride } },
  });
  return [
    candidate('B0', '原参数价格基准'),
    candidate('C1', '中期20/60/120日', {}, { lookbackDays: [20, 60, 120] }),
    candidate('C2', '快速10/30/90日', {}, { lookbackDays: [10, 30, 90] }),
    candidate('C3', '三个周期一致', {}, { minimumTrendVotes: 3 }),
    candidate('C4', '做空前10日下跌1%确认', {}, { shortConfirmationLookbackDays: 10, shortConfirmationMinimumReturn: 0.01 }),
    candidate('C5', '3日逆向3%不增仓', { entryGuardLookbackDays: 3, entryGuardAdverseMove: 0.03 }),
    candidate('C6', '每日新增敞口最多10个百分点', { maximumWeightIncrease: 0.1 }),
    candidate('C7', '月损后保留原目标10%且绝对敞口不超过10%', { monthlyLossContinuationScale: 0.1 }),
  ];
}

export function btcCostProfile(profile, multiplier) {
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error('无效BTC成本倍数');
  const next = structuredClone(profile);
  next.tradingCostRate *= multiplier;
  next.dailyCarryCostRate *= multiplier;
  // These fields document the same cost assumptions; BTC settlement uses top-level rates.
  next.trend.tradingCostRate *= multiplier;
  next.trend.dailyCarryCostRate *= multiplier;
  return next;
}
