import { evaluateDailyCandidate } from './btc-daily-target.js';

function metricNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function coverageConsistent(metrics) {
  if (!metrics || metrics.dataComplete !== true) return false;
  if (Object.hasOwn(metrics, 'missingDays') && metrics.missingDays !== 0) return false;
  if (Object.hasOwn(metrics, 'missingDates')
    && (!Array.isArray(metrics.missingDates) || metrics.missingDates.length !== 0)) return false;
  // Older callers may omit both counts. Once either is supplied, the complete
  // calendar denominator must be positive and agree with observed settlements.
  if (Object.hasOwn(metrics, 'observations') || Object.hasOwn(metrics, 'expectedDays')) {
    if (!Number.isInteger(metrics.expectedDays) || metrics.expectedDays < 1
      || !Number.isInteger(metrics.observations) || metrics.observations !== metrics.expectedDays) return false;
  }
  return true;
}

/**
 * Rank only the predeclared development period. A diagnostic leader is not a
 * recommendation; the unchanged baseline may lead and no nominee is valid.
 * Validation/recent metrics are intentionally never read by this selector.
 */
export function selectBtcResearchCandidate(results, { baselineId = 'B0', developmentKey = 'development' } = {}) {
  if (!Array.isArray(results)) throw new Error('Research results must be an array');
  if (typeof baselineId !== 'string' || !baselineId.trim()
    || typeof developmentKey !== 'string' || !developmentKey.trim()) {
    throw new Error('Baseline and development identifiers must be non-empty strings');
  }
  const pairs = new Map();
  for (const result of results) {
    if (!result || typeof result.id !== 'string' || !result.id.trim()
      || ![1, 2].includes(result.costMultiplier)) {
      throw new Error('Every research result needs an id and costMultiplier of 1 or 2');
    }
    if (!pairs.has(result.id)) pairs.set(result.id, new Map());
    const pair = pairs.get(result.id);
    if (pair.has(result.costMultiplier)) throw new Error(`Duplicate research result: ${result.id} at ${result.costMultiplier}x cost`);
    pair.set(result.costMultiplier, result);
  }
  if (!pairs.has(baselineId)) throw new Error(`Missing baseline: ${baselineId}`);
  for (const [id, pair] of pairs) {
    if (!pair.has(1) || !pair.has(2)) throw new Error(`Incomplete standard/double-cost pair: ${id}`);
  }

  const periodMetrics = (id, costMultiplier) => pairs.get(id).get(costMultiplier).metrics?.[developmentKey];
  const baseline = periodMetrics(baselineId, 1);
  const pressureBaseline = periodMetrics(baselineId, 2);
  const developmentGates = Object.create(null);
  const ranking = [...pairs.keys()].map(id => {
    const metrics = periodMetrics(id, 1);
    const pressure = periodMetrics(id, 2);
    const gate = evaluateDailyCandidate(metrics, baseline, pressure, pressureBaseline);
    // evaluateDailyCandidate permits a fallback for other callers. Selection
    // never permits a missing pressure baseline to become a standard-cost one.
    if (!pressureBaseline) {
      gate.checks.validMetrics = false;
      gate.checks.completeData = false;
      gate.passed = false;
      gate.annualized10Met = false;
      gate.eligibleForForward = false;
      gate.failedChecks = Object.keys(gate.checks).filter(key => !gate.checks[key]);
      gate.doubleCostComparison = 'missing_double_cost_baseline';
    }
    gate.checks.coverageConsistency = [metrics, baseline, pressure, pressureBaseline].every(coverageConsistent);
    gate.checks.completeData = gate.checks.completeData && gate.checks.coverageConsistency;
    gate.passed = Object.values(gate.checks).every(Boolean);
    gate.eligibleForForward = gate.passed && gate.annualized10Met;
    gate.failedChecks = Object.keys(gate.checks).filter(key => !gate.checks[key]);
    developmentGates[id] = gate;
    return {
      id, isBaseline: id === baselineId,
      dataValid: gate.checks.validMetrics && gate.checks.completeData,
      profitableDayRatio: metricNumber(metrics?.profitableDayRatio),
      totalReturn: metricNumber(metrics?.totalReturn),
      annualizedReturn: metricNumber(metrics?.annualizedReturn),
      doubleCostProfitableDayRatio: metricNumber(pressure?.profitableDayRatio),
      doubleCostTotalReturn: metricNumber(pressure?.totalReturn),
      doubleCostAnnualizedReturn: metricNumber(pressure?.annualizedReturn),
      eligibleForForward: id !== baselineId && gate.eligibleForForward === true,
    };
  }).sort((left, right) => Number(right.dataValid) - Number(left.dataValid)
    || (right.profitableDayRatio ?? -Infinity) - (left.profitableDayRatio ?? -Infinity)
    || (right.totalReturn ?? -Infinity) - (left.totalReturn ?? -Infinity)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  ranking.forEach((entry, index) => { entry.rank = index + 1; });
  const leader = ranking.find(entry => entry.dataValid);
  const nominee = ranking.find(entry => entry.eligibleForForward);
  return {
    baselineId, developmentKey, selectionUsesValidation: false, automaticPromotion: false,
    reason: nominee ? 'candidate_passed_development' : 'no_candidate_passed_development',
    bestDiagnosticCandidate: leader ? { ...leader, diagnosticOnly: true, recommendation: false } : null,
    nominatedCandidate: nominee ? { ...nominee, requiresRetrospectiveValidation: true,
      requiresForwardReview: true, automaticPromotion: false } : null,
    ranking, developmentGates,
  };
}
