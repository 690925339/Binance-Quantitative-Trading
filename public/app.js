const state = {
  connected: false,
  market: null,
  currentPage: 'dashboard',
  strategyCatalog: null,
  strategies: [],
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
  if (!response.ok) throw new Error(payload.error || '请求失败，请稍后重试');
  return payload;
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
    const metrics = (strategy.riskSummary?.metrics || []).slice(0, 2);
    const warning = strategy.riskSummary?.warnings?.[0];
    return `
      <article class="configured-card">
        <header class="configured-card-head">
          <span class="template-icon">${escapeHtml(definition.icon)}</span>
          <div class="configured-main">
            <strong>${escapeHtml(strategy.name)}</strong>
            <p>${escapeHtml(strategy.symbol)} · ${escapeHtml(definition.name)} · ${escapeHtml(definition.riskLevel)}</p>
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
    resultCard.innerHTML = `<strong>✓ 测试订单校验通过</strong>${result.message}`;
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
$('#refreshAssets').addEventListener('click', () => state.connected ? loadAssets() : navigate('settings'));
$('#toggleSecret').addEventListener('click', () => {
  const input = $('#apiSecret');
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  $('#toggleSecret').textContent = visible ? '显示' : '隐藏';
});
$$('[data-target]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.target)));
window.addEventListener('resize', () => { if (state.market) drawChart(state.market.candles); });

await Promise.all([loadSession(), loadMarket(), loadStrategies()]);
setInterval(() => { if (!document.hidden) loadMarket(); }, 20_000);
