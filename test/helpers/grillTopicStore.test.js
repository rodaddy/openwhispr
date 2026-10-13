const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ensureGrillQuestionTables,
  addTopic,
  removeTopic,
  listTopics,
  markTopicsUsed,
} = require("../../src/helpers/grillQuestionStore.js");

function createDb(t) {
  try {
    const BetterSqlite = require("better-sqlite3");
    const db = new BetterSqlite(":memory:");
    ensureGrillQuestionTables(db);
    return db;
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("NODE_MODULE_VERSION") || message.includes("bindings file")) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("a topic round-trips and can be removed", (t) => {
  const db = createDb(t);
  if (!db) return;
  const id = addTopic(db, {
    text: "  Why is the build slow?  ",
    source: "brain-dump",
    sourceRef: "42",
  });
  const [row] = listTopics(db, { status: "pending" });
  assert.equal(row.id, id);
  assert.equal(row.text, "Why is the build slow?");
  assert.equal(row.source, "brain-dump");
  assert.equal(row.source_ref, "42");
  assert.equal(row.status, "pending");
  assert.equal(row.used_at, null);
  assert.equal(removeTopic(db, id), true);
  assert.deepEqual(listTopics(db, { status: "pending" }), []);
  assert.throws(() => addTopic(db, { text: "  ", source: "manual" }));
});

test("listTopics filters by status and markTopicsUsed marks only the given ids", (t) => {
  const db = createDb(t);
  if (!db) return;
  const a = addTopic(db, { text: "A", source: "manual" });
  const b = addTopic(db, { text: "B", source: "manual" });
  const c = addTopic(db, { text: "C", source: "manual" });
  markTopicsUsed(db, [a, c]);
  assert.deepEqual(
    listTopics(db, { status: "pending" }).map((r) => r.id),
    [b]
  );
  const used = listTopics(db, { status: "used" });
  assert.deepEqual(used.map((r) => r.id).sort(), [a, c].sort());
  assert.ok(used.every((r) => r.used_at));
  assert.equal(listTopics(db).length, 3);
});
