(function() {
  const root = document.getElementById('app');
  if (!root) return;

  const selectors = {
    icon: '[data-icon]',
    domain: '[data-domain]',
    panel: '[data-title]',
    summary: '[data-summary]',
    range: '[data-range]',
    hosts: '[data-hosts]',
    partitions: '[data-partitions]',
    chartTitle: '[data-chart-title]',
    chart: '[data-chart]',
    highlights: '[data-highlights]'
  };

  const getRefs = () => {
    const map = {};
    Object.entries(selectors).forEach(([key, selector]) => {
      map[key] = root.querySelector(selector);
    });
    return map;
  };

  const setText = (el, text) => {
    if (!el) return;
    el.textContent = text !== undefined && text !== null ? text : '';
  };

  const formatRange = (windowInfo) => {
    if (!windowInfo || !windowInfo.start || !windowInfo.end) return 'n/a';
    const start = windowInfo.start.split('T')[0] || windowInfo.start;
    const end = windowInfo.end.split('T')[0] || windowInfo.end;
    return `${start} → ${end}`;
  };

  const extractQueryResult = (results, name) => {
    if (!Array.isArray(results)) return undefined;
    return results.find((res) => res.queryName === name);
  };

  const renderSummary = (content, container) => {
    if (!container) return;
    container.innerHTML = '';
    const lines = (content || '').split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      container.textContent = 'No summary available.';
      return;
    }
    lines.forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      container.appendChild(p);
    });
  };

  const renderChart = (chartData, container) => {
    if (!container) return;
    container.innerHTML = '';
    if (!chartData || !Array.isArray(chartData.labels) || !Array.isArray(chartData.values)) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = 'No chart data available.';
      container.appendChild(empty);
      return;
    }
    const numericValues = chartData.values.map((v) => Number(v) || 0);
    const maxValue = Math.max.apply(null, numericValues.concat([1]));
    chartData.labels.forEach((label, index) => {
      const value = numericValues[index] || 0;
      const row = document.createElement('div');
      row.className = 'chart-row';
      const labelEl = document.createElement('div');
      labelEl.className = 'chart-label';
      labelEl.textContent = label;
      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = `${(value / maxValue) * 100}%`;
      track.appendChild(fill);
      const valueEl = document.createElement('div');
      valueEl.className = 'bar-value';
      valueEl.textContent = `${value}°C`;
      row.appendChild(labelEl);
      row.appendChild(track);
      row.appendChild(valueEl);
      container.appendChild(row);
    });
  };

  const renderHighlights = (items, container) => {
    if (!container) return;
    container.innerHTML = '';
    if (!Array.isArray(items) || items.length === 0) {
      const fallback = document.createElement('div');
      fallback.className = 'highlight-empty';
      fallback.textContent = 'No highlights available.';
      container.appendChild(fallback);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'highlight-list';
    items.forEach((item) => {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.appendChild(entry);
    });
    container.appendChild(list);
  };

  const emitResize = () => {
    if (!window.MorphyBridge || typeof window.MorphyBridge.emit !== 'function') return;
    const height = Math.max(360, Math.ceil(root.getBoundingClientRect().height + 20));
    window.MorphyBridge.emit('widget:resize', { height });
  };

  const renderWidget = (payload) => {
    if (!payload) return;
    const refs = getRefs();
    const { report = {}, context = {}, panel = {}, domain = {} } = payload;
    const narrative = Array.isArray(report.narrative) && report.narrative.length > 0 ? report.narrative[0] : '';
    const summaryText = narrative || panel.summary || domain.description || 'No summary provided.';
    renderSummary(summaryText, refs.summary);
    const fallbackIcon = (domain.name || '??').split(' ').map((part) => (part || '')[0] || '').join('').slice(0, 2).toUpperCase();
    setText(refs.icon, domain.icon || fallbackIcon);
    setText(refs.domain, domain.name || 'Cluster observability');
    setText(refs.panel, panel.title || 'Fleet health');
    const preview = context && Array.isArray(context.previews) ? context.previews[0] : undefined;
    const queryResults = preview && preview.detail && Array.isArray(preview.detail.queryResults) ? preview.detail.queryResults : [];
    setText(refs.range, formatRange(preview && preview.detail && preview.detail.queryWindow));
    const hostResult = extractQueryResult(queryResults, 'instrumentedHostCount');
    const hostCount = hostResult && hostResult.sample && hostResult.sample[0] ? hostResult.sample[0].value : undefined;
    setText(refs.hosts, hostCount ? hostCount + ' hosts' : 'n/a');
    const pendingResult = extractQueryResult(queryResults, 'pendingJobsByPartition');
    const partitionCount = pendingResult && pendingResult.resultCount ? pendingResult.resultCount : 0;
    const pendingSample = pendingResult && Array.isArray(pendingResult.sample) ? pendingResult.sample : [];
    const pendingTotal = pendingSample.reduce((sum, entry) => sum + (Number(entry && entry.value) || 0), 0);
    const partitionText = partitionCount ? pendingTotal + ' jobs • ' + partitionCount + ' partitions' : 'No pending demand';
    setText(refs.partitions, partitionText);
    setText(refs.chartTitle, (report.chart && report.chart.title) || panel.title || 'Risk chart');
    renderChart(report.chart, refs.chart);
    renderHighlights(report.highlights, refs.highlights);
    root.style.setProperty('--accent-color', domain.color || '#8df0c6');
    emitResize();
  };

  if (window.MorphyBridge) {
    if (typeof window.MorphyBridge.onInit === 'function') {
      window.MorphyBridge.onInit(renderWidget);
    }
    if (typeof window.MorphyBridge.onUpdate === 'function') {
      window.MorphyBridge.onUpdate(renderWidget);
    }
  }
})();