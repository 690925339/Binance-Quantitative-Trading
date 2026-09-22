import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIVERSIFIED_CAPPED_PROFILE, DIVERSIFIED_DRAWDOWN_PROFILE,
  DIVERSIFIED_SPREAD_RISK_PROFILE, DIVERSIFIED_SPREAD_CONTROL_PROFILE,
} from '../src/paper-optimization-profiles.js';
import { initializePaperState, advancePaperState, PAPER_SYMBOLS, addUtcDays } from '../src/monthly-accuracy-paper.js';
import { PAPER_SHADOW_PROFILES } from '../src/paper-strategy-review.js';

test('分散限仓候选由独立影子盘初始化，并在正式引擎中限制横截面敞口', () => {
  const seriesBySymbol = Object.fromEntries(PAPER_SYMBOLS.map((symbol, i) => [symbol,
    Array.from({ length: 251 }, (_, day) => ({
      date: addUtcDays('2025-01-01', day),
      close: 100 * Math.exp((i - 2.5) * day * 0.001 + Math.sin(day) * 0.001),
    })),
  ]));
  const state = initializePaperState({
    seriesBySymbol,
    cycleDate: addUtcDays('2025-01-01', 250),
    markPrices: Object.fromEntries(PAPER_SYMBOLS.map(s => [s, seriesBySymbol[s].at(-1).close])),
    profile: DIVERSIFIED_CAPPED_PROFILE,
  });
  assert.equal(state.strategyProfileId, DIVERSIFIED_CAPPED_PROFILE.id);
  assert.equal(state.reports.length, 1);
  const legs = state.positions.map(p => p.marketNeutralWeight).filter(w => Math.abs(w) > 1e-12);
  assert.equal(legs.filter(w => w > 0).length, 2);
  assert.equal(legs.filter(w => w < 0).length, 2);
  assert.ok(legs.reduce((s, w) => s + Math.abs(w), 0) <= 0.85000001);
  assert.ok(legs.every(w => Math.abs(w) <= 0.21250001));
  assert.equal(PAPER_SHADOW_PROFILES.filter(p => p.id === state.strategyProfileId).length, 1);
});

function volatileSeries() {
  return Object.fromEntries(PAPER_SYMBOLS.map((symbol, index) => {
    let close = 100;
    return [symbol, Array.from({ length: 251 }, (_, day) => {
      close *= Math.exp((2.5 - index) * (0.002 + (day % 2 ? -0.06 : 0.06)));
      return { date: addUtcDays('2025-01-01', day), close };
    })];
  }));
}

test('价差候选在正式引擎提前减仓且未来价格不改变当前决策', () => {
  const series = volatileSeries();
  const cycleDate = addUtcDays('2025-01-01', 250);
  const args = { seriesBySymbol: series, cycleDate,
    markPrices: Object.fromEntries(PAPER_SYMBOLS.map(s => [s, series[s].at(-1).close])) };
  const guarded = initializePaperState({ ...args, profile: DIVERSIFIED_SPREAD_RISK_PROFILE });
  const control = initializePaperState({ ...args, profile: DIVERSIFIED_SPREAD_CONTROL_PROFILE });
  assert.ok(guarded.components.marketNeutral.lastAdaptiveRisk.spreadRiskScale < 1);
  const gross = s => Object.values(s.components.marketNeutral.weights).reduce((sum, w) => sum + Math.abs(w), 0);
  assert.ok(gross(guarded) < gross(control));
  for (const symbol of PAPER_SYMBOLS) series[symbol].push({ date: addUtcDays(cycleDate, 1), close: 999999 });
  const withFuture = initializePaperState({ ...args, profile: DIVERSIFIED_SPREAD_RISK_PROFILE });
  assert.deepEqual(withFuture.positions, guarded.positions);
  assert.equal(PAPER_SHADOW_PROFILES.some(p => p.id === DIVERSIFIED_DRAWDOWN_PROFILE.id), false);
  assert.equal(PAPER_SHADOW_PROFILES.filter(p => p.id === guarded.strategyProfileId).length, 1);
});

test('回撤研究先按旧持仓结算亏损，再对下一周期减仓', () => {
  const series = volatileSeries();
  const cycleDate = addUtcDays('2025-01-01', 249);
  const args = { seriesBySymbol: series, cycleDate,
    markPrices: Object.fromEntries(PAPER_SYMBOLS.map(s => [s, series[s][249].close])) };
  const guarded = initializePaperState({ ...args, profile: DIVERSIFIED_DRAWDOWN_PROFILE });
  const control = initializePaperState({ ...args, profile: DIVERSIFIED_CAPPED_PROFILE });
  const nextDate = addUtcDays(cycleDate, 1);
  const prices = Object.fromEntries(PAPER_SYMBOLS.map(s => [s,
    args.markPrices[s] * (1 - Math.sign(guarded.components.marketNeutral.weights[s]) * 0.1),
  ]));
  for (const [state, profile] of [[guarded, DIVERSIFIED_DRAWDOWN_PROFILE], [control, DIVERSIFIED_CAPPED_PROFILE]]) {
    advancePaperState({ state, profile, seriesBySymbol: series, throughCycleDate: nextDate,
      markPricesByCycleDate: { [nextDate]: prices } });
  }
  assert.equal(guarded.latestReport.pricePnl, control.latestReport.pricePnl);
  assert.ok(guarded.latestReport.pricePnl < 0);
  assert.equal(guarded.latestReport.settledDrawdownRisk.scale, 1);
  assert.equal(guarded.latestReport.nextDrawdownRisk.scale, 0.25);
  assert.equal(guarded.latestReport.nextDrawdownRisk.cycleDate, nextDate);
});
