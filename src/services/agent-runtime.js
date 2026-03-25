import crypto from "node:crypto";
import OpenAI from "openai";
import { gatherDomainContext } from "./data-sources.js";
import {
  buildArchetypeAnalysisContract,
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

const PANEL_QUERY_PRIORITY = {
  "fleet-health": [
    "instrumentedHostCount",
    "slurmNodeHealthScore",
    "smartFailures",
    "ibErrorScoreByNode",
    "gpuRasUncorrectableByNode",
    "hotGpusByTemperature"
  ],
  "scheduler-pressure": [
    "pendingJobsByPartition",
    "partitionCpuSaturation",
    "instrumentedHostCount"
  ],
  "gpu-hotspots": [
    "hotGpusByTemperature",
    "jobGpuUtilizationPeak",
    "jobGpuVramPeak",
    "jobGpuOccupancyPeak"
  ],
  "fabric-storage": [
    "ibErrorScoreByNode",
    "smartFailures",
    "slurmNodeHealthScore"
  ],
  "job-correlation": [
    "recentJobsByNode",
    "jobGpuUtilizationPeak",
    "jobGpuVramPeak"
  ],
  "job-explorer": [
    "recentJobsByNode",
    "jobGpuUtilizationPeak",
    "jobGpuVramPeak",
    "jobGpuOccupancyPeak",
    "hotGpusByTemperature"
  ],
  "operator-brief": [
    "pendingJobsByPartition",
    "partitionCpuSaturation",
    "hotGpusByTemperature",
    "ibErrorScoreByNode",
    "smartFailures",
    "recentJobsByNode"
  ]
};

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function compactDomain(domain) {
  return {
    id: domain.id,
    name: domain.name,
    description: domain.description,
    dataSources: domain.dataSources,
    allowedArchetypes: domain.allowedArchetypes ?? [],
    panels: (domain.panels ?? []).map((panel) => ({
      id: panel.id,
      title: panel.title,
      summary: panel.summary,
      chartPreference: panel.chartPreference,
      allowedArchetypes: panel.allowedArchetypes ?? [],
      preferredArchetype: panel.preferredArchetype ?? null
    }))
  };
}

function compactPanel(panel) {
  return {
    id: panel.id,
    title: panel.title,
    summary: panel.summary,
    chartPreference: panel.chartPreference,
    allowedArchetypes: panel.allowedArchetypes ?? [],
    preferredArchetype: panel.preferredArchetype ?? null,
    archetypeGuidance: panel.archetypeGuidance ?? "",
    analysisPrompt: panel.analysisPrompt
  };
}

function compactWorkspacePlan(workspacePlan, panelId = null) {
  if (!workspacePlan) {
    return null;
  }

  return {
    layoutMode: workspacePlan.layoutMode,
    focusPanelId: workspacePlan.focusPanelId,
    panelIsFocused: panelId ? workspacePlan.focusPanelId === panelId : null,
    visiblePanelIds: (workspacePlan.visiblePanelIds ?? []).slice(0, 8),
    recommendedActions: (workspacePlan.recommendedActions ?? []).slice(0, 3),
    rationale: workspacePlan.rationale ?? ""
  };
}

function compactRecentRuns(runs = []) {
  return runs.slice(0, 5).map((run) => ({
    panelId: run.panelId,
    panelTitle: run.panelTitle,
    status: run.status,
    updatedAt: run.updatedAt,
    selectedArchetype: run.selectedArchetype ?? null,
    widgetStatus: run.widgetStatus ?? null,
    topHighlights: (run.report?.highlights ?? []).slice(0, 2),
    chart: run.report?.chart
      ? {
          type: run.report.chart.type,
          title: run.report.chart.title,
          pointCount: Array.isArray(run.report.chart.labels) ? run.report.chart.labels.length : 0
        }
      : null
  }));
}

function formatMetricLabels(metric = {}) {
  const keys = ["instance", "partition", "jobid", "user", "card", "device"];
  const values = keys
    .filter((key) => metric[key] !== undefined && metric[key] !== null && metric[key] !== "")
    .map((key) => `${key}=${metric[key]}`);
  return values.join(", ");
}

function compactQueryResult(result, sampleCount = 4) {
  return {
    queryName: result.queryName,
    resultType: result.resultType,
    resultCount: result.resultCount,
    sample: (result.sample ?? []).slice(0, sampleCount).map((entry) => ({
      labels: formatMetricLabels(entry.metric ?? {}),
      value: entry.value
    }))
  };
}

function relevantQueryNamesForPanel(panel) {
  return PANEL_QUERY_PRIORITY[panel.id] ?? [];
}

function compactContextForPanel(panel, context) {
  const preferredNames = relevantQueryNamesForPanel(panel);
  const previews = (context.previews ?? []).map((preview) => {
    const ready = preview.status === "ready";
    const results = preview.detail?.queryResults ?? [];
    const ordered = preferredNames.length
      ? [
          ...preferredNames
            .map((name) => results.find((result) => result.queryName === name))
            .filter(Boolean),
          ...results.filter((result) => !preferredNames.includes(result.queryName))
        ]
      : results;
    const selectedResults = ordered.slice(0, preferredNames.length ? Math.min(4, ordered.length) : Math.min(3, ordered.length));

    return {
      sourceId: preview.sourceId,
      sourceName: preview.sourceName,
      sourceType: preview.sourceType,
      status: preview.status,
      message: ready ? null : preview.detail?.message ?? null,
      queryWindow: preview.detail?.queryWindow ?? null,
      queryResults: selectedResults.map((result) => compactQueryResult(result))
    };
  });

  return {
    domainId: context.domainId,
    domainName: context.domainName,
    previewCount: previews.length,
    previews
  };
}

function compactContextForPlanner(context) {
  const previews = (context.previews ?? []).map((preview) => ({
    sourceId: preview.sourceId,
    sourceName: preview.sourceName,
    sourceType: preview.sourceType,
    status: preview.status,
    message: preview.status === "ready" ? null : preview.detail?.message ?? null,
    queryWindow: preview.detail?.queryWindow ?? null,
    queryResults: (preview.detail?.queryResults ?? []).slice(0, 4).map((result) => compactQueryResult(result, 3))
  }));

  return {
    domainId: context.domainId,
    domainName: context.domainName,
    previewCount: previews.length,
    previews
  };
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

function sanitizeDetailSection(section) {
  return {
    sectionId: section?.sectionId ? String(section.sectionId) : null,
    title: String(section?.title ?? "").trim(),
    items: Array.isArray(section?.items) ? section.items.map((item) => String(item)).filter(Boolean) : []
  };
}

function mergeArchetypeDetails(contract, details = [], fallbackDetails = []) {
  if (!contract?.detailSections?.length) {
    return Array.isArray(details) ? details.map(sanitizeDetailSection).filter((section) => section.title && section.items.length) : [];
  }

  const normalized = Array.isArray(details) ? details.map(sanitizeDetailSection) : [];
  const normalizedFallback = Array.isArray(fallbackDetails) ? fallbackDetails.map(sanitizeDetailSection) : [];

  return contract.detailSections
    .map((expectedSection) => {
      const directMatch =
        normalized.find((section) => section.sectionId === expectedSection.id) ??
        normalized.find((section) => section.title.toLowerCase() === expectedSection.title.toLowerCase());
      const fallbackMatch =
        normalizedFallback.find((section) => section.sectionId === expectedSection.id) ??
        normalizedFallback.find((section) => section.title.toLowerCase() === expectedSection.title.toLowerCase());
      const source = directMatch?.items?.length ? directMatch : fallbackMatch;

      return {
        sectionId: expectedSection.id,
        title: expectedSection.title,
        items: (source?.items ?? []).slice(0, expectedSection.maxItems ?? 5)
      };
    })
    .filter((section) => section.items.length);
}

function missingArchetypeSections(contract, details = []) {
  if (!contract?.detailSections?.length) {
    return [];
  }

  const presentSectionIds = new Set(
    (Array.isArray(details) ? details : [])
      .map((section) => section?.sectionId)
      .filter(Boolean)
  );

  return contract.detailSections
    .filter((section) => !presentSectionIds.has(section.id))
    .map((section) => section.id);
}

function normalizeReport(parsed, panel, contract = null, fallbackDetails = []) {
  const chart = parsed.chart ?? {};
  return {
    narrative: Array.isArray(parsed.narrative) ? parsed.narrative : [String(parsed.narrative ?? "No narrative generated.")],
    highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
    details: mergeArchetypeDetails(contract, Array.isArray(parsed.details) ? parsed.details : [], fallbackDetails),
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
        sectionId: "pressure-metrics",
        title: "Pressure Metrics",
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
      },
      {
        sectionId: "backlog-board",
        title: "Backlog Board",
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
        sectionId: "capacity-notes",
        title: "Capacity Notes",
        items: (report.highlights ?? []).slice(0, 4)
      }
    ];
  }

  if (archetype === "risk-scoreboard") {
    return [
      {
        sectionId: "ranked-signals",
        title: "Ranked Signals",
        items: toDetailItems(chartTop, (entry) => `${entry.label}: ${entry.numericValue}`)
      },
      {
        sectionId: "triage-summary",
        title: "Triage Summary",
        items: (report.highlights ?? []).slice(0, 4)
      },
      {
        sectionId: "operator-notes",
        title: "Operator Notes",
        items: (report.highlights ?? []).slice(0, 4)
      }
    ];
  }

  if (archetype === "timeline-analysis") {
    return [
      {
        sectionId: "timeline-overview",
        title: "Timeline Overview",
        items: (report.highlights ?? []).slice(0, 3)
      },
      {
        sectionId: "peak-metrics",
        title: "Peak Metrics",
        items: toDetailItems(chartTop, (entry) => `${entry.label}: ${entry.numericValue}`)
      },
      {
        sectionId: "trend-notes",
        title: "Trend Notes",
        items: (report.narrative ?? []).slice(0, 3)
      }
    ];
  }

  if (archetype === "correlation-inspector") {
    return [
      {
        sectionId: "entity-links",
        title: "Entity Links",
        items: recentJobs.slice(0, 5).map((entry) => {
          const metric = entry.metric ?? {};
          return `${metric.user ?? "unknown"} · job ${metric.jobid ?? "?"} · ${metric.partition ?? "unknown"} · ${metric.instance ?? "unknown"}`;
        })
      },
      {
        sectionId: "evidence-matrix",
        title: "Evidence Matrix",
        items: (report.highlights ?? []).slice(0, 4)
      },
      {
        sectionId: "attribution-notes",
        title: "Attribution Notes",
        items: (report.highlights ?? []).slice(0, 4)
      }
    ];
  }

  if (archetype === "job-detail-sheet") {
    return [
      {
        sectionId: "job-header",
        title: "Job Header",
        items: recentJobs.slice(0, 5).map((entry) => {
          const metric = entry.metric ?? {};
          return `job ${metric.jobid ?? "?"} · ${metric.user ?? "unknown"} · ${metric.partition ?? "unknown"} · ${metric.instance ?? "unknown"}`;
        })
      },
      {
        sectionId: "resource-profile",
        title: "Resource Profile",
        items: [
          ...jobGpuUtilization.slice(0, 2).map((entry) => `GPU utilization peak: ${(entry.metric?.jobid ?? "?")} @ ${Number(entry.value).toFixed(0)}%`),
          ...jobGpuVram.slice(0, 2).map((entry) => `VRAM peak: ${(entry.metric?.jobid ?? "?")} @ ${Number(entry.value).toFixed(1)}%`)
        ].slice(0, 4)
      },
      {
        sectionId: "candidate-drilldowns",
        title: "Candidate Drilldowns",
        items: (report.highlights ?? []).slice(0, 4)
      }
    ];
  }

  if (archetype === "incident-summary") {
    return [
      {
        sectionId: "briefing",
        title: "Briefing",
        items: (report.narrative ?? []).slice(0, 3)
      },
      {
        sectionId: "actions",
        title: "Actions",
        items: (report.highlights ?? []).slice(0, 4)
      },
      {
        sectionId: "confidence-notes",
        title: "Confidence Notes",
        items: (report.narrative ?? []).slice(0, 2)
      }
    ];
  }

  if (fabricRisk.length) {
      return [
        {
          sectionId: "ranked-signals",
          title: "Infrastructure Signals",
          items: fabricRisk.slice(0, 4).map((entry) => `${entry.metric?.instance ?? "unknown"}: ${Number(entry.value).toFixed(0)}`)
        }
    ];
  }

  if (hotGpus.length) {
      return [
        {
          sectionId: "peak-metrics",
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
  constructor({ configStore, eventBus, widgetService, logger, billingTracker = null }) {
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
    this.billingTracker = billingTracker;
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
    await this.billingTracker?.recordResponseUsage({
      response,
      model: appConfig.agent?.model ?? "gpt-5.4",
      operation: "domain_generation",
      provider: "openai-responses"
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
    const plannerContext = compactContextForPlanner(context);
    const plannerDomain = compactDomain(domain);
    const plannerRuns = compactRecentRuns(recentRuns);
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
              text: `Domain summary:\n${JSON.stringify(plannerDomain, null, 2)}\n\nCurrent source preview summary:\n${JSON.stringify(plannerContext, null, 2)}\n\nRecent run summary:\n${JSON.stringify(plannerRuns, null, 2)}\n\nPlanning reason: ${reason}\nPreferred panel: ${preferredPanelId ?? "none"}\n\nReturn a workspace plan that keeps the UI stable while promoting the most relevant analysis.`
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
    await this.billingTracker?.recordResponseUsage({
      response,
      model: appConfig.agent?.model ?? "gpt-5.4",
      operation: "workspace_planning",
      provider: "openai-responses",
      domainId
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
    const compactContext = compactContextForPanel(panel, context);

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
                text: `Domain summary:\n${JSON.stringify({ id: domain.id, name: domain.name }, null, 2)}\n\nPanel summary:\n${JSON.stringify(compactPanel(panel), null, 2)}\n\nArchetype policy:\n${JSON.stringify(archetypeBlock, null, 2)}\n\nCurrent source preview summary:\n${JSON.stringify(compactContext, null, 2)}\n\nPick the best archetype from the allowed set for the current evidence.`
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
      await this.billingTracker?.recordResponseUsage({
        response,
        model: appConfig.agent?.model ?? "gpt-5.4",
        operation: "archetype_selection",
        provider: "openai-responses",
        domainId: domain.id,
        panelId: panel.id,
        panelTitle: panel.title
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
    const analysisContract = buildArchetypeAnalysisContract(appConfig, archetypeSelection.selectedArchetype);
    const analysisContext = compactContextForPanel(panel, context);
    const analysisDomain = compactDomain(domain);
    const analysisPanel = compactPanel(panel);
    const analysisWorkspacePlan = compactWorkspacePlan(workspacePlan, panel.id);
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
      billing: {},
      selectedArchetype: archetypeSelection.selectedArchetype,
      archetypeReason: archetypeSelection.reason,
      archetypeConfidence: archetypeSelection.confidence,
      archetypeTitle: selectedArchetypeDefinition?.title ?? archetypeSelection.selectedArchetype,
      remoteResponseId: null,
      widgetId: null,
      widgetUrl: null
    };

    if (!this.openai && run.report) {
      run.report.details = mergeArchetypeDetails(
        analysisContract,
        run.report.details,
        buildArchetypeDetails({ run, report: run.report, context: run.context })
      );
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

    const previousResponseId = appConfig.agent?.reuseResponseHistory ? sessions[domainId]?.previousResponseId : undefined;
    const response = await this.openai.responses.create({
      model: appConfig.agent?.model ?? "gpt-5.4",
      store: true,
      background: Boolean(appConfig.agent?.allowBackground),
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
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
                  "You are an analytical backend. Return strict JSON with keys narrative, highlights, details, and chart. The details array is required for the selected archetype. The chart object must contain type, title, labels, and values."
              }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Domain summary:\n${JSON.stringify(analysisDomain, null, 2)}\n\nWorkspace plan summary:\n${JSON.stringify(analysisWorkspacePlan, null, 2)}\n\nPanel summary:\n${JSON.stringify(analysisPanel, null, 2)}\n\nSelected archetype:\n${JSON.stringify({
                id: run.selectedArchetype,
                title: run.archetypeTitle,
                reason: run.archetypeReason,
                confidence: run.archetypeConfidence,
                allowedArchetypes: getPanelAllowedArchetypes(appConfig, domain, panel)
              }, null, 2)}\n\nArchetype analysis contract:\n${JSON.stringify(analysisContract, null, 2)}\n\nCurrent source preview summary:\n${JSON.stringify(analysisContext, null, 2)}\n\nTask:\n${this.buildAnalysisTask(panel, workspacePlan)}\n\nReturn details as an array of section objects. Each section should include sectionId, title, and items. Use the section ids and titles from the archetype analysis contract.`
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

    if (appConfig.agent?.reuseResponseHistory) {
      sessions[domainId] = {
        previousResponseId: response.id,
        updatedAt: new Date().toISOString()
      };
      await this.configStore.saveSessions(sessions);
    }

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
    const analysisContract = buildArchetypeAnalysisContract(await this.configStore.getAppConfig(), run.selectedArchetype);
    const preliminaryReport = normalizeReport(parsed, panel);
    run.report = normalizeReport(
      parsed,
      panel,
      analysisContract,
      buildArchetypeDetails({ run, report: preliminaryReport, context: run.context })
    );
    const missingSections = missingArchetypeSections(analysisContract, run.report.details);
    if (!run.billing?.analysisEntryId) {
      const entry = await this.billingTracker?.recordResponseUsage({
        response,
        model: (await this.configStore.getAppConfig()).agent?.model ?? "gpt-5.4",
        operation: "panel_analysis",
        provider: "openai-responses",
        domainId: run.domainId,
        panelId: run.panelId,
        panelTitle: run.panelTitle,
        archetypeId: run.selectedArchetype,
        archetypeTitle: run.archetypeTitle,
        runId: run.id
      });
      if (entry) {
        run.billing = {
          ...(run.billing ?? {}),
          analysisEntryId: entry.id
        };
        run.analysisUsage = entry.usage;
        run.analysisCost = entry.cost;
      }
    }
    if (missingSections.length) {
      this.logger.warn("Analysis completed with incomplete archetype detail coverage", {
        runId,
        panelId: panel.id,
        selectedArchetype: run.selectedArchetype,
        missingSections
      }, "analysis");
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
      const { widget, billingEntry } = await this.widgetService.generateForRun({ domain, panel, run });
      run.widgetId = widget.id;
      run.widgetUrl = `/generated/widgets/${widget.id}`;
      run.widgetGeneratedAt = widget.generatedAt ?? new Date().toISOString();
      run.widgetStatus = "completed";
      if (billingEntry) {
        run.billing = {
          ...(run.billing ?? {}),
          widgetEntryId: billingEntry.id
        };
        run.widgetUsage = billingEntry.usage;
        run.widgetCost = billingEntry.cost;
      }
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
