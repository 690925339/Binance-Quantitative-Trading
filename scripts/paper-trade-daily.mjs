import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addUtcDays,
  advancePaperState,
  fetchPaperMarketData,
  initializePaperState,
  latestCompletePaperCycleDate,
  PaperPortfolioStore,
  paperPortfolioSnapshot,
  writePaperReportArtifacts,
} from '../src/monthly-accuracy-paper.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = path.join(rootDir, 'data', 'runtime', 'monthly-accuracy-paper.json');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const [key, inlineValue] = item.slice(2).split('=', 2);
    if (inlineValue !== undefined) args[key] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[key] = argv[index + 1];
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function signed(value, digits = 2) {
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(digits)}`;
}

function reportText(state) {
  const report = state.latestReport;
  const lines = [
    report.kind === 'initialization'
      ? `模拟盘已于 ${report.cycleDate} 建立基线`
      : `模拟盘日报 ${report.cycleDate}`,
    `当日盈亏：${signed(report.dayPnl)} USDT（${signed(report.dayReturn * 100)}%）`,
    `当前净值：${Number(state.equity).toFixed(2)} USDT`,
    `累计盈亏：${signed(state.equity - state.initialCapital)} USDT（${signed((state.equity / state.initialCapital - 1) * 100)}%）`,
    `最大回撤：${(Number(state.maxDrawdown) * 100).toFixed(2)}%`,
    `当前模型总敞口：${(Number(state.modelGrossExposure) * 100).toFixed(2)}%`,
    `持仓：${state.positions.length
      ? state.positions.map((item) => `${item.symbol} ${item.side === 'LONG' ? '多' : '空'} ${Math.abs(item.weightPercent).toFixed(2)}%`).join('；')
      : '空仓'}`,
  ];
  return lines.join('\n');
}

function notifyWindows(message) {
  if (process.platform !== 'win32') return;
  const safeMessage = message.replaceAll("'", "''");
  const command = [
    '$shell = New-Object -ComObject Wscript.Shell',
    `[void]$shell.Popup('${safeMessage}', 30, 'QuantFlow 模拟盘日报', 64)`,
  ].join('; ');
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout: 45_000 },
  );
  if (result.error || result.status !== 0) {
    console.warn(`Windows 通知未显示：${result.error?.message || result.stderr || `退出码 ${result.status}`}`);
  }
}

export async function runPaperDaily({
  now = Date.now(),
  initialCapital = 10_000,
  fetchImpl = fetch,
  baseUrl,
  notify = false,
} = {}) {
  const latestCycleDate = latestCompletePaperCycleDate(now);
  const store = new PaperPortfolioStore(stateFile);
  const state = await store.run(async (current) => {
    if (current && latestCycleDate <= current.lastCycleDate) return current;
    const startCycleDate = current?.startCycleDate || latestCycleDate;
    const markStartCycleDate = current
      ? addUtcDays(current.lastCycleDate, 1)
      : latestCycleDate;
    const marketData = await fetchPaperMarketData({
      historyStartDate: addUtcDays(startCycleDate, -220),
      signalEndDate: addUtcDays(latestCycleDate, -1),
      markStartCycleDate,
      markEndCycleDate: latestCycleDate,
      fetchImpl,
      ...(baseUrl ? { baseUrl } : {}),
    });
    if (!current) {
      return initializePaperState({
        seriesBySymbol: marketData.seriesBySymbol,
        cycleDate: latestCycleDate,
        markPrices: marketData.markPricesByCycleDate[latestCycleDate],
        initialCapital,
        now,
      });
    }
    return advancePaperState({
      state: current,
      seriesBySymbol: marketData.seriesBySymbol,
      markPricesByCycleDate: marketData.markPricesByCycleDate,
      throughCycleDate: latestCycleDate,
      now,
    });
  });
  await writePaperReportArtifacts(rootDir, state);
  const text = reportText(state);
  console.log(text);
  if (notify) notifyWindows(text);
  return paperPortfolioSnapshot(state);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const initialCapital = Number(args['initial-capital'] || process.env.PAPER_INITIAL_CAPITAL || 10_000);
  runPaperDaily({
    initialCapital,
    notify: Boolean(args.notify),
  }).then((snapshot) => {
    if (args.json) console.log(JSON.stringify(snapshot, null, 2));
  }).catch((error) => {
    console.error(`模拟盘结算失败：${error.message}`);
    process.exitCode = 1;
  });
}
