import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const manifest = JSON.parse(await fs.readFile(path.join(dataDir, 'manifest.json'), 'utf8'));
let failed = false;

for (const dataset of manifest.datasets) {
  const content = await fs.readFile(path.join(dataDir, dataset.file), 'utf8');
  const lines = content.trimEnd().split(/\r?\n/);
  const first = lines[1]?.split(',');
  const last = lines.at(-1)?.split(',');
  const actual = {
    rows: lines.length - 1,
    firstOpenTime: Number(first?.[2]),
    lastOpenTime: Number(last?.[2]),
    sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    bom: content.charCodeAt(0) === 0xFEFF,
  };
  const checks = {
    rows: actual.rows === dataset.rows,
    firstOpenTime: actual.firstOpenTime === dataset.firstOpenTime,
    lastOpenTime: actual.lastOpenTime === dataset.lastOpenTime,
    sha256: actual.sha256 === dataset.sha256,
    utf8NoBom: !actual.bom,
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${dataset.symbol} | ${actual.rows} 行 | ${JSON.stringify(checks)}`);
}

if (failed) process.exitCode = 1;
