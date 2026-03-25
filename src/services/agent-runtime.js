import crypto from "node:crypto";
import OpenAI from "openai";
import { gatherDomainContext } from "./data-sources.js";
import {
  buildDeterministicDomainSummary,
  buildDeterministicPanelSummary,
  getRelevantQueryNamesFromRecipe,
  listDeterministicTools
} from "./analysis-tools.js";
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
  required: ["id", "name", "description", "color", "icon", "allowedArchetypes", "dataSources", "analysisRecipe", "panels"],
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
    analysisRecipe: {
      type: "object",
      additionalProperties: false,
      required: ["focus", "blocks"],
      properties: {
        focus: { type: "string" },
        blocks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "operation"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              operation: {
                type: "string",
                enum: ["scalar", "top_entries"]
              },
              description: { type: "string" },
              queryName: { type: "string" },
              queryNames: {
                type: "array",
                items: { type: "string" }
              },
              labelFields: {
                type: "array",
                items: { type: "string" }
              },
              valueField: { type: "string" },
              valueTransform: {
                type: "string",
                enum: ["identity", "percent"]
              },
              unit: { type: "string" },
              decimals: { type: "integer" },
              limit: { type: "integer" },
              sort: {
                type: "string",
                enum: ["asc", "desc"]
              }
            }
          }
        }
      }
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
          "archetypeGuidance",
          "analysisRecipe"
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
          archetypeGuidance: { type: "string" },
          analysisRecipe: {
            type: "object",
            additionalProperties: false,
            required: ["focus", "blocks"],
            properties: {
              focus: { type: "string" },
              blocks: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "title", "operation"],
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    operation: {
                      type: "string",
                      enum: ["scalar", "top_entries"]
                    },
                    description: { type: "string" },
                    queryName: { type: "string" },
                    queryNames: {
                      type: "array",
                      items: { type: "string" }
                    },
                    labelFields: {
                      type: "array",
                      items: { type: "string" }
                    },
                    valueField: { type: "string" },
                    valueTransform: {
                      type: "string",
                      enum: ["identity", "percent"]
                    },
                    unit: { type: "string" },
                    decimals: { type: "integer" },
                    limit: { type: "integer" },
                    sort: {
                      type: "string",
                      enum: ["asc", "desc"]
                    }
                  }
                }
              }
            }
          }
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

function compactDomain(domain) {
  return {
    id: domain.id,
    name: domain.name,
    description: domain.description,
    dataSources: domain.dataSources,
    allowedArchetypes: domain.allowedArchetypes ?? [],
    analysisRecipe: domain.analysisRecipe
      ? {
          focus: domain.analysisRecipe.focus,
          blocks: (domain.analysisRecipe.blocks ?? []).map((block) => ({
            id: block.id,
            title: block.title,
            operation: block.operation,
            queryName: block.queryName ?? null,
            queryNames: block.queryNames ?? [],
            labelFields: block.labelFields ?? [],
            valueTransform: block.valueTransform ?? "identity",
            unit: block.unit ?? "",
            limit: block.limit ?? null
          }))
        }
      : null,
    panels: (domain.panels ?? []).map((panel) => ({
      id: panel.id,
      title: panel.title,
      summary: panel.summary,
      chartPreference: panel.chartPreference,
      allowedArchetypes: panel.allowedArchetypes ?? [],
      preferredArchetype: panel.preferredArchetype ?? null,
      analysisRecipe: panel.analysisRecipe
        ? {
            focus: panel.analysisRecipe.focus,
            blocks: (panel.analysisRecipe.blocks ?? []).map((block) => ({
              id: block.id,
              title: block.title,
              operation: block.operation,
              queryName: block.queryName ?? null,
              queryNames: block.queryNames ?? [],
              labelFields: block.labelFields ?? [],
              valueTransform: block.valueTransform ?? "identity",
              unit: block.unit ?? "",
              limit: block.limit ?? null
            }))
          }
        : null
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
    analysisPrompt: panel.analysisPrompt,
    analysisRecipe: panel.analysisRecipe
      ? {
          focus: panel.analysisRecipe.focus,
          blocks: (panel.analysisRecipe.blocks ?? []).map((block) => ({
            id: block.id,
            title: block.title,
            operation: block.operation,
            queryName: block.queryName ?? null,
            queryNames: block.queryNames ?? [],
            labelFields: block.labelFields ?? [],
            valueTransform: block.valueTransform ?? "identity",
            unit: block.unit ?? "",
            limit: block.limit ?? null
          }))
        }
      : null
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
  return getRelevantQueryNamesFromRecipe(panel?.analysisRecipe);
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
    analysisRecipe: {
      focus: "Summarize the broadest operating picture from local preview evidence.",
      blocks: [
        {
          id: "overview-signals",
          title: "Overview Signals",
          operation: "top_entries",
          queryName: "pendingJobsByPartition",
          labelFields: ["partition"],
          valueField: "pendingJobs",
          limit: 3,
          sort: "desc"
        }
      ]
    },
    panels: [
      {
        id: "overview",
        title: "Domain Overview",
        summary: "Summarize the main health or performance signals across configured sources.",
        analysisPrompt: "Explain the most relevant operating picture across the configured domain sources.",
        chartPreference: "bar",
        allowedArchetypes: ["incident-summary", "risk-scoreboard"],
        preferredArchetype: "incident-summary",
        archetypeGuidance: "Use incident-summary for broad synthesis and risk-scoreboard when ranked outliers dominate.",
        analysisRecipe: {
          focus: "Summarize the main signals visible in the local preview results.",
          blocks: [
            {
              id: "overview-signals",
              title: "Overview Signals",
              operation: "top_entries",
              queryName: "pendingJobsByPartition",
              labelFields: ["partition"],
              valueField: "pendingJobs",
              limit: 4,
              sort: "desc"
            }
          ]
        }
      },
      {
        id: "anomalies",
        title: "Anomalies",
        summary: "Identify outliers, correlated warnings, and likely investigation targets.",
        analysisPrompt: "Find the most important anomalies or outliers and explain why they matter.",
        chartPreference: "line",
        allowedArchetypes: ["risk-scoreboard", "timeline-analysis"],
        preferredArchetype: "risk-scoreboard",
        archetypeGuidance: "Use timeline-analysis only when the anomaly story is fundamentally temporal.",
        analysisRecipe: {
          focus: "Surface the strongest outlier signals from local preview results.",
          blocks: [
            {
              id: "anomaly-signals",
              title: "Anomaly Signals",
              operation: "top_entries",
              queryName: "hotGpusByTemperature",
              labelFields: ["instance", "card"],
              valueField: "temperatureC",
              unit: "C",
              limit: 4,
              sort: "desc"
            }
          ]
        }
      },
      {
        id: "briefing",
        title: "Executive Briefing",
        summary: "Convert the current state into a concise decision-oriented brief.",
        analysisPrompt: "Generate a concise operational briefing with priorities, risks, and confidence notes.",
        chartPreference: "donut",
        allowedArchetypes: ["incident-summary"],
        preferredArchetype: "incident-summary",
        archetypeGuidance: "Keep the briefing narrative-first.",
        analysisRecipe: {
          focus: "Collect the highest-priority evidence for a brief operational handoff.",
          blocks: [
            {
              id: "brief-signals",
              title: "Brief Signals",
              operation: "top_entries",
              queryName: "pendingJobsByPartition",
              labelFields: ["partition"],
              valueField: "pendingJobs",
              limit: 3,
              sort: "desc"
            }
          ]
        }
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
  const latestRunsByPanel = new Map();
  for (const run of recentRuns) {
    const current = latestRunsByPanel.get(run.panelId);
    if (!current || new Date(run.updatedAt ?? 0).getTime() > new Date(current.updatedAt ?? 0).getTime()) {
      latestRunsByPanel.set(run.panelId, run);
    }
  }

  const panelScores = domain.panels.map((panel) => {
    const summary = buildDeterministicPanelSummary(panel, context);
    const findings = Array.isArray(summary.findings) ? summary.findings : [];
    const rankedFindings = findings.filter((finding) => finding.operation === "top_entries");
    const scalarFindings = findings.filter((finding) => finding.operation === "scalar");
    const rankedEntryCount = rankedFindings.reduce((count, finding) => count + (finding.entries?.length ?? 0), 0);
    const nonZeroScalarCount = scalarFindings.filter((finding) => Number(finding.value) !== 0).length;
    const warningCount = summary.coverage?.warningSources?.length ?? 0;
    const latestRun = latestRunsByPanel.get(panel.id) ?? null;
    const failedBonus = latestRun?.status === "failed" ? 2 : 0;
    const staleBonus = !latestRun || latestRun.status !== "completed" ? 1 : 0;
    const score = rankedEntryCount * 3 + nonZeroScalarCount * 2 + failedBonus + staleBonus - warningCount;

    return {
      panel,
      summary,
      latestRun,
      rankedEntryCount,
      nonZeroScalarCount,
      warningCount,
      score
    };
  });

  const sortedPanels = [...panelScores].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.panel.title.localeCompare(right.panel.title);
  });
  const recommendedActions = [];
  const preferredFocus = preferredPanelId && panelIds(domain).includes(preferredPanelId) ? preferredPanelId : null;
  const topPanel = sortedPanels[0] ?? null;
  const focusPanelId = preferredFocus ?? topPanel?.panel.id ?? domain.panels[0]?.id ?? "";
  const focusPanel = sortedPanels.find((entry) => entry.panel.id === focusPanelId) ?? topPanel;
  let rationale = "Workspace remains centered on the configured domain panels.";

  if (!preferredFocus && focusPanel) {
    rationale = `${focusPanel.panel.title} has been promoted because its configured local analysis recipe currently yields the strongest evidence density.`;
    recommendedActions.push(`Use ${focusPanel.panel.title} as the verification anchor; its local recipe surfaced the strongest current evidence.`);
  }

  if (focusPanel?.warningCount) {
    recommendedActions.push(`Validate datasource readiness before over-trusting ${focusPanel.panel.title}; some preview sources reported warnings.`);
  }

  if (recentRuns.some((run) => run.status === "failed")) {
    recommendedActions.push("Re-run failed panels after reviewing datasource readiness and widget generation state.");
  }

  const rankedPanelIds = sortedPanels.map((entry) => entry.panel.id);
  const visiblePanelIds = [
    focusPanelId,
    ...rankedPanelIds.filter((panelId) => panelId !== focusPanelId),
    ...panelIds(domain).filter((panelId) => !rankedPanelIds.includes(panelId) && panelId !== focusPanelId)
  ].filter((panelId, index, values) => panelId && values.indexOf(panelId) === index);

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

function buildEvidencePools({ panel, report, context }) {
  const summary = buildDeterministicPanelSummary(panel, context);
  const findings = Array.isArray(summary.findings) ? summary.findings : [];
  const recipeText = [
    panel?.analysisRecipe?.focus ?? "",
    ...((panel?.analysisRecipe?.blocks ?? []).flatMap((block) => [
      block.title ?? "",
      block.description ?? "",
      block.queryName ?? "",
      ...(block.queryNames ?? [])
    ]))
  ]
    .join(" ")
    .toLowerCase();

  const rankedFindings = findings.filter((finding) => finding.operation === "top_entries");
  const scalarFindings = findings.filter((finding) => finding.operation === "scalar");
  const rankedItems = rankedFindings.flatMap((finding) =>
    (finding.entries ?? []).map((entry) => ({
      label: String(entry.label ?? "unknown"),
      displayValue: String(entry.displayValue ?? entry.value ?? ""),
      text: `${entry.label ?? "unknown"}: ${entry.displayValue ?? entry.value ?? ""}`,
      queryName: entry.queryName ?? null,
      title: finding.title
    }))
  );
  const scalarItems = scalarFindings.map((finding) => ({
    text: `${finding.title}: ${finding.displayValue}`,
    title: finding.title
  }));
  const chartItems = topChartPairs(report).map((entry) => `${entry.label}: ${entry.numericValue}`);
  const narrativeItems = [...(report.highlights ?? []), ...(report.narrative ?? [])].map(String).filter(Boolean);
  const coverageItems = [
    ...(summary.coverage?.warningSources ?? []).map((warning) => `${warning.sourceName}: ${warning.message}`),
    summary.coverage?.queryWindow?.evaluationTime ? `Evidence window anchored at ${summary.coverage.queryWindow.evaluationTime}.` : null
  ].filter(Boolean);

  const jobItems = rankedItems.filter((item) => /job|user|partition/i.test(item.text) || /job|user|partition/i.test(recipeText));
  const partitionItems = rankedItems.filter((item) => /partition/i.test(item.text) || /partition|backlog|saturation|pressure|capacity/i.test(recipeText));
  const percentItems = rankedItems.filter((item) => /%|percent/i.test(item.displayValue));

  return {
    recipeText,
    rankedItems,
    scalarItems,
    chartItems,
    narrativeItems,
    coverageItems,
    jobItems,
    partitionItems,
    percentItems
  };
}

function uniqueItems(items = [], limit = 5) {
  return [...new Set(items.filter(Boolean))].slice(0, limit);
}

function sectionItemsForArchetype(sectionId, pools) {
  const ranked = uniqueItems([...pools.rankedItems.map((item) => item.text), ...pools.chartItems], 5);
  const notes = uniqueItems([...pools.narrativeItems, ...pools.coverageItems], 4);
  const jobs = uniqueItems(pools.jobItems.map((item) => item.text), 5);
  const partition = uniqueItems(
    [...pools.percentItems.map((item) => item.text), ...pools.partitionItems.map((item) => item.text)],
    5
  );
  const scalar = uniqueItems(pools.scalarItems.map((item) => item.text), 4);

  switch (sectionId) {
    case "pressure-metrics":
      return partition.length ? partition : ranked;
    case "backlog-board":
      return uniqueItems([...pools.partitionItems.map((item) => item.text), ...ranked], 5);
    case "capacity-notes":
    case "triage-summary":
    case "operator-notes":
    case "timeline-overview":
    case "trend-notes":
    case "briefing":
    case "actions":
    case "confidence-notes":
    case "candidate-drilldowns":
    case "attribution-notes":
      return notes.length ? notes : ranked;
    case "ranked-signals":
    case "peak-metrics":
    case "evidence-matrix":
    case "resource-profile":
      return ranked.length ? ranked : [...scalar, ...notes];
    case "entity-links":
    case "job-header":
      return jobs.length ? jobs : ranked;
    default:
      return ranked.length ? ranked : [...scalar, ...notes];
  }
}

function buildArchetypeDetails({ appConfig, panel, run, report, context }) {
  const contract = buildArchetypeAnalysisContract(appConfig, run.selectedArchetype ?? "incident-summary");
  if (!contract?.detailSections?.length) {
    return [];
  }

  const pools = buildEvidencePools({ panel, report, context });
  return contract.detailSections
    .map((section) => ({
      sectionId: section.id,
      title: section.title,
      items: sectionItemsForArchetype(section.id, pools).slice(0, section.maxItems ?? 5)
    }))
    .filter((section) => section.items.length);
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
  const evidence = buildEvidencePools({ panel, report: { chart: { labels: [], values: [] }, highlights: [], narrative: [] }, context });
  const hasStructuredRankings = evidence.rankedItems.length >= 3;
  const hasJobLinks = evidence.jobItems.length >= 2;
  const hasPartitionPressure = evidence.partitionItems.length >= 2 || evidence.percentItems.length >= 2;
  const hasLineBias = panel.chartPreference === "line";
  const focusText = (panel.analysisRecipe?.focus ?? "").toLowerCase();

  const scores = new Map(allowedArchetypes.map((id) => [id, id === preferredArchetype ? 2 : 0]));
  if (scores.has("pressure-board") && hasPartitionPressure) scores.set("pressure-board", scores.get("pressure-board") + 4);
  if (scores.has("correlation-inspector") && hasJobLinks) scores.set("correlation-inspector", scores.get("correlation-inspector") + 4);
  if (scores.has("job-detail-sheet") && hasJobLinks) scores.set("job-detail-sheet", scores.get("job-detail-sheet") + 3);
  if (scores.has("timeline-analysis") && (hasLineBias || /trend|timeline|window|over time|history/i.test(focusText))) {
    scores.set("timeline-analysis", scores.get("timeline-analysis") + 3);
  }
  if (scores.has("risk-scoreboard") && hasStructuredRankings) scores.set("risk-scoreboard", scores.get("risk-scoreboard") + 3);
  if (scores.has("incident-summary")) scores.set("incident-summary", scores.get("incident-summary") + (evidence.narrativeItems.length ? 2 : 1));

  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  const [selectedArchetype] = ranked[0] ?? [pickAvailableArchetype(allowedArchetypes, preferredArchetype, null)];
  const secondScore = ranked[1]?.[1] ?? -Infinity;
  const topScore = ranked[0]?.[1] ?? 0;
  const confidence = topScore - secondScore >= 3 ? "high" : topScore - secondScore >= 1 ? "medium" : "low";
  const reasonParts = [];
  if (selectedArchetype === preferredArchetype) {
    reasonParts.push("The preferred archetype remains aligned with the configured recipe focus.");
  }
  if (selectedArchetype === "pressure-board" && hasPartitionPressure) {
    reasonParts.push("Recipe evidence is dominated by backlog or saturation style partition signals.");
  }
  if ((selectedArchetype === "correlation-inspector" || selectedArchetype === "job-detail-sheet") && hasJobLinks) {
    reasonParts.push("The local evidence contains clear multi-entity job, user, partition, or host links.");
  }
  if (selectedArchetype === "timeline-analysis" && hasLineBias) {
    reasonParts.push("The panel is configured for line-oriented presentation and temporal interpretation.");
  }
  if (selectedArchetype === "risk-scoreboard" && hasStructuredRankings) {
    reasonParts.push("The strongest local evidence is a ranked set of outliers or leaders.");
  }
  if (!reasonParts.length) {
    reasonParts.push("No stronger evidence pattern displaced the preferred allowed archetype.");
  }

  return {
    selectedArchetype,
    reason: reasonParts.join(" "),
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
              text: `Available data sources:\n${JSON.stringify(dataSources, null, 2)}\n\nAvailable widget archetypes:\n${JSON.stringify(getArchetypeRegistry(appConfig), null, 2)}\n\nCreate a domain configuration from this prompt:\n${prompt}\n\nMorphy is a metamorphic system, so generate a domain-level analysisRecipe and a panel-level analysisRecipe for every panel. Recipes must describe how deterministic local tools should summarize data using only scalar or top_entries blocks. Every panel must also declare allowedArchetypes, preferredArchetype, and archetypeGuidance. Choose only archetype ids from the available registry. The domain-level allowedArchetypes should be the union of archetypes that make sense for the domain.`
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
    const plannerToolSummary = buildDeterministicDomainSummary(domain, context);
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
              text: `You are planning workspace priority, not doing raw numerical analysis. Use the local deterministic tool outputs as the primary evidence source and use the minimal preview summary only for grounding.\n\nAvailable local deterministic tools:\n${JSON.stringify(listDeterministicTools(), null, 2)}\n\nDomain summary:\n${JSON.stringify(plannerDomain, null, 2)}\n\nDeterministic domain tool output:\n${JSON.stringify(plannerToolSummary, null, 2)}\n\nMinimal source preview summary:\n${JSON.stringify(plannerContext, null, 2)}\n\nRecent run summary:\n${JSON.stringify(plannerRuns, null, 2)}\n\nPlanning reason: ${reason}\nPreferred panel: ${preferredPanelId ?? "none"}\n\nReturn a workspace plan that keeps the UI stable while promoting the most relevant analysis.`
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
    const panelToolSummary = buildDeterministicPanelSummary(panel, context);

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
                text: `Pick the best archetype from the allowed set using the deterministic local tool output as the primary evidence source.\n\nAvailable local deterministic tools:\n${JSON.stringify(listDeterministicTools(), null, 2)}\n\nDomain summary:\n${JSON.stringify({ id: domain.id, name: domain.name }, null, 2)}\n\nPanel summary:\n${JSON.stringify(compactPanel(panel), null, 2)}\n\nArchetype policy:\n${JSON.stringify(archetypeBlock, null, 2)}\n\nDeterministic panel tool output:\n${JSON.stringify(panelToolSummary, null, 2)}\n\nMinimal source preview summary:\n${JSON.stringify(compactContext, null, 2)}`
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
    const analysisDomainTools = buildDeterministicDomainSummary(domain, context);
    const analysisPanelTools = buildDeterministicPanelSummary(panel, context);
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
        buildArchetypeDetails({ appConfig, panel, run, report: run.report, context: run.context })
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
                  "You are an analytical backend. Local deterministic tools have already computed the numerical and ranking work. Your job is planning, interpretation, confidence handling, and presentation. Return strict JSON with keys narrative, highlights, details, and chart. The details array is required for the selected archetype. The chart object must contain type, title, labels, and values."
              }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Available local deterministic tools:\n${JSON.stringify(listDeterministicTools(), null, 2)}\n\nDomain summary:\n${JSON.stringify(analysisDomain, null, 2)}\n\nWorkspace plan summary:\n${JSON.stringify(analysisWorkspacePlan, null, 2)}\n\nPanel summary:\n${JSON.stringify(analysisPanel, null, 2)}\n\nSelected archetype:\n${JSON.stringify({
                id: run.selectedArchetype,
                title: run.archetypeTitle,
                reason: run.archetypeReason,
                confidence: run.archetypeConfidence,
                allowedArchetypes: getPanelAllowedArchetypes(appConfig, domain, panel)
              }, null, 2)}\n\nArchetype analysis contract:\n${JSON.stringify(analysisContract, null, 2)}\n\nDeterministic domain tool output:\n${JSON.stringify(analysisDomainTools, null, 2)}\n\nDeterministic panel tool output:\n${JSON.stringify(analysisPanelTools, null, 2)}\n\nMinimal source preview summary:\n${JSON.stringify(analysisContext, null, 2)}\n\nTask:\n${this.buildAnalysisTask(panel, workspacePlan)}\n\nReturn details as an array of section objects. Each section should include sectionId, title, and items. Use the section ids and titles from the archetype analysis contract.`
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
    const currentAppConfig = await this.configStore.getAppConfig();
    const analysisContract = buildArchetypeAnalysisContract(currentAppConfig, run.selectedArchetype);
    const preliminaryReport = normalizeReport(parsed, panel);
    run.report = normalizeReport(
      parsed,
      panel,
      analysisContract,
      buildArchetypeDetails({ appConfig: currentAppConfig, panel, run, report: preliminaryReport, context: run.context })
    );
    const missingSections = missingArchetypeSections(analysisContract, run.report.details);
    if (!run.billing?.analysisEntryId) {
      const entry = await this.billingTracker?.recordResponseUsage({
        response,
        model: currentAppConfig.agent?.model ?? "gpt-5.4",
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
