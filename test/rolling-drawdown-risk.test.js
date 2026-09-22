import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRollingDrawdownRisk } from '../src/rolling-drawdown-risk.js';

const settings = {
  rollingDrawdownRiskEnabled: true,
  rollingDrawdownWindowDays: 20,
  rollingDrawdownStart: 0.02,
  rollingDrawdownFull: 0.05,
  rollingDrawdownMinimumScale: 0.25,
};

test('默认关闭的研究风控不修改正式账户状态', () => {
  const component = { equity: 1 };
  assert.deepEqual(evaluateRollingDrawdownRisk(component, {}, '2026-09-12'), { enabled: false, scale: 1 });
  assert.deepEqual(component, { equity: 1 });
});

test('滚动回撤按当时净值逐渐减仓且同日重复调用不增加样本', () => {
  const component = { equity: 100 };
  assert.equal(evaluateRollingDrawdownRisk(component, settings, '2026-09-01').scale, 1);
  component.equity = 96.5;
  const mid = evaluateRollingDrawdownRisk(component, settings, '2026-09-02');
  assert.ok(Math.abs(mid.scale - 0.625) < 1e-12);
  assert.deepEqual(evaluateRollingDrawdownRisk(component, settings, '2026-09-02'), mid);
  assert.equal(component.drawdownRiskHistory.length, 2);
  component.equity = 90;
  assert.equal(evaluateRollingDrawdownRisk(component, settings, '2026-09-03').scale, 0.25);
  assert.equal(evaluateRollingDrawdownRisk(component, settings, '2026-09-24').scale, 1);
  assert.equal(component.drawdownRiskHistory.length, 1);
});

test('滚动回撤拒绝无效参数与净值并排除未来记录', () => {
  for (const patch of [{ rollingDrawdownFull: 0.01 }, { rollingDrawdownWindowDays: 0 }, { rollingDrawdownMinimumScale: 0 }]) {
    assert.throws(() => evaluateRollingDrawdownRisk({ equity: 1 }, { ...settings, ...patch }, '2026-09-12'), /无效/);
  }
  assert.throws(() => evaluateRollingDrawdownRisk({ equity: NaN }, settings, '2026-09-12'), /无效/);
  const component = { equity: 1, drawdownRiskHistory: [{ date: '2026-10-01', equity: 10 }] };
  assert.equal(evaluateRollingDrawdownRisk(component, settings, '2026-09-12').scale, 1);
});
