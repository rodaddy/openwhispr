// Storage for the pipeline connector: the base URL in
// userData/pipeline-settings.json, the bearer token through the environment
// manager's secret store (never a plain file), and grill sync state on notes.
const fs = require("fs/promises");
const path = require("path");
const { app } = require("electron");

class PipelineStore {
  constructor({ databaseManager, environmentManager }) {
    this.databaseManager = databaseManager;
    this.environmentManager = environmentManager;
    this.settingsPath = path.join(app.getPath("userData"), "pipeline-settings.json");
    this.writeQueue = Promise.resolve();
  }

  async getSettings() {
    try {
      const value = JSON.parse(await fs.readFile(this.settingsPath, "utf8"));
      return { baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "" };
    } catch {
      return { baseUrl: "" };
    }
  }

  async saveSettings(settings) {
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
        const temp = `${this.settingsPath}.tmp`;
        const data = { baseUrl: String(settings.baseUrl || "") };
        await fs.writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
        await fs.rename(temp, this.settingsPath);
      });
    return this.writeQueue;
  }

  getToken() {
    return this.environmentManager.getPipelineToken();
  }

  saveToken(token) {
    return this.environmentManager.savePipelineToken(token);
  }

  getNote(id) {
    return this.databaseManager.getPipelineNote(id);
  }

  saveGrillMeta(id, meta) {
    return this.databaseManager.saveGrillMeta(id, meta);
  }

  getSyncState(id) {
    return this.databaseManager.getPipelineSyncState(id);
  }

  saveSyncState(id, state) {
    return this.databaseManager.savePipelineSyncState(id, state);
  }

  listPendingNoteIds() {
    return this.databaseManager.listPipelinePendingNoteIds();
  }
}

module.exports = PipelineStore;
