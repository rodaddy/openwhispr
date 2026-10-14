const test = require("node:test");
const assert = require("node:assert/strict");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

const {
  ensureGrillQuestionTables,
  ensureGrillQuestionMarksTable,
  addGrillQuestion,
  setGrillQuestionStatus,
  setMark,
  clearMark,
  marksForNote,
  markCountsByQuestion,
  ensureGrillMarkNoteCleanup,
} = require("../../src/helpers/grillQuestionStore.js");

function createDb(t) {
  try {
    const BetterSqlite = require("better-sqlite3");
    const db = new BetterSqlite(":memory:");
    ensureGrillQuestionTables(db);
    return db;
  } catch (error) {
    if (isNativeBindingUnavailable(error) && !process.env.REQUIRE_DB_TESTS) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

const T1 = new Date("2026-09-01T10:00:00.000Z");
const T2 = new Date("2026-09-02T10:00:00.000Z");

function markRows(db) {
  return db.prepare("SELECT * FROM grill_question_marks ORDER BY id").all();
}

test("setMark on the same (question, note) replaces the mark instead of adding one", (t) => {
  const db = createDb(t);
  if (!db) return;

  setMark(db, "gq-a", 7, "good", "clear", T1);
  db.prepare("UPDATE grill_question_marks SET sent_at = ?").run(T1.toISOString());
  const row = setMark(db, "gq-a", 7, "weak", "vague", T2);

  const rows = markRows(db);
  assert.equal(rows.length, 1);
  assert.equal(row.mark, "weak");
  assert.equal(row.note, "vague");
  assert.equal(row.created_at, T1.toISOString());
  assert.equal(row.updated_at, T2.toISOString());
  assert.equal(row.sent_at, null);
});

test("a NULL note is its own slot and upserts too", (t) => {
  const db = createDb(t);
  if (!db) return;

  setMark(db, "gq-a", null, "good", null, T1);
  setMark(db, "gq-a", null, "retire", null, T2);
  setMark(db, "gq-a", 7, "good", null, T2);

  const rows = markRows(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.note_id, r.mark]),
    [
      [null, "retire"],
      [7, "good"],
    ]
  );
});

test("clearMark removes only that slot", (t) => {
  const db = createDb(t);
  if (!db) return;

  setMark(db, "gq-a", 7, "good", null, T1);
  setMark(db, "gq-a", 8, "weak", null, T1);

  assert.equal(clearMark(db, "gq-a", 7), true);
  assert.equal(clearMark(db, "gq-a", 7), false);
  assert.deepEqual(
    markRows(db).map((r) => r.note_id),
    [8]
  );
});

test("an unknown mark throws and writes nothing", (t) => {
  const db = createDb(t);
  if (!db) return;

  assert.throws(() => setMark(db, "gq-a", 7, "meh", null, T1), /Unknown grill question mark/);
  assert.throws(() => setMark(db, "gq-a", 7, undefined, null, T1), /Unknown grill question mark/);
  assert.equal(markRows(db).length, 0);
});

test("marksForNote lists that note's marks only", (t) => {
  const db = createDb(t);
  if (!db) return;

  setMark(db, "gq-a", 7, "good", null, T1);
  setMark(db, "gq-b", 7, "weak", "too long", T2);
  setMark(db, "gq-a", 8, "retire", null, T1);

  const marks = marksForNote(db, 7);
  assert.deepEqual(
    marks.map((m) => [m.question_id, m.mark, m.note]),
    [
      ["gq-a", "good", null],
      ["gq-b", "weak", "too long"],
    ]
  );
  assert.deepEqual(marksForNote(db, 99), []);
});

test("markCountsByQuestion groups per question, retired questions included", (t) => {
  const db = createDb(t);
  if (!db) return;

  const live = addGrillQuestion(db, { section: "standard", text: "What shipped?" }, T1);
  const retired = addGrillQuestion(db, { section: "standard", text: "Old one?" }, T1);
  setGrillQuestionStatus(db, retired.id, "retired", T2);

  setMark(db, live.id, 1, "good", null, T1);
  setMark(db, live.id, 2, "good", null, T1);
  setMark(db, live.id, 3, "weak", null, T1);
  setMark(db, retired.id, 1, "retire", null, T1);
  setMark(db, retired.id, 2, "retire", null, T1);

  assert.deepEqual(markCountsByQuestion(db), {
    [live.id]: { good: 2, weak: 1, retire: 0 },
    [retired.id]: { good: 0, weak: 0, retire: 2 },
  });
});

test("the marks migration is idempotent and keeps existing marks", (t) => {
  const db = createDb(t);
  if (!db) return;

  setMark(db, "gq-a", 7, "good", null, T1);
  ensureGrillQuestionTables(db);
  ensureGrillQuestionMarksTable(db);

  assert.equal(markRows(db).length, 1);
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'grill_question_marks' AND name LIKE 'idx_%' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  assert.deepEqual(indexes, ["idx_grill_question_marks_note", "idx_grill_question_marks_slot"]);
});

// Note_id has no foreign key, so a hard-deleted note (a hub
// tombstone) must take its marks with it or they stay in the tallies.
test("deleting a note removes its marks from the counts", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT)");
  db.prepare("INSERT INTO notes (id, title) VALUES (1, 'kept'), (2, 'deleted')").run();
  ensureGrillMarkNoteCleanup(db);

  setMark(db, "gq-a", 1, "good", null, T1);
  setMark(db, "gq-a", 2, "weak", null, T1);
  setMark(db, "gq-a", null, "retire", null, T1);
  db.prepare("DELETE FROM notes WHERE id = 2").run();

  assert.deepEqual(markCountsByQuestion(db), { "gq-a": { good: 1, weak: 0, retire: 1 } });
  assert.deepEqual(marksForNote(db, 2), []);
});

test("the note cleanup drops marks whose note is already gone and is idempotent", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT)");
  db.prepare("INSERT INTO notes (id, title) VALUES (1, 'kept')").run();
  setMark(db, "gq-a", 1, "good", null, T1);
  setMark(db, "gq-a", 9, "weak", null, T1);

  ensureGrillMarkNoteCleanup(db);
  ensureGrillMarkNoteCleanup(db);

  assert.deepEqual(
    markRows(db).map((r) => r.note_id),
    [1]
  );
});
