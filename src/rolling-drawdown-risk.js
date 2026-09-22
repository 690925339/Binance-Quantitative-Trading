// Evaluated after settlement; the returned scale applies only to the next holding period.
export function evaluateRollingDrawdownRisk(component, settings, cycleDate) {
  if (!settings.rollingDrawdownRiskEnabled) return { enabled: false, scale: 1 };
  const windowDays = settings.rollingDrawdownWindowDays;
  const start = settings.rollingDrawdownStart;
  const full = settings.rollingDrawdownFull;
  const floor = settings.rollingDrawdownMinimumScale;
  if (!Number.isInteger(windowDays) || windowDays < 2 || windowDays > 365
    || !(Number.isFinite(start) && start > 0)
    || !(Number.isFinite(full) && full > start && full < 1)
    || !(Number.isFinite(floor) && floor > 0 && floor < 1)
    || !(Number.isFinite(component.equity) && component.equity > 0)
    || !/^\d{4}-\d{2}-\d{2}$/.test(cycleDate)) {
    throw new Error('滚动回撤减仓参数或净值无效');
  }
  const cutoff = Date.parse(`${cycleDate}T00:00:00Z`) - windowDays * 86400000;
  const history = (component.drawdownRiskHistory || []).filter(item => (
    item.date < cycleDate && Date.parse(`${item.date}T00:00:00Z`) >= cutoff
  ));
  history.push({ date: cycleDate, equity: component.equity });
  component.drawdownRiskHistory = history;
  const peak = Math.max(...history.map(item => item.equity));
  const drawdown = Math.max(0, 1 - component.equity / peak);
  const progress = Math.max(0, Math.min(1, (drawdown - start) / (full - start)));
  return {
    enabled: true, cycleDate, windowDays, observations: history.length,
    drawdown, start, full, minimumScale: floor,
    scale: 1 - progress * (1 - floor),
  };
}
