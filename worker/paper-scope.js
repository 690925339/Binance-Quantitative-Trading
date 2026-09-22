// Shared by the local runner, API and hosted Worker. No retired ledger is read.
export const ACTIVE_PAPER_SCOPE = 'btc_only';

export function buildBtcReview(btc) {
  const daily = (btc?.reports || []).filter(r => r.kind === 'daily');
  const recent = daily.slice(-30);
  const latest = btc?.latestReport;
  const count = predicate => recent.filter(predicate).length;
  const costs = recent.reduce((sum, r) => sum + Number(r.tradingCost || 0) + Number(r.carryCost || 0), 0);
  const labels = { fresh: '决策时点新闻缺失或过期', directionStrength: '方向强度不足',
    credibility: '可信度不足', confidence: '判断置信度不足', articles: 'BTC相关新闻不足',
    directionalEvidence: '缺少同方向官方确认或独立多源证据' };
  const news = btc?.newsRisk || latest?.newsRisk;
  return {
    scope: ACTIVE_PAPER_SCOPE, status: btc?.status || 'not_started', cycleDate: btc?.lastCycleDate || null,
    candidates: [],
    recent: { observations: recent.length, profitableDays: count(r => r.dayPnl > 0),
      lossDays: count(r => r.dayPnl < 0), flatDays: count(r => r.dayPnl === 0),
      directionalMisses: count(r => r.pricePnl < 0), costOnlyLosses: count(r => r.pricePnl >= 0 && r.dayPnl < 0),
      newsEligibleDays: count(r => r.newsRisk?.eligible), newsConflictDays: count(r => r.newsRisk?.conflict),
      newsMissingDays: count(r => !(r.newsRisk?.checks?.fresh ?? r.newsRisk?.signalFresh)),
      dataGuardDays: count(r => r.dataQualityRisk?.active),
      deRiskDays: count(r => r.profitDeRisk?.active), costs: Number(costs.toFixed(4)) },
    latestAttribution: latest ? { pricePnl: latest.pricePnl || 0, tradingCost: latest.tradingCost || 0,
      carryCost: latest.carryCost || 0, previousWeight: latest.previousWeight || 0,
      assetReturn: latest.assetReturn || 0 } : null,
    diagnostics: [
      '仅BTC单币账本参与净值、盈亏和日报；组合盘及其影子盘已停止结算，历史文件保留。',
      `近${recent.length}个结算日：亏损${count(r => r.dayPnl < 0)}天，其中方向错误${count(r => r.pricePnl < 0)}天、仅成本致亏${count(r => r.pricePnl >= 0 && r.dayPnl < 0)}天。`,
      news?.eligible ? (news.conflict ? 'BTC新闻与持仓冲突，已执行减仓。' : 'BTC新闻证据合格，目前未与持仓冲突。')
        : `新闻未参与调整：${(news?.failedChecks || []).map(key => labels[key] || key).join('、') || '缺少合格证据'}。`,
      '新闻可信度不等于交易胜率；缺失历史新闻不补造。收益和命中率不作保证。',
      btc?.pendingStrategyChange
        ? `新闻数据保护将于${btc.pendingStrategyChange.effectiveFromCycleDate}决策生效：新闻缺失或过期时不加仓、不新开仓，仍可减仓和平仓。`
        : btc?.strategyProfileId?.includes('v2-data-guard') ? '新闻数据保护已启用：缺失或过期时不增加风险，减仓和平仓正常执行。' : '当前沿用已冻结策略参数。',
    ],
  };
}

export function activePaperSnapshot(btc) {
  const active = btc || { status: 'not_started', reports: [], positions: [] };
  return { ...active, scope: ACTIVE_PAPER_SCOPE, activeSymbols: ['BTCUSDT'],
    retiredPortfoliosExcluded: true, btcPortfolio: active, optimizationReview: buildBtcReview(active) };
}
