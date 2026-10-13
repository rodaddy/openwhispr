const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

/** The GoHighLevel connector's storage: the token in the secret store, links on the notes table. */
class CrmStore {
  constructor({ databaseManager, environmentManager }) {
    this.databaseManager = databaseManager;
    this.environmentManager = environmentManager;
    // The old in-house CRM kept its settings here; GoHighLevel needs none.
    try {
      fs.rmSync(path.join(app.getPath("userData"), "crm-settings.json"), { force: true });
    } catch {
      // A leftover file is harmless; never block startup on it.
    }
  }

  getToken() {
    return this.environmentManager.getGhlToken();
  }

  saveToken(token) {
    return this.environmentManager.saveGhlToken(token);
  }

  _scope(locationId, accountId) {
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify(["ghl", locationId, accountId]))
      .digest("hex");
    return `ghl:${digest}`;
  }

  async captureSyncContext(noteId, locationId) {
    const captured = this.databaseManager.captureCrmNoteContext(noteId);
    if (!captured) return null;
    const speakerMappings = Object.fromEntries(
      (this.databaseManager.getSpeakerMappings?.(noteId) || []).map((row) => [
        row.speaker_id,
        row.display_name || row.speaker_name || row.name,
      ])
    );
    return {
      ...captured,
      note: { ...captured.note, speakerMappings },
      token: String((await this.getToken()) || ""),
      locationId,
      scope: this._scope(locationId, captured.accountId),
    };
  }

  async validateSyncContext(context) {
    if (!this.databaseManager.isCrmNoteContextCurrent(context)) return false;
    return String((await this.getToken()) || "") === context.token;
  }

  getSyncState(noteId, context) {
    return this.databaseManager.getCrmSyncState(noteId, context.scope, context.accountId);
  }

  saveSyncState(noteId, state, context) {
    return this.databaseManager.saveCrmSyncState(noteId, state, context.scope, context.accountId);
  }
}

module.exports = CrmStore;
