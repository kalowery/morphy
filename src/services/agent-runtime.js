import crypto from "node:crypto";
import OpenAI from "openai";
import { gatherDomainContext, previewSource } from "./data-sources.js";
import {
  buildDeterministicDomainSummary,
  buildDeterministicPanelSummary,
  buildDomainToolRegistry,
  buildPanelToolRegistry,
  executeDerivedTool,
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
    generationPrompt: { type: "string" },
    generationEvidenceSummary: { type: "string" },
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
          },
          interactionMode: {
            type: "string",
            enum: ["report", "interactive", "hybrid"]
          },
          interactionContract: {
            type: "object",
            additionalProperties: false,
            required: ["controls"],
            properties: {
              summary: { type: "string" },
              controls: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label", "type", "parameter", "source"],
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    description: { type: "string" },
                    type: {
                      type: "string",
                      enum: ["single_select", "multi_select", "search", "date_range"]
                    },
                    parameter: { type: "string" },
                    source: {
                      type: "string",
                      enum: ["label_values", "query_window"]
                    },
                    queryName: { type: "string" },
                    field: { type: "string" },
                    displayFields: {
                      type: "array",
                      items: { type: "string" }
                    },
                    maxOptions: { type: "integer" },
                    multiple: { type: "boolean" },
                    required: { type: "boolean" },
                    defaultStrategy: {
                      type: "string",
                      enum: ["none", "top", "all"]
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

const analysisReportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["narrative", "highlights", "details", "chart"],
  properties: {
    narrative: {
      type: "array",
      items: { type: "string" }
    },
    highlights: {
      type: "array",
      items: { type: "string" }
    },
    details: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sectionId", "title", "items"],
        properties: {
          sectionId: { type: "string" },
          title: { type: "string" },
          items: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    },
    chart: {
      type: "object",
      additionalProperties: false,
      required: ["type", "title", "labels", "values"],
      properties: {
        type: { type: "string" },
        title: { type: "string" },
        labels: {
          type: "array",
          items: { type: "string" }
        },
        values: {
          type: "array",
          items: { type: "number" }
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

const plannerToolRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "rationale", "toolCalls"],
  properties: {
    mode: {
      type: "string",
      enum: ["plan", "call_tools"]
    },
    rationale: { type: "string" },
    toolCalls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["toolId", "purpose"],
        properties: {
          toolId: { type: "string" },
          purpose: { type: "string" }
        }
      }
    }
  }
};

const archetypeToolRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "rationale", "toolCalls"],
  properties: {
    mode: {
      type: "string",
      enum: ["select", "call_tools"]
    },
    rationale: { type: "string" },
    toolCalls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["toolId", "purpose"],
        properties: {
          toolId: { type: "string" },
          purpose: { type: "string" }
        }
      }
    }
  }
};

const analysisToolRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "rationale", "toolCalls"],
  properties: {
    mode: {
      type: "string",
      enum: ["analyze", "call_tools"]
    },
    rationale: { type: "string" },
    toolCalls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["toolId", "purpose"],
        properties: {
          toolId: { type: "string" },
          purpose: { type: "string" }
        }
      }
    }
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
    generationEvidenceSummary: domain.generationEvidenceSummary ?? null,
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
    interactionMode: panel.interactionMode ?? "report",
    interactionContract: panel.interactionContract ?? null,
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

function compactToolRegistry(toolRegistry, limit = 12) {
  return {
    domainId: toolRegistry?.domainId ?? null,
    domainName: toolRegistry?.domainName ?? null,
    toolCount: toolRegistry?.toolCount ?? 0,
    tools: (toolRegistry?.tools ?? []).slice(0, limit).map((tool) => ({
      id: tool.id,
      scopeType: tool.scopeType,
      scopeTitle: tool.scopeTitle,
      title: tool.title,
      description: tool.description,
      operation: tool.operation,
      queryNames: tool.queryNames ?? [],
      valueField: tool.valueField ?? null,
      limit: tool.limit ?? null,
      focus: tool.focus ?? ""
    }))
  };
}

function compactToolRegistryIds(toolRegistry) {
  return (toolRegistry?.tools ?? []).map((tool) => tool.id);
}

function compactToolResultForModel(execution) {
  const result = execution?.result ?? {};
  return {
    tool: execution?.tool ?? null,
    result: {
      blockId: result.blockId ?? null,
      title: result.title ?? null,
      operation: result.operation ?? null,
      displayValue: result.displayValue ?? null,
      value: result.value ?? null,
      entries: (result.entries ?? []).slice(0, 5).map((entry) => ({
        label: entry.label,
        displayValue: entry.displayValue
      }))
    }
  };
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

function compactSourceMetadataForGeneration(source) {
  if (source.type === "victoria-metrics") {
    const queryNames = Object.keys(source.queries ?? {});
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      description: source.description ?? "",
      baseUrl: source.baseUrl ?? null,
      window: {
        evaluationTime: source.defaultEvaluationTime ?? source.time ?? null,
        start: source.start ?? null,
        end: source.end ?? null
      },
      previewQueryNames: (source.previewQueryNames ?? []).slice(0, 10),
      availableQueryNames: queryNames.slice(0, 16),
      availableQueryCount: queryNames.length
    };
  }

  if (source.type === "json-file") {
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      description: source.description ?? "",
      path: source.path ?? null
    };
  }

  if (source.type === "relational") {
    const sampleRows = Array.isArray(source.sampleRows) ? source.sampleRows : [];
    const sampleColumns = collectTopKeys(sampleRows, 10);
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      description: source.description ?? "",
      sampleColumns,
      sampleRowCount: sampleRows.length
    };
  }

  return {
    id: source.id,
    name: source.name,
    type: source.type,
    description: source.description ?? ""
  };
}

const QUERY_LANGUAGE_TOKENS = new Set([
  "and",
  "bool",
  "by",
  "group_left",
  "group_right",
  "ignoring",
  "last_over_time",
  "max_over_time",
  "min_over_time",
  "avg_over_time",
  "sum_over_time",
  "count_over_time",
  "increase",
  "rate",
  "irate",
  "delta",
  "deriv",
  "predict_linear",
  "topk",
  "bottomk",
  "sort",
  "sort_desc",
  "sum",
  "avg",
  "max",
  "min",
  "count",
  "stddev",
  "stdvar",
  "quantile",
  "without",
  "on",
  "or",
  "unless",
  "offset"
]);

function extractMetricHints(expression, limit = 8) {
  if (typeof expression !== "string" || !expression.trim()) {
    return [];
  }

  const matches = expression.match(/\b[a-zA-Z_:][a-zA-Z0-9_:]*\b/g) ?? [];
  const unique = [];

  for (const token of matches) {
    if (QUERY_LANGUAGE_TOKENS.has(token)) {
      continue;
    }

    if (!token.includes("_") && !token.includes(":")) {
      continue;
    }

    if (!unique.includes(token)) {
      unique.push(token);
    }

    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

function collectTopKeys(items = [], limit = 6) {
  const counts = new Map();

  for (const item of items) {
    for (const key of Object.keys(item ?? {})) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key]) => key);
}

function collectRepresentativeValues(items = [], limit = 5) {
  const values = [];

  for (const item of items) {
    for (const [key, value] of Object.entries(item ?? {})) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      const rendered = String(value);
      if (!values.some((entry) => entry.key === key && entry.value === rendered)) {
        values.push({ key, value: rendered });
      }

      if (values.length >= limit) {
        return values;
      }
    }
  }

  return values;
}

function compactVictoriaResultForGeneration(result) {
  const sample = result.sample ?? [];
  const metrics = sample.map((entry) => entry.metric ?? {});
  const labelKeys = collectTopKeys(metrics, 6);
  const representativeLabels = collectRepresentativeValues(metrics, 6);

  return {
    queryName: result.queryName,
    resultType: result.resultType,
    resultCount: result.resultCount,
    labelKeys,
    representativeLabels,
    sample: sample.slice(0, 3).map((entry) => ({
      labels: formatMetricLabels(entry.metric ?? {}),
      value: entry.value
    }))
  };
}

function compactPreviewForGeneration(source, preview) {
  const base = {
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    description: source.description ?? "",
    status: preview.status
  };

  if (preview.status !== "ready") {
    return {
      ...base,
      issue: preview.detail?.message ?? "Preview unavailable"
    };
  }

  if (source.type === "victoria-metrics") {
    return {
      ...base,
      window: preview.detail?.queryWindow ?? null,
      previewQueries: (source.previewQueryNames ?? []).slice(0, 8),
      queryCatalog: Object.entries(source.queries ?? {})
        .slice(0, 10)
        .map(([queryName, queryExpression]) => ({
          queryName,
          metricHints: extractMetricHints(queryExpression, 6)
        })),
      queryResults: (preview.detail?.queryResults ?? []).slice(0, 8).map((result) => compactVictoriaResultForGeneration(result))
    };
  }

  if (source.type === "json-file" || source.type === "relational") {
    const detail = preview.detail ?? {};
    const sampleRows = Array.isArray(detail.sample) ? detail.sample : [];
    const sampleKeys = collectTopKeys(sampleRows, 8);
    const numericFields = Object.keys(detail.metrics ?? {}).slice(0, 8);

    return {
      ...base,
      rowCount: detail.rowCount ?? 0,
      sampleKeys,
      numericFields,
      sampleRows: sampleRows.slice(0, 3)
    };
  }

  return {
    ...base,
    detail: preview.detail ?? null
  };
}

async function gatherSourceDiscoveryEvidence(dataSources, logger) {
  const previews = await Promise.all(
    dataSources.map(async (source) => ({
      source,
      preview: await previewSource(source, { logger })
    }))
  );

  return previews.map(({ source, preview }) => compactPreviewForGeneration(source, preview));
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

function compactInteractionEvidence(interaction) {
  const findings = interaction?.data?.findings ?? interaction?.data?.localFindings?.findings ?? [];
  return {
    summary: interaction?.summary ?? "",
    params: interaction?.params ?? {},
    coverage: interaction?.data?.coverage ?? interaction?.data?.localFindings?.coverage ?? null,
    report: {
      narrative: (interaction?.data?.report?.narrative ?? []).slice(0, 4),
      highlights: (interaction?.data?.report?.highlights ?? []).slice(0, 6),
      details: (interaction?.data?.report?.details ?? []).slice(0, 4),
      chart: interaction?.data?.chart ?? interaction?.data?.report?.chart ?? null
    },
    findings: findings.slice(0, 6).map((finding) => ({
      blockId: finding.blockId ?? null,
      title: finding.title ?? null,
      operation: finding.operation ?? null,
      displayValue: finding.displayValue ?? null,
      value: finding.value ?? null,
      entries: (finding.entries ?? []).slice(0, 5).map((entry) => ({
        label: entry.label,
        displayValue: entry.displayValue
      }))
    }))
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
    generationEvidenceSummary: sourceIds.length
      ? `Fallback domain based on configured sources: ${sourceIds.join(", ")}. Live datasource semantic grounding was unavailable because the model-backed generation path was not used.`
      : "Fallback domain generated without datasource grounding because no sources were available.",
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
  return run?.status === "in_progress" || run?.status === "queued";
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
    this.activeWidgetGenerations = new Map();
    this.openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  }

  async runPlannerToolLoop({
    appConfig,
    domain,
    plannerDomain,
    plannerContext,
    plannerRuns,
    plannerToolRegistry,
    reason,
    preferredPanelId
  }) {
    const toolTrace = [];
    const availableToolIds = new Set(compactToolRegistryIds(plannerToolRegistry));
    const requireToolCall = Boolean(
      appConfig.agent?.localTools?.enabled &&
        appConfig.agent?.localTools?.primaryForPlanning &&
        Array.isArray(plannerToolRegistry?.tools) &&
        plannerToolRegistry.tools.length
    );
    const toolRequirementText = requireToolCall
      ? "You must request 1 to 3 derived tool calls from the provided registry before a final workspace plan can be produced. Do not return mode=plan on this step."
      : "If the existing evidence is sufficient, you may return mode=plan with no tool calls.";
    const initialResponse = await this.openai.responses.create({
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
                `You plan bounded workspace adaptations for an analytical web app. Keep the host shell stable. ${toolRequirementText} Return strict JSON only.`
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Decide which derived tools, if any, should be invoked before producing a workspace plan.\n\nStable local analysis primitives:\n${JSON.stringify(listDeterministicTools(), null, 2)}\n\nDomain-specific exposed tool registry:\n${JSON.stringify(compactToolRegistry(plannerToolRegistry), null, 2)}\n\nDomain summary:\n${JSON.stringify(plannerDomain, null, 2)}\n\nMinimal source preview summary:\n${JSON.stringify(plannerContext, null, 2)}\n\nRecent run summary:\n${JSON.stringify(plannerRuns, null, 2)}\n\nPlanning reason: ${reason}\nPreferred panel: ${preferredPanelId ?? "none"}\n\n${requireToolCall ? "Return mode=call_tools with 1 to 3 tool calls from the registry. Choose the tools most likely to sharpen panel prioritization or focus." : "If you already have enough evidence, return mode=plan with no tool calls. If you need more evidence, return mode=call_tools with up to 3 tool calls from the registry."}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "planner_tool_request",
          schema: plannerToolRequestSchema,
          strict: true
        }
      }
    });
    await this.billingTracker?.recordResponseUsage({
      response: initialResponse,
      model: appConfig.agent?.model ?? "gpt-5.4",
      operation: "workspace_planning",
      provider: "openai-responses",
      domainId: domain.id
    });

    const decision = initialResponse.output_text
      ? JSON.parse(initialResponse.output_text)
      : extractJson(JSON.stringify(initialResponse.output));
    this.logger.info("Planner tool decision received", {
      domainId: domain.id,
      mode: decision.mode,
      toolCallCount: decision.toolCalls?.length ?? 0,
      required: requireToolCall
    }, "planner");

    if (requireToolCall && (decision.mode !== "call_tools" || !(decision.toolCalls ?? []).length)) {
      const repairResponse = await this.openai.responses.create({
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
                  "You must request derived tools before workspace planning. Return strict JSON only."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The previous response did not request tools, but this planner mode requires tool invocation. Return mode=call_tools with 1 to 3 tool calls from this registry.\n\nDomain-specific exposed tool registry:\n${JSON.stringify(compactToolRegistry(plannerToolRegistry), null, 2)}\n\nDomain summary:\n${JSON.stringify(plannerDomain, null, 2)}\n\nMinimal source preview summary:\n${JSON.stringify(plannerContext, null, 2)}\n\nRecent run summary:\n${JSON.stringify(plannerRuns, null, 2)}\n\nPlanning reason: ${reason}\nPreferred panel: ${preferredPanelId ?? "none"}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "planner_tool_request_repair",
            schema: plannerToolRequestSchema,
            strict: true
          }
        }
      });
      await this.billingTracker?.recordResponseUsage({
        response: repairResponse,
        model: appConfig.agent?.model ?? "gpt-5.4",
        operation: "workspace_planning",
        provider: "openai-responses",
        domainId: domain.id
      });
      const repairedDecision = repairResponse.output_text
        ? JSON.parse(repairResponse.output_text)
        : extractJson(JSON.stringify(repairResponse.output));
      if (repairedDecision.mode === "call_tools" && (repairedDecision.toolCalls ?? []).length) {
        decision.mode = repairedDecision.mode;
        decision.rationale = repairedDecision.rationale;
        decision.toolCalls = repairedDecision.toolCalls;
        this.logger.info("Planner tool decision repaired", {
          domainId: domain.id,
          mode: decision.mode,
          toolCallCount: decision.toolCalls?.length ?? 0
        }, "planner");
      }
    }

    if (decision.mode !== "call_tools" || !(decision.toolCalls ?? []).length) {
      return {
        toolTrace,
        toolDecision: decision,
        finalResponse: null
      };
    }

    let requestedToolCalls = [...(decision.toolCalls ?? [])];
    if (requestedToolCalls.some((toolCall) => toolCall?.toolId && !availableToolIds.has(toolCall.toolId))) {
      const invalidToolIds = requestedToolCalls
        .map((toolCall) => toolCall?.toolId)
        .filter((toolId) => toolId && !availableToolIds.has(toolId));
      this.logger.info("Planner requested invalid tool ids", {
        domainId: domain.id,
        invalidToolIds
      }, "planner");
      const repairInvalidResponse = await this.openai.responses.create({
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
                  "You must request only tool ids that appear in the provided registry. Return strict JSON only."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The previous tool request included invalid tool ids: ${invalidToolIds.join(", ")}.\n\nReturn mode=call_tools with 1 to 3 tool calls using only these valid tools:\n${JSON.stringify(compactToolRegistry(plannerToolRegistry), null, 2)}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "planner_tool_request_registry_repair",
            schema: plannerToolRequestSchema,
            strict: true
          }
        }
      });
      await this.billingTracker?.recordResponseUsage({
        response: repairInvalidResponse,
        model: appConfig.agent?.model ?? "gpt-5.4",
        operation: "workspace_planning",
        provider: "openai-responses",
        domainId: domain.id
      });
      const repairedInvalidDecision = repairInvalidResponse.output_text
        ? JSON.parse(repairInvalidResponse.output_text)
        : extractJson(JSON.stringify(repairInvalidResponse.output));
      if (repairedInvalidDecision.mode === "call_tools" && (repairedInvalidDecision.toolCalls ?? []).length) {
        requestedToolCalls = repairedInvalidDecision.toolCalls;
        this.logger.info("Planner invalid tool request repaired", {
          domainId: domain.id,
          toolCallCount: requestedToolCalls.length
        }, "planner");
      }
    }

    const uniqueToolCalls = [];
    const seen = new Set();
    for (const toolCall of requestedToolCalls.slice(0, 3)) {
      if (!toolCall?.toolId || seen.has(toolCall.toolId) || !availableToolIds.has(toolCall.toolId)) {
        continue;
      }
      seen.add(toolCall.toolId);
      uniqueToolCalls.push(toolCall);
    }

    if (!uniqueToolCalls.length) {
      return {
        toolTrace,
        toolDecision: {
          ...decision,
          mode: "plan",
          rationale: `${decision.rationale} No valid derived tool ids were returned after validation.`
        },
        finalResponse: null
      };
    }

    const toolExecutions = uniqueToolCalls.map((toolCall) => {
      const execution = executeDerivedTool(plannerToolRegistry, plannerContext, toolCall.toolId);
      const traceEntry = {
        toolId: execution.tool.id,
        title: execution.tool.title,
        scopeType: execution.tool.scopeType,
        scopeTitle: execution.tool.scopeTitle,
        operation: execution.tool.operation,
        purpose: toolCall.purpose,
        result: compactToolResultForModel(execution),
        recordedAt: new Date().toISOString()
      };
      toolTrace.push(traceEntry);
      return compactToolResultForModel(execution);
    });
    this.logger.info("Planner tools executed", {
      domainId: domain.id,
      toolIds: toolTrace.map((entry) => entry.toolId),
      toolCount: toolTrace.length
    }, "planner");

    const finalResponse = await this.openai.responses.create({
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
              text: `Use the derived tool outputs below as the primary evidence source for a bounded workspace plan.\n\nDomain summary:\n${JSON.stringify(plannerDomain, null, 2)}\n\nDerived tool outputs:\n${JSON.stringify(toolExecutions, null, 2)}\n\nRecent run summary:\n${JSON.stringify(plannerRuns, null, 2)}\n\nPlanning reason: ${reason}\nPreferred panel: ${preferredPanelId ?? "none"}\n\nReturn a workspace plan that keeps the UI stable while promoting the most relevant analysis.`
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
      response: finalResponse,
      model: appConfig.agent?.model ?? "gpt-5.4",
      operation: "workspace_planning",
      provider: "openai-responses",
      domainId: domain.id
    });
    this.logger.info("Planner final plan response received", {
      domainId: domain.id,
      toolCount: toolTrace.length
    }, "planner");

    return {
      toolTrace,
      toolDecision: decision,
      finalResponse
    };
  }

  async generateDomain(prompt) {
    const dataSources = await this.configStore.getDataSources();
    const appConfig = await this.configStore.getAppConfig();
    const compactSourceMetadata = dataSources.map((source) => compactSourceMetadataForGeneration(source));
    const sourceDiscoveryEvidence = await gatherSourceDiscoveryEvidence(dataSources, this.logger);
    this.logger.info("Generating domain", {
      promptLength: prompt.length,
      dataSourceIds: dataSources.map((source) => source.id),
      readySourceCount: sourceDiscoveryEvidence.filter((source) => source.status === "ready").length,
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
              text: `Available data source metadata:\n${JSON.stringify(compactSourceMetadata, null, 2)}\n\nLive datasource discovery evidence:\n${JSON.stringify(sourceDiscoveryEvidence, null, 2)}\n\nAvailable widget archetypes:\n${JSON.stringify(getArchetypeRegistry(appConfig), null, 2)}\n\nCreate a domain configuration from this prompt:\n${prompt}\n\nMorphy is a metamorphic system, so generate a domain-level analysisRecipe and a panel-level analysisRecipe for every panel. Recipes must describe how deterministic local tools should summarize data using only scalar or top_entries blocks. Every panel must also declare allowedArchetypes, preferredArchetype, and archetypeGuidance. Choose only archetype ids from the available registry. The domain-level allowedArchetypes should be the union of archetypes that make sense for the domain.\n\nUse the live datasource discovery evidence as the primary grounding for semantic understanding of the domain. Infer entities, relationships, and relevant workflows from that evidence when possible. Do not invent metric families, labels, or operational semantics that are not supported by the datasource metadata or live evidence. Include generationEvidenceSummary as a concise explanation of which datasource contents most strongly shaped the resulting domain.`
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
    domain.generationPrompt = prompt;
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
    const plannerToolRegistry = buildDomainToolRegistry(domain);
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
      workspacePlan.toolMode = "recipe-fallback";
      workspacePlan.toolTrace = [];
      await this.configStore.saveWorkspacePlan(domainId, workspacePlan);
      this.eventBus.emit("workspace.update", workspacePlan);
      this.logger.debug("Built fallback workspace plan", {
        domainId,
        focusPanelId: workspacePlan.focusPanelId,
        visiblePanelIds: workspacePlan.visiblePanelIds
      }, "planner");
      return workspacePlan;
    }

    const planningLoop = await this.runPlannerToolLoop({
      appConfig,
      domain,
      plannerDomain,
      plannerContext,
      plannerRuns,
      plannerToolRegistry,
      reason,
      preferredPanelId
    });
    const response = planningLoop.finalResponse;
    const parsed = response?.output_text
      ? JSON.parse(response.output_text)
      : response
        ? extractJson(JSON.stringify(response.output))
        : buildFallbackWorkspacePlan(domain, context, recentRuns, preferredPanelId);
    const workspacePlan = normalizeWorkspacePlan(domain, parsed, preferredPanelId);
    workspacePlan.toolMode = planningLoop.toolTrace.length ? "model-directed" : "model-no-tools";
    workspacePlan.toolTrace = planningLoop.toolTrace;
    workspacePlan.toolDecision = planningLoop.toolDecision ?? null;
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

  async reinterpretFilteredPanel({ domain, panel, context, interaction, runId = null }) {
    const appConfig = await this.configStore.getAppConfig();
    const run = runId ? await this.configStore.getRun(runId) : null;
    const selectedArchetype =
      run?.selectedArchetype ??
      getPreferredArchetype(appConfig, domain, panel) ??
      panel?.preferredArchetype ??
      null;
    const selectedArchetypeDefinition = selectedArchetype
      ? getArchetypeDefinition(appConfig, selectedArchetype)
      : null;
    const analysisContract = buildArchetypeAnalysisContract(appConfig, selectedArchetype);
    const compactDomainSummary = compactDomain(domain);
    const compactPanelSummary = compactPanel(panel);
    const compactContext = compactContextForPanel(panel, context);
    const compactInteraction = compactInteractionEvidence(interaction);
    const fallbackReport = normalizeReport(
      interaction?.data?.report ?? {},
      panel,
      analysisContract,
      buildArchetypeDetails({
        appConfig,
        panel,
        run: {
          ...run,
          selectedArchetype,
          archetypeTitle: selectedArchetypeDefinition?.title ?? selectedArchetype
        },
        report: interaction?.data?.report ?? {},
        context
      })
    );

    if (!this.openai) {
      return {
        report: fallbackReport,
        billingEntry: null
      };
    }

    this.logger.info("Reinterpreting filtered interaction view", {
      domainId: domain.id,
      panelId: panel.id,
      runId,
      selectedArchetype
    }, "analysis");

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
                "You reinterpret a filtered analytical view. Keep the panel structure stable. Use the supplied filtered evidence as the primary source of truth. Return strict JSON only with keys narrative, highlights, details, and chart."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Domain summary:\n${JSON.stringify(compactDomainSummary, null, 2)}\n\nPanel summary:\n${JSON.stringify(compactPanelSummary, null, 2)}\n\nSelected archetype:\n${JSON.stringify({
                id: selectedArchetype,
                title: selectedArchetypeDefinition?.title ?? selectedArchetype,
                contract: analysisContract
              }, null, 2)}\n\nFiltered interaction evidence:\n${JSON.stringify(compactInteraction, null, 2)}\n\nMinimal source preview summary:\n${JSON.stringify(compactContext, null, 2)}\n\nReinterpret this filtered slice only. Do not change the scaffold, controls, or archetype. Refresh the narrative, highlights, details, and chart so they match the selected filters.`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "interactive_reinterpretation",
          schema: analysisReportSchema,
          strict: true
        }
      }
    });

    const billingEntry = await this.billingTracker?.recordResponseUsage({
      response,
      model: appConfig.agent?.model ?? "gpt-5.4",
      operation: "interactive_reinterpretation",
      provider: "openai-responses",
      domainId: domain.id,
      panelId: panel.id,
      panelTitle: panel.title,
      archetypeId: selectedArchetype,
      archetypeTitle: selectedArchetypeDefinition?.title ?? selectedArchetype ?? null,
      runId
    });

    const parsed = response.output_text
      ? JSON.parse(response.output_text)
      : extractJson(JSON.stringify(response.output));

    return {
      report: normalizeReport(
        parsed,
        panel,
        analysisContract,
        buildArchetypeDetails({
          appConfig,
          panel,
          run: {
            ...run,
            selectedArchetype,
            archetypeTitle: selectedArchetypeDefinition?.title ?? selectedArchetype
          },
          report: parsed,
          context
        })
      ),
      billingEntry
    };
  }

  async runArchetypeToolLoop({
    appConfig,
    domain,
    panel,
    archetypeBlock,
    compactContext,
    panelToolSummary,
    panelToolRegistry
  }) {
    const toolTrace = [];
    const billingEntries = [];
    const availableToolIds = new Set(compactToolRegistryIds(panelToolRegistry));
    const requireToolCall = Boolean(
      appConfig.agent?.localTools?.enabled &&
        appConfig.agent?.localTools?.primaryForArchetypeSelection &&
        Array.isArray(panelToolRegistry?.tools) &&
        panelToolRegistry.tools.length
    );
    const toolRequirementText = requireToolCall
      ? "You must request 1 to 2 derived tool calls from the provided registry before final archetype selection. Do not return mode=select on this step."
      : "If the existing evidence is sufficient, you may return mode=select with no tool calls.";
    const initialResponse = await this.openai.responses.create({
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
              text: `Choose the best widget archetype for the current panel from the allowed set only. Favor evidence alignment over novelty. ${toolRequirementText} Return strict JSON only.`
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Decide which derived tools, if any, should be invoked before selecting the archetype.\n\nPanel-specific exposed tool registry:\n${JSON.stringify(compactToolRegistry(panelToolRegistry), null, 2)}\n\nDomain summary:\n${JSON.stringify({ id: domain.id, name: domain.name }, null, 2)}\n\nPanel summary:\n${JSON.stringify(compactPanel(panel), null, 2)}\n\nArchetype policy:\n${JSON.stringify(archetypeBlock, null, 2)}\n\nDeterministic panel tool output:\n${JSON.stringify(panelToolSummary, null, 2)}\n\nMinimal source preview summary:\n${JSON.stringify(compactContext, null, 2)}\n\n${requireToolCall ? "Return mode=call_tools with 1 to 2 tool calls from the registry. Choose the tools most likely to sharpen archetype selection." : "If you already have enough evidence, return mode=select with no tool calls. If you need more evidence, return mode=call_tools with up to 2 tool calls from the registry."}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "archetype_tool_request",
          schema: archetypeToolRequestSchema,
          strict: true
        }
      }
    });
    const initialBillingEntry = await this.billingTracker?.recordResponseUsage({
      response: initialResponse,
      model: appConfig.agent?.model ?? "gpt-5.4",
      operation: "archetype_selection",
      provider: "openai-responses",
      domainId: domain.id,
      panelId: panel.id,
      panelTitle: panel.title
    });
    if (initialBillingEntry) {
      billingEntries.push(initialBillingEntry);
    }

    const decision = initialResponse.output_text
      ? JSON.parse(initialResponse.output_text)
      : extractJson(JSON.stringify(initialResponse.output));
    this.logger.info("Archetype tool decision received", {
      domainId: domain.id,
      panelId: panel.id,
      mode: decision.mode,
      toolCallCount: decision.toolCalls?.length ?? 0,
      required: requireToolCall
    }, "planner");

    if (requireToolCall && (decision.mode !== "call_tools" || !(decision.toolCalls ?? []).length)) {
      const repairResponse = await this.openai.responses.create({
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
                  "You must request derived tools before selecting the archetype. Return strict JSON only."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The previous response did not request tools, but this archetype-selection mode requires tool invocation. Return mode=call_tools with 1 to 2 tool calls from this registry.\n\nPanel-specific exposed tool registry:\n${JSON.stringify(compactToolRegistry(panelToolRegistry), null, 2)}\n\nPanel summary:\n${JSON.stringify(compactPanel(panel), null, 2)}\n\nArchetype policy:\n${JSON.stringify(archetypeBlock, null, 2)}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "archetype_tool_request_repair",
            schema: archetypeToolRequestSchema,
            strict: true
          }
        }
      });
      const repairBillingEntry = await this.billingTracker?.recordResponseUsage({
        response: repairResponse,
        model: appConfig.agent?.model ?? "gpt-5.4",
        operation: "archetype_selection",
        provider: "openai-responses",
        domainId: domain.id,
        panelId: panel.id,
        panelTitle: panel.title
      });
      if (repairBillingEntry) {
        billingEntries.push(repairBillingEntry);
      }
      const repairedDecision = repairResponse.output_text
        ? JSON.parse(repairResponse.output_text)
        : extractJson(JSON.stringify(repairResponse.output));
      if (repairedDecision.mode === "call_tools" && (repairedDecision.toolCalls ?? []).length) {
        decision.mode = repairedDecision.mode;
        decision.rationale = repairedDecision.rationale;
        decision.toolCalls = repairedDecision.toolCalls;
        this.logger.info("Archetype tool decision repaired", {
          domainId: domain.id,
          panelId: panel.id,
          toolCallCount: decision.toolCalls?.length ?? 0
        }, "planner");
      }
    }

    let requestedToolCalls = [...(decision.toolCalls ?? [])];
    if (requestedToolCalls.some((toolCall) => toolCall?.toolId && !availableToolIds.has(toolCall.toolId))) {
      const invalidToolIds = requestedToolCalls
        .map((toolCall) => toolCall?.toolId)
        .filter((toolId) => toolId && !availableToolIds.has(toolId));
      this.logger.info("Archetype selection requested invalid tool ids", {
        domainId: domain.id,
        panelId: panel.id,
        invalidToolIds
      }, "planner");
      const repairInvalidResponse = await this.openai.responses.create({
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
                  "You must request only tool ids that appear in the provided registry. Return strict JSON only."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The previous tool request included invalid tool ids: ${invalidToolIds.join(", ")}.\n\nReturn mode=call_tools with 1 to 2 tool calls using only these valid tools:\n${JSON.stringify(compactToolRegistry(panelToolRegistry), null, 2)}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "archetype_tool_request_registry_repair",
            schema: archetypeToolRequestSchema,
            strict: true
          }
        }
      });
      const repairInvalidBillingEntry = await this.billingTracker?.recordResponseUsage({
        response: repairInvalidResponse,
        model: appConfig.agent?.model ?? "gpt-5.4",
        operation: "archetype_selection",
        provider: "openai-responses",
        domainId: domain.id,
        panelId: panel.id,
        panelTitle: panel.title
      });
      if (repairInvalidBillingEntry) {
        billingEntries.push(repairInvalidBillingEntry);
      }
      const repairedInvalidDecision = repairInvalidResponse.output_text
        ? JSON.parse(repairInvalidResponse.output_text)
        : extractJson(JSON.stringify(repairInvalidResponse.output));
      if (repairedInvalidDecision.mode === "call_tools" && (repairedInvalidDecision.toolCalls ?? []).length) {
        requestedToolCalls = repairedInvalidDecision.toolCalls;
        this.logger.info("Archetype invalid tool request repaired", {
          domainId: domain.id,
          panelId: panel.id,
          toolCallCount: requestedToolCalls.length
        }, "planner");
      }
    }

    if (decision.mode !== "call_tools" || !requestedToolCalls.length) {
      return {
        toolMode: "model-no-tools",
        toolTrace,
        toolDecision: decision,
        selection: null,
        billingEntries
      };
    }

    const uniqueToolCalls = [];
    const seen = new Set();
    for (const toolCall of requestedToolCalls.slice(0, 2)) {
      if (!toolCall?.toolId || seen.has(toolCall.toolId) || !availableToolIds.has(toolCall.toolId)) {
        continue;
      }
      seen.add(toolCall.toolId);
      uniqueToolCalls.push(toolCall);
    }

    if (!uniqueToolCalls.length) {
      return {
        toolMode: "model-no-tools",
        toolTrace,
        toolDecision: {
          ...decision,
          mode: "select",
          rationale: `${decision.rationale} No valid derived tool ids were returned after validation.`
        },
        selection: null,
        billingEntries
      };
    }

    const toolExecutions = uniqueToolCalls.map((toolCall) => {
      const execution = executeDerivedTool(panelToolRegistry, compactContext, toolCall.toolId);
      const traceEntry = {
        toolId: execution.tool.id,
        title: execution.tool.title,
        scopeType: execution.tool.scopeType,
        scopeTitle: execution.tool.scopeTitle,
        operation: execution.tool.operation,
        purpose: toolCall.purpose,
        result: compactToolResultForModel(execution),
        recordedAt: new Date().toISOString()
      };
      toolTrace.push(traceEntry);
      return compactToolResultForModel(execution);
    });
    this.logger.info("Archetype tools executed", {
      domainId: domain.id,
      panelId: panel.id,
      toolIds: toolTrace.map((entry) => entry.toolId),
      toolCount: toolTrace.length
    }, "planner");

    const finalResponse = await this.openai.responses.create({
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
              text: `Select the best archetype using the derived tool outputs below as the primary evidence source.\n\nPanel summary:\n${JSON.stringify(compactPanel(panel), null, 2)}\n\nArchetype policy:\n${JSON.stringify(archetypeBlock, null, 2)}\n\nDeterministic panel tool output:\n${JSON.stringify(panelToolSummary, null, 2)}\n\nDerived tool outputs:\n${JSON.stringify(toolExecutions, null, 2)}`
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
    const finalBillingEntry = await this.billingTracker?.recordResponseUsage({
      response: finalResponse,
      model: appConfig.agent?.model ?? "gpt-5.4",
      operation: "archetype_selection",
      provider: "openai-responses",
      domainId: domain.id,
      panelId: panel.id,
      panelTitle: panel.title
    });
    if (finalBillingEntry) {
      billingEntries.push(finalBillingEntry);
    }
    const parsed = finalResponse.output_text
      ? JSON.parse(finalResponse.output_text)
      : extractJson(JSON.stringify(finalResponse.output));
    this.logger.info("Archetype final selection received", {
      domainId: domain.id,
      panelId: panel.id,
      selectedArchetype: parsed.selectedArchetype,
      toolCount: toolTrace.length
    }, "planner");

    return {
      toolMode: "model-directed",
      toolTrace,
      toolDecision: decision,
      selection: parsed,
      billingEntries
    };
  }

  async runAnalysisToolLoop({
    runId,
    appConfig,
    domain,
    panel,
    workspacePlan,
    analysisContract,
    analysisDomain,
    analysisPanel,
    analysisWorkspacePlan,
    analysisDomainTools,
    analysisPanelTools,
    analysisContext,
    analysisToolRegistry,
    selectedArchetype
  }) {
    const toolTrace = [];
    const billingEntries = [];
    const availableToolIds = new Set(compactToolRegistryIds(analysisToolRegistry));
    const requireToolCall = Boolean(
      appConfig.agent?.localTools?.enabled &&
        appConfig.agent?.localTools?.primaryForAnalysis &&
        Array.isArray(analysisToolRegistry?.tools) &&
        analysisToolRegistry.tools.length
    );
    const toolRequirementText = requireToolCall
      ? "You must request 1 to 3 derived tool calls from the provided registry before final analysis. Do not return mode=analyze on this step."
      : "If the existing evidence is sufficient, you may return mode=analyze with no tool calls.";
    const initialResponse = await this.openai.responses.create({
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
              text: `You are preparing an analytical report. ${toolRequirementText} Return strict JSON only.`
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Decide which derived tools, if any, should be invoked before final analysis.\n\nPanel-specific exposed tool registry:\n${JSON.stringify(compactToolRegistry(analysisToolRegistry), null, 2)}\n\nDomain summary:\n${JSON.stringify(analysisDomain, null, 2)}\n\nWorkspace plan summary:\n${JSON.stringify(analysisWorkspacePlan, null, 2)}\n\nPanel summary:\n${JSON.stringify(analysisPanel, null, 2)}\n\nSelected archetype:\n${JSON.stringify(selectedArchetype, null, 2)}\n\nArchetype analysis contract:\n${JSON.stringify(analysisContract, null, 2)}\n\nDeterministic domain tool output:\n${JSON.stringify(analysisDomainTools, null, 2)}\n\nDeterministic panel tool output:\n${JSON.stringify(analysisPanelTools, null, 2)}\n\nMinimal source preview summary:\n${JSON.stringify(analysisContext, null, 2)}\n\nTask:\n${this.buildAnalysisTask(panel, workspacePlan)}\n\n${requireToolCall ? "Return mode=call_tools with 1 to 3 tool calls from the registry. Choose the tools most likely to sharpen the analysis report." : "If you already have enough evidence, return mode=analyze with no tool calls. If you need more evidence, return mode=call_tools with up to 3 tool calls from the registry."}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "analysis_tool_request",
          schema: analysisToolRequestSchema,
          strict: true
        }
      }
    });
    const initialBillingEntry = await this.billingTracker?.recordResponseUsage({
      response: initialResponse,
      model: appConfig.agent?.model ?? "gpt-5.4",
      operation: "panel_analysis",
      provider: "openai-responses",
      domainId: domain.id,
      panelId: panel.id,
      panelTitle: panel.title,
      archetypeId: selectedArchetype.id,
      archetypeTitle: selectedArchetype.title,
      runId
    });
    if (initialBillingEntry) {
      billingEntries.push(initialBillingEntry);
    }

    const decision = initialResponse.output_text
      ? JSON.parse(initialResponse.output_text)
      : extractJson(JSON.stringify(initialResponse.output));
    this.logger.info("Analysis tool decision received", {
      runId,
      panelId: panel.id,
      mode: decision.mode,
      toolCallCount: decision.toolCalls?.length ?? 0,
      required: requireToolCall
    }, "analysis");

    if (requireToolCall && (decision.mode !== "call_tools" || !(decision.toolCalls ?? []).length)) {
      const repairResponse = await this.openai.responses.create({
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
                  "You must request derived tools before final analysis. Return strict JSON only."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The previous response did not request tools, but this analysis mode requires tool invocation. Return mode=call_tools with 1 to 3 tool calls from this registry.\n\nPanel-specific exposed tool registry:\n${JSON.stringify(compactToolRegistry(analysisToolRegistry), null, 2)}\n\nPanel summary:\n${JSON.stringify(analysisPanel, null, 2)}\n\nSelected archetype:\n${JSON.stringify(selectedArchetype, null, 2)}\n\nTask:\n${this.buildAnalysisTask(panel, workspacePlan)}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "analysis_tool_request_repair",
            schema: analysisToolRequestSchema,
            strict: true
          }
        }
      });
      const repairBillingEntry = await this.billingTracker?.recordResponseUsage({
        response: repairResponse,
        model: appConfig.agent?.model ?? "gpt-5.4",
        operation: "panel_analysis",
        provider: "openai-responses",
        domainId: domain.id,
        panelId: panel.id,
        panelTitle: panel.title,
        archetypeId: selectedArchetype.id,
        archetypeTitle: selectedArchetype.title,
        runId
      });
      if (repairBillingEntry) {
        billingEntries.push(repairBillingEntry);
      }
      const repairedDecision = repairResponse.output_text
        ? JSON.parse(repairResponse.output_text)
        : extractJson(JSON.stringify(repairResponse.output));
      if (repairedDecision.mode === "call_tools" && (repairedDecision.toolCalls ?? []).length) {
        decision.mode = repairedDecision.mode;
        decision.rationale = repairedDecision.rationale;
        decision.toolCalls = repairedDecision.toolCalls;
        this.logger.info("Analysis tool decision repaired", {
          runId,
          panelId: panel.id,
          toolCallCount: decision.toolCalls?.length ?? 0
        }, "analysis");
      }
    }

    let requestedToolCalls = [...(decision.toolCalls ?? [])];
    if (requestedToolCalls.some((toolCall) => toolCall?.toolId && !availableToolIds.has(toolCall.toolId))) {
      const invalidToolIds = requestedToolCalls
        .map((toolCall) => toolCall?.toolId)
        .filter((toolId) => toolId && !availableToolIds.has(toolId));
      this.logger.info("Analysis requested invalid tool ids", {
        runId,
        panelId: panel.id,
        invalidToolIds
      }, "analysis");
      const repairInvalidResponse = await this.openai.responses.create({
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
                  "You must request only tool ids that appear in the provided registry. Return strict JSON only."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The previous tool request included invalid tool ids: ${invalidToolIds.join(", ")}.\n\nReturn mode=call_tools with 1 to 3 tool calls using only these valid tools:\n${JSON.stringify(compactToolRegistry(analysisToolRegistry), null, 2)}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "analysis_tool_request_registry_repair",
            schema: analysisToolRequestSchema,
            strict: true
          }
        }
      });
      const repairInvalidBillingEntry = await this.billingTracker?.recordResponseUsage({
        response: repairInvalidResponse,
        model: appConfig.agent?.model ?? "gpt-5.4",
        operation: "panel_analysis",
        provider: "openai-responses",
        domainId: domain.id,
        panelId: panel.id,
        panelTitle: panel.title,
        archetypeId: selectedArchetype.id,
        archetypeTitle: selectedArchetype.title,
        runId
      });
      if (repairInvalidBillingEntry) {
        billingEntries.push(repairInvalidBillingEntry);
      }
      const repairedInvalidDecision = repairInvalidResponse.output_text
        ? JSON.parse(repairInvalidResponse.output_text)
        : extractJson(JSON.stringify(repairInvalidResponse.output));
      if (repairedInvalidDecision.mode === "call_tools" && (repairedInvalidDecision.toolCalls ?? []).length) {
        requestedToolCalls = repairedInvalidDecision.toolCalls;
        this.logger.info("Analysis invalid tool request repaired", {
          runId,
          panelId: panel.id,
          toolCallCount: requestedToolCalls.length
        }, "analysis");
      }
    }

    if (decision.mode !== "call_tools" || !requestedToolCalls.length) {
      return {
        toolMode: "model-no-tools",
        toolTrace,
        toolDecision: decision,
        billingEntries,
        derivedToolOutputs: []
      };
    }

    const uniqueToolCalls = [];
    const seen = new Set();
    for (const toolCall of requestedToolCalls.slice(0, 3)) {
      if (!toolCall?.toolId || seen.has(toolCall.toolId) || !availableToolIds.has(toolCall.toolId)) {
        continue;
      }
      seen.add(toolCall.toolId);
      uniqueToolCalls.push(toolCall);
    }

    if (!uniqueToolCalls.length) {
      return {
        toolMode: "model-no-tools",
        toolTrace,
        toolDecision: {
          ...decision,
          mode: "analyze",
          rationale: `${decision.rationale} No valid derived tool ids were returned after validation.`
        },
        billingEntries,
        derivedToolOutputs: []
      };
    }

    const derivedToolOutputs = uniqueToolCalls.map((toolCall) => {
      const execution = executeDerivedTool(analysisToolRegistry, analysisContext, toolCall.toolId);
      const traceEntry = {
        toolId: execution.tool.id,
        title: execution.tool.title,
        scopeType: execution.tool.scopeType,
        scopeTitle: execution.tool.scopeTitle,
        operation: execution.tool.operation,
        purpose: toolCall.purpose,
        result: compactToolResultForModel(execution),
        recordedAt: new Date().toISOString()
      };
      toolTrace.push(traceEntry);
      return compactToolResultForModel(execution);
    });
    this.logger.info("Analysis tools executed", {
      runId,
      panelId: panel.id,
      toolIds: toolTrace.map((entry) => entry.toolId),
      toolCount: toolTrace.length
    }, "analysis");

    return {
      toolMode: "model-directed",
      toolTrace,
      toolDecision: decision,
      billingEntries,
      derivedToolOutputs
    };
  }

  async selectArchetype({ appConfig, domain, panel, context }) {
    const archetypeBlock = buildArchetypePromptBlock(appConfig, domain, panel);
    const fallback = selectHeuristicArchetype({ appConfig, domain, panel, context });
    const compactContext = compactContextForPanel(panel, context);
    const panelToolSummary = buildDeterministicPanelSummary(panel, context);
    const panelToolRegistry = buildPanelToolRegistry(domain, panel);

    if (!this.openai) {
      return {
        ...fallback,
        toolMode: "recipe-fallback",
        toolTrace: [],
        toolDecision: null,
        billingEntries: []
      };
    }

    try {
      const selectionLoop = await this.runArchetypeToolLoop({
        appConfig,
        domain,
        panel,
        archetypeBlock,
        compactContext,
        panelToolSummary,
        panelToolRegistry
      });
      const parsed = selectionLoop.selection ?? fallback;
      const allowedArchetypes = archetypeBlock.allowed;

      if (!allowedArchetypes.includes(parsed.selectedArchetype)) {
        this.logger.warn("OpenAI selected disallowed archetype; using fallback", {
          panelId: panel.id,
          selectedArchetype: parsed.selectedArchetype,
          allowedArchetypes
        }, "planner");
        return {
          ...fallback,
          toolMode: selectionLoop.toolMode,
          toolTrace: selectionLoop.toolTrace,
          toolDecision: selectionLoop.toolDecision,
          billingEntries: selectionLoop.billingEntries ?? []
        };
      }

      return {
        ...parsed,
        toolMode: selectionLoop.toolMode,
        toolTrace: selectionLoop.toolTrace,
        toolDecision: selectionLoop.toolDecision,
        billingEntries: selectionLoop.billingEntries ?? []
      };
    } catch (error) {
      this.logger.warn("Archetype selection fell back to heuristic", {
        panelId: panel.id,
        error: error.message
      }, "planner");
      return {
        ...fallback,
        toolMode: "recipe-fallback",
        toolTrace: [],
        toolDecision: null,
        billingEntries: []
      };
    }
  }

  async persistRunUpdate(run, patch = {}) {
    const nextRun = {
      ...run,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    await this.configStore.saveRun(nextRun);
    this.eventBus.emit("run.update", nextRun);
    return nextRun;
  }

  async executeRunPipeline({
    runId,
    appConfig,
    domain,
    panel,
    dataSources,
    sessions,
    contextOverride = null,
    workspacePlanOverride = null,
    trigger = "manual"
  }) {
    let run = await this.configStore.getRun(runId);
    if (!run) {
      return;
    }

    try {
      run = await this.persistRunUpdate(run, {
        progressPhase: "context",
        progressLabel: "Preparing Context",
        progressMessage: "Collecting source previews and deterministic local findings."
      });

      const context = contextOverride ?? (await gatherDomainContext(domain, dataSources, { logger: this.logger }));
      const analysisPanelTools = buildDeterministicPanelSummary(panel, context);
      run = await this.persistRunUpdate(run, {
        context,
        localFindings: analysisPanelTools
      });

      run = await this.persistRunUpdate(run, {
        progressPhase: "planning",
        progressLabel: "Planning Workspace",
        progressMessage: "Reconsidering panel focus and workspace layout from the latest evidence."
      });
      const workspacePlan = workspacePlanOverride
        ? workspacePlanOverride
        : await this.planWorkspace({ domainId: domain.id, preferredPanelId: panel.id, reason: "run-request", contextOverride: context }).catch(() =>
            this.configStore.getWorkspacePlan(domain.id)
          );

      run = await this.persistRunUpdate(run, {
        progressPhase: "archetype",
        progressLabel: "Selecting Archetype",
        progressMessage: "Comparing allowed presentation archetypes against current evidence."
      });
      const archetypeSelection = await this.selectArchetype({ appConfig, domain, panel, context });
      const selectedArchetypeDefinition = getArchetypeDefinition(appConfig, archetypeSelection.selectedArchetype);
      const analysisContract = buildArchetypeAnalysisContract(appConfig, archetypeSelection.selectedArchetype);
      const archetypeEntryIds = (archetypeSelection.billingEntries ?? []).map((entry) => entry.id).filter(Boolean);
      if (archetypeEntryIds.length) {
        await this.billingTracker?.attachEntriesToRun(archetypeEntryIds, run.id);
      }
      run = await this.persistRunUpdate(run, {
        selectedArchetype: archetypeSelection.selectedArchetype,
        archetypeReason: archetypeSelection.reason,
        archetypeConfidence: archetypeSelection.confidence,
        archetypeToolMode: archetypeSelection.toolMode ?? null,
        archetypeToolTrace: archetypeSelection.toolTrace ?? [],
        archetypeToolDecision: archetypeSelection.toolDecision ?? null,
        archetypeTitle: selectedArchetypeDefinition?.title ?? archetypeSelection.selectedArchetype,
        billing: archetypeEntryIds.length
          ? {
              ...(run.billing ?? {}),
              archetypeEntryIds
            }
          : run.billing,
        archetypeCost: archetypeEntryIds.length
          ? {
              totalUsd: (archetypeSelection.billingEntries ?? []).reduce(
                (sum, entry) => sum + Number(entry.cost?.totalUsd ?? 0),
                0
              )
            }
          : run.archetypeCost ?? null
      });

      if (!this.openai) {
        const report = buildFallbackReport(panel, context);
        report.findings = analysisPanelTools.findings ?? [];
        report.localFindings = analysisPanelTools;
        report.details = mergeArchetypeDetails(
          analysisContract,
          report.details,
          buildArchetypeDetails({ appConfig, panel, run, report, context })
        );
        run = await this.persistRunUpdate(run, {
          status: "completed",
          report,
          progressPhase: "widget_pending",
          progressLabel: "Widget Pending",
          progressMessage: "Analysis is complete. Generating the browser widget artifact next.",
          widgetStatus: "pending"
        });
        void this.generateWidgetForRun(run.id, domain, panel);
        return;
      }

      const analysisContext = compactContextForPanel(panel, context);
      const analysisDomain = compactDomain(domain);
      const analysisPanel = compactPanel(panel);
      const analysisWorkspacePlan = compactWorkspacePlan(workspacePlan, panel.id);
      const analysisDomainTools = buildDeterministicDomainSummary(domain, context);
      const analysisToolRegistry = buildPanelToolRegistry(domain, panel);

      this.logger.info("Starting panel analysis", {
        domainId: domain.id,
        panelId: panel.id,
        panelTitle: panel.title,
        trigger,
        provider: this.openai ? "openai" : "fallback",
        previewCount: context.previewCount,
        focusPanelId: workspacePlan?.focusPanelId ?? null,
        selectedArchetype: archetypeSelection.selectedArchetype
      }, "analysis");

      run = await this.persistRunUpdate(run, {
        progressPhase: "analysis_tools",
        progressLabel: "Selecting Analysis Tools",
        progressMessage: "Letting the model choose which derived local tools to invoke for this report."
      });

      const analysisLoop = await this.runAnalysisToolLoop({
        runId: run.id,
        appConfig,
        domain,
        panel,
        workspacePlan,
        analysisContract,
        analysisDomain,
        analysisPanel,
        analysisWorkspacePlan,
        analysisDomainTools,
        analysisPanelTools,
        analysisContext,
        analysisToolRegistry,
        selectedArchetype: {
          id: run.selectedArchetype,
          title: run.archetypeTitle,
          reason: run.archetypeReason,
          confidence: run.archetypeConfidence
        }
      });
      const analysisEntryIds = (analysisLoop.billingEntries ?? []).map((entry) => entry.id).filter(Boolean);
      const analysisLoopCost = (analysisLoop.billingEntries ?? []).reduce(
        (sum, entry) => sum + Number(entry.cost?.totalUsd ?? 0),
        0
      );
      run = await this.persistRunUpdate(run, {
        analysisToolMode: analysisLoop.toolMode ?? null,
        analysisToolTrace: analysisLoop.toolTrace ?? [],
        analysisToolDecision: analysisLoop.toolDecision ?? null,
        billing: analysisEntryIds.length
          ? {
              ...(run.billing ?? {}),
              analysisEntryIds
            }
          : run.billing,
        analysisCost: analysisEntryIds.length
          ? {
              totalUsd: analysisLoopCost
            }
          : run.analysisCost ?? null,
        progressPhase: "analysis_request",
        progressLabel: "Submitting Analysis",
        progressMessage:
          analysisLoop.toolTrace?.length
            ? "Derived local tool outputs are ready. Sending the analytical synthesis task to the model."
            : "Sending the prepared task to the model."
      });

      const previousResponseId = appConfig.agent?.reuseResponseHistory ? sessions[domain.id]?.previousResponseId : undefined;
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
                text: `Stable local analysis primitives:\n${JSON.stringify(listDeterministicTools(), null, 2)}\n\nPanel-specific exposed tool registry:\n${JSON.stringify(compactToolRegistry(analysisToolRegistry), null, 2)}\n\nDomain summary:\n${JSON.stringify(analysisDomain, null, 2)}\n\nWorkspace plan summary:\n${JSON.stringify(analysisWorkspacePlan, null, 2)}\n\nPanel summary:\n${JSON.stringify(analysisPanel, null, 2)}\n\nSelected archetype:\n${JSON.stringify({
                  id: run.selectedArchetype,
                  title: run.archetypeTitle,
                  reason: run.archetypeReason,
                  confidence: run.archetypeConfidence,
                  allowedArchetypes: getPanelAllowedArchetypes(appConfig, domain, panel)
                }, null, 2)}\n\nArchetype analysis contract:\n${JSON.stringify(analysisContract, null, 2)}\n\nDeterministic domain tool output:\n${JSON.stringify(analysisDomainTools, null, 2)}\n\nDeterministic panel tool output:\n${JSON.stringify(analysisPanelTools, null, 2)}\n\nMinimal source preview summary:\n${JSON.stringify(analysisContext, null, 2)}\n\nDerived tool decision:\n${JSON.stringify({
                  mode: analysisLoop.toolMode,
                  decision: analysisLoop.toolDecision ?? null
                }, null, 2)}\n\nDerived tool outputs:\n${JSON.stringify(analysisLoop.derivedToolOutputs ?? [], null, 2)}\n\nReturn details as an array of section objects. Each section should include sectionId, title, and items. Use the section ids and titles from the archetype analysis contract.`
              }
            ]
          }
        ]
      });

      run = await this.persistRunUpdate(run, {
        remoteResponseId: response.id,
        status: response.status === "completed" ? "completed" : "in_progress",
        progressPhase: response.status === "completed" ? "finalizing_report" : "analysis_running",
        progressLabel: response.status === "completed" ? "Finalizing Report" : "Analysis Running",
        progressMessage:
          response.status === "completed"
            ? "Model output received. Normalizing report structure and preparing widget generation."
            : "Model analysis is running on the server."
      });
      this.logger.info("OpenAI analysis response received", {
        runId: run.id,
        domainId: domain.id,
        panelId: panel.id,
        remoteResponseId: response.id,
        status: run.status
      }, "analysis");

      if (appConfig.agent?.reuseResponseHistory) {
        sessions[domain.id] = {
          previousResponseId: response.id,
          updatedAt: new Date().toISOString()
        };
        await this.configStore.saveSessions(sessions);
      }

      if (run.status === "completed") {
        await this.completeRun(run.id, domain, panel, response);
        return;
      }

      void this.monitorRun(run.id, domain, panel);
    } catch (error) {
      const current = (await this.configStore.getRun(runId)) ?? run;
      if (!current) {
        return;
      }
      await this.persistRunUpdate(current, {
        status: "failed",
        progressPhase: "failed",
        progressLabel: "Failed",
        progressMessage: error.message,
        error: error.message
      });
      this.logger.warn("Analysis pipeline failed", {
        runId,
        panelId: panel.id,
        error: error.message
      }, "analysis");
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
    const [appConfig, domain, dataSources, sessions] = await Promise.all([
      this.configStore.getAppConfig(),
      this.configStore.getDomain(domainId),
      this.configStore.getDataSources(),
      this.configStore.getSessions()
    ]);

    if (!domain) {
      throw new Error(`Unknown domain: ${domainId}`);
    }

    const panel = domain.panels.find((entry) => entry.id === panelId);

    if (!panel) {
      throw new Error(`Unknown panel: ${panelId}`);
    }

    const run = {
      id: crypto.randomUUID(),
      domainId,
      panelId,
      panelTitle: panel.title,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      context: null,
      localFindings: null,
      report: null,
      provider: this.openai ? "openai-responses" : "local-fallback",
      trigger,
      progressPhase: "context",
      progressLabel: "Preparing Context",
      progressMessage: "Collecting source previews and deterministic local findings.",
      widgetStatus: "pending",
      billing: {},
      selectedArchetype: null,
      archetypeReason: null,
      archetypeConfidence: null,
      archetypeToolMode: null,
      archetypeToolTrace: [],
      archetypeToolDecision: null,
      analysisToolMode: null,
      analysisToolTrace: [],
      analysisToolDecision: null,
      widgetToolMode: null,
      widgetToolTrace: [],
      widgetToolDecision: null,
      archetypeTitle: null,
      remoteResponseId: null,
      widgetId: null,
      widgetUrl: null
    };

    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);
    this.logger.debug("Saved initial run state", {
      runId: run.id,
      status: run.status,
      provider: run.provider
    }, "analysis");
    void this.executeRunPipeline({
      runId: run.id,
      appConfig,
      domain,
      panel,
      dataSources,
      sessions,
      contextOverride,
      workspacePlanOverride,
      trigger
    });
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
    run.progressPhase = "finalizing_report";
    run.progressLabel = "Finalizing Report";
    run.progressMessage = "Normalizing model output and preparing widget generation.";
    run.updatedAt = new Date().toISOString();
    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);

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
    const deterministicPanelTools = run.localFindings ?? buildDeterministicPanelSummary(panel, run.context);
    const preliminaryReport = normalizeReport(parsed, panel);
    run.report = normalizeReport(
      parsed,
      panel,
      analysisContract,
      buildArchetypeDetails({ appConfig: currentAppConfig, panel, run, report: preliminaryReport, context: run.context })
    );
    run.localFindings = deterministicPanelTools;
    run.report.findings = deterministicPanelTools.findings ?? [];
    run.report.localFindings = deterministicPanelTools;
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
        const analysisEntryIds = [
          ...((run.billing?.analysisEntryIds ?? []).filter(Boolean)),
          entry.id
        ];
        const priorAnalysisUsd = Number(run.analysisCost?.totalUsd ?? 0);
        run.billing = {
          ...(run.billing ?? {}),
          analysisEntryIds,
          analysisEntryId: entry.id
        };
        run.analysisUsage = entry.usage;
        run.analysisCost = {
          totalUsd: Number((priorAnalysisUsd + Number(entry.cost?.totalUsd ?? 0)).toFixed(6))
        };
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
    run.progressPhase = "widget_pending";
    run.progressLabel = "Widget Pending";
    run.progressMessage = "Analysis is complete. Preparing the browser widget artifact.";
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

    const attemptId = crypto.randomUUID();
    try {
      this.activeWidgetGenerations.set(run.id, attemptId);
      run.widgetStatus = "in_progress";
      run.widgetError = null;
      run.progressPhase = "widget_generating";
      run.progressLabel = "Widget Generating";
      run.progressMessage = "Rendering the browser widget artifact for this run.";
      run.widgetAttemptId = attemptId;
      run.widgetAttemptStartedAt = new Date().toISOString();
      run.widgetRetryCount = Number(run.widgetRetryCount ?? 0);
      run.updatedAt = new Date().toISOString();
      await this.configStore.saveRun(run);
      this.eventBus.emit("run.update", run);
      this.logger.debug("Generating widget for run", {
        runId: run.id,
        domainId: domain.id,
        panelId: panel.id
      }, "widgets");
      const {
        widget,
        billingEntries = [],
        toolMode = null,
        toolTrace = [],
        toolDecision = null
      } = await this.widgetService.generateForRun({ domain, panel, run });
      run.widgetId = widget.id;
      run.widgetUrl = `/generated/widgets/${widget.id}`;
      run.widgetGeneratedAt = widget.generatedAt ?? new Date().toISOString();
      run.widgetStatus = "completed";
      run.widgetError = null;
      run.widgetToolMode = toolMode;
      run.widgetToolTrace = toolTrace;
      run.widgetToolDecision = toolDecision;
      run.progressPhase = "complete";
      run.progressLabel = "Complete";
      run.progressMessage = "Analysis and widget generation are both complete.";
      if (billingEntries.length) {
        const widgetEntryIds = billingEntries.map((entry) => entry.id).filter(Boolean);
        const widgetTotalUsd = billingEntries.reduce((sum, entry) => sum + Number(entry.cost?.totalUsd ?? 0), 0);
        const finalWidgetEntry = billingEntries[billingEntries.length - 1];
        run.billing = {
          ...(run.billing ?? {}),
          widgetEntryIds,
          widgetEntryId: finalWidgetEntry?.id ?? null
        };
        run.widgetUsage = finalWidgetEntry?.usage ?? null;
        run.widgetCost = {
          totalUsd: Number(widgetTotalUsd.toFixed(6))
        };
      }
      this.logger.info("Widget attached to run", {
        runId: run.id,
        widgetId: widget.id,
        panelId: panel.id
      }, "widgets");
    } catch (error) {
      if (this.activeWidgetGenerations.get(run.id) === attemptId) {
        run.widgetStatus = "failed";
        run.widgetError = error.message;
        run.progressPhase = "widget_failed";
        run.progressLabel = "Widget Failed";
        run.progressMessage = error.message;
      }
      this.logger.warn("Widget generation failed", {
        runId: run.id,
        panelId: panel.id,
        error: error.message
      }, "widgets");
    } finally {
      if (this.activeWidgetGenerations.get(run.id) === attemptId) {
        this.activeWidgetGenerations.delete(run.id);
      }
    }
  }

  async generateWidgetForRun(runId, domain, panel) {
    const run = await this.configStore.getRun(runId);

    if (!run?.report || run.widgetId || this.activeWidgetGenerations.has(runId)) {
      return;
    }

    await this.attachWidget(run, domain, panel);
    run.updatedAt = new Date().toISOString();
    await this.configStore.saveRun(run);
    this.eventBus.emit("run.update", run);
  }

  async reconcileRecentRuns(runs = []) {
    const appConfig = await this.configStore.getAppConfig();
    const pendingRuns = runs.filter((run) => isInProgress(run) && run.remoteResponseId);
    this.logger.debug("Reconciling recent runs", {
      pendingRunIds: pendingRuns.map((run) => run.id)
    }, "analysis");

    await Promise.allSettled(
      pendingRuns.map(async (run) => {
        await this.syncRun(run.id);
      })
    );

    const widgetTimeoutMs = appConfig.refresh?.widgetGenerationTimeoutMs ?? 300000;
    const widgetMaxRetries = appConfig.refresh?.widgetGenerationMaxRetries ?? 2;
    const now = Date.now();
    const widgetCandidates = runs.filter(
      (run) =>
        run?.status === "completed" &&
        !run.widgetId &&
        (run.widgetStatus === "pending" || run.widgetStatus === "in_progress")
    );

    await Promise.allSettled(
      widgetCandidates.map(async (run) => {
        const ageMs = Math.max(0, now - new Date(run.updatedAt ?? run.createdAt ?? now).getTime());
        const domain = await this.configStore.getDomain(run.domainId);
        const panel = domain?.panels.find((entry) => entry.id === run.panelId);

        if (!domain || !panel) {
          return;
        }

        if (run.widgetStatus === "pending") {
          this.logger.info("Re-queueing pending widget generation", {
            runId: run.id,
            panelId: run.panelId,
            ageMs
          }, "widgets");
          await this.generateWidgetForRun(run.id, domain, panel);
          return;
        }

        if (run.widgetStatus === "in_progress" && this.activeWidgetGenerations.has(run.id)) {
          return;
        }

        if (run.widgetStatus === "in_progress" && ageMs > widgetTimeoutMs) {
          const freshRun = (await this.configStore.getRun(run.id)) ?? run;
          if (freshRun.widgetId || freshRun.widgetStatus === "completed") {
            return;
          }
          const retryCount = Number(freshRun.widgetRetryCount ?? 0);
          if (retryCount < widgetMaxRetries) {
            freshRun.widgetStatus = "pending";
            freshRun.widgetError = `Widget generation exceeded ${Math.round(widgetTimeoutMs / 1000)}s; retrying attempt ${retryCount + 1} of ${widgetMaxRetries}.`;
            freshRun.progressPhase = "widget_retrying";
            freshRun.progressLabel = "Retrying Widget";
            freshRun.progressMessage = freshRun.widgetError;
            freshRun.widgetRetryCount = retryCount + 1;
            freshRun.updatedAt = new Date().toISOString();
            await this.configStore.saveRun(freshRun);
            this.eventBus.emit("run.update", freshRun);
            this.logger.warn("Retrying stale widget generation", {
              runId: freshRun.id,
              panelId: freshRun.panelId,
              ageMs,
              widgetTimeoutMs,
              retryCount: freshRun.widgetRetryCount,
              widgetMaxRetries
            }, "widgets");
            await this.generateWidgetForRun(freshRun.id, domain, panel);
            return;
          }
          freshRun.widgetStatus = "failed";
          freshRun.widgetError = `Widget generation timed out after ${Math.round(widgetTimeoutMs / 1000)}s and exhausted ${widgetMaxRetries} retries.`;
          freshRun.progressPhase = "widget_failed";
          freshRun.progressLabel = "Widget Failed";
          freshRun.progressMessage = freshRun.widgetError;
          freshRun.updatedAt = new Date().toISOString();
          await this.configStore.saveRun(freshRun);
          this.eventBus.emit("run.update", freshRun);
          this.logger.warn("Marked stale widget generation as failed", {
            runId: freshRun.id,
            panelId: freshRun.panelId,
            ageMs,
            widgetTimeoutMs,
            widgetMaxRetries
          }, "widgets");
        }
      })
    );
  }
}
