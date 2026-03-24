(function() {
  const bridge = window.MorphyBridge;
  if (!bridge) {
    return;
  }
  const root = document.getElementById('app');
  const shellId = 'widget-shell';
  const ensureShell = () => {
    if (!root) {
      return null;
    }
    let shell = document.getElementById(shellId);
    if (!shell) {
      shell = document.createElement('div');
      shell.id = shellId;
      shell.className = 'widget-shell';
      root.innerHTML = '';
      root.appendChild(shell);
    }
    return shell;
  };
  const formatDate = (value) => {
    if (!value) {
      return '';
    }
    return value.split('T')[0];
  };
  const summarizeScheduler = (detail) => {
    if (!detail) {
      return 'Pending and saturation details unavailable in this preview.';
    }
    const pendingSamples = detail.queryResults?.find((q) => q.queryName === 'pendingJobsByPartition')?.sample ?? [];
    const saturationSamples = detail.queryResults?.find((q) => q.queryName === 'partitionCpuSaturation')?.sample ?? [];
    const pending = pendingSamples
      .map((entry) => ({ partition: entry.metric?.partition ?? 'unknown', value: Number(entry.value) }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
    const pendingText = pending.length
      ? pending.map((entry) => `${entry.partition} (${entry.value} pending)`).join(', ')
      : 'No pending jobs reported in the preview.';
    const saturated = saturationSamples
      .map((entry) => ({ partition: entry.metric?.partition ?? 'unknown', value: Number(entry.value) }))
      .filter((entry) => entry.value >= 0.95)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
    const saturationText = saturated.length
      ? `Saturated partitions: ${saturated.map((entry) => `${entry.partition} (${entry.value.toFixed(2)})`).join(', ')}`
      : 'No partitions above 95% CPU saturation in this window.';
    return `${pendingText}. ${saturationText}.`;
  };
  const renderChart = (chart, container) => {
    const barsContainer = container.querySelector('.chart-bars');
    if (!barsContainer) {
      return;
    }
    barsContainer.innerHTML = '';
    const labels = Array.isArray(chart?.labels) ? chart.labels : [];
    const values = Array.isArray(chart?.values) ? chart.values : [];
    const numericValues = values.map((value) => Number(value)).filter((value) => !Number.isNaN(value));
    const maxValue = numericValues.length ? Math.max(...numericValues) : 1;
    barsContainer.setAttribute('aria-label', chart?.title ? `${chart.title} bars` : 'Bar chart');
    labels.forEach((label, index) => {
      const value = Number(values[index]);
      if (Number.isNaN(value)) {
        return;
      }
      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      const barOuter = document.createElement('div');
      barOuter.className = 'bar-outer';
      const barFill = document.createElement('div');
      barFill.className = 'bar-fill';
      const heightPercent = maxValue > 0 ? (value / maxValue) * 100 : 0;
      barFill.style.setProperty('--bar-height', `${heightPercent}%`);
      barOuter.appendChild(barFill);
      const barValue = document.createElement('div');
      barValue.className = 'bar-value';
      barValue.textContent = `${value}°C`;
      const barLabel = document.createElement('div');
      barLabel.className = 'bar-label';
      barLabel.textContent = label.split(':')[0];
      bar.appendChild(barOuter);
      bar.appendChild(barValue);
      bar.appendChild(barLabel);
      barsContainer.appendChild(bar);
    });
  };
  const publishResize = () => {
    requestAnimationFrame(() => {
      const shell = document.getElementById(shellId);
      if (!shell || !bridge?.emit) {
        return;
      }
      const height = Math.max(shell.scrollHeight, shell.offsetHeight, 420);
      bridge.emit('widget:resize', { height });
    });
  };
  const render = (payload) => {
    if (!payload || !root) {
      return;
    }
    const shell = ensureShell();
    if (!shell) {
      return;
    }
    const setText = (selector, text) => {
      const el = shell.querySelector(selector);
      if (el) {
        el.textContent = text ?? '';
      }
    };
    const { domain = {}, panel = {}, report = {} } = payload;
    setText('.panel-title', panel.title ?? 'Fleet Health');
    setText('.panel-summary', panel.summary ?? '');
    setText('.domain-chip', domain.name ?? '');
    setText('.type-chip', 'Historical observability preview');
    setText('.chart-title', report.chart?.title ?? 'Top host risk signals');
    const windowDetail = payload.context?.previews?.[0]?.detail?.queryWindow;
    const dateRange = windowDetail
      ? `Window: ${formatDate(windowDetail.start)} → ${formatDate(windowDetail.end)}`
      : 'Historical window snapshot';
    setText('.chart-subtitle', dateRange);
    const narrative = Array.isArray(report.narrative) && report.narrative[0] ? report.narrative[0] : '';
    setText('.big-summary', narrative);
    renderChart(report.chart ?? {}, shell);
    const highlightNode = shell.querySelector('.highlight-items');
    if (highlightNode) {
      highlightNode.innerHTML = '';
      (Array.isArray(report.highlights) ? report.highlights : []).forEach((highlight) => {
        const li = document.createElement('li');
        li.textContent = highlight;
        highlightNode.appendChild(li);
      });
    }
    const chartLabels = Array.isArray(report.chart?.labels) ? report.chart.labels : [];
    const topHosts = chartLabels.slice(0, 3).map((label) => label.split(':')[0]);
    const riskText = topHosts.length
      ? `Thermal hotspots on ${topHosts.join(', ')} anchor the observable host-level risk.`
      : 'Thermal data anchors the observable host-level risk.';
    setText('.risk-body', riskText);
    const schedulerText = summarizeScheduler(payload.context?.previews?.[0]?.detail);
    setText('.scheduler-body', schedulerText);
    setText('.caveat-body', 'Fabric, storage, and node state signals are absent in the preview, so anything beyond scheduler pressure and thermal risk is lower confidence.');
    publishResize();
  };
  if (typeof bridge.onInit === 'function') {
    bridge.onInit(render);
  }
  if (typeof bridge.onUpdate === 'function') {
    bridge.onUpdate(render);
  }
})();