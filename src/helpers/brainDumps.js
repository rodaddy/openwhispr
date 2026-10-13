// Brain-dump Process engine (#327). Main process only. The phone saves each
// dump as a note in "Brain dumps"; Process files each one as a note, a
// "To grill" topic, or an Apple Reminder, and records an undoable action.
// notes/topics/reminders are injected so tests never touch the real apps.
const { parseDecision } = require("./brainDumpClassifier");

const DUMPS_FOLDER = "Brain dumps";
const PROCESSED_FOLDER = "Brain dumps - Processed";
const INBOX_FOLDER = "Inbox";
const ROUNDUPS_FOLDER = "Brain dumps - Roundups";

// Note times are SQLite CURRENT_TIMESTAMP (UTC, no zone) or ISO strings.
function toMillis(value) {
  const text = String(value ?? "");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
}

function ensureBrainDumpActionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_dump_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('note', 'grill', 'todo')),
      target_ref TEXT NOT NULL,
      from_folder_id INTEGER,
      created_at TEXT NOT NULL,
      undone_at TEXT
    )
  `);
}

function firstLine(text) {
  return (
    String(text ?? "")
      .split("\n")
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 80) ?? ""
  );
}

// Folder names match ignoring case and surrounding space, as the phone and the
// hub do; the stored folder (its own name and id) is always what is used.
const sameName = (a, b) =>
  String(a ?? "")
    .trim()
    .toLowerCase() ===
  String(b ?? "")
    .trim()
    .toLowerCase();

// Runs one call at a time; a call made while one is running gets `busy` back.
function createInFlightGuard(busy) {
  let running = false;
  return async (fn) => {
    if (running) return { ...busy };
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  };
}

function createBrainDumps({
  db,
  notes,
  topics,
  reminders,
  now = () => new Date(),
  log = (message, meta) => console.warn(message, meta),
}) {
  ensureBrainDumpActionsTable(db);

  const findFolder = (name) =>
    notes.getFolders().find((folder) => sameName(folder.name, name)) ?? null;
  const ensureFolder = (name) => findFolder(name) ?? notes.createFolder(name);
  // Folders Process never files into: the two dump folders and the roundups.
  const isDumpFolderName = (name) =>
    sameName(name, DUMPS_FOLDER) ||
    sameName(name, PROCESSED_FOLDER) ||
    sameName(name, ROUNDUPS_FOLDER);

  // True only while the note is live and still in the Brain dumps folder.
  function stillDump(noteId) {
    const note = notes.getNote(noteId);
    const dumps = findFolder(DUMPS_FOLDER);
    return Boolean(note && !note.deleted_at && dumps && note.folder_id === dumps.id);
  }

  function listDumps() {
    const folder = findFolder(DUMPS_FOLDER);
    if (!folder) return [];
    return [...notes.listNotesInFolder(folder.id)].sort(
      (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id
    );
  }

  // Folders the AI may file a note into: every folder except the dump and roundup folders.
  function targetFolderNames() {
    return notes
      .getFolders()
      .map((folder) => folder.name)
      .filter((name) => !isDumpFolderName(name));
  }

  async function applyDecision(note, decision) {
    const title = decision.title || note.title || firstLine(note.content) || "Brain dump";
    const text = decision.text || note.content || "";
    const fromFolderId = note.folder_id ?? null;
    const changed = { noteId: note.id, error: "Changed while processing" };
    let targetRef;
    let target;
    let compensate = async () => {};

    // The note may have moved or been deleted since listDumps (another run,
    // the phone): act only while it is still a live dump.
    if (!stillDump(note.id)) return changed;

    // Resolve the folder first, so a folder failure creates nothing.
    let folder;
    if (decision.kind === "grill" || decision.kind === "todo") {
      folder = ensureFolder(PROCESSED_FOLDER);
    } else {
      const match = isDumpFolderName(decision.folder) ? null : findFolder(decision.folder);
      folder = match ?? ensureFolder(INBOX_FOLDER);
      targetRef = folder.id;
      target = folder.name;
    }

    if (decision.kind === "grill") {
      targetRef = topics.addTopic({ text, source: "brain-dump", sourceRef: String(note.id) });
      target = "To grill";
      compensate = async () => topics.removeTopic(targetRef);
    } else if (decision.kind === "todo") {
      // A RemindersPermissionError throws here, before anything is touched.
      targetRef = (await reminders.addReminder({ title, notes: text })).id;
      target = "Reminders";
      compensate = async () => reminders.removeReminder(targetRef);
    }

    try {
      // addReminder can wait on osascript for a long time: check again.
      if (!stillDump(note.id)) {
        await compensate();
        return changed;
      }
      notes.moveNote(note.id, folder.id, decision.kind === "note" ? title : undefined);
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO brain_dump_actions (note_id, kind, target_ref, from_folder_id, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(note.id, decision.kind, String(targetRef), fromFolderId, now().toISOString());
      return { noteId: note.id, actionId: Number(lastInsertRowid), kind: decision.kind, target };
    } catch (error) {
      await compensate();
      throw error;
    }
  }

  // outputs: { [noteId]: the model's raw reply }. Every current dump runs in
  // order; a dump with no reply is left alone and reported.
  async function processAll(outputs = {}) {
    const results = [];
    for (const note of listDumps()) {
      const raw = outputs[note.id];
      if (typeof raw !== "string") {
        results.push({ noteId: note.id, error: "Not classified" });
        continue;
      }
      try {
        results.push(await applyDecision(note, parseDecision(raw)));
      } catch (error) {
        results.push({ noteId: note.id, error: error.message });
      }
    }
    return results;
  }

  async function undo(actionId) {
    const row = db.prepare("SELECT * FROM brain_dump_actions WHERE id = ?").get(actionId);
    if (!row) throw new Error("Brain dump action not found");
    if (row.undone_at) return { undone: false };
    // The topic or reminder may be the only live copy of the dump: move the
    // note back first, and remove the copy only once that has succeeded.
    const note = notes.getNote(row.note_id);
    if (!note || note.deleted_at) {
      return { undone: false, error: "The original note is missing or deleted" };
    }
    notes.moveNote(row.note_id, ensureFolder(DUMPS_FOLDER).id);
    try {
      if (row.kind === "grill") topics.removeTopic(row.target_ref);
      if (row.kind === "todo") await reminders.removeReminder(row.target_ref);
    } catch (error) {
      log("Brain dump undo: could not remove the copy", {
        actionId: row.id,
        kind: row.kind,
        targetRef: row.target_ref,
        error: error.message,
      });
    }
    db.prepare("UPDATE brain_dump_actions SET undone_at = ? WHERE id = ?").run(
      now().toISOString(),
      row.id
    );
    return { undone: true };
  }

  function listActions({ since } = {}) {
    return db
      .prepare(
        `SELECT * FROM brain_dump_actions WHERE created_at >= ? ORDER BY created_at DESC, id DESC`
      )
      .all(since ? String(since) : "");
  }

  // Daily roundup input (summary only): dumps in either dump folder or already
  // filed elsewhere, and what Process did with them. With afterNoteId the dumps
  // are the ones that ARRIVED after it (local note id), so a phone dump synced
  // after a run is still picked up even though its created_at is older. Without
  // it (first run) dumps created since sinceIso are used. lastNoteId is the
  // cursor for the next run.
  function roundupContext(sinceIso, afterNoteId) {
    const since = Date.parse(String(sinceIso));
    if (Number.isNaN(since)) throw new Error("Invalid roundup start time");
    const rows = listActions({ since: new Date(since).toISOString() }).filter((r) => !r.undone_at);
    const folders = notes.getFolders();
    const folderName = (id) => folders.find((f) => f.id === id)?.name ?? "";
    const dumpFolderIds = folders
      .filter((f) => f.name === DUMPS_FOLDER || f.name === PROCESSED_FOLDER)
      .map((f) => f.id);
    const filedFolderIds = rows.filter((r) => r.kind === "note").map((r) => Number(r.target_ref));
    const byId = new Map();
    for (const id of new Set([...dumpFolderIds, ...filedFolderIds])) {
      for (const note of notes.listNotesInFolder(id)) byId.set(note.id, note);
    }
    const actedOn = new Set(rows.map((r) => r.note_id));
    const after = Number.isInteger(afterNoteId) ? afterNoteId : null;
    const isNew = (n) => (after === null ? toMillis(n.created_at) >= since : n.id > after);
    const lastNoteId = Math.max(after ?? 0, ...[...byId.keys()].map(Number));
    const dumps = [...byId.values()]
      .filter((n) => (dumpFolderIds.includes(n.folder_id) || actedOn.has(n.id)) && isNew(n))
      .sort((a, b) => toMillis(a.created_at) - toMillis(b.created_at) || a.id - b.id)
      .map((n) => ({ title: n.title || "", content: n.content || "", createdAt: n.created_at }));
    const targets = { grill: "To grill", todo: "Reminders" };
    const actions = rows.map((r) => {
      const note = byId.get(r.note_id);
      return {
        kind: r.kind,
        target: targets[r.kind] ?? folderName(Number(r.target_ref)),
        title: note?.title || firstLine(note?.content),
        createdAt: r.created_at,
      };
    });
    return { dumps, actions, lastNoteId };
  }

  function saveRoundup(title, content) {
    if (!String(title ?? "").trim()) throw new Error("A roundup needs a title");
    const folder = ensureFolder(ROUNDUPS_FOLDER);
    return { note: notes.createNote(String(title), String(content ?? ""), folder.id) };
  }

  return {
    listDumps,
    targetFolderNames,
    applyDecision,
    processAll,
    undo,
    listActions,
    roundupContext,
    saveRoundup,
  };
}

module.exports = {
  createBrainDumps,
  createInFlightGuard,
  ensureBrainDumpActionsTable,
  DUMPS_FOLDER,
  PROCESSED_FOLDER,
  INBOX_FOLDER,
  ROUNDUPS_FOLDER,
};
