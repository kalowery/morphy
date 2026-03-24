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
      model: appConfig.agent?.model ?? "gpt-5.2",
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

  async runAnalysis({ domainId, panelId }) {
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

    const context = await gatherDomainContext(domain, dataSources);
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
      model: appConfig.agent?.model ?? "gpt-5.2",
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
              text: `Domain:\n${JSON.stringify(domain, null, 2)}\n\nPanel:\n${JSON.stringify(panel, null, 2)}\n\nCurrent source preview context:\n${JSON.stringify(context, null, 2)}\n\nTask:\n${panel.analysisPrompt}`
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
