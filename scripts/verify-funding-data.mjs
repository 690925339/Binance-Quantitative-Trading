import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(rootDir, 'data', 'market', 'funding');
const manifest = JSON.parse(await fs.readFile(path.join(dataDir, 'manifest.json'), 'utf8'));
let failed = false;

for (const dataset of manifest.datasets) {
  const content = await fs.readFile(path.join(dataDir, dataset.file), 'utf8');
  const [headerLine, ...rows] = content.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const timeIndex = headers.indexOf('funding_time');
  const rateIndex = headers.indexOf('funding_rate');
  const markIndex = headers.indexOf('mark_price');
  const times = rows.map((row) => Number(row.split(',')[timeIndex]));
  const valuesValid = rows.every((row) => {
    const columns = row.split(',');
    return Number.isFinite(Number(columns[timeIndex]))
      && Number.isFinite(Number(columns[rateIndex]))
      && Number(columns[markIndex]) > 0;
  });
  const checks = {
    rows: rows.length === dataset.rows,
    sourceAccounting: dataset.sourceRows === dataset.rows + dataset.unmatchedRows,
    duplicates: new Set(times).size === times.length && dataset.duplicateTimes === 0,
    chronological: times.every((time, index) => index === 0 || time > times[index - 1]),
    valuesValid,
    sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex') === dataset.sha256,
    utf8NoBom: content.charCodeAt(0) !== 0xFEFF,
  };
  const passed = Object.values(checks).every(Boolean);
  if (!passed) failed = true;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${dataset.symbol} | ${rows.length}/${dataset.sourceRows} 条 | ${JSON.stringify(checks)}`);
}

if (failed) process.exitCode = 1;
