import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addUtcDays,
  advancePaperState,
  fetchPaperMarketData,
  initializePaperState,
  latestCompletePaperCycleDate,
  migratePaperStateToContinuousDeRisk,
  MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE,
  PaperPortfolioStore,
  paperPortfolioSnapshot,
  writePaperReportArtifacts,
} from '../src/monthly-accuracy-paper.js';
import { NewsService } from '../src/news-service.js';
import {
  buildPaperStrategyReview,
  PAPER_SHADOW_PROFILES,
  paperShadowStatePath,
  writePaperReviewArtifacts,
} from '../src/paper-strategy-review.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = path.join(rootDir, 'data', 'runtime', 'monthly-accuracy-paper.json');
const paperNewsDir = path.join(rootDir, 'data', 'runtime', 'paper-news-snapshots');
const NEWS_CAPTURE_RETRY_DELAYS_MS = Object.freeze([0, 2_000, 5_000]);

function paperNewsSnapshotPath(cycleDate) {
  return path.join(paperNewsDir, `${cycleDate}.json`);
}

async function readPaperNewsSnapshot(cycleDate) {
  return fs.readFile(paperNewsSnapshotPath(cycleDate), 'utf8')
    .then((text) => JSON.parse(text))
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
}

async function writePaperNewsSnapshot(cycleDate, news) {
  await fs.mkdir(paperNewsDir, { recursive: true });
  const target = paperNewsSnapshotPath(cycleDate);
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

async function writePaperNewsCaptureAudit(cycleDate, audit) {
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

function reportText(state, review) {
  const report = state.latestReport;
  const attribution = review?.latestAttribution;
  const candidateSummary = (review?.candidates || [])
    .map((candidate) => `${candidate.name} ${candidate.status} ${candidate.metrics?.observations || 0}天`)
    .join('；');
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
    ...(attribution ? [
      `复盘：横截面 ${signed(attribution.marketNeutral?.totalPnl)} USDT；趋势 ${signed(attribution.trend?.totalPnl)} USDT`,
      `最大拖累：${attribution.largestDetractor.symbol} ${signed(attribution.largestDetractor.totalPricePnl)} USDT`,
    ] : []),
    ...(candidateSummary ? [`影子策略：${candidateSummary}`] : []),
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
  newsFetchImpl = fetch,
  newsService = null,
  baseUrl,
  notify = false,
} = {}) {
  const latestCycleDate = latestCompletePaperCycleDate(now);
  const profiles = [MONTHLY_ACCURACY_CONTINUOUS_DERISK_PROFILE, ...PAPER_SHADOW_PROFILES];
  const stores = [
    new PaperPortfolioStore(stateFile),
    ...PAPER_SHADOW_PROFILES.map((profile) => (
      new PaperPortfolioStore(paperShadowStatePath(rootDir, profile.id))
    )),
  ];
  const existingStates = await Promise.all(stores.map((store) => store.read()));
  const pendingIndexes = existingStates
    .map((current, index) => ({ current, index }))
    .filter(({ current }) => !current || current.lastCycleDate < latestCycleDate);
  const newsSnapshotsByCycleDate = {};
  const pendingNewsIndexes = pendingIndexes.filter(({ index }) => (
    profiles[index]?.newsOverlay?.enabled
  ));
  if (pendingNewsIndexes.length) {
    for (const { current } of pendingNewsIndexes) {
      let cycleDate = current ? addUtcDays(current.lastCycleDate, 1) : latestCycleDate;
      while (cycleDate < latestCycleDate) {
        const stored = await readPaperNewsSnapshot(cycleDate);
        if (stored) newsSnapshotsByCycleDate[cycleDate] = stored;
        cycleDate = addUtcDays(cycleDate, 1);
      }
    }
    let latestNews = await readPaperNewsSnapshot(latestCycleDate);
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
      });
    }
    if (latestNews) newsSnapshotsByCycleDate[latestCycleDate] = latestNews;
  }
  let marketData = null;
  if (pendingIndexes.length) {
    const historyStartCycleDate = pendingIndexes
      .map(({ current }) => current?.startCycleDate || latestCycleDate)
      .sort()[0];
    const markStartCycleDate = pendingIndexes
      .map(({ current }) => current ? addUtcDays(current.lastCycleDate, 1) : latestCycleDate)
      .sort()[0];
    marketData = await fetchPaperMarketData({
      historyStartDate: addUtcDays(historyStartCycleDate, -220),
      signalEndDate: addUtcDays(latestCycleDate, -1),
      markStartCycleDate,
      markEndCycleDate: latestCycleDate,
      fetchImpl,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
  const states = await Promise.all(stores.map((store, index) => store.run((storedState) => {
    const current = index === 0 && storedState
      ? migratePaperStateToContinuousDeRisk(storedState, { now })
      : storedState;
    const profile = current?.profileSnapshot || profiles[index];
    if (current && !current.profileSnapshot) {
      current.profileSnapshot = JSON.parse(JSON.stringify(profile));
    }
    if (current && latestCycleDate <= current.lastCycleDate) return current;
    if (!marketData) throw new Error('模拟盘缺少待结算行情');
    if (!current) {
      if (profile.newsOverlay?.enabled && !newsSnapshotsByCycleDate[latestCycleDate]) {
        return current;
      }
      return initializePaperState({
        seriesBySymbol: marketData.seriesBySymbol,
        cycleDate: latestCycleDate,
        markPrices: marketData.markPricesByCycleDate[latestCycleDate],
        initialCapital,
        now,
        profile,
        newsSnapshot: profile.newsOverlay?.enabled
          ? newsSnapshotsByCycleDate[latestCycleDate] || null
          : null,
      });
    }
    return advancePaperState({
      state: current,
      seriesBySymbol: marketData.seriesBySymbol,
      markPricesByCycleDate: marketData.markPricesByCycleDate,
      throughCycleDate: latestCycleDate,
      now,
      profile,
      newsSnapshotsByCycleDate: profile.newsOverlay?.enabled
        ? newsSnapshotsByCycleDate
        : {},
    });
  })));
  const [state, ...shadowStates] = states;
  await writePaperReportArtifacts(rootDir, state);
  const review = buildPaperStrategyReview({ baselineState: state, shadowStates, now });
  await writePaperReviewArtifacts(rootDir, review);
  const text = reportText(state, review);
  console.log(text);
  if (notify) notifyWindows(text);
  return { ...paperPortfolioSnapshot(state), optimizationReview: review };
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
