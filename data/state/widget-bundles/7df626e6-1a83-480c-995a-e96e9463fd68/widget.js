(function() {
  const safeEmit = function(eventName, detail) {
    if (window.MorphyBridge && typeof window.MorphyBridge.emit === 'function') {
      window.MorphyBridge.emit(eventName, detail);
    }
  };

  const formatWindowRange = function(queryWindow) {
    if (!queryWindow) {
      return '—';
    }
    var start = queryWindow.start ? queryWindow.start.slice(0, 10) : '';
    var end = queryWindow.end ? queryWindow.end.slice(0, 10) : '';
    if (start && end) {
      return start + ' → ' + end;
    }
    return start || end || '—';
  };

  var setText = function(root, selector, value) {
    var element = root.querySelector(selector);
    if (element) {
      element.textContent = value || '—';
    }
  };

  var populateList = function(root, selector, items, fallback) {
    var container = root.querySelector(selector);
    if (!container) {
      return;
    }
    container.innerHTML = '';
    var entries = items && items.length ? items : [fallback];
    entries.forEach(function(item) {
      var entry = document.createElement('li');
      entry.textContent = item;
      container.appendChild(entry);
    });
  };

  var buildChart = function(root, chart) {
    var chartContainer = root.querySelector('[data-chart]');
    if (!chartContainer) {
      return;
    }
    chartContainer.innerHTML = '';
    if (!chart) {
      chartContainer.innerHTML = '<div class=chart-empty>No coverage information is available for this preview.</div>';
      return;
    }
    var labels = Array.isArray(chart.labels) ? chart.labels : [];
    var values = Array.isArray(chart.values) ? chart.values : [];
    var rows = labels.map(function(label, index) {
      var rawValue = Number(values[index] != null ? values[index] : 0);
      var value = Number.isFinite(rawValue) ? rawValue : 0;
      return {
        label: label,
        value: value
      };
    });
    if (!rows.length) {
      chartContainer.innerHTML = '<div class=chart-empty>No coverage information is available for this preview.</div>';
      return;
    }
    var maxValue = rows.reduce(function(memo, row) {
      return Math.max(memo, row.value);
    }, 0) || 1;
    rows.forEach(function(row) {
      var bar = document.createElement('div');
      bar.className = 'chart-bar';
      var content = document.createElement('div');
      content.className = 'chart-bar-content';
      var name = document.createElement('span');
      name.className = 'chart-bar-name';
      name.textContent = row.label;
      var track = document.createElement('div');
      track.className = 'chart-bar-track';
      var fill = document.createElement('span');
      fill.className = 'chart-bar-fill';
      var percent = maxValue > 0 ? (row.value / maxValue) * 100 : 0;
      fill.style.width = Math.min(Math.max(percent, 0), 100) + '%';
      fill.setAttribute('aria-hidden', 'true');
      track.appendChild(fill);
      content.appendChild(name);
      content.appendChild(track);
      var valueLabel = document.createElement('span');
      valueLabel.className = 'chart-bar-value';
      valueLabel.textContent = row.value.toLocaleString('en-US', {
        maximumFractionDigits: row.value % 1 === 0 ? 0 : 2
      });
      bar.appendChild(content);
      bar.appendChild(valueLabel);
      chartContainer.appendChild(bar);
    });
  };

  var render = function(payload) {
    if (!payload) {
      return;
    }
    var root = document.getElementById('app');
    if (!root) {
      return;
    }
    var widgetRoot = root.querySelector('.widget-root') || root;
    var report = payload.report || {};
    var panel = payload.panel || {};
    var domain = payload.domain || {};
    var context = payload.context || {};
    var preview = Array.isArray(context.previews) ? context.previews[0] : null;
    var queryWindow = preview && preview.detail ? preview.detail.queryWindow : null;
    widgetRoot.style.setProperty('--accent-color', domain.color || '#8df0c6');
    var chartKind = (report.chart && report.chart.type) || panel.chartPreference || 'bar';
    setText(widgetRoot, '[data-domain-name]', domain.name || 'Domain');
    setText(widgetRoot, '[data-panel-title]', panel.title || 'Fabric And Storage');
    setText(widgetRoot, '[data-panel-summary]', panel.summary || '');
    setText(widgetRoot, '[data-chart-title]', (report.chart && report.chart.title) || panel.title || 'Fabric/Storage Signal Coverage');
    setText(widgetRoot, '[data-chart-meta]', chartKind.toString().toUpperCase() + ' overview');
    setText(widgetRoot, '[data-context-window]', formatWindowRange(queryWindow));
    var narrativeSource = Array.isArray(report.narrative) ? report.narrative : [];
    var narrative = [];
    narrativeSource.forEach(function(entry) {
      if (!entry) {
        return;
      }
      entry.split(/\n{2,}/).forEach(function(part) {
        var trimmed = part.trim();
        if (trimmed) {
          narrative.push(trimmed);
        }
      });
    });
    populateList(widgetRoot, '[data-narrative]', narrative, 'Narrative details are not available for this preview.');
    var highlightSource = Array.isArray(report.highlights) ? report.highlights : (report.highlights ? [report.highlights] : []);
    populateList(widgetRoot, '[data-highlights]', highlightSource, 'No highlights were provided for this run.');
    buildChart(widgetRoot, report.chart);
  };

  var scheduleResize = function() {
    requestAnimationFrame(function() {
      var root = document.getElementById('app');
      if (!root) {
        return;
      }
      safeEmit('widget:resize', {
        height: Math.max(root.scrollHeight, 420)
      });
    });
  };

  var handlePayload = function(payload) {
    render(payload);
    scheduleResize();
  };

  if (window.MorphyBridge) {
    window.MorphyBridge.onInit(handlePayload);
    window.MorphyBridge.onUpdate(handlePayload);
  }
})();