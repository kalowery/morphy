(function() {
  const widgetRoot = document.getElementById('widget-root');
  if (!widgetRoot) {
    return;
  }
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text || '';
    }
  }
  function setNarrative(lines) {
    const container = document.getElementById('narrative');
    if (!container) {
      return;
    }
    container.innerHTML = '';
    (Array.isArray(lines) ? lines : []).forEach((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      container.appendChild(p);
    });
  }
  function setHighlights(list) {
    const container = document.getElementById('highlights');
    if (!container) {
      return;
    }
    container.innerHTML = '';
    (Array.isArray(list) ? list : []).forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      container.appendChild(li);
    });
  }
  function renderChart(chart) {
    const container = document.getElementById('chart-bars');
    if (!container) {
      return;
    }
    container.innerHTML = '';
    if (!chart || !Array.isArray(chart.labels) || !Array.isArray(chart.values)) {
      return;
    }
    const numbers = chart.values.map((value) => Number(value) || 0);
    const maxValue = Math.max(...numbers, 1);
    chart.labels.forEach((label, index) => {
      const value = numbers[index] || 0;
      const row = document.createElement('div');
      row.className = 'bar-row';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'bar-label';
      labelSpan.textContent = label;
      const wrapper = document.createElement('div');
      wrapper.className = 'bar-wrapper';
      const inner = document.createElement('div');
      inner.className = 'bar-inner';
      inner.style.width = `${(value / maxValue) * 100}%`;
      inner.textContent = value.toString();
      wrapper.appendChild(inner);
      row.appendChild(labelSpan);
      row.appendChild(wrapper);
      container.appendChild(row);
    });
  }
  function formatRange(info) {
    if (!info) {
      return '';
    }
    const start = info.start ? info.start.slice(0, 10) : '';
    const end = info.end ? info.end.slice(0, 10) : '';
    if (start && end) {
      return `${start} — ${end}`;
    }
    return start || end || '';
  }
  function render(payload) {
    if (!payload) {
      return;
    }
    const { report, context, domain, panel } = payload;
    setText('domain-chip', domain?.name || 'Domain');
    setText('panel-title', panel?.title || 'Panel');
    setText('summary', panel?.summary || '');
    setText('panel-name', panel?.title || '');
    const windowInfo = context?.previews?.[0]?.detail?.queryWindow;
    setText('date-range', formatRange(windowInfo));
    setNarrative(report?.narrative);
    setHighlights(report?.highlights);
    setText('chart-title', report?.chart?.title || '');
    const accent = domain?.color || '#8df0c6';
    widgetRoot.style.setProperty('--accent-color', accent);
    renderChart(report?.chart);
    resize();
  }
  function resize() {
    if (!widgetRoot) {
      return;
    }
    const height = Math.min(Math.max(widgetRoot.scrollHeight, 320), 1200);
    window.MorphyBridge.emit('widget:resize', { height });
  }
  window.MorphyBridge.onInit = (payload) => {
    render(payload);
  };
  window.MorphyBridge.onUpdate = (payload) => {
    render(payload);
  };
})();