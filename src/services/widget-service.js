import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { paths } from "./config-store.js";
import { buildDeterministicPanelSummary, buildPanelToolRegistry, listDeterministicTools } from "./analysis-tools.js";
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
      const chart = report.chart ?? {};
      const entries = topEntries(chart.labels ?? [], chart.values ?? [], 6);
      return \`
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
            <p class="eyebrow">Resource Profile</p>
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
            <p class="eyebrow">Candidate Drilldowns</p>
            <div class="detail-list">
              \${(report.highlights ?? []).slice(0, 5).map((entry) => \`<p>\${escapeHtml(entry)}</p>\`).join("")}
            </div>
          </section>
        </div>
      \`;
    }

    function render(payload) {
      const report = payload?.report ?? {};
      const chart = report.chart ?? {};
      const target = root.querySelector("#archetype-target");

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
    this.logger.info("Generating widget artifact", {
      artifactId,
      domainId: domain.id,
      panelId: panel.id,
      runId: run.id,
      provider: this.openai ? "openai" : "fallback"
    }, "widgets");
    const generated = this.openai
      ? await this.generateWithOpenAI({ appConfig, domain, panel, run })
      : buildFallbackBundle(domain, panel, run);
    const bundle = this.openai ? generated.bundle : generated;
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
      provider: this.openai ? `openai:${appConfig.codegen?.model ?? "gpt-5.4"}` : "local-template"
    };
    const payload = buildWidgetPayload(domain, panel, run, widget);

    await this.writeBundle(widget, bundle, payload);
    await this.configStore.saveWidget(widget);
    let billingEntry = null;
    if (this.openai && generated?.response) {
      billingEntry = await this.billingTracker?.recordResponseUsage({
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
    }
    this.logger.info("Saved widget artifact", {
      artifactId: widget.id,
      panelId: panel.id,
      runId: run.id
    }, "widgets");
    return { widget, billingEntry };
  }

  async generateWithOpenAI({ appConfig, domain, panel, run }) {
    this.logger.debug("Requesting OpenAI widget generation", {
      domainId: domain.id,
      panelId: panel.id,
      runId: run.id,
      model: appConfig.codegen?.model ?? "gpt-5.4",
      archetype: run.selectedArchetype ?? null
    }, "widgets");
    const archetype = getArchetypeDefinition(appConfig, run.selectedArchetype);
    const widgetContract = buildArchetypeWidgetContract(appConfig, run.selectedArchetype);
    const panelToolSummary = compactToolSummaryForWidget(buildDeterministicPanelSummary(panel, run.context));
    const compactRun = compactWidgetRun(run);
    const panelToolRegistry = buildPanelToolRegistry(domain, panel);
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
                "Generate a browser widget artifact for a sandboxed iframe. Return JSON only. The widget must not fetch network resources, use eval, or depend on external libraries. It must rely on window.MorphyBridge.onInit, window.MorphyBridge.onUpdate, and window.MorphyBridge.emit. The HTML fragment should be body-safe only, with no script tags. Stay within the selected widget archetype rather than inventing an unrelated layout. Make the widget visually and structurally distinct for the chosen archetype. Use high-contrast text and avoid dark text on dark or saturated backgrounds."
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
              }, null, 2)}\n\nCompact deterministic evidence:\n${JSON.stringify(panelToolSummary, null, 2)}\n\nCompact run summary:\n${JSON.stringify(compactRun, null, 2)}\n\nWidget contract:\n- Render into document.getElementById("app")\n- Use payload.report, payload.context, payload.domain, payload.panel, payload.archetype, and payload.theme at runtime\n- Register both onInit and onUpdate handlers\n- Include the archetype's required sections in some form\n- After rendering, emit widget:resize with a height field`
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
      response
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
      "styles.css": bundle.stylesCss,
      "widget.js": bundle.widgetJs,
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

  async getServedIndexHtml(widgetId) {
    const filePath = await this.getWidgetFilePath(widgetId, "index.html");

    if (!filePath) {
      this.logger.warn("Requested widget HTML for unknown widget", { widgetId }, "widgets");
      return null;
    }

    let html = await fs.readFile(filePath, "utf8");
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
