import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { paths } from "./config-store.js";
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
    if (preview?.detail?.queryWindow) {
      return preview.detail.queryWindow;
    }
  }

  return null;
}

function buildWidgetPayload(domain, panel, run, widget = null) {
  const queryWindow = firstQueryWindow(run.context);
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
    report: run.report,
    context: run.context,
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
      }
      html, body {
        background: var(--morphy-bg);
        color: var(--morphy-text);
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
      #app a {
        color: #9be7ff;
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
  constructor({ configStore, logger }) {
    this.configStore = configStore;
    this.logger = logger ?? {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {}
    };
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
    const bundle = this.openai
      ? await this.generateWithOpenAI({ appConfig, domain, panel, run })
      : buildFallbackBundle(domain, panel, run);
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
    this.logger.info("Saved widget artifact", {
      artifactId: widget.id,
      panelId: panel.id,
      runId: run.id
    }, "widgets");
    return widget;
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
              text: `Create a polished browser visualization widget for this analytical panel.\n\nDomain:\n${JSON.stringify(domain, null, 2)}\n\nPanel:\n${JSON.stringify(panel, null, 2)}\n\nSelected archetype:\n${JSON.stringify({
                id: run.selectedArchetype,
                title: run.archetypeTitle,
                reason: run.archetypeReason,
                confidence: run.archetypeConfidence,
                definition: archetype
              }, null, 2)}\n\nArchetype widget contract:\n${JSON.stringify(widgetContract, null, 2)}\n\nRun:\n${JSON.stringify({
                id: run.id,
                report: run.report,
                context: run.context
              }, null, 2)}\n\nWidget contract:\n- Render into document.getElementById("app")\n- Use payload.report, payload.context, payload.domain, payload.panel, payload.archetype, and payload.theme\n- Register both onInit and onUpdate handlers\n- Include the archetype's required sections in some form\n- After rendering, emit widget:resize with a height field`
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

    return parseArtifactResponse(response);
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

    if (html.includes("window.__MORPHY_PAYLOAD__")) {
      this.logger.trace("Widget HTML already contains payload", { widgetId }, "widgets");
      return html;
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

    if (html.includes('<script src="/runtime/widget-bridge.js"></script>')) {
      return html.replace('<script src="/runtime/widget-bridge.js"></script>', `${injection}\n    <script src="/runtime/widget-bridge.js"></script>`);
    }

    return html.replace("</body>", `    ${injection}\n  </body>`);
  }
}
