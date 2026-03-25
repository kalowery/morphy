import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { paths } from "./config-store.js";

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

function buildWidgetPayload(domain, panel, run) {
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
    report: run.report,
    context: run.context,
    theme: {
      accent: domain.color || "#6ee7b7",
      background: "#07111d",
      panel: "#101826"
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

function buildFallbackBundle(domain, panel, run) {
  const accent = domain.color || "#6ee7b7";
  const htmlFragment = `
    <section class="widget-shell">
      <div class="hero-band">
        <p class="eyebrow">${escapeHtml(domain.name)}</p>
        <h1>${escapeHtml(panel.title)}</h1>
        <p class="summary">${escapeHtml(panel.summary)}</p>
      </div>
      <div class="widget-grid">
        <section class="widget-card">
          <p class="eyebrow">Signals</p>
          <div id="metric-tape" class="metric-tape"></div>
        </section>
        <section class="widget-card">
          <p class="eyebrow">Visualization</p>
          <div id="viz-target" class="viz-target"></div>
        </section>
      </div>
      <section class="widget-card">
        <p class="eyebrow">Narrative</p>
        <div id="narrative-target" class="narrative-target"></div>
      </section>
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

    function render(payload) {
      const report = payload?.report ?? {};
      const chart = report.chart ?? {};
      const labels = Array.isArray(chart.labels) ? chart.labels : [];
      const values = Array.isArray(chart.values) ? chart.values : [];
      const max = Math.max(...values, 1);
      const metricTape = root.querySelector("#metric-tape");
      const vizTarget = root.querySelector("#viz-target");
      const narrativeTarget = root.querySelector("#narrative-target");

      metricTape.innerHTML = labels.slice(0, 4).map((label, index) => \`
        <article class="metric">
          <span class="label">\${escapeHtml(label)}</span>
          <span class="value">\${escapeHtml(formatValue(values[index] ?? ""))}</span>
        </article>
      \`).join("");

      vizTarget.innerHTML = labels.length ? \`
        <div class="viz-stack">
          \${labels.map((label, index) => {
            const width = Math.max(6, ((values[index] ?? 0) / max) * 100);
            return \`
              <div class="viz-row">
                <span>\${escapeHtml(label)}</span>
                <div class="bar-track"><div class="bar-fill" style="width: \${width}%"></div></div>
                <strong>\${escapeHtml(formatValue(values[index] ?? 0))}</strong>
              </div>
            \`;
          }).join("")}
        </div>
      \` : '<p class="summary">No numeric chart data is available for this run.</p>';

      narrativeTarget.innerHTML = \`
        \${(report.narrative ?? []).map((entry) => \`<p>\${escapeHtml(entry)}</p>\`).join("")}
        \${(report.highlights ?? []).length ? \`<ul>\${report.highlights.map((entry) => \`<li>\${escapeHtml(entry)}</li>\`).join("")}</ul>\` : ""}
      \`;

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
    const payload = buildWidgetPayload(domain, panel, run);

    const widget = {
      id: artifactId,
      domainId: domain.id,
      panelId: panel.id,
      runId: run.id,
      title: bundle.title,
      summary: bundle.summary,
      sandbox: appConfig.codegen?.sandboxMode ?? "iframe",
      bridgeVersion: "1",
      entrypoint: "index.html",
      files: ["index.html", "styles.css", "widget.js", "manifest.json"],
      generatedAt: new Date().toISOString(),
      provider: this.openai ? `openai:${appConfig.codegen?.model ?? "gpt-5.4"}` : "local-template"
    };

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
      model: appConfig.codegen?.model ?? "gpt-5.4"
    }, "widgets");
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
                "Generate a browser widget artifact for a sandboxed iframe. Return JSON only. The widget must not fetch network resources, use eval, or depend on external libraries. It must rely on window.MorphyBridge.onInit, window.MorphyBridge.onUpdate, and window.MorphyBridge.emit. The HTML fragment should be body-safe only, with no script tags."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Create a polished browser visualization widget for this analytical panel.\n\nDomain:\n${JSON.stringify(domain, null, 2)}\n\nPanel:\n${JSON.stringify(panel, null, 2)}\n\nRun:\n${JSON.stringify({
                id: run.id,
                report: run.report,
                context: run.context
              }, null, 2)}\n\nWidget contract:\n- Render into document.getElementById("app")\n- Use payload.report, payload.context, payload.domain, payload.panel, and payload.theme\n- Register both onInit and onUpdate handlers\n- After rendering, emit widget:resize with a height field`
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

    const payload = JSON.stringify(buildWidgetPayload(domain, panel, run)).replaceAll("</script", "<\\/script");
    const injection = `<script>window.__MORPHY_PAYLOAD__ = ${payload};</script>`;

    if (html.includes('<script src="/runtime/widget-bridge.js"></script>')) {
      return html.replace('<script src="/runtime/widget-bridge.js"></script>', `${injection}\n    <script src="/runtime/widget-bridge.js"></script>`);
    }

    return html.replace("</body>", `    ${injection}\n  </body>`);
  }
}
