const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-msg-edit-db-"));
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

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-msg-edit-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  try {
    const database = new DatabaseManager();
    database.setActiveAccountId("test-account");
    return database;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

function seed(db) {
  const conv = db.createAgentConversation("Grill");
  const first = db.addAgentMessage(conv.id, "assistant", "What surprised you?");
  const second = db.addAgentMessage(conv.id, "user", "stray text became an answer");
  return { conv, first, second };
}

test("updateAgentMessage rewrites one row's content", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conv, first, second } = seed(db);

  const result = db.updateAgentMessage(second.id, "the grill stayed on script");
  assert.equal(result.success, true);

  const messages = db.getAgentMessages(conv.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, "What surprised you?");
  assert.equal(messages[0].id, first.id);
  assert.equal(messages[1].content, "the grill stayed on script");
});

test("updateAgentMessage reports an unknown id without throwing", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conv } = seed(db);
  const result = db.updateAgentMessage(999999, "nothing");
  assert.equal(result.success, false);
  assert.equal(db.getAgentMessages(conv.id).length, 2);
});

test("deleteAgentMessage removes one row and leaves the rest", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conv, first, second } = seed(db);

  const result = db.deleteAgentMessage(second.id);
  assert.equal(result.success, true);

  const messages = db.getAgentMessages(conv.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, first.id);

  const missing = db.deleteAgentMessage(second.id);
  assert.equal(missing.success, false);
});
