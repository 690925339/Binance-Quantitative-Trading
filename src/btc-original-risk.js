import { BTC_SINGLE_ASSET_PAPER_PROFILE, evaluateBtcProfitDeRisk } from './btc-paper.js';
import { calculateLongShortTrendWeights } from './long-short-trend.js';
import { addUtcDays } from './monthly-accuracy-paper.js';

function positive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number`);
  }
  return value;
}

function cycleDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error('cycleDate must be a valid YYYY-MM-DD date');
  }
  return value;
}

/**
 * Adapt the original BTC price signal and monthly risk rules to the isolated
 * signed-quantity research executor. This is price-only research: no historical
 * news is reconstructed, and neither the live v2 profile nor ledger is changed.
 *
 * A candidate may replace direction only. Its gross budget is the absolute
 * original trend allocation after the original monthly protection. The callback
 * always sees the real held position, including while the budget is zero; there
 * is no hypothetical position state maintained on its behalf.
 *
 * Create a fresh closure for each replay (including each cost stress replay).
 */
export function createBtcOriginalRiskSignal({
  profile = BTC_SINGLE_ASSET_PAPER_PROFILE,
  directionSignal = null,
} = {}) {
  if (!profile || profile.symbol !== 'BTCUSDT' || !profile.trend) {
    throw new Error('Original BTC risk requires a BTCUSDT profile with trend settings');
  }
  if (directionSignal !== null && typeof directionSignal !== 'function') {
    throw new Error('directionSignal must be a function or null');
  }
  // Snapshot parameters so a concurrent caller cannot change a running replay.
  const settings = structuredClone(profile);
  positive(settings.monthlyLossLimit, 'monthlyLossLimit');
  if (settings.monthlyLossLimit >= 1) throw new Error('monthlyLossLimit must be below 1');
  positive(settings.monthlyProfitDeRiskThreshold, 'monthlyProfitDeRiskThreshold');
  positive(settings.monthlyProfitDeRiskScale, 'monthlyProfitDeRiskScale');
  if (settings.monthlyProfitDeRiskScale > 1) throw new Error('monthlyProfitDeRiskScale must not exceed 1');
  const trend = settings.trend;
  if (!Array.isArray(trend.lookbackDays) || !trend.lookbackDays.length
    || trend.lookbackDays.some((value) => !Number.isInteger(value) || value < 1)
    || !Number.isInteger(trend.volatilityWindowDays) || trend.volatilityWindowDays < 1) {
    throw new Error('Original BTC trend warmup settings are invalid');
  }
  const warmupDays = Math.max(...trend.lookbackDays, trend.volatilityWindowDays,
    trend.shortConfirmationLookbackDays || 0);
  let lastCycleDate = null;
  let currentMonth = null;
  let monthStartEquity = null;
  let lockReason = null;

  return (context) => {
    if (!context || typeof context !== 'object') throw new Error('Signal context is required');
    const date = cycleDate(context.cycleDate);
    if (lastCycleDate !== null && date !== addUtcDays(lastCycleDate, 1)) {
      throw new Error('Original BTC risk closure requires consecutive cycles and a fresh closure per replay');
    }
    positive(context.startingEquity, 'startingEquity');
    const equity = positive(context.equityBeforeTrade, 'equityBeforeTrade');
    const { closes, index } = context;
    if (!Array.isArray(closes) || !Number.isInteger(index) || index < warmupDays
      || closes.length !== index + 1) {
      throw new Error('Original BTC signal requires sufficient past-only closes ending at index');
    }
    if (closes.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      throw new Error('Original BTC signal closes must be finite positive prices');
    }
    if (typeof context.previousWeight !== 'number' || !Number.isFinite(context.previousWeight)) {
      throw new Error('previousWeight must be the finite actual held weight');
    }

    const initialization = lastCycleDate === null;
    const upcomingMonth = addUtcDays(date, 1).slice(0, 7);
    let nextMonth = initialization ? upcomingMonth : currentMonth;
    let nextMonthStartEquity = initialization ? context.startingEquity : monthStartEquity;
    let nextLockReason = lockReason;
    // Match the original order: settle, detect loss, then reset for tomorrow's
    // month, then apply the profit de-risk rule to the next position.
    if (!initialization && nextLockReason === null
      && equity / nextMonthStartEquity - 1 <= -settings.monthlyLossLimit) {
      nextLockReason = 'loss';
    }
    const settledLockReason = nextLockReason;
    const monthChanged = !initialization && nextMonth !== upcomingMonth;
    if (monthChanged) {
      nextMonth = upcomingMonth;
      nextMonthStartEquity = equity;
      nextLockReason = null;
    }
    const profitDeRisk = evaluateBtcProfitDeRisk({ equity, monthStartEquity: nextMonthStartEquity }, settings);
    const allocation = calculateLongShortTrendWeights({ BTCUSDT: closes }, ['BTCUSDT'], index, trend);
    const rawWeight = allocation.weights.BTCUSDT ?? 0;
    if (!Number.isFinite(rawWeight)) throw new Error('Original BTC allocation is non-finite');
    const riskBudget = nextLockReason === null ? Math.abs(rawWeight) * profitDeRisk.scale : 0;
    // Freeze a copy even for standalone tests/callers. Do not inject a simulated
    // direction or substitute an intended target for the actual previousWeight.
    const callbackContext = Object.freeze({ ...context, closes: Object.freeze([...closes]),
      originalDirection: Math.sign(rawWeight), originalRawWeight: rawWeight });
    const signal = directionSignal === null
      ? { direction: Math.sign(rawWeight), diagnostics: { source: 'original_price_trend' } }
      : directionSignal(callbackContext);
    if (!signal || typeof signal.then === 'function' || ![-1, 0, 1].includes(signal.direction)) {
      throw new Error('Direction signal must synchronously return direction -1, 0 or 1');
    }
    const targetWeight = riskBudget > 0 && signal.direction !== 0 ? signal.direction * riskBudget : 0;

    lastCycleDate = date;
    currentMonth = nextMonth;
    monthStartEquity = nextMonthStartEquity;
    lockReason = nextLockReason;
    return {
      targetWeight,
      diagnostics: {
        originalRisk: {
          evidenceScope: 'price_only',
          profileId: settings.id,
          cycleDate: date,
          currentMonth,
          monthStartEquity,
          equityBeforeTrade: equity,
          monthlyReturn: equity / monthStartEquity - 1,
          monthlyLossLimit: settings.monthlyLossLimit,
          settledLockReason,
          lockReason,
          monthChanged,
          profitDeRisk,
          rawWeight,
          originalDirection: Math.sign(rawWeight),
          riskBudget,
          activeSignalCount: allocation.activeSignalCount,
          dynamicLeverage: allocation.dynamicLeverage,
          shortConfirmation: allocation.shortConfirmation,
        },
        signal: { direction: signal.direction, ...(signal.diagnostics === undefined ? {} : { details: signal.diagnostics }) },
      },
    };
  };
}
