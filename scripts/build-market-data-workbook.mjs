import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(rootDir, 'data', 'market', 'spot', '1h');
const outputDir = path.join(rootDir, 'outputs', '019f64e2-efb9-7bd0-9675-fbcae8bbb7d8');
const outputPath = path.join(outputDir, 'Binance主流币历史行情_2023至今.xlsx');

const colors = {
  ink: '#10211A',
  forest: '#113D2D',
  green: '#2E8B67',
  mint: '#DDF4E9',
  pale: '#F4F8F6',
  line: '#CAD9D2',
  white: '#FFFFFF',
  amber: '#FFF1CC',
  red: '#FDE2E2',
};

function aggregateDaily(csvText) {
  const lines = csvText.trim().split(/\r?\n/).slice(1);
  const days = new Map();
  for (const line of lines) {
    const columns = line.split(',');
    const day = columns[3].slice(0, 10);
    const current = days.get(day);
    const item = {
      date: new Date(`${day}T00:00:00.000Z`),
      open: Number(columns[4]),
      high: Number(columns[5]),
      low: Number(columns[6]),
      close: Number(columns[7]),
      volume: Number(columns[8]),
      quoteVolume: Number(columns[11]),
      trades: Number(columns[12]),
      bars: 1,
    };
    if (!current) {
      days.set(day, item);
      continue;
    }
    current.high = Math.max(current.high, item.high);
    current.low = Math.min(current.low, item.low);
    current.close = item.close;
    current.volume += item.volume;
    current.quoteVolume += item.quoteVolume;
    current.trades += item.trades;
    current.bars += 1;
  }
  return [...days.values()];
}

function formatTitle(sheet, range, title) {
  range.merge();
  range.values = [[title]];
  range.format = {
    fill: colors.forest,
    font: { bold: true, color: colors.white, size: 18 },
    verticalAlignment: 'center',
  };
  range.format.rowHeight = 34;
}

function formatHeader(range) {
  range.format = {
    fill: colors.green,
    font: { bold: true, color: colors.white },
    verticalAlignment: 'center',
    wrapText: true,
    borders: { preset: 'outside', style: 'thin', color: colors.forest },
  };
  range.format.rowHeight = 26;
}

function addDailySheet(workbook, symbol, rows) {
  const sheet = workbook.worksheets.add(symbol.replace('USDT', ''));
  sheet.showGridLines = false;
  formatTitle(sheet, sheet.getRange('A1:I1'), `${symbol} 日线汇总（由 1h K线聚合）`);
  sheet.getRange('A2:I2').values = [[
    '日期 UTC', '开盘价', '最高价', '最低价', '收盘价', '基础资产成交量', 'USDT 成交额', '成交笔数', '小时K线数',
  ]];
  formatHeader(sheet.getRange('A2:I2'));
  const matrix = rows.map((row) => [
    row.date, row.open, row.high, row.low, row.close, row.volume, row.quoteVolume, row.trades, row.bars,
  ]);
  if (matrix.length) sheet.getRangeByIndexes(2, 0, matrix.length, 9).values = matrix;
  const lastRow = matrix.length + 2;
  sheet.getRange(`A3:A${lastRow}`).format.numberFormat = 'yyyy-mm-dd';
  sheet.getRange(`B3:E${lastRow}`).format.numberFormat = '#,##0.00000000';
  sheet.getRange(`F3:G${lastRow}`).format.numberFormat = '#,##0.00';
  sheet.getRange(`H3:I${lastRow}`).format.numberFormat = '#,##0';
  sheet.getRange(`A3:I${lastRow}`).format.borders = {
    insideHorizontal: { style: 'thin', color: '#E5EDE9' },
  };
  sheet.getRange(`A3:I${lastRow}`).conditionalFormats.add('cellIs', {
    operator: 'lessThan', formula: 0, format: { font: { color: '#B42318' } },
  });
  const table = sheet.tables.add(`A2:I${lastRow}`, true, `${symbol}DailyTable`);
  table.style = 'TableStyleMedium4';
  sheet.freezePanes.freezeRows(2);
  sheet.getRange('A:A').format.columnWidth = 14;
  sheet.getRange('B:E').format.columnWidth = 15;
  sheet.getRange('F:G').format.columnWidth = 20;
  sheet.getRange('H:I').format.columnWidth = 14;
  return sheet;
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(dataDir, 'manifest.json'), 'utf8'));
  const workbook = Workbook.create();

  const summary = workbook.worksheets.add('数据概览');
  summary.showGridLines = false;
  formatTitle(summary, summary.getRange('A1:J1'), 'Binance 主流币历史行情数据集');
  summary.getRange('A3:B7').values = [
    ['数据用途', '量化策略研究、特征生成与回测'],
    ['市场', manifest.market],
    ['周期 / 时区', `${manifest.interval} / UTC`],
    ['覆盖范围', `${manifest.requestedStartTimeUtc} 至 ${manifest.requestedEndTimeUtc}`],
    ['原始数据目录', 'data/market/spot/1h/'],
  ];
  summary.getRange('A3:A7').format = { fill: colors.mint, font: { bold: true, color: colors.forest } };
  summary.getRange('B3:B7').format = { fill: colors.pale, wrapText: true };
  summary.getRange('A9:J9').values = [[
    '交易对', '周期', 'K线数量', '首根K线 UTC', '末根K线 UTC', '缺失', '重复', '非法OHLC', '状态', 'SHA-256',
  ]];
  formatHeader(summary.getRange('A9:J9'));
  const coverage = manifest.datasets.map((item) => [
    item.symbol,
    item.interval,
    item.rows,
    new Date(item.firstOpenTime),
    new Date(item.lastOpenTime),
    item.quality.gaps,
    item.quality.duplicates,
    item.quality.invalidOhlc,
    item.quality.gaps === 0 && item.quality.duplicates === 0 && item.quality.invalidOhlc === 0 ? 'OK' : 'REVIEW',
    item.sha256,
  ]);
  summary.getRangeByIndexes(9, 0, coverage.length, 10).values = coverage;
  const summaryLast = 9 + coverage.length;
  summary.getRange(`C10:C${summaryLast}`).format.numberFormat = '#,##0';
  summary.getRange(`D10:E${summaryLast}`).format.numberFormat = 'yyyy-mm-dd hh:mm';
  summary.getRange(`F10:H${summaryLast}`).format.numberFormat = '#,##0';
  summary.getRange(`A${summaryLast + 2}:B${summaryLast + 3}`).values = [
    ['总小时K线数', null],
    ['共同缺口', '2023-03-24 13:00 UTC（六个交易对均缺 1 根）'],
  ];
  summary.getRange(`B${summaryLast + 2}`).formulas = [[`=SUM(C10:C${summaryLast})`]];
  summary.getRange(`B${summaryLast + 2}`).format.numberFormat = '#,##0';
  summary.getRange(`A${summaryLast + 2}:A${summaryLast + 3}`).format = { fill: colors.mint, font: { bold: true, color: colors.forest } };
  summary.getRange(`B${summaryLast + 3}`).format = { fill: colors.amber, font: { color: '#7A4D00' }, wrapText: true };
  summary.getRange(`I10:I${summaryLast}`).conditionalFormats.add('containsText', {
    text: 'REVIEW', format: { fill: colors.amber, font: { bold: true, color: '#7A4D00' } },
  });
  summary.freezePanes.freezeRows(9);
  summary.getRange('A:A').format.columnWidth = 18;
  summary.getRange('B:B').format.columnWidth = 28;
  summary.getRange('C:C').format.columnWidth = 13;
  summary.getRange('D:E').format.columnWidth = 21;
  summary.getRange('F:I').format.columnWidth = 12;
  summary.getRange('J:J').format.columnWidth = 68;

  const quality = workbook.worksheets.add('质量检查');
  quality.showGridLines = false;
  formatTitle(quality, quality.getRange('A1:G1'), '数据质量检查');
  quality.getRange('A3:G3').values = [['交易对', '检查项', '实际值', '期望值', '状态', '影响', '处理建议']];
  formatHeader(quality.getRange('A3:G3'));
  const qualityRows = [];
  for (const item of manifest.datasets) {
    qualityRows.push(
      [item.symbol, '重复时间戳', item.quality.duplicates, 0, item.quality.duplicates === 0 ? 'OK' : 'FAIL', '重复信号/重复成交', '回测前去重'],
      [item.symbol, '非法 OHLC', item.quality.invalidOhlc, 0, item.quality.invalidOhlc === 0 ? 'OK' : 'FAIL', '指标与收益失真', '剔除并回查源数据'],
      [item.symbol, '非正价格', item.quality.nonPositivePrice, 0, item.quality.nonPositivePrice === 0 ? 'OK' : 'FAIL', '收益率计算异常', '剔除并回查源数据'],
      [item.symbol, '缺失小时K线', item.quality.gaps, 0, item.quality.gaps === 0 ? 'OK' : 'REVIEW', '指标窗口不连续', '跳过该窗口或显式保留缺失；禁止未来数据回填'],
    );
  }
  quality.getRangeByIndexes(3, 0, qualityRows.length, 7).values = qualityRows;
  const qualityLast = 3 + qualityRows.length;
  quality.getRange(`E4:E${qualityLast}`).conditionalFormats.add('containsText', {
    text: 'OK', format: { fill: colors.mint, font: { bold: true, color: colors.forest } },
  });
  quality.getRange(`E4:E${qualityLast}`).conditionalFormats.add('containsText', {
    text: 'REVIEW', format: { fill: colors.amber, font: { bold: true, color: '#7A4D00' } },
  });
  quality.getRange(`E4:E${qualityLast}`).conditionalFormats.add('containsText', {
    text: 'FAIL', format: { fill: colors.red, font: { bold: true, color: '#B42318' } },
  });
  quality.getRange(`A3:G${qualityLast}`).format.borders = {
    insideHorizontal: { style: 'thin', color: '#E5EDE9' },
  };
  quality.freezePanes.freezeRows(3);
  quality.getRange('A:B').format.columnWidth = 20;
  quality.getRange('C:E').format.columnWidth = 12;
  quality.getRange('F:F').format.columnWidth = 24;
  quality.getRange('G:G').format.columnWidth = 48;
  quality.getRange(`F4:G${qualityLast}`).format.wrapText = true;

  const sources = workbook.worksheets.add('数据源');
  sources.showGridLines = false;
  formatTitle(sources, sources.getRange('A1:D1'), '数据源与使用说明');
  sources.getRange('A3:D3').values = [['项目', '值', '来源 URL', '备注']];
  formatHeader(sources.getRange('A3:D3'));
  sources.getRange('A4:D8').values = [
    ['K线数据', 'Binance Spot /api/v3/klines', 'https://data-api.binance.vision/api/v3/klines', '公开市场数据，无需 API Key'],
    ['接口文档', 'Spot Kline/Candlestick', 'https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md', '单次最多 1000 根，按 open time 唯一识别'],
    ['公共数据说明', 'Binance Public Data', 'https://github.com/binance/binance-public-data', '字段定义与归档说明'],
    ['时区', 'UTC', '', '所有 open_time_utc / close_time_utc 均为 UTC'],
    ['回测防泄漏', '仅使用已收盘 K线', '', '生成信号时不能读取当前尚未收盘 K线的 close/high/low'],
  ];
  sources.getRange('A4:A8').format = { fill: colors.mint, font: { bold: true, color: colors.forest } };
  sources.getRange('A3:D8').format.wrapText = true;
  sources.getRange('A:A').format.columnWidth = 20;
  sources.getRange('B:B').format.columnWidth = 32;
  sources.getRange('C:C').format.columnWidth = 74;
  sources.getRange('D:D').format.columnWidth = 52;
  sources.freezePanes.freezeRows(3);

  for (const item of manifest.datasets) {
    const csv = await fs.readFile(path.join(dataDir, item.file), 'utf8');
    addDailySheet(workbook, item.symbol, aggregateDaily(csv));
  }

  await fs.mkdir(outputDir, { recursive: true });
  const inspection = await workbook.inspect({
    kind: 'table',
    range: `数据概览!A1:J${summaryLast + 3}`,
    include: 'values,formulas',
    tableMaxRows: 20,
    tableMaxCols: 10,
  });
  console.log(inspection.ndjson);
  const errors = await workbook.inspect({
    kind: 'match',
    searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
    options: { useRegex: true, maxResults: 100 },
    summary: 'final formula error scan',
  });
  console.log(errors.ndjson);
  const qaDir = path.join(outputDir, 'qa');
  await fs.mkdir(qaDir, { recursive: true });
  const previewSpecs = [
    ['数据概览', `A1:J${summaryLast + 3}`, '01-overview.png'],
    ['质量检查', `A1:G${qualityLast}`, '02-quality.png'],
    ['数据源', 'A1:D8', '03-sources.png'],
    ...manifest.datasets.map((item, index) => [
      item.symbol.replace('USDT', ''),
      'A1:I20',
      `${String(index + 4).padStart(2, '0')}-${item.symbol.toLowerCase()}.png`,
    ]),
  ];
  for (const [sheetName, range, fileName] of previewSpecs) {
    const preview = await workbook.render({ sheetName, range, scale: 1.1, format: 'png' });
    await fs.writeFile(path.join(qaDir, fileName), new Uint8Array(await preview.arrayBuffer()));
  }
  const xlsx = await SpreadsheetFile.exportXlsx(workbook);
  await xlsx.save(outputPath);
  console.log(`工作簿已生成：${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
