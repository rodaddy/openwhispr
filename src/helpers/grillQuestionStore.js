const { randomUUID } = require("crypto");

// The grill question bank, stored in SQLite so Rico can edit it without a
// rebuild. The compiled bank (src/config/grill/questionBank.ts) is only the
// seed: the renderer hands main the rows once, and main never reads the TS.
// Interviewer rules and the lifetime intro stay compiled — they are not
// questions, so they are not stored here.

function ensureGrillQuestionTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grill_questions (
      id TEXT PRIMARY KEY,
      section TEXT NOT NULL,
      chapter INTEGER,
      source TEXT,
      text TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS grill_question_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      source TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS grill_flow_params (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  ensureGrillQuestionMarksTable(db);
  ensureGrillTopicsTable(db);

  return true;
}

// Rico's per-question marks (good / weak / retire), optionally tied to the note
// the question was asked in. One mark per (question_id, note_id); a NULL note_id
// is its own slot, so the unique index folds NULL to -1 (note ids start at 1).
// sent_at is left for the lane that ships marks upstream.
function ensureGrillQuestionMarksTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grill_question_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL,
      note_id INTEGER,
      mark TEXT NOT NULL CHECK (mark IN ('good', 'weak', 'retire')),
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grill_question_marks_slot
      ON grill_question_marks (question_id, IFNULL(note_id, -1))
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_grill_question_marks_note
      ON grill_question_marks (note_id)
  `);
}

// note_id has no foreign key (the marks table is created without the notes
// table in some callers), so a hard-deleted note takes its marks with it
// through a trigger instead. Run once notes exists; it also drops marks whose
// note is already gone.
function ensureGrillMarkNoteCleanup(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS grill_question_marks_note_deleted
      AFTER DELETE ON notes
    BEGIN
      DELETE FROM grill_question_marks WHERE note_id = OLD.id;
    END
  `);
  db.exec(`
    DELETE FROM grill_question_marks
     WHERE note_id IS NOT NULL AND note_id NOT IN (SELECT id FROM notes)
  `);
}

function readParams(db) {
  const params = {};
  for (const row of db.prepare("SELECT key, value FROM grill_flow_params").all()) {
    try {
      params[row.key] = JSON.parse(row.value);
    } catch {
      // A param that is not JSON is a write nobody should have made; the bank
      // still loads, so keep the raw string rather than failing the grill.
      params[row.key] = row.value;
    }
  }
  return params;
}

function getGrillQuestionBank(db) {
  const questions = db
    .prepare(
      `SELECT id, section, chapter, source, text, position, status, created_at, updated_at
         FROM grill_questions
        WHERE status = 'active'
        ORDER BY section, chapter, position, id`
    )
    .all();
  return { questions, params: readParams(db) };
}

// Seeds ONLY when grill_questions is empty, in one transaction, and returns the
// stored bank either way — so calling it on every app start is safe.
function seedGrillQuestions(db, questions, params, now = new Date()) {
  const rows = Array.isArray(questions) ? questions : [];
  const flowParams = params && typeof params === "object" ? params : {};
  const timestamp = now.toISOString();

  const seed = db.transaction(() => {
    const existing = db.prepare("SELECT COUNT(*) AS count FROM grill_questions").get();
    if (existing.count > 0) return;

    const insertQuestion = db.prepare(
      `INSERT INTO grill_questions
         (id, section, chapter, source, text, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    );
    const insertHistory = db.prepare(
      `INSERT INTO grill_question_history
         (question_id, changed_at, field, old_value, new_value, source)
       VALUES (?, ?, 'created', NULL, ?, 'seed')`
    );
    const insertParam = db.prepare(
      "INSERT OR REPLACE INTO grill_flow_params (key, value) VALUES (?, ?)"
    );

    rows.forEach((row, index) => {
      const id = `gq-${randomUUID()}`;
      insertQuestion.run(
        id,
        row.section,
        Number.isInteger(row.chapter) ? row.chapter : null,
        typeof row.source === "string" ? row.source : null,
        row.text,
        Number.isInteger(row.position) ? row.position : index,
        timestamp,
        timestamp
      );
      insertHistory.run(id, timestamp, row.text);
    });

    for (const [key, value] of Object.entries(flowParams)) {
      insertParam.run(key, JSON.stringify(value));
    }
  });

  seed();
  return getGrillQuestionBank(db);
}

// --- editor -----------------------------------------------------------------
// Rico edits the bank from the control panel. Every write is one transaction and
// leaves a history row, so a question's wording can be traced back; an id is
// never reused and never rewritten, because the pipeline stores it on notes.

const SECTIONS = new Set(["standard", "chapter", "day-template"]);
const STATUSES = new Set(["active", "retired"]);
const QUESTION_COLUMNS = `id, section, chapter, source, text, position, status, created_at, updated_at`;

function requireText(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) throw new Error("Question text is required");
  return trimmed;
}

function getRow(db, id) {
  const row = db.prepare(`SELECT ${QUESTION_COLUMNS} FROM grill_questions WHERE id = ?`).get(id);
  if (!row) throw new Error(`Grill question not found: ${id}`);
  return row;
}

function insertHistory(db, questionId, timestamp, field, oldValue, newValue, source) {
  db.prepare(
    `INSERT INTO grill_question_history
       (question_id, changed_at, field, old_value, new_value, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(questionId, timestamp, field, oldValue, newValue, source);
}

// Siblings share (section, chapter) — that pair is the ordered list the editor
// shows, so NULL chapter has to match NULL rather than compare unequal.
function siblingClause(chapter) {
  return chapter === null || chapter === undefined
    ? "section = ? AND chapter IS NULL"
    : "section = ? AND chapter = ?";
}

function siblingArgs(section, chapter) {
  return chapter === null || chapter === undefined ? [section] : [section, chapter];
}

function listGrillQuestions(db) {
  return db
    .prepare(
      `SELECT ${QUESTION_COLUMNS}
         FROM grill_questions
        ORDER BY section, chapter, position, id`
    )
    .all();
}

function addGrillQuestion(db, question, now = new Date(), historySource = "rico") {
  const fields = question && typeof question === "object" ? question : {};
  const section = fields.section;
  if (!SECTIONS.has(section)) {
    throw new Error(`Unknown grill question section: ${String(section)}`);
  }
  const text = requireText(fields.text);
  const chapter = Number.isInteger(fields.chapter) ? fields.chapter : null;
  const source = typeof fields.source === "string" ? fields.source : null;
  const timestamp = now.toISOString();

  const insert = db.transaction(() => {
    const max = db
      .prepare(
        `SELECT MAX(position) AS maxPosition FROM grill_questions WHERE ${siblingClause(chapter)}`
      )
      .get(...siblingArgs(section, chapter));
    const position = Number.isInteger(max?.maxPosition) ? max.maxPosition + 1 : 0;
    const id = `gq-${randomUUID()}`;
    db.prepare(
      `INSERT INTO grill_questions
         (id, section, chapter, source, text, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(id, section, chapter, source, text, position, timestamp, timestamp);
    insertHistory(db, id, timestamp, "created", null, text, historySource);
    return id;
  });

  return getRow(db, insert());
}

function updateGrillQuestionText(db, id, text, now = new Date(), historySource = "rico") {
  const next = requireText(text);
  const existing = getRow(db, id);
  if (existing.text === next) return existing;
  const timestamp = now.toISOString();

  db.transaction(() => {
    db.prepare("UPDATE grill_questions SET text = ?, updated_at = ? WHERE id = ?").run(
      next,
      timestamp,
      id
    );
    insertHistory(db, id, timestamp, "text", existing.text, next, historySource);
  })();

  return getRow(db, id);
}

function setGrillQuestionStatus(db, id, status, now = new Date(), historySource = "rico") {
  if (!STATUSES.has(status)) {
    throw new Error(`Unknown grill question status: ${String(status)}`);
  }
  const existing = getRow(db, id);
  if (existing.status === status) return existing;
  const timestamp = now.toISOString();

  db.transaction(() => {
    db.prepare("UPDATE grill_questions SET status = ?, updated_at = ? WHERE id = ?").run(
      status,
      timestamp,
      id
    );
    insertHistory(db, id, timestamp, "status", existing.status, status, historySource);
  })();

  return getRow(db, id);
}

function moveGrillQuestion(db, id, newPosition, now = new Date(), historySource = "rico") {
  const existing = getRow(db, id);
  const timestamp = now.toISOString();

  db.transaction(() => {
    const siblings = db
      .prepare(
        `SELECT id, position FROM grill_questions
          WHERE ${siblingClause(existing.chapter)}
          ORDER BY position, id`
      )
      .all(...siblingArgs(existing.section, existing.chapter));

    const others = siblings.filter((row) => row.id !== id);
    const requested = Number.isInteger(newPosition) ? newPosition : 0;
    const target = Math.min(Math.max(requested, 0), others.length);
    const ordered = [...others.slice(0, target), { id }, ...others.slice(target)];

    const setPosition = db.prepare(
      "UPDATE grill_questions SET position = ?, updated_at = ? WHERE id = ?"
    );
    ordered.forEach((row, index) => setPosition.run(index, timestamp, row.id));

    if (existing.position !== target) {
      insertHistory(
        db,
        id,
        timestamp,
        "position",
        String(existing.position),
        String(target),
        historySource
      );
    }
  })();

  return getRow(db, id);
}

function setGrillFlowParam(db, key, value) {
  if (key === "max_day_questions" || key === "max_feed_questions") {
    if (!Number.isInteger(value) || value < 0 || value > 20) {
      throw new Error(`${key} must be an integer in the range 0-20`);
    }
  } else if (key === "chapter_titles") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("chapter_titles must be an object");
    }
  } else {
    throw new Error(`Unknown grill flow param key: ${String(key)}`);
  }

  db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO grill_flow_params (key, value) VALUES (?, ?)").run(
      key,
      JSON.stringify(value)
    );
  })();

  return { key, value };
}

function getGrillQuestionHistory(db, id) {
  return db
    .prepare(
      `SELECT id, question_id, changed_at, field, old_value, new_value, source
         FROM grill_question_history
        WHERE question_id = ?
        ORDER BY id`
    )
    .all(id);
}

// --- marks ------------------------------------------------------------------

const MARKS = new Set(["good", "weak", "retire"]);
const MARK_COLUMNS = `id, question_id, note_id, mark, note, created_at, updated_at, sent_at`;

function requireQuestionId(questionId) {
  if (typeof questionId !== "string" || !questionId.trim()) {
    throw new Error("Question id is required");
  }
  return questionId;
}

function normalizeNoteId(noteId) {
  if (noteId === null || noteId === undefined) return null;
  if (!Number.isInteger(noteId)) throw new Error(`Invalid note id: ${String(noteId)}`);
  return noteId;
}

function getMarkRow(db, questionId, noteId) {
  return (
    db
      .prepare(
        `SELECT ${MARK_COLUMNS} FROM grill_question_marks
          WHERE question_id = ? AND note_id IS ?`
      )
      .get(questionId, noteId) ?? null
  );
}

// Upsert: a second mark for the same slot replaces the first. A changed mark has
// not been sent, so sent_at goes back to NULL.
function setMark(db, questionId, noteId, mark, note = null, now = new Date()) {
  const id = requireQuestionId(questionId);
  const slot = normalizeNoteId(noteId);
  if (!MARKS.has(mark)) throw new Error(`Unknown grill question mark: ${String(mark)}`);
  const text = typeof note === "string" && note.trim() ? note.trim() : null;
  const timestamp = now.toISOString();

  db.prepare(
    `INSERT INTO grill_question_marks
       (question_id, note_id, mark, note, created_at, updated_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (question_id, IFNULL(note_id, -1)) DO UPDATE SET
       mark = excluded.mark,
       note = excluded.note,
       updated_at = excluded.updated_at,
       sent_at = NULL`
  ).run(id, slot, mark, text, timestamp, timestamp);

  return getMarkRow(db, id, slot);
}

function clearMark(db, questionId, noteId) {
  const id = requireQuestionId(questionId);
  const slot = normalizeNoteId(noteId);
  const result = db
    .prepare("DELETE FROM grill_question_marks WHERE question_id = ? AND note_id IS ?")
    .run(id, slot);
  return result.changes > 0;
}

function marksForNote(db, noteId) {
  const slot = normalizeNoteId(noteId);
  return db
    .prepare(
      `SELECT ${MARK_COLUMNS} FROM grill_question_marks
        WHERE note_id IS ?
        ORDER BY created_at, id`
    )
    .all(slot);
}

// Counts every mark regardless of the question's status, so retired questions
// keep their tally.
function markCountsByQuestion(db) {
  const counts = {};
  const rows = db
    .prepare(
      `SELECT question_id, mark, COUNT(*) AS count
         FROM grill_question_marks
        GROUP BY question_id, mark`
    )
    .all();
  for (const row of rows) {
    counts[row.question_id] ??= { good: 0, weak: 0, retire: 0 };
    counts[row.question_id][row.mark] = row.count;
  }
  return counts;
}

// The "To grill" list: topics (from brain dumps or typed by hand) the next
// daily grill asks first, then marks used. Separate from the question bank.
function ensureGrillTopicsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grill_topics (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used')),
      created_at TEXT NOT NULL,
      used_at TEXT
    )
  `);
}

function addTopic(db, { text, source, sourceRef = null }, now = new Date()) {
  const clean = requireText(text);
  const id = `gt-${randomUUID()}`;
  db.prepare(
    `INSERT INTO grill_topics (id, text, source, source_ref, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    clean,
    typeof source === "string" && source.trim() ? source.trim() : "manual",
    sourceRef == null ? null : String(sourceRef),
    now.toISOString()
  );
  return id;
}

function removeTopic(db, id) {
  return db.prepare("DELETE FROM grill_topics WHERE id = ?").run(id).changes > 0;
}

function listTopics(db, { status } = {}) {
  const columns = "id, text, source, source_ref, status, created_at, used_at";
  return status
    ? db
        .prepare(`SELECT ${columns} FROM grill_topics WHERE status = ? ORDER BY created_at, rowid`)
        .all(status)
    : db.prepare(`SELECT ${columns} FROM grill_topics ORDER BY created_at, rowid`).all();
}

function markTopicsUsed(db, ids, now = new Date()) {
  const update = db.prepare(
    "UPDATE grill_topics SET status = 'used', used_at = ? WHERE id = ? AND status = 'pending'"
  );
  const timestamp = now.toISOString();
  const mark = db.transaction((list) => {
    let changed = 0;
    for (const id of list) changed += update.run(timestamp, id).changes;
    return changed;
  });
  return mark(Array.isArray(ids) ? ids : []);
}

module.exports = {
  ensureGrillTopicsTable,
  addTopic,
  removeTopic,
  listTopics,
  markTopicsUsed,
  ensureGrillQuestionTables,
  getGrillQuestionBank,
  seedGrillQuestions,
  listGrillQuestions,
  addGrillQuestion,
  updateGrillQuestionText,
  setGrillQuestionStatus,
  moveGrillQuestion,
  setGrillFlowParam,
  getGrillQuestionHistory,
  ensureGrillQuestionMarksTable,
  ensureGrillMarkNoteCleanup,
  setMark,
  clearMark,
  marksForNote,
  markCountsByQuestion,
};
