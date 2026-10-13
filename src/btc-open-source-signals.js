import { addUtcDays } from './monthly-accuracy-paper.js';

// Independently implemented research concepts, not copied upstream source code.
// Freqtrade: SMA crossings with an independent ADX entry/exit threshold.
// QuantDinger: close an opposite position before confirming the new entry.
const SOURCE_REFS = {
  freqtrade: 'https://github.com/freqtrade/freqtrade-strategies/blob/f3340ce11f5bdf62f598522e64d1f5638eaa13f5/user_data/strategies/futures/FAdxSmaStrategy.py',
  quantdinger: 'https://github.com/OpenByteInc/QuantDinger/blob/a5a9f4c79a263113504e882531585a9f2d3b24f9/backend_api_python/migrations/strategy_v2_templates.sql',
};

export function btcOpenSourceCandidates() {
  const common = {
    protocolId: 'btc-open-source-daily60-v1-2026-10-04', researchOnly: true,
    mode: 'sma_adx', warmupDays: 180, fastPeriod: 12, slowPeriod: 48,
    adxPeriod: 14, adxEntry: 30, adxExit: 30, reverseFlatFirst: false,
    sourceRefs: [SOURCE_REFS.freqtrade],
  };
  const definitions = [
    ['B0', '原策略同口径参照', { mode: 'original', sourceRefs: [] }],
    ['F1', '均线交叉与ADX30独立入场退出', {}],
    ['F2', '均线交叉与ADX30入场20退出', { adxExit: 20 }],
    ['Q1', '原策略反向先平仓后确认', { mode: 'original', reverseFlatFirst: true, sourceRefs: [SOURCE_REFS.quantdinger] }],
    ['F3', 'ADX独立退出与反向先平后开', { adxExit: 20, reverseFlatFirst: true, sourceRefs: [SOURCE_REFS.freqtrade, SOURCE_REFS.quantdinger] }],
  ];
  return definitions.map(([id, name, overrides]) => ({
    id, name, profile: structuredClone({ ...common, ...overrides }),
  }));
}

function dateValue(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function finite(value, name, minimum = -Infinity, maximum = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${name}`);
  }
}

function positiveInteger(value, name, minimum = 1) {
  finite(value, name, minimum);
  if (!Number.isInteger(value)) throw new Error(`Invalid ${name}`);
}

function indicatorPeriods({ fastPeriod = 12, slowPeriod = 48, adxPeriod = 14 } = {}) {
  positiveInteger(fastPeriod, 'fastPeriod');
  positiveInteger(slowPeriod, 'slowPeriod');
  positiveInteger(adxPeriod, 'adxPeriod', 2);
  if (fastPeriod >= slowPeriod) throw new Error('fastPeriod must be below slowPeriod');
  return { fastPeriod, slowPeriod, adxPeriod };
}

function knownBars(dailyBars, throughDate) {
  if (!Array.isArray(dailyBars)) throw new Error('Invalid dailyBars');
  if (throughDate !== undefined) dateValue(throughDate, 'throughDate');
  const known = [];
  for (const bar of dailyBars) {
    // Only the date is consulted for future rows; future OHLC values never
    // participate in validation or in the recursive indicator state.
    if (throughDate !== undefined && bar?.date > throughDate) continue;
    dateValue(bar?.date, 'OHLC date');
    if (known.length && bar.date !== addUtcDays(known.at(-1).date, 1)) {
      throw new Error(`Missing, duplicate or unordered OHLC date near ${bar.date}`);
    }
    const row = { date: bar.date };
    for (const key of ['open', 'high', 'low', 'close']) {
      finite(bar[key], `OHLC ${key} at ${bar.date}`, Number.MIN_VALUE);
      row[key] = bar[key];
    }
    finite(bar.volume, `OHLC volume at ${bar.date}`, 0);
    row.volume = bar.volume;
    if (row.high < Math.max(row.open, row.close, row.low)
      || row.low > Math.min(row.open, row.close, row.high)) {
      throw new Error(`Invalid OHLC range at ${bar.date}`);
    }
    known.push(row);
  }
  return known;
}

/**
 * Wilder DMI/ADX from real complete OHLC bars. The initial smoothed TR/DM uses
 * transitions 1..period; the first ADX averages period DX values (index 2p-1).
 * Prefix calls use identical recursive history and therefore identical values.
 */
export function btcOpenSourceIndicators(dailyBars, options = {}) {
  const { fastPeriod, slowPeriod, adxPeriod } = indicatorPeriods(options);
  const bars = knownBars(dailyBars, options.throughDate);
  let fastSum = 0;
  let slowSum = 0;
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  let dxSum = 0;
  let adx = null;
  return bars.map((bar, index) => {
    fastSum += bar.close;
    slowSum += bar.close;
    if (index >= fastPeriod) fastSum -= bars[index - fastPeriod].close;
    if (index >= slowPeriod) slowSum -= bars[index - slowPeriod].close;
    let plusDi = null;
    let minusDi = null;
    let dx = null;
    if (index > 0) {
      const previous = bars[index - 1];
      const up = bar.high - previous.high;
      const down = previous.low - bar.low;
      const plus = up > down && up > 0 ? up : 0;
      const minus = down > up && down > 0 ? down : 0;
      const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
      if (index <= adxPeriod) {
        trSum += tr;
        plusSum += plus;
        minusSum += minus;
      } else {
        trSum = trSum - trSum / adxPeriod + tr;
        plusSum = plusSum - plusSum / adxPeriod + plus;
        minusSum = minusSum - minusSum / adxPeriod + minus;
      }
      if (index >= adxPeriod) {
        plusDi = trSum === 0 ? 0 : 100 * plusSum / trSum;
        minusDi = trSum === 0 ? 0 : 100 * minusSum / trSum;
        dx = plusDi + minusDi === 0 ? 0 : 100 * Math.abs(plusDi - minusDi) / (plusDi + minusDi);
        if (index < 2 * adxPeriod) dxSum += dx;
        if (index === 2 * adxPeriod - 1) adx = dxSum / adxPeriod;
        if (index >= 2 * adxPeriod) adx = (adx * (adxPeriod - 1) + dx) / adxPeriod;
      }
    }
    return {
      date: bar.date, close: bar.close,
      fastSma: index >= fastPeriod - 1 ? fastSum / fastPeriod : null,
      slowSma: index >= slowPeriod - 1 ? slowSum / slowPeriod : null,
      plusDi, minusDi, dx, adx,
    };
  });
}

function validateProfile(profile) {
  if (!profile || !['original', 'sma_adx'].includes(profile.mode)) throw new Error('Invalid direction mode');
  indicatorPeriods(profile);
  positiveInteger(profile.warmupDays, 'warmupDays', 180);
  if (Math.max(profile.slowPeriod, 2 * profile.adxPeriod) > profile.warmupDays) throw new Error('Indicator period exceeds common warmup');
  finite(profile.adxEntry, 'adxEntry', 0, 100);
  finite(profile.adxExit, 'adxExit', 0, 100);
  if (profile.adxEntry < profile.adxExit) throw new Error('ADX exit must not exceed entry');
  if (typeof profile.reverseFlatFirst !== 'boolean') throw new Error('Invalid reverseFlatFirst');
}

/**
 * Sequential research direction policy. Real executed previousWeight is the
 * source of position truth; a previous proposed direction is never a position.
 * The caller owns risk sizing and must create a new policy for every replay.
 */
export function createBtcOpenSourceDirection(inputProfile, dailyBars) {
  validateProfile(inputProfile);
  if (!Array.isArray(dailyBars)) throw new Error('Invalid dailyBars');
  const profile = structuredClone(inputProfile);
  const bars = dailyBars.slice();
  let pendingDirection = 0;
  let pendingDate = null;
  let lastCycleDate = null;
  let lastSignature = null;
  let lastResult = null;
  return function directionPolicy({ closes, index, cycleDate, previousWeight = 0, originalDirection = 0 } = {}) {
    dateValue(cycleDate, 'cycleDate');
    finite(previousWeight, 'previousWeight');
    if (![-1, 0, 1].includes(originalDirection)) throw new Error('Invalid originalDirection');
    if (!Array.isArray(closes) || !closes.length || !Number.isInteger(index) || index < 0 || index >= closes.length) {
      throw new Error('Invalid closes or index');
    }
    // Do not consult closes after the executor-provided cutoff.
    for (let i = 0; i <= index; i += 1) finite(closes[i], 'known close', Number.MIN_VALUE);
    if (lastCycleDate && cycleDate < lastCycleDate) throw new Error('Direction calls must be chronological');
    const signature = JSON.stringify([index, closes[index], previousWeight, originalDirection]);
    if (cycleDate === lastCycleDate) {
      if (signature !== lastSignature) throw new Error('Conflicting direction inputs for the same cycle');
      return structuredClone(lastResult);
    }
    const signalDate = addUtcDays(cycleDate, -1);
    const indicators = btcOpenSourceIndicators(bars, { ...profile, throughDate: signalDate });
    const current = indicators.at(-1);
    if (!current || current.date !== signalDate) throw new Error(`Missing completed OHLC day ${signalDate}`);
    if (Math.abs(current.close - closes[index]) > Math.max(1, current.close) * 1e-10) {
      throw new Error(`OHLC close does not match signal close at ${signalDate}`);
    }
    const previous = indicators.at(-2);
    const heldDirection = Math.sign(previousWeight);
    const diagnostics = {
      mode: profile.mode, signalDate, knownBarCount: indicators.length,
      warmupDays: profile.warmupDays, originalDirection, heldDirection,
      fastSma: current.fastSma, slowSma: current.slowSma, adx: current.adx,
      adxEntry: profile.adxEntry, adxExit: profile.adxExit,
      crossUp: false, crossDown: false, pendingDirection,
      reason: 'warmup', direction: 0,
    };
    const finish = (direction, reason) => {
      const result = { direction, diagnostics: { ...diagnostics, reason, direction, pendingDirection } };
      lastCycleDate = cycleDate;
      lastSignature = signature;
      lastResult = structuredClone(result);
      return result;
    };
    const cancelPending = () => { pendingDirection = 0; pendingDate = null; };
    if (index < profile.warmupDays || indicators.length <= profile.warmupDays) {
      cancelPending();
      return finish(0, 'warmup');
    }
    let desiredDirection;
    let confirmationDirection;
    if (profile.mode === 'original') {
      desiredDirection = originalDirection;
      confirmationDirection = originalDirection;
    } else {
      if (current.adx === null || !previous || previous.fastSma === null || previous.slowSma === null) {
        throw new Error('Indicators are not initialized after common warmup');
      }
      diagnostics.crossUp = previous.fastSma <= previous.slowSma && current.fastSma > current.slowSma;
      diagnostics.crossDown = previous.fastSma >= previous.slowSma && current.fastSma < current.slowSma;
      // Exit always precedes entry and does not depend on the entry threshold.
      if (current.adx < profile.adxExit) {
        cancelPending();
        return finish(0, 'adx_exit');
      }
      const strong = current.adx > profile.adxEntry;
      confirmationDirection = strong ? Math.sign(current.fastSma - current.slowSma) : 0;
      desiredDirection = strong && diagnostics.crossUp ? 1 : strong && diagnostics.crossDown ? -1 : heldDirection;
    }
    if (pendingDirection) {
      if (confirmationDirection !== pendingDirection) {
        cancelPending();
      } else if (heldDirection === 0 && cycleDate > pendingDate) {
        const confirmed = pendingDirection;
        cancelPending();
        return finish(confirmed, 'confirmed_entry_after_flat');
      } else if (heldDirection === pendingDirection) {
        // An externally opened position is now the actual position; do not
        // leave a stale pending order that could reopen after a later risk exit.
        cancelPending();
      } else {
        return finish(0, 'await_actual_flat');
      }
    }
    if (profile.reverseFlatFirst && heldDirection !== 0 && desiredDirection === -heldDirection) {
      pendingDirection = desiredDirection;
      pendingDate = cycleDate;
      return finish(0, 'close_before_reverse');
    }
    return finish(desiredDirection, desiredDirection === 0 ? 'no_entry' : desiredDirection === heldDirection ? 'hold_actual_position' : 'direction_entry');
  };
}
