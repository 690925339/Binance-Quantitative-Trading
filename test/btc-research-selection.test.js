import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBtcResearchCandidate } from '../src/btc-research-selection.js';

const metric = overrides => ({ dataComplete: true, profitableDayRatio: 0.6, totalReturn: 0.2,
  maxDrawdown: -0.08, worstDayReturn: -0.02, expectedShortfall95: 0.01,
  annualizedReturn: 0.12, ...overrides });

function pair(id, standard = {}, pressure = {}, extraMetrics = {}) {
  return [1, 2].map(costMultiplier => ({ id, costMultiplier,
    metrics: { development: metric(costMultiplier === 1 ? standard : pressure), ...extraMetrics } }));
}

function baseline() {
  return pair('B0', { profitableDayRatio: 0.5, totalReturn: 0.1 },
    { profitableDayRatio: 0.48, totalReturn: 0.05 });
}

test('development-only selection permits a qualified nominee but never automatic promotion', () => {
  const results = [...baseline(), ...pair('C1')];
  const unchanged = JSON.stringify(results);
  const selection = selectBtcResearchCandidate(results);
  assert.equal(selection.bestDiagnosticCandidate.id, 'C1');
  assert.equal(selection.bestDiagnosticCandidate.recommendation, false);
  assert.equal(selection.nominatedCandidate.id, 'C1');
  assert.equal(selection.nominatedCandidate.requiresRetrospectiveValidation, true);
  assert.equal(selection.nominatedCandidate.requiresForwardReview, true);
  assert.equal(selection.automaticPromotion, false);
  assert.equal(selection.selectionUsesValidation, false);
  assert.equal(selection.reason, 'candidate_passed_development');
  assert.equal(selection.developmentGates.C1.eligibleForForward, true);
  assert.equal(selection.developmentGates.C1.doubleCostComparison, 'same_cost_baseline');
  assert.equal(JSON.stringify(results), unchanged);
});

test('baseline stays in ranking and may be diagnostic leader without forcing a winner', () => {
  const selection = selectBtcResearchCandidate([
    ...baseline(), ...pair('C1', { profitableDayRatio: 0.49 }, { profitableDayRatio: 0.45 }),
  ]);
  assert.equal(selection.bestDiagnosticCandidate.id, 'B0');
  assert.equal(selection.ranking[0].isBaseline, true);
  assert.equal(selection.nominatedCandidate, null);
  assert.equal(selection.reason, 'no_candidate_passed_development');
  assert.equal(selection.developmentGates.B0.checks.improvement, false);
});

test('a higher diagnostic ratio is not a nominee when the 60 percent goal is unmet', () => {
  const selection = selectBtcResearchCandidate([
    ...baseline(), ...pair('C1', { profitableDayRatio: 0.59 }, { profitableDayRatio: 0.59 }),
  ]);
  assert.equal(selection.bestDiagnosticCandidate.id, 'C1');
  assert.equal(selection.bestDiagnosticCandidate.diagnosticOnly, true);
  assert.equal(selection.nominatedCandidate, null);
  assert.ok(selection.developmentGates.C1.failedChecks.includes('profitableDays60'));
});

test('selection ignores every validation and recent value, including unavailable future metrics', () => {
  const results = [...baseline(), ...pair('C1'), ...pair('C2', { profitableDayRatio: 0.61 }, { profitableDayRatio: 0.61 })];
  const first = selectBtcResearchCandidate(results);
  const changed = results.map(result => ({ ...result, metrics: { ...result.metrics,
    validation: metric({ profitableDayRatio: result.id === 'C1' ? 1 : 0, totalReturn: -0.99 }),
    retrospectiveValidation: metric({ profitableDayRatio: result.id === 'C1' ? 0 : 1, totalReturn: 999 }),
    recent: metric({ profitableDayRatio: 0, totalReturn: -0.99 }),
  } }));
  assert.deepEqual(selectBtcResearchCandidate(changed), first);
  for (const result of changed) {
    Object.defineProperty(result.metrics, 'validation', { get() { throw new Error('future period read'); } });
    Object.defineProperty(result.metrics, 'recent', { get() { throw new Error('future period read'); } });
  }
  assert.deepEqual(selectBtcResearchCandidate(changed), first);
});

test('profitability, drawdown, tail risk, cost stress, and annualized target remain mandatory', () => {
  const cases = [
    [{ totalReturn: 0.09 }, {}, 'noReturnDeterioration'],
    [{ maxDrawdown: -0.09 }, {}, 'noDrawdownDeterioration'],
    [{ worstDayReturn: -0.021 }, {}, 'noTailDeterioration'],
    [{ expectedShortfall95: 0.011 }, {}, 'noTailDeterioration'],
    [{}, { totalReturn: -0.01 }, 'positiveDoubleCostReturn'],
    [{}, { profitableDayRatio: 0.59 }, 'doubleCostProfitableDays60'],
    [{}, { maxDrawdown: -0.09 }, 'noDoubleCostDrawdownDeterioration'],
    [{}, { expectedShortfall95: 0.011 }, 'noDoubleCostTailDeterioration'],
  ];
  for (const [standard, pressure, check] of cases) {
    const selection = selectBtcResearchCandidate([...baseline(), ...pair('C1', standard, pressure)]);
    assert.equal(selection.nominatedCandidate, null, check);
    assert.equal(selection.developmentGates.C1.checks[check], false, check);
  }
  for (const [standard, pressure] of [[{ annualizedReturn: 0.09 }, {}], [{}, { annualizedReturn: 0.09 }]]) {
    const selection = selectBtcResearchCandidate([...baseline(), ...pair('C1', standard, pressure)]);
    assert.equal(selection.developmentGates.C1.passed, true);
    assert.equal(selection.developmentGates.C1.annualized10Met, false);
    assert.equal(selection.nominatedCandidate, null);
  }
});

test('all standard and double-cost runs are mandatory and duplicate rows are rejected', () => {
  assert.throws(() => selectBtcResearchCandidate(pair('C1')), /Missing baseline/);
  assert.throws(() => selectBtcResearchCandidate([baseline()[0], ...pair('C1')]), /Incomplete.*B0/);
  assert.throws(() => selectBtcResearchCandidate([...baseline(), pair('C1')[0]]), /Incomplete.*C1/);
  assert.throws(() => selectBtcResearchCandidate([...baseline(), ...pair('C1'), pair('C1')[1]]), /Duplicate.*C1/);
  assert.throws(() => selectBtcResearchCandidate([...baseline(), { id: 'C1', costMultiplier: 3 }]), /costMultiplier/);
  assert.throws(() => selectBtcResearchCandidate(null), /must be an array/);
  assert.throws(() => selectBtcResearchCandidate([...baseline(), null]), /Every research/);
  assert.throws(() => selectBtcResearchCandidate(baseline(), { baselineId: '' }), /non-empty/);
});

test('missing, non-finite, and incomplete development data fail closed', () => {
  for (const metrics of [undefined, null, {}, metric({ dataComplete: false }),
    metric({ dataComplete: undefined }), metric({ profitableDayRatio: NaN }),
    metric({ annualizedReturn: undefined }), metric({ maxDrawdown: Infinity })]) {
    const candidate = pair('C1');
    candidate[0].metrics.development = metrics;
    const selection = selectBtcResearchCandidate([...baseline(), ...candidate]);
    assert.equal(selection.nominatedCandidate, null);
    assert.equal(selection.developmentGates.C1.eligibleForForward, false);
    assert.equal(selection.ranking.at(-1).id, 'C1');
  }
  for (const cost of [1, 2]) {
    const rows = [...baseline(), ...pair('C1')];
    rows.find(row => row.id === 'B0' && row.costMultiplier === cost).metrics = {};
    const selection = selectBtcResearchCandidate(rows);
    assert.equal(selection.nominatedCandidate, null);
    assert.equal(selection.bestDiagnosticCandidate, null);
    assert.equal(selection.developmentGates.C1.eligibleForForward, false);
  }
});

test('diagnostic tie breaks on development net return and stable id, independent of input order', () => {
  const rows = [...baseline(), ...pair('C2'), ...pair('C1'), ...pair('C3', { totalReturn: 0.21 })];
  const selection = selectBtcResearchCandidate(rows);
  assert.deepEqual(selection.ranking.map(row => row.id), ['C3', 'C1', 'C2', 'B0']);
  assert.deepEqual(selectBtcResearchCandidate([...rows].reverse()).ranking, selection.ranking);
  assert.equal(selection.nominatedCandidate.id, 'C3');
});

test('explicit missing-day evidence overrides a contradictory dataComplete flag in every cost pair', () => {
  const contradictions = [
    { missingDays: 1 }, { missingDays: -1 }, { missingDays: '0' }, { missingDays: undefined },
    { missingDates: ['2024-01-01'] }, { missingDates: null }, { missingDates: undefined },
    { missingDays: 0, missingDates: ['2024-01-01'] },
    { observations: 49, expectedDays: 50 }, { observations: 51, expectedDays: 50 },
    { observations: 0, expectedDays: 0 }, { observations: 50 }, { expectedDays: 50 },
    { observations: '50', expectedDays: 50 }, { observations: 50, expectedDays: NaN },
  ];
  for (const id of ['B0', 'C1']) {
    for (const costMultiplier of [1, 2]) {
      for (const contradiction of contradictions) {
        const rows = [...baseline(), ...pair('C1')];
        Object.assign(rows.find(row => row.id === id && row.costMultiplier === costMultiplier).metrics.development, contradiction);
        const selection = selectBtcResearchCandidate(rows);
        assert.equal(selection.nominatedCandidate, null);
        assert.equal(selection.reason, 'no_candidate_passed_development');
        assert.equal(selection.developmentGates.C1.checks.coverageConsistency, false);
        assert.equal(selection.developmentGates.C1.checks.completeData, false);
        assert.ok(selection.developmentGates.C1.failedChecks.includes('coverageConsistency'));
      }
    }
  }
});

test('complete calendar metadata with no missing days permits development nomination', () => {
  const rows = [...baseline(), ...pair('C1')];
  for (const row of rows) Object.assign(row.metrics.development,
    { missingDays: 0, missingDates: [], observations: 50, expectedDays: 50 });
  const selection = selectBtcResearchCandidate(rows);
  assert.equal(selection.nominatedCandidate.id, 'C1');
  assert.equal(selection.developmentGates.C1.checks.coverageConsistency, true);
  assert.equal(selection.developmentGates.C1.checks.completeData, true);
});

test('a failing diagnostic leader does not suppress a lower ranked qualified candidate', () => {
  const selection = selectBtcResearchCandidate([...baseline(), ...pair('C1'),
    ...pair('C2', { profitableDayRatio: 0.7, maxDrawdown: -0.3 })]);
  assert.equal(selection.bestDiagnosticCandidate.id, 'C2');
  assert.equal(selection.nominatedCandidate.id, 'C1');
});

test('custom baseline and development keys work without reading the default period', () => {
  const rows = [...pair('original', { profitableDayRatio: 0.5, totalReturn: 0.1 },
    { profitableDayRatio: 0.48, totalReturn: 0.05 }), ...pair('C1')];
  for (const row of rows) { row.metrics.train = row.metrics.development; delete row.metrics.development; }
  const selection = selectBtcResearchCandidate(rows, { baselineId: 'original', developmentKey: 'train' });
  assert.equal(selection.nominatedCandidate.id, 'C1');
  assert.equal(selection.developmentKey, 'train');
});
