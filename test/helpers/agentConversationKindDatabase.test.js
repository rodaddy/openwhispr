const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-kind-db-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-kind-db-"));
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

/** Puts the database back the way a pre-kind launch left it. */
function dropKindColumn(db) {
  db.db.exec("DROP INDEX IF EXISTS idx_agent_conversations_kind");
  db.db.exec("ALTER TABLE agent_conversations DROP COLUMN kind");
}

function titleKinds(db) {
  return Object.fromEntries(
    db.db
      .prepare("SELECT title, kind FROM agent_conversations")
      .all()
      .map((row) => [row.title, row.kind])
  );
}

test("migration backfills grill kind from the two grill title shapes", (t) => {
  const db = createDb(t);
  if (!db) return;

  dropKindColumn(db);
  const insert = db.db.prepare("INSERT INTO agent_conversations (title) VALUES (?)");
  insert.run("Grill 2026-09-28");
  insert.run("Grill 2026-09-29 (resumed)");
  insert.run("Life Story ch 3: The move east");
  insert.run("Grilling the steak");
  insert.run("Notes on the invoice");
  db.db.close();

  const relaunched = new DatabaseManager();
  const kinds = titleKinds(relaunched);
  assert.equal(kinds["Grill 2026-09-28"], "grill");
  assert.equal(kinds["Grill 2026-09-29 (resumed)"], "grill");
  assert.equal(kinds["Life Story ch 3: The move east"], "grill");
  assert.equal(kinds["Grilling the steak"], "chat");
  assert.equal(kinds["Notes on the invoice"], "chat");
  relaunched.db.close();
});

test("conversation preview list filters by kind", (t) => {
  const db = createDb(t);
  if (!db) return;

  const chat = db.createAgentConversation("Quarterly plan");
  const grill = db.createAgentConversation("Grill 2026-09-29", null, null, null, "grill");
  assert.equal(chat.kind, "chat");
  assert.equal(grill.kind, "grill");

  const chats = db.getAgentConversationsWithPreview(50, 0, false, "chat");
  assert.deepEqual(
    chats.map((c) => c.title),
    ["Quarterly plan"]
  );
  assert.equal(chats[0].kind, "chat");

  const grills = db.getAgentConversationsWithPreview(50, 0, false, "grill");
  assert.deepEqual(
    grills.map((c) => c.title),
    ["Grill 2026-09-29"]
  );

  const everything = db.getAgentConversationsWithPreview(50, 0, false);
  assert.equal(everything.length, 2);
  db.db.close();
});

test("deleting a never-synced conversation removes the row and its messages", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(null); // local-only install: nobody signed in, nothing ever synced

  const conversation = db.createAgentConversation("Grill 2026-09-29", null, null, null, "grill");
  db.addAgentMessage(conversation.id, "user", "first answer");
  db.addAgentMessage(conversation.id, "assistant", "next question");

  assert.deepEqual(db.deleteAgentConversation(conversation.id), { success: true });

  const row = db.db.prepare("SELECT id FROM agent_conversations WHERE id = ?").get(conversation.id);
  assert.equal(row, undefined);
  const messages = db.db
    .prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?")
    .get(conversation.id);
  assert.equal(messages.count, 0);
  db.db.close();
});

// A signed-in user's chat with no cloud id may have its CREATE in flight; the
// late ack is what queues the server-side delete, so the row must survive.
test("deleting while signed in tombstones even a chat with no cloud id yet", (t) => {
  const db = createDb(t);
  if (!db) return;

  const conversation = db.createAgentConversation("Create in flight");
  assert.deepEqual(db.deleteAgentConversation(conversation.id), { success: true });
  const row = db.db
    .prepare("SELECT deleted_at FROM agent_conversations WHERE id = ?")
    .get(conversation.id);
  assert.ok(row?.deleted_at, "signed-in delete must leave a tombstone");
  db.db.close();
});

test("deleting a synced conversation tombstones it instead of dropping the row", (t) => {
  const db = createDb(t);
  if (!db) return;

  const conversation = db.createAgentConversation("Synced chat");
  db.addAgentMessage(conversation.id, "user", "kept for the push");
  db.updateAgentConversationCloudId(conversation.id, "cloud-abc");

  assert.deepEqual(db.deleteAgentConversation(conversation.id), { success: true });

  const row = db.db
    .prepare("SELECT deleted_at, sync_status FROM agent_conversations WHERE id = ?")
    .get(conversation.id);
  assert.ok(row, "synced conversation must survive as a tombstone");
  assert.ok(row.deleted_at);
  assert.equal(row.sync_status, "pending");
  const messages = db.db
    .prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?")
    .get(conversation.id);
  assert.equal(messages.count, 1);
  db.db.close();
});

test("startup purge clears pre-existing local tombstones and keeps live rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  const tombstoned = db.createAgentConversation("Grill 2026-09-20", null, null, null, "grill");
  db.addAgentMessage(tombstoned.id, "user", "should not survive");
  const live = db.createAgentConversation("Still here");
  db.addAgentMessage(live.id, "user", "kept");

  // A tombstone written by the old soft-delete, before this launch.
  db.db
    .prepare("UPDATE agent_conversations SET deleted_at = datetime('now') WHERE id = ?")
    .run(tombstoned.id);
  db.db.close();

  const relaunched = new DatabaseManager();
  const ids = relaunched.db
    .prepare("SELECT id FROM agent_conversations ORDER BY id")
    .all()
    .map((row) => row.id);
  assert.deepEqual(ids, [live.id]);
  const orphanMessages = relaunched.db
    .prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?")
    .get(tombstoned.id);
  assert.equal(orphanMessages.count, 0);
  const keptMessages = relaunched.db
    .prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?")
    .get(live.id);
  assert.equal(keptMessages.count, 1);
  relaunched.db.close();
});

// The purge runs before the account is known, so an install that has ever
// synced keeps every tombstone for sync to resolve.
test("startup purge does nothing on an install that has synced", (t) => {
  const db = createDb(t);
  if (!db) return;

  const localTombstone = db.createAgentConversation("Local and deleted");
  const synced = db.createAgentConversation("Synced");
  db.updateAgentConversationCloudId(synced.id, "cloud-xyz");
  db.db
    .prepare("UPDATE agent_conversations SET deleted_at = datetime('now') WHERE id = ?")
    .run(localTombstone.id);
  db.db.close();

  const relaunched = new DatabaseManager();
  const ids = relaunched.db
    .prepare("SELECT id FROM agent_conversations ORDER BY id")
    .all()
    .map((row) => row.id);
  assert.deepEqual(ids, [localTombstone.id, synced.id]);
  relaunched.db.close();
});
