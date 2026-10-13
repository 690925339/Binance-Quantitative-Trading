import test from 'node:test';
import assert from 'node:assert/strict';
import { btcDailyCandidates, btcCostProfile } from '../src/btc-daily-candidates.js';
import { BTC_SINGLE_ASSET_PAPER_PROFILE, BTC_NEWS_DATA_GUARD_PROFILE } from '../src/btc-paper.js';

test('60%研究固定为8个单变量BTC方案，不污染正式配置或引入历史新闻', () => {
  const candidates = btcDailyCandidates();
  assert.deepEqual(candidates.map(c => c.id), ['B0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
  for (const c of candidates) {
    assert.equal(c.profile.symbol, 'BTCUSDT');
    assert.equal(c.profile.newsDataQualityGuardEnabled, false);
    assert.equal(c.profile.trend.maxGrossExposure, 1);
    assert.equal(c.profile.trend.maxAssetExposure, 1);
    assert.equal(c.profile.tradingCostRate, 0.0007);
    assert.equal(c.profile.dailyCarryCostRate, 0.00005);
  }
  assert.deepEqual(candidates[0].profile.trend, BTC_SINGLE_ASSET_PAPER_PROFILE.trend);
  assert.deepEqual(candidates[1].profile.trend.lookbackDays, [20, 60, 120]);
  assert.deepEqual(candidates[2].profile.trend.lookbackDays, [10, 30, 90]);
  assert.equal(candidates[3].profile.trend.minimumTrendVotes, 3);
  assert.equal(candidates[4].profile.trend.shortConfirmationLookbackDays, 10);
  assert.equal(candidates[4].profile.trend.shortConfirmationMinimumReturn, 0.01);
  assert.equal(candidates[5].profile.entryGuardAdverseMove, 0.03);
  assert.equal(candidates[6].profile.maximumWeightIncrease, 0.1);
  assert.equal(candidates[7].profile.monthlyLossContinuationScale, 0.1);
  candidates[0].profile.trend.lookbackDays[0] = 1;
  assert.equal(btcDailyCandidates()[0].profile.trend.lookbackDays[0], 45);
  assert.equal(BTC_NEWS_DATA_GUARD_PROFILE.newsDataQualityGuardEnabled, true);
  assert.equal(BTC_SINGLE_ASSET_PAPER_PROFILE.maximumWeightIncrease, undefined);
});

test('BTC压力成本更新实际结算字段，复制配置而非改写原对象', () => {
  const original = btcDailyCandidates()[0].profile;
  const doubled = btcCostProfile(original, 2);
  assert.equal(doubled.tradingCostRate, 0.0014);
  assert.equal(doubled.dailyCarryCostRate, 0.0001);
  assert.equal(doubled.trend.tradingCostRate, 0.0014);
  assert.equal(original.tradingCostRate, 0.0007);
  assert.equal(original.dailyCarryCostRate, 0.00005);
  for (const multiplier of [0, -1, NaN, Infinity, '2']) {
    assert.throws(() => btcCostProfile(original, multiplier), /成本倍数/);
  }
});
