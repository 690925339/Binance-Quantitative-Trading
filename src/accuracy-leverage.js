import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const HOURS_TO_MS = 60 * 60 * 1_000;
const DAYS_PER_YEAR = 365;

export const STABLE_ACCURACY_LEVERAGE_DEFAULTS = Object.freeze({
  strategyType: 'stableComposite',
  minimumAccuracy: 0.90,
  minimumSamples: 100,
  performanceWindow: 100,
  recentWindow: 20,
  minimumRecentAccuracy: 0.85,
  minimumWilsonLower: 0.82,
  maximumAnnualizedVolatility: 0.08,
  maximumDrawdownMagnitude: 0.05,
  leverageMultiplier: 1.25,
  horizonHours: 168,
  roundTripCostRate: 0.0014,
  ledgerLimit: 1_000,
});

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function wilsonLowerBound(successes, total, z = 1.96) {
  if (!total) return 0;
  const probability = successes / total;
  const zSquared = z ** 2;
  const denominator = 1 + zSquared / total;
  const centre = probability + zSquared / (2 * total);
  const margin = z * Math.sqrt((probability * (1 - probability) + zSquared / (4 * total)) / total);
  return (centre - margin) / denominator;
}

function normalizeOptions(options = {}) {
  const settings = { ...STABLE_ACCURACY_LEVERAGE_DEFAULTS, ...options };
  for (const key of ['minimumAccuracy', 'minimumRecentAccuracy', 'minimumWilsonLower']) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1) {
      throw new Error(`${key} 必须在 0 到 1 之间`);
    }
  }
  for (const key of ['minimumSamples', 'performanceWindow', 'recentWindow', 'horizonHours', 'ledgerLimit']) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new Error(`${key} 必须是正整数`);
  }
  if (settings.performanceWindow < settings.minimumSamples) {
    throw new Error('performanceWindow 不能小于 minimumSamples');
  }
  if (!Number.isFinite(settings.maximumAnnualizedVolatility) || settings.maximumAnnualizedVolatility <= 0) {
    throw new Error('maximumAnnualizedVolatility 必须大于 0');
  }
  if (!Number.isFinite(settings.maximumDrawdownMagnitude)
    || settings.maximumDrawdownMagnitude <= 0
    || settings.maximumDrawdownMagnitude >= 1) {
    throw new Error('maximumDrawdownMagnitude 必须大于 0 且小于 1');
  }
  if (!Number.isFinite(settings.leverageMultiplier)
    || settings.leverageMultiplier < 1
    || settings.leverageMultiplier > 1.5) {
    throw new Error('leverageMultiplier 必须在 1 到 1.5 之间');
  }
  if (!Number.isFinite(settings.roundTripCostRate) || settings.roundTripCostRate < 0) {
    throw new Error('roundTripCostRate 不能小于 0');
  }
  return settings;
}

export function evaluateAccuracyLeverage(performance = {}, options = {}) {
  const settings = normalizeOptions(options);
  const settledSignalCount = Number(performance.settledSignalCount) || 0;
  const correctSignalCount = Number(performance.correctSignalCount) || 0;
  const recentSignalCount = Number(performance.recentSignalCount) || 0;
  const recentCorrectSignalCount = Number(performance.recentCorrectSignalCount) || 0;
  const accuracy = settledSignalCount ? correctSignalCount / settledSignalCount : 0;
  const recentAccuracy = recentSignalCount ? recentCorrectSignalCount / recentSignalCount : 0;
  const wilson95Lower = wilsonLowerBound(correctSignalCount, settledSignalCount);
  const annualizedVolatility = Number(performance.annualizedVolatility) || 0;
  const currentDrawdown = Number(performance.currentDrawdown) || 0;
  const checks = {
    lowRiskStrategy: performance.strategyType === settings.strategyType,
    minimumSamples: settledSignalCount >= settings.minimumSamples,
    minimumAccuracy: accuracy >= settings.minimumAccuracy,
    recentSampleComplete: recentSignalCount >= Math.min(settings.recentWindow, settledSignalCount),
    minimumRecentAccuracy: recentAccuracy >= settings.minimumRecentAccuracy,
    wilsonConfidence: wilson95Lower >= settings.minimumWilsonLower,
    maximumVolatility: annualizedVolatility <= settings.maximumAnnualizedVolatility,
    maximumDrawdown: currentDrawdown >= -settings.maximumDrawdownMagnitude,
  };
  const eligible = Object.values(checks).every(Boolean);
  return {
    eligible,
    appliedLeverage: eligible ? settings.leverageMultiplier : 1,
    configuredLeverage: settings.leverageMultiplier,
    accuracy: round(accuracy),
    recentAccuracy: round(recentAccuracy),
    wilson95Lower: round(wilson95Lower),
    settledSignalCount,
    minimumSamples: settings.minimumSamples,
    annualizedVolatility: round(annualizedVolatility),
    currentDrawdown: round(currentDrawdown),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

export function summarizeAccuracyRecords(records = [], strategyType = 'stableComposite', options = {}) {
  const settings = normalizeOptions(options);
  const settled = records
    .filter((record) => record.strategyType === strategyType && record.status === 'settled')
    .sort((left, right) => left.closedAt - right.closedAt);
  const window = settled.slice(-settings.performanceWindow);
  const recent = window.slice(-settings.recentWindow);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  const returns = [];
  for (const record of window) {
    const strategyReturn = Number(record.strategyReturn) || 0;
    returns.push(strategyReturn);
    equity *= 1 + strategyReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const annualizedVolatility = sampleStandardDeviation(returns)
    * Math.sqrt(DAYS_PER_YEAR / (settings.horizonHours / 24));
  return {
    strategyType,
    lifetimeSettledSignalCount: settled.length,
    settledSignalCount: window.length,
    correctSignalCount: window.filter((record) => record.correct).length,
    recentSignalCount: recent.length,
    recentCorrectSignalCount: recent.filter((record) => record.correct).length,
    annualizedVolatility: round(annualizedVolatility),
    currentDrawdown: round(equity / peak - 1),
    maximumDrawdown: round(maxDrawdown),
  };
}

export class SignalAccuracyStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.options = normalizeOptions(options);
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return { version: 1, forecasts: Array.isArray(payload.forecasts) ? payload.forecasts : [] };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, forecasts: [] };
      throw error;
    }
  }

  async observe(input, evaluationOptions = {}) {
    const summaryOptions = normalizeOptions({ ...this.options, ...evaluationOptions });
    return this.#mutate((payload) => {
      const strategyType = String(input.strategyType || '');
      const symbol = String(input.symbol || '').toUpperCase();
      const action = String(input.action || 'WAIT').toUpperCase();
      const referencePrice = Number(input.referencePrice);
      const observedAt = Number(input.observedAt);
      const targetGrossExposurePercent = Number(input.targetGrossExposurePercent) || 0;
      if (!strategyType || !/^[A-Z0-9]{5,20}$/.test(symbol)) throw new Error('准确率观察对象无效');
      if (!['LONG', 'SHORT', 'WAIT'].includes(action)) throw new Error('准确率观察方向无效');
      if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(observedAt)) {
        throw new Error('准确率观察价格或时间无效');
      }
      const candles = (input.candles || []).map((candle) => ({
        closedAt: Number(candle.closedAt),
        close: Number(candle.close),
      })).filter((candle) => Number.isFinite(candle.closedAt) && Number.isFinite(candle.close) && candle.close > 0)
        .sort((left, right) => left.closedAt - right.closedAt);

      let settledCount = 0;
      for (const forecast of payload.forecasts) {
        if (forecast.status !== 'open' || forecast.strategyType !== strategyType || forecast.symbol !== symbol) continue;
        const settlementCandle = candles.find((candle) => candle.closedAt >= forecast.dueAt);
        if (!settlementCandle) continue;
        const direction = forecast.action === 'LONG' ? 1 : -1;
        const directionalReturn = direction * (settlementCandle.close / forecast.referencePrice - 1)
          - this.options.roundTripCostRate;
        forecast.status = 'settled';
        forecast.closedAt = settlementCandle.closedAt;
        forecast.exitPrice = settlementCandle.close;
        forecast.directionalReturn = round(directionalReturn);
        forecast.strategyReturn = round(directionalReturn * forecast.targetGrossExposurePercent / 100);
        forecast.correct = directionalReturn > 0;
        settledCount += 1;
      }

      const alreadyOpen = payload.forecasts.some((forecast) => (
        forecast.status === 'open' && forecast.strategyType === strategyType && forecast.symbol === symbol
      ));
      let recorded = false;
      if (!alreadyOpen && ['LONG', 'SHORT'].includes(action) && targetGrossExposurePercent > 0) {
        payload.forecasts.push({
          id: crypto.randomUUID(),
          strategyType,
          symbol,
          action,
          referencePrice,
          targetGrossExposurePercent,
          openedAt: observedAt,
          dueAt: observedAt + this.options.horizonHours * HOURS_TO_MS,
          status: 'open',
        });
        recorded = true;
      }
      payload.forecasts = payload.forecasts
        .sort((left, right) => (left.openedAt || 0) - (right.openedAt || 0))
        .slice(-this.options.ledgerLimit);
      const performance = summarizeAccuracyRecords(payload.forecasts, strategyType, summaryOptions);
      return { recorded, settledCount, performance };
    });
  }

  async #mutate(mutator) {
    const operation = this.writeQueue.then(async () => {
      const payload = await this.read();
      const result = mutator(payload);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPath, this.filePath);
      return result;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}
