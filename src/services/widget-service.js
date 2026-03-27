import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { paths } from "./config-store.js";
import {
  buildDeterministicPanelSummary,
  buildPanelInteractionState,
  buildPanelToolRegistry,
  executeDerivedTool,
  listDeterministicTools
} from "./analysis-tools.js";
import { buildArchetypeWidgetContract, getArchetypeDefinition } from "../lib/archetypes.js";

const artifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "htmlFragment", "stylesCss", "widgetJs"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    htmlFragment: { type: "string" },
    stylesCss: { type: "string" },
    widgetJs: { type: "string" }
  }
};

const widgetToolRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "rationale", "toolCalls"],
  properties: {
    mode: {
      type: "string",
      enum: ["render", "call_tools"]
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

function sanitizeFileName(fileName) {
  if (!/^[a-z0-9._-]+$/i.test(fileName)) {
    throw new Error(`Invalid generated file name: ${fileName}`);
  }

  return fileName;
}

function firstQueryWindow(context) {
  for (const preview of context?.previews ?? []) {
    if (preview?.detail?.queryWindow || preview?.queryWindow) {
      return preview.detail?.queryWindow ?? preview.queryWindow;
    }
  }

  return null;
}

function normalizePreviewForWidget(preview) {
  const detail = preview?.detail ?? {};
  return {
    sourceId: preview?.sourceId ?? null,
    sourceName: preview?.sourceName ?? detail.sourceName ?? null,
    sourceType: preview?.sourceType ?? detail.sourceType ?? null,
    status: preview?.status ?? "unknown",
    queryWindow: detail.queryWindow ?? preview?.queryWindow ?? null,
    queryResults: Array.isArray(detail.queryResults)
      ? detail.queryResults
      : Array.isArray(preview?.queryResults)
        ? preview.queryResults
        : [],
    metrics: detail.metrics ?? preview?.metrics ?? {}
  };
}

function normalizeContextForWidget(context) {
  return {
    domainId: context?.domainId ?? null,
    domainName: context?.domainName ?? null,
    previewCount: Array.isArray(context?.previews) ? context.previews.length : 0,
    previews: (context?.previews ?? []).map(normalizePreviewForWidget)
  };
}

function buildWidgetPayload(domain, panel, run, widget = null) {
  const normalizedContext = normalizeContextForWidget(run.context);
  const queryWindow = firstQueryWindow(normalizedContext);
  const localSummary = run.localFindings ?? buildDeterministicPanelSummary(panel, run.context);
  const interaction = buildPanelInteractionState(panel, run.context);
  return {
    runId: run.id,
    domain: {
      id: domain.id,
      name: domain.name,
      color: domain.color,
      icon: domain.icon
    },
    panel: {
      id: panel.id,
      title: panel.title,
      summary: panel.summary
    },
    archetype: {
      id: run.selectedArchetype ?? null,
      title: run.archetypeTitle ?? null,
      reason: run.archetypeReason ?? null,
      confidence: run.archetypeConfidence ?? null
    },
    report: {
      ...(run.report ?? {}),
      findings: run.report?.findings ?? localSummary?.findings ?? [],
      localFindings: run.report?.localFindings ?? localSummary
    },
    context: {
      ...normalizedContext,
      coverage: localSummary?.coverage ?? null,
      recipe: localSummary?.recipe ?? null,
      findings: localSummary?.findings ?? []
    },
    localFindings: localSummary,
    findings: localSummary?.findings ?? [],
    interaction,
    timestamps: {
      runCreatedAt: run.createdAt ?? null,
      runUpdatedAt: run.updatedAt ?? null,
      widgetGeneratedAt: widget?.generatedAt ?? null,
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

function compactWidgetRun(run) {
  return {
    id: run.id,
    selectedArchetype: run.selectedArchetype ?? null,
    archetypeTitle: run.archetypeTitle ?? null,
    archetypeReason: run.archetypeReason ?? null,
    archetypeConfidence: run.archetypeConfidence ?? null,
    report: {
      narrative: (run.report?.narrative ?? []).slice(0, 3),
      highlights: (run.report?.highlights ?? []).slice(0, 4),
      details: (run.report?.details ?? []).slice(0, 4),
      chart: run.report?.chart
        ? {
          type: run.report.chart.type,
          title: run.report.chart.title,
          labels: (run.report.chart.labels ?? []).slice(0, 6),
          values: (run.report.chart.values ?? []).slice(0, 6)
        }
        : null
    },
    timestamps: {
      runUpdatedAt: run.updatedAt ?? null
    }
  };
}

function compactToolSummaryForWidget(summary) {
  return {
    panelId: summary?.panelId ?? null,
    panelTitle: summary?.panelTitle ?? null,
    coverage: {
      previewCount: summary?.coverage?.previewCount ?? 0,
      warningSources: (summary?.coverage?.warningSources ?? []).map((warning) => ({
        sourceName: warning.sourceName,
        message: warning.message
      })),
      queryWindow: summary?.coverage?.queryWindow ?? null
    },
    recipe: {
      focus: summary?.recipe?.focus ?? "",
      blocks: (summary?.recipe?.blocks ?? []).map((block) => ({
        id: block.id,
        title: block.title,
        operation: block.operation
      }))
    },
    findings: (summary?.findings ?? []).map((finding) => ({
      blockId: finding.blockId,
      title: finding.title,
      operation: finding.operation,
      value: finding.value ?? null,
      displayValue: finding.displayValue ?? null,
      entries: (finding.entries ?? []).slice(0, 4).map((entry) => ({
        label: entry.label,
        displayValue: entry.displayValue
      }))
    }))
  };
}

function compactToolRegistry(toolRegistry, limit = 12) {
  return {
    domainId: toolRegistry?.domainId ?? null,
    panelId: toolRegistry?.panelId ?? null,
    panelTitle: toolRegistry?.panelTitle ?? null,
    toolCount: Array.isArray(toolRegistry?.tools) ? toolRegistry.tools.length : 0,
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
    tool: {
      id: execution?.tool?.id ?? null,
      title: execution?.tool?.title ?? null,
      scopeType: execution?.tool?.scopeType ?? null,
      scopeTitle: execution?.tool?.scopeTitle ?? null,
      operation: execution?.tool?.operation ?? null
    },
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

function extractJson(text) {
  const fenced = String(text ?? "").match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : String(text ?? "");
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Agent response did not contain JSON.");
  }

  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

function sanitizeHtmlFragment(htmlFragment) {
  let fragment = String(htmlFragment ?? "").trim();

  fragment = fragment
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(html|head|body)\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");

  let appIdSeen = false;
  fragment = fragment.replace(/\bid=(["'])app\1/gi, () => {
    if (appIdSeen) {
      return 'data-morphy-root="generated"';
    }
    appIdSeen = true;
    return 'data-morphy-root="generated"';
  });

  return fragment;
}

function buildIndexHtml(widget, payload) {
  const serializedPayload = JSON.stringify(payload).replaceAll("</script", "<\\/script");
  const htmlFragment = sanitizeHtmlFragment(widget.htmlFragment);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${widget.title}</title>
    <link rel="stylesheet" href="/generated/widgets/${widget.id}/files/styles.css">
    <style>
      :root {
        --morphy-text: ${payload.theme?.text ?? "#ebf4ff"};
        --morphy-muted: ${payload.theme?.muted ?? "#97a8bc"};
        --morphy-bg: ${payload.theme?.background ?? "#07111d"};
        --morphy-surface: ${payload.theme?.panel ?? "#101826"};
        --morphy-surface-strong: #0d1725;
        --morphy-line: rgba(151, 168, 188, 0.18);
        --morphy-accent-soft: rgba(141, 240, 198, 0.12);
      }
      html, body {
        background: var(--morphy-bg);
        color: var(--morphy-text);
      }
      *, *::before, *::after {
        box-sizing: border-box;
      }
      body {
        min-height: 100vh;
      }
      #app {
        background: transparent;
      }
      #app,
      #app p,
      #app span,
      #app div,
      #app li,
      #app strong,
      #app small,
      #app h1,
      #app h2,
      #app h3,
      #app h4,
      #app h5,
      #app h6,
      #app label,
      #app dt,
      #app dd {
        color: var(--morphy-text);
      }
      #app .eyebrow,
      #app .muted,
      #app .summary,
      #app .hint,
      #app .note,
      #app .caption {
        color: var(--morphy-muted);
      }
      #app .subtitle,
      #app .subtext,
      #app .subtle,
      #app .meta,
      #app .meta-text,
      #app .secondary,
      #app .secondary-text,
      #app .label,
      #app .legend,
      #app .tick,
      #app .axis,
      #app .axis-label,
      #app [class*="subtitle"],
      #app [class*="summary"],
      #app [class*="caption"],
      #app [class*="meta"],
      #app [class*="note"],
      #app [class*="muted"],
      #app [class*="label"],
      #app [class*="sub"] {
        color: var(--morphy-muted) !important;
      }
      #app [class*="panel"],
      #app [class*="card"],
      #app [class*="tile"],
      #app [class*="stat"],
      #app [class*="box"],
      #app [class*="list"],
      #app [class*="lane"],
      #app [class*="legend"],
      #app [class*="chip"],
      #app [class*="metric"],
      #app [class*="shell"],
      #app [class*="priority"],
      #app [class*="narrative"] {
        background: linear-gradient(180deg, var(--morphy-surface-strong), var(--morphy-surface)) !important;
        border-color: var(--morphy-line) !important;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24) !important;
      }
      #app [style*="background: rgba(255,255,255"],
      #app [style*="background:rgba(255,255,255"],
      #app [style*="background-color: rgba(255,255,255"],
      #app [style*="background-color:rgba(255,255,255"] {
        background: linear-gradient(180deg, var(--morphy-surface-strong), var(--morphy-surface)) !important;
      }
      #app [style*="color: #b"],
      #app [style*="color:#b"],
      #app [style*="color: rgba(255,255,255,0."],
      #app [style*="color:rgba(255,255,255,0."] {
        color: var(--morphy-text) !important;
      }
      #app a {
        color: #9be7ff;
      }
      #app input,
      #app select,
      #app button,
      #app textarea {
        max-width: 100%;
      }
      #app input[type="date"],
      #app input[type="datetime-local"],
      #app input[type="search"],
      #app input[type="text"],
      #app select {
        width: 100%;
        min-width: 0;
      }
      #app button {
        min-width: 0;
      }
      #app [class*="grid"],
      #app [class*="controls"],
      #app [class*="filter"],
      #app [class*="toolbar"],
      #app [class*="shell"],
      #app [class*="panel"],
      #app [class*="card"] {
        min-width: 0;
      }
      #app .hfci-shell,
      #app .hfci-root,
      #app .hf-board,
      #app .widget-shell {
        --hfci-bg: #07111d !important;
        --hfci-bg2: #0a1624 !important;
        --hfci-panel: #0d1725 !important;
        --hfci-panel-2: #101b2b !important;
        --hfci-text: var(--morphy-text) !important;
        --hfci-muted: var(--morphy-muted) !important;
        --hfci-soft: #93a8ba !important;
        --hfci-line: var(--morphy-line) !important;
      }
      #app .jd-control-options,
      #app .interaction-grid,
      #app .jd-date-row {
        display: grid !important;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)) !important;
        gap: 0.75rem !important;
        min-width: 0 !important;
      }
      #app .jd-date-row label,
      #app .interaction-field,
      #app .jd-control-group {
        min-width: 0 !important;
      }
      #app .jd-option,
      #app .interaction-button,
      #app [data-control][data-value] {
        border: 1px solid var(--morphy-line) !important;
      }
      #app .jd-option,
      #app [data-control][data-value] {
        width: 100% !important;
        text-align: left !important;
        color: var(--morphy-text) !important;
        background: linear-gradient(180deg, rgba(16, 24, 38, 0.92), rgba(10, 18, 30, 0.92)) !important;
      }
      #app .jd-option.is-selected,
      #app [data-control][data-value].is-selected,
      #app [aria-pressed="true"] {
        background: linear-gradient(180deg, rgba(141, 240, 198, 0.2), rgba(155, 231, 255, 0.16)) !important;
        border-color: rgba(141, 240, 198, 0.55) !important;
        box-shadow: 0 0 0 1px rgba(141, 240, 198, 0.22) inset !important;
      }
      #app .jd-option small,
      #app [data-control][data-value] small {
        color: var(--morphy-muted) !important;
      }
    </style>
  </head>
  <body>
    <div id="app">${htmlFragment}</div>
    <script>window.__MORPHY_PAYLOAD__ = ${serializedPayload};</script>
    <script src="/runtime/widget-bridge.js"></script>
    <script src="/generated/widgets/${widget.id}/files/widget.js"></script>
  </body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildContrastRepairStyle() {
  return `
    <style data-morphy-contrast-repair>
      :root {
        --morphy-surface: #101826;
        --morphy-surface-strong: #0d1725;
        --morphy-text: #ebf4ff;
        --morphy-muted: #97a8bc;
        --morphy-line: rgba(151, 168, 188, 0.18);
      }
      html, body {
        background: #07111d;
        color: var(--morphy-text);
      }
      body {
        min-height: 100vh;
      }
      #app,
      #app p,
      #app span,
      #app div,
      #app li,
      #app strong,
      #app small,
      #app h1,
      #app h2,
      #app h3,
      #app h4,
      #app h5,
      #app h6,
      #app label,
      #app dt,
      #app dd {
        color: var(--morphy-text);
      }
      #app .eyebrow,
      #app .muted,
      #app .summary,
      #app .hint,
      #app .note,
      #app .caption,
      #app .subtitle,
      #app .subtext,
      #app .subtle,
      #app .meta,
      #app .meta-text,
      #app .secondary,
      #app .secondary-text,
      #app .label,
      #app .legend,
      #app .tick,
      #app .axis,
      #app .axis-label,
      #app [class*="subtitle"],
      #app [class*="summary"],
      #app [class*="caption"],
      #app [class*="meta"],
      #app [class*="note"],
      #app [class*="muted"],
      #app [class*="label"],
      #app [class*="sub"] {
        color: var(--morphy-muted) !important;
      }
      #app [class*="panel"],
      #app [class*="card"],
      #app [class*="tile"],
      #app [class*="stat"],
      #app [class*="box"],
      #app [class*="list"],
      #app [class*="lane"],
      #app [class*="legend"],
      #app [class*="chip"],
      #app [class*="metric"],
      #app [class*="shell"],
      #app [class*="priority"],
      #app [class*="narrative"] {
        background: linear-gradient(180deg, var(--morphy-surface-strong), var(--morphy-surface)) !important;
        border-color: var(--morphy-line) !important;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24) !important;
      }
      #app [style*="background: rgba(255,255,255"],
      #app [style*="background:rgba(255,255,255"],
      #app [style*="background-color: rgba(255,255,255"],
      #app [style*="background-color:rgba(255,255,255"] {
        background: linear-gradient(180deg, var(--morphy-surface-strong), var(--morphy-surface)) !important;
      }
      #app [style*="color: #b"],
      #app [style*="color:#b"],
      #app [style*="color: rgba(255,255,255,0."],
      #app [style*="color:rgba(255,255,255,0."] {
        color: var(--morphy-text) !important;
      }
      #app a {
        color: #9be7ff;
      }
      #app .hfci-shell,
      #app .hfci-root,
      #app .hf-board,
      #app .widget-shell {
        --hfci-bg: #07111d !important;
        --hfci-bg2: #0a1624 !important;
        --hfci-panel: #0d1725 !important;
        --hfci-panel-2: #101b2b !important;
        --hfci-text: var(--morphy-text) !important;
        --hfci-muted: var(--morphy-muted) !important;
        --hfci-soft: #93a8ba !important;
        --hfci-line: var(--morphy-line) !important;
      }
    </style>
  `;
}

function fallbackArchetypeId(run) {
  return run.selectedArchetype || "incident-summary";
}

function buildFallbackBundle(domain, panel, run) {
  const accent = domain.color || "#6ee7b7";
  const archetypeLabel = escapeHtml(run.archetypeTitle || run.selectedArchetype || "Adaptive Widget");
  const archetypeId = fallbackArchetypeId(run);
  const htmlFragment = `
    <section class="widget-shell archetype-${escapeHtml(archetypeId)}">
      <div class="hero-band">
        <p class="eyebrow">${escapeHtml(domain.name)}</p>
        <h1>${escapeHtml(panel.title)}</h1>
        <p class="summary">${escapeHtml(panel.summary)}</p>
        <p class="eyebrow">Archetype: ${archetypeLabel}</p>
      </div>
      <div id="interaction-target" class="interaction-target"></div>
      <div id="archetype-target" class="archetype-target"></div>
    </section>
  `;

  const stylesCss = `
    :root {
      color-scheme: dark;
      --bg: #07111d;
      --panel: rgba(11, 17, 28, 0.9);
      --line: rgba(148, 163, 184, 0.18);
      --text: #ebf4ff;
      --muted: #97a8bc;
      --accent: ${accent};
      --warm: #f5a524;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top right, rgba(110, 231, 183, 0.18), transparent 24%),
        linear-gradient(180deg, #07111d, #0d1725 55%, #111c2d 100%);
      padding: 1rem;
    }

    .widget-shell {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .hero-band,
    .widget-card {
      border-radius: 22px;
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 1rem;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
    }

    .widget-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
    }

    .archetype-target {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .interaction-target {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .interaction-shell {
      border-radius: 22px;
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 1rem;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
    }

    .interaction-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0.75rem;
    }

    .interaction-field {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .interaction-field label {
      font-size: 0.78rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .interaction-field select,
    .interaction-field input {
      width: 100%;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: rgba(15, 23, 42, 0.82);
      color: var(--text);
      padding: 0.7rem 0.8rem;
    }

    .interaction-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: center;
      justify-content: space-between;
      margin-top: 0.75rem;
    }

    .interaction-copy {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      min-width: 220px;
      flex: 1 1 260px;
    }

    .interaction-copy .eyebrow {
      margin-bottom: 0;
    }

    .interaction-button-row {
      display: flex;
      gap: 0.7rem;
      flex-wrap: wrap;
    }

    .interaction-button {
      border: 0;
      border-radius: 999px;
      padding: 0.6rem 1rem;
      font-weight: 700;
      font-size: 0.92rem;
      line-height: 1.1;
      color: #04111f;
      background: linear-gradient(135deg, var(--accent), #9be7ff);
      cursor: pointer;
      opacity: 1;
      box-shadow: 0 10px 24px rgba(3, 10, 20, 0.22);
      transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
    }

    .interaction-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 14px 28px rgba(3, 10, 20, 0.28);
    }

    .interaction-button:focus-visible {
      outline: 2px solid rgba(155, 231, 255, 0.9);
      outline-offset: 2px;
    }

    .interaction-button.secondary {
      color: #ebf4ff;
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.94), rgba(51, 65, 85, 0.94));
      border: 1px solid rgba(155, 231, 255, 0.28);
      box-shadow: 0 10px 24px rgba(2, 8, 20, 0.28);
    }

    .interaction-button.secondary:hover {
      border-color: rgba(155, 231, 255, 0.5);
      box-shadow: 0 14px 30px rgba(2, 8, 20, 0.34);
    }

    .interaction-button[disabled] {
      cursor: wait;
      opacity: 0.92;
      transform: none;
    }

    .interaction-status {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      padding: 0.32rem 0.7rem;
      border-radius: 999px;
      font-size: 0.78rem;
      letter-spacing: 0.04em;
      background: rgba(148, 163, 184, 0.12);
      color: var(--text);
      border: 1px solid rgba(148, 163, 184, 0.16);
    }

    .interaction-status.busy {
      background: rgba(155, 231, 255, 0.12);
      border-color: rgba(155, 231, 255, 0.3);
    }

    .interaction-status.error {
      background: rgba(248, 113, 113, 0.12);
      border-color: rgba(248, 113, 113, 0.28);
      color: #fecaca;
    }

    .eyebrow {
      margin: 0 0 0.4rem;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted);
      font-size: 0.72rem;
    }

    h1,
    p {
      margin: 0;
    }

    .summary,
    .narrative-target p {
      color: var(--muted);
      line-height: 1.55;
    }

    .summary-strong {
      color: var(--text);
      line-height: 1.5;
    }

    .metric-tape {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 0.75rem;
      margin-top: 0.75rem;
    }

    .metric {
      padding: 0.85rem;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(148, 163, 184, 0.14);
    }

    .metric .label {
      display: block;
      color: var(--muted);
      font-size: 0.75rem;
      margin-bottom: 0.4rem;
    }

    .metric .value {
      font-size: 1.15rem;
      font-weight: 700;
    }

    .viz-target {
      margin-top: 0.75rem;
    }

    .board-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0.8rem;
    }

    .board-stat {
      padding: 0.85rem;
      border-radius: 18px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(148, 163, 184, 0.14);
    }

    .board-stat .value {
      display: block;
      margin-top: 0.35rem;
      font-size: 1.4rem;
      font-weight: 700;
    }

    .action-strip,
    .link-list,
    .detail-list {
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
      margin-top: 0.75rem;
    }

    .action-chip,
    .link-chip {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      padding: 0.45rem 0.8rem;
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.84);
      border: 1px solid rgba(110, 231, 183, 0.18);
      color: var(--text);
      font-size: 0.82rem;
    }

    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
    }

    .timeline-strip {
      position: relative;
      display: grid;
      gap: 0.55rem;
      margin-top: 0.75rem;
    }

    .timeline-row {
      display: grid;
      grid-template-columns: minmax(90px, 120px) 1fr auto;
      gap: 0.7rem;
      align-items: center;
    }

    .timeline-spark {
      position: relative;
      height: 12px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.12);
      overflow: hidden;
    }

    .timeline-spark::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, rgba(110, 231, 183, 0.2), rgba(155, 231, 255, 0.85));
      clip-path: polygon(0% 70%, 12% 42%, 24% 58%, 36% 30%, 48% 48%, 60% 22%, 72% 40%, 84% 18%, 100% 36%, 100% 100%, 0% 100%);
      opacity: 0.95;
    }

    .evidence-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.8rem;
      margin-top: 0.75rem;
    }

    .evidence-cell {
      padding: 0.85rem;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(148, 163, 184, 0.14);
    }

    .viz-stack {
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
    }

    .viz-row {
      display: grid;
      grid-template-columns: minmax(90px, 130px) 1fr auto;
      gap: 0.7rem;
      align-items: center;
    }

    .bar-track {
      height: 11px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.12);
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), #9be7ff);
    }

    .narrative-target {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      margin-top: 0.75rem;
    }

    ul {
      margin: 0;
      padding-left: 1.1rem;
      color: var(--muted);
    }
  `;

  const widgetJs = `
    const root = document.getElementById("app");
    const archetypeId = ${JSON.stringify(archetypeId)};
    let currentPayload = null;
    let currentInteraction = null;
    let interactionStatus = {
      state: "idle",
      message: ""
    };

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function formatValue(value) {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return String(value);
      }

      if (Math.abs(value) >= 1000) {
        return value.toLocaleString();
      }

      return value.toFixed(value < 10 ? 2 : 1);
    }

    function topEntries(labels, values, count = 6) {
      return labels
        .map((label, index) => ({ label, value: Number(values[index] ?? 0) }))
        .filter((entry) => Number.isFinite(entry.value))
        .slice(0, count);
    }

    function isoDate(value) {
      if (!value) {
        return "";
      }

      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return "";
      }

      return date.toISOString().slice(0, 10);
    }

    function setInteractionStatus(state, message = "") {
      interactionStatus = {
        state,
        message
      };

      const statusNode = root.querySelector("#interaction-status");
      if (statusNode) {
        statusNode.className = \`interaction-status \${state === "busy" ? "busy" : state === "error" ? "error" : ""}\`.trim();
        statusNode.textContent = message || (state === "busy" ? "Working..." : "");
      }

      const applyButton = root.querySelector("#apply-interaction-button");
      const reinterpretButton = root.querySelector("#reinterpret-interaction-button");
      if (applyButton) {
        applyButton.disabled = state === "busy";
        applyButton.textContent = state === "busy" ? "Applying..." : "Apply Filters";
      }
      if (reinterpretButton) {
        reinterpretButton.disabled = state === "busy";
        reinterpretButton.textContent = state === "busy" ? "Reinterpreting..." : "Reinterpret";
      }
    }

    function renderInteraction(interaction) {
      const target = root.querySelector("#interaction-target");
      if (!target) {
        return;
      }

      if (!interaction || !Array.isArray(interaction.controls) || !interaction.controls.length) {
        target.innerHTML = "";
        return;
      }

      target.innerHTML = \`
        <section class="interaction-shell">
          <p class="eyebrow">Interactive Controls</p>
          <div class="interaction-grid">
            \${interaction.controls.map((control) => {
              if (control.type === "date_range") {
                return \`
                  <div class="interaction-field">
                    <label>\${escapeHtml(control.label)}</label>
                    <input type="date" data-control="\${escapeHtml(control.parameter)}:start" value="\${escapeHtml(isoDate(control.value?.start))}">
                    <input type="date" data-control="\${escapeHtml(control.parameter)}:end" value="\${escapeHtml(isoDate(control.value?.end))}">
                  </div>
                \`;
              }

              return \`
                <div class="interaction-field">
                  <label>\${escapeHtml(control.label)}</label>
                  <select data-control="\${escapeHtml(control.parameter)}" \${control.multiple ? "multiple" : ""}>
                    \${(control.options ?? []).map((option) => {
                      const selected = Array.isArray(control.value)
                        ? control.value.includes(option.value)
                        : control.value === option.value;
                      return \`<option value="\${escapeHtml(option.value)}" \${selected ? "selected" : ""}>\${escapeHtml(option.label)}</option>\`;
                    }).join("")}
                  </select>
                </div>
              \`;
            }).join("")}
          </div>
          <div class="interaction-actions">
            <div class="interaction-copy">
              <p class="eyebrow">Current Filter Scope</p>
              <p class="summary">\${escapeHtml(interaction.summary || "Request a narrower view from Morphy without regenerating the widget.")}</p>
              <span id="interaction-status" class="interaction-status">\${escapeHtml(interactionStatus.message || "")}</span>
            </div>
            <div class="interaction-button-row">
              <button class="interaction-button" type="button" id="apply-interaction-button">Apply Filters</button>
              <button class="interaction-button secondary" type="button" id="reinterpret-interaction-button">Reinterpret</button>
            </div>
          </div>
        </section>
      \`;

      target.querySelector("#apply-interaction-button")?.addEventListener("click", async () => {
        const nextParams = {};
        for (const control of interaction.controls) {
          if (control.type === "date_range") {
            const start = target.querySelector(\`[data-control="\${control.parameter}:start"]\`)?.value || "";
            const end = target.querySelector(\`[data-control="\${control.parameter}:end"]\`)?.value || "";
            nextParams[control.parameter] = {
              start: start ? \`\${start}T00:00:00Z\` : null,
              end: end ? \`\${end}T23:59:59Z\` : null
            };
            continue;
          }

          const select = target.querySelector(\`[data-control="\${control.parameter}"]\`);
          if (!select) {
            continue;
          }

          const values = Array.from(select.selectedOptions ?? []).map((option) => option.value);
          nextParams[control.parameter] = control.multiple ? values : (values[0] ?? null);
        }

        try {
          setInteractionStatus("busy", "Applying filters locally...");
          const response = await window.MorphyBridge.requestData(nextParams);
          if (response?.interaction) {
            currentInteraction = response.interaction;
            currentPayload = {
              ...(currentPayload ?? {}),
              interaction: response.interaction,
              report: {
                ...((currentPayload ?? {}).report ?? {}),
                ...(response.interaction.data?.report ?? {}),
                chart: response.interaction.data?.chart ?? response.interaction.data?.report?.chart ?? null
              }
            };
            render(currentPayload);
            setInteractionStatus("idle", "Filters applied.");
          }
        } catch (error) {
          setInteractionStatus("error", error.message);
          window.MorphyBridge.emit("widget:ready", {
            title: ${JSON.stringify(panel.title)},
            runId: ${JSON.stringify(run.id)},
            error: error.message
          });
        }
      });

      target.querySelector("#reinterpret-interaction-button")?.addEventListener("click", async () => {
        const nextParams = {};
        for (const control of interaction.controls) {
          if (control.type === "date_range") {
            const start = target.querySelector(\`[data-control="\${control.parameter}:start"]\`)?.value || "";
            const end = target.querySelector(\`[data-control="\${control.parameter}:end"]\`)?.value || "";
            nextParams[control.parameter] = {
              start: start ? \`\${start}T00:00:00Z\` : null,
              end: end ? \`\${end}T23:59:59Z\` : null
            };
            continue;
          }

          const select = target.querySelector(\`[data-control="\${control.parameter}"]\`);
          if (!select) {
            continue;
          }

          const values = Array.from(select.selectedOptions ?? []).map((option) => option.value);
          nextParams[control.parameter] = control.multiple ? values : (values[0] ?? null);
        }

        try {
          setInteractionStatus("busy", "Reinterpreting filtered view...");
          const response = await window.MorphyBridge.requestInterpretation(nextParams);
          if (response?.interaction) {
            currentInteraction = response.interaction;
            currentPayload = response;
            render(currentPayload);
            setInteractionStatus("idle", "Filtered analysis updated.");
          }
        } catch (error) {
          setInteractionStatus("error", error.message);
          window.MorphyBridge.emit("widget:ready", {
            title: ${JSON.stringify(panel.title)},
            runId: ${JSON.stringify(run.id)},
            error: error.message
          });
        }
      });
    }

    function renderRiskScoreboard(payload) {
      const report = payload?.report ?? {};
      const chart = report.chart ?? {};
      const entries = topEntries(chart.labels ?? [], chart.values ?? [], 6);
      const max = Math.max(...entries.map((entry) => entry.value), 1);
      return \`
        <div class="widget-grid">
          <section class="widget-card">
            <p class="eyebrow">Ranked Signals</p>
            <div class="viz-stack">
              \${entries.map((entry, index) => \`
                <div class="viz-row">
                  <span>\${index + 1}. \${escapeHtml(entry.label)}</span>
                  <div class="bar-track"><div class="bar-fill" style="width: \${Math.max(8, (entry.value / max) * 100)}%"></div></div>
                  <strong>\${escapeHtml(formatValue(entry.value))}</strong>
                </div>
              \`).join("")}
            </div>
          </section>
          <section class="widget-card">
            <p class="eyebrow">Triage Summary</p>
            <div class="action-strip">
              \${(report.highlights ?? []).slice(0, 4).map((entry) => \`<span class="action-chip">\${escapeHtml(entry)}</span>\`).join("")}
            </div>
            <div class="narrative-target">\${(report.narrative ?? []).slice(0, 2).map((entry) => \`<p>\${escapeHtml(entry)}</p>\`).join("")}</div>
          </section>
        </div>
      \`;
    }

    function renderPressureBoard(payload) {
      const report = payload?.report ?? {};
      const chart = report.chart ?? {};
      const entries = topEntries(chart.labels ?? [], chart.values ?? [], 6);
      const max = Math.max(...entries.map((entry) => entry.value), 1);
      return \`
        <div class="widget-card">
          <p class="eyebrow">Pressure Metrics</p>
          <div class="board-grid">
            \${entries.slice(0, 4).map((entry) => \`
              <div class="board-stat">
                <span class="label">\${escapeHtml(entry.label)}</span>
                <span class="value">\${escapeHtml(formatValue(entry.value))}</span>
              </div>
            \`).join("")}
          </div>
        </div>
        <div class="widget-card">
          <p class="eyebrow">Backlog Board</p>
          <div class="viz-stack">
            \${entries.map((entry) => \`
              <div class="viz-row">
                <span>\${escapeHtml(entry.label)}</span>
                <div class="bar-track"><div class="bar-fill" style="width: \${Math.max(8, (entry.value / max) * 100)}%"></div></div>
                <strong>\${escapeHtml(formatValue(entry.value))}</strong>
              </div>
            \`).join("")}
          </div>
        </div>
      \`;
    }

    function renderTimelineAnalysis(payload) {
      const report = payload?.report ?? {};
      const chart = report.chart ?? {};
      const entries = topEntries(chart.labels ?? [], chart.values ?? [], 6);
      return \`
        <div class="widget-card">
          <p class="eyebrow">Timeline Overview</p>
          <div class="timeline-strip">
            \${entries.map((entry) => \`
              <div class="timeline-row">
                <span>\${escapeHtml(entry.label)}</span>
                <div class="timeline-spark"></div>
                <strong>\${escapeHtml(formatValue(entry.value))}</strong>
              </div>
            \`).join("")}
          </div>
        </div>
        <div class="widget-card">
          <p class="eyebrow">Trend Notes</p>
          <div class="narrative-target">\${(report.narrative ?? []).map((entry) => \`<p>\${escapeHtml(entry)}</p>\`).join("")}</div>
        </div>
      \`;
    }

    function renderCorrelationInspector(payload) {
      const report = payload?.report ?? {};
      const chart = report.chart ?? {};
      const entries = topEntries(chart.labels ?? [], chart.values ?? [], 6);
      return \`
        <div class="detail-grid">
          <section class="widget-card">
            <p class="eyebrow">Entity Links</p>
            <div class="link-list">
              \${entries.slice(0, 5).map((entry) => \`<span class="link-chip">\${escapeHtml(entry.label)} · \${escapeHtml(formatValue(entry.value))}</span>\`).join("")}
            </div>
          </section>
          <section class="widget-card">
            <p class="eyebrow">Evidence Matrix</p>
            <div class="evidence-grid">
              \${(report.highlights ?? []).slice(0, 4).map((entry) => \`<div class="evidence-cell">\${escapeHtml(entry)}</div>\`).join("")}
            </div>
          </section>
        </div>
        <section class="widget-card">
          <p class="eyebrow">Attribution Notes</p>
          <div class="narrative-target">\${(report.narrative ?? []).map((entry) => \`<p>\${escapeHtml(entry)}</p>\`).join("")}</div>
        </section>
      \`;
    }

    function renderIncidentSummary(payload) {
      const report = payload?.report ?? {};
      const chart = report.chart ?? {};
      const entries = topEntries(chart.labels ?? [], chart.values ?? [], 3);
      return \`
        <section class="widget-card">
          <p class="eyebrow">Briefing</p>
          <div class="narrative-target">\${(report.narrative ?? []).map((entry) => \`<p class="summary-strong">\${escapeHtml(entry)}</p>\`).join("")}</div>
        </section>
        <div class="widget-grid">
          <section class="widget-card">
            <p class="eyebrow">Actions</p>
            <div class="action-strip">
              \${(report.highlights ?? []).slice(0, 5).map((entry) => \`<span class="action-chip">\${escapeHtml(entry)}</span>\`).join("")}
            </div>
          </section>
          <section class="widget-card">
            <p class="eyebrow">Supporting Signals</p>
            <div class="detail-list">
              \${entries.map((entry) => \`<p>\${escapeHtml(entry.label)}: <strong>\${escapeHtml(formatValue(entry.value))}</strong></p>\`).join("")}
            </div>
          </section>
        </div>
      \`;
    }

    function renderJobDetailSheet(payload) {
      const report = payload?.report ?? {};
      const interaction = payload?.interaction ?? {};
      const chart = report.chart ?? {};
      const entries = topEntries(chart.labels ?? [], chart.values ?? [], 6);
      const narrativeLines = Array.isArray(report.narrative) ? report.narrative.filter(Boolean) : [];
      const leadSummary = narrativeLines[0] || interaction.summary || "";
      const supportingNarrative = narrativeLines.length > 1
        ? narrativeLines.slice(1)
        : (interaction.summary && interaction.summary !== leadSummary ? [interaction.summary] : []);
      return \`
        <section class="widget-card">
          <p class="eyebrow">Analytical Summary</p>
          <div class="narrative-target">
            \${leadSummary ? \`<p class="summary-strong">\${escapeHtml(leadSummary)}</p>\` : ""}
            \${supportingNarrative.map((entry) => \`<p>\${escapeHtml(entry)}</p>\`).join("")}
          </div>
        </section>
        <section class="widget-card">
          <p class="eyebrow">Job Header</p>
          <div class="board-grid">
            \${entries.slice(0, 3).map((entry) => \`
              <div class="board-stat">
                <span class="label">\${escapeHtml(entry.label)}</span>
                <span class="value">\${escapeHtml(formatValue(entry.value))}</span>
              </div>
            \`).join("")}
          </div>
        </section>
        <div class="detail-grid">
        <section class="widget-card">
          <p class="eyebrow">Behavioral Profile</p>
          <div class="viz-stack">
              \${entries.map((entry) => \`
                <div class="viz-row">
                  <span>\${escapeHtml(entry.label)}</span>
                  <div class="bar-track"><div class="bar-fill" style="width: \${Math.max(8, Math.min(100, entry.value))}%"></div></div>
                  <strong>\${escapeHtml(formatValue(entry.value))}</strong>
                </div>
              \`).join("")}
            </div>
          </section>
        <section class="widget-card">
          <p class="eyebrow">Follow-up Drilldowns</p>
          <div class="detail-list">
              \${(report.highlights ?? []).slice(0, 5).map((entry) => \`<p>\${escapeHtml(entry)}</p>\`).join("")}
            </div>
          </section>
        </div>
      \`;
    }

    function render(payload) {
      currentPayload = payload;
      currentInteraction = payload?.interaction ?? currentInteraction;
      const report = payload?.report ?? {};
      const chart = report.chart ?? {};
      const target = root.querySelector("#archetype-target");
      renderInteraction(currentInteraction);
      if (interactionStatus.state === "idle" && !interactionStatus.message) {
        setInteractionStatus("idle", "");
      }

      if (!Array.isArray(chart.labels) || !chart.labels.length) {
        target.innerHTML = '<section class="widget-card"><p class="eyebrow">No Data</p><p class="summary">No numeric chart data is available for this run.</p></section>';
      } else if (archetypeId === "risk-scoreboard") {
        target.innerHTML = renderRiskScoreboard(payload);
      } else if (archetypeId === "pressure-board") {
        target.innerHTML = renderPressureBoard(payload);
      } else if (archetypeId === "timeline-analysis") {
        target.innerHTML = renderTimelineAnalysis(payload);
      } else if (archetypeId === "correlation-inspector") {
        target.innerHTML = renderCorrelationInspector(payload);
      } else if (archetypeId === "job-detail-sheet") {
        target.innerHTML = renderJobDetailSheet(payload);
      } else {
        target.innerHTML = renderIncidentSummary(payload);
      }

      window.MorphyBridge.emit("widget:resize", {
        height: Math.ceil(document.documentElement.scrollHeight)
      });
    }

    window.MorphyBridge.onInit(render);
    window.MorphyBridge.onUpdate(render);
    window.MorphyBridge.emit("widget:ready", {
      title: ${JSON.stringify(panel.title)},
      runId: ${JSON.stringify(run.id)}
    });
  `;

  return {
    title: `${panel.title} Widget`,
    summary: `Fallback browser visualization for ${panel.title}.`,
    htmlFragment,
    stylesCss,
    widgetJs
  };
}

function parseArtifactResponse(response) {
  if (!response.output_text) {
    throw new Error("Code generation did not return output_text.");
  }

  return JSON.parse(response.output_text);
}

function normalizeGeneratedText(content, fileName = "") {
  if (typeof content !== "string") {
    return content;
  }

  let normalized = content;
  const hasRealNewlines = normalized.includes("\n");
  const hasEscapedNewlines = normalized.includes("\\n");

  if (hasEscapedNewlines && !hasRealNewlines) {
    normalized = normalized
      .replaceAll("\\r\\n", "\n")
      .replaceAll("\\n", "\n")
      .replaceAll("\\t", "\t");
  }

  if ((fileName.endsWith(".js") || fileName.endsWith(".css") || fileName.endsWith(".html")) && normalized.startsWith('"') && normalized.endsWith('"')) {
    try {
      normalized = JSON.parse(normalized);
    } catch {
      normalized = normalized.slice(1, -1);
    }
  }

  return normalized;
}

export class WidgetService {
  constructor({ configStore, logger, billingTracker = null }) {
    this.configStore = configStore;
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

  async generateForRun({ domain, panel, run }) {
    const appConfig = await this.configStore.getAppConfig();
    const artifactId = crypto.randomUUID();
    const useDeterministicInteractiveWidget = panel?.interactionMode && panel.interactionMode !== "report";
    this.logger.info("Generating widget artifact", {
      artifactId,
      domainId: domain.id,
      panelId: panel.id,
      runId: run.id,
      provider: useDeterministicInteractiveWidget ? "interactive-fallback" : (this.openai ? "openai" : "fallback")
    }, "widgets");
    const usedOpenAiGeneration = !useDeterministicInteractiveWidget && Boolean(this.openai);
    const generated = usedOpenAiGeneration
      ? await this.generateWithOpenAI({ appConfig, domain, panel, run })
      : buildFallbackBundle(domain, panel, run);
    const bundle = usedOpenAiGeneration ? generated.bundle : generated;
    const widget = {
      id: artifactId,
      domainId: domain.id,
      panelId: panel.id,
      runId: run.id,
      archetypeId: run.selectedArchetype ?? null,
      archetypeTitle: run.archetypeTitle ?? null,
      title: bundle.title,
      summary: bundle.summary,
      sandbox: appConfig.codegen?.sandboxMode ?? "iframe",
      bridgeVersion: "1",
      entrypoint: "index.html",
      files: ["index.html", "styles.css", "widget.js", "manifest.json"],
      generatedAt: new Date().toISOString(),
      provider: useDeterministicInteractiveWidget
        ? "local-interactive-template"
        : (usedOpenAiGeneration ? `openai:${appConfig.codegen?.model ?? "gpt-5.4"}` : "local-template")
    };
    const payload = buildWidgetPayload(domain, panel, run, widget);

    await this.writeBundle(widget, bundle, payload);
    await this.configStore.saveWidget(widget);
    let billingEntries = generated?.billingEntries ?? [];
    if (usedOpenAiGeneration && generated?.response) {
      const finalBillingEntry = await this.billingTracker?.recordResponseUsage({
        response: generated.response,
        model: appConfig.codegen?.model ?? "gpt-5.4",
        operation: "widget_generation",
        provider: "openai-responses",
        domainId: domain.id,
        panelId: panel.id,
        panelTitle: panel.title,
        archetypeId: run.selectedArchetype,
        archetypeTitle: run.archetypeTitle,
        runId: run.id
      });
      if (finalBillingEntry) {
        billingEntries = [...billingEntries, finalBillingEntry];
      }
    }
    this.logger.info("Saved widget artifact", {
      artifactId: widget.id,
      panelId: panel.id,
      runId: run.id
    }, "widgets");
    return {
      widget,
      billingEntries,
      toolMode: generated?.toolMode ?? null,
      toolTrace: generated?.toolTrace ?? [],
      toolDecision: generated?.toolDecision ?? null
    };
  }

  async runWidgetToolLoop({ appConfig, domain, panel, run, widgetContract, panelToolRegistry, panelToolSummary, compactRun }) {
    const toolTrace = [];
    const billingEntries = [];
    const availableToolIds = new Set(compactToolRegistryIds(panelToolRegistry));
    const requireToolCall = Boolean(
      appConfig.agent?.localTools?.enabled &&
      appConfig.agent?.localTools?.primaryForAnalysis &&
      Array.isArray(panelToolRegistry?.tools) &&
      panelToolRegistry.tools.length
    );
    const toolRequirementText = requireToolCall
      ? "You must request 1 to 3 derived tool calls from the provided registry before final widget generation. Do not return mode=render on this step."
      : "If the existing evidence is sufficient, you may return mode=render with no tool calls.";
    const recordUsage = async (response) => {
      const billingEntry = await this.billingTracker?.recordResponseUsage({
        response,
        model: appConfig.codegen?.model ?? "gpt-5.4",
        operation: "widget_generation",
        provider: "openai-responses",
        domainId: domain.id,
        panelId: panel.id,
        panelTitle: panel.title,
        archetypeId: run.selectedArchetype,
        archetypeTitle: run.archetypeTitle,
        runId: run.id
      });
      if (billingEntry) {
        billingEntries.push(billingEntry);
      }
    };

    const initialResponse = await this.openai.responses.create({
      model: appConfig.codegen?.model ?? "gpt-5.4",
      reasoning: {
        effort: appConfig.codegen?.reasoningEffort ?? "medium"
      },
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `You are preparing a browser widget artifact. ${toolRequirementText} Return strict JSON only.`
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Decide which derived tools, if any, should be invoked before final widget generation.\n\nStable local analysis primitives:\n${JSON.stringify(listDeterministicTools(), null, 2)}\n\nPanel-specific exposed tool registry:\n${JSON.stringify(compactToolRegistry(panelToolRegistry), null, 2)}\n\nPanel identity:\n${JSON.stringify({
                id: panel.id,
                title: panel.title,
                summary: panel.summary,
                chartPreference: panel.chartPreference,
                color: domain.color
              }, null, 2)}\n\nSelected archetype:\n${JSON.stringify({
                id: run.selectedArchetype,
                title: run.archetypeTitle,
                reason: run.archetypeReason,
                confidence: run.archetypeConfidence
              }, null, 2)}\n\nArchetype widget contract:\n${JSON.stringify({
                id: widgetContract?.id,
                title: widgetContract?.title,
                description: widgetContract?.description,
                requiredSections: widgetContract?.requiredSections,
                detailSections: widgetContract?.detailSections,
                layoutGuidance: widgetContract?.layoutGuidance
              }, null, 2)}\n\nCompact deterministic evidence:\n${JSON.stringify(panelToolSummary, null, 2)}\n\nCompact run summary:\n${JSON.stringify(compactRun, null, 2)}\n\n${requireToolCall ? "Return mode=call_tools with 1 to 3 tool calls from the registry. Choose the tools most likely to sharpen the widget structure or evidence presentation." : "If you already have enough evidence, return mode=render with no tool calls. If you need more evidence, return mode=call_tools with up to 3 tool calls from the registry."}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "widget_tool_request",
          schema: widgetToolRequestSchema,
          strict: true
        }
      }
    });
    await recordUsage(initialResponse);

    const decision = initialResponse.output_text
      ? JSON.parse(initialResponse.output_text)
      : extractJson(JSON.stringify(initialResponse.output));
    this.logger.info("Widget tool decision received", {
      runId: run.id,
      panelId: panel.id,
      mode: decision.mode,
      toolCallCount: decision.toolCalls?.length ?? 0,
      required: requireToolCall
    }, "widgets");

    let requestedToolCalls = [...(decision.toolCalls ?? [])];

    if (requireToolCall && (decision.mode !== "call_tools" || !requestedToolCalls.length)) {
      const repairResponse = await this.openai.responses.create({
        model: appConfig.codegen?.model ?? "gpt-5.4",
        reasoning: {
          effort: appConfig.codegen?.reasoningEffort ?? "medium"
        },
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: "You must request derived tools before final widget generation. Return strict JSON only."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The previous response did not request tools, but this widget-generation mode requires tool invocation. Return mode=call_tools with 1 to 3 tool calls from this registry.\n\nPanel-specific exposed tool registry:\n${JSON.stringify(compactToolRegistry(panelToolRegistry), null, 2)}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "widget_tool_request_repair",
            schema: widgetToolRequestSchema,
            strict: true
          }
        }
      });
      await recordUsage(repairResponse);
      const repairedDecision = repairResponse.output_text
        ? JSON.parse(repairResponse.output_text)
        : extractJson(JSON.stringify(repairResponse.output));
      if (repairedDecision.mode === "call_tools" && (repairedDecision.toolCalls ?? []).length) {
        decision.mode = repairedDecision.mode;
        decision.rationale = repairedDecision.rationale;
        requestedToolCalls = repairedDecision.toolCalls;
      }
    }

    if (requestedToolCalls.some((toolCall) => toolCall?.toolId && !availableToolIds.has(toolCall.toolId))) {
      const invalidToolIds = requestedToolCalls
        .map((toolCall) => toolCall?.toolId)
        .filter((toolId) => toolId && !availableToolIds.has(toolId));
      const repairInvalidResponse = await this.openai.responses.create({
        model: appConfig.codegen?.model ?? "gpt-5.4",
        reasoning: {
          effort: appConfig.codegen?.reasoningEffort ?? "medium"
        },
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: "You must request only tool ids that appear in the provided registry. Return strict JSON only."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The previous tool request included invalid tool ids: ${invalidToolIds.join(", ")}.\n\nReturn mode=call_tools with 1 to 3 tool calls using only these valid tools:\n${JSON.stringify(compactToolRegistry(panelToolRegistry), null, 2)}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "widget_tool_request_registry_repair",
            schema: widgetToolRequestSchema,
            strict: true
          }
        }
      });
      await recordUsage(repairInvalidResponse);
      const repairedInvalidDecision = repairInvalidResponse.output_text
        ? JSON.parse(repairInvalidResponse.output_text)
        : extractJson(JSON.stringify(repairInvalidResponse.output));
      if (repairedInvalidDecision.mode === "call_tools" && (repairedInvalidDecision.toolCalls ?? []).length) {
        requestedToolCalls = repairedInvalidDecision.toolCalls;
      }
    }

    if (decision.mode !== "call_tools" || !requestedToolCalls.length) {
      return {
        toolMode: "model-no-tools",
        toolTrace,
        toolDecision: decision,
        derivedToolOutputs: [],
        billingEntries
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
          mode: "render",
          rationale: `${decision.rationale} No valid derived tool ids were returned after validation.`
        },
        derivedToolOutputs: [],
        billingEntries
      };
    }

    const derivedToolOutputs = uniqueToolCalls.map((toolCall) => {
      const execution = executeDerivedTool(panelToolRegistry, run.context, toolCall.toolId);
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
    this.logger.info("Widget tools executed", {
      runId: run.id,
      panelId: panel.id,
      toolIds: toolTrace.map((entry) => entry.toolId),
      toolCount: toolTrace.length
    }, "widgets");

    return {
      toolMode: "model-directed",
      toolTrace,
      toolDecision: decision,
      derivedToolOutputs,
      billingEntries
    };
  }

  async generateWithOpenAI({ appConfig, domain, panel, run }) {
    this.logger.debug("Requesting OpenAI widget generation", {
      domainId: domain.id,
      panelId: panel.id,
      runId: run.id,
      model: appConfig.codegen?.model ?? "gpt-5.4",
      archetype: run.selectedArchetype ?? null
    }, "widgets");
    const archetype = getArchetypeDefinition(appConfig, domain, run.selectedArchetype);
    const widgetContract = buildArchetypeWidgetContract(appConfig, domain, run.selectedArchetype);
    const panelToolSummary = compactToolSummaryForWidget(buildDeterministicPanelSummary(panel, run.context));
    const compactRun = compactWidgetRun(run);
    const panelToolRegistry = buildPanelToolRegistry(domain, panel);
    const widgetToolLoop = await this.runWidgetToolLoop({
      appConfig,
      domain,
      panel,
      run,
      widgetContract,
      panelToolRegistry,
      panelToolSummary,
      compactRun
    });
    const response = await this.openai.responses.create({
      model: appConfig.codegen?.model ?? "gpt-5.4",
      reasoning: {
        effort: appConfig.codegen?.reasoningEffort ?? "medium"
      },
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Generate a browser widget artifact for a sandboxed iframe. Return JSON only. The widget must not fetch network resources, use eval, or depend on external libraries. It must rely on window.MorphyBridge.onInit, window.MorphyBridge.onUpdate, window.MorphyBridge.requestData, window.MorphyBridge.requestInterpretation, and window.MorphyBridge.emit. The HTML fragment should be body-safe only, with no script tags. Stay within the selected widget archetype rather than inventing an unrelated layout. Make the widget visually and structurally distinct for the chosen archetype. Use high-contrast text and avoid dark text on dark or saturated backgrounds."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Create a polished browser visualization widget for this analytical panel.\n\nUse the deterministic local evidence as the primary rendering guide. The embedded payload at runtime will contain the full report, context, and theme, so do not assume this prompt is the only available data source.\n\nStable local analysis primitives:\n${JSON.stringify(listDeterministicTools(), null, 2)}\n\nPanel-specific exposed tool registry:\n${JSON.stringify(panelToolRegistry, null, 2)}\n\nPanel identity:\n${JSON.stringify({
                id: panel.id,
                title: panel.title,
                summary: panel.summary,
                chartPreference: panel.chartPreference,
                color: domain.color,
                interactionMode: panel.interactionMode ?? "report",
                interactionContract: panel.interactionContract ?? null
              }, null, 2)}\n\nSelected archetype:\n${JSON.stringify({
                id: run.selectedArchetype,
                title: run.archetypeTitle,
                reason: run.archetypeReason,
                confidence: run.archetypeConfidence
              }, null, 2)}\n\nArchetype widget contract:\n${JSON.stringify({
                id: widgetContract?.id,
                title: widgetContract?.title,
                description: widgetContract?.description,
                requiredSections: widgetContract?.requiredSections,
                detailSections: widgetContract?.detailSections,
                layoutGuidance: widgetContract?.layoutGuidance
              }, null, 2)}\n\nCompact deterministic evidence:\n${JSON.stringify(panelToolSummary, null, 2)}\n\nCompact run summary:\n${JSON.stringify(compactRun, null, 2)}\n\nDerived tool decision:\n${JSON.stringify({
                mode: widgetToolLoop.toolMode,
                decision: widgetToolLoop.toolDecision ?? null
              }, null, 2)}\n\nDerived tool outputs:\n${JSON.stringify(widgetToolLoop.derivedToolOutputs ?? [], null, 2)}\n\nWidget contract:\n- Render into document.getElementById("app")\n- Use payload.report, payload.context, payload.domain, payload.panel, payload.archetype, payload.interaction, and payload.theme at runtime\n- If payload.interaction.controls exists, render meaningful validated controls and use window.MorphyBridge.requestData(params) to repopulate the widget without regeneration\n- If the user explicitly wants a refreshed analytical interpretation of the filtered view, use window.MorphyBridge.requestInterpretation(params)\n- Register both onInit and onUpdate handlers\n- Include the archetype's required sections in some form\n- After rendering, emit widget:resize with a height field`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "browser_widget_artifact",
          schema: artifactSchema,
          strict: true
        }
      }
    });

    return {
      bundle: parseArtifactResponse(response),
      response,
      toolMode: widgetToolLoop.toolMode,
      toolTrace: widgetToolLoop.toolTrace,
      toolDecision: widgetToolLoop.toolDecision,
      billingEntries: widgetToolLoop.billingEntries ?? []
    };
  }

  async writeBundle(widget, bundle, payload) {
    const bundleDir = path.join(paths.widgetBundlesDir, widget.id);
    await fs.mkdir(bundleDir, { recursive: true });
    this.logger.debug("Writing widget bundle", {
      widgetId: widget.id,
      bundleDir,
      files: widget.files
    }, "widgets");

    const files = {
      "index.html": buildIndexHtml({ ...widget, htmlFragment: bundle.htmlFragment }, payload),
      "styles.css": normalizeGeneratedText(bundle.stylesCss, "styles.css"),
      "widget.js": normalizeGeneratedText(bundle.widgetJs, "widget.js"),
      "manifest.json": `${JSON.stringify(widget, null, 2)}\n`
    };

    await Promise.all(
      Object.entries(files).map(([fileName, content]) =>
        fs.writeFile(path.join(bundleDir, sanitizeFileName(fileName)), content, "utf8")
      )
    );
  }

  async getWidgetFilePath(widgetId, fileName = "index.html") {
    const widget = await this.configStore.getWidget(widgetId);

    if (!widget) {
      return null;
    }

    const safeFileName = sanitizeFileName(fileName);

    if (!widget.files.includes(safeFileName)) {
      throw new Error(`Unknown widget file: ${safeFileName}`);
    }

    return path.join(paths.widgetBundlesDir, widget.id, safeFileName);
  }

  async buildRuntimeWidgetArtifact(widgetId) {
    const widget = await this.configStore.getWidget(widgetId);
    if (!widget || widget.provider !== "local-interactive-template") {
      return null;
    }

    const [domain, run] = await Promise.all([
      this.configStore.getDomain(widget.domainId),
      this.configStore.getRun(widget.runId)
    ]);

    if (!domain || !run) {
      return null;
    }

    const panel = domain.panels.find((entry) => entry.id === widget.panelId);
    if (!panel) {
      return null;
    }

    const payload = buildWidgetPayload(domain, panel, run, widget);
    const bundle = buildFallbackBundle(domain, panel, run);

    return {
      widget,
      payload,
      bundle
    };
  }

  async getServedWidgetAsset(widgetId, fileName) {
    const safeFileName = sanitizeFileName(fileName);
    if (!["widget.js", "styles.css"].includes(safeFileName)) {
      return null;
    }

    const runtimeArtifact = await this.buildRuntimeWidgetArtifact(widgetId);
    if (runtimeArtifact) {
      if (safeFileName === "widget.js") {
        return normalizeGeneratedText(runtimeArtifact.bundle.widgetJs, safeFileName);
      }

      return normalizeGeneratedText(runtimeArtifact.bundle.stylesCss, safeFileName);
    }

    const filePath = await this.getWidgetFilePath(widgetId, fileName);

    if (!filePath) {
      return null;
    }

    const raw = await fs.readFile(filePath, "utf8");
    return normalizeGeneratedText(raw, safeFileName);
  }

  async getServedIndexHtml(widgetId) {
    const runtimeArtifact = await this.buildRuntimeWidgetArtifact(widgetId);
    let html;
    let filePath = null;

    if (runtimeArtifact) {
      html = buildIndexHtml(
        { ...runtimeArtifact.widget, htmlFragment: runtimeArtifact.bundle.htmlFragment },
        runtimeArtifact.payload
      );
    } else {
      filePath = await this.getWidgetFilePath(widgetId, "index.html");

      if (!filePath) {
        this.logger.warn("Requested widget HTML for unknown widget", { widgetId }, "widgets");
        return null;
      }

      html = await fs.readFile(filePath, "utf8");
    }

    this.logger.debug("Serving widget HTML", { widgetId, filePath }, "widgets");
    const contrastRepairStyle = buildContrastRepairStyle();

    html = html.replace(
      /<script\b([^>]*)\bsrc=(["'])([^"']*\/widget\.js)\2([^>]*)><\/script>/gi,
      (_match, beforeSrc, _quote, src, afterSrc) => {
        const normalizedAttrs = `${beforeSrc} ${afterSrc}`
          .replace(/\btype\s*=\s*(["'])module\1/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        const attributePrefix = normalizedAttrs ? ` ${normalizedAttrs}` : "";
        return `<script${attributePrefix} src="${src}"></script>`;
      }
    );

    let appRootSeen = false;
    html = html.replace(/\bid=(["'])app\1/gi, () => {
      if (appRootSeen) {
        return 'data-morphy-root="generated"';
      }
      appRootSeen = true;
      return 'id="app"';
    });

    if (!html.includes("data-morphy-contrast-repair")) {
      if (html.includes("</head>")) {
        html = html.replace("</head>", `${contrastRepairStyle}\n  </head>`);
      } else {
        html = `${contrastRepairStyle}\n${html}`;
      }
    }

    const widget = await this.configStore.getWidget(widgetId);
    const run = widget ? await this.configStore.getRun(widget.runId) : null;
    const domain = run ? await this.configStore.getDomain(run.domainId) : null;
    const panel = domain?.panels.find((entry) => entry.id === run?.panelId);

    if (!widget || !run?.report || !domain || !panel) {
      this.logger.warn("Widget payload injection skipped due to missing context", {
        widgetId,
        hasWidget: Boolean(widget),
        hasRun: Boolean(run),
        hasDomain: Boolean(domain),
        hasPanel: Boolean(panel)
      }, "widgets");
      return html;
    }

    const payload = JSON.stringify(buildWidgetPayload(domain, panel, run, widget)).replaceAll("</script", "<\\/script");
    const injection = `<script>window.__MORPHY_PAYLOAD__ = ${payload};</script>`;

    if (html.includes("window.__MORPHY_PAYLOAD__")) {
      this.logger.trace("Replacing embedded widget payload", { widgetId }, "widgets");
      return html.replace(/<script>\s*window\.__MORPHY_PAYLOAD__\s*=\s*[\s\S]*?<\/script>/i, injection);
    }

    if (html.includes('<script src="/runtime/widget-bridge.js"></script>')) {
      return html.replace('<script src="/runtime/widget-bridge.js"></script>', `${injection}\n    <script src="/runtime/widget-bridge.js"></script>`);
    }

    return html.replace("</body>", `    ${injection}\n  </body>`);
  }
}
