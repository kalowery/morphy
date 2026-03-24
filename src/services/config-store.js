import path from "node:path";
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
  runsDir: path.join(rootDir, "data", "state", "runs"),
  sessions: path.join(rootDir, "data", "state", "agent-sessions.json"),
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

  async getSessions() {
    return readJson(paths.sessions, {});
  }

  async saveSessions(sessions) {
    return writeJson(paths.sessions, sessions);
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
