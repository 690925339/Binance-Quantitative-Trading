import { addUtcDays } from './monthly-accuracy-paper.js';

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function finiteNumber(value, label, { minimum = 0, exclusive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || (exclusive ? value <= minimum : value < minimum)) {
    throw new Error(`${label} must be finite and ${exclusive ? 'greater than' : 'at least'} ${minimum}`);
  }
  return value;
}

function positiveEquity(value, cycleDate, phase) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Insolvent or non-finite equity at ${cycleDate} (${phase})`);
  }
  return value;
}

// Solve E_after = E_before - feeRate * |targetWeight * E_after - oldNotional|.
// With feeRate * maxGrossExposure < 1 this solution is unique. Both an exit
// and its opposite-side entry are included in reversal turnover.
function rebalance({ equity, oldNotional, targetWeight, price, feeRate, cycleDate }) {
  const tradeDirection = Math.sign(targetWeight * equity - oldNotional);
  const postFeeEquity = positiveEquity(
    (equity + feeRate * tradeDirection * oldNotional)
      / (1 + feeRate * tradeDirection * targetWeight),
    cycleDate,
    'rebalance',
  );
  const notional = targetWeight * postFeeEquity;
  const turnover = Math.abs(notional - oldNotional);
  const tradingCost = turnover * feeRate;
  if (![notional, turnover, tradingCost].every(Number.isFinite)
    || Math.abs(postFeeEquity - (equity - tradingCost)) > Math.max(1, equity) * 1e-10) {
    throw new Error(`Non-finite or inconsistent execution at ${cycleDate}`);
  }
  return { equity: postFeeEquity, quantity: notional / price, notional, turnover, tradingCost };
}

/**
 * Isolated BTC long/short research execution model; never reads or writes a ledger.
 * Marks are the 09:00 Beijing boundary prices. Signal data is restricted to UTC
 * closes through the previous date. Carry is a fixed daily cost proxy, not an
 * assertion that historical futures funding, borrow or liquidation is modelled.
 *
 * daysInPosition counts complete settlement days in the currently held side,
 * resetting to zero when opening or reversing. lastDirection remembers the last
 * nonzero held side, including while flat. previousWeight is the drifted exposure
 * after mark-to-market and carry but before today's rebalance.
 */
export function replayBtcBehavior({
  market,
  profile,
  signalFn,
  throughCycleDate = market?.throughCycleDate,
  initialCapital = 10_000,
  costMultiplier = 1,
}) {
  if (!market || typeof market !== 'object') throw new Error('market is required');
  if (!profile || typeof profile !== 'object') throw new Error('profile is required');
  if (typeof signalFn !== 'function') throw new Error('signalFn must be a function');
  finiteNumber(initialCapital, 'initialCapital', { exclusive: true });
  finiteNumber(costMultiplier, 'costMultiplier', { exclusive: true });
  const maxGrossExposure = finiteNumber(profile.maxGrossExposure ?? 1, 'maxGrossExposure');
  const tradingCostRate = finiteNumber(profile.tradingCostRate ?? 0.0007, 'tradingCostRate');
  const dailyCarryCostRate = finiteNumber(profile.dailyCarryCostRate ?? 0, 'dailyCarryCostRate');
  const feeRate = finiteNumber(tradingCostRate * costMultiplier, 'effective tradingCostRate');
  const carryRate = finiteNumber(dailyCarryCostRate * costMultiplier, 'effective dailyCarryCostRate');
  if (feeRate * maxGrossExposure >= 1) {
    throw new Error('effective tradingCostRate * maxGrossExposure must be below 1');
  }
  const startCycleDate = validDate(market.initializationCycleDate, 'initializationCycleDate');
  validDate(throughCycleDate, 'throughCycleDate');
  if (throughCycleDate < startCycleDate) throw new Error('throughCycleDate is before initialization');
  if (market.throughCycleDate !== undefined
    && throughCycleDate > validDate(market.throughCycleDate, 'market.throughCycleDate')) {
    throw new Error('throughCycleDate is beyond the available market range');
  }

  const signalEndDate = addUtcDays(throughCycleDate, -1);
  if (!Array.isArray(market.seriesBySymbol?.BTCUSDT)) throw new Error('BTCUSDT signal series is required');
  // Deliberately ignore future rows, including their prices, when replaying an
  // earlier cutoff. A signal never receives a reference to the full input series.
  const signalSeries = market.seriesBySymbol.BTCUSDT.filter((row) => row.date <= signalEndDate);
  if (!signalSeries.length) throw new Error('BTCUSDT signal history is empty');
  const signalIndexByDate = new Map();
  const allCloses = [];
  for (const [index, row] of signalSeries.entries()) {
    validDate(row.date, 'signal date');
    finiteNumber(row.close, `BTCUSDT close at ${row.date}`, { exclusive: true });
    if (index > 0 && row.date !== addUtcDays(signalSeries[index - 1].date, 1)) {
      throw new Error(`Missing, duplicate or unordered BTCUSDT signal date near ${row.date}`);
    }
    signalIndexByDate.set(row.date, index);
    allCloses.push(row.close);
  }

  const reports = [];
  let equity = initialCapital;
  let quantity = 0;
  let lastPrice = null;
  let previousTargetWeight = 0;
  let daysInPosition = 0;
  let lastDirection = 0;
  let totalTradingCost = 0;
  let totalCarryCost = 0;
  for (let cycleDate = startCycleDate; cycleDate <= throughCycleDate; cycleDate = addUtcDays(cycleDate, 1)) {
    const initialization = cycleDate === startCycleDate;
    const price = market.markPricesByCycleDate?.[cycleDate]?.BTCUSDT;
    finiteNumber(price, `Missing or invalid BTCUSDT mark at ${cycleDate}`, { exclusive: true });
    const signalDate = addUtcDays(cycleDate, -1);
    const index = signalIndexByDate.get(signalDate);
    if (index === undefined) throw new Error(`Missing BTCUSDT signal date ${signalDate}`);
    const startingEquity = equity;
    const settledDirection = Math.sign(quantity);
    const settledWeight = initialization ? 0 : quantity * lastPrice / startingEquity;
    const assetReturn = initialization ? 0 : price / lastPrice - 1;
    const pricePnl = initialization ? 0 : quantity * (price - lastPrice);
    const carryCost = initialization ? 0 : Math.abs(quantity * lastPrice) * carryRate;
    const preTradeEquity = positiveEquity(startingEquity + pricePnl - carryCost, cycleDate, 'settlement');
    const oldNotional = quantity * price;
    const previousWeight = oldNotional / preTradeEquity;
    if (![pricePnl, carryCost, oldNotional, previousWeight, assetReturn].every(Number.isFinite)) {
      throw new Error(`Non-finite settlement at ${cycleDate}`);
    }
    if (!initialization && settledDirection !== 0) daysInPosition += 1;
    const decision = signalFn(Object.freeze({
      closes: Object.freeze(allCloses.slice(0, index + 1)),
      index,
      cycleDate,
      previousWeight,
      equityBeforeTrade: preTradeEquity,
      startingEquity,
      settledWeight,
      markPrice: price,
      daysInPosition,
      lastDirection,
      previousTargetWeight,
    }));
    const targetWeight = decision?.targetWeight;
    if (!decision || typeof decision.then === 'function'
      || typeof targetWeight !== 'number' || !Number.isFinite(targetWeight)
      || Math.abs(targetWeight) > maxGrossExposure) {
      throw new Error(`Invalid targetWeight at ${cycleDate}; absolute weight must not exceed ${maxGrossExposure}`);
    }
    const execution = rebalance({
      equity: preTradeEquity,
      oldNotional,
      targetWeight,
      price,
      feeRate,
      cycleDate,
    });
    equity = execution.equity;
    quantity = execution.quantity;
    const nextDirection = Math.sign(quantity);
    if (nextDirection === 0 || nextDirection !== settledDirection) daysInPosition = 0;
    if (nextDirection !== 0) lastDirection = nextDirection;
    totalTradingCost += execution.tradingCost;
    totalCarryCost += carryCost;
    reports.push({
      kind: initialization ? 'initialization' : 'daily',
      cycleDate,
      signalDate,
      strategyProfileId: profile.id ?? null,
      dayPnl: equity - startingEquity,
      dayReturn: equity / startingEquity - 1,
      startingEquity,
      equity,
      previousWeight,
      previousTargetWeight,
      settledWeight,
      nextWeight: targetWeight,
      modelGrossExposure: Math.abs(targetWeight),
      tradingCost: execution.tradingCost,
      carryCost,
      turnoverNotional: execution.turnover,
      assetReturn,
      pricePnl,
      daysInPosition,
      diagnostics: decision.diagnostics ?? null,
      positions: quantity === 0 ? [] : [{
        symbol: 'BTCUSDT',
        side: quantity > 0 ? 'long' : 'short',
        weight: targetWeight,
        quantity,
        markPrice: price,
        notional: Math.abs(execution.notional),
        signedNotional: execution.notional,
      }],
    });
    previousTargetWeight = targetWeight;
    lastPrice = price;
  }
  return {
    strategyProfileId: profile.id ?? null,
    executionModel: 'btc-signed-quantity-post-fee-equity-v1',
    researchOnly: true,
    initialCapital,
    equity,
    cumulativePnl: equity - initialCapital,
    cumulativeReturn: equity / initialCapital - 1,
    initializationTradingCost: reports[0].tradingCost,
    totalTradingCost,
    totalCarryCost,
    startCycleDate,
    lastCycleDate: throughCycleDate,
    reports,
  };
}
