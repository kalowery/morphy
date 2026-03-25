import crypto from "node:crypto";
import OpenAI from "openai";
import { gatherDomainContext } from "./data-sources.js";
import {
  buildArchetypePromptBlock,
  getArchetypeDefinition,
  getArchetypeRegistry,
  getPanelAllowedArchetypes,
  getPreferredArchetype
} from "../lib/archetypes.js";

const domainSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "description", "color", "icon", "allowedArchetypes", "dataSources", "panels"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    color: { type: "string" },
    icon: { type: "string" },
    allowedArchetypes: {
      type: "array",
      items: { type: "string" }
    },
    dataSources: {
      type: "array",
      items: { type: "string" }
    },
    panels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "summary",
          "analysisPrompt",
          "chartPreference",
          "allowedArchetypes",
          "preferredArchetype",
          "archetypeGuidance"
        ],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          analysisPrompt: { type: "string" },
          chartPreference: { type: "string" },
          allowedArchetypes: {
            type: "array",
            items: { type: "string" }
          },
          preferredArchetype: { type: "string" },
          archetypeGuidance: { type: "string" }
        }
      }
    }
  }
};

const archetypeSelectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selectedArchetype", "reason", "confidence"],
  properties: {
    selectedArchetype: { type: "string" },
    reason: { type: "string" },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"]
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

function buildFallbackDomain(prompt, dataSources, appConfig = {}) {
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
    allowedArchetypes: Object.keys(getArchetypeRegistry(appConfig).library),
    dataSources: sourceIds,
    panels: [
      {
        id: "overview",
        title: "Domain Overview",
        summary: "Summarize the main health or performance signals across configured sources.",
        analysisPrompt: "Explain the most relevant operating picture across the configured domain sources.",
        chartPreference: "bar",
        allowedArchetypes: ["incident-summary", "risk-scoreboard"],
        preferredArchetype: "incident-summary",
        archetypeGuidance: "Use incident-summary for broad synthesis and risk-scoreboard when ranked outliers dominate."
      },
      {
        id: "anomalies",
        title: "Anomalies",
        summary: "Identify outliers, correlated warnings, and likely investigation targets.",
        analysisPrompt: "Find the most important anomalies or outliers and explain why they matter.",
        chartPreference: "line",
        allowedArchetypes: ["risk-scoreboard", "timeline-analysis"],
        preferredArchetype: "risk-scoreboard",
        archetypeGuidance: "Use timeline-analysis only when the anomaly story is fundamentally temporal."
      },
      {
        id: "briefing",
        title: "Executive Briefing",
        summary: "Convert the current state into a concise decision-oriented brief.",
        analysisPrompt: "Generate a concise operational briefing with priorities, risks, and confidence notes.",
        chartPreference: "donut",
        allowedArchetypes: ["incident-summary"],
        preferredArchetype: "incident-summary",
        archetypeGuidance: "Keep the briefing narrative-first."
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
    details: [],
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
  const nextVisiblePanelIds = visiblePanelIds.length
    ? [...visiblePanelIds, ...panelIds(domain).filter((panelId) => !visiblePanelIds.includes(panelId))]
    : panelIds(domain);
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
    "job-explorer",
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
    details: Array.isArray(parsed.details) ? parsed.details : [],
    chart: {
      type: chart.type ?? panel.chartPreference ?? "bar",
      title: chart.title ?? panel.title,
      labels: Array.isArray(chart.labels) ? chart.labels : [],
      values: Array.isArray(chart.values) ? chart.values : []
    }
  };
}

function chartPairs(report) {
  const labels = Array.isArray(report?.chart?.labels) ? report.chart.labels : [];
  const values = Array.isArray(report?.chart?.values) ? report.chart.values : [];

  return labels.map((label, index) => ({
    label,
    value: values[index]
  }));
}

function topChartPairs(report, count = 4) {
  return chartPairs(report)
    .map((entry) => ({
      ...entry,
      numericValue: Number(entry.value)
    }))
    .filter((entry) => Number.isFinite(entry.numericValue))
    .sort((left, right) => right.numericValue - left.numericValue)
    .slice(0, count);
}

function toDetailItems(entries, formatter = (entry) => `${entry.label}: ${entry.numericValue}`) {
  return entries.map((entry) => formatter(entry));
}

function buildArchetypeDetails({ run, report, context }) {
  const archetype = run.selectedArchetype ?? "incident-summary";
  const chartTop = topChartPairs(report);
  const pendingJobs = getQuerySample(context, "pendingJobsByPartition");
  const saturation = getQuerySample(context, "partitionCpuSaturation");
  const hotGpus = getQuerySample(context, "hotGpusByTemperature");
  const recentJobs = getQuerySample(context, "recentJobsByNode");
  const jobGpuUtilization = getQuerySample(context, "jobGpuUtilizationPeak");
  const jobGpuVram = getQuerySample(context, "jobGpuVramPeak");
  const fabricRisk = getQuerySample(context, "ibErrorScoreByNode");

  if (archetype === "pressure-board") {
    return [
      {
        title: "Backlog Leaders",
        items: toDetailItems(
          pendingJobs
            .map((entry) => ({
              label: entry.metric?.partition ?? "unknown",
              numericValue: Number(entry.value)
            }))
            .filter((entry) => Number.isFinite(entry.numericValue))
            .sort((left, right) => right.numericValue - left.numericValue)
            .slice(0, 4),
          (entry) => `${entry.label}: ${entry.numericValue} pending`
        )
      },
      {
        title: "Saturation Leaders",
        items: toDetailItems(
          saturation
            .map((entry) => ({
              label: entry.metric?.partition ?? "unknown",
              numericValue: Number(entry.value)
            }))
            .filter((entry) => Number.isFinite(entry.numericValue))
            .sort((left, right) => right.numericValue - left.numericValue)
            .slice(0, 4),
          (entry) => `${entry.label}: ${(entry.numericValue * 100).toFixed(0)}% saturation`
        )
      }
    ];
  }

  if (archetype === "risk-scoreboard") {
    return [
      {
        title: "Top Risks",
        items: toDetailItems(chartTop, (entry) => `${entry.label}: ${entry.numericValue}`)
      },
      {
        title: "Operator Notes",
        items: (report.highlights ?? []).slice(0, 4)
      }
    ];
  }

  if (archetype === "timeline-analysis") {
    return [
      {
        title: "Peak Signals",
        items: toDetailItems(chartTop, (entry) => `${entry.label}: ${entry.numericValue}`)
      },
      {
        title: "Trend Notes",
        items: (report.narrative ?? []).slice(0, 3)
      }
    ];
  }

  if (archetype === "correlation-inspector") {
    return [
      {
        title: "Linked Entities",
        items: recentJobs.slice(0, 5).map((entry) => {
          const metric = entry.metric ?? {};
          return `${metric.user ?? "unknown"} · job ${metric.jobid ?? "?"} · ${metric.partition ?? "unknown"} · ${metric.instance ?? "unknown"}`;
        })
      },
      {
        title: "Attribution Notes",
        items: (report.highlights ?? []).slice(0, 4)
      }
    ];
  }

  if (archetype === "job-detail-sheet") {
    return [
      {
        title: "Candidate Jobs",
        items: recentJobs.slice(0, 5).map((entry) => {
          const metric = entry.metric ?? {};
          return `job ${metric.jobid ?? "?"} · ${metric.user ?? "unknown"} · ${metric.partition ?? "unknown"} · ${metric.instance ?? "unknown"}`;
        })
      },
      {
        title: "Resource Signals",
        items: [
          ...jobGpuUtilization.slice(0, 2).map((entry) => `GPU utilization peak: ${(entry.metric?.jobid ?? "?")} @ ${Number(entry.value).toFixed(0)}%`),
          ...jobGpuVram.slice(0, 2).map((entry) => `VRAM peak: ${(entry.metric?.jobid ?? "?")} @ ${Number(entry.value).toFixed(1)}%`)
        ].slice(0, 4)
      }
    ];
  }

  if (archetype === "incident-summary") {
    return [
      {
        title: "Priority Actions",
        items: (report.highlights ?? []).slice(0, 4)
      },
      {
        title: "Confidence Notes",
        items: (report.narrative ?? []).slice(0, 2)
      }
    ];
  }

  if (fabricRisk.length) {
    return [
      {
        title: "Infrastructure Signals",
        items: fabricRisk.slice(0, 4).map((entry) => `${entry.metric?.instance ?? "unknown"}: ${Number(entry.value).toFixed(0)}`)
      }
    ];
  }

  if (hotGpus.length) {
    return [
      {
        title: "Thermal Signals",
        items: hotGpus.slice(0, 4).map((entry) => `${entry.metric?.instance ?? "unknown"} card ${entry.metric?.card ?? "?"}: ${Number(entry.value).toFixed(0)}C`)
      }
    ];
  }

  return [];
}

function pickAvailableArchetype(allowedArchetypes, preferredArchetype, fallbackArchetype) {
  if (preferredArchetype && allowedArchetypes.includes(preferredArchetype)) {
    return preferredArchetype;
  }

  if (fallbackArchetype && allowedArchetypes.includes(fallbackArchetype)) {
    return fallbackArchetype;
  }

  return allowedArchetypes[0];
}

function selectHeuristicArchetype({ appConfig, domain, panel, context }) {
  const allowedArchetypes = getPanelAllowedArchetypes(appConfig, domain, panel);
  const preferredArchetype = getPreferredArchetype(appConfig, domain, panel);
  const pendingJobs = getQuerySample(context, "pendingJobsByPartition");
  const hotGpus = getQuerySample(context, "hotGpusByTemperature");
  const jobSignals = getQuerySample(context, "recentJobsByNode");
  const gpuJobSignals = [
    ...getQuerySample(context, "jobGpuUtilizationPeak"),
    ...getQuerySample(context, "jobGpuVramPeak"),
    ...getQuerySample(context, "jobGpuOccupancyPeak")
  ];
  const fabricSignals = getQuerySample(context, "ibErrorScoreByNode");

  let selectedArchetype = preferredArchetype;
  let reason = "Using the panel's preferred archetype because the current evidence does not strongly favor another allowed presentation mode.";
  let confidence = "medium";

  if (panel.id === "scheduler-pressure" && pendingJobs.length) {
    selectedArchetype = pickAvailableArchetype(allowedArchetypes, "pressure-board", preferredArchetype);
    reason = "Pending-job and saturation evidence make a pressure-board the clearest allowed presentation for scheduler bottlenecks.";
    confidence = "high";
  } else if (panel.id === "gpu-hotspots" && hotGpus.length) {
    const fallback = panel.chartPreference === "line" ? "timeline-analysis" : "risk-scoreboard";
    selectedArchetype = pickAvailableArchetype(allowedArchetypes, preferredArchetype, fallback);
    reason = "The current hotspot evidence is dominated by ranked thermal outliers and trend-like comparisons across GPUs.";
    confidence = "high";
  } else if (panel.id === "job-correlation" && (jobSignals.length || gpuJobSignals.length)) {
    selectedArchetype = pickAvailableArchetype(allowedArchetypes, "correlation-inspector", preferredArchetype);
    reason = "Cross-linked job, user, and node evidence supports a correlation-oriented archetype.";
    confidence = "medium";
  } else if (panel.id === "job-explorer" && gpuJobSignals.length) {
    selectedArchetype = pickAvailableArchetype(allowedArchetypes, "job-detail-sheet", preferredArchetype);
    reason = "The current preview includes enough job-to-GPU evidence to support a job-centric detail sheet.";
    confidence = "medium";
  } else if ((panel.id === "fleet-health" || panel.id === "fabric-storage") && (hotGpus.length || fabricSignals.length)) {
    selectedArchetype = pickAvailableArchetype(allowedArchetypes, "risk-scoreboard", preferredArchetype);
    reason = "The current evidence is strongest when presented as ranked host or infrastructure risks.";
    confidence = "medium";
  } else if (panel.id === "operator-brief") {
    selectedArchetype = pickAvailableArchetype(allowedArchetypes, "incident-summary", preferredArchetype);
    reason = "Operator handoff panels should remain narrative-first unless a stronger allowed archetype is explicitly justified.";
    confidence = "high";
  }

  return {
    selectedArchetype,
    reason,
    confidence
  };
}

function isInProgress(run) {
  return run?.status === "in_progress";
}

export class AgentRuntime {
  constructor({ configStore, eventBus, widgetService, logger }) {
    this.configStore = configStore;
    this.eventBus = eventBus;
    this.widgetService = widgetService;
    this.logger = logger ?? {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {}
    };
    this.openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  }

  async generateDomain(prompt) {
    const dataSources = await this.configStore.getDataSources();
    const appConfig = await this.configStore.getAppConfig();
    this.logger.info("Generating domain", {
      promptLength: prompt.length,
      dataSourceIds: dataSources.map((source) => source.id),
      provider: this.openai ? "openai" : "fallback"
    }, "analysis");

    if (!this.openai) {
      const domain = buildFallbackDomain(prompt, dataSources, appConfig);
      await this.configStore.saveDomain(domain);
      this.logger.info("Generated fallback domain", {
        domainId: domain.id,
        panelCount: domain.panels.length
      }, "analysis");
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
              text: `Available data sources:\n${JSON.stringify(dataSources, null, 2)}\n\nAvailable widget archetypes:\n${JSON.stringify(getArchetypeRegistry(appConfig), null, 2)}\n\nCreate a domain configuration from this prompt:\n${prompt}\n\nEvery panel must declare allowedArchetypes, preferredArchetype, and archetypeGuidance. Choose only archetype ids from the available registry. The domain-level allowedArchetypes should be the union of archetypes that make sense for the domain.`
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
    this.logger.info("Generated domain with OpenAI", {
      domainId: domain.id,
      panelCount: domain.panels.length
    }, "analysis");
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

    const context = contextOverride ?? (await gatherDomainContext(domain, dataSources, { logger: this.logger }));
    const recentRuns = runs.filter((run) => run.domainId === domainId).slice(0, 8);
    this.logger.info("Planning workspace", {
      domainId,
      preferredPanelId,
      reason,
      recentRunCount: recentRuns.length,
      previewCount: context.previewCount,
      provider: this.openai ? "openai" : "fallback"
    }, "planner");

    if (!this.openai) {
      const workspacePlan = buildFallbackWorkspacePlan(domain, context, recentRuns, preferredPanelId);
      await this.configStore.saveWorkspacePlan(domainId, workspacePlan);
      this.eventBus.emit("workspace.update", workspacePlan);
      this.logger.debug("Built fallback workspace plan", {
        domainId,
        focusPanelId: workspacePlan.focusPanelId,
        visiblePanelIds: workspacePlan.visiblePanelIds
      }, "planner");
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
    this.logger.info("Workspace plan saved", {
      domainId,
      focusPanelId: workspacePlan.focusPanelId,
      visiblePanelIds: workspacePlan.visiblePanelIds,
      layoutMode: workspacePlan.layoutMode
    }, "planner");
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

  async selectArchetype({ appConfig, domain, panel, context }) {
    const archetypeBlock = buildArchetypePromptBlock(appConfig, domain, panel);
    const fallback = selectHeuristicArchetype({ appConfig, domain, panel, context });

    if (!this.openai) {
      return fallback;
    }

    try {
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
                  "Choose the best widget archetype for the current panel from the allowed set only. Favor evidence alignment over novelty. Return strict JSON only."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Domain:\n${JSON.stringify({ id: domain.id, name: domain.name }, null, 2)}\n\nPanel:\n${JSON.stringify(panel, null, 2)}\n\nArchetype policy:\n${JSON.stringify(archetypeBlock, null, 2)}\n\nCurrent source preview context:\n${JSON.stringify(context, null, 2)}\n\nPick the best archetype from the allowed set for the current evidence.`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "archetype_selection",
            schema: archetypeSelectionSchema,
            strict: true
          }
        }
      });

      const parsed = response.output_text ? JSON.parse(response.output_text) : extractJson(JSON.stringify(response.output));
      const allowedArchetypes = archetypeBlock.allowed;

      if (!allowedArchetypes.includes(parsed.selectedArchetype)) {
        this.logger.warn("OpenAI selected disallowed archetype; using fallback", {
          panelId: panel.id,
          selectedArchetype: parsed.selectedArchetype,
          allowedArchetypes
        }, "planner");
        return fallback;
      }

      return parsed;
    } catch (error) {
      this.logger.warn("Archetype selection fell back to heuristic", {
        panelId: panel.id,
        error: error.message
      }, "planner");
      return fallback;
    }
  }

  async ensurePanelRun({ domainId, panelId, force = false, freshnessMs = 0, contextOverride = null, workspacePlanOverride = null, trigger = "manual" }) {
    const runs = await this.configStore.listRuns();
    const relevantRuns = runs.filter((run) => run.domainId === domainId && run.panelId === panelId);
    const latestRun = relevantRuns[0] ?? null;
    this.logger.debug("Ensuring panel run", {
      domainId,
      panelId,
      force,
      freshnessMs,
      trigger,
      latestRunId: latestRun?.id ?? null,
      latestRunStatus: latestRun?.status ?? null
    }, "analysis");

    if (latestRun?.status === "in_progress") {
      const syncedRun = await this.syncRun(latestRun.id);
      if (syncedRun?.status === "in_progress") {
        this.logger.debug("Reusing in-progress panel run", {
          domainId,
          panelId,
          runId: syncedRun.id
        }, "analysis");
        return syncedRun;
      }
      if (!force && syncedRun?.status === "completed" && Date.now() - new Date(syncedRun.updatedAt).getTime() <= freshnessMs) {
        this.logger.debug("Reusing freshly completed run after sync", {
          domainId,
          panelId,
          runId: syncedRun.id
        }, "analysis");
        return syncedRun;
      }
    }

    if (!force && latestRun?.status === "completed" && Date.now() - new Date(latestRun.updatedAt).getTime() <= freshnessMs) {
      this.logger.debug("Reusing fresh completed run", {
        domainId,
        panelId,
        runId: latestRun.id
      }, "analysis");
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

    const context = contextOverride ?? (await gatherDomainContext(domain, dataSources, { logger: this.logger }));
    const archetypeSelection = await this.selectArchetype({ appConfig, domain, panel, context });
    const selectedArchetypeDefinition = getArchetypeDefinition(appConfig, archetypeSelection.selectedArchetype);
    this.logger.info("Starting panel analysis", {
      domainId,
      panelId,
      panelTitle: panel.title,
      trigger,
      provider: this.openai ? "openai" : "fallback",
      previewCount: context.previewCount,
      focusPanelId: workspacePlan?.focusPanelId ?? null,
      selectedArchetype: archetypeSelection.selectedArchetype
    }, "analysis");
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
      widgetStatus: "idle",
      selectedArchetype: archetypeSelection.selectedArchetype,
      archetypeReason: archetypeSelection.reason,
      archetypeConfidence: archetypeSelection.confidence,
      archetypeTitle: selectedArchetypeDefinition?.title ?? archetypeSelection.selectedArchetype,
      remoteResponseId: null,
      widgetId: null,
      widgetUrl: null
    };

    if (!this.openai && run.report) {
      run.report.details = buildArchetypeDetails({ run, report: run.report, context: run.context });
      run.widgetStatus = "pending";
    }

    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);
    this.logger.debug("Saved initial run state", {
      runId: run.id,
      status: run.status,
      provider: run.provider
    }, "analysis");

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
              text: "You are an analytical backend. Return strict JSON with keys narrative, highlights, chart, and optional details. The chart object must contain type, title, labels, and values."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Domain:\n${JSON.stringify(domain, null, 2)}\n\nWorkspace plan:\n${JSON.stringify(workspacePlan, null, 2)}\n\nPanel:\n${JSON.stringify(panel, null, 2)}\n\nSelected archetype:\n${JSON.stringify({
                id: run.selectedArchetype,
                title: run.archetypeTitle,
                reason: run.archetypeReason,
                confidence: run.archetypeConfidence,
                allowedArchetypes: getPanelAllowedArchetypes(appConfig, domain, panel)
              }, null, 2)}\n\nCurrent source preview context:\n${JSON.stringify(context, null, 2)}\n\nTask:\n${this.buildAnalysisTask(panel, workspacePlan)}`
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
    this.logger.info("OpenAI analysis response received", {
      runId: run.id,
      domainId,
      panelId,
      remoteResponseId: response.id,
      status: run.status
    }, "analysis");

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
    this.logger.debug("Synced remote run state", {
      runId,
      remoteResponseId: run.remoteResponseId,
      remoteStatus: response.status
    }, "analysis");

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
      this.logger.warn("Run failed during sync", {
        runId,
        remoteResponseId: run.remoteResponseId,
        remoteStatus: response.status,
        error: run.error
      }, "analysis");
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
      this.logger.warn("Analysis response could not be parsed as JSON", {
        runId,
        panelId: panel.id,
        error: error.message
      }, "analysis");
      parsed = {
        narrative: ["The agent returned a non-JSON response, so the raw text has been wrapped."],
        highlights: [error.message],
        details: [],
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
    if (!run.report.details.length) {
      run.report.details = buildArchetypeDetails({ run, report: run.report, context: run.context });
    }
    run.widgetStatus = "pending";
    run.widgetError = null;
    run.updatedAt = new Date().toISOString();
    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);
    this.logger.info("Run completed", {
      runId,
      domainId: run.domainId,
      panelId: panel.id,
      chartType: run.report.chart.type,
      chartPointCount: run.report.chart.labels.length
    }, "analysis");
    void this.generateWidgetForRun(run.id, domain, panel);
    void this.planWorkspace({ domainId: run.domainId, preferredPanelId: panel.id, reason: "analysis-complete" }).catch(() => {});
  }

  async attachWidget(run, domain, panel) {
    if (!this.widgetService || !run.report) {
      return;
    }

    try {
      run.widgetStatus = "in_progress";
      run.widgetError = null;
      run.updatedAt = new Date().toISOString();
      await this.configStore.saveRun(run);
      this.eventBus.emit("run.update", run);
      this.logger.debug("Generating widget for run", {
        runId: run.id,
        domainId: domain.id,
        panelId: panel.id
      }, "widgets");
      const widget = await this.widgetService.generateForRun({ domain, panel, run });
      run.widgetId = widget.id;
      run.widgetUrl = `/generated/widgets/${widget.id}`;
      run.widgetGeneratedAt = widget.generatedAt ?? new Date().toISOString();
      run.widgetStatus = "completed";
      this.logger.info("Widget attached to run", {
        runId: run.id,
        widgetId: widget.id,
        panelId: panel.id
      }, "widgets");
    } catch (error) {
      run.widgetStatus = "failed";
      run.widgetError = error.message;
      this.logger.warn("Widget generation failed", {
        runId: run.id,
        panelId: panel.id,
        error: error.message
      }, "widgets");
    }
  }

  async generateWidgetForRun(runId, domain, panel) {
    const run = await this.configStore.getRun(runId);

    if (!run?.report || run.widgetId || run.widgetStatus === "in_progress") {
      return;
    }

    await this.attachWidget(run, domain, panel);
    run.updatedAt = new Date().toISOString();
    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);
  }

  async reconcileRecentRuns(runs = []) {
    const pendingRuns = runs.filter((run) => isInProgress(run) && run.remoteResponseId);
    this.logger.debug("Reconciling recent runs", {
      pendingRunIds: pendingRuns.map((run) => run.id)
    }, "analysis");

    await Promise.allSettled(
      pendingRuns.map(async (run) => {
        await this.syncRun(run.id);
      })
    );
  }
}
