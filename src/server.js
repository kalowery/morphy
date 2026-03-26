import express from "express";
import EventEmitter from "node:events";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./services/config-store.js";
import { gatherDomainContext, previewSource } from "./services/data-sources.js";
import { AgentRuntime } from "./services/agent-runtime.js";
import { WidgetService } from "./services/widget-service.js";
import { RefreshCoordinator } from "./services/refresh-coordinator.js";
import { buildServerDiagnostics, createLogger } from "./lib/logger.js";
import { BillingTracker } from "./lib/billing.js";
import {
  buildDomainToolRegistry,
  buildPanelInteractionState,
  getInteractionDateRangeOverrides
} from "./services/analysis-tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createApp() {
  const app = express();
  const eventBus = new EventEmitter();
  const configStore = new ConfigStore();
  const appConfig = await configStore.getAppConfig();
  const diagnostics = buildServerDiagnostics(appConfig);
  const logger = createLogger({ namespace: "server", diagnostics });
  const billingTracker = new BillingTracker({ configStore, eventBus, logger });
  await billingTracker.repairLedgerCosts();
  const widgetService = new WidgetService({ configStore, logger, billingTracker });
  const agentRuntime = new AgentRuntime({ configStore, eventBus, widgetService, logger, billingTracker });
  const refreshCoordinator = new RefreshCoordinator({ configStore, agentRuntime, eventBus, logger });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/favicon.ico", (_request, response) => {
    response.status(204).end();
  });

  app.post("/api/spend/reset", async (_request, response, next) => {
    try {
      const spendSummary = await billingTracker.resetLedger();
      logger.info("Spend reset via API", {}, "billing");
      response.json(spendSummary);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/bootstrap", async (_request, response, next) => {
    try {
      logger.debug("Handling bootstrap request", {}, "server");
      const [appConfig, dataSources, domains, runs, widgets, workspacePlans, liveState, spendSummary] = await Promise.all([
        configStore.getAppConfig(),
        configStore.getDataSources(),
        configStore.listDomains(),
        configStore.listRuns(),
        configStore.listWidgets(),
        configStore.getWorkspacePlans(),
        configStore.getLiveState(),
        billingTracker.getSummary()
      ]);

      const sourcePreviews = liveState.sourcePreviews?.length
        ? liveState.sourcePreviews
        : await Promise.all(dataSources.map((source) => previewSource(source, { logger })));
      const derivedToolRegistries = Object.fromEntries(
        domains.map((domain) => [domain.id, buildDomainToolRegistry(domain)])
      );
      const snapshotRunIds = new Set(
        Object.values(liveState.domainSnapshots ?? {})
          .flatMap((snapshot) => Object.values(snapshot?.panelStatus ?? {}))
          .map((status) => status?.runId)
          .filter(Boolean)
      );
      const latestWidgetRunIds = new Set();
      const latestWidgetRunsByPanel = new Map();

      for (const run of runs) {
        if (!run.widgetId) {
          continue;
        }

        const key = `${run.domainId}:${run.panelId}`;
        if (!latestWidgetRunsByPanel.has(key)) {
          latestWidgetRunsByPanel.set(key, run);
          latestWidgetRunIds.add(run.id);
        }
      }

      const recentRuns = runs.filter((run, index) => index < 12 || snapshotRunIds.has(run.id) || latestWidgetRunIds.has(run.id));

      void agentRuntime.reconcileRecentRuns(recentRuns);
      logger.info("Bootstrap payload prepared", {
        domainCount: domains.length,
        runCount: recentRuns.length,
        widgetCount: widgets.length,
        sourcePreviewCount: sourcePreviews.length
      }, "server");

      response.json({
        appConfig,
        domains,
        dataSources,
        sourcePreviews,
        runs: recentRuns,
        widgets: widgets.slice(0, 24),
        workspacePlans,
        derivedToolRegistries,
        domainSnapshots: liveState.domainSnapshots ?? {},
        liveStateUpdatedAt: liveState.updatedAt ?? null,
        spendSummary,
        agent: {
          mode: process.env.OPENAI_API_KEY ? "openai-responses" : "fallback",
          hasApiKey: Boolean(process.env.OPENAI_API_KEY)
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/data-sources", async (request, response, next) => {
    try {
      const current = await configStore.getDataSources();
      const source = request.body;

      if (!source?.id || !source?.name || !source?.type) {
        response.status(400).json({ error: "id, name, and type are required." });
        return;
      }

      const nextSources = current.filter((entry) => entry.id !== source.id);
      nextSources.push(source);
      await configStore.saveDataSources(nextSources);
      logger.info("Saved data source", {
        sourceId: source.id,
        sourceType: source.type
      }, "server");
      response.status(201).json(source);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/domains/generate", async (request, response, next) => {
    try {
      const prompt = request.body?.prompt?.trim();

      if (!prompt) {
        response.status(400).json({ error: "prompt is required." });
        return;
      }

      const domain = await agentRuntime.generateDomain(prompt);
      const derivedToolRegistry = buildDomainToolRegistry(domain);
      logger.info("Domain generated via API", {
        domainId: domain.id,
        panelCount: domain.panels.length
      }, "server");
      response.status(201).json({
        domain,
        derivedToolRegistry
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/domains/:domainId", async (request, response, next) => {
    try {
      const domainId = request.params.domainId;
      const domain = await configStore.getDomain(domainId);

      if (!domain) {
        response.status(404).json({ error: "Domain not found." });
        return;
      }

      await configStore.deleteDomain(domainId);
      logger.info("Domain deleted via API", {
        domainId
      }, "server");
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/analysis/run", async (request, response, next) => {
    try {
      const { domainId, panelId, force = false } = request.body ?? {};

      if (!domainId || !panelId) {
        response.status(400).json({ error: "domainId and panelId are required." });
        return;
      }

      const appConfig = await configStore.getAppConfig();
      logger.info("Analysis run requested", {
        domainId,
        panelId,
        force
      }, "server");
      const run = await agentRuntime.ensurePanelRun({
        domainId,
        panelId,
        force,
        freshnessMs: appConfig.refresh?.analysisTtlMs ?? 300000,
        trigger: force ? "manual-force" : "manual"
      });
      response.status(202).json(run);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/refresh/domain", async (request, response, next) => {
    try {
      const { domainId, force = false } = request.body ?? {};

      if (!domainId) {
        response.status(400).json({ error: "domainId is required." });
        return;
      }

      logger.info("Domain refresh requested", {
        domainId,
        force
      }, "server");
      const snapshot = await refreshCoordinator.refreshDomain(domainId, {
        reason: force ? "manual-force" : "manual-refresh",
        force
      });
      response.status(202).json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workspace/plan", async (request, response, next) => {
    try {
      const { domainId, preferredPanelId, reason } = request.body ?? {};

      if (!domainId) {
        response.status(400).json({ error: "domainId is required." });
        return;
      }

      logger.info("Workspace plan requested", {
        domainId,
        preferredPanelId: preferredPanelId ?? null,
        reason: reason ?? "manual-refresh"
      }, "server");
      const workspacePlan = await agentRuntime.planWorkspace({
        domainId,
        preferredPanelId: preferredPanelId ?? null,
        reason: reason ?? "manual-refresh"
      });

      response.status(201).json(workspacePlan);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/:runId", async (request, response, next) => {
    try {
      logger.debug("Analysis status requested", { runId: request.params.runId }, "server");
      const run = await agentRuntime.syncRun(request.params.runId);

      if (!run) {
        response.status(404).json({ error: "Run not found." });
        return;
      }

      response.json(run);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/panels/:domainId/:panelId/interaction", async (request, response, next) => {
    try {
      const [domain, dataSources] = await Promise.all([
        configStore.getDomain(request.params.domainId),
        configStore.getDataSources()
      ]);

      if (!domain) {
        response.status(404).json({ error: "Domain not found." });
        return;
      }

      const panel = domain.panels.find((entry) => entry.id === request.params.panelId);
      if (!panel) {
        response.status(404).json({ error: "Panel not found." });
        return;
      }

      const context = await gatherDomainContext(domain, dataSources, { logger });
      response.json({
        domainId: domain.id,
        panelId: panel.id,
        interaction: buildPanelInteractionState(panel, context)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/panels/:domainId/:panelId/interaction/data", async (request, response, next) => {
    try {
      const params = request.body?.params ?? {};
      const [domain, dataSources] = await Promise.all([
        configStore.getDomain(request.params.domainId),
        configStore.getDataSources()
      ]);

      if (!domain) {
        response.status(404).json({ error: "Domain not found." });
        return;
      }

      const panel = domain.panels.find((entry) => entry.id === request.params.panelId);
      if (!panel) {
        response.status(404).json({ error: "Panel not found." });
        return;
      }

      const baseContext = await gatherDomainContext(domain, dataSources, { logger });
      const sourceOverrides = {};
      for (const sourceId of domain.dataSources) {
        const override = getInteractionDateRangeOverrides(panel, params, baseContext);
        if (Object.keys(override).length) {
          sourceOverrides[sourceId] = override;
        }
      }

      const context = Object.keys(sourceOverrides).length
        ? await gatherDomainContext(domain, dataSources, { logger, sourceOverrides })
        : baseContext;
      response.json({
        domainId: domain.id,
        panelId: panel.id,
        params,
        interaction: buildPanelInteractionState(panel, context, params)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/panels/:domainId/:panelId/interaction/reinterpret", async (request, response, next) => {
    try {
      const params = request.body?.params ?? {};
      const runId = request.body?.runId ?? null;
      const [domain, dataSources] = await Promise.all([
        configStore.getDomain(request.params.domainId),
        configStore.getDataSources()
      ]);

      if (!domain) {
        response.status(404).json({ error: "Domain not found." });
        return;
      }

      const panel = domain.panels.find((entry) => entry.id === request.params.panelId);
      if (!panel) {
        response.status(404).json({ error: "Panel not found." });
        return;
      }

      const baseContext = await gatherDomainContext(domain, dataSources, { logger });
      const sourceOverrides = {};
      for (const sourceId of domain.dataSources) {
        const override = getInteractionDateRangeOverrides(panel, params, baseContext);
        if (Object.keys(override).length) {
          sourceOverrides[sourceId] = override;
        }
      }

      const context = Object.keys(sourceOverrides).length
        ? await gatherDomainContext(domain, dataSources, { logger, sourceOverrides })
        : baseContext;
      const interaction = buildPanelInteractionState(panel, context, params);
      const reinterpretation = await agentRuntime.reinterpretFilteredPanel({
        domain,
        panel,
        context,
        interaction,
        runId
      });

      interaction.data.report = reinterpretation.report;
      interaction.data.chart = reinterpretation.report?.chart ?? interaction.data.chart ?? null;
      interaction.summary = reinterpretation.report?.narrative?.[0] ?? interaction.summary;

      response.json({
        domainId: domain.id,
        panelId: panel.id,
        params: interaction.params,
        interaction,
        report: reinterpretation.report,
        usage: reinterpretation.billingEntry?.usage ?? null,
        cost: reinterpretation.billingEntry?.cost ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/widgets/generate", async (request, response, next) => {
    try {
      const { domainId, panelId, runId } = request.body ?? {};
      const [domain, runs] = await Promise.all([
        configStore.getDomain(domainId),
        configStore.listRuns()
      ]);

      if (!domain) {
        response.status(404).json({ error: "Domain not found." });
        return;
      }

      const panel = domain.panels.find((entry) => entry.id === panelId);

      if (!panel) {
        response.status(404).json({ error: "Panel not found." });
        return;
      }

      const run =
        runs.find((entry) => entry.id === runId) ??
        runs.find((entry) => entry.domainId === domainId && entry.panelId === panelId && entry.report);

      if (!run?.report) {
        response.status(400).json({ error: "A completed analysis run is required before generating a widget." });
        return;
      }

      run.widgetStatus = "in_progress";
      run.widgetError = null;
      run.updatedAt = new Date().toISOString();
      await configStore.saveRun(run);
      eventBus.emit("run.update", run);

      const {
        widget,
        billingEntries = [],
        toolMode = null,
        toolTrace = [],
        toolDecision = null
      } = await widgetService.generateForRun({ domain, panel, run });
      run.widgetId = widget.id;
      run.widgetUrl = `/generated/widgets/${widget.id}`;
      run.widgetGeneratedAt = widget.generatedAt ?? new Date().toISOString();
      run.widgetStatus = "completed";
      run.widgetToolMode = toolMode;
      run.widgetToolTrace = toolTrace;
      run.widgetToolDecision = toolDecision;
      if (billingEntries.length) {
        const widgetEntryIds = billingEntries.map((entry) => entry.id).filter(Boolean);
        const finalWidgetEntry = billingEntries[billingEntries.length - 1];
        const widgetTotalUsd = billingEntries.reduce((sum, entry) => sum + Number(entry.cost?.totalUsd ?? 0), 0);
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
      run.updatedAt = new Date().toISOString();
      await configStore.saveRun(run);
      eventBus.emit("run.update", run);
      logger.info("Widget generated via API", {
        domainId,
        panelId,
        runId: run.id,
        widgetId: widget.id
      }, "server");
      response.status(201).json(widget);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/widgets/:widgetId", async (request, response, next) => {
    try {
      const widget = await configStore.getWidget(request.params.widgetId);

      if (!widget) {
        response.status(404).json({ error: "Widget not found." });
        return;
      }

      response.json(widget);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/widgets/panel/:domainId/:panelId", async (request, response, next) => {
    try {
      const widget = await configStore.getLatestWidgetForPanel(request.params.domainId, request.params.panelId);

      if (!widget) {
        response.status(404).json({ error: "Widget not found." });
        return;
      }

      response.json(widget);
    } catch (error) {
      next(error);
    }
  });

  app.get("/generated/widgets/:widgetId", async (request, response, next) => {
    try {
      logger.debug("Serving generated widget HTML", { widgetId: request.params.widgetId }, "widgets");
      const html = await widgetService.getServedIndexHtml(request.params.widgetId);

      if (!html) {
        response.status(404).send("Widget not found.");
        return;
      }

      response.type("html").send(html);
    } catch (error) {
      next(error);
    }
  });

  app.get("/generated/widgets/:widgetId/files/:fileName", async (request, response, next) => {
    try {
      logger.debug("Serving generated widget asset", {
        widgetId: request.params.widgetId,
        fileName: request.params.fileName
      }, "widgets");
      const servedAsset = await widgetService.getServedWidgetAsset(request.params.widgetId, request.params.fileName);

      if (servedAsset != null) {
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.type(request.params.fileName.endsWith(".js") ? "application/javascript" : "text/css").send(servedAsset);
        return;
      }

      const filePath = await widgetService.getWidgetFilePath(request.params.widgetId, request.params.fileName);

      if (!filePath) {
        response.status(404).send("Widget file not found.");
        return;
      }

      response.setHeader("Access-Control-Allow-Origin", "*");
      response.sendFile(filePath);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/events", (request, response) => {
    logger.debug("SSE client connected", {}, "events");
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const onRunUpdate = (run) => {
      response.write(`event: run.update\n`);
      response.write(`data: ${JSON.stringify(run)}\n\n`);
    };

    const onWorkspaceUpdate = (workspacePlan) => {
      response.write(`event: workspace.update\n`);
      response.write(`data: ${JSON.stringify(workspacePlan)}\n\n`);
    };

    const onDomainRefresh = (snapshot) => {
      response.write(`event: domain.refresh\n`);
      response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    };

    const onSpendUpdate = (spendSummary) => {
      response.write(`event: spend.update\n`);
      response.write(`data: ${JSON.stringify(spendSummary)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      response.write("event: heartbeat\n");
      response.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 15000);

    eventBus.on("run.update", onRunUpdate);
    eventBus.on("workspace.update", onWorkspaceUpdate);
    eventBus.on("domain.refresh", onDomainRefresh);
    eventBus.on("spend.update", onSpendUpdate);

    request.on("close", () => {
      logger.debug("SSE client disconnected", {}, "events");
      clearInterval(heartbeat);
      eventBus.off("run.update", onRunUpdate);
      eventBus.off("workspace.update", onWorkspaceUpdate);
      eventBus.off("domain.refresh", onDomainRefresh);
      eventBus.off("spend.update", onSpendUpdate);
    });
  });

  app.use((error, _request, response, _next) => {
    logger.error("Unhandled server error", {
      error: error.message,
      stack: error.stack
    }, "server");
    response.status(500).json({
      error: error.message ?? "Unexpected server error."
    });
  });

  app.locals.logger = logger;
  app.locals.refreshCoordinator = refreshCoordinator;
  return app;
}

export async function startServer(
  port = Number(process.env.PORT ?? process.env.APP_PORT ?? 3000),
  host = process.env.HOST ?? "127.0.0.1"
) {
  const app = await createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });

  await app.locals.refreshCoordinator?.start();
  app.locals.logger?.info("Morphy server started", { host, port }, "server");

  return { app, server };
}

if (process.argv[1] === __filename) {
  const port = Number(process.env.PORT ?? process.env.APP_PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const { server } = await startServer(port, host);
  console.log(`Morphy listening on http://${host}:${server.address().port}`);
}
