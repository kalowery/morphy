import { gatherDomainContext, previewSource } from "./data-sources.js";

function getAgeMs(value) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }

  return Date.now() - new Date(value).getTime();
}

function summarizeDomainRuns(runs, domain) {
  return Object.fromEntries(
    domain.panels.map((panel) => {
      const latest = runs.find((run) => run.domainId === domain.id && run.panelId === panel.id) ?? null;
      return [
        panel.id,
        latest
          ? {
              runId: latest.id,
              status: latest.status,
              updatedAt: latest.updatedAt,
              hasReport: Boolean(latest.report),
              widgetId: latest.widgetId ?? null
            }
          : {
              runId: null,
              status: "missing",
              updatedAt: null,
              hasReport: false,
              widgetId: null
            }
      ];
    })
  );
}

export class RefreshCoordinator {
  constructor({ configStore, agentRuntime, eventBus }) {
    this.configStore = configStore;
    this.agentRuntime = agentRuntime;
    this.eventBus = eventBus;
    this.intervalId = null;
    this.domainRefreshes = new Map();
  }

  async start() {
    const appConfig = await this.configStore.getAppConfig();
    const tickMs = appConfig.refresh?.schedulerTickMs ?? 60000;

    await this.refreshAllDomains({ reason: "startup" });
    this.intervalId = setInterval(() => {
      void this.refreshAllDomains({ reason: "tick" }).catch((error) => {
        console.error("Refresh coordinator tick failed", error);
      });
    }, tickMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async refreshAllDomains({ reason = "tick" } = {}) {
    const domains = await this.configStore.listDomains();
    await Promise.allSettled(domains.map((domain) => this.refreshDomain(domain.id, { reason })));
  }

  async refreshDomain(domainId, { reason = "manual", force = false } = {}) {
    const active = this.domainRefreshes.get(domainId);
    if (active) {
      return active;
    }

    const work = this.performDomainRefresh(domainId, { reason, force }).finally(() => {
      this.domainRefreshes.delete(domainId);
    });
    this.domainRefreshes.set(domainId, work);
    return work;
  }

  async performDomainRefresh(domainId, { reason, force }) {
    const [appConfig, domain, dataSources, liveState, runs] = await Promise.all([
      this.configStore.getAppConfig(),
      this.configStore.getDomain(domainId),
      this.configStore.getDataSources(),
      this.configStore.getLiveState(),
      this.configStore.listRuns()
    ]);

    if (!domain) {
      return null;
    }

    const sourcePreviewTtlMs = appConfig.refresh?.sourcePreviewTtlMs ?? 60000;
    const workspacePlanTtlMs = appConfig.refresh?.workspacePlanTtlMs ?? 300000;
    const analysisTtlMs = appConfig.refresh?.analysisTtlMs ?? 300000;
    const panelsPerSweep = appConfig.refresh?.panelsPerSweep ?? Math.max(1, domain.panels.length);
    const sourcePreviews =
      !force && Array.isArray(liveState.sourcePreviews) && liveState.sourcePreviews.length && getAgeMs(liveState.updatedAt) < sourcePreviewTtlMs
        ? liveState.sourcePreviews
        : await Promise.all(dataSources.map((source) => previewSource(source)));

    const applicablePreviews = sourcePreviews.filter((preview) => domain.dataSources.includes(preview.sourceId));
    const context = {
      domainId: domain.id,
      domainName: domain.name,
      previewCount: applicablePreviews.length,
      previews: applicablePreviews
    };

    const existingPlan = await this.configStore.getWorkspacePlan(domainId);
    const workspacePlan =
      force || !existingPlan || getAgeMs(existingPlan.updatedAt) >= workspacePlanTtlMs
        ? await this.agentRuntime.planWorkspace({
            domainId,
            preferredPanelId: existingPlan?.focusPanelId ?? null,
            reason,
            contextOverride: context
          })
        : existingPlan;

    const orderedPanelIds = [
      ...(workspacePlan?.visiblePanelIds ?? []),
      ...domain.panels.map((panel) => panel.id)
    ].filter((panelId, index, values) => values.indexOf(panelId) === index);

    const targetPanelIds = orderedPanelIds.slice(0, Math.min(panelsPerSweep, orderedPanelIds.length));
    await Promise.allSettled(
      targetPanelIds.map((panelId) =>
        this.agentRuntime.ensurePanelRun({
          domainId,
          panelId,
          force,
          freshnessMs: analysisTtlMs,
          contextOverride: context,
          workspacePlanOverride: workspacePlan,
          trigger: "scheduled"
        })
      )
    );

    const latestRuns = await this.configStore.listRuns();
    const nextLiveState = await this.configStore.getLiveState();
    nextLiveState.updatedAt = new Date().toISOString();
    nextLiveState.sourcePreviews = sourcePreviews;
    nextLiveState.domainSnapshots = {
      ...(nextLiveState.domainSnapshots ?? {}),
      [domainId]: {
        domainId,
        domainName: domain.name,
        updatedAt: new Date().toISOString(),
        reason,
        context,
        workspacePlan,
        panelStatus: summarizeDomainRuns(latestRuns, domain)
      }
    };

    await this.configStore.saveLiveState(nextLiveState);
    this.eventBus.emit("domain.refresh", nextLiveState.domainSnapshots[domainId]);
    return nextLiveState.domainSnapshots[domainId];
  }
}
