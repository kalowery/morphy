import { createBrowserLogger } from "./runtime/logger.js";

const state = {
  appConfig: null,
  domains: [],
  dataSources: [],
  sourcePreviews: [],
  runs: [],
  widgets: [],
  workspacePlans: {},
  derivedToolRegistries: {},
  domainSnapshots: {},
  selectedDomainId: null,
  activePanelId: null,
  isStudioOpen: false,
  panelRunState: {},
  widgetInteractionLocks: {},
  widgetInteractionState: {},
  sectionOverrides: {},
  bootstrapSignature: null,
  currentDomainRenderSignature: null,
  currentPanelStageSignature: null,
  spendSummary: null
};

const elements = {
  appName: document.querySelector("#app-name"),
  domainList: document.querySelector("#domain-list"),
  domainName: document.querySelector("#domain-name"),
  domainDescription: document.querySelector("#domain-description"),
  domainChip: document.querySelector("#domain-chip"),
  workspaceNote: document.querySelector("#workspace-note"),
  workspaceActions: document.querySelector("#workspace-actions"),
  workspaceToolTrace: document.querySelector("#workspace-tool-trace"),
  panelRail: document.querySelector("#panel-rail"),
  panelStage: document.querySelector("#panel-stage"),
  runList: document.querySelector("#run-list"),
  sourcePreviewList: document.querySelector("#source-preview-list"),
  sourcePreviewSection: document.querySelector("#source-preview-section"),
  domainForm: document.querySelector("#domain-form"),
  domainPrompt: document.querySelector("#domain-prompt"),
  sourceForm: document.querySelector("#source-form"),
  agentStatus: document.querySelector("#agent-status"),
  spendSummary: document.querySelector("#spend-summary"),
  domainContextSummary: document.querySelector("#domain-context-summary"),
  deleteDomainButton: document.querySelector("#delete-domain-button"),
  toolRegistrySummary: document.querySelector("#tool-registry-summary"),
  resetSpendButton: document.querySelector("#reset-spend-button"),
  refreshButton: document.querySelector("#refresh-button"),
  studioToggleButton: document.querySelector("#studio-toggle-button"),
  studioCloseButton: document.querySelector("#studio-close-button"),
  studioDrawer: document.querySelector("#studio-drawer"),
  studioOverlay: document.querySelector("#studio-overlay")
};

const panelTemplate = document.querySelector("#panel-card-template");
const runTemplate = document.querySelector("#run-card-template");
const STALE_RUN_MS = 5 * 60 * 1000;
const WIDGET_INTERACTION_LOCK_MS = 2 * 60 * 1000;
const logger = createBrowserLogger("app");

async function request(url, options = {}) {
  const method = options.method ?? "GET";
  logger.debug("Request started", { url, method }, "network");
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    logger.warn("Request failed", {
      url,
      method,
      status: response.status,
      error: payload.error ?? response.statusText
    }, "network");
    throw new Error(payload.error ?? "Request failed.");
  }

  logger.debug("Request completed", { url, method, status: response.status }, "network");
  return response.status === 204 ? null : response.json();
}

function currentDomain() {
  return state.domains.find((domain) => domain.id === state.selectedDomainId) ?? null;
}

function formatUsd(value) {
  const numeric = Number(value ?? 0);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: numeric < 1 ? 4 : 2,
    maximumFractionDigits: numeric < 1 ? 4 : 2
  }).format(numeric);
}

function summarizePanelSpend(domainId, panelId, archetypeId = null) {
  const source = archetypeId ? (state.spendSummary?.byPanelArchetype ?? []) : (state.spendSummary?.byPanel ?? []);
  return source
    .filter((entry) => entry.domainId === domainId && entry.panelId === panelId && (!archetypeId || entry.archetypeId === archetypeId))
    .reduce(
      (summary, entry) => ({
        totalUsd: summary.totalUsd + Number(entry.cost?.totalUsd ?? 0),
        inputUsd: summary.inputUsd + Number(entry.cost?.inputUsd ?? 0),
        cachedInputUsd: summary.cachedInputUsd + Number(entry.cost?.cachedInputUsd ?? 0),
        outputUsd: summary.outputUsd + Number(entry.cost?.outputUsd ?? 0),
        entries: summary.entries + Number(entry.entries ?? 0)
      }),
      { totalUsd: 0, inputUsd: 0, cachedInputUsd: 0, outputUsd: 0, entries: 0 }
    );
}

function currentRunSpend(run) {
  const matchingEntries = (state.spendSummary?.recentEntries ?? []).filter((entry) => entry.runId === run?.id);
  const derivedArchetypeUsd = matchingEntries
    .filter((entry) => entry.operation === "archetype_selection")
    .reduce((sum, entry) => sum + Number(entry.cost?.totalUsd ?? 0), 0);
  const derivedAnalysisUsd = matchingEntries
    .filter((entry) => entry.operation === "panel_analysis")
    .reduce((sum, entry) => sum + Number(entry.cost?.totalUsd ?? 0), 0);
  const derivedWidgetUsd = matchingEntries
    .filter((entry) => entry.operation === "widget_generation")
    .reduce((sum, entry) => sum + Number(entry.cost?.totalUsd ?? 0), 0);
  const archetypeUsd = Number(run?.archetypeCost?.totalUsd ?? derivedArchetypeUsd ?? 0);
  const analysisUsd = Number(run?.analysisCost?.totalUsd ?? derivedAnalysisUsd ?? 0);
  const widgetUsd = Number(run?.widgetCost?.totalUsd ?? derivedWidgetUsd ?? 0);
  return {
    archetypeUsd,
    analysisUsd,
    widgetUsd,
    totalUsd: archetypeUsd + analysisUsd + widgetUsd
  };
}

function getRunUpdatedAt(run) {
  return new Date(run.updatedAt || run.createdAt || 0).getTime();
}

function isStaleRun(run) {
  return (run?.status === "in_progress" || run?.status === "queued") && Date.now() - getRunUpdatedAt(run) > STALE_RUN_MS;
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
  return panelRuns(domainRuns, panelId).find((run) => (run.status === "in_progress" || run.status === "queued") && !isStaleRun(run)) ?? null;
}

function stalePanelRun(domainRuns, panelId) {
  return panelRuns(domainRuns, panelId).find((run) => (run.status === "in_progress" || run.status === "queued") && isStaleRun(run)) ?? null;
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

function interactionLockKey(domainId, panelId) {
  return `${domainId}:${panelId}`;
}

function getWidgetInteractionLock(domainId, panelId) {
  const key = interactionLockKey(domainId, panelId);
  const lock = state.widgetInteractionLocks[key] ?? null;

  if (!lock) {
    return null;
  }

  if (Date.now() - Number(lock.touchedAt ?? 0) > WIDGET_INTERACTION_LOCK_MS) {
    delete state.widgetInteractionLocks[key];
    return null;
  }

  return lock;
}

function touchWidgetInteractionLock(domainId, panelId, runId, widgetId) {
  state.widgetInteractionLocks[interactionLockKey(domainId, panelId)] = {
    domainId,
    panelId,
    runId,
    widgetId,
    touchedAt: Date.now()
  };
}

function resolveDisplayedPanelRuns(domainId, panelId, domainRuns) {
  const latestRun = latestRenderableRun(domainRuns, panelId);
  const widgetRun = latestWidgetRun(domainRuns, panelId);
  const activeRun = activePanelRun(domainRuns, panelId);
  const lock = getWidgetInteractionLock(domainId, panelId);
  const lockedRun = lock?.runId ? domainRuns.find((run) => run.id === lock.runId) ?? null : null;
  const lockedWidgetRun = lockedRun?.widgetId ? lockedRun : null;
  const effectiveLatestRun = lockedRun?.report ? lockedRun : latestRun;
  const effectiveWidgetRun = lockedWidgetRun ?? widgetRun;
  const hasPendingReplacement = Boolean(
    lock &&
    ((latestRun?.id && effectiveLatestRun?.id && latestRun.id !== effectiveLatestRun.id) ||
      (widgetRun?.id && effectiveWidgetRun?.id && widgetRun.id !== effectiveWidgetRun.id))
  );
  const effectiveActiveRun =
    lock && activeRun?.id && effectiveLatestRun?.id && activeRun.id !== effectiveLatestRun.id
      ? null
      : activeRun;

  return {
    lock,
    latestRun,
    widgetRun,
    activeRun,
    effectiveLatestRun,
    effectiveWidgetRun,
    effectiveActiveRun,
    hasPendingReplacement
  };
}

function domainRenderSignature(domainId) {
  if (!domainId) {
    return "no-domain";
  }

  const snapshot = state.domainSnapshots[domainId] ?? null;
  const workspacePlan = state.workspacePlans[domainId] ?? snapshot?.workspacePlan ?? null;
  const runs = visibleRunsForDomain(domainId).map((run) => [
    run.id,
    run.panelId,
    run.status,
    run.updatedAt,
    run.widgetId ?? null
  ]);

  return JSON.stringify({
    domainId,
    activePanelId: state.activePanelId,
    runs,
    workspacePlan: workspacePlan
      ? {
          focusPanelId: workspacePlan.focusPanelId,
          visiblePanelIds: workspacePlan.visiblePanelIds,
          panelGroups: workspacePlan.panelGroups,
          collapsedSections: workspacePlan.collapsedSections
        }
      : null,
    panelStatus: snapshot?.panelStatus ?? null,
    sourcePreviews: state.sourcePreviews.map((preview) => [
      preview.sourceId,
      preview.status,
      preview.detail?.queryWindow?.evaluationTime ?? null,
      preview.detail?.rowCount ?? null,
      preview.detail?.resultCount ?? null
    ])
  });
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
  logger.info("Selected domain", {
    domainId,
    activePanelId: state.activePanelId
  }, "render");
  renderDomains();
  renderDomainContext();
  renderToolRegistry();
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

function renderToolRegistry() {
  if (!elements.toolRegistrySummary) {
    return;
  }

  const domain = currentDomain();
  const registry = domain ? state.derivedToolRegistries?.[domain.id] ?? null : null;

  if (!domain || !registry) {
    elements.toolRegistrySummary.innerHTML = `<p class="hint">Select a domain to inspect how its recipes are projected into model-facing tools.</p>`;
    return;
  }

  const domainTools = (registry.tools ?? []).filter((tool) => tool.scopeType === "domain");
  const panelTools = (registry.tools ?? []).filter((tool) => tool.scopeType === "panel");
  const cards = (registry.tools ?? [])
    .slice(0, 10)
    .map((tool) => `
      <article class="tool-registry-card">
        <p class="section-label">${tool.scopeType === "domain" ? "Domain Tool" : `Panel Tool · ${escapeHtml(tool.scopeTitle ?? "")}`}</p>
        <h4>${escapeHtml(tool.title ?? tool.id)}</h4>
        <p class="source-description">${escapeHtml(tool.description ?? "")}</p>
        <p class="hint">Operation: <code>${escapeHtml(tool.operation ?? "")}</code>${tool.queryNames?.length ? ` · Queries: ${tool.queryNames.map((query) => `<code>${escapeHtml(query)}</code>`).join(", ")}` : ""}</p>
      </article>
    `)
    .join("");

  elements.toolRegistrySummary.innerHTML = `
    <div class="tool-registry-meta">
      <div class="metric">
        <span class="label">Derived Tools</span>
        <span class="value">${registry.toolCount ?? 0}</span>
      </div>
      <div class="metric">
        <span class="label">Domain Tools</span>
        <span class="value">${domainTools.length}</span>
      </div>
      <div class="metric">
        <span class="label">Panel Tools</span>
        <span class="value">${panelTools.length}</span>
      </div>
    </div>
    <div class="tool-registry-list">
      ${cards || '<p class="hint">No derived tools are available for this domain yet.</p>'}
    </div>
  `;
}

function describeSourceLocation(source) {
  if (source.type === "victoria-metrics") {
    return source.baseUrl || "VictoriaMetrics endpoint not configured";
  }

  if (source.type === "json-file") {
    return source.path || "JSON path not configured";
  }

  if (source.type === "relational") {
    return source.connectionString || "Relational source configured via sample rows or sample data";
  }

  if (source.type === "sql") {
    const engine = source.engine || source.connection?.engine || "sql";
    const location = source.databasePath || source.connection?.databasePath || source.connectionString || source.connection?.connectionString || "SQL connection not configured";
    return `${engine} · ${location}`;
  }

  return "Source location not specified";
}

function renderDomainContext() {
  if (!elements.domainContextSummary) {
    return;
  }

  const domain = currentDomain();
  if (elements.deleteDomainButton) {
    elements.deleteDomainButton.disabled = !domain;
  }

  if (!domain) {
    elements.domainContextSummary.innerHTML = `<p class="hint">Select a domain to inspect its originating prompt and configured datasource bindings.</p>`;
    return;
  }

  const boundSources = state.dataSources.filter((source) => domain.dataSources.includes(source.id));
  const promptMarkup = domain.generationPrompt
    ? `<div class="domain-context-prompt">${escapeHtml(domain.generationPrompt)}</div>`
    : `<p class="hint">This domain appears to be authored directly in config, so no original generation prompt is stored.</p>`;
  const evidenceMarkup = domain.generationEvidenceSummary
    ? `<div class="domain-context-prompt">${escapeHtml(domain.generationEvidenceSummary)}</div>`
    : `<p class="hint">No explicit datasource-grounding summary is stored for this domain.</p>`;
  const generationToolTrace = Array.isArray(domain.generationToolTrace) ? domain.generationToolTrace : [];
  const generationToolMarkup = generationToolTrace.length
    ? `
      <div class="tool-registry-list">
        ${generationToolTrace.map((entry) => `
          <article class="tool-card">
            <p class="section-label">${escapeHtml(entry.scopeTitle || entry.scopeType || "Source Tool")}</p>
            <h4>${escapeHtml(entry.title || entry.toolId)}</h4>
            <p class="source-description">${escapeHtml(entry.purpose || entry.operation || "")}</p>
            <p class="hint">${escapeHtml(entry.result?.result?.summary || entry.result?.summary || "")}</p>
          </article>
        `).join("")}
      </div>
    `
    : `<p class="hint">No generation tool trace is stored for this domain.</p>`;
  const sourcesMarkup = boundSources.length
    ? `
      <div class="domain-source-list">
        ${boundSources.map((source) => `
          <article class="domain-source-item">
            <p class="section-label">${escapeHtml(source.type)}</p>
            <h4>${escapeHtml(source.name)}</h4>
            <p class="source-description">${escapeHtml(source.description || "No source description provided.")}</p>
            <div class="domain-source-meta">
              <span class="domain-source-chip">${escapeHtml(source.id)}</span>
              <span class="domain-source-chip">${escapeHtml(describeSourceLocation(source))}</span>
            </div>
          </article>
        `).join("")}
      </div>
    `
    : `<p class="hint">No datasource bindings are configured for this domain.</p>`;

  elements.domainContextSummary.innerHTML = `
    <div class="domain-context-block">
      <p class="section-label">Original Prompt</p>
      ${promptMarkup}
    </div>
    <div class="domain-context-block">
      <p class="section-label">Grounding Summary</p>
      ${evidenceMarkup}
    </div>
    <div class="domain-context-block">
      <p class="section-label">Generation Tool Trace</p>
      ${generationToolMarkup}
    </div>
    <div class="domain-context-block">
      <p class="section-label">Configured Data Sources</p>
      ${sourcesMarkup}
    </div>
  `;
}

async function deleteCurrentDomain() {
  const domain = currentDomain();

  if (!domain) {
    return;
  }

  const confirmed = window.confirm(`Delete domain "${domain.name}" and its saved runs, widgets, and workspace state?`);
  if (!confirmed) {
    return;
  }

  await request(`/api/domains/${encodeURIComponent(domain.id)}`, {
    method: "DELETE"
  });

  delete state.workspacePlans[domain.id];
  delete state.domainSnapshots[domain.id];
  delete state.derivedToolRegistries[domain.id];
  state.runs = state.runs.filter((run) => run.domainId !== domain.id);
  state.widgets = state.widgets.filter((widget) => widget.domainId !== domain.id);
  state.domains = state.domains.filter((entry) => entry.id !== domain.id);

  const preferredDomainId = state.appConfig?.app?.defaultDomainId ?? null;
  state.selectedDomainId = preferredDomainId && state.domains.some((entry) => entry.id === preferredDomainId)
    ? preferredDomainId
    : state.domains[0]?.id ?? null;
  state.activePanelId = null;

  await refresh();
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

function renderSpendSummary() {
  if (!elements.spendSummary) {
    return;
  }

  const summary = state.spendSummary;
  if (!summary) {
    elements.spendSummary.innerHTML = `<p class="hint">No model usage recorded yet.</p>`;
    return;
  }

  const currentDomainId = state.selectedDomainId ?? null;
  const domainPanels = (summary.byPanel ?? []).filter((entry) => entry.domainId === currentDomainId).slice(0, 5);
  const models = (summary.byModel ?? []).slice(0, 4);
  const archetypes = (summary.byArchetype ?? []).slice(0, 4);

  elements.spendSummary.innerHTML = `
    <div class="spend-total-card">
      <span class="section-label">Total Spend</span>
      <strong>${formatUsd(summary.totals?.cost?.totalUsd ?? 0)}</strong>
    </div>
    <div class="spend-breakdown-grid">
      <div class="metric">
        <span class="label">Input</span>
        <span class="value">${formatUsd(summary.totals?.cost?.inputUsd ?? 0)}</span>
      </div>
      <div class="metric">
        <span class="label">Cached Input</span>
        <span class="value">${formatUsd(summary.totals?.cost?.cachedInputUsd ?? 0)}</span>
      </div>
      <div class="metric">
        <span class="label">Output</span>
        <span class="value">${formatUsd(summary.totals?.cost?.outputUsd ?? 0)}</span>
      </div>
    </div>
    <p class="hint">Reasoning tokens currently account for ${formatUsd(summary.totals?.cost?.reasoningOutputUsd ?? 0)} of output spend.</p>
    <div class="spend-section">
      <p class="section-label">By Model</p>
      <ul class="spend-list">
        ${models.map((entry) => `<li><span>${escapeHtml(entry.model)}</span><strong>${formatUsd(entry.cost?.totalUsd ?? 0)}</strong></li>`).join("") || `<li><span>No priced model usage yet</span></li>`}
      </ul>
    </div>
    <div class="spend-section">
      <p class="section-label">${currentDomainId ? "Current Domain Panels" : "Panels"}</p>
      <ul class="spend-list">
        ${domainPanels.map((entry) => `<li><span>${escapeHtml(entry.panelTitle)}</span><strong>${formatUsd(entry.cost?.totalUsd ?? 0)}</strong></li>`).join("") || `<li><span>No panel-attributed spend yet</span></li>`}
      </ul>
    </div>
    <div class="spend-section">
      <p class="section-label">By Archetype</p>
      <ul class="spend-list">
        ${archetypes.map((entry) => `<li><span>${escapeHtml(entry.archetypeTitle ?? formatArchetypeTitle(entry.archetypeId))}</span><strong>${formatUsd(entry.cost?.totalUsd ?? 0)}</strong></li>`).join("") || `<li><span>No archetype-attributed spend yet</span></li>`}
      </ul>
    </div>
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

function sectionOverrideKey(domainId, sectionId) {
  return `${domainId}:${sectionId}`;
}

function getSectionOpenState(sectionId, defaultOpen) {
  const domainId = state.selectedDomainId ?? null;

  if (!domainId) {
    return defaultOpen;
  }

  const override = state.sectionOverrides[sectionOverrideKey(domainId, sectionId)];
  return typeof override === "boolean" ? override : defaultOpen;
}

function visiblePanelIdsForDomain(domain) {
  if (!domain) {
    return [];
  }

  const domainPanelIds = domain.panels.map((panel) => panel.id);
  const workspacePlan = state.workspacePlans[domain.id] ?? null;
  const planVisiblePanelIds = workspacePlan?.visiblePanelIds?.filter((panelId) => domainPanelIds.includes(panelId)) ?? [];

  return planVisiblePanelIds.length
    ? [...planVisiblePanelIds, ...domainPanelIds.filter((panelId) => !planVisiblePanelIds.includes(panelId))]
    : domainPanelIds;
}

function orderedPanelsForDomain(domain) {
  const orderedIds = visiblePanelIdsForDomain(domain);
  return orderedIds
    .map((panelId) => domain.panels.find((panel) => panel.id === panelId))
    .filter(Boolean);
}

function currentDomainRenderSignature(domain) {
  if (!domain) {
    return "no-domain";
  }

  const workspacePlan = currentWorkspacePlan();
  const orderedPanels = orderedPanelsForDomain(domain);
  const panel = orderedPanels.find((entry) => entry.id === state.activePanelId) ?? orderedPanels[0] ?? null;
  const domainRuns = visibleRunsForDomain(domain.id);
  const latestRun = panel ? latestRenderableRun(domainRuns, panel.id) : null;
  const widgetRun = panel ? latestWidgetRun(domainRuns, panel.id) : null;
  const activeRun = panel ? activePanelRun(domainRuns, panel.id) : null;
  const staleRun = panel ? stalePanelRun(domainRuns, panel.id) : null;
  const failedRun = panel ? failedPanelRun(domainRuns, panel.id) : null;
  const panelKey = panel ? `${domain.id}:${panel.id}` : null;
  return JSON.stringify({
    domainId: domain.id,
    activePanelId: state.activePanelId,
    orderedPanels: orderedPanels.map((entry) => entry.id),
    workspacePlan: workspacePlan
      ? {
          focusPanelId: workspacePlan.focusPanelId,
          visiblePanelIds: workspacePlan.visiblePanelIds,
          panelGroups: workspacePlan.panelGroups,
          collapsedSections: workspacePlan.collapsedSections,
          rationale: workspacePlan.rationale,
          recommendedActions: workspacePlan.recommendedActions
        }
      : null,
    panelState: panel
      ? {
          panelId: panel.id,
          transientState: panelKey ? state.panelRunState[panelKey] ?? null : null,
          latestRun: latestRun ? [latestRun.id, latestRun.updatedAt, latestRun.status, latestRun.widgetStatus ?? null, latestRun.widgetId ?? null] : null,
          widgetRun: widgetRun ? [widgetRun.id, widgetRun.updatedAt, widgetRun.widgetStatus ?? null, widgetRun.widgetId ?? null] : null,
          activeRun: activeRun ? [activeRun.id, activeRun.updatedAt] : null,
          staleRun: staleRun ? [staleRun.id, staleRun.updatedAt] : null,
          failedRun: failedRun ? [failedRun.id, failedRun.updatedAt, failedRun.error ?? null] : null
        }
      : null
  });
}

function currentPanelStageSignature(domain) {
  if (!domain) {
    return "no-domain";
  }

  const orderedPanels = orderedPanelsForDomain(domain);
  const panel = orderedPanels.find((entry) => entry.id === state.activePanelId) ?? orderedPanels[0] ?? null;

  if (!panel) {
    return "no-panel";
  }

  const domainRuns = visibleRunsForDomain(domain.id);
  const resolvedRuns = resolveDisplayedPanelRuns(domain.id, panel.id, domainRuns);
  const latestRun = resolvedRuns.effectiveLatestRun;
  const widgetRun = resolvedRuns.effectiveWidgetRun;
  const activeRun = resolvedRuns.effectiveActiveRun;
  const staleRun = stalePanelRun(domainRuns, panel.id);
  const failedRun = failedPanelRun(domainRuns, panel.id);
  const panelKey = `${domain.id}:${panel.id}`;

  return JSON.stringify({
    domainId: domain.id,
    panelId: panel.id,
    transientState: state.panelRunState[panelKey] ?? null,
    latestRun: latestRun ? [latestRun.id, latestRun.updatedAt, latestRun.status, latestRun.widgetStatus ?? null, latestRun.widgetId ?? null] : null,
    widgetRun: widgetRun ? [widgetRun.id, widgetRun.updatedAt, widgetRun.widgetStatus ?? null, widgetRun.widgetId ?? null] : null,
    activeRun: activeRun ? [activeRun.id, activeRun.updatedAt, activeRun.progressPhase ?? null, activeRun.progressLabel ?? null, activeRun.widgetStatus ?? null] : null,
    staleRun: staleRun ? [staleRun.id, staleRun.updatedAt, staleRun.widgetStatus ?? null] : null,
    failedRun: failedRun ? [failedRun.id, failedRun.updatedAt, failedRun.error ?? null, failedRun.widgetError ?? null] : null,
    interactionLock: resolvedRuns.lock ? [resolvedRuns.lock.runId ?? null, resolvedRuns.lock.widgetId ?? null] : null,
    hasPendingReplacement: resolvedRuns.hasPendingReplacement
  });
}

function renderWorkspacePlan(workspacePlan) {
  elements.workspaceNote.textContent = workspacePlan?.rationale ?? "Workspace is following the default domain layout.";
  elements.workspaceActions.innerHTML = "";
  if (elements.workspaceToolTrace) {
    elements.workspaceToolTrace.innerHTML = "";
  }

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

  if (elements.workspaceToolTrace) {
    const toolTrace = workspacePlan?.toolTrace ?? [];
    if (toolTrace.length) {
      elements.workspaceToolTrace.innerHTML = `
        <p class="section-label">Planner Tool Trace</p>
        ${toolTrace.map((entry) => `
          <article class="workspace-tool-trace-card">
            <p class="section-label">${escapeHtml(entry.scopeType ?? "tool")} · ${escapeHtml(entry.scopeTitle ?? "")}</p>
            <h4>${escapeHtml(entry.title ?? entry.toolId ?? "Derived Tool")}</h4>
            <p class="hint">${escapeHtml(entry.purpose ?? "Model-requested derived tool invocation.")}</p>
            <p class="hint">Top result: ${escapeHtml(
              entry.result?.result?.displayValue ??
              entry.result?.result?.entries?.[0]?.displayValue ??
              entry.result?.result?.entries?.[0]?.label ??
              "No result summary"
            )}</p>
          </article>
        `).join("")}
      `;
    } else if (workspacePlan?.toolMode) {
      elements.workspaceToolTrace.innerHTML = `
        <p class="section-label">Planner Tool Trace</p>
        <article class="workspace-tool-trace-card">
          <h4>No model-directed tool calls</h4>
          <p class="hint">Planner mode: ${escapeHtml(workspacePlan.toolMode)}</p>
        </article>
      `;
    }
  }

  if (elements.sourcePreviewSection) {
    elements.sourcePreviewSection.open = getSectionOpenState(
      "source-preview",
      !(workspacePlan?.collapsedSections ?? []).includes("source-preview")
    );
  }
  const recentRunsSection = document.querySelector("#recent-runs-section");
  if (recentRunsSection) {
    recentRunsSection.open = getSectionOpenState(
      "recent-runs",
      !(workspacePlan?.collapsedSections ?? []).includes("recent-runs")
    );
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
  const interactionOverride = run ? state.widgetInteractionState[run.id] ?? null : null;
  const queryWindow = run?.context?.previews?.find((preview) => preview?.detail?.queryWindow)?.detail?.queryWindow ?? null;
  const interactionData = interactionOverride?.data ?? null;
  const reportOverride = interactionData?.report
    ? {
        ...run.report,
        ...interactionData.report,
        chart: interactionData.chart ?? interactionData.report?.chart ?? run.report?.chart ?? null,
        narrative: interactionData.report?.narrative?.length ? interactionData.report.narrative : run.report?.narrative ?? [],
        highlights: interactionData.report?.highlights?.length ? interactionData.report.highlights : run.report?.highlights ?? [],
        details: interactionData.report?.details?.length ? interactionData.report.details : run.report?.details ?? []
      }
    : run.report;
  const contextOverride = interactionOverride
    ? {
        ...(run.context ?? {}),
        coverage: interactionData?.coverage ?? run.context?.coverage ?? null,
        findings: interactionData?.findings ?? interactionData?.localFindings?.findings ?? run.context?.findings ?? null
      }
    : run.context;
  return {
    runId: run.id,
    domain,
    panel,
    archetype: {
      id: run.selectedArchetype ?? null,
      title: run.archetypeTitle ?? null,
      reason: run.archetypeReason ?? null,
      confidence: run.archetypeConfidence ?? null
    },
    report: reportOverride,
    context: contextOverride,
    interaction: interactionOverride ?? null,
    timestamps: {
      runCreatedAt: run.createdAt ?? null,
      runUpdatedAt: run.updatedAt ?? null,
      widgetGeneratedAt: null,
      evaluationTime: queryWindow?.evaluationTime ?? null,
      windowStart: queryWindow?.start ?? null,
      windowEnd: queryWindow?.end ?? null
    },
    theme: {
      accent: domain.color || "#6ee7b7",
      background: "#07111d",
      panel: "#101826",
      text: "#ebf4ff",
      muted: "#97a8bc"
    }
  };
}

function formatLocalTimestamp(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function renderWidgetMeta(widgetSourceRun) {
  const widget = widgetSourceRun?.widgetId
    ? state.widgets.find((entry) => entry.id === widgetSourceRun.widgetId) ?? null
    : null;
  const analysisTime = formatLocalTimestamp(widgetSourceRun?.updatedAt);
  const snapshotTime = formatLocalTimestamp(
    widgetSourceRun?.context?.previews?.find((preview) => preview?.detail?.queryWindow)?.detail?.queryWindow?.evaluationTime
  );
  const widgetTime = formatLocalTimestamp(widgetSourceRun?.widgetGeneratedAt ?? widget?.generatedAt ?? widgetSourceRun?.updatedAt);
  const parts = [
    widgetSourceRun?.archetypeTitle ?? null,
    analysisTime ? `analysis ${analysisTime}` : null,
    widgetSourceRun?.widgetId ? `widget ${widgetTime}` : null,
    snapshotTime ? `data ${snapshotTime}` : null
  ].filter(Boolean);

  if (!parts.length) {
    return "";
  }

  return parts.join(" · ");
}

function renderWidgetStatus(run, widgetRun) {
  if (!run?.report && !widgetRun?.widgetId) {
    return "";
  }

  if (run?.widgetId) {
    return "";
  }

  if (widgetRun?.widgetId && widgetRun.id !== run?.id && (run?.widgetStatus === "in_progress" || run?.widgetStatus === "pending")) {
    return `
      <div class="widget-status widget-status-stale">
        <strong>Widget fallback in use.</strong> The generated widget below is from an older analysis run while Morphy finishes building a new widget for the current run.
      </div>
    `;
  }

  if (run?.widgetStatus === "in_progress" || run?.widgetStatus === "pending") {
    return `
      <div class="widget-status widget-status-pending">
        <strong>Generated widget is underway.</strong> Analysis is complete and the native chart above is current; Morphy is still building the browser widget artifact for this run.
      </div>
    `;
  }

  if (widgetRun?.widgetId && widgetRun.id !== run?.id) {
    return `
      <div class="widget-status widget-status-stale">
        <strong>Widget fallback in use.</strong> The generated widget below is from an older analysis run because the latest run does not have a widget artifact yet.
      </div>
    `;
  }

  if (run?.widgetError) {
    return `
      <div class="widget-status widget-status-warning">
        <strong>Generated widget unavailable.</strong> ${escapeHtml(run.widgetError)}
      </div>
    `;
  }

  if (run?.report) {
    return `
      <div class="widget-status widget-status-pending">
        <strong>No generated widget for this run yet.</strong> The native chart above is current; the browser widget has not been produced for this analysis.
      </div>
    `;
  }

  return "";
}

function renderInteractionLockNotice(hasPendingReplacement) {
  if (!hasPendingReplacement) {
    return "";
  }

  return `
    <div class="widget-status widget-status-pending">
      <strong>Interactive widget is pinned.</strong> Morphy detected active interaction and is keeping this widget in place. A newer analysis or widget is available and will appear after the interaction lock expires.
    </div>
  `;
}

function renderRunLifecycle(run, transientState) {
  if (transientState?.status === "starting") {
    return `
      <div class="panel-phase-card">
        <span class="phase-chip active">Starting</span>
        <span class="phase-chip">Analysis</span>
        <span class="phase-chip">Widget</span>
      </div>
    `;
  }

  if (!run) {
    return `
      <div class="panel-phase-card">
        <span class="phase-chip">Ready</span>
        <span class="phase-note">No analysis run has been started for this panel yet.</span>
      </div>
    `;
  }

  const phaseLabel = run.progressLabel || null;
  const phaseNote = run.progressMessage || null;
  const effectiveWidgetStatus =
    run.widgetStatus === "idle" && (run.status === "queued" || run.status === "in_progress")
      ? "pending"
      : (run.widgetStatus ?? (run.widgetId ? "completed" : "idle"));
  const analysisLabel = run.status === "queued"
    ? "Preparing"
    : run.status === "in_progress"
    ? "Analysis Running"
    : run.status === "failed"
      ? "Analysis Failed"
      : "Analysis Complete";
  const widgetLabel = effectiveWidgetStatus === "in_progress"
    ? "Widget Generating"
    : effectiveWidgetStatus === "completed"
      ? "Widget Ready"
      : effectiveWidgetStatus === "failed"
        ? "Widget Failed"
        : effectiveWidgetStatus === "pending"
          ? "Widget Pending"
        : "Widget Idle";
  const shouldRenderPhaseChip = phaseLabel && phaseLabel !== analysisLabel && phaseLabel !== widgetLabel;

  const note = phaseNote
    ? phaseNote
    : run.status === "queued"
      ? "Morphy is still preparing the run before the main analysis begins."
    : run.status === "in_progress"
    ? "The analytical pass is still running on the server."
    : run.status === "completed" && (effectiveWidgetStatus === "pending" || effectiveWidgetStatus === "in_progress")
      ? "The report is ready. Browser widget generation is still in progress."
    : run.status === "completed" && effectiveWidgetStatus === "completed"
      ? "Both analysis and widget generation are complete for this run."
    : run.status === "failed"
      ? `The analysis run failed${run.error ? `: ${escapeHtml(run.error)}` : "."}`
    : effectiveWidgetStatus === "failed"
      ? `Analysis completed, but widget generation failed${run.widgetError ? `: ${escapeHtml(run.widgetError)}` : "."}`
    : "Run state is available.";

  return `
    <div class="panel-phase-card">
      <span class="phase-chip ${run.status === "queued" || run.status === "in_progress" ? "active" : run.status === "failed" ? "failed" : "done"}">${analysisLabel}</span>
      <span class="phase-chip ${
        effectiveWidgetStatus === "in_progress" || effectiveWidgetStatus === "pending"
          ? "active"
          : effectiveWidgetStatus === "failed"
            ? "failed"
            : effectiveWidgetStatus === "completed"
              ? "done"
              : ""
      }">${widgetLabel}</span>
      ${shouldRenderPhaseChip ? `<span class="phase-chip active">${escapeHtml(phaseLabel)}</span>` : ""}
      <span class="phase-note">${note}</span>
    </div>
  `;
}

function renderArchetypeDetails(run) {
  const details = Array.isArray(run?.report?.details) ? run.report.details.filter((section) => section?.title && section?.items?.length) : [];

  const derivedDetails = !details.length && run?.report
    ? (() => {
        const labels = Array.isArray(run.report.chart?.labels) ? run.report.chart.labels : [];
        const values = Array.isArray(run.report.chart?.values) ? run.report.chart.values : [];
        const top = labels
          .map((label, index) => ({
            label,
            value: Number(values[index] ?? 0)
          }))
          .filter((entry) => Number.isFinite(entry.value))
          .sort((left, right) => right.value - left.value)
          .slice(0, 4);
        const highlights = Array.isArray(run.report.highlights) ? run.report.highlights.slice(0, 4) : [];
        const narrative = Array.isArray(run.report.narrative) ? run.report.narrative.slice(0, 2) : [];
        const archetype = run.selectedArchetype ?? "incident-summary";

        if (archetype === "pressure-board") {
          return [
            {
              title: "Backlog Leaders",
              items: top.map((entry) => `${entry.label}: ${entry.value}`)
            },
            {
              title: "Pressure Notes",
              items: highlights
            }
          ];
        }

        if (archetype === "job-detail-sheet" || archetype === "correlation-inspector") {
          return [
            {
              title: archetype === "job-detail-sheet" ? "Candidate Jobs" : "Linked Entities",
              items: highlights
            },
            {
              title: "Operator Notes",
              items: narrative
            }
          ];
        }

        if (archetype === "timeline-analysis") {
          return [
            {
              title: "Peak Signals",
              items: top.map((entry) => `${entry.label}: ${entry.value}`)
            },
            {
              title: "Trend Notes",
              items: narrative
            }
          ];
        }

        return [
          {
            title: "Key Signals",
            items: top.map((entry) => `${entry.label}: ${entry.value}`)
          },
          {
            title: "Highlights",
            items: highlights
          }
        ];
      })()
    : [];
  const sections = details.length ? details : derivedDetails;

  if (!sections.length) {
    return "";
  }

  return `
    <div class="detail-section-grid">
      ${sections.map((section) => `
        <section class="detail-card">
          <p class="section-label">${escapeHtml(section.title)}</p>
          <ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </section>
      `).join("")}
    </div>
  `;
}

function renderVisualization(run, domain, panel, widgetRun = null) {
  const nativeChart = `
    <div class="native-chart-shell">
      ${run?.report?.chart ? renderChart(run.report.chart) : renderPlaceholderChart(panel.chartPreference)}
    </div>
  `;
  const widgetStatus = renderWidgetStatus(run, widgetRun);

  const widgetSourceRun = widgetRun?.widgetId ? widgetRun : run?.widgetId ? run : null;

  if (!widgetSourceRun?.widgetId) {
    return `<div class="chart-stack">${nativeChart}${widgetStatus}</div>`;
  }

  return `
    <div class="chart-stack">
      ${nativeChart}
      ${widgetStatus}
      <div class="widget-host">
        <p class="widget-caption">Generated browser widget served from the artifact runtime.</p>
        <p class="widget-meta">${escapeHtml(renderWidgetMeta(widgetSourceRun))}</p>
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

function formatArchetypeTitle(value) {
  if (!value) {
    return "Adaptive";
  }

  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((token) => token[0].toUpperCase() + token.slice(1))
    .join(" ");
}

function renderArchetypeMeta(panel, run, domain) {
  const allowedArchetypes = Array.isArray(panel.allowedArchetypes) && panel.allowedArchetypes.length
    ? panel.allowedArchetypes
    : [];
  const panelSpend = domain ? summarizePanelSpend(domain.id, panel.id) : null;
  const archetypeSpend = domain && run?.selectedArchetype ? summarizePanelSpend(domain.id, panel.id, run.selectedArchetype) : null;
  const archetypeToolTrace = Array.isArray(run?.archetypeToolTrace) ? run.archetypeToolTrace : [];
  const archetypeToolMode = run?.archetypeToolMode ?? null;
  const analysisToolTrace = Array.isArray(run?.analysisToolTrace) ? run.analysisToolTrace : [];
  const analysisToolMode = run?.analysisToolMode ?? null;
  const widgetToolTrace = Array.isArray(run?.widgetToolTrace) ? run.widgetToolTrace : [];
  const widgetToolMode = run?.widgetToolMode ?? null;
  const archetypeToolTraceMarkup = run
    ? archetypeToolTrace.length
      ? `
        <div class="archetype-tool-trace">
          <p class="panel-archetype-meta">Selection tools: ${escapeHtml(archetypeToolMode || "model-directed")}</p>
          ${archetypeToolTrace.map((entry) => `
            <div class="archetype-tool-trace-card">
              <strong>${escapeHtml(entry.title || entry.toolId)}</strong>
              <p class="panel-archetype-meta">${escapeHtml(entry.purpose || entry.operation || "")}</p>
            </div>
          `).join("")}
        </div>
      `
      : archetypeToolMode
        ? `<p class="panel-archetype-meta">Selection tools: ${escapeHtml(archetypeToolMode)}</p>`
        : ""
    : "";
  const analysisToolTraceMarkup = run
    ? analysisToolTrace.length
      ? `
        <div class="archetype-tool-trace">
          <p class="panel-archetype-meta">Analysis tools: ${escapeHtml(analysisToolMode || "model-directed")}</p>
          ${analysisToolTrace.map((entry) => `
            <div class="archetype-tool-trace-card">
              <strong>${escapeHtml(entry.title || entry.toolId)}</strong>
              <p class="panel-archetype-meta">${escapeHtml(entry.purpose || entry.operation || "")}</p>
            </div>
          `).join("")}
        </div>
      `
      : analysisToolMode
        ? `<p class="panel-archetype-meta">Analysis tools: ${escapeHtml(analysisToolMode)}</p>`
        : ""
    : "";
  const widgetToolTraceMarkup = run
    ? widgetToolTrace.length
      ? `
        <div class="archetype-tool-trace">
          <p class="panel-archetype-meta">Widget tools: ${escapeHtml(widgetToolMode || "model-directed")}</p>
          ${widgetToolTrace.map((entry) => `
            <div class="archetype-tool-trace-card">
              <strong>${escapeHtml(entry.title || entry.toolId)}</strong>
              <p class="panel-archetype-meta">${escapeHtml(entry.purpose || entry.operation || "")}</p>
            </div>
          `).join("")}
        </div>
      `
      : widgetToolMode
        ? `<p class="panel-archetype-meta">Widget tools: ${escapeHtml(widgetToolMode)}</p>`
        : ""
    : "";
  const runSpend = currentRunSpend(run);
  const spendMeta = run
    ? `
      <p class="panel-archetype-meta">Current run spend: ${formatUsd(runSpend.totalUsd)}${runSpend.archetypeUsd ? ` · archetype ${formatUsd(runSpend.archetypeUsd)}` : ""}${runSpend.analysisUsd ? ` · analysis ${formatUsd(runSpend.analysisUsd)}` : ""}${runSpend.widgetUsd ? ` · widget ${formatUsd(runSpend.widgetUsd)}` : ""}</p>
      <p class="panel-archetype-meta">Panel cumulative: ${formatUsd(panelSpend?.totalUsd ?? 0)}${run?.selectedArchetype ? ` · this archetype ${formatUsd(archetypeSpend?.totalUsd ?? 0)}` : ""}</p>
    `
    : panelSpend?.entries
      ? `<p class="panel-archetype-meta">Panel cumulative spend: ${formatUsd(panelSpend.totalUsd)}</p>`
      : "";

  if (!run?.selectedArchetype) {
    const allowed = allowedArchetypes.length
      ? allowedArchetypes.map((entry) => formatArchetypeTitle(entry)).join(", ")
      : "Adaptive";
    const guidance = panel.archetypeGuidance
      ? `<p class="panel-archetype-reason">${escapeHtml(panel.archetypeGuidance)}</p>`
      : "";

    return `
      <div class="panel-archetype-card pending">
        <div class="panel-archetype-row">
          <span class="section-label">Allowed Archetypes</span>
          <span class="archetype-badge">${escapeHtml(allowed)}</span>
        </div>
        ${spendMeta}
        ${archetypeToolTraceMarkup}
        ${analysisToolTraceMarkup}
        ${widgetToolTraceMarkup}
        ${guidance}
      </div>
    `;
  }

  const confidence = run.archetypeConfidence ? `Confidence: ${run.archetypeConfidence}` : "Confidence pending";
  const reason = run.archetypeReason
    ? `<p class="panel-archetype-reason">${escapeHtml(run.archetypeReason)}</p>`
    : "";

  return `
    <div class="panel-archetype-card">
      <div class="panel-archetype-row">
        <span class="section-label">Selected Archetype</span>
        <span class="archetype-badge">${escapeHtml(run.archetypeTitle || formatArchetypeTitle(run.selectedArchetype))}</span>
      </div>
      <p class="panel-archetype-meta">${escapeHtml(confidence)}</p>
      ${spendMeta}
      ${archetypeToolTraceMarkup}
      ${analysisToolTraceMarkup}
      ${widgetToolTraceMarkup}
      ${reason}
    </div>
  `;
}

function postToWidgetFrame(frame, type = "init") {
  const run = state.runs.find((entry) => entry.id === frame.dataset.runId);
  const domain = state.domains.find((entry) => entry.id === frame.dataset.domainId);
  const panel = domain?.panels.find((entry) => entry.id === frame.dataset.panelId);

  if (!run || !domain || !panel || !frame.contentWindow) {
    logger.debug("Skipped widget frame post due to missing context", {
      type,
      runId: frame.dataset.runId,
      domainId: frame.dataset.domainId,
      panelId: frame.dataset.panelId
    }, "widgets");
    return;
  }

  logger.trace("Posting message to widget frame", {
    type,
    runId: run.id,
    panelId: panel.id,
    widgetId: frame.dataset.widgetId
  }, "widgets");
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
    logger.debug("Binding widget frame", {
      widgetId: frame.dataset.widgetId,
      runId: frame.dataset.runId,
      panelId: frame.dataset.panelId
    }, "widgets");
    frame.addEventListener("load", () => {
      logger.debug("Widget frame loaded", {
        widgetId: frame.dataset.widgetId,
        runId: frame.dataset.runId
      }, "widgets");
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

async function handleWidgetDataRequest(frame, message) {
  const requestId = message.payload?.requestId ?? null;
  try {
    const result = await request(`/api/panels/${encodeURIComponent(frame.dataset.domainId)}/${encodeURIComponent(frame.dataset.panelId)}/interaction/data`, {
      method: "POST",
      body: JSON.stringify({
        runId: frame.dataset.runId,
        params: message.payload?.params ?? {}
      })
    });
    const runId = frame.dataset.runId ?? null;
    if (runId && result?.interaction) {
      state.widgetInteractionState[runId] = result.interaction;
    }

    frame.contentWindow?.postMessage(
      {
        source: "morphy-host",
        type: "widget:data-response",
        sessionId: frame.dataset.sessionId,
        requestId,
        payload: result
      },
      "*"
    );
  } catch (error) {
    frame.contentWindow?.postMessage(
      {
        source: "morphy-host",
        type: "widget:data-error",
        sessionId: frame.dataset.sessionId,
        requestId,
        payload: {
          error: error.message
        }
      },
      "*"
    );
  }
}

async function handleWidgetInterpretationRequest(frame, message) {
  const requestId = message.payload?.requestId ?? null;
  try {
    const result = await request(`/api/panels/${encodeURIComponent(frame.dataset.domainId)}/${encodeURIComponent(frame.dataset.panelId)}/interaction/reinterpret`, {
      method: "POST",
      body: JSON.stringify({
        runId: frame.dataset.runId,
        params: message.payload?.params ?? {}
      })
    });
    const runId = frame.dataset.runId ?? null;
    if (runId && result?.interaction) {
      state.widgetInteractionState[runId] = result.interaction;
      state.spendSummary = null;
      void refresh().catch((error) => {
        logger.warn("Failed to refresh spend state after reinterpretation", { error: error.message }, "network");
      });
    }

    frame.contentWindow?.postMessage(
      {
        source: "morphy-host",
        type: "widget:reinterpretation-response",
        sessionId: frame.dataset.sessionId,
        requestId,
        payload: result
      },
      "*"
    );
  } catch (error) {
    frame.contentWindow?.postMessage(
      {
        source: "morphy-host",
        type: "widget:reinterpretation-error",
        sessionId: frame.dataset.sessionId,
        requestId,
        payload: {
          error: error.message
        }
      },
      "*"
    );
  }
}

function renderCurrentDomain() {
  const domain = currentDomain();

  if (!domain) {
    state.currentDomainRenderSignature = "no-domain";
    logger.debug("Render skipped because no domain is selected", {}, "render");
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
  const nextRenderSignature = currentDomainRenderSignature(domain);
  const nextStageSignature = currentPanelStageSignature(domain);

  if (state.currentDomainRenderSignature === nextRenderSignature) {
    logger.trace("Skipping render because signature is unchanged", {
      domainId: domain.id,
      activePanelId: state.activePanelId
    }, "render");
    return;
  }

  state.currentDomainRenderSignature = nextRenderSignature;
  logger.debug("Rendering current domain", {
    domainId: domain.id,
    activePanelId: state.activePanelId,
    orderedPanelIds: orderedPanels.map((panel) => panel.id)
  }, "render");
  elements.panelRail.innerHTML = "";
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
      logger.info("Selected panel", {
        domainId: domain.id,
        panelId: panel.id
      }, "render");
      state.activePanelId = panel.id;
      renderCurrentDomain();
    });
    elements.panelRail.append(button);
  }

  const panel = orderedPanels.find((entry) => entry.id === state.activePanelId) ?? orderedPanels[0];

  if (!panel) {
    elements.panelStage.innerHTML = `<p class="hint">No panels are defined for this domain.</p>`;
    state.currentPanelStageSignature = "no-panel";
    return;
  }

  if (state.currentPanelStageSignature === nextStageSignature) {
    logger.trace("Skipping panel stage rebuild because signature is unchanged", {
      domainId: domain.id,
      panelId: panel.id
    }, "render");
    return;
  }

  state.currentPanelStageSignature = nextStageSignature;
  elements.panelStage.innerHTML = "";

  const node = panelTemplate.content.firstElementChild.cloneNode(true);
  const panelKey = `${domain.id}:${panel.id}`;
  const transientState = state.panelRunState[panelKey] ?? null;
  const resolvedRuns = resolveDisplayedPanelRuns(domain.id, panel.id, domainRuns);
  const latestRun = resolvedRuns.effectiveLatestRun;
  const widgetRun = resolvedRuns.effectiveWidgetRun;
  const activeRun = resolvedRuns.effectiveActiveRun;
  const staleRun = stalePanelRun(domainRuns, panel.id);
  const failedRun = failedPanelRun(domainRuns, panel.id);
  const lifecycleRun = activeRun ?? latestRun ?? failedRun ?? staleRun ?? null;
  const panelMetaRun = activeRun ?? latestRun ?? failedRun ?? staleRun ?? null;
  node.querySelector(".panel-kicker").textContent = panelMetaRun?.archetypeTitle || panel.chartPreference;
  node.querySelector(".panel-title").textContent = panel.title;
  node.querySelector(".panel-summary").textContent = panel.summary;
  node.querySelector(".panel-phase-shell").innerHTML = renderRunLifecycle(lifecycleRun, transientState);
  const runButton = node.querySelector(".run-button");
  const forceRunButton = node.querySelector(".force-run-button");
  node.querySelector(".chart-title").textContent = (latestRun?.widgetId || widgetRun?.widgetId)
    ? "Generated Browser Visualization"
    : latestRun?.report?.chart?.title || "Awaiting chart output";
  node.querySelector(".chart-target").innerHTML = `${renderInteractionLockNotice(resolvedRuns.hasPendingReplacement)}${renderVisualization(latestRun, domain, panel, widgetRun)}`;
  node.querySelector(".panel-archetype-shell").innerHTML = renderArchetypeMeta(panel, panelMetaRun, domain);
  node.querySelector(".report-shell").innerHTML = latestRun?.report
    ? `
      ${renderArchetypeDetails(latestRun)}
      ${latestRun.report.narrative.map((entry) => `<p>${escapeHtml(entry)}</p>`).join("")}
      ${latestRun.report.highlights.length ? `<ul>${latestRun.report.highlights.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : ""}
    `
    : transientState?.status === "starting"
      ? `<p class="hint">Starting analysis run...</p>`
    : activeRun?.status === "queued" || activeRun?.status === "in_progress"
      ? `<p class="hint">${escapeHtml(activeRun?.progressMessage || (activeRun?.status === "queued" ? "Morphy is preparing this run." : "Analysis is running. Results will appear when the server-side agent completes."))}</p>`
    : staleRun
      ? `<p class="hint">A previous analysis run appears stale. Run analysis again to start a fresh job.</p>`
    : failedRun
      ? `<p class="hint">Analysis failed${failedRun.error ? `: ${escapeHtml(failedRun.error)}` : "."}</p>`
    : `<p class="hint">Run analysis to populate this panel.</p>`;
  runButton.disabled = transientState?.status === "starting" || activeRun?.status === "in_progress" || activeRun?.status === "queued";
  runButton.textContent = transientState?.status === "starting"
    ? "Starting..."
    : activeRun?.status === "queued" || activeRun?.status === "in_progress"
      ? (activeRun?.progressLabel || "Running...")
      : "Run Analysis";
  forceRunButton.disabled = transientState?.status === "starting" || activeRun?.status === "in_progress" || activeRun?.status === "queued";
  forceRunButton.textContent = transientState?.status === "starting"
    ? "Starting..."
    : activeRun?.status === "queued" || activeRun?.status === "in_progress"
      ? (activeRun?.progressLabel || "Running...")
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
    const effectiveWidgetStatus = run.widgetStatus ?? (run.widgetId ? "completed" : null);
    node.querySelector(".status-pill").textContent =
      run.status === "queued"
        ? (run.progressLabel || "queued")
        : effectiveWidgetStatus && run.status === "completed"
          ? `${run.status} · widget ${effectiveWidgetStatus.replaceAll("_", " ")}`
          : run.status;
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
  const previousSelectedDomainId = state.selectedDomainId;
  const previousDomainSignature = domainRenderSignature(previousSelectedDomainId);
  const payload = await request("/api/bootstrap");
  const nextSignature = JSON.stringify({
    liveStateUpdatedAt: payload.liveStateUpdatedAt ?? null,
    runs: (payload.runs ?? []).map((run) => [run.id, run.updatedAt, run.status, run.widgetStatus ?? null, run.widgetId ?? null]),
    widgets: (payload.widgets ?? []).map((widget) => widget.id),
    spendUpdatedAt: payload.spendSummary?.updatedAt ?? null,
    plans: Object.fromEntries(
      Object.entries(payload.workspacePlans ?? {}).map(([domainId, workspacePlan]) => [domainId, workspacePlan?.updatedAt ?? null])
    )
  });

  if (state.bootstrapSignature && state.bootstrapSignature === nextSignature) {
    logger.trace("Skipping bootstrap merge because signature is unchanged", {}, "network");
    return;
  }

  state.bootstrapSignature = nextSignature;
  state.appConfig = payload.appConfig;
  logger.update(payload.appConfig?.diagnostics?.client ?? {});
  state.domains = payload.domains;
  state.dataSources = payload.dataSources;
  state.sourcePreviews = payload.sourcePreviews;
  state.runs = payload.runs;
  state.widgets = payload.widgets;
  state.spendSummary = payload.spendSummary ?? null;
  state.derivedToolRegistries = payload.derivedToolRegistries ?? {};
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
  const nextDomainSignature = domainRenderSignature(state.selectedDomainId);
  const shouldRenderCurrentDomain =
    previousSelectedDomainId !== state.selectedDomainId ||
    previousDomainSignature !== nextDomainSignature;
  logger.info("Bootstrap state merged", {
    selectedDomainId: state.selectedDomainId,
    domainCount: state.domains.length,
    runCount: state.runs.length,
    shouldRenderCurrentDomain
  }, "network");

  elements.appName.textContent = payload.appConfig.app?.name || "Morphy";
  renderAgentStatus(payload.agent);
  renderSpendSummary();
  renderDomains();
  renderDomainContext();
  renderToolRegistry();
  renderSourcePreviews();
  if (shouldRenderCurrentDomain) {
    renderCurrentDomain();
  }
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

  const result = await request("/api/domains/generate", {
    method: "POST",
    body: JSON.stringify({ prompt })
  });
  const domain = result.domain ?? result;
  if (result.derivedToolRegistry && domain?.id) {
    state.derivedToolRegistries[domain.id] = result.derivedToolRegistry;
  }

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
  logger.info("Run analysis clicked", { domainId, panelId, force }, "events");
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

  if (run.status === "in_progress" || run.status === "queued") {
    logger.debug("Run entered polling state", { runId: run.id, domainId, panelId }, "events");
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
      logger.info("Polling completed for run", {
        runId,
        status: run.status,
        attempt: attempt + 1
      }, "events");
      return run;
    }
  }

  logger.warn("Polling timed out for run", { runId }, "events");
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

async function resetSpend() {
  const confirmed = window.confirm("Reset cumulative model spend totals?");
  if (!confirmed) {
    return;
  }

  const summary = await request("/api/spend/reset", {
    method: "POST"
  });
  state.spendSummary = summary;
  renderSpendSummary();
  if (state.selectedDomainId) {
    renderCurrentDomain();
  }
}

function connectEvents() {
  const events = new EventSource("/api/events");
  logger.info("Opening SSE connection", {}, "events");
  events.addEventListener("run.update", (event) => {
    const run = JSON.parse(event.data);
    logger.debug("Received run.update", {
      runId: run.id,
      domainId: run.domainId,
      panelId: run.panelId,
      status: run.status
    }, "events");
    state.runs = [run, ...state.runs.filter((entry) => entry.id !== run.id)].sort(
      (left, right) => new Date(right.updatedAt) - new Date(left.updatedAt)
    );
    if (run.domainId === state.selectedDomainId && (!state.activePanelId || run.panelId === state.activePanelId)) {
      renderCurrentDomain();
    }
    renderRuns();
  });
  events.addEventListener("workspace.update", (event) => {
    const workspacePlan = JSON.parse(event.data);
    logger.debug("Received workspace.update", {
      domainId: workspacePlan.domainId,
      focusPanelId: workspacePlan.focusPanelId,
      visiblePanelIds: workspacePlan.visiblePanelIds
    }, "events");
    state.workspacePlans[workspacePlan.domainId] = workspacePlan;

    if (workspacePlan.domainId === state.selectedDomainId) {
      const domain = currentDomain();
      const nextVisiblePanelIds = visiblePanelIdsForDomain(domain);

      if (!state.activePanelId || !nextVisiblePanelIds.includes(state.activePanelId)) {
        state.activePanelId = workspacePlan.focusPanelId;
      }
      renderCurrentDomain();
    }
  });
  events.addEventListener("domain.refresh", (event) => {
    const snapshot = JSON.parse(event.data);
    logger.debug("Received domain.refresh", {
      domainId: snapshot.domainId,
      reason: snapshot.reason,
      focusPanelId: snapshot.workspacePlan?.focusPanelId ?? null
    }, "events");
    state.domainSnapshots[snapshot.domainId] = snapshot;
    if (snapshot.workspacePlan) {
      state.workspacePlans[snapshot.domainId] = snapshot.workspacePlan;
    }
    if (state.selectedDomainId === snapshot.domainId) {
      const domain = currentDomain();
      const nextVisiblePanelIds = visiblePanelIdsForDomain(domain);

      if (!state.activePanelId || !nextVisiblePanelIds.includes(state.activePanelId)) {
        state.activePanelId = snapshot.workspacePlan?.focusPanelId ?? state.activePanelId;
      }
      if (snapshot.context?.previews?.length) {
        state.sourcePreviews = state.sourcePreviews
          .filter((preview) => !snapshot.context.previews.some((nextPreview) => nextPreview.sourceId === preview.sourceId))
          .concat(snapshot.context.previews);
      }
      renderSourcePreviews();
      renderCurrentDomain();
    }
  });
  events.addEventListener("spend.update", (event) => {
    state.spendSummary = JSON.parse(event.data);
    logger.debug("Received spend.update", {
      totalUsd: state.spendSummary?.totals?.cost?.totalUsd ?? 0,
      entries: state.spendSummary?.totals?.entries ?? 0
    }, "events");
    renderSpendSummary();
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
    logger.trace("Ignored widget message for unknown frame", {
      type: message.type,
      sessionId: message.sessionId ?? null
    }, "widgets");
    return;
  }

  logger.trace("Received widget message", {
    type: message.type,
    widgetId: frame.dataset.widgetId,
    runId: frame.dataset.runId
  }, "widgets");
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

  if (message.type === "widget:request-data") {
    handleWidgetDataRequest(frame, message).catch((error) => {
      logger.warn("Widget data request failed", {
        widgetId: frame.dataset.widgetId,
        runId: frame.dataset.runId,
        error: error.message
      }, "widgets");
    });
  }

  if (message.type === "widget:request-interpretation") {
    handleWidgetInterpretationRequest(frame, message).catch((error) => {
      logger.warn("Widget reinterpretation request failed", {
        widgetId: frame.dataset.widgetId,
        runId: frame.dataset.runId,
        error: error.message
      }, "widgets");
    });
  }

  if (message.type === "widget:interaction") {
    touchWidgetInteractionLock(
      frame.dataset.domainId,
      frame.dataset.panelId,
      frame.dataset.runId,
      frame.dataset.widgetId
    );
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

elements.resetSpendButton?.addEventListener("click", () => {
  resetSpend().catch((error) => window.alert(error.message));
});

elements.deleteDomainButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  deleteCurrentDomain().catch((error) => window.alert(error.message));
});

if (elements.sourcePreviewSection) {
  elements.sourcePreviewSection.addEventListener("toggle", () => {
    if (!state.selectedDomainId) {
      return;
    }

    state.sectionOverrides[sectionOverrideKey(state.selectedDomainId, "source-preview")] = elements.sourcePreviewSection.open;
  });
}

const recentRunsSection = document.querySelector("#recent-runs-section");
if (recentRunsSection) {
  recentRunsSection.addEventListener("toggle", () => {
    if (!state.selectedDomainId) {
      return;
    }

    state.sectionOverrides[sectionOverrideKey(state.selectedDomainId, "recent-runs")] = recentRunsSection.open;
  });
}

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
