(function() {
  const parseNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const formatPercent = (value, digits = 0) => {
    if (typeof value !== 'number') return null;
    return `${(value * 100).toFixed(digits)}%`;
  };

  const formatDate = (value) => {
    if (typeof value !== 'string') return null;
    return value.split('T')[0];
  };

  const topSampleByValue = (samples = []) => {
    if (!samples.length) return null;
    return samples.reduce((best, item) => {
      if (!best) return item;
      const bestValue = parseNumber(best.value);
      const itemValue = parseNumber(item.value);
      if (itemValue != null && bestValue != null) {
        return itemValue > bestValue ? item : best;
      }
      if (itemValue != null) return item;
      return best;
    }, null);
  };

  const buildPreviewSummary = (detail = {}) => {
    const parts = [];
    if (detail.rowCount != null) {
      parts.push(`Rows: ${detail.rowCount}`);
    }
    if (detail.metrics?.cpu_load?.average != null) {
      const percent = formatPercent(detail.metrics.cpu_load.average, 0);
      if (percent) parts.push(`CPU avg ${percent}`);
    }
    if (detail.queryWindow) {
      const start = formatDate(detail.queryWindow.start);
      const end = formatDate(detail.queryWindow.end);
      if (start && end) {
        parts.push(`Window ${start}→${end}`);
      }
    }
    const pending = detail.queryResults?.find((qr) => qr.queryName === 'pendingJobsByPartition');
    if (pending?.sample?.length) {
      const sorted = pending.sample.slice().sort((a, b) => {
        const left = parseNumber(a.value) ?? 0;
        const right = parseNumber(b.value) ?? 0;
        return right - left;
      });
      const topPending = sorted[0];
      if (topPending) {
        const partition = topPending.metric?.partition ?? 'partition';
        const value = parseNumber(topPending.value) ?? topPending.value;
        parts.push(`Top pending ${partition}:${value}`);
      }
    }
    const cpuSat = detail.queryResults?.find((qr) => qr.queryName === 'partitionCpuSaturation');
    if (cpuSat?.sample?.length) {
      const sortedSat = cpuSat.sample.slice().sort((a, b) => {
        const left = parseNumber(a.value) ?? 0;
        const right = parseNumber(b.value) ?? 0;
        return right - left;
      });
      const topSat = sortedSat[0];
      if (topSat) {
        const partition = topSat.metric?.partition ?? '';
        const percent = formatPercent(parseNumber(topSat.value), 0) ?? topSat.value;
        parts.push(`CPU sat ${partition}:${percent}`);
      }
    }
    const hotGpuResult = detail.queryResults?.find((qr) => qr.queryName === 'hotGpusByTemperature');
    if (hotGpuResult?.sample?.length) {
      const topGpu = topSampleByValue(hotGpuResult.sample);
      if (topGpu) {
        const instance = topGpu.metric?.instance ?? '';
        const temp = parseNumber(topGpu.value) ?? topGpu.value;
        parts.push(`Hot GPU ${instance}:${temp}°C`);
      }
    }
    return parts.length ? parts.slice(0, 3).join(' · ') : 'Preview ready';
  };

  const emitResize = () => {
    const root = document.getElementById('app');
    if (!root || !window.MorphyBridge?.emit) return;
    const height = Math.max(root.scrollHeight, 420);
    window.MorphyBridge.emit('widget:resize', { height: Math.ceil(height) });
  };

  const render = (payload) => {
    if (!payload) return;
    const root = document.getElementById('app');
    if (!root) return;
    const widget = root.querySelector('.widget');
    if (!widget) return;

    const domain = payload.domain || {};
    const panel = payload.panel || {};
    const report = payload.report || {};
    const context = payload.context || {};
    const theme = payload.theme || {};

    const accent = theme?.palette?.primary || theme?.accent || domain?.color || '#6ee7b7';
    widget.style.setProperty('--accent-color', accent);

    const badge = widget.querySelector('[data-role="domain-badge"]');
    if (badge) {
      badge.textContent = domain.icon || (domain.name ? domain.name.slice(0, 2).toUpperCase() : 'CO');
    }

    const domainNameEl = widget.querySelector('[data-role="domain-name"]');
    if (domainNameEl) {
      domainNameEl.textContent = domain.name || 'Cluster Observability';
    }

    const panelTitleEl = widget.querySelector('[data-role="panel-title"]');
    if (panelTitleEl) {
      panelTitleEl.textContent = panel.title || 'Analytical Panel';
    }

    const panelSummaryEl = widget.querySelector('[data-role="panel-summary"]');
    if (panelSummaryEl) {
      panelSummaryEl.textContent = panel.summary || domain.description || '';
    }

    const chart = report.chart || {};
    const chartTitleEl = widget.querySelector('[data-role="chart-title"]');
    if (chartTitleEl) {
      chartTitleEl.textContent = chart.title || panel.title || 'Risk distribution';
    }

    const chartSubtitleEl = widget.querySelector('[data-role="chart-subtitle"]');
    if (chartSubtitleEl) {
      chartSubtitleEl.textContent = panel.analysisPrompt || panel.summary || '';
    }

    const chartScoreEl = widget.querySelector('[data-role="chart-score"]');
    const labels = Array.isArray(chart.labels) ? chart.labels : [];
    const rawValues = Array.isArray(chart.values) ? chart.values : [];
    const values = rawValues.map((value) => parseNumber(value) ?? 0);
    const hasChartData = labels.length && values.length;
    const chartBars = widget.querySelector('[data-role="chart-bars"]');
    if (chartBars) {
      chartBars.innerHTML = '';
      if (hasChartData) {
        const maxValue = Math.max(...values, 0.01);
        labels.slice(0, values.length).forEach((label, index) => {
          const value = values[index];
          const ratio = maxValue ? value / maxValue : 0;
          const row = document.createElement('div');
          row.className = 'bar-row';
          const meta = document.createElement('div');
          meta.className = 'bar-meta';
          const labelEl = document.createElement('span');
          labelEl.className = 'bar-label';
          labelEl.textContent = label;
          const valueEl = document.createElement('span');
          valueEl.className = 'bar-value';
          valueEl.textContent = `${(value * 100).toFixed(1)}%`;
          meta.append(labelEl, valueEl);
          const track = document.createElement('div');
          track.className = 'bar-track';
          const fill = document.createElement('div');
          fill.className = 'bar-fill';
          fill.style.width = `${Math.max(ratio * 100, 4)}%`;
          track.append(fill);
          row.append(meta, track);
          chartBars.append(row);
        });
        if (chartScoreEl) {
          const highestIndex = values.reduce((bestIndex, current, idx) =>
            current > (values[bestIndex] ?? 0) ? idx : bestIndex,
          0);
          const highestLabel = labels[highestIndex] || 'Highest risk';
          const highestValue = values[highestIndex] ?? 0;
          chartScoreEl.textContent = `${highestLabel} · ${(highestValue * 100).toFixed(1)}%`;
        }
      } else {
        const placeholder = document.createElement('p');
        placeholder.className = 'chart-empty';
        placeholder.textContent = 'Chart data unavailable';
        chartBars.append(placeholder);
        if (chartScoreEl) {
          chartScoreEl.textContent = 'Awaiting data';
        }
      }
    }

    const highlightsEl = widget.querySelector('[data-role="highlights-list"]');
    const highlights = Array.isArray(report.highlights) ? report.highlights : [];
    if (highlightsEl) {
      highlightsEl.innerHTML = '';
      if (highlights.length) {
        highlights.forEach((item) => {
          const li = document.createElement('li');
          li.textContent = item;
          highlightsEl.append(li);
        });
      } else {
        const li = document.createElement('li');
        li.textContent = 'No highlights available.';
        highlightsEl.append(li);
      }
    }

    const narrativeEl = widget.querySelector('[data-role="narrative"]');
    if (narrativeEl) {
      narrativeEl.innerHTML = '';
      const narrative = Array.isArray(report.narrative) ? report.narrative : [];
      if (narrative.length) {
        narrative.forEach((paragraph) => {
          const p = document.createElement('p');
          p.textContent = paragraph;
          narrativeEl.append(p);
        });
      } else {
        const p = document.createElement('p');
        p.textContent = 'Narrative pending.';
        narrativeEl.append(p);
      }
    }

    const contextGrid = widget.querySelector('[data-role="context-grid"]');
    if (contextGrid) {
      contextGrid.innerHTML = '';
      const previews = Array.isArray(context.previews) ? context.previews : [];
      const inventoryPreview = previews.find((item) => item.sourceId === 'cluster-inventory');
      const victoriaPreview = previews.find((item) => item.sourceId === 'victoria-cluster');
      const instrumentedResult = victoriaPreview?.detail?.queryResults?.find((qr) => qr.queryName === 'instrumentedHostCount');
      const instrumented = parseNumber(instrumentedResult?.sample?.[0]?.value);
      const pendingResult = victoriaPreview?.detail?.queryResults?.find((qr) => qr.queryName === 'pendingJobsByPartition');
      const pendingPartitions = pendingResult?.resultCount != null ? pendingResult.resultCount : pendingResult?.sample?.length;
      const hotGpuResult = victoriaPreview?.detail?.queryResults?.find((qr) => qr.queryName === 'hotGpusByTemperature');
      const hottestGpu = hotGpuResult?.sample?.length ? topSampleByValue(hotGpuResult.sample) : null;
      const hottestTemp = parseNumber(hottestGpu?.value);
      const stats = [];
      if (instrumented != null) {
        stats.push({ label: 'Instrumented hosts', value: instrumented.toString() });
      }
      if (inventoryPreview?.detail?.rowCount != null) {
        stats.push({ label: 'Inventory rows', value: inventoryPreview.detail.rowCount.toString() });
      }
      if (pendingPartitions != null) {
        stats.push({ label: 'Partitions w/ pending jobs', value: pendingPartitions.toString() });
      }
      if (hottestTemp != null) {
        const machine = hottestGpu?.metric?.instance ? `${hottestGpu.metric.instance}` : 'unknown instance';
        stats.push({ label: 'Hottest GPU', value: `${machine} ${hottestTemp}°C` });
      }
      if (context.previewCount != null) {
        stats.push({ label: 'Previews total', value: context.previewCount.toString() });
      }
      if (!stats.length) {
        const stat = document.createElement('div');
        stat.className = 'context-stat';
        const label = document.createElement('span');
        label.className = 'context-label';
        label.textContent = 'Context';
        const value = document.createElement('span');
        value.className = 'context-value';
        value.textContent = 'Awaiting data';
        stat.append(label, value);
        contextGrid.append(stat);
      } else {
        stats.forEach((statInfo) => {
          const stat = document.createElement('div');
          stat.className = 'context-stat';
          const label = document.createElement('span');
          label.className = 'context-label';
          label.textContent = statInfo.label;
          const value = document.createElement('span');
          value.className = 'context-value';
          value.textContent = statInfo.value;
          stat.append(label, value);
          contextGrid.append(stat);
        });
      }
    }

    const previewList = widget.querySelector('[data-role="preview-list"]');
    if (previewList) {
      previewList.innerHTML = '';
      const previews = Array.isArray(context.previews) ? context.previews : [];
      previews.forEach((preview) => {
        const card = document.createElement('article');
        card.className = 'preview-card';
        const header = document.createElement('div');
        header.className = 'preview-card__header';
        const title = document.createElement('span');
        title.className = 'preview-card__title';
        title.textContent = preview.sourceName || preview.sourceId || 'Data preview';
        const type = document.createElement('span');
        type.className = 'preview-card__type';
        type.textContent = preview.sourceType || 'source';
        header.append(title, type);
        const status = document.createElement('p');
        status.className = 'preview-card__status';
        status.textContent = `Status: ${preview.status || 'unknown'}`;
        const summary = document.createElement('p');
        summary.className = 'preview-card__summary';
        summary.textContent = buildPreviewSummary(preview.detail);
        card.append(header, status, summary);
        previewList.append(card);
      });
      if (!previews.length) {
        const placeholder = document.createElement('p');
        placeholder.textContent = 'No preview data yet.';
        previewList.append(placeholder);
      }
    }

    emitResize();
  };

  if (window.MorphyBridge) {
    window.MorphyBridge.onInit = render;
    window.MorphyBridge.onUpdate = render;
  }
})();