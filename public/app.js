const state = {
  appConfig: null,
  domains: [],
  dataSources: [],
  sourcePreviews: [],
  runs: [],
  widgets: [],
  workspacePlans: {},
  domainSnapshots: {},
  selectedDomainId: null,
  activePanelId: null,
  isStudioOpen: false,
  panelRunState: {}
};

const elements = {
  appName: document.querySelector("#app-name"),
  domainList: document.querySelector("#domain-list"),
  domainName: document.querySelector("#domain-name"),
  domainDescription: document.querySelector("#domain-description"),
  domainChip: document.querySelector("#domain-chip"),
  workspaceNote: document.querySelector("#workspace-note"),
  workspaceActions: document.querySelector("#workspace-actions"),
  panelRail: document.querySelector("#panel-rail"),
  panelStage: document.querySelector("#panel-stage"),
  runList: document.querySelector("#run-list"),
  sourcePreviewList: document.querySelector("#source-preview-list"),
  sourcePreviewSection: document.querySelector("#source-preview-section"),
  domainForm: document.querySelector("#domain-form"),
  domainPrompt: document.querySelector("#domain-prompt"),
  sourceForm: document.querySelector("#source-form"),
  agentStatus: document.querySelector("#agent-status"),
  refreshButton: document.querySelector("#refresh-button"),
  studioToggleButton: document.querySelector("#studio-toggle-button"),
  studioCloseButton: document.querySelector("#studio-close-button"),
  studioDrawer: document.querySelector("#studio-drawer"),
  studioOverlay: document.querySelector("#studio-overlay")
};

const panelTemplate = document.querySelector("#panel-card-template");
const runTemplate = document.querySelector("#run-card-template");
const STALE_RUN_MS = 5 * 60 * 1000;

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error ?? "Request failed.");
  }

  return response.status === 204 ? null : response.json();
}

function currentDomain() {
  return state.domains.find((domain) => domain.id === state.selectedDomainId) ?? null;
}

function getRunUpdatedAt(run) {
  return new Date(run.updatedAt || run.createdAt || 0).getTime();
}

function isStaleRun(run) {
  return run?.status === "in_progress" && Date.now() - getRunUpdatedAt(run) > STALE_RUN_MS;
}

function panelRuns(domainRuns, panelId) {
  return domainRuns.filter((run) => run.panelId === panelId);
}

function latestRenderableRun(domainRuns, panelId) {
  const candidates = panelRuns(domainRuns, panelId);
  return (
    candidates.find((run) => run.report) ??
    candidates.find((run) => run.status === "failed") ??
    candidates.find((run) => !isStaleRun(run)) ??
    candidates[0] ??
    null
  );
}

function activePanelRun(domainRuns, panelId) {
  return panelRuns(domainRuns, panelId).find((run) => run.status === "in_progress" && !isStaleRun(run)) ?? null;
}

function stalePanelRun(domainRuns, panelId) {
  return panelRuns(domainRuns, panelId).find((run) => run.status === "in_progress" && isStaleRun(run)) ?? null;
}

function failedPanelRun(domainRuns, panelId) {
  return panelRuns(domainRuns, panelId).find((run) => run.status === "failed") ?? null;
}

function latestWidgetRun(domainRuns, panelId) {
  return panelRuns(domainRuns, panelId).find((run) => run.widgetId) ?? null;
}

function visibleRunsForDomain(domainId) {
  return domainId ? state.runs.filter((run) => run.domainId === domainId) : state.runs;
}

function dedupeRunsForDisplay(runs) {
  const grouped = new Map();

  for (const run of runs) {
    const key = `${run.domainId}:${run.panelId}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(run);
  }

  return Array.from(grouped.values())
    .map((group) => {
      return (
        group.find((run) => run.status === "in_progress" && !isStaleRun(run)) ??
        group.find((run) => run.report) ??
        group.find((run) => run.status === "failed") ??
        group.find((run) => !isStaleRun(run)) ??
        group[0]
      );
    })
    .sort((left, right) => getRunUpdatedAt(right) - getRunUpdatedAt(left));
}

function setSelectedDomain(domainId) {
  state.selectedDomainId = domainId;
  const domain = currentDomain();
  state.activePanelId = state.workspacePlans[domainId]?.focusPanelId ?? state.domainSnapshots[domainId]?.workspacePlan?.focusPanelId ?? domain?.panels[0]?.id ?? null;
  renderDomains();
  renderCurrentDomain();
}

function renderDomains() {
  elements.domainList.innerHTML = "";

  for (const domain of state.domains) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `domain-button ${domain.id === state.selectedDomainId ? "active" : ""}`;
    button.innerHTML = `
      <div class="domain-dot" style="background: linear-gradient(135deg, ${domain.color || "#6ee7b7"}, rgba(245,165,36,0.88));">
        ${domain.icon || domain.name.slice(0, 2).toUpperCase()}
      </div>
      <div>
        <p class="section-label">${domain.dataSources.length} source(s)</p>
        <h3>${domain.name}</h3>
        <p class="source-description">${domain.description}</p>
      </div>
    `;
    button.addEventListener("click", () => setSelectedDomain(domain.id));
    elements.domainList.append(button);
  }
}

function renderSourcePreviews() {
  elements.sourcePreviewList.innerHTML = "";

  for (const preview of state.sourcePreviews) {
    const card = document.createElement("article");
    card.className = "source-card";
    const className = preview.status === "ready" ? "status-ready" : "status-warning";
    card.innerHTML = `
      <div class="run-meta">
        <div>
          <p class="section-label">${preview.sourceType}</p>
          <h3>${preview.sourceName}</h3>
        </div>
        <span class="${className}">${preview.status}</span>
      </div>
      <p class="source-description">${preview.detail.message || `Preview rows: ${preview.detail.rowCount ?? preview.detail.resultCount ?? 0}`}</p>
      <code>${preview.sourceId}</code>
    `;
    elements.sourcePreviewList.append(card);
  }
}

function renderAgentStatus(agent) {
  elements.agentStatus.innerHTML = `
    <p class="lede">Provider: <strong>${agent.mode}</strong></p>
    <p class="hint">${agent.hasApiKey ? "OpenAI API key detected. Background analysis uses the Responses API." : "No OpenAI API key detected. Local fallback reporting remains available."}</p>
  `;
}

function renderStudio() {
  if (!elements.studioDrawer || !elements.studioOverlay || !elements.studioToggleButton) {
    return;
  }

  elements.studioDrawer.hidden = !state.isStudioOpen;
  elements.studioDrawer.setAttribute("aria-hidden", state.isStudioOpen ? "false" : "true");
  elements.studioOverlay.hidden = !state.isStudioOpen;
  elements.studioToggleButton.textContent = state.isStudioOpen ? "Hide Studio" : "Studio";
  document.body.classList.toggle("studio-open", state.isStudioOpen);
}

function setStudioOpen(nextValue) {
  state.isStudioOpen = Boolean(nextValue);
  renderStudio();
}

function currentWorkspacePlan() {
  const domain = currentDomain();
  return domain ? state.workspacePlans[domain.id] ?? null : null;
}

function orderedPanelsForDomain(domain) {
  const workspacePlan = state.workspacePlans[domain.id] ?? null;
  const visiblePanelIds = workspacePlan?.visiblePanelIds?.filter((panelId) => domain.panels.some((panel) => panel.id === panelId));
  const orderedIds = visiblePanelIds?.length ? visiblePanelIds : domain.panels.map((panel) => panel.id);
  return orderedIds
    .map((panelId) => domain.panels.find((panel) => panel.id === panelId))
    .filter(Boolean);
}

function renderWorkspacePlan(workspacePlan) {
  elements.workspaceNote.textContent = workspacePlan?.rationale ?? "Workspace is following the default domain layout.";
  elements.workspaceActions.innerHTML = "";

  for (const action of workspacePlan?.recommendedActions ?? []) {
    const chip = document.createElement("span");
    chip.className = "workspace-action-chip";
    chip.textContent = action;
    elements.workspaceActions.append(chip);
  }

  if (!workspacePlan?.recommendedActions?.length) {
    const chip = document.createElement("span");
    chip.className = "workspace-action-chip muted";
    chip.textContent = "No immediate adaptation actions recommended.";
    elements.workspaceActions.append(chip);
  }

  if (elements.sourcePreviewSection) {
    elements.sourcePreviewSection.open = !(workspacePlan?.collapsedSections ?? []).includes("source-preview");
  }
  const recentRunsSection = document.querySelector("#recent-runs-section");
  if (recentRunsSection) {
    recentRunsSection.open = !(workspacePlan?.collapsedSections ?? []).includes("recent-runs");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderChart(chart) {
  const labels = Array.isArray(chart?.labels) ? chart.labels : [];
  const values = Array.isArray(chart?.values) ? chart.values : [];

  if (!labels.length || !values.length) {
    return `<p class="hint">No chart data available yet.</p>`;
  }

  const width = 360;
  const height = 220;
  const padding = 28;
  const max = Math.max(...values, 1);
  const formatValue = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return String(value);
    }
    return numeric % 1 === 0 ? `${numeric}` : numeric.toFixed(2);
  };
  const formatLabel = (label) => {
    const text = String(label);
    return text.length > 14 ? `${text.slice(0, 12)}..` : text;
  };

  if (chart.type === "line") {
    const step = labels.length > 1 ? (width - padding * 2) / (labels.length - 1) : 0;
    const points = values
      .map((value, index) => {
        const x = padding + step * index;
        const y = height - padding - ((height - padding * 2) * value) / max;
        return `${x},${y}`;
      })
      .join(" ");
    const dots = values
      .map((value, index) => {
        const x = padding + step * index;
        const y = height - padding - ((height - padding * 2) * value) / max;
        return `<circle class="dot" cx="${x}" cy="${y}" r="4"></circle>`;
      })
      .join("");
    const text = labels
      .map((label, index) => {
        const x = padding + step * index;
        return `<text class="chart-label" x="${x}" y="${height - 8}" text-anchor="middle">${escapeHtml(formatLabel(label))}</text>`;
      })
      .join("");

    return `
      <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.title || "Line chart")}">
        <line class="chart-axis" x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}"></line>
        <polyline class="line" points="${points}"></polyline>
        ${dots}
        ${text}
      </svg>
    `;
  }

  if (chart.type === "donut") {
    const total = values.reduce((sum, value) => sum + value, 0) || 1;
    let offset = 0;
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const palette = ["#6ee7b7", "#9be7ff", "#f5a524", "#fb7185", "#c084fc"];
    const segments = values
      .map((value, index) => {
        const dash = (value / total) * circumference;
        const segment = `
          <circle
            cx="90"
            cy="90"
            r="${radius}"
            fill="none"
            stroke="${palette[index % palette.length]}"
            stroke-width="18"
            stroke-dasharray="${dash} ${circumference - dash}"
            stroke-dashoffset="${-offset}"
            transform="rotate(-90 90 90)"
          ></circle>
        `;
        offset += dash;
        return segment;
      })
      .join("");
    const legend = labels
      .map((label, index) => `<text class="chart-label" x="190" y="${32 + index * 20}">${escapeHtml(label)}: ${values[index]}</text>`)
      .join("");

    return `
      <svg class="chart" viewBox="0 0 360 180" role="img" aria-label="${escapeHtml(chart.title || "Donut chart")}">
        <circle cx="90" cy="90" r="${radius}" fill="none" stroke="rgba(148,163,184,0.12)" stroke-width="18"></circle>
        ${segments}
        ${legend}
      </svg>
    `;
  }

  const barHeight = 24;
  const gap = 14;
  const chartHeight = Math.max(220, labels.length * (barHeight + gap) + 36);
  const labelX = 10;
  const barX = 150;
  const valueX = width - 8;
  const barWidth = valueX - barX - 38;
  const rows = labels
    .map((label, index) => {
      const numeric = Number(values[index] ?? 0);
      const y = 18 + index * (barHeight + gap);
      const fillWidth = Math.max(6, (numeric / max) * barWidth);
      return `
        <text class="chart-row-label" x="${labelX}" y="${y + 16}">${escapeHtml(formatLabel(label))}</text>
        <rect class="chart-bar-track" x="${barX}" y="${y}" rx="8" ry="8" width="${barWidth}" height="${barHeight}"></rect>
        <rect class="chart-bar-fill" x="${barX}" y="${y}" rx="8" ry="8" width="${fillWidth}" height="${barHeight}"></rect>
        <text class="chart-value-label" x="${valueX}" y="${y + 16}" text-anchor="end">${escapeHtml(formatValue(numeric))}</text>
      `;
    })
    .join("");

  return `
    <svg class="chart bar-chart" viewBox="0 0 ${width} ${chartHeight}" role="img" aria-label="${escapeHtml(chart.title || "Bar chart")}">
      <defs>
        <linearGradient id="barFillGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#6ee7b7"></stop>
          <stop offset="100%" stop-color="#9be7ff"></stop>
        </linearGradient>
      </defs>
      ${rows}
    </svg>
  `;
}

function renderPlaceholderChart(kind = "bar") {
  if (kind === "line") {
    return `
      <svg class="chart placeholder-chart" viewBox="0 0 360 220" role="img" aria-label="Placeholder line chart">
        <line class="chart-axis" x1="28" y1="188" x2="332" y2="188"></line>
        <polyline class="line placeholder-line" points="28,164 88,132 148,146 208,98 268,114 332,68"></polyline>
        <circle class="dot" cx="28" cy="164" r="4"></circle>
        <circle class="dot" cx="88" cy="132" r="4"></circle>
        <circle class="dot" cx="148" cy="146" r="4"></circle>
        <circle class="dot" cx="208" cy="98" r="4"></circle>
        <circle class="dot" cx="268" cy="114" r="4"></circle>
        <circle class="dot" cx="332" cy="68" r="4"></circle>
      </svg>
    `;
  }

  if (kind === "donut") {
    return `
      <svg class="chart placeholder-chart" viewBox="0 0 360 180" role="img" aria-label="Placeholder donut chart">
        <circle cx="90" cy="90" r="52" fill="none" stroke="rgba(148,163,184,0.14)" stroke-width="18"></circle>
        <circle cx="90" cy="90" r="52" fill="none" stroke="#6ee7b7" stroke-width="18" stroke-dasharray="110 216" transform="rotate(-90 90 90)"></circle>
        <circle cx="90" cy="90" r="52" fill="none" stroke="#9be7ff" stroke-width="18" stroke-dasharray="56 270" stroke-dashoffset="-110" transform="rotate(-90 90 90)"></circle>
        <circle cx="90" cy="90" r="52" fill="none" stroke="#f5a524" stroke-width="18" stroke-dasharray="38 288" stroke-dashoffset="-166" transform="rotate(-90 90 90)"></circle>
      </svg>
    `;
  }

  return `
    <div class="hbar-chart placeholder-chart" role="img" aria-label="Placeholder bar chart">
      <div class="hbar-row">
        <div class="hbar-label">Signal A</div>
        <div class="hbar-track"><div class="hbar-fill" style="width: 86%"></div></div>
        <div class="hbar-value">86</div>
      </div>
      <div class="hbar-row">
        <div class="hbar-label">Signal B</div>
        <div class="hbar-track"><div class="hbar-fill" style="width: 62%"></div></div>
        <div class="hbar-value">62</div>
      </div>
      <div class="hbar-row">
        <div class="hbar-label">Signal C</div>
        <div class="hbar-track"><div class="hbar-fill" style="width: 41%"></div></div>
        <div class="hbar-value">41</div>
      </div>
    </div>
  `;
}

function widgetPayload(run, domain, panel) {
  return {
    runId: run.id,
    domain,
    panel,
    report: run.report,
    context: run.context,
    theme: {
      accent: domain.color || "#6ee7b7",
      background: "#07111d",
      panel: "#101826"
    }
  };
}

function renderVisualization(run, domain, panel, widgetRun = null) {
  const nativeChart = `
    <div class="native-chart-shell">
      ${run?.report?.chart ? renderChart(run.report.chart) : renderPlaceholderChart(panel.chartPreference)}
    </div>
  `;

  const widgetSourceRun = widgetRun?.widgetId ? widgetRun : run?.widgetId ? run : null;

  if (!widgetSourceRun?.widgetId) {
    return `<div class="chart-stack">${nativeChart}</div>`;
  }

  return `
    <div class="chart-stack">
      ${nativeChart}
      <div class="widget-host">
        <p class="widget-caption">Generated browser widget served from the artifact runtime.</p>
        <iframe
          class="widget-frame"
          title="${escapeHtml(panel.title)}"
          src="/generated/widgets/${encodeURIComponent(widgetSourceRun.widgetId)}"
          sandbox="allow-scripts"
          data-widget-id="${escapeHtml(widgetSourceRun.widgetId)}"
          data-run-id="${escapeHtml(widgetSourceRun.id)}"
          data-domain-id="${escapeHtml(domain.id)}"
          data-panel-id="${escapeHtml(panel.id)}"
          data-session-id="${escapeHtml(`${widgetSourceRun.widgetId}:${widgetSourceRun.id}`)}"
        ></iframe>
        <p class="widget-note">If the generated widget is sparse, the native chart above is the guaranteed fallback visualization.</p>
      </div>
    </div>
  `;
}

function postToWidgetFrame(frame, type = "init") {
  const run = state.runs.find((entry) => entry.id === frame.dataset.runId);
  const domain = state.domains.find((entry) => entry.id === frame.dataset.domainId);
  const panel = domain?.panels.find((entry) => entry.id === frame.dataset.panelId);

  if (!run || !domain || !panel || !frame.contentWindow) {
    return;
  }

  frame.contentWindow.postMessage(
    {
      source: "morphy-host",
      type,
      sessionId: frame.dataset.sessionId,
      payload: widgetPayload(run, domain, panel)
    },
    "*"
  );
}

function bindWidgetFrames() {
  document.querySelectorAll(".widget-frame").forEach((frame) => {
    if (frame.dataset.bound === "true") {
      return;
    }

    frame.dataset.bound = "true";
    frame.addEventListener("load", () => {
      postToWidgetFrame(frame, "init");
    });

    window.setTimeout(() => {
      postToWidgetFrame(frame, "init");
    }, 0);

    window.setTimeout(() => {
      postToWidgetFrame(frame, "update");
    }, 250);
  });
}

function renderCurrentDomain() {
  const domain = currentDomain();

  if (!domain) {
    elements.domainName.textContent = "Select a domain";
    elements.domainDescription.textContent = "Upload or generate a domain description to project a specialized analytics UI.";
    elements.domainChip.textContent = "No domain";
    elements.workspaceNote.textContent = "";
    elements.workspaceActions.innerHTML = "";
    elements.panelRail.innerHTML = "";
    elements.panelStage.innerHTML = `<p class="hint">No domain selected.</p>`;
    return;
  }

  const workspacePlan = currentWorkspacePlan();
  const orderedPanels = orderedPanelsForDomain(domain);

  if (!orderedPanels.some((panel) => panel.id === state.activePanelId)) {
    state.activePanelId = workspacePlan?.focusPanelId && orderedPanels.some((panel) => panel.id === workspacePlan.focusPanelId)
      ? workspacePlan.focusPanelId
      : orderedPanels[0]?.id ?? null;
  }

  elements.domainName.textContent = domain.name;
  elements.domainDescription.textContent = domain.description;
  elements.domainChip.textContent = `${domain.panels.length} panels`;
  elements.panelRail.innerHTML = "";
  elements.panelStage.innerHTML = "";
  renderWorkspacePlan(workspacePlan);

  const domainRuns = visibleRunsForDomain(domain.id);
  const panelGroups = workspacePlan?.panelGroups?.filter((group) => group.panelIds.some((panelId) => orderedPanels.some((panel) => panel.id === panelId))) ?? [];
  const renderedGroupIds = new Set();

  for (const panel of orderedPanels) {
    const matchingGroup = panelGroups.find((group) => group.panelIds.includes(panel.id));
    if (matchingGroup && !renderedGroupIds.has(matchingGroup.id)) {
      const label = document.createElement("div");
      label.className = "panel-group-label";
      label.textContent = matchingGroup.title;
      elements.panelRail.append(label);
      renderedGroupIds.add(matchingGroup.id);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = `panel-rail-button ${panel.id === state.activePanelId ? "active" : ""}`;
    button.innerHTML = `
      <span class="panel-rail-meta">
        <span class="section-label">${panel.chartPreference}</span>
        <strong>${panel.title}</strong>
      </span>
      <span class="panel-rail-summary">${panel.summary}</span>
    `;
    button.addEventListener("click", () => {
      state.activePanelId = panel.id;
      renderCurrentDomain();
    });
    elements.panelRail.append(button);
  }

  const panel = orderedPanels.find((entry) => entry.id === state.activePanelId) ?? orderedPanels[0];

  if (!panel) {
    elements.panelStage.innerHTML = `<p class="hint">No panels are defined for this domain.</p>`;
    return;
  }

  const node = panelTemplate.content.firstElementChild.cloneNode(true);
  const panelKey = `${domain.id}:${panel.id}`;
  const transientState = state.panelRunState[panelKey] ?? null;
  node.querySelector(".panel-kicker").textContent = panel.chartPreference;
  node.querySelector(".panel-title").textContent = panel.title;
  node.querySelector(".panel-summary").textContent = panel.summary;
  const latestRun = latestRenderableRun(domainRuns, panel.id);
  const widgetRun = latestWidgetRun(domainRuns, panel.id);
  const activeRun = activePanelRun(domainRuns, panel.id);
  const staleRun = stalePanelRun(domainRuns, panel.id);
  const failedRun = failedPanelRun(domainRuns, panel.id);
  const runButton = node.querySelector(".run-button");
  const forceRunButton = node.querySelector(".force-run-button");
  node.querySelector(".chart-title").textContent = (latestRun?.widgetId || widgetRun?.widgetId)
    ? "Generated Browser Visualization"
    : latestRun?.report?.chart?.title || "Awaiting chart output";
  node.querySelector(".chart-target").innerHTML = renderVisualization(latestRun, domain, panel, widgetRun);
  node.querySelector(".report-shell").innerHTML = latestRun?.report
    ? `
      ${latestRun.report.narrative.map((entry) => `<p>${escapeHtml(entry)}</p>`).join("")}
      ${latestRun.report.highlights.length ? `<ul>${latestRun.report.highlights.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : ""}
    `
    : transientState?.status === "starting"
      ? `<p class="hint">Starting analysis run...</p>`
    : activeRun?.status === "in_progress"
      ? `<p class="hint">Analysis is running. Results will appear when the server-side agent completes.</p>`
    : staleRun
      ? `<p class="hint">A previous analysis run appears stale. Run analysis again to start a fresh job.</p>`
    : failedRun
      ? `<p class="hint">Analysis failed${failedRun.error ? `: ${escapeHtml(failedRun.error)}` : "."}</p>`
    : `<p class="hint">Run analysis to populate this panel.</p>`;
  runButton.disabled = transientState?.status === "starting" || activeRun?.status === "in_progress";
  runButton.textContent = transientState?.status === "starting"
    ? "Starting..."
    : activeRun?.status === "in_progress"
      ? "Running..."
      : "Run Analysis";
  forceRunButton.disabled = transientState?.status === "starting" || activeRun?.status === "in_progress";
  forceRunButton.textContent = transientState?.status === "starting"
    ? "Starting..."
    : activeRun?.status === "in_progress"
      ? "Running..."
      : "Force Re-run";
  runButton.addEventListener("click", () => runAnalysis(domain.id, panel.id, false));
  forceRunButton.addEventListener("click", () => runAnalysis(domain.id, panel.id, true));
  elements.panelStage.append(node);

  bindWidgetFrames();
}

function renderRuns() {
  elements.runList.innerHTML = "";

  if (!state.runs.length) {
    elements.runList.innerHTML = `<p class="hint">No analysis runs yet.</p>`;
    return;
  }

  const domain = currentDomain();
  const dedupedRuns = dedupeRunsForDisplay(visibleRunsForDomain(domain?.id ?? null));

  if (!dedupedRuns.length) {
    elements.runList.innerHTML = `<p class="hint">No analysis runs yet for the selected domain.</p>`;
    return;
  }

  for (const run of dedupedRuns.slice(0, 8)) {
    const node = runTemplate.content.firstElementChild.cloneNode(true);
    const domain = state.domains.find((entry) => entry.id === run.domainId);
    node.querySelector(".run-domain").textContent = domain?.name || run.domainId;
    node.querySelector(".run-title").textContent = run.panelTitle;
    node.querySelector(".status-pill").textContent = run.status;
    node.querySelector(".run-report").innerHTML = run.report
      ? `
        ${run.report.narrative.map((entry) => `<p>${escapeHtml(entry)}</p>`).join("")}
        ${run.report.highlights.length ? `<ul>${run.report.highlights.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : ""}
      `
      : `<p class="hint">Awaiting completion.</p>`;
    elements.runList.append(node);
  }
}

async function refresh() {
  const payload = await request("/api/bootstrap");
  state.appConfig = payload.appConfig;
  state.domains = payload.domains;
  state.dataSources = payload.dataSources;
  state.sourcePreviews = payload.sourcePreviews;
  state.runs = payload.runs;
  state.widgets = payload.widgets;
  state.domainSnapshots = payload.domainSnapshots ?? {};
  state.workspacePlans = {
    ...(payload.workspacePlans ?? {})
  };
  for (const snapshot of Object.values(state.domainSnapshots)) {
    if (snapshot?.workspacePlan) {
      state.workspacePlans[snapshot.domainId] = snapshot.workspacePlan;
    }
  }
  const preferredDomainId = payload.appConfig.app?.defaultDomainId ?? null;

  if (!state.selectedDomainId && preferredDomainId && state.domains.some((domain) => domain.id === preferredDomainId)) {
    state.selectedDomainId = preferredDomainId;
  } else if (!state.selectedDomainId && state.domains.length) {
    state.selectedDomainId = state.domains[0].id;
  } else if (state.selectedDomainId && !state.domains.some((domain) => domain.id === state.selectedDomainId)) {
    state.selectedDomainId = preferredDomainId && state.domains.some((domain) => domain.id === preferredDomainId)
      ? preferredDomainId
      : state.domains[0]?.id ?? null;
  }

  const selectedDomain = currentDomain();
  const workspacePlan = selectedDomain ? state.workspacePlans[selectedDomain.id] ?? null : null;
  if (!selectedDomain?.panels.some((panel) => panel.id === state.activePanelId)) {
    state.activePanelId = workspacePlan?.focusPanelId ?? selectedDomain?.panels[0]?.id ?? null;
  }

  elements.appName.textContent = payload.appConfig.app?.name || "Morphy";
  renderAgentStatus(payload.agent);
  renderDomains();
  renderSourcePreviews();
  renderCurrentDomain();
  renderRuns();
  renderStudio();
  void reconcileStaleRuns();
}

async function createDomain(event) {
  event.preventDefault();
  const prompt = elements.domainPrompt.value.trim();
  if (!prompt) {
    return;
  }

  const domain = await request("/api/domains/generate", {
    method: "POST",
    body: JSON.stringify({ prompt })
  });

  elements.domainPrompt.value = "";
  await refresh();
  setSelectedDomain(domain.id);
  setStudioOpen(false);
}

async function createDataSource(event) {
  event.preventDefault();

  let extraConfig = {};
  const raw = document.querySelector("#source-config").value.trim();

  if (raw) {
    extraConfig = JSON.parse(raw);
  }

  await request("/api/data-sources", {
    method: "POST",
    body: JSON.stringify({
      id: document.querySelector("#source-id").value.trim(),
      name: document.querySelector("#source-name").value.trim(),
      type: document.querySelector("#source-type").value,
      ...extraConfig
    })
  });

  elements.sourceForm.reset();
  await refresh();
  setStudioOpen(false);
}

async function runAnalysis(domainId, panelId, force = false) {
  const panelKey = `${domainId}:${panelId}`;
  state.panelRunState[panelKey] = { status: "starting", force };
  renderCurrentDomain();

  const run = await request("/api/analysis/run", {
    method: "POST",
    body: JSON.stringify({ domainId, panelId, force })
  });
  delete state.panelRunState[panelKey];
  state.runs = [run, ...state.runs.filter((entry) => entry.id !== run.id)].sort(
    (left, right) => new Date(right.updatedAt) - new Date(left.updatedAt)
  );
  renderCurrentDomain();
  renderRuns();

  if (run.status === "in_progress") {
    await pollRun(run.id);
  } else {
    await refresh();
  }
}

async function pollRun(runId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    const run = await request(`/api/analysis/${encodeURIComponent(runId)}`);
    state.runs = [run, ...state.runs.filter((entry) => entry.id !== run.id)].sort(
      (left, right) => new Date(right.updatedAt) - new Date(left.updatedAt)
    );
    renderCurrentDomain();
    renderRuns();

    if (run.status === "completed" || run.status === "failed") {
      return run;
    }
  }

  return null;
}

async function reconcileStaleRuns() {
  const staleRuns = state.runs.filter((run) => isStaleRun(run)).slice(0, 6);

  if (!staleRuns.length) {
    return;
  }

  await Promise.allSettled(
    staleRuns.map(async (run) => {
      const nextRun = await request(`/api/analysis/${encodeURIComponent(run.id)}`);
      state.runs = [nextRun, ...state.runs.filter((entry) => entry.id !== nextRun.id)].sort(
        (left, right) => getRunUpdatedAt(right) - getRunUpdatedAt(left)
      );
    })
  );

  renderCurrentDomain();
  renderRuns();
}

async function ensureWorkspacePlan() {
  const domain = currentDomain();

  if (!domain) {
    return;
  }

  const workspacePlan = state.workspacePlans[domain.id] ?? null;
  const planAgeMs = workspacePlan?.updatedAt ? Date.now() - new Date(workspacePlan.updatedAt).getTime() : Infinity;

  if (workspacePlan && planAgeMs < 5 * 60 * 1000) {
    return;
  }

  const nextPlan = await request("/api/workspace/plan", {
    method: "POST",
    body: JSON.stringify({
      domainId: domain.id,
      preferredPanelId: state.activePanelId,
      reason: workspacePlan ? "stale-refresh" : "bootstrap"
    })
  });

  state.workspacePlans[domain.id] = nextPlan;
  if (!state.activePanelId || !nextPlan.visiblePanelIds?.includes(state.activePanelId)) {
    state.activePanelId = nextPlan.focusPanelId;
  }
  renderCurrentDomain();
}

async function requestDomainRefresh(force = false) {
  const domain = currentDomain();

  if (!domain) {
    await refresh();
    return;
  }

  await request("/api/refresh/domain", {
    method: "POST",
    body: JSON.stringify({
      domainId: domain.id,
      force
    })
  });
  await refresh();
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("run.update", (event) => {
    const run = JSON.parse(event.data);
    state.runs = [run, ...state.runs.filter((entry) => entry.id !== run.id)].sort(
      (left, right) => new Date(right.updatedAt) - new Date(left.updatedAt)
    );
    renderCurrentDomain();
    renderRuns();
  });
  events.addEventListener("workspace.update", (event) => {
    const workspacePlan = JSON.parse(event.data);
    state.workspacePlans[workspacePlan.domainId] = workspacePlan;

    if (workspacePlan.domainId === state.selectedDomainId && (!state.activePanelId || !workspacePlan.visiblePanelIds?.includes(state.activePanelId))) {
      state.activePanelId = workspacePlan.focusPanelId;
    }

    renderCurrentDomain();
  });
  events.addEventListener("domain.refresh", (event) => {
    const snapshot = JSON.parse(event.data);
    state.domainSnapshots[snapshot.domainId] = snapshot;
    if (snapshot.workspacePlan) {
      state.workspacePlans[snapshot.domainId] = snapshot.workspacePlan;
    }
    if (state.selectedDomainId === snapshot.domainId) {
      if (!state.activePanelId || !snapshot.workspacePlan?.visiblePanelIds?.includes(state.activePanelId)) {
        state.activePanelId = snapshot.workspacePlan?.focusPanelId ?? state.activePanelId;
      }
      if (snapshot.context?.previews?.length) {
        state.sourcePreviews = state.sourcePreviews
          .filter((preview) => !snapshot.context.previews.some((nextPreview) => nextPreview.sourceId === preview.sourceId))
          .concat(snapshot.context.previews);
      }
    }
    renderSourcePreviews();
    renderCurrentDomain();
  });
}

window.addEventListener("message", (event) => {
  const message = event.data;

  if (!message || message.source !== "morphy-widget") {
    return;
  }

  const frame = Array.from(document.querySelectorAll(".widget-frame")).find((candidate) => {
    if (candidate.contentWindow === event.source) {
      return true;
    }
    return candidate.dataset.sessionId === message.sessionId;
  });

  if (!frame) {
    return;
  }

  if (message.type === "widget:bootstrap") {
    postToWidgetFrame(frame, "init");
  }

  if (message.type === "widget:ready") {
    postToWidgetFrame(frame, "update");
  }

  if (message.type === "widget:resize") {
    const nextHeight = Math.max(240, Number(message.payload?.height) || 240);
    frame.style.height = `${nextHeight}px`;
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.isStudioOpen) {
    setStudioOpen(false);
  }
});

elements.domainForm.addEventListener("submit", (event) => {
  createDomain(event).catch((error) => window.alert(error.message));
});

elements.sourceForm.addEventListener("submit", (event) => {
  createDataSource(event).catch((error) => window.alert(error.message));
});

elements.refreshButton.addEventListener("click", () => {
  requestDomainRefresh(false).catch((error) => window.alert(error.message));
});

elements.studioToggleButton?.addEventListener("click", () => {
  setStudioOpen(!state.isStudioOpen);
});

elements.studioCloseButton?.addEventListener("click", () => {
  setStudioOpen(false);
});

elements.studioOverlay?.addEventListener("click", () => {
  setStudioOpen(false);
});

await refresh();
connectEvents();
setInterval(() => {
  refresh().catch(() => {});
}, 15000);
