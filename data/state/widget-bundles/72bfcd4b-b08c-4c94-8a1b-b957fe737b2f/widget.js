(function() {
  if (!window.MorphyBridge) {
    window.MorphyBridge = {};
  }

  const createEl = (tag, className) => {
    const el = document.createElement(tag);
    if (className) {
      el.className = className;
    }
    return el;
  };

  const formatWindowDate = (iso) => {
    if (!iso) {
      return '—';
    }
    const [year, month, day] = iso.split('T')[0].split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthName = months[Number(month) - 1] || month;
    return `${monthName} ${Number(day)}, ${year}`;
  };

  const renderChart = (container, pairs) => {
    container.innerHTML = '';
    if (!pairs.length) {
      const empty = createEl('div', 'chart-empty');
      empty.textContent = 'No temperature samples captured in this preview.';
      container.appendChild(empty);
      return;
    }
    const maxValue = pairs.reduce((max, row) => Math.max(max, row.value), 0) || 1;
    pairs.forEach((row) => {
      const barRow = createEl('div', 'bar-row');
      const meta = createEl('div', 'bar-meta');
      const label = createEl('span', 'bar-label');
      label.textContent = row.label;
      const valueEl = createEl('span', 'bar-value');
      const rounded = Number.isFinite(row.value) ? Math.round(row.value) : 0;
      valueEl.textContent = `${rounded}°C`;
      meta.appendChild(label);
      meta.appendChild(valueEl);
      const track = createEl('div', 'bar-track');
      const fill = createEl('span', 'bar-fill');
      const width = Number.isFinite(row.value) ? (row.value / maxValue) * 100 : 0;
      fill.style.width = `${Math.max(1, Math.min(100, width))}%`;
      track.appendChild(fill);
      barRow.appendChild(meta);
      barRow.appendChild(track);
      container.appendChild(barRow);
    });
  };

  const render = (payload) => {
    const app = document.getElementById('app');
    if (!app || !payload) {
      return;
    }
    const report = payload.report || {};
    const context = payload.context || {};
    const domain = payload.domain || {};
    const panel = payload.panel || {};
    const chart = report.chart || {};
    const previews = Array.isArray(context.previews) ? context.previews : [];
    const preview = previews[0] || null;
    const detail = (preview && preview.detail) || null;
    const queryWindow = (detail && detail.queryWindow) || null;
    const start = (queryWindow && queryWindow.start) || null;
    const end = (queryWindow && queryWindow.end) || null;
    const timeframe = start && end ? `${formatWindowDate(start)} – ${formatWindowDate(end)}` : 'Historical window';
    const queryResults = (detail && Array.isArray(detail.queryResults)) ? detail.queryResults : [];
    const instrumented = queryResults.find((q) => q.queryName === 'instrumentedHostCount');
    const instrumentedCount = instrumented && Array.isArray(instrumented.sample) && instrumented.sample[0]
      ? Number(instrumented.sample[0].value)
      : null;
    const pendingQuery = queryResults.find((q) => q.queryName === 'pendingJobsByPartition');
    const pendingList = [];
    if (pendingQuery && Array.isArray(pendingQuery.sample)) {
      pendingQuery.sample.forEach((item) => {
        const partition = item.metric && item.metric.partition ? item.metric.partition : null;
        const value = Number(item.value);
        if (partition && Number.isFinite(value)) {
          pendingList.push({ partition, value });
        }
      });
      pendingList.sort((a, b) => b.value - a.value);
    }
    const pendingSummary = pendingList.length
      ? pendingList.slice(0, 2).map((item) => `${item.partition} ${item.value}`).join(' · ')
      : 'Pending jobs data unavailable in preview';
    const previewCount = typeof context.previewCount === 'number'
      ? context.previewCount
      : (previews.length || null);
    const chartLabels = Array.isArray(chart.labels) ? chart.labels : [];
    const chartValues = Array.isArray(chart.values) ? chart.values : [];
    const chartPairs = chartLabels.map((label, index) => {
      const value = Number(chartValues[index]);
      return {
        label: label || '—',
        value: Number.isFinite(value) ? value : 0
      };
    }).filter((item) => item.label && Number.isFinite(item.value));
    const topHosts = chartPairs.slice(0, 3);
    const narrativeText = Array.isArray(report.narrative) && report.narrative.length
      ? report.narrative[0]
      : '';
    const paragraphs = narrativeText
      ? narrativeText.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
      : [];
    const highlights = Array.isArray(report.highlights) ? report.highlights : [];
    const snippet = paragraphs[0] || panel.summary || '';
    const statusSnippet = snippet.length > 160 ? `${snippet.slice(0, 157)}…` : snippet;
    app.innerHTML = '';
    const shell = createEl('div', 'widget-shell');
    const header = createEl('div', 'widget-header');
    const titleBlock = createEl('div', 'title-block');
    const domainChip = createEl('span', 'domain-chip');
    const chipIcon = createEl('span', 'domain-icon');
    chipIcon.textContent = domain.icon || (domain.name ? domain.name.slice(0, 2).toUpperCase() : 'HF');
    const chipLabel = createEl('span', 'domain-chip-label');
    chipLabel.textContent = domain.name || 'HPCFund Cluster Observability';
    domainChip.appendChild(chipIcon);
    domainChip.appendChild(chipLabel);
    if (domain.color) {
      domainChip.style.backgroundColor = domain.color;
      domainChip.style.color = '#042f2a';
    }
    const panelTitle = createEl('h1', 'panel-title');
    panelTitle.textContent = panel.title || 'Fleet health';
    const panelSummary = createEl('p', 'panel-summary');
    panelSummary.textContent = panel.summary || '';
    const promptEl = createEl('p', 'analysis-prompt');
    promptEl.textContent = panel.analysisPrompt || '';
    titleBlock.appendChild(domainChip);
    titleBlock.appendChild(panelTitle);
    titleBlock.appendChild(panelSummary);
    if (promptEl.textContent) {
      titleBlock.appendChild(promptEl);
    }
    const statusBlock = createEl('div', 'status-block');
    const statusLabel = createEl('span', 'status-label');
    statusLabel.textContent = 'Dominant risk';
    const statusValue = createEl('strong', 'status-value');
    statusValue.textContent = 'Thermal stress';
    const statusSub = createEl('p', 'status-sub');
    statusSub.textContent = statusSnippet || 'Thermal risk scores dominate the dataset; scheduler/fabric signals are not host-level.';
    statusBlock.appendChild(statusLabel);
    statusBlock.appendChild(statusValue);
    statusBlock.appendChild(statusSub);
    header.appendChild(titleBlock);
    header.appendChild(statusBlock);
    shell.appendChild(header);
    const grid = createEl('div', 'content-grid');
    const chartPanel = createEl('section', 'panel card chart-panel');
    const chartHeader = createEl('div', 'chart-panel-header');
    const chartHeaderText = createEl('div', 'chart-panel-text');
    const chartLabel = createEl('span', 'chart-label');
    chartLabel.textContent = 'Thermal proxy';
    const chartTitle = createEl('h2', 'chart-panel-title');
    chartTitle.textContent = chart.title || 'Top GPU temperatures by host';
    const chartSubtitle = createEl('p', 'chart-panel-subtitle');
    chartSubtitle.textContent = chart.subtitle || 'Ranking derived from the highest observed GPU temperature per host in the preview.';
    const chartBadge = createEl('span', 'chart-badge');
    chartBadge.textContent = chart.type ? chart.type.charAt(0).toUpperCase() + chart.type.slice(1) : 'Bar';
    chartHeaderText.appendChild(chartLabel);
    chartHeaderText.appendChild(chartTitle);
    chartHeaderText.appendChild(chartSubtitle);
    chartHeader.appendChild(chartHeaderText);
    chartHeader.appendChild(chartBadge);
    chartPanel.appendChild(chartHeader);
    const topTagRow = createEl('div', 'top-risk-tags');
    const topTagTitle = createEl('span', 'top-risk-heading');
    topTagTitle.textContent = 'Watch list';
    topTagRow.appendChild(topTagTitle);
    if (topHosts.length) {
      topHosts.forEach((row) => {
        const pill = createEl('span', 'top-risk-pill');
        pill.textContent = row.label;
        topTagRow.appendChild(pill);
      });
    } else {
      const noHosts = createEl('span', 'top-risk-pill');
      noHosts.textContent = 'No host data';
      topTagRow.appendChild(noHosts);
    }
    chartPanel.appendChild(topTagRow);
    const chartBody = createEl('div', 'chart-body');
    renderChart(chartBody, chartPairs);
    chartPanel.appendChild(chartBody);
    const insightPanel = createEl('section', 'panel card insight-panel');
    const narrativeSection = createEl('div', 'section-block');
    const narrativeTitle = createEl('h3', 'section-title');
    narrativeTitle.textContent = 'Key narrative';
    narrativeSection.appendChild(narrativeTitle);
    if (paragraphs.length) {
      paragraphs.slice(0, 3).forEach((paragraph) => {
        const p = createEl('p', 'section-paragraph');
        p.textContent = paragraph;
        narrativeSection.appendChild(p);
      });
    } else {
      const p = createEl('p', 'section-paragraph muted');
      p.textContent = 'Narrative details are not available for this preview.';
      narrativeSection.appendChild(p);
    }
    const highlightSection = createEl('div', 'section-block');
    const highlightTitle = createEl('h3', 'section-title');
    highlightTitle.textContent = 'Highlights';
    highlightSection.appendChild(highlightTitle);
    const highlightList = createEl('ul', 'highlight-list');
    if (highlights.length) {
      highlights.forEach((item) => {
        const li = createEl('li');
        li.textContent = item;
        highlightList.appendChild(li);
      });
    } else {
      const li = createEl('li');
      li.textContent = 'No highlight data captured.';
      highlightList.appendChild(li);
    }
    highlightSection.appendChild(highlightList);
    const metaGrid = createEl('div', 'meta-grid');
    const metaRows = [
      { label: 'Window', value: timeframe },
      { label: 'Instrumented hosts', value: typeof instrumentedCount === 'number' ? instrumentedCount.toString() : '—' },
      { label: 'Pending jobs', value: pendingSummary },
      { label: 'Preview count', value: previewCount != null ? previewCount.toString() : '—' }
    ];
    metaRows.forEach((meta) => {
      const metaCard = createEl('div', 'meta-card');
      const metaLabel = createEl('span', 'meta-label');
      metaLabel.textContent = meta.label;
      const metaValue = createEl('strong', 'meta-value');
      metaValue.textContent = meta.value;
      metaCard.appendChild(metaLabel);
      metaCard.appendChild(metaValue);
      metaGrid.appendChild(metaCard);
    });
    const metaNote = createEl('p', 'meta-note');
    metaNote.textContent = 'Fabric, SMART, and scheduler node-state telemetry were not surfaced in this preview, so only thermal/scheduler observations drove the risk callout.';
    insightPanel.appendChild(narrativeSection);
    insightPanel.appendChild(highlightSection);
    insightPanel.appendChild(metaGrid);
    insightPanel.appendChild(metaNote);
    grid.appendChild(chartPanel);
    grid.appendChild(insightPanel);
    shell.appendChild(grid);
    app.appendChild(shell);
    const height = Math.ceil(shell.getBoundingClientRect().height + 20);
    if (window.MorphyBridge && typeof window.MorphyBridge.emit === 'function') {
      window.MorphyBridge.emit('widget:resize', { height });
    }
  };

  const handle = (payload) => render(payload);
  window.MorphyBridge.onInit = handle;
  window.MorphyBridge.onUpdate = handle;
})();