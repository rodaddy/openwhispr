const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const fixtureRoot = path.join(require("node:os").tmpdir(), "openwhispr-crm-verification");
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
const CrmStore = require("../../src/helpers/crmStore.js");
const { createCrmConnector } = require("../../src/helpers/crmConnector.js");
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

function insertPrivateNote(manager, { accountId, deleted = false }) {
  const space = manager.db
    .prepare("INSERT INTO spaces (name, kind) VALUES (?, 'private')")
    .run(`Private ${accountId}`);
  return Number(
    manager.db
      .prepare(
        `INSERT INTO notes (title, content, note_type, space_id, account_id, deleted_at)
         VALUES ('CRM note', 'Follow up', 'personal', ?, ?, ?)`
      )
      .run(space.lastInsertRowid, accountId, deleted ? new Date().toISOString() : null)
      .lastInsertRowid
  );
}

const GHL_NOTE = (url, init) => {
  const contactId = new URL(url).pathname.split("/")[2];
  const body = init.body ? JSON.parse(init.body) : {};
  return new Response(
    JSON.stringify({ note: { id: "ghl-note-1", contactId, body: body.body || "old" } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

test("GHL note links migrate, survive reopen, clear old CRM links, and keep account boundaries", (t) => {
  userDataDir = fs.mkdtempSync(path.join(fixtureRoot, "persistence-"));
  let manager = openDatabase(t);
  if (!manager) return;

  const columns = manager.db
    .prepare("PRAGMA table_info(notes)")
    .all()
    .map((row) => row.name);
  for (const column of [
    "crm_activity_id",
    "crm_target_id",
    "crm_target_type",
    "crm_opportunity_id",
    "crm_synced_at",
    "crm_scope",
  ]) {
    assert.ok(columns.includes(column), `migration adds ${column}`);
  }

  manager.setActiveAccountId("account-a");
  const noteId = insertPrivateNote(manager, { accountId: "account-a" });
  const legacyId = insertPrivateNote(manager, { accountId: "account-a" });
  const deletedNoteId = insertPrivateNote(manager, { accountId: "account-a", deleted: true });
  manager.db
    .prepare(
      `UPDATE notes SET crm_activity_id = 'activity-old', crm_target_id = 'c-old',
        crm_target_type = 'company', crm_synced_at = 'then', crm_scope = 'legacy-scope' WHERE id = ?`
    )
    .run(legacyId);
  const state = {
    noteId: "ghl-note-1",
    contactId: "contact-1",
    opportunityId: "opp-1",
    syncedAt: "2026-10-07T12:00:00.000Z",
  };
  assert.deepEqual(manager.saveCrmSyncState(noteId, state, "ghl:a"), state);
  assert.throws(() => manager.saveCrmSyncState(deletedNoteId, state, "ghl:a"), /Note not found/);

  manager.db.close();
  manager.db = null;
  manager = openDatabase(t);
  if (!manager) return;
  manager.setActiveAccountId("account-a");
  assert.deepEqual(manager.getCrmSyncState(noteId, "ghl:a"), state);
  assert.equal(manager.getNote(noteId).crm_target_type, "contact");
  const legacy = manager.getNote(legacyId);
  for (const column of ["crm_activity_id", "crm_target_id", "crm_target_type", "crm_scope"]) {
    assert.equal(legacy[column], null, `old link ${column} is cleared`);
  }

  manager.setActiveAccountId("account-b");
  assert.equal(manager.getCrmSyncState(noteId, "ghl:a"), null);
  assert.throws(
    () => manager.saveCrmSyncState(noteId, { ...state, noteId: "hijacked" }, "ghl:b"),
    /Note not found/
  );
  manager.db.close();
  manager.db = null;
});

test("the real store deletes the old settings file and updates the GHL note after reopen", async (t) => {
  userDataDir = fs.mkdtempSync(path.join(fixtureRoot, "adapter-"));
  const oldSettings = path.join(userDataDir, "crm-settings.json");
  fs.writeFileSync(oldSettings, "{}");
  let manager = openDatabase(t);
  if (!manager) return;
  manager.setActiveAccountId("account-a");
  const noteId = insertPrivateNote(manager, { accountId: "account-a" });

  let token = "pit-secret";
  const environmentManager = {
    getGhlToken: () => token,
    saveGhlToken: (value) => {
      token = value;
    },
  };
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push(`${init.method || "GET"} ${new URL(url).pathname}`);
    return GHL_NOTE(url, init);
  };
  const target = { contactId: "contact-1", opportunityId: "opp-1" };
  let store = new CrmStore({ databaseManager: manager, environmentManager });
  assert.equal(fs.existsSync(oldSettings), false);
  await createCrmConnector({ store, fetchImpl }).syncNote(noteId, target);

  manager.db.close();
  manager.db = null;
  manager = openDatabase(t);
  if (!manager) return;
  manager.setActiveAccountId("account-a");
  store = new CrmStore({ databaseManager: manager, environmentManager });
  const connector = createCrmConnector({ store, fetchImpl });
  assert.equal((await connector.getSyncState(noteId))?.noteId, "ghl-note-1");
  await connector.syncNote(noteId, target);
  assert.deepEqual(requests, [
    "POST /contacts/contact-1/notes",
    "GET /contacts/contact-1/notes/ghl-note-1",
    "PUT /contacts/contact-1/notes/ghl-note-1",
  ]);

  let release;
  const racing = createCrmConnector({
    store,
    fetchImpl: async (url, init = {}) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return GHL_NOTE(url, init);
    },
  });
  const otherId = insertPrivateNote(manager, { accountId: "account-a" });
  const sync = racing.syncNote(otherId, target);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  manager.setActiveAccountId("account-b");
  release();
  await assert.rejects(sync, { code: "SETTINGS_CHANGED" });
  manager.setActiveAccountId("account-a");
  assert.equal(await connector.getSyncState(otherId), null);
  manager.db.close();
  manager.db = null;
});

test("GHL token uses encrypted secret storage, stays out of .env, and explicit empty removes it", async (t) => {
  userDataDir = fs.mkdtempSync(path.join(fixtureRoot, "secret-"));
  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: fixtureRoot,
  });
  t.after(() => {
    if (originalResourcesPath) {
      Object.defineProperty(process, "resourcesPath", originalResourcesPath);
    } else {
      delete process.resourcesPath;
    }
  });
  const environmentPath = require.resolve("../../src/helpers/environment.js");
  const secretCryptoPath = require.resolve("../../src/helpers/secretCrypto.js");
  const encryptedPrefix = Buffer.from("encrypted:");
  const cryptoStub = {
    isAvailable: () => true,
    encrypt: (value) => Buffer.concat([encryptedPrefix, Buffer.from(value).reverse()]),
    decrypt: (buffer) => ({
      value: Buffer.from(buffer.subarray(encryptedPrefix.length)).reverse().toString("utf8"),
      needsReencrypt: false,
    }),
  };
  const priorLoad = Module._load;
  Module._load = function loadEncryptedEnvironment(request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => userDataDir }, safeStorage: {} };
    }
    if (request === "./secretCrypto" && parent?.filename === environmentPath) return cryptoStub;
    return priorLoad.call(this, request, parent, isMain);
  };
  delete require.cache[environmentPath];
  delete require.cache[secretCryptoPath];
  const EnvironmentManager = require(environmentPath);
  Module._load = priorLoad;

  const environment = new EnvironmentManager();
  delete process.env.GHL_PRIVATE_TOKEN;
  await environment.init();
  await environment.saveGhlToken("crm-secret-value");
  const secretPath = path.join(userDataDir, "secure-keys", "GHL_PRIVATE_TOKEN.enc");
  const encrypted = fs.readFileSync(secretPath);
  assert.equal(encrypted.includes(Buffer.from("crm-secret-value")), false);
  assert.equal(environment.getGhlToken(), "crm-secret-value");

  await environment.saveAllKeysToEnvFile();
  const envContents = fs.readFileSync(path.join(userDataDir, ".env"), "utf8");
  assert.equal(envContents.includes("GHL_PRIVATE_TOKEN"), false);
  assert.equal(envContents.includes("crm-secret-value"), false);

  await environment.saveGhlToken("");
  assert.equal(environment.getGhlToken(), "");
  assert.equal(fs.existsSync(secretPath), false);
});
