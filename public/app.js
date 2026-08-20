const state = {
  user: null,
  connected: false,
  market: null,
  currentPage: 'dashboard',
  strategyCatalog: null,
  strategies: [],
  news: null,
  compositeSignals: null,
  newsLoading: false,
  paper: null,
  paperLoading: false,
  editingStrategyId: null,
  toastTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.code === 'AUTH_REQUIRED') {
    window.location.replace(`/login.html?next=${encodeURIComponent(window.location.pathname)}`);
    throw new Error('登录状态已失效');
  }
  if (!response.ok) throw new Error(payload.error || '请求失败，请稍后重试');
  return payload;
}

async function loadAppSession() {
  const session = await api('/api/auth/session');
  if (!session.authenticated) {
    window.location.replace('/login.html?next=%2F');
    return false;
  }
  state.user = session.user;
  $('#currentUserName').textContent = session.user.displayName;
  $('#currentUserMeta').textContent = `${session.user.username} · ${session.user.role === 'admin' ? '管理员' : '普通用户'}`;
  $('#currentUserAvatar').textContent = session.user.displayName.slice(0, 1);
  $('#adminUserLink').classList.toggle('hidden', session.user.role !== 'admin');
  return true;
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function setButtonLoading(button, loading, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = loading;
  button.textContent = loading ? text : button.dataset.label;
}

function navigate(page) {
  state.currentPage = page;
  $$('.page').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $$('.bottom-nav button').forEach((item) => item.classList.toggle('active', item.dataset.target === page));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (page === 'assets' && state.connected) loadAssets();
  if (page === 'strategies') loadStrategies();
  if (page === 'news') loadNews();
  if (page === 'paper') loadPaperPortfolio();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function updateConnection(connected, hint = '') {
  state.connected = connected;
  $('#connectionButton').classList.toggle('connected', connected);
  $('#connectionText').textContent = connected ? (hint || '已连接') : '未连接';
  $('#disconnectButton').classList.toggle('hidden', !connected);
  $('#connectApiButton').textContent = connected ? '重新连接并验证' : '连接并验证';
}

function priceFormat(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  const digits = number >= 1000 ? 2 : number >= 1 ? 3 : 6;
  return number.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatPnl(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return `${number > 0 ? '+' : ''}${priceFormat(number)} USDT`;
}

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(number);
}

function movingAverage(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function updateSignal(candles) {
  const closes = candles.map((item) => Number(item.close));
  const ma5 = movingAverage(closes, 5);
  const ma20 = movingAverage(closes, 20);
  $('#ma5').textContent = priceFormat(ma5);
  $('#ma20').textContent = priceFormat(ma20);
  const signal = $('#signalBadge');
  if (!ma5 || !ma20) signal.textContent = '数据不足';
  else if (ma5 > ma20) signal.textContent = '偏多观察';
  else if (ma5 < ma20) signal.textContent = '偏空观察';
  else signal.textContent = '震荡观察';
}

function drawChart(candles) {
  const canvas = $('#priceChart');
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);

  const values = candles.map((item) => Number(item.close));
  const width = rect.width;
  const height = rect.height;
  const padding = { top: 16, right: 4, bottom: 13, left: 4 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const point = (value, index) => ({
    x: padding.left + (index / Math.max(1, values.length - 1)) * (width - padding.left - padding.right),
    y: padding.top + ((max - value) / range) * (height - padding.top - padding.bottom),
  });

  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(32, 201, 151, 0.22)');
  gradient.addColorStop(1, 'rgba(32, 201, 151, 0)');
  context.beginPath();
  values.forEach((value, index) => {
    const p = point(value, index);
    if (index === 0) context.moveTo(p.x, p.y);
    else context.lineTo(p.x, p.y);
  });
  const last = point(values.at(-1), values.length - 1);
  const first = point(values[0], 0);
  context.lineTo(last.x, height);
  context.lineTo(first.x, height);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  values.forEach((value, index) => {
    const p = point(value, index);
    if (index === 0) context.moveTo(p.x, p.y);
    else context.lineTo(p.x, p.y);
  });
  context.strokeStyle = '#20c997';
  context.lineWidth = 1.7;
  context.lineJoin = 'round';
  context.stroke();
  context.beginPath();
  context.arc(last.x, last.y, 3.2, 0, Math.PI * 2);
  context.fillStyle = '#20c997';
  context.fill();
}

async function loadMarket() {
  const symbol = $('#marketSymbol').value;
  $('#chartLoading').classList.remove('hidden');
  try {
    const data = await api(`/api/market?symbol=${encodeURIComponent(symbol)}`);
    state.market = data;
    $('#lastPrice').textContent = priceFormat(data.ticker.lastPrice);
    const change = Number(data.ticker.priceChangePercent);
    const changeElement = $('#priceChange');
    changeElement.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
    changeElement.className = `change ${change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral'}`;
    $('#highPrice').textContent = priceFormat(data.ticker.highPrice);
    $('#lowPrice').textContent = priceFormat(data.ticker.lowPrice);
    $('#quoteVolume').textContent = compactNumber(data.ticker.quoteVolume);
    drawChart(data.candles);
    updateSignal(data.candles);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#chartLoading').classList.add('hidden');
  }
}

async function loadSession() {
  try {
    const session = await api('/api/session');
    updateConnection(session.connected, session.apiKeyHint);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function loadAssets() {
  const button = $('#refreshAssets');
  setButtonLoading(button, true, '正在同步…');
  try {
    const account = await api('/api/account');
    $('#accountStatus').textContent = account.canTrade ? '可进行测试交易' : '只读或交易未启用';
    $('#accountType').textContent = `${account.accountType || 'SPOT'} · Binance Spot Testnet`;
    $('#assetList').innerHTML = account.balances.length
      ? account.balances.map((item) => `
        <div class="asset-row">
          <div class="asset-name"><i>${item.asset.slice(0, 2)}</i><div><strong>${item.asset}</strong><span>测试资产</span></div></div>
          <div class="asset-value"><strong>${compactNumber(Number(item.free) + Number(item.locked))}</strong><span>可用 ${compactNumber(item.free)}</span></div>
        </div>`).join('')
      : '<div class="empty-state"><span>◇</span><strong>暂无非零资产</strong><p>可前往测试网领取测试资产</p></div>';
  } catch (error) {
    if (error.message.includes('会话')) updateConnection(false);
    showToast(error.message, 'error');
  } finally {
    setButtonLoading(button, false);
  }
}

function relativeNewsTime(value) {
  if (!value) return '时间未知';
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function renderNews(news, compositeSignals) {
  const symbol = compositeSignals.symbol;
  const summary = compositeSignals.newsSummary;
  $('#newsUpdatedAt').textContent = news.status === 'live'
    ? `更新于 ${new Date(news.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : news.status === 'stale' ? '新闻源异常，显示缓存' : '新闻源暂不可用';
  $('#newsDirection').textContent = summary.label;
  $('#newsDirection').className = `news-direction ${summary.direction}`;
  $('#newsCredibility').textContent = `${summary.credibility}%`;
  $('#newsConfidence').textContent = `${summary.confidence}%`;
  $('#newsArticleCount').textContent = `${summary.confirmedArticleCount || 0} / ${summary.articleCount}`;

  $('#compositeSignalList').innerHTML = compositeSignals.strategies.map((strategy) => `
    <article class="composite-signal-card ${strategy.strategyType === 'stableComposite' ? 'stable' : 'aggressive'}">
      <header>
        <div><span>${strategy.strategyType === 'stableComposite' ? 'STABLE' : 'AGGRESSIVE'}</span><strong>${escapeHtml(strategy.strategyName)}</strong></div>
        <b class="signal-action ${strategy.action.toLowerCase()}">${escapeHtml(strategy.actionLabel)}</b>
      </header>
      <div class="signal-score-row"><span>综合方向分</span><strong>${strategy.combinedScore >= 0 ? '+' : ''}${(strategy.combinedScore * 100).toFixed(1)}</strong></div>
      <div class="signal-breakdown">
        <div><span>价格</span><strong>${(strategy.priceScore * 100).toFixed(1)}</strong><small>权重 ${strategy.appliedWeights.pricePercent}%</small></div>
        <div><span>新闻</span><strong>${strategy.newsEligible ? (strategy.newsScore * 100).toFixed(1) : '--'}</strong><small>${strategy.newsEligible ? `权重 ${strategy.appliedWeights.newsPercent}%` : '未通过门槛'}</small></div>
        <div><span>目标敞口</span><strong>${strategy.risk.targetGrossExposurePercent}%</strong><small>当前上限 ${strategy.risk.effectiveMaxGrossExposurePercent}%</small></div>
      </div>
      <p>新闻门槛：合格官方证据 ${strategy.newsGate.qualifiedConfirmedArticleCount} / ${strategy.newsGate.minimumConfirmedArticles} 条 · 可信度 ${strategy.newsGate.minimumCredibility}% · 方向置信度 ${strategy.newsGate.minimumConfidence}% · 最大杠杆 ${strategy.risk.maxLeverage}×</p>
      ${strategy.risk.accuracyLeverage ? `<p>90% 条件杠杆：${strategy.risk.accuracyLeverage.eligible ? '已启用' : '等待达标'} · 当前 ${strategy.risk.appliedLeverage.toFixed(2)}× · 滚动准确率 ${(strategy.risk.accuracyLeverage.accuracy * 100).toFixed(1)}% · 样本 ${strategy.risk.accuracyLeverage.settledSignalCount} / ${strategy.risk.accuracyLeverage.minimumSamples}</p>` : ''}
    </article>
  `).join('');

  let relevantItems = news.items.filter((item) => item.symbols.includes(symbol) || item.symbols.includes('MARKET'));
  if (!relevantItems.length) relevantItems = news.items;
  $('#newsList').innerHTML = relevantItems.length ? relevantItems.slice(0, 20).map((item) => `
    <a class="news-item ${item.sentiment}" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
      <div class="news-item-head">
        <span>${escapeHtml(item.source)}${item.sourceTier === 'official' ? ' · 官方源' : ''} · ${escapeHtml(relativeNewsTime(item.publishedAt))}</span>
        <b class="confirmation-badge ${escapeHtml(item.confirmationStatus)}">${escapeHtml(item.confirmationLabel)}</b>
      </div>
      <strong>${escapeHtml(item.title)}</strong>
      <footer>
        <span class="sentiment-badge">${escapeHtml(item.sentimentLabel)}</span>
        <span>可信度 ${escapeHtml(item.credibilityLabel)} · ${item.credibility}%</span>
        <span>证据强度 ${escapeHtml(item.evidenceStrengthLabel)}</span>
        <span>方向置信度 ${item.confidence}%</span>
        <span class="confirmation-reason">${escapeHtml(item.confirmationReason)}</span>
        <span class="assessment-reason">方向依据：${escapeHtml(item.directionReason)}</span>
        <span class="assessment-reason">可信依据：${escapeHtml(item.credibilityReason)}</span>
      </footer>
    </a>
  `).join('') : '<div class="empty-state news-empty"><span>⌁</span><strong>暂无可用新闻</strong><p>检查网络或配置 CryptoPanic API Token</p></div>';
}

async function loadNews() {
  if (state.newsLoading || !$('#newsSymbol')) return;
  state.newsLoading = true;
  $('#newsRefreshState').textContent = '正在刷新…';
  const symbol = $('#newsSymbol').value;
  try {
    const [news, compositeSignals] = await Promise.all([
      api('/api/news'),
      api(`/api/composite-signals?symbol=${encodeURIComponent(symbol)}`),
    ]);
    state.news = news;
    state.compositeSignals = compositeSignals;
    renderNews(news, compositeSignals);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.newsLoading = false;
    $('#newsRefreshState').textContent = '每 60 秒刷新';
  }
}

function percentFormat(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return `${number > 0 ? '+' : ''}${(number * 100).toFixed(digits)}%`;
}

function pnlClass(value) {
  const number = Number(value);
  return number > 0 ? 'positive' : number < 0 ? 'negative' : 'neutral';
}

function beijingTime(value, options = {}) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...options,
  }).format(new Date(value));
}

function paperCandidateStatus(status) {
  return {
    not_started: '尚未启动',
    collecting: '采样中',
    reviewable: '可诊断',
    promotable: '待人工晋级复核',
    reject: '停止晋级',
  }[status] || status || '--';
}

function renderPaperPortfolio(paper) {
  const running = paper.status === 'running';
  $('#paperStatus').textContent = running ? '模拟运行中' : '尚未启动';
  $('#paperStatus').classList.toggle('running', running);
  if (!running) {
    $('#paperEquity').textContent = '--';
    $('#paperDayPnl').textContent = '等待首次启动';
    $('#paperTotalPnl').textContent = '--';
    $('#paperDrawdown').textContent = '--';
    $('#paperGross').textContent = '--';
    $('#paperNextReport').textContent = '--';
    $('#paperReviewCycle').textContent = '--';
    $('#paperAttribution').innerHTML = '<div class="empty-state"><span>△</span><strong>等待首个完整日报</strong><p>结算后会拆分币种、子策略与成本贡献</p></div>';
    $('#paperCandidateList').innerHTML = '';
    $('#paperPositionList').innerHTML = '<div class="empty-state"><span>◎</span><strong>模拟盘尚未启动</strong><p>运行每日纸面盘任务后将在这里显示持仓和盈亏</p></div>';
    $('#paperReportList').innerHTML = '<div class="empty-state"><span>◇</span><strong>暂无日报</strong><p>首次启动只建立基线</p></div>';
    return;
  }

  const latest = paper.latestReport;
  $('#paperUpdatedAt').textContent = `结算于 ${beijingTime(latest?.reportedAt || paper.updatedAt)}`;
  $('#paperEquity').textContent = `${Number(paper.equity).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
  $('#paperDayPnl').textContent = `当日 ${formatPnl(latest?.dayPnl)} · ${percentFormat(latest?.dayReturn)}`;
  $('#paperDayPnl').className = `paper-day-pnl ${pnlClass(latest?.dayPnl)}`;
  $('#paperTotalPnl').textContent = `${formatPnl(paper.totalPnl)} · ${percentFormat(paper.totalReturn)}`;
  $('#paperTotalPnl').className = pnlClass(paper.totalPnl);
  $('#paperDrawdown').textContent = percentFormat(paper.maxDrawdown);
  $('#paperGross').textContent = percentFormat(paper.modelGrossExposure);
  $('#paperNextReport').textContent = beijingTime(paper.nextReportAt);

  const review = paper.optimizationReview;
  const attribution = review?.latestAttribution;
  $('#paperReviewCycle').textContent = review?.cycleDate || '--';
  $('#paperAttribution').innerHTML = attribution ? `
    <div class="paper-attribution-summary">
      <div><span>横截面子策略</span><b class="${pnlClass(attribution.marketNeutral?.totalPnl)}">${formatPnl(attribution.marketNeutral?.totalPnl)}</b></div>
      <div><span>趋势子策略</span><b class="${pnlClass(attribution.trend?.totalPnl)}">${formatPnl(attribution.trend?.totalPnl)}</b></div>
      <div><span>最大拖累</span><b class="negative">${escapeHtml(attribution.largestDetractor.symbol)} ${formatPnl(attribution.largestDetractor.totalPricePnl)}</b></div>
      <div><span>最大贡献</span><b class="positive">${escapeHtml(attribution.largestContributor.symbol)} ${formatPnl(attribution.largestContributor.totalPricePnl)}</b></div>
      <div><span>多空价差变化</span><b class="${pnlClass(attribution.marketNeutralSpreadMove)}">${percentFormat(attribution.marketNeutralSpreadMove)}</b></div>
      <div><span>成本占绝对盈亏</span><b>${percentFormat(attribution.costShareOfAbsolutePnl)}</b></div>
    </div>
    <ul>${attribution.diagnostics.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
  ` : '<div class="empty-state"><span>△</span><strong>等待首个完整日报</strong><p>首日只建仓，次日开始生成归因</p></div>';
  $('#paperCandidateList').innerHTML = (review?.candidates || []).map((candidate) => {
    const metrics = candidate.metrics;
    const newsOverlay = candidate.profile?.newsOverlay;
    const newsDecision = candidate.latestNewsDecision;
    const newsNote = newsOverlay ? `
      <p class="paper-candidate-news">新闻目标权重 ${escapeHtml(newsOverlay.newsSignalWeight)}% · ${newsDecision
        ? newsDecision.fallbackToPriceOnly
          ? `当前退回价格信号：${escapeHtml(newsDecision.fallbackReason)}`
          : `当前应用于 ${escapeHtml(newsDecision.eligibleSymbols.map((item) => item.symbol).join('、'))}`
        : '等待首个09:00新闻快照'}</p>
    ` : '';
    return `
      <article class="paper-candidate-card ${escapeHtml(candidate.status)}">
        <header><div><strong>${escapeHtml(candidate.name)}</strong><span>${escapeHtml(candidate.hypothesis)}</span></div><b>${escapeHtml(paperCandidateStatus(candidate.status))}</b></header>
        <div class="paper-candidate-metrics">
          <span>共同样本 <strong>${metrics?.observations || 0} / 90天</strong></span>
          <span>完整月份 <strong>${metrics?.fullMonthCount || 0} / 3</strong></span>
          <span>相对基准 <strong class="${pnlClass(metrics?.pairedExcessReturn)}">${metrics?.pairedExcessReturn !== null && metrics?.pairedExcessReturn !== undefined ? percentFormat(metrics.pairedExcessReturn) : '--'}</strong></span>
          <span>最大回撤 <strong>${metrics ? percentFormat(metrics.maxDrawdown) : '--'}</strong></span>
        </div>
        ${newsNote}
        <p>${escapeHtml(candidate.statusReason)}</p>
      </article>
    `;
  }).join('') || '<div class="empty-state"><span>◇</span><strong>影子候选尚未建立</strong><p>每日任务会自动创建并持续观察</p></div>';

  const profitLocksDisabled = paper.monthlyProfitLockEnabled?.marketNeutral === false
    && paper.monthlyProfitLockEnabled?.trend === false;
  const flatPositionNote = paper.pendingStrategyChange
    ? `${paper.pendingStrategyChange.continuousTrading ? '持续交易降风险修复' : '策略变更'}将在 ${escapeHtml(paper.pendingStrategyChange.effectiveFromCycleDate)} 09:00 生效并重算仓位`
    : profitLocksDisabled
      ? '盈利锁已关闭；等待最新信号形成仓位，亏损风控仍保留'
      : '可能已触发月度锁定';
  $('#paperPositionList').innerHTML = paper.positions.length ? paper.positions.map((position) => `
    <article class="card paper-position-card ${position.side.toLowerCase()}">
      <header>
        <div><strong>${escapeHtml(position.symbol)}</strong><span>${position.side === 'LONG' ? '模拟多仓' : '模拟空仓'}</span></div>
        <b>${position.weightPercent > 0 ? '+' : ''}${Number(position.weightPercent).toFixed(2)}%</b>
      </header>
      <div>
        <span>目标名义金额 <strong>${Math.abs(Number(position.notional)).toFixed(2)} USDT</strong></span>
        <span>模拟数量 <strong>${Math.abs(Number(position.quantity)).toFixed(8)}</strong></span>
        <span>09:00估值价 <strong>${priceFormat(position.markPrice)}</strong></span>
      </div>
    </article>
  `).join('') : `<div class="empty-state"><span>◎</span><strong>当前为空仓</strong><p>${flatPositionNote}</p></div>`;

  const reports = (paper.reports || []).slice(-7).reverse();
  $('#paperReportList').innerHTML = reports.length ? reports.map((report) => `
    <article class="card paper-report-card">
      <header><strong>${escapeHtml(report.cycleDate)}</strong><span>${report.kind === 'initialization' ? '建仓基线' : '09:00日报'}</span></header>
      <div>
        <b class="${pnlClass(report.dayPnl)}">${formatPnl(report.dayPnl)}</b>
        <span>${percentFormat(report.dayReturn)}</span>
      </div>
      <footer>
        <span>价格 ${formatPnl(report.pricePnl)}</span>
        <span>交易成本 ${Number(report.tradingCost || 0).toFixed(2)} USDT</span>
        <span>持仓成本 ${Number(report.carryCost || 0).toFixed(2)} USDT</span>
      </footer>
    </article>
  `).join('') : '<div class="empty-state"><span>◇</span><strong>暂无日报</strong><p>下一次09:00结算后生成</p></div>';
}

async function loadPaperPortfolio() {
  if (state.paperLoading || !$('#paperPage')) return;
  state.paperLoading = true;
  const button = $('#refreshPaper');
  if (button) setButtonLoading(button, true, '刷新中…');
  try {
    state.paper = await api('/api/paper-portfolio');
    renderPaperPortfolio(state.paper);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.paperLoading = false;
    if (button) setButtonLoading(button, false);
  }
}

function strategyDefinition(type) {
  return state.strategyCatalog?.strategies.find((item) => item.type === type) || null;
}

function renderStrategyTemplates() {
  const container = $('#strategyTemplates');
  if (!state.strategyCatalog) return;
  container.innerHTML = state.strategyCatalog.strategies.map((definition) => `
    <button class="template-card" type="button" data-create-strategy="${escapeHtml(definition.type)}">
      <span class="template-icon">${escapeHtml(definition.icon)}</span>
      <strong>${escapeHtml(definition.name)}</strong>
      <p>${escapeHtml(definition.description)}</p>
      <footer><span>${escapeHtml(definition.riskLevel)}</span><b>＋</b></footer>
    </button>
  `).join('');
}

function renderStrategyList() {
  $('#strategyCount').textContent = String(state.strategies.length);
  $('#enabledStrategyCount').textContent = String(state.strategies.filter((item) => item.enabled).length);
  const container = $('#strategyList');
  if (!state.strategies.length) {
    container.innerHTML = '<div class="empty-state strategy-empty"><span>＋</span><strong>还没有策略配置</strong><p>从上方模板创建第一套参数</p></div>';
    return;
  }
  container.innerHTML = state.strategies.map((strategy) => {
    const definition = strategyDefinition(strategy.type) || { name: strategy.type, icon: 'S', riskLevel: '' };
    const metrics = (strategy.riskSummary?.metrics || []).slice(0, 3);
    const warning = strategy.riskSummary?.warnings?.[0];
    const marketLabel = definition.portfolio ? `${definition.universe?.length || 0} 币组合` : strategy.symbol;
    return `
      <article class="configured-card">
        <header class="configured-card-head">
          <span class="template-icon">${escapeHtml(definition.icon)}</span>
          <div class="configured-main">
            <strong>${escapeHtml(strategy.name)}</strong>
            <p>${escapeHtml(marketLabel)} · ${escapeHtml(definition.name)} · ${escapeHtml(definition.riskLevel)}</p>
          </div>
          <button class="observation-switch ${strategy.enabled ? 'on' : ''}" type="button" data-strategy-action="toggle" data-strategy-id="${strategy.id}">${strategy.enabled ? '观察中' : '已停用'}</button>
        </header>
        <div class="configured-metrics">
          ${metrics.map((metric) => `<div><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)} ${escapeHtml(metric.unit)}</strong></div>`).join('')}
        </div>
        ${warning ? `<p class="configured-warning">! ${escapeHtml(warning)}</p>` : ''}
        <footer class="configured-actions">
          <button type="button" data-strategy-action="edit" data-strategy-id="${strategy.id}">编辑参数</button>
          <button type="button" data-strategy-action="clone" data-strategy-id="${strategy.id}">复制</button>
          <button type="button" data-strategy-action="delete" data-strategy-id="${strategy.id}">删除</button>
        </footer>
      </article>
    `;
  }).join('');
}

async function loadStrategies() {
  try {
    const requests = [api('/api/strategies')];
    if (!state.strategyCatalog) requests.push(api('/api/strategies/catalog'));
    const [strategyPayload, catalogPayload] = await Promise.all(requests);
    if (catalogPayload) state.strategyCatalog = catalogPayload;
    state.strategies = strategyPayload.strategies || [];
    renderStrategyTemplates();
    renderStrategyList();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderStrategyFields(definition, config = {}) {
  $('#strategyFields').innerHTML = definition.fields.map((field) => {
    const value = config[field.key] ?? field.default;
    const label = `<span>${escapeHtml(field.label)}${field.unit ? `<b>${escapeHtml(field.unit)}</b>` : ''}</span>`;
    const control = field.type === 'select'
      ? `<select data-config-key="${escapeHtml(field.key)}">${field.options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`
      : `<input data-config-key="${escapeHtml(field.key)}" type="number" inputmode="decimal" min="${field.min}" max="${field.max}" step="${field.step}" value="${escapeHtml(value)}">`;
    return `<label>${label}${control}${field.help ? `<small class="field-help">${escapeHtml(field.help)}</small>` : ''}</label>`;
  }).join('');
}

function collectStrategyConfig() {
  const definition = strategyDefinition($('#strategyType').value);
  if (!definition) return {};
  return Object.fromEntries(definition.fields.map((field) => {
    const element = $(`[data-config-key="${field.key}"]`);
    return [field.key, field.type === 'number' ? Number(element.value) : element.value];
  }));
}

function localRiskPreview(type, config) {
  let metrics = [];
  let warning = '保存后由服务端执行完整参数校验。';
  if (type === 'grid') {
    const perGrid = config.totalInvestment / config.gridCount;
    const interval = config.gridMode === 'geometric'
      ? ((config.upperPrice / config.lowerPrice) ** (1 / config.gridCount) - 1) * 100
      : (config.upperPrice - config.lowerPrice) / config.gridCount;
    metrics = [
      { label: '单格资金', value: perGrid, unit: 'USDT' },
      { label: config.gridMode === 'geometric' ? '单格间距' : '单格价差', value: interval, unit: config.gridMode === 'geometric' ? '%' : 'USDT' },
    ];
    if (perGrid < 10) warning = '单格资金较小，执行前还需根据交易对过滤器检查最小名义价值。';
  }
  if (type === 'martingale') {
    let total = config.initialOrderAmount;
    let order = config.safetyOrderAmount;
    for (let index = 0; index < config.maxSafetyOrders; index += 1) { total += order; order *= config.volumeMultiplier; }
    metrics = [
      { label: '预计最大占用', value: total, unit: 'USDT' },
      { label: '资金上限', value: config.maxInvestment, unit: 'USDT' },
    ];
    warning = total > config.maxInvestment ? '当前参数会超过最大资金上限，无法保存。' : '马丁策略在单边下跌中可能快速占满资金上限。';
  }
  if (type === 'dca') {
    metrics = [
      { label: '计划总投入', value: config.orderAmount * config.maxOrders, unit: 'USDT' },
      { label: '计划周期', value: config.intervalHours * config.maxOrders / 24, unit: '天' },
    ];
  }
  if (type === 'maCrossover') {
    metrics = [
      { label: '最大仓位资金', value: config.orderAmount * config.maxPositions, unit: 'USDT' },
      { label: '均线组合', value: `${config.fastPeriod} / ${config.slowPeriod}`, unit: '根' },
    ];
    if (config.fastPeriod >= config.slowPeriod) warning = '快线周期必须小于慢线周期。';
  }
  if (['longShortTrend', 'longShortEnhanced', 'longShortHighReturn'].includes(type)) {
    metrics = [
      { label: '交易组合', value: 'BTC / ETH / BNB / SOL / XRP / DOGE', unit: '' },
      { label: '交易方向', value: config.positionMode === 'both' ? '多空双向' : config.positionMode === 'longOnly' ? '仅做多' : '仅做空', unit: '' },
      { label: '目标年化波动', value: config.targetVolatilityPercent, unit: '%' },
      { label: '最大总敞口', value: config.maxGrossExposurePercent, unit: '%' },
    ];
    if (!(config.shortLookbackDays < config.mediumLookbackDays && config.mediumLookbackDays < config.longLookbackDays)) {
      warning = '回看周期必须满足短周期 < 中周期 < 长周期。';
    } else if (config.maxAssetExposurePercent > config.maxGrossExposurePercent) {
      warning = '单币最大敞口不能超过组合最大总敞口。';
    } else {
      warning = type === 'longShortHighReturn'
        ? '高收益档当前长期年化回测为 10.51%，但最大回撤为 -27.91%；未来收益不保证超过 10%，当前仍不会自动下单。'
        : type === 'longShortEnhanced'
          ? '收益增强档历史最大回撤为 -21.68%；收益来自放大风险预算，当前仍只保存配置和风险摘要。'
          : '该策略需要 USDⓈ-M 合约执行器；当前仅保存配置和生成风险摘要。';
    }
  }
  if (type === 'monthlyAccuracyPortfolio') {
    metrics = [
      { label: '市场中性 / 趋势权重', value: `${config.marketNeutralWeightPercent} / ${config.trendWeightPercent}`, unit: '%' },
      { label: '相对强弱 / 调仓', value: `${config.relativeMomentumLookbackDays} / ${config.rebalanceDays}`, unit: '天' },
      { label: '中性基础 / 组合上限', value: `${config.marketNeutralBaseGrossExposurePercent} / ${config.maxGrossExposurePercent}`, unit: '%' },
      { label: '月度盈利锁定', value: config.monthlyProfitLockPercent, unit: '%' },
      { label: '冻结验证', value: '16 / 18 盈利月', unit: '' },
      { label: '验证期年化 / 回撤', value: '11.48 / -11.30', unit: '%' },
      { label: '2023 至今', value: '37 / 42 盈利月', unit: '' },
      { label: '长期年化 / 回撤', value: '19.57 / -21.81', unit: '%' },
    ];
    warning = config.marketNeutralWeightPercent + config.trendWeightPercent !== 100
      ? '市场中性仓位权重与动态趋势仓位权重之和必须为 100%。'
      : '88.89% 是历史验证结果，不是未来保证；该档仍只保存配置并用于观察。';
  }
  if (['stableComposite', 'aggressiveComposite'].includes(type)) {
    metrics = [
      { label: '价格 / 新闻权重', value: `${config.priceSignalWeight} / ${config.newsSignalWeight}`, unit: '%' },
      { label: '新闻可信门槛', value: config.minimumNewsCredibility, unit: '%' },
      { label: '目标年化波动', value: config.targetVolatilityPercent, unit: '%' },
      { label: '回撤熔断', value: config.portfolioDrawdownLimitPercent, unit: '%' },
    ];
    if (type === 'stableComposite' && config.accuracyLeverageEnabled === 'enabled') {
      metrics.push(
        { label: '条件杠杆门槛', value: config.accuracyLeverageThresholdPercent, unit: '%' },
        { label: '达标后敞口倍率', value: config.accuracyLeverageMultiplier, unit: '×' },
      );
    }
    if (config.priceSignalWeight + config.newsSignalWeight !== 100) {
      warning = '价格信号权重与新闻信号权重之和必须为 100%。';
    } else if (config.maxAssetExposurePercent > config.maxGrossExposurePercent) {
      warning = '单币最大敞口不能超过组合最大总敞口。';
    } else {
      warning = type === 'stableComposite' && config.accuracyLeverageEnabled === 'enabled'
        ? `至少 ${config.accuracyLeverageMinimumSamples} 条已结算信号达到 ${config.accuracyLeverageThresholdPercent}% 准确率且通过波动/回撤门槛后，才提高到 ${config.accuracyLeverageMultiplier}×；否则保持 1×。`
        : '新闻低于可信度或方向置信度门槛时，自动退化为纯价格信号。';
    }
  }
  const leverage = Number.isFinite(config.leverage) ? config.leverage : 1;
  const maxInvestment = type === 'grid'
    ? config.totalInvestment
    : type === 'martingale'
      ? config.initialOrderAmount + Array.from({ length: config.maxSafetyOrders }, (_, index) => config.safetyOrderAmount * (config.volumeMultiplier ** index)).reduce((sum, amount) => sum + amount, 0)
      : type === 'dca'
        ? config.orderAmount * config.maxOrders
        : type === 'maCrossover'
          ? config.orderAmount * config.maxPositions
          : config.marginBudget;
  metrics = [
    { label: '杠杆倍数', value: leverage, unit: '×' },
    {
      label: '最大名义敞口',
      value: ['longShortTrend', 'longShortEnhanced', 'longShortHighReturn', 'monthlyAccuracyPortfolio', 'stableComposite', 'aggressiveComposite'].includes(type)
        ? Math.min(
          maxInvestment * leverage,
          maxInvestment * config.maxGrossExposurePercent / 100
            * (type === 'stableComposite' && config.accuracyLeverageEnabled === 'enabled' ? config.accuracyLeverageMultiplier : 1),
        )
        : maxInvestment * leverage,
      unit: 'USDT',
    },
    ...metrics,
  ];
  if (leverage >= 10) warning = '杠杆达到 10× 或以上，损益与强平风险会显著放大。';
  return { metrics, warning };
}

function updateStrategyRiskPreview() {
  const type = $('#strategyType').value;
  const { metrics, warning } = localRiskPreview(type, collectStrategyConfig());
  $('#riskMetrics').innerHTML = metrics.map((metric) => {
    const numeric = typeof metric.value === 'number' && Number.isFinite(metric.value)
      ? Number(metric.value.toFixed(4)).toLocaleString('en-US')
      : metric.value;
    return `<div><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(numeric)} ${escapeHtml(metric.unit)}</strong></div>`;
  }).join('');
  $('#riskWarning').textContent = warning;
}

function openStrategyModal(type = 'grid', strategy = null) {
  const definition = strategyDefinition(strategy?.type || type);
  if (!definition || !state.strategyCatalog) return;
  state.editingStrategyId = strategy?.id || null;
  $('#strategyType').value = definition.type;
  $('#strategyModalEyebrow').textContent = strategy ? 'EDIT STRATEGY' : 'NEW STRATEGY';
  $('#strategyModalTitle').textContent = strategy ? '编辑策略参数' : `配置${definition.name}`;
  $('#strategyName').value = strategy?.name || `${definition.name} ${definition.type === 'martingale' ? '谨慎版' : '基础版'}`;
  $('#strategySymbol').innerHTML = state.strategyCatalog.symbols.map((item) => `<option value="${escapeHtml(item.value)}" ${item.value === (strategy?.symbol || 'BTCUSDT') ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
  $('#strategySymbol').closest('label').classList.toggle('hidden', Boolean(definition.portfolio));
  $('#strategyTypeNote').innerHTML = `<strong>${escapeHtml(definition.riskLevel)}</strong> · ${escapeHtml(definition.description)}`;
  renderStrategyFields(definition, strategy?.config);
  updateStrategyRiskPreview();
  $('#strategyModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#strategyName').focus();
}

function closeStrategyModal() {
  $('#strategyModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  state.editingStrategyId = null;
  $('#strategyForm').reset();
}

async function handleStrategyAction(action, id) {
  const strategy = state.strategies.find((item) => item.id === id);
  if (!strategy) return;
  try {
    if (action === 'edit') return openStrategyModal(strategy.type, strategy);
    if (action === 'toggle') {
      await api(`/api/strategies/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !strategy.enabled }) });
      showToast(strategy.enabled ? '策略已停止观察' : '策略已进入观察状态，不会自动下单');
    }
    if (action === 'clone') {
      await api(`/api/strategies/${id}/clone`, { method: 'POST', body: '{}' });
      showToast('策略配置已复制');
    }
    if (action === 'delete') {
      if (!window.confirm(`确定删除“${strategy.name}”吗？`)) return;
      await api(`/api/strategies/${id}`, { method: 'DELETE' });
      showToast('策略配置已删除');
    }
    await loadStrategies();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

$('#apiForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#connectApiButton');
  const apiKey = $('#apiKey').value.trim();
  const apiSecret = $('#apiSecret').value.trim();
  setButtonLoading(button, true, '正在验证签名…');
  try {
    const result = await api('/api/session', { method: 'POST', body: JSON.stringify({ apiKey, apiSecret }) });
    updateConnection(true, `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`);
    $('#apiSecret').value = '';
    showToast(result.canTrade ? '测试网连接成功，交易权限正常' : '连接成功，但当前 API 未开启交易权限');
    setTimeout(() => navigate('assets'), 450);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonLoading(button, false);
  }
});

$('#disconnectButton').addEventListener('click', async () => {
  try {
    await api('/api/session', { method: 'DELETE' });
    updateConnection(false);
    $('#apiKey').value = '';
    $('#apiSecret').value = '';
    showToast('API 会话已从服务端内存清除');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

$('#logoutAppButton').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } finally {
    window.location.replace('/login.html');
  }
});

$('#orderForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.connected) {
    showToast('请先连接 Binance Testnet API', 'error');
    navigate('settings');
    return;
  }
  const button = $('#testOrderButton');
  const side = $('input[name="side"]:checked').value;
  const body = { symbol: $('#orderSymbol').value, side, amount: $('#orderAmount').value.trim() };
  setButtonLoading(button, true, '正在校验订单…');
  try {
    const result = await api('/api/orders/test', { method: 'POST', body: JSON.stringify(body) });
    const resultCard = $('#orderResult');
    const referencePrice = priceFormat(result.execution?.referencePrice);
    const pnl = formatPnl(result.execution?.pnl);
    resultCard.innerHTML = `
      <strong>✓ 测试订单校验通过</strong>
      <p>${escapeHtml(result.message)}</p>
      <div class="order-result-metrics">
        <div><span>交易价格（参考）</span><b>${referencePrice} USDT</b></div>
        <div><span>盈亏</span><b class="pnl-neutral">${pnl}</b></div>
      </div>
      <small>测试订单不会进入撮合；价格为校验时行情，未成交因此无实际盈亏。</small>`;
    resultCard.classList.remove('hidden');
    showToast('签名、权限和订单参数均已通过验证');
  } catch (error) {
    $('#orderResult').classList.add('hidden');
    showToast(error.message, 'error');
  } finally {
    setButtonLoading(button, false);
  }
});

$$('input[name="side"]').forEach((input) => input.addEventListener('change', () => {
  const buy = input.value === 'BUY' && input.checked;
  if (!input.checked) return;
  const base = $('#orderSymbol').value.replace(/USDT$/, '');
  $('#amountLabel').textContent = buy ? '花费金额（USDT）' : `卖出数量（${base}）`;
  $('#amountUnit').textContent = buy ? 'USDT' : base;
}));

$('#orderSymbol').addEventListener('change', () => {
  $('input[name="side"]:checked').dispatchEvent(new Event('change'));
});
$('#newStrategyButton').addEventListener('click', () => openStrategyModal('grid'));
$('#strategyTemplates').addEventListener('click', (event) => {
  const button = event.target.closest('[data-create-strategy]');
  if (button) openStrategyModal(button.dataset.createStrategy);
});
$('#strategyList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-strategy-action]');
  if (button) handleStrategyAction(button.dataset.strategyAction, button.dataset.strategyId);
});
$('#strategyFields').addEventListener('input', updateStrategyRiskPreview);
$('#strategyFields').addEventListener('change', updateStrategyRiskPreview);
$('#closeStrategyModal').addEventListener('click', closeStrategyModal);
$('#cancelStrategyButton').addEventListener('click', closeStrategyModal);
$('#strategyModal').addEventListener('click', (event) => {
  if (event.target === $('#strategyModal')) closeStrategyModal();
});
$('#strategyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#saveStrategyButton');
  const payload = {
    type: $('#strategyType').value,
    name: $('#strategyName').value.trim(),
    symbol: $('#strategySymbol').value,
    config: collectStrategyConfig(),
  };
  setButtonLoading(button, true, '正在校验配置…');
  try {
    const path = state.editingStrategyId ? `/api/strategies/${state.editingStrategyId}` : '/api/strategies';
    await api(path, { method: state.editingStrategyId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    showToast(state.editingStrategyId ? '策略参数已更新' : '策略配置已创建');
    closeStrategyModal();
    await loadStrategies();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonLoading(button, false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#strategyModal').classList.contains('hidden')) closeStrategyModal();
});
$('#marketSymbol').addEventListener('change', loadMarket);
$('#newsSymbol').addEventListener('change', loadNews);
$('#refreshPaper').addEventListener('click', loadPaperPortfolio);
$('#refreshAssets').addEventListener('click', () => state.connected ? loadAssets() : navigate('settings'));
$('#toggleSecret').addEventListener('click', () => {
  const input = $('#apiSecret');
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  $('#toggleSecret').textContent = visible ? '显示' : '隐藏';
});
$$('[data-target]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.target)));
window.addEventListener('resize', () => { if (state.market) drawChart(state.market.candles); });

if (await loadAppSession()) {
  await Promise.all([loadSession(), loadMarket(), loadStrategies(), loadPaperPortfolio()]);
}
setInterval(() => { if (!document.hidden) loadMarket(); }, 20_000);
setInterval(() => { if (!document.hidden && state.currentPage === 'news') loadNews(); }, 60_000);
setInterval(() => { if (!document.hidden && state.currentPage === 'paper') loadPaperPortfolio(); }, 60_000);
