import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { activePaperSnapshot } from '../worker/paper-scope.js';

test('模拟盘渲染仅显示BTC归因与日报，不显示旧组合和候选卡', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderPaperPortfolio('), source.indexOf('async function loadPaperPortfolio('));
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', classList: { toggle() {}, remove() {} } });
    return elements.get(id);
  };
  const paper = activePaperSnapshot({ status: 'running', equity: 10610.29, totalPnl: 610.29, totalReturn: .061,
    lastCycleDate: '2026-09-22', reports: [], positions: [], latestReport: { pricePnl: 45.25, dayPnl: 45.13, tradingCost: .08, carryCost: .04 } });
  const context = vm.createContext({ $: get, renderBtcPaperPortfolio() {}, renderPaperStatus: () => ({ running: true }),
    paperUpdatedText: () => '今日09:00', formatPnl: String, percentFormat: String, beijingTime: String,
    pnlClass: () => 'neutral', escapeHtml: String, paper });
  vm.runInContext(`${render}\nrenderPaperPortfolio(paper);`, context);
  assert.match(get('#paperEquity').textContent, /10,610.29/);
  assert.match(get('#paperAttribution').innerHTML, /BTC价格贡献/);
  assert.doesNotMatch(get('#paperAttribution').innerHTML, /横截面子策略|当前v3|shadow/);
  assert.equal(get('#paperCandidateList').innerHTML, '');
});
