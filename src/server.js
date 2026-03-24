import express from "express";
import EventEmitter from "node:events";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./services/config-store.js";
import { previewSource } from "./services/data-sources.js";
import { AgentRuntime } from "./services/agent-runtime.js";
import { WidgetService } from "./services/widget-service.js";
import { RefreshCoordinator } from "./services/refresh-coordinator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();
  const eventBus = new EventEmitter();
  const configStore = new ConfigStore();
  const widgetService = new WidgetService({ configStore });
  const agentRuntime = new AgentRuntime({ configStore, eventBus, widgetService });
  const refreshCoordinator = new RefreshCoordinator({ configStore, agentRuntime, eventBus });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/bootstrap", async (_request, response, next) => {
    try {
      const [appConfig, dataSources, domains, runs, widgets, workspacePlans, liveState] = await Promise.all([
        configStore.getAppConfig(),
        configStore.getDataSources(),
        configStore.listDomains(),
        configStore.listRuns(),
        configStore.listWidgets(),
        configStore.getWorkspacePlans(),
        configStore.getLiveState()
      ]);

      const sourcePreviews = liveState.sourcePreviews?.length
        ? liveState.sourcePreviews
        : await Promise.all(dataSources.map((source) => previewSource(source)));
      const snapshotRunIds = new Set(
        Object.values(liveState.domainSnapshots ?? {})
          .flatMap((snapshot) => Object.values(snapshot?.panelStatus ?? {}))
          .map((status) => status?.runId)
          .filter(Boolean)
      );
      const recentRuns = runs.filter((run, index) => index < 12 || snapshotRunIds.has(run.id));

      void agentRuntime.reconcileRecentRuns(recentRuns);

      response.json({
        appConfig,
        domains,
        dataSources,
        sourcePreviews,
        runs: recentRuns,
        widgets: widgets.slice(0, 24),
        workspacePlans,
        domainSnapshots: liveState.domainSnapshots ?? {},
        liveStateUpdatedAt: liveState.updatedAt ?? null,
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
      response.status(201).json(domain);
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

      const widget = await widgetService.generateForRun({ domain, panel, run });
      run.widgetId = widget.id;
      run.widgetUrl = `/generated/widgets/${widget.id}`;
      run.updatedAt = new Date().toISOString();
      await configStore.saveRun(run);
      eventBus.emit("run.update", run);
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

    const heartbeat = setInterval(() => {
      response.write("event: heartbeat\n");
      response.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 15000);

    eventBus.on("run.update", onRunUpdate);
    eventBus.on("workspace.update", onWorkspaceUpdate);
    eventBus.on("domain.refresh", onDomainRefresh);

    request.on("close", () => {
      clearInterval(heartbeat);
      eventBus.off("run.update", onRunUpdate);
      eventBus.off("workspace.update", onWorkspaceUpdate);
      eventBus.off("domain.refresh", onDomainRefresh);
    });
  });

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({
      error: error.message ?? "Unexpected server error."
    });
  });

  app.locals.refreshCoordinator = refreshCoordinator;
  return app;
}

export async function startServer(
  port = Number(process.env.PORT ?? process.env.APP_PORT ?? 3000),
  host = process.env.HOST ?? "127.0.0.1"
) {
  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });

  await app.locals.refreshCoordinator?.start();

  return { app, server };
}

if (process.argv[1] === __filename) {
  const port = Number(process.env.PORT ?? process.env.APP_PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const { server } = await startServer(port, host);
  console.log(`Morphy listening on http://${host}:${server.address().port}`);
}
