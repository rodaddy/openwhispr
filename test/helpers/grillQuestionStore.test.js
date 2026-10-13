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
  getGrillQuestionBank,
  seedGrillQuestions,
} = require("../../src/helpers/grillQuestionStore.js");

function createDb(t) {
  try {
    const BetterSqlite = require("better-sqlite3");
    return new BetterSqlite(":memory:");
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

const SEED_QUESTIONS = [
  { section: "chapter", chapter: 2, text: "What broke?", position: 1 },
  { section: "standard", text: "What did you ship today?", position: 0 },
  { section: "chapter", chapter: 2, text: "Who fixed it?", position: 0 },
  { section: "day-template", source: "monday", text: "How was {day}?", position: 0 },
];

const SEED_PARAMS = {
  max_day_questions: 4,
  max_feed_questions: 2,
  chapter_titles: { 2: "The middle" },
};

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

test("ensureGrillQuestionTables creates the three store tables", (t) => {
  const db = createDb(t);
  if (!db) return;
  ensureGrillQuestionTables(db);

  const names = tableNames(db);
  assert.ok(names.includes("grill_questions"), `grill_questions missing from ${names.join(",")}`);
  assert.ok(names.includes("grill_question_history"));
  assert.ok(names.includes("grill_flow_params"));

  // Idempotent: a second call on the same handle is a no-op.
  ensureGrillQuestionTables(db);
  assert.deepEqual(tableNames(db), names);
});

test("seedGrillQuestions inserts questions, history rows and params", (t) => {
  const db = createDb(t);
  if (!db) return;
  ensureGrillQuestionTables(db);

  const bank = seedGrillQuestions(
    db,
    SEED_QUESTIONS,
    SEED_PARAMS,
    new Date("2026-09-29T12:00:00Z")
  );

  assert.equal(bank.questions.length, 4);
  for (const row of bank.questions) {
    assert.match(row.id, /^gq-/);
    assert.equal(row.status, "active");
    assert.equal(row.created_at, "2026-09-29T12:00:00.000Z");
    assert.equal(row.updated_at, "2026-09-29T12:00:00.000Z");
  }

  const history = db
    .prepare("SELECT question_id, field, old_value, new_value, source FROM grill_question_history")
    .all();
  assert.equal(history.length, 4);
  for (const entry of history) {
    assert.equal(entry.field, "created");
    assert.equal(entry.source, "seed");
    assert.equal(entry.old_value, null);
  }
  assert.deepEqual(
    history.map((entry) => entry.new_value).sort(),
    SEED_QUESTIONS.map((question) => question.text).sort()
  );
  const questionIds = new Set(bank.questions.map((row) => row.id));
  for (const entry of history) {
    assert.ok(questionIds.has(entry.question_id));
  }

  assert.deepEqual(bank.params, SEED_PARAMS);
  const stored = db.prepare("SELECT key, value FROM grill_flow_params ORDER BY key").all();
  assert.deepEqual(
    stored.map((row) => row.key),
    ["chapter_titles", "max_day_questions", "max_feed_questions"]
  );
  assert.deepEqual(
    JSON.parse(stored.find((row) => row.key === "chapter_titles").value),
    SEED_PARAMS.chapter_titles
  );
});

test("a second seed is a no-op and returns the first rows", (t) => {
  const db = createDb(t);
  if (!db) return;
  ensureGrillQuestionTables(db);

  const first = seedGrillQuestions(db, SEED_QUESTIONS, SEED_PARAMS);
  const second = seedGrillQuestions(
    db,
    [{ section: "standard", text: "A different question", position: 0 }],
    { max_day_questions: 99 }
  );

  assert.deepEqual(second, first);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM grill_questions").get().n, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM grill_question_history").get().n, 4);
  assert.equal(
    JSON.parse(
      db.prepare("SELECT value FROM grill_flow_params WHERE key = 'max_day_questions'").get().value
    ),
    4
  );
});

test("getGrillQuestionBank orders by section, chapter, position and decodes params", (t) => {
  const db = createDb(t);
  if (!db) return;
  ensureGrillQuestionTables(db);
  seedGrillQuestions(db, SEED_QUESTIONS, SEED_PARAMS);

  const bank = getGrillQuestionBank(db);
  assert.deepEqual(
    bank.questions.map((row) => [row.section, row.chapter, row.position, row.text]),
    [
      ["chapter", 2, 0, "Who fixed it?"],
      ["chapter", 2, 1, "What broke?"],
      ["day-template", null, 0, "How was {day}?"],
      ["standard", null, 0, "What did you ship today?"],
    ]
  );
  assert.equal(bank.questions[2].source, "monday");
  assert.deepEqual(bank.params, SEED_PARAMS);
  assert.equal(typeof bank.params.max_feed_questions, "number");
});

test("getGrillQuestionBank on empty tables returns no questions and no params", (t) => {
  const db = createDb(t);
  if (!db) return;
  ensureGrillQuestionTables(db);

  assert.deepEqual(getGrillQuestionBank(db), { questions: [], params: {} });
});

// --- part A: editor functions -------------------------------------------------

const {
  listGrillQuestions,
  addGrillQuestion,
  updateGrillQuestionText,
  setGrillQuestionStatus,
  moveGrillQuestion,
  setGrillFlowParam,
  getGrillQuestionHistory,
} = require("../../src/helpers/grillQuestionStore.js");

const NOW = new Date("2026-09-29T12:00:00Z");
const LATER = new Date("2026-09-30T08:30:00Z");

function seeded(t) {
  const db = createDb(t);
  if (!db) return null;
  ensureGrillQuestionTables(db);
  seedGrillQuestions(db, SEED_QUESTIONS, SEED_PARAMS, NOW);
  return db;
}

test("listGrillQuestions returns retired rows too, in bank order", (t) => {
  const db = seeded(t);
  if (!db) return;

  const rows = listGrillQuestions(db);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => [row.section, row.chapter, row.position]),
    [
      ["chapter", 2, 0],
      ["chapter", 2, 1],
      ["day-template", null, 0],
      ["standard", null, 0],
    ]
  );
});

test("addGrillQuestion assigns a fresh gq- id, the next position and history", (t) => {
  const db = seeded(t);
  if (!db) return;

  const row = addGrillQuestion(
    db,
    { section: "chapter", chapter: 2, source: null, text: "What did it cost?" },
    LATER
  );

  assert.match(row.id, /^gq-[0-9a-f-]{36}$/);
  assert.equal(row.position, 2);
  assert.equal(row.status, "active");
  assert.equal(row.created_at, "2026-09-30T08:30:00.000Z");
  assert.equal(row.updated_at, "2026-09-30T08:30:00.000Z");

  const second = addGrillQuestion(db, { section: "chapter", chapter: 2, text: "And then?" }, LATER);
  assert.notEqual(second.id, row.id);
  assert.equal(second.position, 3);
  assert.equal(second.source, null);

  const history = getGrillQuestionHistory(db, row.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].field, "created");
  assert.equal(history[0].old_value, null);
  assert.equal(history[0].new_value, "What did it cost?");
  assert.equal(history[0].source, "rico");

  assert.equal(listGrillQuestions(db).length, 6);
});

test("addGrillQuestion rejects an empty text or an unknown section", (t) => {
  const db = seeded(t);
  if (!db) return;

  assert.throws(() => addGrillQuestion(db, { section: "standard", text: "   " }, NOW), /text/i);
  assert.throws(() => addGrillQuestion(db, { section: "weekly", text: "Hi?" }, NOW), /section/i);
  assert.equal(listGrillQuestions(db).length, 4);
});

test("updateGrillQuestionText keeps the id and writes one history row", (t) => {
  const db = seeded(t);
  if (!db) return;

  const target = listGrillQuestions(db).find((row) => row.text === "What broke?");
  const updated = updateGrillQuestionText(db, target.id, "What broke, exactly?", LATER);

  assert.equal(updated.id, target.id);
  assert.equal(updated.text, "What broke, exactly?");
  assert.equal(updated.updated_at, "2026-09-30T08:30:00.000Z");
  assert.equal(updated.created_at, target.created_at);

  const history = getGrillQuestionHistory(db, target.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].field, "created");
  assert.equal(history[1].field, "text");
  assert.equal(history[1].old_value, "What broke?");
  assert.equal(history[1].new_value, "What broke, exactly?");
  assert.equal(history[1].source, "rico");
});

test("an unchanged edit writes no history, and bad input throws", (t) => {
  const db = seeded(t);
  if (!db) return;

  const target = listGrillQuestions(db).find((row) => row.text === "What broke?");
  updateGrillQuestionText(db, target.id, "What broke?", LATER);
  assert.equal(getGrillQuestionHistory(db, target.id).length, 1);

  assert.throws(
    () => updateGrillQuestionText(db, "gq-nope", "Anything?", NOW),
    /not found|unknown/i
  );
  assert.throws(() => updateGrillQuestionText(db, target.id, "", NOW), /text/i);
});

test("retiring a question drops it from the bank but not from listGrillQuestions", (t) => {
  const db = seeded(t);
  if (!db) return;

  const target = listGrillQuestions(db).find((row) => row.text === "What broke?");
  const retired = setGrillQuestionStatus(db, target.id, "retired", LATER);
  assert.equal(retired.status, "retired");

  assert.equal(getGrillQuestionBank(db).questions.length, 3);
  assert.equal(listGrillQuestions(db).length, 4);

  const history = getGrillQuestionHistory(db, target.id);
  assert.equal(history[1].field, "status");
  assert.equal(history[1].old_value, "active");
  assert.equal(history[1].new_value, "retired");

  assert.equal(setGrillQuestionStatus(db, target.id, "active", LATER).status, "active");
  assert.equal(getGrillQuestionBank(db).questions.length, 4);
  assert.throws(() => setGrillQuestionStatus(db, target.id, "deleted", NOW), /status/i);
});

test("moveGrillQuestion renumbers the siblings contiguously", (t) => {
  const db = seeded(t);
  if (!db) return;

  addGrillQuestion(db, { section: "chapter", chapter: 2, text: "Third?" }, NOW);
  const before = listGrillQuestions(db).filter((row) => row.section === "chapter");
  assert.deepEqual(
    before.map((row) => [row.position, row.text]),
    [
      [0, "Who fixed it?"],
      [1, "What broke?"],
      [2, "Third?"],
    ]
  );

  const moved = moveGrillQuestion(db, before[2].id, 0, LATER);
  assert.equal(moved.position, 0);

  const after = listGrillQuestions(db).filter((row) => row.section === "chapter");
  assert.deepEqual(
    after.map((row) => [row.position, row.text]),
    [
      [0, "Third?"],
      [1, "Who fixed it?"],
      [2, "What broke?"],
    ]
  );

  const history = getGrillQuestionHistory(db, before[2].id);
  assert.equal(history[1].field, "position");
  assert.equal(history[1].old_value, "2");
  assert.equal(history[1].new_value, "0");

  // Clamped past the end, and other sections untouched.
  assert.equal(moveGrillQuestion(db, after[0].id, 99, LATER).position, 2);
  assert.equal(listGrillQuestions(db).find((row) => row.section === "standard").position, 0);
});

test("setGrillFlowParam upserts known keys and rejects the rest", (t) => {
  const db = seeded(t);
  if (!db) return;

  setGrillFlowParam(db, "max_day_questions", 7);
  assert.equal(getGrillQuestionBank(db).params.max_day_questions, 7);

  setGrillFlowParam(db, "chapter_titles", { 3: "The end" });
  assert.deepEqual(getGrillQuestionBank(db).params.chapter_titles, { 3: "The end" });

  assert.throws(() => setGrillFlowParam(db, "max_moon_phases", 3), /key/i);
  assert.throws(() => setGrillFlowParam(db, "max_feed_questions", 21), /0-20|range|integer/i);
  assert.throws(() => setGrillFlowParam(db, "max_feed_questions", 2.5), /integer|0-20|range/i);
  assert.throws(() => setGrillFlowParam(db, "chapter_titles", "nope"), /object/i);
});

test("getGrillQuestionHistory returns that question's rows oldest first", (t) => {
  const db = seeded(t);
  if (!db) return;

  const target = listGrillQuestions(db).find((row) => row.text === "What broke?");
  const other = listGrillQuestions(db).find((row) => row.text === "Who fixed it?");
  updateGrillQuestionText(db, target.id, "One?", LATER);
  setGrillQuestionStatus(db, target.id, "retired", LATER);

  const history = getGrillQuestionHistory(db, target.id);
  assert.deepEqual(
    history.map((row) => row.field),
    ["created", "text", "status"]
  );
  for (const row of history) assert.equal(row.question_id, target.id);
  assert.equal(getGrillQuestionHistory(db, other.id).length, 1);
  assert.deepEqual(getGrillQuestionHistory(db, "gq-nope"), []);
});
