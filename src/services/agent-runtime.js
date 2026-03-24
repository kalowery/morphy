import crypto from "node:crypto";
import OpenAI from "openai";
import { gatherDomainContext } from "./data-sources.js";

const domainSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "description", "color", "icon", "dataSources", "panels"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    color: { type: "string" },
    icon: { type: "string" },
    dataSources: {
      type: "array",
      items: { type: "string" }
    },
    panels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "summary", "analysisPrompt", "chartPreference"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          analysisPrompt: { type: "string" },
          chartPreference: { type: "string" }
        }
      }
    }
  }
};

const workspacePlanSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "domainId",
    "layoutMode",
    "focusPanelId",
    "visiblePanelIds",
    "panelGroups",
    "collapsedSections",
    "recommendedActions",
    "rationale"
  ],
  properties: {
    domainId: { type: "string" },
    layoutMode: {
      type: "string",
      enum: ["focus", "split", "overview"]
    },
    focusPanelId: { type: "string" },
    visiblePanelIds: {
      type: "array",
      items: { type: "string" }
    },
    panelGroups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "panelIds"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          panelIds: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    },
    collapsedSections: {
      type: "array",
      items: {
        type: "string",
        enum: ["recent-runs", "source-preview"]
      }
    },
    recommendedActions: {
      type: "array",
      items: { type: "string" }
    },
    rationale: { type: "string" }
  }
};

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Agent response did not contain JSON.");
  }

  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

function buildFallbackDomain(prompt, dataSources) {
  const nameSource = prompt.split(/[.!?\n]/)[0]?.trim() || "Adaptive Domain";
  const name = nameSource.length > 60 ? `${nameSource.slice(0, 57)}...` : nameSource;
  const id = slugify(name) || `domain-${Date.now()}`;
  const sourceIds = dataSources.slice(0, 3).map((source) => source.id);

  return {
    id,
    name,
    description: prompt.trim(),
    color: "#f5a524",
    icon: name
      .split(/\s+/)
      .map((token) => token[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase(),
    dataSources: sourceIds,
    panels: [
      {
        id: "overview",
        title: "Domain Overview",
        summary: "Summarize the main health or performance signals across configured sources.",
        analysisPrompt: "Explain the most relevant operating picture across the configured domain sources.",
        chartPreference: "bar"
      },
      {
        id: "anomalies",
        title: "Anomalies",
        summary: "Identify outliers, correlated warnings, and likely investigation targets.",
        analysisPrompt: "Find the most important anomalies or outliers and explain why they matter.",
        chartPreference: "line"
      },
      {
        id: "briefing",
        title: "Executive Briefing",
        summary: "Convert the current state into a concise decision-oriented brief.",
        analysisPrompt: "Generate a concise operational briefing with priorities, risks, and confidence notes.",
        chartPreference: "donut"
      }
    ]
  };
}

function buildFallbackReport(panel, context) {
  const previews = context.previews ?? [];
  const ready = previews.filter((preview) => preview.status === "ready");
  const warnings = previews.filter((preview) => preview.status !== "ready");
  const firstMetricSource = ready.find((preview) => preview.detail?.metrics && Object.keys(preview.detail.metrics).length);
  const metricEntries = Object.entries(firstMetricSource?.detail?.metrics ?? {}).slice(0, 6);

  return {
    narrative: [
      `${panel.title} is using ${ready.length} ready data source(s) and ${warnings.length} warning source(s).`,
      warnings.length ? `Sources needing attention: ${warnings.map((warning) => warning.sourceName).join(", ")}.` : "No source connectivity warnings were observed in the current preview.",
      metricEntries.length
        ? `Key metrics in the sample include ${metricEntries.map(([name, metric]) => `${name} avg ${metric.average}`).join(", ")}.`
        : "The current sources do not expose enough numeric structure for a richer fallback chart."
    ],
    highlights: [
      ready[0] ? `Primary source: ${ready[0].sourceName}` : "No ready sources available",
      warnings[0] ? warnings[0].detail?.message ?? "Warning present" : "All sampled sources responded"
    ],
    chart: {
      type: panel.chartPreference ?? "bar",
      title: `${panel.title} Snapshot`,
      labels: metricEntries.map(([name]) => name),
      values: metricEntries.map(([, metric]) => metric.average)
    }
  };
}

function getQuerySample(context, queryName) {
  for (const preview of context.previews ?? []) {
    for (const result of preview.detail?.queryResults ?? []) {
      if (result.queryName === queryName) {
        return result.sample ?? [];
      }
    }
  }

  return [];
}

function panelIds(domain) {
  return domain.panels.map((panel) => panel.id);
}

function normalizeWorkspacePlan(domain, parsed, preferredPanelId = null) {
  const validPanelIds = new Set(panelIds(domain));
  const visiblePanelIds = (Array.isArray(parsed.visiblePanelIds) ? parsed.visiblePanelIds : [])
    .filter((panelId) => validPanelIds.has(panelId));
  const nextVisiblePanelIds = visiblePanelIds.length ? visiblePanelIds : panelIds(domain);
  const focusPanelId = validPanelIds.has(parsed.focusPanelId)
    ? parsed.focusPanelId
    : preferredPanelId && validPanelIds.has(preferredPanelId)
      ? preferredPanelId
      : nextVisiblePanelIds[0];

  const panelGroups = (Array.isArray(parsed.panelGroups) ? parsed.panelGroups : [])
    .map((group) => ({
      id: String(group.id ?? ""),
      title: String(group.title ?? ""),
      panelIds: (Array.isArray(group.panelIds) ? group.panelIds : []).filter((panelId) => nextVisiblePanelIds.includes(panelId))
    }))
    .filter((group) => group.id && group.title && group.panelIds.length);

  return {
    domainId: domain.id,
    layoutMode: ["focus", "split", "overview"].includes(parsed.layoutMode) ? parsed.layoutMode : "focus",
    focusPanelId,
    visiblePanelIds: nextVisiblePanelIds,
    panelGroups,
    collapsedSections: (Array.isArray(parsed.collapsedSections) ? parsed.collapsedSections : []).filter((section) =>
      ["recent-runs", "source-preview"].includes(section)
    ),
    recommendedActions: Array.isArray(parsed.recommendedActions)
      ? parsed.recommendedActions.map((entry) => String(entry)).filter(Boolean).slice(0, 4)
      : [],
    rationale: String(parsed.rationale ?? "Workspace remains in its default focused layout."),
    updatedAt: new Date().toISOString()
  };
}

function buildFallbackWorkspacePlan(domain, context, recentRuns = [], preferredPanelId = null) {
  const backlog = getQuerySample(context, "pendingJobsByPartition");
  const hotGpus = getQuerySample(context, "hotGpusByTemperature");
  const fabricRisk = getQuerySample(context, "ibErrorScoreByNode");
  const recommendedActions = [];
  let focusPanelId = preferredPanelId && panelIds(domain).includes(preferredPanelId) ? preferredPanelId : domain.panels[0]?.id ?? "";
  let rationale = "Workspace remains centered on the default domain priorities.";

  if (!preferredPanelId) {
    const topBacklog = backlog
      .map((entry) => Number(entry.value))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)[0] ?? 0;
    const topGpuTemp = hotGpus
      .map((entry) => Number(entry.value))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)[0] ?? 0;
    const topFabricSignal = fabricRisk
      .map((entry) => Number(entry.value))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)[0] ?? 0;

    if (topBacklog >= 20 && panelIds(domain).includes("scheduler-pressure")) {
      focusPanelId = "scheduler-pressure";
      rationale = "Scheduler pressure has been promoted because queue backlog is concentrated in a few partitions.";
      recommendedActions.push("Inspect partition backlog and saturation before drilling into host-level symptoms.");
    } else if (topGpuTemp >= 78 && panelIds(domain).includes("gpu-hotspots")) {
      focusPanelId = "gpu-hotspots";
      rationale = "GPU hotspots have been promoted because the current window shows elevated thermal outliers.";
      recommendedActions.push("Inspect the hottest accelerators and correlate them with job placement.");
    } else if (topFabricSignal > 0 && panelIds(domain).includes("fabric-storage")) {
      focusPanelId = "fabric-storage";
      rationale = "Fabric and storage signals were promoted because non-zero infrastructure error counters are present.";
      recommendedActions.push("Check the highest-error nodes before assuming the issue is only scheduler-related.");
    } else if (panelIds(domain).includes("fleet-health")) {
      focusPanelId = "fleet-health";
      rationale = "Fleet Health stays in focus because it best summarizes the current operating picture.";
    }
  }

  if (!recommendedActions.length && recentRuns.some((run) => run.status === "failed")) {
    recommendedActions.push("Re-run failed panels after reviewing datasource readiness and widget generation state.");
  }

  const preferredOrder = [
    focusPanelId,
    "fleet-health",
    "scheduler-pressure",
    "gpu-hotspots",
    "fabric-storage",
    "job-correlation",
    "operator-brief"
  ].filter((panelId, index, values) => panelId && values.indexOf(panelId) === index && panelIds(domain).includes(panelId));
  const visiblePanelIds = preferredOrder.concat(panelIds(domain).filter((panelId) => !preferredOrder.includes(panelId)));

  return normalizeWorkspacePlan(
    domain,
    {
      domainId: domain.id,
      layoutMode: "focus",
      focusPanelId,
      visiblePanelIds,
      panelGroups: [
        {
          id: "primary",
          title: "Priority",
          panelIds: visiblePanelIds.slice(0, 3)
        },
        {
          id: "secondary",
          title: "Supporting",
          panelIds: visiblePanelIds.slice(3)
        }
      ],
      collapsedSections: ["recent-runs"],
      recommendedActions,
      rationale
    },
    preferredPanelId
  );
}

function normalizeReport(parsed, panel) {
  const chart = parsed.chart ?? {};
  return {
    narrative: Array.isArray(parsed.narrative) ? parsed.narrative : [String(parsed.narrative ?? "No narrative generated.")],
    highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
    chart: {
      type: chart.type ?? panel.chartPreference ?? "bar",
      title: chart.title ?? panel.title,
      labels: Array.isArray(chart.labels) ? chart.labels : [],
      values: Array.isArray(chart.values) ? chart.values : []
    }
  };
}

function isInProgress(run) {
  return run?.status === "in_progress";
}

export class AgentRuntime {
  constructor({ configStore, eventBus, widgetService }) {
    this.configStore = configStore;
    this.eventBus = eventBus;
    this.widgetService = widgetService;
    this.openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  }

  async generateDomain(prompt) {
    const dataSources = await this.configStore.getDataSources();
    const appConfig = await this.configStore.getAppConfig();

    if (!this.openai) {
      const domain = buildFallbackDomain(prompt, dataSources);
      await this.configStore.saveDomain(domain);
      return domain;
    }

    const response = await this.openai.responses.create({
      model: appConfig.agent?.model ?? "gpt-5.4",
      reasoning: {
        effort: appConfig.agent?.reasoningEffort ?? "medium"
      },
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You design configuration-only analytical domains for a web app. Return strict JSON only."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Available data sources:\n${JSON.stringify(dataSources, null, 2)}\n\nCreate a domain configuration from this prompt:\n${prompt}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "domain_configuration",
          schema: domainSchema,
          strict: true
        }
      }
    });

    const domain = response.output_text ? JSON.parse(response.output_text) : extractJson(JSON.stringify(response.output));
    await this.configStore.saveDomain(domain);
    return domain;
  }

  async planWorkspace({ domainId, preferredPanelId = null, reason = "refresh", contextOverride = null }) {
    const [appConfig, domain, dataSources, runs] = await Promise.all([
      this.configStore.getAppConfig(),
      this.configStore.getDomain(domainId),
      this.configStore.getDataSources(),
      this.configStore.listRuns()
    ]);

    if (!domain) {
      throw new Error(`Unknown domain: ${domainId}`);
    }

    const context = contextOverride ?? (await gatherDomainContext(domain, dataSources));
    const recentRuns = runs.filter((run) => run.domainId === domainId).slice(0, 8);

    if (!this.openai) {
      const workspacePlan = buildFallbackWorkspacePlan(domain, context, recentRuns, preferredPanelId);
      await this.configStore.saveWorkspacePlan(domainId, workspacePlan);
      this.eventBus.emit("workspace.update", workspacePlan);
      return workspacePlan;
    }

    const response = await this.openai.responses.create({
      model: appConfig.agent?.model ?? "gpt-5.4",
      reasoning: {
        effort: appConfig.agent?.reasoningEffort ?? "medium"
      },
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You plan bounded workspace adaptations for an analytical web app. Keep the host shell stable. Only reprioritize panels, order, grouping, and collapsed secondary sections. Return strict JSON only."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Domain:\n${JSON.stringify(domain, null, 2)}\n\nCurrent source preview context:\n${JSON.stringify(context, null, 2)}\n\nRecent runs:\n${JSON.stringify(recentRuns, null, 2)}\n\nPlanning reason: ${reason}\nPreferred panel: ${preferredPanelId ?? "none"}\n\nReturn a workspace plan that keeps the UI stable while promoting the most relevant analysis.`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "workspace_plan",
          schema: workspacePlanSchema,
          strict: true
        }
      }
    });

    const parsed = response.output_text ? JSON.parse(response.output_text) : extractJson(JSON.stringify(response.output));
    const workspacePlan = normalizeWorkspacePlan(domain, parsed, preferredPanelId);
    await this.configStore.saveWorkspacePlan(domainId, workspacePlan);
    this.eventBus.emit("workspace.update", workspacePlan);
    return workspacePlan;
  }

  buildAnalysisTask(panel, workspacePlan) {
    const focusHint = workspacePlan?.focusPanelId === panel.id
      ? "This panel is currently the primary focus of the workspace plan."
      : "This panel is currently supporting the primary workspace focus.";
    const rationaleHint = workspacePlan?.rationale ? `Workspace rationale: ${workspacePlan.rationale}` : "";
    const actionsHint = workspacePlan?.recommendedActions?.length
      ? `Recommended operator actions to consider: ${workspacePlan.recommendedActions.join(" ")}`
      : "";

    return [panel.analysisPrompt, focusHint, rationaleHint, actionsHint].filter(Boolean).join("\n\n");
  }

  async ensurePanelRun({ domainId, panelId, force = false, freshnessMs = 0, contextOverride = null, workspacePlanOverride = null, trigger = "manual" }) {
    const runs = await this.configStore.listRuns();
    const relevantRuns = runs.filter((run) => run.domainId === domainId && run.panelId === panelId);
    const latestRun = relevantRuns[0] ?? null;

    if (latestRun?.status === "in_progress") {
      const syncedRun = await this.syncRun(latestRun.id);
      if (syncedRun?.status === "in_progress") {
        return syncedRun;
      }
      if (!force && syncedRun?.status === "completed" && Date.now() - new Date(syncedRun.updatedAt).getTime() <= freshnessMs) {
        return syncedRun;
      }
    }

    if (!force && latestRun?.status === "completed" && Date.now() - new Date(latestRun.updatedAt).getTime() <= freshnessMs) {
      return latestRun;
    }

    return this.runAnalysis({ domainId, panelId, contextOverride, workspacePlanOverride, trigger });
  }

  async runAnalysis({ domainId, panelId, contextOverride = null, workspacePlanOverride = null, trigger = "manual" }) {
    const [appConfig, domain, dataSources, sessions, workspacePlan] = await Promise.all([
      this.configStore.getAppConfig(),
      this.configStore.getDomain(domainId),
      this.configStore.getDataSources(),
      this.configStore.getSessions(),
      workspacePlanOverride
        ? Promise.resolve(workspacePlanOverride)
        : this.planWorkspace({ domainId, preferredPanelId: panelId, reason: "run-request" }).catch(() =>
            this.configStore.getWorkspacePlan(domainId)
          )
    ]);

    if (!domain) {
      throw new Error(`Unknown domain: ${domainId}`);
    }

    const panel = domain.panels.find((entry) => entry.id === panelId);

    if (!panel) {
      throw new Error(`Unknown panel: ${panelId}`);
    }

    const context = contextOverride ?? (await gatherDomainContext(domain, dataSources));
    const run = {
      id: crypto.randomUUID(),
      domainId,
      panelId,
      panelTitle: panel.title,
      status: this.openai ? "queued" : "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      context,
      report: this.openai ? null : buildFallbackReport(panel, context),
      provider: this.openai ? "openai-responses" : "local-fallback",
      trigger,
      remoteResponseId: null,
      widgetId: null,
      widgetUrl: null
    };

    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);

    if (!this.openai) {
      void this.generateWidgetForRun(run.id, domain, panel);
      return run;
    }

    const previousResponseId = sessions[domainId]?.previousResponseId;
    const response = await this.openai.responses.create({
      model: appConfig.agent?.model ?? "gpt-5.4",
      store: true,
      background: Boolean(appConfig.agent?.allowBackground),
      previous_response_id: previousResponseId,
      reasoning: {
        effort: appConfig.agent?.reasoningEffort ?? "medium"
      },
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You are an analytical backend. Return strict JSON with keys narrative, highlights, and chart. The chart object must contain type, title, labels, and values."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Domain:\n${JSON.stringify(domain, null, 2)}\n\nWorkspace plan:\n${JSON.stringify(workspacePlan, null, 2)}\n\nPanel:\n${JSON.stringify(panel, null, 2)}\n\nCurrent source preview context:\n${JSON.stringify(context, null, 2)}\n\nTask:\n${this.buildAnalysisTask(panel, workspacePlan)}`
            }
          ]
        }
      ]
    });

    run.remoteResponseId = response.id;
    run.status = response.status === "completed" ? "completed" : "in_progress";
    run.updatedAt = new Date().toISOString();
    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);

    sessions[domainId] = {
      previousResponseId: response.id,
      updatedAt: new Date().toISOString()
    };
    await this.configStore.saveSessions(sessions);

    if (run.status === "completed") {
      await this.completeRun(run.id, domain, panel, response);
      return (await this.configStore.getRun(run.id)) ?? run;
    }

    void this.monitorRun(run.id, domain, panel);
    return run;
  }

  async syncRun(runId) {
    const run = await this.configStore.getRun(runId);

    if (!run || !this.openai || !run.remoteResponseId || run.status !== "in_progress") {
      return run;
    }

    const domain = await this.configStore.getDomain(run.domainId);
    const panel = domain?.panels.find((entry) => entry.id === run.panelId);

    if (!domain || !panel) {
      return run;
    }

    const response = await this.openai.responses.retrieve(run.remoteResponseId);

    if (response.status === "completed") {
      await this.completeRun(runId, domain, panel, response);
      return this.configStore.getRun(runId);
    }

    if (response.status === "failed" || response.status === "cancelled" || response.status === "incomplete") {
      run.status = "failed";
      run.updatedAt = new Date().toISOString();
      run.error = response.error ?? `Response ended with status ${response.status}`;
      await this.configStore.saveRun(run);
      this.eventBus.emit("run.update", run);
      return run;
    }

    return run;
  }

  async monitorRun(runId, domain, panel) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const current = await this.syncRun(runId);

      if (!current?.remoteResponseId) {
        return;
      }

      if (current.status === "completed" || current.status === "failed") {
        return;
      }
    }
  }

  async completeRun(runId, domain, panel, response) {
    const run = await this.configStore.getRun(runId);
    if (!run) {
      return;
    }

    let parsed;

    try {
      parsed = extractJson(response.output_text ?? JSON.stringify(response.output));
    } catch (error) {
      parsed = {
        narrative: ["The agent returned a non-JSON response, so the raw text has been wrapped."],
        highlights: [error.message],
        chart: {
          type: panel.chartPreference ?? "bar",
          title: panel.title,
          labels: [],
          values: []
        }
      };
    }

    run.status = "completed";
    run.report = normalizeReport(parsed, panel);
    run.updatedAt = new Date().toISOString();
    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);
    void this.generateWidgetForRun(run.id, domain, panel);
    void this.planWorkspace({ domainId: run.domainId, preferredPanelId: panel.id, reason: "analysis-complete" }).catch(() => {});
  }

  async attachWidget(run, domain, panel) {
    if (!this.widgetService || !run.report) {
      return;
    }

    try {
      const widget = await this.widgetService.generateForRun({ domain, panel, run });
      run.widgetId = widget.id;
      run.widgetUrl = `/generated/widgets/${widget.id}`;
    } catch (error) {
      run.widgetError = error.message;
    }
  }

  async generateWidgetForRun(runId, domain, panel) {
    const run = await this.configStore.getRun(runId);

    if (!run?.report || run.widgetId) {
      return;
    }

    await this.attachWidget(run, domain, panel);
    run.updatedAt = new Date().toISOString();
    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);
  }

  async reconcileRecentRuns(runs = []) {
    const pendingRuns = runs.filter((run) => isInProgress(run) && run.remoteResponseId);

    await Promise.allSettled(
      pendingRuns.map(async (run) => {
        await this.syncRun(run.id);
      })
    );
  }
}
