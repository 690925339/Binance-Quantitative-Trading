import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGY_CATALOG, STRATEGY_SYMBOLS } from '../src/strategies.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const seedDir = path.join(distDir, 'seed');

async function copyIfPresent(source, target) {
  try {
    await fs.copyFile(source, target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(path.join(distDir, 'server'), { recursive: true });
await fs.mkdir(seedDir, { recursive: true });
await fs.cp(path.join(rootDir, 'public'), distDir, { recursive: true });
await fs.copyFile(path.join(rootDir, 'worker', 'index.js'), path.join(distDir, 'server', 'index.js'));
await fs.writeFile(
  path.join(seedDir, 'strategy-catalog.json'),
  `${JSON.stringify({ strategies: Object.values(STRATEGY_CATALOG), symbols: STRATEGY_SYMBOLS })}\n`,
  'utf8',
);
await copyIfPresent(
  path.join(rootDir, 'data', 'runtime', 'monthly-accuracy-paper.json'),
  path.join(seedDir, 'paper-portfolio.json'),
);
await copyIfPresent(
  path.join(rootDir, 'data', 'runtime', 'paper-review.json'),
  path.join(seedDir, 'paper-review.json'),
);
await copyIfPresent(
  path.join(rootDir, 'data', 'runtime', 'btc-single-asset-paper.json'),
  path.join(seedDir, 'btc-paper.json'),
);
console.log('Sites Worker artifact ready.');
