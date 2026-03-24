(() => {
  const bridge = window.MorphyBridge;
  if (!bridge) return;
  const hostId = 'app';
  let lastHeight = 0;
  const getRoot = () => {
    const host = document.getElementById(hostId);
    return host?.querySelector('[data-widget-root]') ?? document.querySelector('[data-widget-root]');
  };
  const createRefs = (container) => container ? {
    root: container,
    domainName: container.querySelector('[data-domain-name]'),
    panelTitle: container.querySelector('[data-panel-title]'),
    domainIcon: container.querySelector('[data-domain-icon]'),
    panelSummary: container.querySelector('[data-panel-summary]'),
    summaryText: container.querySelector('[data-summary-text]'),
    chartTitle: container.querySelector('[data-chart-title]'),
    chartGrid: container.querySelector('[data-chart-grid]'),
    dominant: container.querySelector('[data-dominant]'),
    strength: container.querySelector('[data-strength]'),
    highlightsList: container.querySelector('[data-highlights]')
  } : null;
  const truncate = (text, limit) => text && text.length > limit ? text.slice(0, limit - 1) + '…' : text || '';
  const renderChart = (labels, values, target) => {
    if (!target) return;
    target.innerHTML = '';
    const numeric = Array.isArray(values) ? values.map((v) => Number(v) || 0) : [];
    const max = numeric.length ? Math.max(...numeric) : 1;
    labels.forEach((label, index) => {
      const value = numeric[index] ?? 0;
      const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
      const row = document.createElement('div');
      row.className = 'chart-row';
      const labelEl = document.createElement('div');
      labelEl.className = 'chart-label';
      labelEl.textContent = label;
      const barWrapper = document.createElement('div');
      barWrapper.className = 'chart-bar';
      const bar = document.createElement('span');
      bar.style.width = `${ratio * 100}%`;
      barWrapper.appendChild(bar);
      const valueEl = document.createElement('div');
      valueEl.className = 'chart-value';
      valueEl.textContent = `${value}°C`;
      row.appendChild(labelEl);
      row.appendChild(barWrapper);
      row.appendChild(valueEl);
      target.appendChild(row);
    });
  };
  const emitResize = () => {
    requestAnimationFrame(() => {
      const host = document.getElementById(hostId);
      if (!host || !bridge.emit) return;
      const height = Math.ceil(host.scrollHeight || host.offsetHeight || 400);
      if (height && height !== lastHeight) {
        bridge.emit('widget:resize', { height });
        lastHeight = height;
      }
    });
  };
  const render = (payload) => {
    if (!payload) return;
    const shell = getRoot();
    if (!shell) return;
    const refs = createRefs(shell);
    if (!refs) return;
    const report = payload.report || {};
    const domain = payload.domain || {};
    const panel = payload.panel || {};
    if (refs.domainName) refs.domainName.textContent = domain.name || '';
    if (refs.panelTitle) refs.panelTitle.textContent = panel.title || '';
    if (refs.domainIcon) {
      refs.domainIcon.textContent = domain.icon || (domain.name || '').slice(0, 2).toUpperCase();
      refs.domainIcon.style.backgroundColor = domain.color || '#8df0c6';
    }
    if (refs.panelSummary) refs.panelSummary.textContent = panel.summary || '';
    if (refs.summaryText) {
      refs.summaryText.textContent = (report.narrative && report.narrative.length ? report.narrative[0] : '') || panel.summary || '';
    }
    const chart = report.chart || {};
    if (refs.chartTitle) refs.chartTitle.textContent = chart.title || panel.title || '';
    renderChart(chart.labels || [], chart.values || [], refs.chartGrid);
    const highlights = Array.isArray(report.highlights) ? report.highlights : [];
    const dominant = highlights[0] || 'Scheduler/capacity pressure plus GPU thermal hotspots.';
    if (refs.dominant) refs.dominant.textContent = truncate(dominant, 120);
    const evidenceText = 'Strong: scheduler/capacity pressure; Moderate: GPU thermal hotspots; Weak: hardware/fabric/storage signals not present.';
    if (refs.strength) refs.strength.textContent = evidenceText;
    if (refs.highlightsList) {
      refs.highlightsList.innerHTML = '';
      highlights.slice(0, 4).forEach((item) => {
        const li = document.createElement('li');
        li.textContent = item;
        refs.highlightsList.appendChild(li);
      });
    }
    emitResize();
  };
  const handler = (payload) => {
    render(payload);
  };
  bridge.onInit && bridge.onInit(handler);
  bridge.onUpdate && bridge.onUpdate(handler);
})();