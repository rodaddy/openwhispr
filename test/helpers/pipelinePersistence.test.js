const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const fixtureRoot = path.join(require("node:os").tmpdir(), "openwhispr-pipeline-verification");
fs.mkdirSync(fixtureRoot, { recursive: true });
let userDataDir = fs.mkdtempSync(path.join(fixtureRoot, "persistence-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database.js");
const PipelineStore = require("../../src/helpers/pipelineStore.js");
Module._load = originalLoad;

function openDatabase(t) {
  try {
    return new DatabaseManager();
  } catch (error) {
    const message = String(error?.message || error);
    if (
      message.includes("NODE_MODULE_VERSION") ||
      message.includes("Could not locate the bindings")
    ) {
      t.skip("better-sqlite3 native binding is unavailable for this Node runtime");
      return null;
    }
    throw error;
  }
}

function insertGrillNote(manager, { accountId = "account-a", deleted = false } = {}) {
  const space = manager.db
    .prepare("INSERT INTO spaces (name, kind) VALUES (?, 'private')")
    .run(`Private ${accountId}-${Math.random()}`);
  return Number(
    manager.db
      .prepare(
        `INSERT INTO notes (title, content, note_type, space_id, account_id, deleted_at, transcript)
         VALUES ('Grill 2026-09-27', 'Q', 'personal', ?, ?, ?, ?)`
      )
      .run(
        space.lastInsertRowid,
        accountId,
        deleted ? new Date().toISOString() : null,
        JSON.stringify([
          { role: "assistant", text: "Q?", source: "system" },
          { role: "user", text: "A.", source: "mic" },
        ])
      ).lastInsertRowid
  );
}

const META = {
  kind: "daily",
  chapter: null,
  startedAt: "2026-09-27T14:00:05.000Z",
  endedAt: "2026-09-27T14:13:40.000Z",
};

test("pipeline sync state migrates onto notes and survives a reopen", (t) => {
  userDataDir = fs.mkdtempSync(path.join(fixtureRoot, "persistence-"));
  let manager = openDatabase(t);
  if (!manager) return;
  const columns = manager.db
    .prepare("PRAGMA table_info(notes)")
    .all()
    .map((row) => row.name);
  for (const column of [
    "grill_meta",
    "pipeline_synced_at",
    "pipeline_last_error",
    "pipeline_pieces_added",
    "pipeline_not_sendable",
  ]) {
    assert.ok(columns.includes(column), `migration adds ${column}`);
  }

  manager.setActiveAccountId("account-a");
  const id = insertGrillNote(manager);
  const other = insertGrillNote(manager);
  const deleted = insertGrillNote(manager, { deleted: true });
  const plain = insertGrillNote(manager);
  manager.db
    .prepare("UPDATE notes SET transcript = NULL, title = ? WHERE id = ?")
    .run("Standup", plain);

  manager.saveGrillMeta(id, META);
  manager.saveGrillMeta(other, META);
  assert.throws(() => manager.saveGrillMeta(deleted, META), /Note not found/);
  assert.deepEqual(manager.listPipelinePendingNoteIds(), [id, other]);

  // A note that cannot be sent leaves the pending list until it is saved again.
  manager.savePipelineSyncState(other, { lastError: "NO_TURNS: none", notSendable: true });
  assert.equal(manager.getPipelineSyncState(other).notSendable, true);
  assert.deepEqual(manager.listPipelinePendingNoteIds(), [id]);
  manager.saveGrillMeta(other, META);
  assert.equal(manager.getPipelineSyncState(other).notSendable, false);
  assert.deepEqual(manager.listPipelinePendingNoteIds(), [id, other]);

  manager.savePipelineSyncState(id, { lastError: "UPSTREAM_FAILED (502)" });
  assert.deepEqual(manager.getPipelineSyncState(id), {
    syncedAt: null,
    lastError: "UPSTREAM_FAILED (502)",
    piecesAdded: null,
    notSendable: false,
    eligible: true,
  });
  manager.savePipelineSyncState(id, {
    syncedAt: "2026-09-27T15:00:00.000Z",
    lastError: null,
    piecesAdded: 3,
  });

  manager.db.close();
  manager.db = null;
  manager = openDatabase(t);
  if (!manager) return;
  manager.setActiveAccountId("account-a");
  assert.deepEqual(manager.getPipelineSyncState(id), {
    syncedAt: "2026-09-27T15:00:00.000Z",
    lastError: null,
    piecesAdded: 3,
    notSendable: false,
    eligible: true,
  });
  assert.deepEqual(manager.listPipelinePendingNoteIds(), [other]);
  assert.deepEqual(JSON.parse(manager.getPipelineNote(id).grill_meta), META);
  assert.equal(manager.getPipelineSyncState(plain)?.eligible ?? false, false);
  assert.equal(manager.getPipelineNote(deleted), null);

  manager.setActiveAccountId("account-b");
  assert.equal(manager.getPipelineNote(id), null);
  assert.deepEqual(manager.listPipelinePendingNoteIds(), []);
  assert.throws(() => manager.saveGrillMeta(id, META), /Note not found/);
  manager.db.close();
  manager.db = null;
});

test("the store keeps only the base URL in pipeline-settings.json; the token goes to the environment manager", async (t) => {
  userDataDir = fs.mkdtempSync(path.join(fixtureRoot, "store-"));
  let token = "";
  const environmentManager = {
    getPipelineToken: () => token,
    savePipelineToken: async (value) => {
      token = value;
    },
  };
  const store = new PipelineStore({ databaseManager: {}, environmentManager });
  assert.deepEqual(await store.getSettings(), { baseUrl: "" });
  await store.saveSettings({ baseUrl: "https://smp.example.test" });
  await store.saveToken("secret-bearer");
  const file = fs.readFileSync(path.join(userDataDir, "pipeline-settings.json"), "utf8");
  assert.deepEqual(JSON.parse(file), { baseUrl: "https://smp.example.test" });
  assert.equal(file.includes("secret-bearer"), false);
  assert.equal(await store.getToken(), "secret-bearer");
  t.diagnostic("settings file holds the URL only");
});
