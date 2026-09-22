import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaperDaily } from './paper-trade-daily.mjs';
import { runScheduledPaper } from './paper-trade-scheduled.mjs';
import { latestCompletePaperCycleDate } from '../src/monthly-accuracy-paper.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(rootDir, 'data/runtime');
const now = Date.now();
const btcFile = path.join(runtime, 'btc-single-asset-paper.json');
const oldBytes = await fs.readFile(btcFile);
const oldState = JSON.parse(oldBytes);
if (oldState.lastCycleDate !== latestCompletePaperCycleDate(now)) throw new Error('先完成当期BTC结算，再执行范围切换');
const archived = ['monthly-accuracy-paper.json', ...(await fs.readdir(path.join(runtime, 'paper-shadow')))
  .filter(name => name.endsWith('.json')).map(name => `paper-shadow/${name}`)];
const hashes = async () => Object.fromEntries(await Promise.all(archived.map(async file =>
  [file, crypto.createHash('sha256').update(await fs.readFile(path.join(runtime, file))).digest('hex')])));
const before = await hashes();
const backupDir = path.join(runtime, 'repair-backups', `btc-only-${new Date(now).toISOString().replaceAll(':', '-')}`);
await fs.mkdir(backupDir, { recursive: true });
await fs.copyFile(btcFile, path.join(backupDir, 'btc-single-asset-paper.json'));
const noNetwork = async () => { throw new Error('切换范围时不应再次获取已结算行情'); };
await runPaperDaily({ now, fetchImpl: noNetwork, newsFetchImpl: noNetwork });
const next = JSON.parse(await fs.readFile(btcFile, 'utf8'));
assert.equal(next.equity, oldState.equity);
assert.equal(next.weight, oldState.weight);
assert.deepEqual(next.reports, oldState.reports);
assert.deepEqual(await hashes(), before);
const health = await runScheduledPaper({ now, runImpl: noNetwork });
assert.equal(health.status, 'up_to_date');
const audit = { scope: 'btc_only', changedAt: new Date(now).toISOString(),
  retirementCycleDate: oldState.lastCycleDate, activeLedger: 'btc-single-asset-paper.json',
  archivedLedgerHashes: before, backupDir, historicalReportsUnchanged: true,
  equityUnchanged: true, pendingStrategyChange: next.pendingStrategyChange, health: health.health };
await fs.writeFile(path.join(runtime, 'paper-active-scope.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ archivedLedgersUnchanged: archived.length, btcEquity: next.equity,
  historicalReportsUnchanged: true, effectiveFromCycleDate: next.pendingStrategyChange?.effectiveFromCycleDate,
  health: health.status, backupDir }));
