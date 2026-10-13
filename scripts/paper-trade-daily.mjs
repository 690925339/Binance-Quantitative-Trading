import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addUtcDays,
  fetchPaperMarketData,
  latestCompletePaperCycleDate,
  PaperPortfolioStore,
} from '../src/monthly-accuracy-paper.js';
import { NewsService } from '../src/news-service.js';
import { activePaperSnapshot } from '../worker/paper-scope.js';
import { buildBtcDailyTarget } from '../src/btc-daily-target.js';
import {
  advanceBtcPaperState,
  btcPaperSnapshot,
  btcPaperStatePath,
  BTC_SINGLE_ASSET_PAPER_PROFILE,
  BTC_NEWS_DATA_GUARD_PROFILE,
  queueBtcNewsDataGuard,
  initializeBtcPaperState,
  writeBtcPaperReportArtifacts,
} from '../src/btc-paper.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEWS_CAPTURE_RETRY_DELAYS_MS = Object.freeze([0, 2_000, 5_000]);

function paperNewsSnapshotPath(cycleDate, activeRoot = rootDir) {
  return path.join(activeRoot, 'data/runtime/paper-news-snapshots', `${cycleDate}.json`);
}

async function readPaperNewsSnapshot(cycleDate, activeRoot = rootDir) {
  return fs.readFile(paperNewsSnapshotPath(cycleDate, activeRoot), 'utf8')
    .then((text) => JSON.parse(text))
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
}

async function writePaperNewsSnapshot(cycleDate, news, activeRoot = rootDir) {
  const target = paperNewsSnapshotPath(cycleDate, activeRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  const snapshot = {
    ...news,
    paperCycleDate: cycleDate,
    capturedForDecisionAt: news.updatedAt,
  };
  await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
  return snapshot;
}

async function writePaperNewsCaptureAudit(cycleDate, audit, activeRoot = rootDir) {
  const paperNewsDir = path.join(activeRoot, 'data/runtime/paper-news-snapshots');
  await fs.mkdir(paperNewsDir, { recursive: true });
  const target = path.join(paperNewsDir, `${cycleDate}.capture.json`);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function paperNewsDecisionWindow(cycleDate) {
  const startsAt = Date.parse(`${cycleDate}T01:00:00.000Z`);
  if (!Number.isFinite(startsAt)) throw new Error(`无效新闻决策周期：${cycleDate}`);
  return { startsAt, endsAt: startsAt + 15 * 60_000 };
}

export function isTimelyPaperNews(news, cycleDate) {
  const capturedAt = Date.parse(news?.updatedAt || '');
  const window = paperNewsDecisionWindow(cycleDate);
  return news?.status === 'live'
    && Number.isFinite(capturedAt)
    && capturedAt >= window.startsAt
    && capturedAt <= window.endsAt;
}

export async function captureDecisionNewsSnapshot({
  cycleDate,
  newsService,
  retryDelaysMs = NEWS_CAPTURE_RETRY_DELAYS_MS,
  waitImpl = wait,
  writeSnapshot = writePaperNewsSnapshot,
  writeAudit = writePaperNewsCaptureAudit,
  now = Date.now(),
}) {
  const attempts = [];
  for (let index = 0; index < retryDelaysMs.length; index += 1) {
    const delayMs = Number(retryDelaysMs[index] || 0);
    if (delayMs > 0) await waitImpl(delayMs);
    try {
      const news = await newsService.getNews({ forceRefresh: index > 0 });
      const sourceStatus = news?.sourceStatus || [];
      const timely = isTimelyPaperNews(news, cycleDate);
      attempts.push({
        attempt: index + 1,
        requestedAt: new Date(Number(now)).toISOString(),
        status: news?.status || 'missing',
        updatedAt: news?.updatedAt || null,
        timely,
        sourceAvailability: {
          available: sourceStatus.filter((item) => item.ok).length,
          total: sourceStatus.length,
        },
      });
      if (timely) {
        const snapshot = await writeSnapshot(cycleDate, {
          ...news,
          captureAttemptCount: index + 1,
        });
        await writeAudit(cycleDate, {
          paperCycleDate: cycleDate,
          completedAt: new Date(Number(now)).toISOString(),
          success: true,
          attempts,
        });
        return snapshot;
      }
    } catch (error) {
      attempts.push({
        attempt: index + 1,
        requestedAt: new Date(Number(now)).toISOString(),
        status: 'error',
        updatedAt: null,
        timely: false,
        error: error.message,
      });
    }
  }
  await writeAudit(cycleDate, {
    paperCycleDate: cycleDate,
    completedAt: new Date(Number(now)).toISOString(),
    success: false,
    attempts,
  });
  return null;
}

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

export function reportText(state, dailyTarget = buildBtcDailyTarget(state)) {
  const report = state.latestReport;
  const lines = [
    report.kind === 'initialization'
      ? `BTC模拟盘已于 ${report.cycleDate} 建立基线`
      : `BTC模拟盘日报 ${report.cycleDate}`,
    `当日盈亏：${signed(report.dayPnl)} USDT（${signed(report.dayReturn * 100)}%）`,
    `当前净值：${Number(state.equity).toFixed(2)} USDT`,
    `累计盈亏：${signed(state.equity - state.initialCapital)} USDT（${signed((state.equity / state.initialCapital - 1) * 100)}%）`,
    `最大回撤：${(Number(state.maxDrawdown) * 100).toFixed(2)}%`,
    dailyTarget.account
      ? `净盈利日比例：${(dailyTarget.account.profitableDayRatio * 100).toFixed(2)}%（${dailyTarget.account.profitableDays}/${dailyTarget.account.expectedDays}个自然结算日；目标60%；空仓、持平计入分母${dailyTarget.account.dataComplete ? '' : `；缺失${dailyTarget.account.missingDays}日，暂不验收`}）`
      : '净盈利日比例：暂无完整结算日（目标60%；空仓、持平计入分母）',
    '保留年化10%目标；90天及3完整月仅供复核，不自动上线或增加杠杆。',
    `当前模型总敞口：${(Number(state.modelGrossExposure) * 100).toFixed(2)}%`,
    `持仓：${state.positions.length
      ? state.positions.map((item) => `${item.symbol} ${item.side === 'LONG' ? '多' : '空'} ${Math.abs(item.weightPercent).toFixed(2)}%`).join('；')
      : '空仓'}`,
    '仅BTC参与结算；组合盘及相关影子盘已停用。',
  ];
  return lines.join('\n');
}

export async function fetchBtcLivePrice({
  fetchImpl = fetch,
  baseUrl = 'https://data-api.binance.vision',
} = {}) {
  const response = await fetchImpl(`${baseUrl}/api/v3/ticker/price?symbol=BTCUSDT`, {
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  const price = Number(payload?.price);
  if (!response.ok || !Number.isFinite(price) || price <= 0) {
    throw new Error(`BTC实时价格返回异常：${response.status} ${payload?.msg || ''}`.trim());
  }
  return price;
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

export function pendingPaperNewsStates({ btcState, latestCycleDate }) {
  return !btcState || btcState.lastCycleDate < latestCycleDate ? [btcState || null] : [];
}

export async function runPaperDaily({
  rootDir: activeRoot = rootDir,
  now = Date.now(),
  initialCapital = 10_000,
  fetchImpl = fetch,
  newsFetchImpl = fetch,
  newsService = null,
  baseUrl,
  notify = false,
} = {}) {
  const latestCycleDate = latestCompletePaperCycleDate(now);
  const btcStore = new PaperPortfolioStore(btcPaperStatePath(activeRoot));
  const existingBtcState = await btcStore.read();
  const btcPending = !existingBtcState || existingBtcState.lastCycleDate < latestCycleDate;
  const newsSnapshotsByCycleDate = {};
  const pendingNewsStates = pendingPaperNewsStates({ btcState: existingBtcState, latestCycleDate });
  if (pendingNewsStates.length) {
    for (const current of pendingNewsStates) {
      let cycleDate = current ? addUtcDays(current.lastCycleDate, 1) : latestCycleDate;
      while (cycleDate < latestCycleDate) {
        const stored = await readPaperNewsSnapshot(cycleDate, activeRoot);
        if (stored) newsSnapshotsByCycleDate[cycleDate] = stored;
        cycleDate = addUtcDays(cycleDate, 1);
      }
    }
    let latestNews = await readPaperNewsSnapshot(latestCycleDate, activeRoot);
    const decisionWindow = paperNewsDecisionWindow(latestCycleDate);
    const timelyCapture = Number(now) >= decisionWindow.startsAt
      && Number(now) <= decisionWindow.endsAt;
    if ((!latestNews || !isTimelyPaperNews(latestNews, latestCycleDate)) && timelyCapture) {
      const activeNewsService = newsService || new NewsService({
        fetchImpl: newsFetchImpl,
        now: () => Number(now),
        cryptoPanicToken: process.env.CRYPTOPANIC_API_TOKEN || '',
        cryptoPanicPlan: process.env.CRYPTOPANIC_API_PLAN || 'growth',
      });
      latestNews = await captureDecisionNewsSnapshot({
        cycleDate: latestCycleDate,
        newsService: activeNewsService,
        now,
        writeSnapshot: (date, news) => writePaperNewsSnapshot(date, news, activeRoot),
        writeAudit: (date, audit) => writePaperNewsCaptureAudit(date, audit, activeRoot),
      });
    }
    if ((!latestNews || !isTimelyPaperNews(latestNews, latestCycleDate)) && !timelyCapture) {
      await writePaperNewsCaptureAudit(latestCycleDate, {
        paperCycleDate: latestCycleDate, completedAt: new Date(Number(now)).toISOString(),
        success: false, attempts: [], reason: 'outside_decision_window',
      }, activeRoot);
    }
    if (latestNews) newsSnapshotsByCycleDate[latestCycleDate] = latestNews;
  }
  let btcMarketData = null;
  const btcNewsSnapshotsByCycleDate = {};
  let btcEntryPrice = null;
  if (btcPending) {
    const btcMarkStartCycleDate = existingBtcState
      ? addUtcDays(existingBtcState.lastCycleDate, 1)
      : latestCycleDate;
    btcMarketData = await fetchPaperMarketData({
      historyStartDate: addUtcDays(existingBtcState?.startCycleDate || latestCycleDate, -220),
      signalEndDate: addUtcDays(latestCycleDate, -1),
      markStartCycleDate: btcMarkStartCycleDate,
      markEndCycleDate: latestCycleDate,
      fetchImpl,
      symbols: [BTC_SINGLE_ASSET_PAPER_PROFILE.symbol],
      ...(baseUrl ? { baseUrl } : {}),
    });
    for (let cycleDate = btcMarkStartCycleDate; cycleDate <= latestCycleDate; cycleDate = addUtcDays(cycleDate, 1)) {
      btcNewsSnapshotsByCycleDate[cycleDate] = newsSnapshotsByCycleDate[cycleDate]
        || await readPaperNewsSnapshot(cycleDate, activeRoot)
        || null;
    }
    if (!existingBtcState) {
      btcEntryPrice = await fetchBtcLivePrice({
        fetchImpl,
        ...(baseUrl ? { baseUrl } : {}),
      });
    }
  }
  const btcState = await btcStore.run((storedState) => {
    queueBtcNewsDataGuard(storedState, now);
    if (storedState && storedState.lastCycleDate >= latestCycleDate) return storedState;
    if (!btcMarketData) throw new Error('BTC模拟盘缺少待结算行情');
    if (!storedState) {
      return initializeBtcPaperState({
        seriesBySymbol: btcMarketData.seriesBySymbol,
        cycleDate: latestCycleDate,
        markPrice: btcEntryPrice,
        initialCapital,
        now,
        newsSnapshot: btcNewsSnapshotsByCycleDate[latestCycleDate],
        entryMode: 'live_mark',
        profile: BTC_NEWS_DATA_GUARD_PROFILE,
      });
    }
    return advanceBtcPaperState({
      state: storedState,
      seriesBySymbol: btcMarketData.seriesBySymbol,
      markPricesByCycleDate: btcMarketData.markPricesByCycleDate,
      throughCycleDate: latestCycleDate,
      now,
      newsSnapshotsByCycleDate: btcNewsSnapshotsByCycleDate,
    });
  });
  await writeBtcPaperReportArtifacts(activeRoot, btcState);
  const snapshot = activePaperSnapshot(btcPaperSnapshot(btcState));
  await fs.writeFile(path.join(activeRoot, 'data/runtime/btc-paper-review.json'), `${JSON.stringify(snapshot.optimizationReview, null, 2)}\n`, 'utf8');
  const dailyTarget = buildBtcDailyTarget(btcState);
  const targetFile = path.join(activeRoot, 'data/runtime/btc-daily-target.json');
  const temporaryTarget = `${targetFile}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryTarget, `${JSON.stringify(dailyTarget, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryTarget, targetFile);
  const text = reportText(btcState, dailyTarget);
  console.log(text);
  if (notify) notifyWindows(text);
  return snapshot;
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
