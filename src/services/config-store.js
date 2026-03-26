import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listJsonFiles, readJson, writeJson } from "../lib/json-file.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..", "..");

const paths = {
  rootDir,
  appConfig: path.join(rootDir, "config", "app.config.json"),
  dataSources: path.join(rootDir, "config", "data-sources.json"),
  domainsDir: path.join(rootDir, "data", "domains"),
  liveState: path.join(rootDir, "data", "state", "live-state.json"),
  runsDir: path.join(rootDir, "data", "state", "runs"),
  workspacePlans: path.join(rootDir, "data", "state", "workspace-plans.json"),
  sessions: path.join(rootDir, "data", "state", "agent-sessions.json"),
  billingLedger: path.join(rootDir, "data", "state", "billing-ledger.json"),
  widgetsIndex: path.join(rootDir, "data", "state", "widgets", "index.json"),
  widgetBundlesDir: path.join(rootDir, "data", "state", "widget-bundles")
};

export class ConfigStore {
  async getAppConfig() {
    return readJson(paths.appConfig, {});
  }

  async getDataSources() {
    return readJson(paths.dataSources, []);
  }

  async saveDataSources(dataSources) {
    return writeJson(paths.dataSources, dataSources);
  }

  async listDomains() {
    const files = await listJsonFiles(paths.domainsDir);
    const domains = await Promise.all(
      files.map(async (file) => readJson(path.join(paths.domainsDir, file.name), null))
    );

    return domains.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name));
  }

  async getDomain(domainId) {
    return readJson(path.join(paths.domainsDir, `${domainId}.json`), null);
  }

  async saveDomain(domain) {
    return writeJson(path.join(paths.domainsDir, `${domain.id}.json`), domain);
  }

  async deleteDomain(domainId) {
    await fs.rm(path.join(paths.domainsDir, `${domainId}.json`), { force: true });

    const [workspacePlans, liveState, sessions, widgets, runs] = await Promise.all([
      this.getWorkspacePlans(),
      this.getLiveState(),
      this.getSessions(),
      this.getWidgets(),
      this.listRuns()
    ]);

    if (workspacePlans[domainId]) {
      delete workspacePlans[domainId];
      await this.saveWorkspacePlans(workspacePlans);
    }

    if (liveState.domainSnapshots?.[domainId]) {
      delete liveState.domainSnapshots[domainId];
      liveState.updatedAt = new Date().toISOString();
      await this.saveLiveState(liveState);
    }

    if (sessions[domainId]) {
      delete sessions[domainId];
      await this.saveSessions(sessions);
    }

    const widgetsToDelete = widgets.filter((widget) => widget.domainId === domainId);
    if (widgetsToDelete.length) {
      const nextWidgets = widgets.filter((widget) => widget.domainId !== domainId);
      await this.saveWidgets(nextWidgets);
      await Promise.all(
        widgetsToDelete.map((widget) =>
          fs.rm(path.join(paths.widgetBundlesDir, widget.id), { recursive: true, force: true })
        )
      );
    }

    const runsToDelete = runs.filter((run) => run.domainId === domainId);
    if (runsToDelete.length) {
      await Promise.all(
        runsToDelete.map((run) =>
          fs.rm(path.join(paths.runsDir, `${run.id}.json`), { force: true })
        )
      );
    }
  }

  async getLiveState() {
    return readJson(paths.liveState, {
      updatedAt: null,
      sourcePreviews: [],
      domainSnapshots: {}
    });
  }

  async saveLiveState(liveState) {
    return writeJson(paths.liveState, liveState);
  }

  async getSessions() {
    return readJson(paths.sessions, {});
  }

  async saveSessions(sessions) {
    return writeJson(paths.sessions, sessions);
  }

  async getBillingLedger() {
    return readJson(paths.billingLedger, {
      updatedAt: null,
      entries: []
    });
  }

  async saveBillingLedger(billingLedger) {
    return writeJson(paths.billingLedger, billingLedger);
  }

  async saveRun(run) {
    return writeJson(path.join(paths.runsDir, `${run.id}.json`), run);
  }

  async getRun(runId) {
    return readJson(path.join(paths.runsDir, `${runId}.json`), null);
  }

  async listRuns() {
    const files = await listJsonFiles(paths.runsDir);
    const runs = await Promise.all(
      files.map(async (file) => readJson(path.join(paths.runsDir, file.name), null))
    );

    return runs
      .filter(Boolean)
      .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
  }

  async getWorkspacePlans() {
    return readJson(paths.workspacePlans, {});
  }

  async saveWorkspacePlans(workspacePlans) {
    return writeJson(paths.workspacePlans, workspacePlans);
  }

  async getWorkspacePlan(domainId) {
    const workspacePlans = await this.getWorkspacePlans();
    return workspacePlans[domainId] ?? null;
  }

  async saveWorkspacePlan(domainId, workspacePlan) {
    const workspacePlans = await this.getWorkspacePlans();
    workspacePlans[domainId] = workspacePlan;
    await this.saveWorkspacePlans(workspacePlans);
    return workspacePlan;
  }

  async getWidgets() {
    return readJson(paths.widgetsIndex, []);
  }

  async saveWidgets(widgets) {
    return writeJson(paths.widgetsIndex, widgets);
  }

  async listWidgets() {
    const widgets = await this.getWidgets();
    return widgets.sort((left, right) => new Date(right.generatedAt) - new Date(left.generatedAt));
  }

  async getWidget(widgetId) {
    const widgets = await this.getWidgets();
    return widgets.find((widget) => widget.id === widgetId) ?? null;
  }

  async getLatestWidgetForPanel(domainId, panelId) {
    const widgets = await this.listWidgets();
    return widgets.find((widget) => widget.domainId === domainId && widget.panelId === panelId) ?? null;
  }

  async saveWidget(widget) {
    const widgets = await this.getWidgets();
    const next = widgets.filter((entry) => entry.id !== widget.id);
    next.push(widget);
    await this.saveWidgets(next);
    return widget;
  }
}

export { paths };
