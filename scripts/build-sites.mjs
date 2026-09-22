import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { btcPaperSnapshot } from '../src/btc-paper.js';
import { activePaperSnapshot } from '../worker/paper-scope.js';
import { STRATEGY_CATALOG, STRATEGY_SYMBOLS } from '../src/strategies.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const seedDir = path.join(distDir, 'seed');
const RUNTIME_SNAPSHOT_VERSION = 4;

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(path.join(distDir, 'server'), { recursive: true });
await fs.mkdir(seedDir, { recursive: true });
await fs.cp(path.join(rootDir, 'public'), distDir, { recursive: true });
await fs.copyFile(path.join(rootDir, 'worker', 'index.js'), path.join(distDir, 'server', 'index.js'));
await fs.copyFile(path.join(rootDir, 'worker', 'paper-scope.js'), path.join(distDir, 'server', 'paper-scope.js'));
await fs.writeFile(
  path.join(seedDir, 'strategy-catalog.json'),
  `${JSON.stringify({ strategies: Object.values(STRATEGY_CATALOG), symbols: STRATEGY_SYMBOLS })}\n`,
  'utf8',
);
const btcState = await readJsonIfPresent(
  path.join(rootDir, 'data', 'runtime', 'btc-single-asset-paper.json'),
);
const activeSnapshot = activePaperSnapshot(btcPaperSnapshot(btcState));
await writeJson(path.join(seedDir, 'paper-portfolio.json'), { ...activeSnapshot, runtimeSnapshotVersion: RUNTIME_SNAPSHOT_VERSION });
await writeJson(path.join(seedDir, 'paper-review.json'), activeSnapshot.optimizationReview);
if (btcState) {
  await writeJson(
    path.join(seedDir, 'btc-paper.json'),
    {
      ...btcPaperSnapshot(btcState),
      runtimeSnapshotVersion: RUNTIME_SNAPSHOT_VERSION,
    },
  );
}
console.log('Sites Worker artifact ready.');
