import { addUtcDays } from './monthly-accuracy-paper.js';

// Protocol fixed before testing: two causal rolling models, no parameter search.
export function btcLearningCandidates() {
  const common = { maxGrossExposure: 0.5, targetVolatility: 0.1, tradingCostRate: 0.0007,
    dailyCarryCostRate: 0.00005, trainingWindow: 365, minimumTraining: 90, volatilityWindow: 30 };
  return [
    { id: 'A0', name: '滚动逻辑回归方向', profile: { ...common, mode: 'logistic',
      retrainEveryDays: 7, steps: 100, learningRate: 0.15, regularization: 0.05 } },
    { id: 'A1', name: '滚动31近邻方向', profile: { ...common, mode: 'neighbors', neighbors: 31 } },
  ];
}

function mean(values) { return values.reduce((sum, v) => sum + v, 0) / values.length; }
function stdev(values) {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - average) ** 2, 0) / Math.max(1, values.length - 1));
}
function features(closes, index) {
  if (index < 60) return null;
  const returns = Array.from({ length: 30 }, (_, i) => Math.log(closes[index - i] / closes[index - i - 1]));
  const volatility = Math.max(stdev(returns), 1e-5);
  const logs = closes.slice(index - 19, index + 1).map(Math.log);
  const z = (logs.at(-1) - mean(logs)) / Math.max(stdev(logs), 1e-5);
  return { x: [1, 3, 10, 20, 60].map(days => Math.log(closes[index] / closes[index - days]) / (volatility * Math.sqrt(days)))
    .concat(z).map(value => Math.max(-6, Math.min(6, value))), volatility: volatility * Math.sqrt(365) };
}
function normalized(training, input) {
  const columns = input.map((_, i) => training.map(row => row.x[i]));
  const centers = columns.map(mean), scales = columns.map(v => Math.max(stdev(v), 1e-6));
  const normalize = vector => vector.map((v, i) => Math.max(-8, Math.min(8, (v - centers[i]) / scales[i])));
  return { rows: training.map(row => ({ ...row, x: normalize(row.x) })), input: normalize(input), centers, scales };
}
const sigmoid = value => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
function fitLogistic(rows, profile) {
  const weights = new Array(rows[0].x.length + 1).fill(0);
  for (let step = 0; step < profile.steps; step++) {
    const gradient = weights.map(() => 0);
    for (const row of rows) {
      const p = sigmoid(weights[0] + row.x.reduce((sum, x, i) => sum + x * weights[i + 1], 0));
      const error = p - row.y;
      gradient[0] += error;
      row.x.forEach((x, i) => { gradient[i + 1] += error * x; });
    }
    weights.forEach((w, i) => {
      weights[i] -= profile.learningRate * (gradient[i] / rows.length + (i ? profile.regularization * w : 0));
    });
  }
  return weights;
}

export function createBtcLearningSignal(inputProfile, market) {
  const profile = structuredClone(inputProfile);
  if (!['logistic', 'neighbors'].includes(profile.mode)) throw new Error('未知滚动模型');
  if (!Number.isInteger(profile.trainingWindow) || !Number.isInteger(profile.minimumTraining)
    || profile.minimumTraining < 2 || profile.trainingWindow < profile.minimumTraining
    || !(profile.maxGrossExposure > 0 && profile.maxGrossExposure <= 0.5)
    || profile.volatilityWindow !== 30
    || !(profile.targetVolatility > 0 && profile.targetVolatility <= 0.1)) throw new Error('滚动模型参数无效');
  if (profile.mode === 'neighbors' && (!Number.isInteger(profile.neighbors) || profile.neighbors < 1
    || profile.neighbors > profile.minimumTraining)) throw new Error('近邻数量无效');
  if (profile.mode === 'logistic' && (!Number.isInteger(profile.retrainEveryDays) || profile.retrainEveryDays < 1
    || !Number.isInteger(profile.steps) || profile.steps < 1 || !(profile.learningRate > 0 && profile.learningRate <= 1)
    || !Number.isFinite(profile.regularization) || profile.regularization < 0)) throw new Error('逻辑回归参数无效');
  const series = market.seriesBySymbol.BTCUSDT;
  const prices = series.map(r => r.close);
  const samples = [];
  for (let index = 60; index < series.length; index++) {
    const cycleDate = addUtcDays(series[index].date, 1), outcomeDate = addUtcDays(cycleDate, 1);
    const before = market.markPricesByCycleDate[cycleDate]?.BTCUSDT;
    const after = market.markPricesByCycleDate[outcomeDate]?.BTCUSDT;
    if (!(before > 0) || !(after > 0)) continue;
    const values = features(prices, index);
    samples.push({ x: values.x, y: after > before ? 1 : after < before ? 0 : 0.5, cycleDate, outcomeDate });
  }
  let model = null, lastDecision = null;
  return ({ closes, index, cycleDate }) => {
    if (!Array.isArray(closes) || !Number.isInteger(index) || index < 0 || index >= closes.length
      || !series[index] || cycleDate !== addUtcDays(series[index].date, 1)
      || closes.slice(0, index + 1).some(value => !Number.isFinite(value) || value <= 0)) {
      throw new Error('滚动信号日期与可用行情不一致');
    }
    if (lastDecision && cycleDate < lastDecision) throw new Error('滚动模型必须按时间正序调用');
    lastDecision = cycleDate;
    if (index < 180) return { targetWeight: 0, diagnostics: { mode: profile.mode, reason: 'warmup' } };
    const current = features(closes, index);
    if (!current || !current.x.every(Number.isFinite) || !Number.isFinite(current.volatility)) throw new Error('滚动特征无效');
    // The outcome ending at today's 09:00 is known; tomorrow's outcome is never a training label.
    const training = samples.filter(row => row.outcomeDate <= cycleDate && row.cycleDate < cycleDate
      && row.outcomeDate > addUtcDays(cycleDate, -profile.trainingWindow));
    if (training.length < profile.minimumTraining) return { targetWeight: 0,
      diagnostics: { mode: profile.mode, reason: 'training_warmup', trainingCount: training.length } };
    let probability, trainingCount, latestOutcomeDate;
    if (profile.mode === 'logistic') {
      if (!model || cycleDate >= addUtcDays(model.fittedAt, profile.retrainEveryDays)) {
        const standardized = normalized(training, current.x);
        model = { weights: fitLogistic(standardized.rows, profile), centers: standardized.centers,
          scales: standardized.scales, fittedAt: cycleDate, trainingCount: training.length,
          latestOutcomeDate: training.at(-1).outcomeDate };
      }
      const x = current.x.map((v, i) => Math.max(-8, Math.min(8, (v - model.centers[i]) / model.scales[i])));
      probability = sigmoid(model.weights[0] + x.reduce((sum, v, i) => sum + v * model.weights[i + 1], 0));
      trainingCount = model.trainingCount; latestOutcomeDate = model.latestOutcomeDate;
    } else {
      const standardized = normalized(training, current.x);
      const nearest = standardized.rows.map(row => ({ ...row,
        distance: row.x.reduce((sum, x, i) => sum + (x - standardized.input[i]) ** 2, 0),
      })).sort((a, b) => a.distance - b.distance || a.cycleDate.localeCompare(b.cycleDate)).slice(0, profile.neighbors);
      probability = mean(nearest.map(row => row.y));
      trainingCount = training.length; latestOutcomeDate = training.at(-1).outcomeDate;
    }
    const direction = Math.sign(probability - 0.5);
    const riskWeight = Math.min(profile.maxGrossExposure, profile.targetVolatility / current.volatility);
    return { targetWeight: direction * riskWeight, diagnostics: { mode: profile.mode, direction,
      probability, probabilityIsCalibrated: false, trainingCount, latestOutcomeDate,
      modelFittedAt: model?.fittedAt || cycleDate, volatility: current.volatility } };
  };
}
