const TEMPLATE = `<div class='widget-shell' data-morphy-widget>
  <header class='widget-header'>
    <div class='domain-pill' aria-hidden='true'></div>
    <div class='header-content'>
      <h1 class='panel-title'></h1>
      <p class='panel-summary'></p>
      <div class='panel-meta'>
        <span class='domain-name'></span>
        <span class='window-range'></span>
      </div>
    </div>
  </header>
  <section class='stats-grid'></section>
  <section class='widget-main'>
    <div class='chart-wrapper'>
      <div class='chart-title'></div>
      <div class='chart-bars' role='list'></div>
    </div>
    <div class='insights'>
      <h2>Highlights</h2>
      <ul class='highlights-list'></ul>
    </div>
  </section>
  <section class='narrative'>
    <h2>Analysis Notes</h2>
    <div class='narrative-text'></div>
  </section>
</div>`;
const formatDate = (value) => {
  if (!value) {
    return '';
  }
  return value.split('T')[0];
};
const hydrateStats = (shell, stats) => {
  const container = shell.querySelector('.stats-grid');
  if (!container) {
    return;
  }
  container.innerHTML = '';
  stats.forEach((stat) => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const label = document.createElement('div');
    label.className = 'stat-label';
    label.textContent = stat.label;
    const value = document.createElement('div');
    value.className = 'stat-value';
    value.textContent = stat.value;
    card.appendChild(label);
    card.appendChild(value);
    container.appendChild(card);
  });
};
const hydrateChart = (shell, chartInfo) => {
  const container = shell.querySelector('.chart-bars');
  const title = shell.querySelector('.chart-title');
  if (title) {
    title.textContent = chartInfo.title || 'Observations';
  }
  if (!container) {
    return 0;
  }
  container.innerHTML = '';
  const labels = Array.isArray(chartInfo.labels) ? chartInfo.labels : [];
  const rawValues = Array.isArray(chartInfo.values) ? chartInfo.values : [];
  const points = labels.map((label, index) => {
    const numeric = Number(rawValues[index]);
    return {
      label,
      value: Number.isFinite(numeric) ? numeric : 0
    };
  });
  if (!points.length) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'No chart data available in this preview.';
    container.appendChild(empty);
    return 0;
  }
  const maxValue = points.reduce((max, point) => Math.max(max, point.value), 0) || 1;
  points.forEach((point) => {
    const barItem = document.createElement('div');
    barItem.className = 'bar-item';
    const bar = document.createElement('div');
    bar.className = 'bar-visual';
    const height = Math.max(6, Math.min(100, (point.value / maxValue) * 100));
    bar.style.height = `${height}%`;
    const valueTag = document.createElement('div');
    valueTag.className = 'bar-value';
    valueTag.textContent = `${point.value}°C`;
    const labelTag = document.createElement('div');
    labelTag.className = 'bar-label';
    labelTag.textContent = point.label;
    barItem.appendChild(bar);
    barItem.appendChild(valueTag);
    barItem.appendChild(labelTag);
    container.appendChild(barItem);
  });
  return Math.round(maxValue);
};
const hydrateHighlights = (shell, highlights) => {
  const list = shell.querySelector('.highlights-list');
  if (!list) {
    return;
  }
  list.innerHTML = '';
  if (!highlights.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No highlights available from this preview.';
    list.appendChild(empty);
    return;
  }
  highlights.forEach((highlight) => {
    const item = document.createElement('li');
    item.textContent = highlight;
    list.appendChild(item);
  });
};
const hydrateNarrative = (shell, narrative) => {
  const target = shell.querySelector('.narrative-text');
  if (!target) {
    return;
  }
  target.innerHTML = '';
  if (!narrative.length) {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Narrative context is not available in the current preview.';
    target.appendChild(paragraph);
    return;
  }
  narrative.forEach((block) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = block;
    target.appendChild(paragraph);
  });
};
const buildStats = (payload, maxTemperature) => {
  const context = payload?.context ?? {};
  const detail = context?.previews?.[0]?.detail;
  const queryResults = Array.isArray(detail?.queryResults) ? detail.queryResults : [];
  const findQuery = (queryName) => queryResults.find((entry) => entry.queryName === queryName);
  const instrumentedSample = findQuery('instrumentedHostCount')?.sample?.[0];
  const instrumentedValue = Number(instrumentedSample?.value);
  const pendingSamples = findQuery('pendingJobsByPartition')?.sample ?? [];
  let topPartition = '';
  let topValue = -Infinity;
  pendingSamples.forEach((entry) => {
    const value = Number(entry.value);
    const partition = entry.metric?.partition;
    if (partition && Number.isFinite(value) && value > topValue) {
      topValue = value;
      topPartition = partition;
    }
  });
  const saturationSamples = findQuery('partitionCpuSaturation')?.sample ?? [];
  const saturated = saturationSamples
    .filter((entry) => Number(entry.value) === 1 && entry.metric?.partition)
    .map((entry) => entry.metric.partition);
  return [
    {
      label: 'Instrumented hosts',
      value: Number.isFinite(instrumentedValue) ? `${instrumentedValue}` : 'Unavailable'
    },
    {
      label: 'Pending jobs',
      value: topPartition ? `${topValue} pending (${topPartition})` : 'Pending data unavailable'
    },
    {
      label: 'Saturated partitions',
      value: saturated.length ? saturated.join(', ') : 'None at 100%'
    },
    {
      label: 'Max GPU temp',
      value: maxTemperature ? `${maxTemperature}°C` : 'N/A'
    }
  ];
};
const handlePayload = (payload) => {
  if (!payload) {
    return;
  }
  const report = payload.report ?? {};
  const panel = payload.panel ?? {};
  const domain = payload.domain ?? {};
  const context = payload.context ?? {};
  const detail = context?.previews?.[0]?.detail;
  const root = document.getElementById('app');
  if (!root) {
    return;
  }
  root.innerHTML = TEMPLATE;
  const shell = root.querySelector('.widget-shell');
  if (!shell) {
    return;
  }
  const accent = domain.color || '#8df0c6';
  shell.style.setProperty('--accent', accent);
  const icon = shell.querySelector('.domain-pill');
  if (icon) {
    icon.textContent = domain.icon || 'HF';
  }
  const title = shell.querySelector('.panel-title');
  if (title) {
    title.textContent = panel.title || 'Fleet Health';
  }
  const summary = shell.querySelector('.panel-summary');
  if (summary) {
    summary.textContent = panel.summary || '';
  }
  const domainName = shell.querySelector('.domain-name');
  if (domainName) {
    domainName.textContent = domain.name || '';
  }
  const range = shell.querySelector('.window-range');
  if (range) {
    const queryWindow = detail?.queryWindow;
    if (queryWindow) {
      const start = formatDate(queryWindow.start);
      const end = formatDate(queryWindow.end);
      range.textContent = start && end ? `${start} → ${end}` : start || end || 'Historical window';
    } else {
      range.textContent = 'Historical window data';
    }
  }
  const maxTemp = hydrateChart(shell, report.chart ?? {});
  hydrateStats(shell, buildStats(payload, maxTemp));
  hydrateHighlights(shell, Array.isArray(report.highlights) ? report.highlights : []);
  hydrateNarrative(shell, Array.isArray(report.narrative) ? report.narrative : []);
  const emitResize = () => {
    if (window.MorphyBridge && typeof window.MorphyBridge.emit === 'function') {
      window.MorphyBridge.emit('widget:resize', { height: Math.ceil(root.scrollHeight) });
    }
  };
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(emitResize);
  } else {
    emitResize();
  }
};
if (window.MorphyBridge && typeof window.MorphyBridge.onInit === 'function') {
  window.MorphyBridge.onInit(handlePayload);
}
if (window.MorphyBridge && typeof window.MorphyBridge.onUpdate === 'function') {
  window.MorphyBridge.onUpdate(handlePayload);
}
