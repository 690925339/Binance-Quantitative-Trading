// Frozen research-only protocol. These functions never read or update a paper ledger.
// Changing this list after observing experiment results creates a new experiment.
const EPSILON = 1e-12;
const KINDS = new Set(['buy_hold', 'trend', 'reversion', 'hybrid']);

function commonProfile(behavior) {
  return {
    protocolId: 'btc-bidirectional-behavior-v1-2026-10-04',
    researchOnly: true,
    maxGrossExposure: 1,
    positionCap: 0.5,
    tradingCostRate: 0.0007,
    dailyCarryCostRate: 0.00005,
    targetAnnualizedVolatility: 0.1,
    volatilityLookback: 30,
    annualizationDays: 365,
    warmupIntervals: 180,
    behavior,
  };
}

export function btcBehaviorCandidates() {
  const trend = { kind: 'trend', trendLookbacks: [20, 60, 120] };
  const hybrid = {
    kind: 'hybrid', trendLookbacks: [20, 60, 120],
    efficiencyLookback: 60, efficiencyThreshold: 0.25,
    rsiLookback: 14, rsiEntryLow: 40, rsiEntryHigh: 60,
    hysteresis: false, minimumHoldingDays: 0, maximumHoldingDays: null,
  };
  const candidates = [
    ['L0', 'Constant 30% long daily-rebalanced reference', { kind: 'buy_hold', constantWeight: 0.3 }],
    ['T0', '20/60/120-day majority trend', trend],
    ['T1', '5/20/60-day majority trend', { kind: 'trend', trendLookbacks: [5, 20, 60] }],
    ['R0', '20-day log-price z-score reversal', { kind: 'reversion', zscoreLookback: 20, zscoreThreshold: 1 }],
    ['H0', 'Efficiency regime with trend/RSI reversal', hybrid],
    ['H1', 'Regime strategy with RSI entry/exit hysteresis', { ...hybrid, rsiEntryLow: 35, rsiEntryHigh: 65, hysteresis: true }],
    ['H2', 'Regime strategy with three-day time exit', { ...hybrid, minimumHoldingDays: 1, maximumHoldingDays: 3 }],
  ];
  // Each call and each profile owns its nested arrays and configuration.
  return candidates.map(([id, name, behavior]) => ({ id, name, profile: structuredClone(commonProfile(behavior)) }));
}

function finite(value, name, low = -Infinity, high = Infinity) {
  if (!Number.isFinite(value) || value < low || value > high) throw new Error(`Invalid ${name}`);
}

function integer(value, name, low, high = Infinity) {
  finite(value, name, low, high);
  if (!Number.isInteger(value)) throw new Error(`Invalid ${name}`);
}

function positive(value, name, high = Infinity) {
  finite(value, name, Number.MIN_VALUE, high);
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || !KINDS.has(profile.behavior?.kind)) throw new Error('Invalid behavior profile');
  finite(profile.maxGrossExposure, 'maxGrossExposure', Number.MIN_VALUE, 1);
  positive(profile.positionCap, 'positionCap', profile.maxGrossExposure);
  finite(profile.tradingCostRate, 'tradingCostRate', 0, 0.1);
  finite(profile.dailyCarryCostRate, 'dailyCarryCostRate', 0, 0.1);
  positive(profile.targetAnnualizedVolatility, 'targetAnnualizedVolatility', 1);
  integer(profile.volatilityLookback, 'volatilityLookback', 2);
  integer(profile.annualizationDays, 'annualizationDays', 1);
  integer(profile.warmupIntervals, 'warmupIntervals', 180);
  if (profile.volatilityLookback > profile.warmupIntervals) throw new Error('Volatility lookback exceeds warmup');
  const b = profile.behavior;
  if (b.kind === 'buy_hold') finite(b.constantWeight, 'constantWeight', -profile.positionCap, profile.positionCap);
  if (b.kind === 'trend' || b.kind === 'hybrid') {
    if (!Array.isArray(b.trendLookbacks) || b.trendLookbacks.length !== 3) throw new Error('Invalid trendLookbacks');
    b.trendLookbacks.forEach(value => integer(value, 'trend lookback', 1, profile.warmupIntervals));
    if (new Set(b.trendLookbacks).size !== 3) throw new Error('Duplicate trend lookback');
  }
  if (b.kind === 'reversion') {
    integer(b.zscoreLookback, 'zscoreLookback', 2, profile.warmupIntervals);
    positive(b.zscoreThreshold, 'zscoreThreshold');
  }
  if (b.kind === 'hybrid') {
    integer(b.efficiencyLookback, 'efficiencyLookback', 2, profile.warmupIntervals);
    finite(b.efficiencyThreshold, 'efficiencyThreshold', 0, 1);
    integer(b.rsiLookback, 'rsiLookback', 2, profile.warmupIntervals);
    positive(b.rsiEntryLow, 'rsiEntryLow', 50);
    finite(b.rsiEntryHigh, 'rsiEntryHigh', 50, 100);
    if (b.rsiEntryLow >= 50 || b.rsiEntryHigh <= 50 || Math.abs(b.rsiEntryLow + b.rsiEntryHigh - 100) > EPSILON) {
      throw new Error('RSI thresholds must be symmetric about 50');
    }
    if (typeof b.hysteresis !== 'boolean') throw new Error('Invalid hysteresis');
    integer(b.minimumHoldingDays, 'minimumHoldingDays', 0);
    if (b.maximumHoldingDays !== null) {
      integer(b.maximumHoldingDays, 'maximumHoldingDays', 1);
      if (b.minimumHoldingDays >= b.maximumHoldingDays) throw new Error('Invalid holding-day limits');
    }
  }
}

function sign(value) {
  return Math.abs(value) <= EPSILON ? 0 : Math.sign(value);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, sample = false) {
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - (sample ? 1 : 0));
  return Math.sqrt(variance);
}

function trendDirection(logs, index, lookbacks) {
  const returns = lookbacks.map(days => logs[index] - logs[index - days]);
  const positiveVotes = returns.filter(value => sign(value) > 0).length;
  const negativeVotes = returns.filter(value => sign(value) < 0).length;
  return { direction: positiveVotes >= 2 ? 1 : negativeVotes >= 2 ? -1 : 0, returns, positiveVotes, negativeVotes };
}

function rsiValue(logReturns, lookback) {
  const recent = logReturns.slice(-lookback);
  const gains = recent.reduce((sum, value) => sum + Math.max(0, value), 0);
  const losses = recent.reduce((sum, value) => sum + Math.max(0, -value), 0);
  return gains + losses <= EPSILON ? 50 : 100 * gains / (gains + losses);
}

/**
 * A pure close-only signal. `index` is the latest available UTC close, not the
 * execution price. The caller must execute later and account for mark drift,
 * turnover, short carry/funding and fees. No cost is subtracted here.
 * `daysInPosition` counts completed holding intervals. A time exit emits zero
 * for this decision; a flat position is eligible to enter on the next call.
 */
export function createBtcBehaviorSignal(inputProfile) {
  validateProfile(inputProfile);
  const profile = structuredClone(inputProfile);
  const behavior = profile.behavior;
  return function btcBehaviorSignal({
    closes, index, cycleDate, previousWeight = 0, daysInPosition = 0,
    lastDirection = Math.sign(previousWeight), previousTargetWeight = previousWeight,
  } = {}) {
    if (!Array.isArray(closes) || !closes.length) throw new Error('Invalid closes');
    integer(index, 'index', 0, closes.length - 1);
    finite(previousWeight, 'previousWeight');
    finite(previousTargetWeight, 'previousTargetWeight');
    integer(daysInPosition, 'daysInPosition', 0);
    integer(lastDirection, 'lastDirection', -1, 1);
    if (cycleDate !== undefined && (typeof cycleDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cycleDate)
      || !Number.isFinite(Date.parse(`${cycleDate}T00:00:00.000Z`))
      || new Date(`${cycleDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== cycleDate)) throw new Error('Invalid cycleDate');
    // Never inspect values after `index`, including validation of future data.
    const knownCloses = closes.slice(0, index + 1);
    knownCloses.forEach(value => positive(value, 'close'));
    const diagnostics = {
      kind: behavior.kind, index, cycleDate: cycleDate ?? null,
      knownCloseCount: knownCloses.length, warmupIntervals: profile.warmupIntervals,
      previousWeight, previousTargetWeight, daysInPosition, lastDirection,
      direction: 0, annualizedVolatility: null, regime: null,
      reason: 'warmup', timeExit: false, minimumHoldingApplied: false,
    };
    if (index < profile.warmupIntervals) return { targetWeight: 0, diagnostics };
    if (behavior.kind === 'buy_hold') {
      return { targetWeight: behavior.constantWeight, diagnostics: { ...diagnostics,
        reason: 'constant_weight_long_benchmark', direction: Math.sign(behavior.constantWeight), regime: 'benchmark' } };
    }
    const logs = knownCloses.map(Math.log);
    const logReturns = logs.slice(1).map((value, i) => value - logs[i]);
    const recentReturns = logReturns.slice(-profile.volatilityLookback);
    const annualizedVolatility = standardDeviation(recentReturns, true) * Math.sqrt(profile.annualizationDays);
    diagnostics.annualizedVolatility = annualizedVolatility;
    const isFlat = recentReturns.every(value => Math.abs(value) <= EPSILON);
    if (isFlat) return { targetWeight: 0, diagnostics: { ...diagnostics, reason: 'flat_market', regime: 'flat' } };
    let direction = 0;
    if (behavior.kind === 'trend') {
      const trend = trendDirection(logs, index, behavior.trendLookbacks);
      direction = trend.direction;
      diagnostics.trend = trend;
      diagnostics.regime = 'trend';
      diagnostics.reason = direction ? 'majority_trend' : 'no_trend_majority';
    } else if (behavior.kind === 'reversion') {
      const recent = logs.slice(-behavior.zscoreLookback);
      const std = standardDeviation(recent);
      const zscore = std <= EPSILON ? 0 : (logs[index] - average(recent)) / std;
      direction = zscore < -behavior.zscoreThreshold ? 1 : zscore > behavior.zscoreThreshold ? -1 : 0;
      diagnostics.zscore = zscore;
      diagnostics.regime = 'reversion';
      diagnostics.reason = direction ? 'zscore_reversion' : 'zscore_neutral';
    } else {
      const recentPath = logReturns.slice(-behavior.efficiencyLookback);
      const pathLength = recentPath.reduce((sum, value) => sum + Math.abs(value), 0);
      const displacement = Math.abs(logs[index] - logs[index - behavior.efficiencyLookback]);
      const efficiency = pathLength <= EPSILON ? 0 : Math.min(1, displacement / pathLength);
      const rsi = rsiValue(logReturns, behavior.rsiLookback);
      diagnostics.efficiency = efficiency;
      diagnostics.rsi = rsi;
      if (efficiency > behavior.efficiencyThreshold) {
        const trend = trendDirection(logs, index, behavior.trendLookbacks);
        direction = trend.direction;
        diagnostics.trend = trend;
        diagnostics.regime = 'trend';
        diagnostics.reason = direction ? 'regime_majority_trend' : 'no_trend_majority';
      } else {
        diagnostics.regime = 'range';
        direction = rsi < behavior.rsiEntryLow ? 1 : rsi > behavior.rsiEntryHigh ? -1 : 0;
        diagnostics.reason = direction ? 'range_rsi_entry' : 'range_rsi_neutral';
        if (!direction && behavior.hysteresis && ((previousWeight > 0 && rsi < 50) || (previousWeight < 0 && rsi > 50))) {
          direction = Math.sign(previousWeight);
          diagnostics.reason = 'range_rsi_hysteresis_hold';
        }
      }
      if (previousWeight !== 0 && behavior.maximumHoldingDays !== null && daysInPosition >= behavior.maximumHoldingDays) {
        direction = 0;
        diagnostics.timeExit = true;
        diagnostics.reason = 'maximum_holding_exit';
      } else if (previousWeight !== 0 && daysInPosition < behavior.minimumHoldingDays && direction !== Math.sign(previousWeight)) {
        direction = Math.sign(previousWeight);
        diagnostics.minimumHoldingApplied = true;
        diagnostics.reason = 'minimum_holding_period';
      }
    }
    const size = annualizedVolatility <= EPSILON ? profile.positionCap
      : Math.min(profile.positionCap, profile.targetAnnualizedVolatility / annualizedVolatility);
    diagnostics.direction = direction;
    diagnostics.positionSize = size;
    return { targetWeight: direction === 0 ? 0 : direction * size, diagnostics };
  };
}
