import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SYMBOL_OPTIONS = [
  { value: 'BTCUSDT', label: 'BTC / USDT' },
  { value: 'ETHUSDT', label: 'ETH / USDT' },
  { value: 'BNBUSDT', label: 'BNB / USDT' },
  { value: 'SOLUSDT', label: 'SOL / USDT' },
  { value: 'XRPUSDT', label: 'XRP / USDT' },
  { value: 'DOGEUSDT', label: 'DOGE / USDT' },
];

export const STRATEGY_CATALOG = {
  grid: {
    type: 'grid',
    name: '现货网格',
    icon: '▦',
    riskLevel: '中风险',
    description: '在设定价格区间内分层低买高卖，适合震荡行情。',
    fields: [
      { key: 'gridMode', label: '网格模式', type: 'select', default: 'arithmetic', options: [
        { value: 'arithmetic', label: '等差网格' }, { value: 'geometric', label: '等比网格' },
      ], help: '等差使用固定价差，等比使用固定百分比。' },
      { key: 'lowerPrice', label: '区间下限', type: 'number', unit: 'USDT', min: 0.00000001, max: 1_000_000_000, step: 'any', default: 50_000 },
      { key: 'upperPrice', label: '区间上限', type: 'number', unit: 'USDT', min: 0.00000001, max: 1_000_000_000, step: 'any', default: 100_000 },
      { key: 'gridCount', label: '网格数量', type: 'number', unit: '格', min: 2, max: 200, step: 1, integer: true, default: 20 },
      { key: 'totalInvestment', label: '计划投入', type: 'number', unit: 'USDT', min: 10, max: 10_000_000, step: 0.01, default: 1_000 },
      { key: 'stopLossPrice', label: '止损价格', type: 'number', unit: 'USDT', min: 0, max: 1_000_000_000, step: 'any', default: 45_000, help: '填 0 表示不设置，建议低于区间下限。' },
      { key: 'takeProfitPrice', label: '止盈价格', type: 'number', unit: 'USDT', min: 0, max: 1_000_000_000, step: 'any', default: 105_000, help: '填 0 表示不设置，建议高于区间上限。' },
    ],
  },
  martingale: {
    type: 'martingale',
    name: '马丁补仓',
    icon: 'M',
    riskLevel: '高风险',
    description: '价格回撤时按倍率分批补仓，严格受最大资金上限约束。',
    fields: [
      { key: 'initialOrderAmount', label: '首单金额', type: 'number', unit: 'USDT', min: 5, max: 1_000_000, step: 0.01, default: 20 },
      { key: 'safetyOrderAmount', label: '首笔安全单', type: 'number', unit: 'USDT', min: 5, max: 1_000_000, step: 0.01, default: 20 },
      { key: 'priceDeviationPercent', label: '首次回撤触发', type: 'number', unit: '%', min: 0.1, max: 50, step: 0.1, default: 2 },
      { key: 'volumeMultiplier', label: '补仓金额倍率', type: 'number', unit: '倍', min: 1, max: 5, step: 0.1, default: 1.5 },
      { key: 'stepMultiplier', label: '回撤间距倍率', type: 'number', unit: '倍', min: 1, max: 5, step: 0.1, default: 1.2 },
      { key: 'maxSafetyOrders', label: '最大补仓次数', type: 'number', unit: '次', min: 1, max: 12, step: 1, integer: true, default: 5 },
      { key: 'takeProfitPercent', label: '整体止盈', type: 'number', unit: '%', min: 0.1, max: 100, step: 0.1, default: 1.5 },
      { key: 'stopLossPercent', label: '整体止损', type: 'number', unit: '%', min: 0.1, max: 100, step: 0.1, default: 15 },
      { key: 'maxInvestment', label: '最大资金上限', type: 'number', unit: 'USDT', min: 10, max: 10_000_000, step: 0.01, default: 500 },
    ],
  },
  dca: {
    type: 'dca',
    name: '定期定投',
    icon: 'D',
    riskLevel: '中低风险',
    description: '按固定时间间隔分批买入，降低一次性择时影响。',
    fields: [
      { key: 'orderAmount', label: '每次投入', type: 'number', unit: 'USDT', min: 5, max: 1_000_000, step: 0.01, default: 50 },
      { key: 'intervalHours', label: '投入间隔', type: 'number', unit: '小时', min: 1, max: 8_760, step: 1, integer: true, default: 24 },
      { key: 'maxOrders', label: '最多执行次数', type: 'number', unit: '次', min: 1, max: 1_000, step: 1, integer: true, default: 12 },
      { key: 'takeProfitPercent', label: '组合止盈', type: 'number', unit: '%', min: 0.1, max: 500, step: 0.1, default: 10 },
      { key: 'stopLossPercent', label: '组合止损', type: 'number', unit: '%', min: 0.1, max: 100, step: 0.1, default: 20 },
      { key: 'maxInvestment', label: '最大资金上限', type: 'number', unit: 'USDT', min: 5, max: 10_000_000, step: 0.01, default: 1_000 },
    ],
  },
  maCrossover: {
    type: 'maCrossover',
    name: '双均线趋势',
    icon: '⌁',
    riskLevel: '中风险',
    description: '快线穿越慢线时生成趋势信号，适合单边行情观察。',
    fields: [
      { key: 'timeframe', label: 'K线周期', type: 'select', default: '1h', options: [
        { value: '15m', label: '15 分钟' }, { value: '1h', label: '1 小时' },
        { value: '4h', label: '4 小时' }, { value: '1d', label: '1 天' },
      ] },
      { key: 'fastPeriod', label: '快线周期', type: 'number', unit: '根', min: 2, max: 200, step: 1, integer: true, default: 9 },
      { key: 'slowPeriod', label: '慢线周期', type: 'number', unit: '根', min: 3, max: 500, step: 1, integer: true, default: 21 },
      { key: 'orderAmount', label: '单次信号资金', type: 'number', unit: 'USDT', min: 5, max: 1_000_000, step: 0.01, default: 100 },
      { key: 'maxPositions', label: '最大同时仓位', type: 'number', unit: '个', min: 1, max: 20, step: 1, integer: true, default: 1 },
      { key: 'takeProfitPercent', label: '单仓止盈', type: 'number', unit: '%', min: 0.1, max: 200, step: 0.1, default: 8 },
      { key: 'stopLossPercent', label: '单仓止损', type: 'number', unit: '%', min: 0.1, max: 100, step: 0.1, default: 4 },
      { key: 'maxInvestment', label: '最大资金上限', type: 'number', unit: 'USDT', min: 5, max: 10_000_000, step: 0.01, default: 100 },
    ],
  },
};

export const STRATEGY_SYMBOLS = SYMBOL_OPTIONS;

export class StrategyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StrategyValidationError';
    this.status = 400;
  }
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function normalizeField(field, value) {
  if (field.type === 'select') {
    const normalized = String(value ?? field.default);
    if (!field.options.some((option) => option.value === normalized)) {
      throw new StrategyValidationError(`${field.label}选项无效`);
    }
    return normalized;
  }
  const normalized = Number(value ?? field.default);
  if (!Number.isFinite(normalized)) throw new StrategyValidationError(`${field.label}必须是有效数字`);
  if (normalized < field.min || normalized > field.max) {
    throw new StrategyValidationError(`${field.label}必须在 ${field.min} 到 ${field.max} 之间`);
  }
  if (field.integer && !Number.isInteger(normalized)) {
    throw new StrategyValidationError(`${field.label}必须是整数`);
  }
  return normalized;
}

function estimateRisk(type, config) {
  const warnings = [];
  let estimatedMaxInvestment = 0;
  let metrics = [];
  if (type === 'grid') {
    estimatedMaxInvestment = config.totalInvestment;
    const perGrid = config.totalInvestment / config.gridCount;
    const spacing = config.gridMode === 'arithmetic'
      ? (config.upperPrice - config.lowerPrice) / config.gridCount
      : ((config.upperPrice / config.lowerPrice) ** (1 / config.gridCount) - 1) * 100;
    metrics = [
      { label: '单格资金', value: round(perGrid), unit: 'USDT' },
      { label: config.gridMode === 'arithmetic' ? '单格价差' : '单格间距', value: round(spacing, 4), unit: config.gridMode === 'arithmetic' ? 'USDT' : '%' },
    ];
    if (perGrid < 10) warnings.push('单格资金较小，后续执行时可能低于交易对最小名义价值。');
  }
  if (type === 'martingale') {
    let safetyTotal = 0;
    let currentOrder = config.safetyOrderAmount;
    for (let index = 0; index < config.maxSafetyOrders; index += 1) {
      safetyTotal += currentOrder;
      currentOrder *= config.volumeMultiplier;
    }
    estimatedMaxInvestment = config.initialOrderAmount + safetyTotal;
    const maxDeviation = config.priceDeviationPercent
      * Array.from({ length: config.maxSafetyOrders }, (_, index) => config.stepMultiplier ** index)
        .reduce((sum, value) => sum + value, 0);
    metrics = [
      { label: '预计最大占用', value: round(estimatedMaxInvestment), unit: 'USDT' },
      { label: '末级累计回撤', value: round(maxDeviation), unit: '%' },
    ];
    if (config.volumeMultiplier >= 2) warnings.push('补仓倍率达到 2 倍或以上，尾部资金占用增长很快。');
    if (config.maxSafetyOrders >= 8) warnings.push('补仓层级较多，需重点评估极端单边行情。');
  }
  if (type === 'dca') {
    estimatedMaxInvestment = config.orderAmount * config.maxOrders;
    metrics = [
      { label: '计划总投入', value: round(estimatedMaxInvestment), unit: 'USDT' },
      { label: '计划周期', value: round(config.intervalHours * config.maxOrders / 24, 1), unit: '天' },
    ];
  }
  if (type === 'maCrossover') {
    estimatedMaxInvestment = config.orderAmount * config.maxPositions;
    metrics = [
      { label: '最大仓位资金', value: round(estimatedMaxInvestment), unit: 'USDT' },
      { label: '均线组合', value: `${config.fastPeriod} / ${config.slowPeriod}`, unit: '根' },
    ];
  }
  return { estimatedMaxInvestment: round(estimatedMaxInvestment), metrics, warnings };
}

export function validateStrategyInput(input) {
  const type = String(input?.type || '');
  const definition = STRATEGY_CATALOG[type];
  if (!definition) throw new StrategyValidationError('策略类型无效');
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 40) throw new StrategyValidationError('策略名称需为 2 到 40 个字符');
  const symbol = String(input.symbol || '').trim().toUpperCase();
  if (!SYMBOL_OPTIONS.some((item) => item.value === symbol)) throw new StrategyValidationError('当前不支持该交易对');
  const config = Object.fromEntries(
    definition.fields.map((field) => [field.key, normalizeField(field, input.config?.[field.key])]),
  );

  if (type === 'grid') {
    if (config.lowerPrice >= config.upperPrice) throw new StrategyValidationError('网格区间下限必须低于上限');
    if (config.stopLossPrice > 0 && config.stopLossPrice >= config.lowerPrice) {
      throw new StrategyValidationError('网格止损价格应低于区间下限，或填写 0');
    }
    if (config.takeProfitPrice > 0 && config.takeProfitPrice <= config.upperPrice) {
      throw new StrategyValidationError('网格止盈价格应高于区间上限，或填写 0');
    }
  }
  if (type === 'maCrossover' && config.fastPeriod >= config.slowPeriod) {
    throw new StrategyValidationError('快线周期必须小于慢线周期');
  }
  const riskSummary = estimateRisk(type, config);
  if ('maxInvestment' in config && riskSummary.estimatedMaxInvestment > config.maxInvestment + 0.000001) {
    throw new StrategyValidationError(`预计最大资金占用 ${riskSummary.estimatedMaxInvestment} USDT，已超过资金上限`);
  }
  return {
    type,
    name,
    symbol,
    enabled: Boolean(input.enabled),
    config,
    riskSummary,
  };
}

export class StrategyStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeQueue = Promise.resolve();
  }

  async list() {
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return Array.isArray(payload) ? payload : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async get(id) {
    return (await this.list()).find((item) => item.id === id) || null;
  }

  async create(input) {
    return this.#mutate((items) => {
      const normalized = validateStrategyInput(input);
      const now = new Date().toISOString();
      const strategy = { id: crypto.randomUUID(), ...normalized, enabled: false, createdAt: now, updatedAt: now };
      items.unshift(strategy);
      return strategy;
    });
  }

  async update(id, input) {
    return this.#mutate((items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw Object.assign(new Error('策略不存在'), { status: 404 });
      const normalized = validateStrategyInput({ ...items[index], ...input, enabled: items[index].enabled });
      items[index] = { ...items[index], ...normalized, updatedAt: new Date().toISOString() };
      return items[index];
    });
  }

  async setEnabled(id, enabled) {
    return this.#mutate((items) => {
      const strategy = items.find((item) => item.id === id);
      if (!strategy) throw Object.assign(new Error('策略不存在'), { status: 404 });
      strategy.enabled = Boolean(enabled);
      strategy.updatedAt = new Date().toISOString();
      return strategy;
    });
  }

  async clone(id) {
    const source = await this.get(id);
    if (!source) throw Object.assign(new Error('策略不存在'), { status: 404 });
    return this.create({ ...source, name: `${source.name} 副本`, enabled: false });
  }

  async delete(id) {
    return this.#mutate((items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw Object.assign(new Error('策略不存在'), { status: 404 });
      const [removed] = items.splice(index, 1);
      return removed;
    });
  }

  async #mutate(mutator) {
    const operation = this.writeQueue.then(async () => {
      const items = await this.list();
      const result = mutator(items);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPath, this.filePath);
      return result;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}
