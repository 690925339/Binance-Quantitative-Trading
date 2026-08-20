import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  addUtcDays,
  advancePaperState,
  MONTHLY_ACCURACY_PAPER_PROFILE,
  PAPER_SYMBOLS,
} from '../src/monthly-accuracy-paper.js';
import {
  loadPaperResearchReplayMarket,
  paperProfileWarmupDays,
  paperProfileWithCostMultiplier,
  paperResearchPeriodMetrics,
  replayPaperResearchProfile,
} from '../src/paper-research-replay.js';

function testProfile(id = 'paper-replay-test') {
  const profile = JSON.parse(JSON.stringify(MONTHLY_ACCURACY_PAPER_PROFILE));
  profile.id = id;
  profile.name = id;
  profile.marketNeutral.lookbackDays = 2;
  profile.marketNeutral.rebalanceDays = 2;
  profile.marketNeutral.monthlyProfitLock = 0.03;
  profile.trend.lookbackDays = [2, 3];
  profile.trend.volatilityWindowDays = 2;
  profile.trend.minimumTrendVotes = 2;
  profile.trend.minimumTrendStrength = 0;
  profile.trend.monthlyProfitLock = 0.03;
  return profile;
}

function utcDates(startDate, endDate) {
  const dates = [];
  for (let date = startDate; date <= endDate; date = addUtcDays(date, 1)) dates.push(date);
  return dates;
}

function fixtureClose(symbolIndex, dayIndex, hour) {
  const dailyGrowth = 1 + (symbolIndex - 2.5) * 0.0015;
  return Number((100 + symbolIndex * 15 + dayIndex * dailyGrowth + hour * 0.01).toFixed(6));
}

async function createMarketFixture({ missingBoundary = null } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-replay-'));
  const marketDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
  await fs.mkdir(marketDir, { recursive: true });
  const dates = utcDates('2022-12-20', '2023-02-01');
  const datasets = [];
  for (const [symbolIndex, symbol] of PAPER_SYMBOLS.entries()) {
    const file = `${symbol}-1h.csv`;
    const rows = ['open_time_utc,close'];
    dates.forEach((date, dayIndex) => {
      for (let hour = 0; hour < 24; hour += 1) {
        if (missingBoundary?.symbol === symbol
          && missingBoundary.date === date
          && missingBoundary.hour === hour) continue;
        rows.push(
          `${date}T${String(hour).padStart(2, '0')}:00:00.000Z,${fixtureClose(symbolIndex, dayIndex, hour)}`,
        );
      }
    });
    await fs.writeFile(path.join(marketDir, file), `${rows.join('\n')}\n`, 'utf8');
    datasets.push({ symbol, file, sha256: `fixture-${symbol}` });
  }
  await fs.writeFile(path.join(marketDir, 'manifest.json'), `${JSON.stringify({
    generatedAt: '2023-02-02T00:00:00.000Z',
    requestedStartTimeUtc: '2022-12-20T00:00:00.000Z',
    requestedEndTimeUtc: '2023-02-01T23:59:59.999Z',
    datasets,
  }, null, 2)}\n`, 'utf8');
  return { rootDir, dates };
}

test('执行时点行情加载严格映射23:59信号与00:59估值，并使用共同预热', async (t) => {
  const fixture = await createMarketFixture();
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));
  const profile = testProfile();
  const market = await loadPaperResearchReplayMarket({
    rootDir: fixture.rootDir,
    profiles: [profile],
    developmentStartDate: '2022-12-28',
    throughCycleDate: '2023-01-31',
  });

  assert.equal(paperProfileWarmupDays(profile), 3);
  assert.equal(market.commonWarmupDays, 3);
  assert.equal(market.initializationSignalDate, '2022-12-23');
  assert.equal(market.initializationCycleDate, '2022-12-24');
  assert.equal(market.signalEndDate, '2023-01-30');
  assert.equal(
    market.seriesBySymbol.BTCUSDT.find((item) => item.date === '2022-12-23').close,
    fixtureClose(0, 3, 23),
  );
  assert.equal(
    market.markPricesByCycleDate['2022-12-24'].BTCUSDT,
    fixtureClose(0, 4, 0),
  );
  assert.equal(market.seriesBySymbol.BTCUSDT.at(-1).date, '2023-01-30');
});

test('任一交易对缺少00:00或23:00边界K线时研究行情拒绝加载', async (t) => {
  const fixture = await createMarketFixture({
    missingBoundary: { symbol: 'DOGEUSDT', date: '2023-01-10', hour: 0 },
  });
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));
  await assert.rejects(
    loadPaperResearchReplayMarket({
      rootDir: fixture.rootDir,
      profiles: [testProfile()],
      developmentStartDate: '2022-12-28',
      throughCycleDate: '2023-01-31',
    }),
    /边界K线|不连续/,
  );
});

test('正式paper重放跨月连续承接状态，重复运行确定且2x成本使用fresh state', async (t) => {
  const fixture = await createMarketFixture();
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));
  const profile = testProfile('paper-replay-continuous');
  const stressedProfile = paperProfileWithCostMultiplier(profile, 2, '2x');
  const market = await loadPaperResearchReplayMarket({
    rootDir: fixture.rootDir,
    profiles: [profile, stressedProfile],
    developmentStartDate: '2022-12-28',
    throughCycleDate: '2023-01-31',
  });

  const full = replayPaperResearchProfile({ profile, market });
  const repeated = replayPaperResearchProfile({ profile, market });
  assert.deepEqual(
    full.reports.map((report) => [report.kind, report.cycleDate, report.dayReturn]),
    repeated.reports.map((report) => [report.kind, report.cycleDate, report.dayReturn]),
  );
  assert.equal(full.reports.filter((report) => report.kind === 'initialization').length, 1);

  let segmented = replayPaperResearchProfile({
    profile,
    market,
    throughCycleDate: '2022-12-31',
  });
  segmented = advancePaperState({
    state: segmented,
    seriesBySymbol: market.seriesBySymbol,
    markPricesByCycleDate: market.markPricesByCycleDate,
    throughCycleDate: '2023-01-31',
    now: Date.parse('2023-01-31T01:00:00.000Z'),
    profile,
  });
  assert.deepEqual(
    segmented.reports.map((report) => [report.kind, report.cycleDate, report.dayReturn]),
    full.reports.map((report) => [report.kind, report.cycleDate, report.dayReturn]),
  );

  assert.equal(stressedProfile.marketNeutral.tradingCostRate, profile.marketNeutral.tradingCostRate * 2);
  assert.equal(stressedProfile.trend.dailyCarryCostRate, profile.trend.dailyCarryCostRate * 2);
  assert.equal(stressedProfile.allocationTradingCostRate, profile.allocationTradingCostRate * 2);
  const stressed = replayPaperResearchProfile({ profile: stressedProfile, market });
  assert.notEqual(stressed.equity, full.equity);
  assert.equal(full.strategyProfileId, profile.id);
  assert.equal(stressed.strategyProfileId, stressedProfile.id);

  const january = paperResearchPeriodMetrics(full, {
    startDate: '2023-01-01',
    endDate: '2023-01-31',
  });
  assert.equal(january.observations, 31);
  assert.equal(january.dataCoverage, 1);
  assert.equal(january.monthCount, 1);
  assert.equal(january.monthly[0].month, '2023-01');
});

test('新闻策略没有逐时点快照时禁止历史重放', async (t) => {
  const fixture = await createMarketFixture();
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));
  const profile = testProfile('paper-replay-news');
  profile.newsOverlay = { enabled: true };
  const market = await loadPaperResearchReplayMarket({
    rootDir: fixture.rootDir,
    profiles: [profile],
    developmentStartDate: '2022-12-28',
    throughCycleDate: '2023-01-31',
  });
  assert.throws(
    () => replayPaperResearchProfile({ profile, market }),
    /必须提供逐时点新闻快照/,
  );
});
