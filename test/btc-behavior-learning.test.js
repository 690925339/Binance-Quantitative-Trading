import test from 'node:test';
import assert from 'node:assert/strict';
import { addUtcDays } from '../src/monthly-accuracy-paper.js';
import { btcLearningCandidates, createBtcLearningSignal } from '../src/btc-behavior-learning.js';

function fixture(direction = 1) {
  const series = Array.from({ length: 320 }, (_, i) => ({ date: addUtcDays('2023-01-01', i),
    close: 100 * Math.exp(direction * (0.002 * i + Math.sin(i / 4) * 0.003)) }));
  return { seriesBySymbol: { BTCUSDT: series }, markPricesByCycleDate: Object.fromEntries(series.map((r, i) =>
    [addUtcDays(r.date, 1), { BTCUSDT: 100 * Math.exp(direction * 0.002 * i) }])) };
}

test('滚动方向模型只使用已到期标签，能分别产生多头和空头', () => {
  for (const candidate of btcLearningCandidates()) for (const direction of [1, -1]) {
    const market = fixture(direction), signal = createBtcLearningSignal(candidate.profile, market);
    const result = signal({ closes: market.seriesBySymbol.BTCUSDT.map(r => r.close), index: 250,
      cycleDate: addUtcDays(market.seriesBySymbol.BTCUSDT[250].date, 1) });
    assert.equal(Math.sign(result.targetWeight), direction);
    assert.ok(Math.abs(result.targetWeight) <= 0.5);
    assert.ok(result.diagnostics.latestOutcomeDate <= addUtcDays(market.seriesBySymbol.BTCUSDT[250].date, 1));
    assert.equal(result.diagnostics.probabilityIsCalibrated, false);
  }
});

test('修改未来价格及未来标签不会改变此前滚动模型决策', () => {
  for (const candidate of btcLearningCandidates()) {
    const market = fixture(), altered = structuredClone(market);
    const cutoff = addUtcDays(market.seriesBySymbol.BTCUSDT[250].date, 1);
    for (const r of altered.seriesBySymbol.BTCUSDT) if (r.date >= cutoff) r.close *= 7;
    for (const [date, values] of Object.entries(altered.markPricesByCycleDate)) if (date > cutoff) values.BTCUSDT *= 0.1;
    const input = { closes: market.seriesBySymbol.BTCUSDT.map(r => r.close), index: 250, cycleDate: cutoff };
    const original = createBtcLearningSignal(candidate.profile, market)(input);
    const changed = createBtcLearningSignal(candidate.profile, altered)({ ...input, closes: altered.seriesBySymbol.BTCUSDT.map(r => r.close) });
    assert.deepEqual(changed, original);
  }
});

test('训练不足必须空仓而非使用未来数据补齐，样本不能回拨', () => {
  const market = fixture();
  market.markPricesByCycleDate = Object.fromEntries(Object.entries(market.markPricesByCycleDate).slice(200));
  for (const candidate of btcLearningCandidates()) {
    const signal = createBtcLearningSignal(candidate.profile, market), closes = market.seriesBySymbol.BTCUSDT.map(r => r.close);
    const cycleDate = addUtcDays(market.seriesBySymbol.BTCUSDT[250].date, 1);
    const result = signal({ closes, index: 250, cycleDate });
    assert.equal(result.targetWeight, 0);
    assert.equal(result.diagnostics.reason, 'training_warmup');
    assert.throws(() => signal({ closes, index: 249, cycleDate: addUtcDays(cycleDate, -1) }), /正序/);
  }
});

test('固定模型配置独立，非法参数拒绝', () => {
  const candidates = btcLearningCandidates();
  assert.deepEqual(candidates.map(c => c.id), ['A0', 'A1']);
  candidates[0].profile.trainingWindow = 9;
  assert.equal(btcLearningCandidates()[0].profile.trainingWindow, 365);
  for (const profile of [{}, { ...btcLearningCandidates()[0].profile, maxGrossExposure: 2 },
    { ...btcLearningCandidates()[1].profile, neighbors: 0 }, { ...btcLearningCandidates()[0].profile, steps: 0 }]) {
    assert.throws(() => createBtcLearningSignal(profile, fixture()));
  }
});

test('不能用较早特征搭配未来决策日期，模型闭包不受外部参数修改影响', () => {
  const market = fixture(), profile = btcLearningCandidates()[0].profile;
  const signal = createBtcLearningSignal(profile, market);
  const input = { closes: market.seriesBySymbol.BTCUSDT.map(r => r.close), index: 250,
    cycleDate: addUtcDays(market.seriesBySymbol.BTCUSDT[250].date, 1) };
  assert.throws(() => signal({ ...input, cycleDate: addUtcDays(input.cycleDate, 1) }), /日期与可用行情/);
  profile.minimumTraining = 1000;
  assert.notEqual(signal(input).targetWeight, 0);
});
