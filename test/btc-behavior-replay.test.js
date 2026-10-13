import test from 'node:test';
import assert from 'node:assert/strict';
import { replayBtcBehavior } from '../src/btc-behavior-replay.js';
import { dailyWinMetrics } from '../src/btc-daily-target.js';
import { paperResearchPeriodMetrics } from '../src/paper-research-replay.js';

function marketFor(prices = [100, 110, 99]) {
  return {
    initializationCycleDate: '2026-01-02',
    throughCycleDate: `2026-01-${String(prices.length + 1).padStart(2, '0')}`,
    seriesBySymbol: {
      BTCUSDT: prices.map((close, index) => ({ date: `2026-01-${String(index + 1).padStart(2, '0')}`, close })),
    },
    markPricesByCycleDate: Object.fromEntries(prices.map((price, index) => [
      `2026-01-${String(index + 2).padStart(2, '0')}`, { BTCUSDT: price },
    ])),
  };
}

function replay({ market = marketFor(), profile = {}, signalFn = () => ({ targetWeight: 0.5 }), ...rest } = {}) {
  return replayBtcBehavior({
    market,
    profile: { id: 'test', tradingCostRate: 0, dailyCarryCostRate: 0, ...profile },
    signalFn,
    ...rest,
  });
}

function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test('signed quantities make money in both long rises and short falls', () => {
  const state = replay({ signalFn: ({ cycleDate }) => ({ targetWeight: cycleDate === '2026-01-02' ? 0.5 : -0.5 }) });
  close(state.reports[1].pricePnl, 500);
  close(state.reports[2].pricePnl, 525);
  close(state.equity, 11_025);
  assert.equal(state.reports[1].positions[0].side, 'short');
  close(state.reports[2].dayReturn, 0.05);
});

test('reversal charges both closing and opening turnover using post-fee equity', () => {
  const state = replay({
    market: marketFor([100, 100]),
    profile: { tradingCostRate: 0.001 },
    signalFn: ({ cycleDate }) => ({ targetWeight: cycleDate === '2026-01-02' ? 0.5 : -0.5 }),
  });
  const opened = state.reports[0];
  const reversed = state.reports[1];
  const expected = opened.equity * (1 - 0.001 * 0.5) / (1 + 0.001 * 0.5);
  close(reversed.equity, expected);
  close(reversed.turnoverNotional, 0.5 * opened.equity + 0.5 * reversed.equity);
  close(reversed.tradingCost, reversed.turnoverNotional * 0.001);
  close(reversed.positions[0].signedNotional / reversed.equity, -0.5);
});

test('unchanged target still incurs genuine price-drift rebalance cost', () => {
  const state = replay({ market: marketFor([100, 110]), profile: { tradingCostRate: 0.001 } });
  const [opened, next] = state.reports;
  assert.ok(next.previousWeight > next.previousTargetWeight);
  assert.ok(next.tradingCost > 0);
  close(next.tradingCost, Math.abs(next.positions[0].signedNotional - opened.positions[0].quantity * 110) * 0.001);
  close(next.equity, opened.equity + next.pricePnl - next.tradingCost);
});

test('future rows cannot change an earlier replay and signals receive only past closes', () => {
  const market = marketFor([100, 110, 99, 200]);
  const observed = [];
  const options = {
    market,
    throughCycleDate: '2026-01-03',
    signalFn: ({ closes, index, cycleDate }) => {
      observed.push({ closes: [...closes], index, cycleDate });
      assert.ok(Object.isFrozen(closes));
      assert.equal(closes.length, index + 1);
      return { targetWeight: 0.5 };
    },
  };
  const first = replay(options);
  market.seriesBySymbol.BTCUSDT[2].close = NaN;
  market.seriesBySymbol.BTCUSDT[3].close = 1e12;
  market.markPricesByCycleDate['2026-01-04'].BTCUSDT = 1;
  const second = replay(options);
  assert.deepEqual(first, second);
  assert.deepEqual(observed[0].closes, [100]);
  assert.deepEqual(observed[1].closes, [100, 110]);
});

test('flat days remain daily reports and count in the full calendar denominator', () => {
  const state = replay({ signalFn: () => ({ targetWeight: 0 }) });
  const daily = dailyWinMetrics(state.reports, { startDate: '2026-01-03', endDate: '2026-01-04' });
  assert.equal(state.reports.length, 3);
  assert.equal(daily.expectedDays, 2);
  assert.equal(daily.profitableDays, 0);
  assert.equal(daily.flatDays, 2);
  assert.equal(daily.profitableDayRatio, 0);
  assert.equal(paperResearchPeriodMetrics(state, { startDate: '2026-01-03', endDate: '2026-01-04' }).totalReturn, 0);
});

test('doubled cost reruns the self-consistent quantities, carry and equity', () => {
  const profile = { tradingCostRate: 0.001, dailyCarryCostRate: 0.0001 };
  const signalFn = ({ cycleDate }) => ({ targetWeight: cycleDate === '2026-01-03' ? -0.75 : 0.5 });
  const normal = replay({ profile, signalFn });
  const doubled = replay({ profile, signalFn, costMultiplier: 2 });
  assert.ok(doubled.equity < normal.equity);
  assert.notEqual(doubled.reports[0].positions[0].quantity, normal.reports[0].positions[0].quantity);
  for (let index = 0; index < doubled.reports.length; index += 1) {
    const row = doubled.reports[index];
    close(row.tradingCost, row.turnoverNotional * 0.002);
    close(row.dayPnl, row.pricePnl - row.carryCost - row.tradingCost);
    close(row.positions[0].signedNotional / row.equity, row.nextWeight);
    if (index > 0) {
      const previous = doubled.reports[index - 1];
      close(row.carryCost, previous.positions[0].notional * 0.0002);
    }
  }
});

test('initialization cost is distinct but included in account cumulative results', () => {
  const state = replay({ market: marketFor([100]), profile: { tradingCostRate: 0.001 } });
  assert.equal(state.reports[0].kind, 'initialization');
  close(state.equity, 10_000 / 1.0005);
  close(state.cumulativePnl, -state.initializationTradingCost);
  close(state.totalTradingCost, state.initializationTradingCost);
  assert.ok(state.reports[0].dayReturn < 0);
});

test('missing marks or signal dates and duplicate signal dates are rejected', () => {
  const missingMark = marketFor();
  delete missingMark.markPricesByCycleDate['2026-01-03'];
  assert.throws(() => replay({ market: missingMark }), /mark/);
  const missingSignal = marketFor();
  missingSignal.seriesBySymbol.BTCUSDT.splice(1, 1);
  assert.throws(() => replay({ market: missingSignal }), /Missing.*signal date/);
  const duplicate = marketFor();
  duplicate.seriesBySymbol.BTCUSDT[1].date = '2026-01-01';
  assert.throws(() => replay({ market: duplicate }), /duplicate/);
});

test('insolvency and invalid parameters or targets stop research rather than hide failed days', () => {
  assert.throws(() => replay({ market: marketFor([100, 201]), signalFn: () => ({ targetWeight: -1 }) }), /Insolvent/);
  for (const field of ['tradingCostRate', 'dailyCarryCostRate', 'maxGrossExposure']) {
    assert.throws(() => replay({ profile: { [field]: -0.1 } }), new RegExp(field));
  }
  assert.throws(() => replay({ initialCapital: 0 }), /initialCapital/);
  assert.throws(() => replay({ costMultiplier: -1 }), /costMultiplier/);
  assert.throws(() => replay({ profile: { tradingCostRate: 1 } }), /must be below 1/);
  assert.throws(() => replay({ signalFn: () => ({ targetWeight: 1.01 }) }), /targetWeight/);
  assert.throws(() => replay({ signalFn: () => ({ targetWeight: NaN }) }), /targetWeight/);
  assert.throws(() => replay({ throughCycleDate: '2026-02-30' }), /valid YYYY/);
});

test('behavior context tracks complete holding days, reversals and previous targets', () => {
  const observed = [];
  const weights = [0.5, 0.5, -0.5, 0, 0];
  replay({
    market: marketFor([100, 110, 99, 101, 100]),
    signalFn: (context) => {
      observed.push(context);
      return { targetWeight: weights[observed.length - 1] };
    },
  });
  assert.deepEqual(observed.map((item) => item.daysInPosition), [0, 1, 2, 1, 0]);
  assert.deepEqual(observed.map((item) => item.lastDirection), [0, 1, 1, -1, -1]);
  assert.deepEqual(observed.map((item) => item.previousTargetWeight), [0, 0.5, 0.5, -0.5, 0]);
  assert.ok(observed[1].previousWeight > 0.5);
});

test('signal equity context is immutable and contains only the current settled pre-trade state', () => {
  const observed = [];
  const state = replay({
    profile: { tradingCostRate: 0.001, dailyCarryCostRate: 0.0002 },
    signalFn: (ctx) => {
      assert.ok(Object.isFrozen(ctx));
      assert.throws(() => { ctx.equityBeforeTrade = 1; }, TypeError);
      assert.throws(() => { ctx.markPrice = 1e9; }, TypeError);
      assert.equal('market' in ctx, false);
      assert.equal('reports' in ctx, false);
      observed.push(ctx);
      return { targetWeight: 0.5 };
    },
  });
  for (let index = 0; index < state.reports.length; index += 1) {
    const row = state.reports[index];
    const ctx = observed[index];
    close(ctx.startingEquity, row.startingEquity);
    close(ctx.equityBeforeTrade, row.startingEquity + row.pricePnl - row.carryCost);
    close(row.equity, ctx.equityBeforeTrade - row.tradingCost);
    close(ctx.settledWeight, row.settledWeight);
    close(ctx.markPrice, [100, 110, 99][index]);
    if (index === 0) {
      assert.equal(ctx.settledWeight, 0);
      assert.equal(ctx.equityBeforeTrade, 10_000);
    } else {
      close(ctx.previousWeight, state.reports[index - 1].positions[0].quantity * ctx.markPrice / ctx.equityBeforeTrade);
    }
  }
});
