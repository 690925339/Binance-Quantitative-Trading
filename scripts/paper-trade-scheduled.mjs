import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestCompletePaperCycleDate, PaperPortfolioStore } from '../src/monthly-accuracy-paper.js';
import { runPaperDaily } from './paper-trade-daily.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function paperRunHealth(rootDir, now = Date.now()) {
  const cycleDate = latestCompletePaperCycleDate(now);
  const runtime = path.join(rootDir, 'data', 'runtime');
  const entries = [
    { file: 'btc-single-asset-paper.json' },
  ];
  const ledgers = await Promise.all(entries.map(async entry => {
    const state = await readJson(path.join(runtime, entry.file));
    return { file: entry.file, lastCycleDate: state?.lastCycleDate || null,
      pending: !state || state.lastCycleDate < cycleDate };
  }));
  const artifacts = await Promise.all(['btc-paper-reports/latest.json', 'btc-paper-review.json']
    .map(async file => ({ file, cycleDate: (await readJson(path.join(runtime, file)))?.cycleDate || null })));
  return { cycleDate, ledgers,
    pending: ledgers.filter(item => item.pending).map(item => item.file),
    staleArtifacts: artifacts.filter(item => !item.cycleDate || item.cycleDate < cycleDate).map(item => item.file) };
}

export async function runScheduledPaper({ rootDir = defaultRoot, now = Date.now(), notify = false,
  runImpl = runPaperDaily } = {}) {
  const runtime = path.join(rootDir, 'data', 'runtime');
  // Shared lock for the 09:00 task and the login/repetition recovery task.
  const store = new PaperPortfolioStore(path.join(runtime, 'paper-job-status.json'));
  let failure;
  const status = await store.run(async previous => {
    const checkedAt = new Date(now).toISOString();
    const cycleDate = latestCompletePaperCycleDate(now);
    const journal = path.join(runtime, 'paper-job-runs', `${cycleDate}.jsonl`);
    const record = async value => {
      await fs.mkdir(path.dirname(journal), { recursive: true });
      await fs.appendFile(journal, `${JSON.stringify(value)}\n`, 'utf8');
    };
    try {
      const before = await paperRunHealth(rootDir, now);
      if (!before.pending.length && !before.staleArtifacts.length) {
        return { ...previous, status: 'up_to_date', cycleDate, checkedAt, health: before };
      }
      await record({ status: 'started', cycleDate, checkedAt, pending: before.pending, staleArtifacts: before.staleArtifacts });
      await runImpl({ now, notify, rootDir });
      const after = await paperRunHealth(rootDir, now);
      if (after.pending.length || after.staleArtifacts.length) {
        throw new Error(`结算后仍有延迟：${[...after.pending, ...after.staleArtifacts].join(', ')}`);
      }
      const completedAt = new Date().toISOString();
      await record({ status: 'settled', cycleDate, checkedAt, completedAt });
      return { ...previous, status: 'settled', cycleDate, checkedAt, completedAt,
        lastSuccessAt: completedAt, health: after };
    } catch (error) {
      failure = error;
      const failedAt = new Date().toISOString();
      const lastFailure = { cycleDate, failedAt, message: error.message };
      await record({ status: 'failed', checkedAt, ...lastFailure });
      return { ...previous, status: 'failed', cycleDate, checkedAt, lastFailure };
    }
  });
  // Persist the failure before returning a non-zero exit for Task Scheduler retries.
  if (failure) throw failure;
  return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runScheduledPaper({ notify: process.argv.includes('--notify') })
    .then(status => console.log(JSON.stringify({ status: status.status, cycleDate: status.cycleDate, checkedAt: status.checkedAt })))
    .catch(error => { console.error(`模拟盘任务失败：${error.message}`); process.exitCode = 1; });
}
