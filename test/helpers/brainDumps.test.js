const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrainDumps, createInFlightGuard } = require("../../src/helpers/brainDumps.js");
const { RemindersPermissionError } = require("../../src/helpers/remindersBridge.js");

function createDb(t) {
  try {
    const BetterSqlite = require("better-sqlite3");
    return new BetterSqlite(":memory:");
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("NODE_MODULE_VERSION") || message.includes("bindings file")) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

// Fakes for the notes, grill topics and Reminders the engine drives.
function setup(
  t,
  { reminderError, folderNames = ["Brain dumps", "Work"], createFolderError, onAddReminder } = {}
) {
  const db = createDb(t);
  if (!db) return null;
  const folders = folderNames.map((name, i) => ({ id: i + 1, name }));
  const calls = [];
  const notes = [
    { id: 10, title: "", content: "second", folder_id: 1, created_at: "2026-09-30 10:00:00" },
    { id: 11, title: "", content: "first", folder_id: 1, created_at: "2026-09-30 09:00:00" },
    { id: 12, title: "other", content: "x", folder_id: 2, created_at: "2026-09-30 08:00:00" },
  ];
  const created = [];
  const notesApi = {
    getFolders: () => folders.map((f) => ({ ...f })),
    createFolder: (name) => {
      if (createFolderError) throw createFolderError;
      const folder = { id: folders.length + 1, name };
      folders.push(folder);
      created.push(name);
      return folder;
    },
    getNote: (id) => {
      const note = notes.find((n) => n.id === id);
      return note ? { ...note } : null;
    },
    listNotesInFolder: (folderId) => notes.filter((n) => n.folder_id === folderId),
    moveNote: (id, folderId, title) => {
      calls.push(`move:${id}`);
      const note = notes.find((n) => n.id === id);
      note.folder_id = folderId;
      if (title !== undefined) note.title = title;
    },
    createNote: (title, content, folderId) => {
      const note = { id: 100 + notes.length, title, content, folder_id: folderId };
      notes.push(note);
      return note;
    },
  };
  const topics = new Map();
  const topicsApi = {
    addTopic: (topic) => {
      const id = `gt-${topics.size + 1}`;
      topics.set(id, topic);
      return id;
    },
    removeTopic: (id) => {
      calls.push(`removeTopic:${id}`);
      topics.delete(id);
    },
  };
  const reminders = new Map();
  const remindersApi = {
    addReminder: async (reminder) => {
      if (reminderError) throw reminderError;
      const id = `rem-${reminders.size + 1}`;
      reminders.set(id, reminder);
      onAddReminder?.({ notes, reminder });
      return { id };
    },
    removeReminder: async (id) => {
      calls.push(`removeReminder:${id}`);
      reminders.delete(id);
    },
  };
  const engine = createBrainDumps({
    db,
    notes: notesApi,
    topics: topicsApi,
    reminders: remindersApi,
  });
  const folderOf = (noteId) =>
    folders.find((f) => f.id === notes.find((n) => n.id === noteId).folder_id).name;
  return { db, engine, notes, notesApi, topics, reminders, created, calls, folderOf };
}

const rows = (db) => db.prepare("SELECT * FROM brain_dump_actions ORDER BY id").all();

test("listDumps returns only Brain dumps notes, oldest first", (t) => {
  const s = setup(t);
  if (!s) return;
  assert.deepEqual(
    s.engine.listDumps().map((n) => n.id),
    [11, 10]
  );
});

test("note: moves the dump into an existing folder and sets its title", async (t) => {
  const s = setup(t);
  if (!s) return;
  const note = s.notes.find((n) => n.id === 10);
  const result = await s.engine.applyDecision(note, {
    kind: "note",
    folder: "Work",
    title: "Idea",
    text: "second",
  });
  assert.equal(s.folderOf(10), "Work");
  assert.equal(note.title, "Idea");
  assert.equal(result.target, "Work");
  assert.deepEqual(s.created, []);
  const [row] = rows(s.db);
  assert.equal(row.id, result.actionId);
  assert.equal(row.note_id, 10);
  assert.equal(row.kind, "note");
  assert.equal(row.target_ref, "2");
  assert.equal(row.from_folder_id, 1);
  assert.equal(row.undone_at, null);
});

test("note: an unknown folder goes to Inbox, created once", async (t) => {
  const s = setup(t);
  if (!s) return;
  const decision = { kind: "note", folder: "Nope", title: "t", text: "x" };
  await s.engine.applyDecision(s.notes[0], decision);
  await s.engine.applyDecision(s.notes[1], { ...decision, folder: "" });
  assert.equal(s.folderOf(10), "Inbox");
  assert.equal(s.folderOf(11), "Inbox");
  assert.deepEqual(s.created, ["Inbox"]);
});

test("grill: adds a topic and moves the dump to Processed", async (t) => {
  const s = setup(t);
  if (!s) return;
  const decision = { kind: "grill", title: "Pricing", text: "should we raise it" };
  const result = await s.engine.applyDecision(s.notes[0], decision);
  await s.engine.applyDecision(s.notes[1], decision);
  const [topicId] = s.topics.keys();
  assert.deepEqual(s.topics.get(topicId), {
    text: "should we raise it",
    source: "brain-dump",
    sourceRef: "10",
  });
  assert.equal(s.folderOf(10), "Brain dumps - Processed");
  assert.deepEqual(s.created, ["Brain dumps - Processed"]);
  assert.equal(rows(s.db)[0].target_ref, topicId);
  assert.equal(result.kind, "grill");
});

test("todo: adds a reminder and moves the dump to Processed", async (t) => {
  const s = setup(t);
  if (!s) return;
  const result = await s.engine.applyDecision(s.notes[0], {
    kind: "todo",
    title: "Call Bob",
    text: "about the quote",
  });
  assert.deepEqual(s.reminders.get("rem-1"), { title: "Call Bob", notes: "about the quote" });
  assert.equal(s.folderOf(10), "Brain dumps - Processed");
  assert.equal(rows(s.db)[0].target_ref, "rem-1");
  assert.equal(result.kind, "todo");
});

test("undo reverses each kind and moves the dump back", async (t) => {
  const s = setup(t);
  if (!s) return;
  const a = await s.engine.applyDecision(s.notes[0], { kind: "grill", title: "t", text: "x" });
  const b = await s.engine.applyDecision(s.notes[1], { kind: "todo", title: "t", text: "x" });
  s.notes[2].folder_id = 1; // a third dump
  const c = await s.engine.applyDecision(s.notes[2], {
    kind: "note",
    folder: "Work",
    title: "t",
    text: "x",
  });
  for (const r of [a, b, c]) assert.equal((await s.engine.undo(r.actionId)).undone, true);
  assert.equal(s.topics.size, 0);
  assert.equal(s.reminders.size, 0);
  for (const id of [10, 11, 12]) assert.equal(s.folderOf(id), "Brain dumps");
  assert.ok(rows(s.db).every((row) => row.undone_at));
});

test("undo twice is a no-op", async (t) => {
  const s = setup(t);
  if (!s) return;
  const r = await s.engine.applyDecision(s.notes[0], { kind: "grill", title: "t", text: "x" });
  await s.engine.undo(r.actionId);
  const stamp = rows(s.db)[0].undone_at;
  s.topics.set("keep", {});
  const again = await s.engine.undo(r.actionId);
  assert.equal(again.undone, false);
  assert.equal(rows(s.db)[0].undone_at, stamp);
  assert.equal(s.topics.size, 1);
});

test("a Reminders permission error leaves the dump untouched", async (t) => {
  const s = setup(t, { reminderError: new RemindersPermissionError(new Error("-1743")) });
  if (!s) return;
  await assert.rejects(
    s.engine.applyDecision(s.notes[0], { kind: "todo", title: "t", text: "x" }),
    RemindersPermissionError
  );
  assert.equal(s.folderOf(10), "Brain dumps");
  assert.equal(rows(s.db).length, 0);
  // Processed is resolved before the reminder (#404); the dump is not moved.
  assert.deepEqual(s.created, ["Brain dumps - Processed"]);
});

test("processAll files every dump and reports a permission error per dump", async (t) => {
  const s = setup(t, { reminderError: new RemindersPermissionError(new Error("-1743")) });
  if (!s) return;
  const results = await s.engine.processAll({
    10: '{"kind":"todo","title":"t","text":"x"}',
    11: "garbage",
  });
  assert.deepEqual(
    results.map((r) => [r.noteId, r.kind ?? null, r.target ?? null, Boolean(r.error)]),
    [
      [11, "note", "Inbox", false],
      [10, null, null, true],
    ]
  );
  assert.equal(s.folderOf(10), "Brain dumps");
  assert.equal(s.notes.find((n) => n.id === 11).title, "first");
  assert.deepEqual(
    s.engine.listActions({ since: "2000-01-01" }).map((a) => a.note_id),
    [11]
  );
});

test("roundupContext: new dumps from both dump folders and filed ones, readable actions", async (t) => {
  const s = setup(t);
  if (!s) return;
  s.notes.push(
    { id: 13, title: "", content: "old", folder_id: 1, created_at: "2026-09-29 08:00:00" },
    { id: 14, title: "", content: "filed", folder_id: 1, created_at: "2026-09-30 11:00:00" },
    {
      id: 15,
      title: "work",
      content: "not a dump",
      folder_id: 2,
      created_at: "2026-09-30 12:00:00",
    }
  );
  await s.engine.applyDecision(s.notes[0], { kind: "grill", title: "g", text: "second" });
  const filed = s.notes.find((n) => n.id === 14);
  await s.engine.applyDecision(filed, { kind: "note", folder: "Work", title: "Filed", text: "x" });
  const undone = await s.engine.applyDecision(s.notes[1], { kind: "todo", title: "t", text: "x" });
  await s.engine.undo(undone.actionId);

  const context = s.engine.roundupContext("2026-09-30T09:30:00.000Z");
  assert.deepEqual(
    context.dumps.map((d) => d.content),
    ["second", "filed"]
  );
  assert.deepEqual(context.actions.map((a) => [a.kind, a.target, a.title]).sort(), [
    ["grill", "To grill", "second"],
    ["note", "Work", "Filed"],
  ]);
  assert.throws(() => s.engine.roundupContext("not a date"));
});

test("roundupContext: a dump synced after the last run is included though its created_at is older (review desktop-pr-396)", (t) => {
  const s = setup(t);
  if (!s) return;
  const first = s.engine.roundupContext("2026-09-30T09:30:00.000Z");
  assert.equal(first.lastNoteId, 11);
  // A phone dump captured at 09:20 arrives by sync after the 09:30 run.
  s.notes.push({
    id: 20,
    title: "",
    content: "late phone dump",
    folder_id: 1,
    created_at: "2026-09-30 09:20:00",
  });
  const next = s.engine.roundupContext("2026-09-30T23:00:00.000Z", first.lastNoteId);
  assert.deepEqual(
    next.dumps.map((d) => d.content),
    ["late phone dump"]
  );
  assert.equal(next.lastNoteId, 20);
  const after = s.engine.roundupContext("2026-09-30T23:00:00.000Z", next.lastNoteId);
  assert.deepEqual(after.dumps, []);
  assert.equal(after.lastNoteId, 20);
});

test("saveRoundup: creates the Roundups folder once and saves the note there", (t) => {
  const s = setup(t);
  if (!s) return;
  s.engine.saveRoundup("Roundup 2026-09-30 morning", "summary");
  const { note } = s.engine.saveRoundup("Roundup 2026-09-30 night", "summary 2");
  assert.deepEqual(s.created, ["Brain dumps - Roundups"]);
  assert.equal(s.folderOf(note.id), "Brain dumps - Roundups");
  assert.equal(note.title, "Roundup 2026-09-30 night");
  assert.throws(() => s.engine.saveRoundup("", "x"));
});

test("folder names match ignoring case and keep the stored name (#405)", async (t) => {
  const s = setup(t, { folderNames: ["brain dumps", "Work", "BRAIN DUMPS - processed"] });
  if (!s) return;
  assert.deepEqual(
    s.engine.listDumps().map((n) => n.id),
    [11, 10]
  );
  assert.deepEqual(s.engine.targetFolderNames(), ["Work"]);
  const r = await s.engine.applyDecision(s.notes[0], {
    kind: "note",
    folder: "work",
    title: "t",
    text: "x",
  });
  assert.equal(r.target, "Work");
  assert.equal(s.folderOf(10), "Work");
  await s.engine.applyDecision(s.notes[1], { kind: "grill", title: "t", text: "x" });
  assert.equal(s.folderOf(11), "BRAIN DUMPS - processed");
  await s.engine.undo(r.actionId);
  assert.equal(s.folderOf(10), "brain dumps");
  assert.deepEqual(s.created, []);
});

test("a second Process while one runs is refused (#403)", async () => {
  const guard = createInFlightGuard({ success: false, error: "Already processing" });
  let release;
  const first = guard(() => new Promise((resolve) => (release = resolve)));
  assert.deepEqual(await guard(async () => "ran"), {
    success: false,
    error: "Already processing",
  });
  release("first");
  assert.equal(await first, "first");
  assert.equal(await guard(async () => "again"), "again");
});

test("a dump moved out of Brain dumps mid-run is skipped (#403)", async (t) => {
  const s = setup(t, {
    onAddReminder: ({ notes }) => {
      notes.find((n) => n.id === 10).folder_id = 2;
    },
  });
  if (!s) return;
  const results = await s.engine.processAll({
    11: '{"kind":"todo","title":"t","text":"x"}',
    10: '{"kind":"note","folder":"Inbox","title":"t","text":"x"}',
  });
  assert.deepEqual(results[1], { noteId: 10, error: "Changed while processing" });
  assert.equal(s.folderOf(10), "Work");
  assert.deepEqual(
    rows(s.db).map((r) => r.note_id),
    [11]
  );
});

test("a dump moved during its own reminder is left alone and the reminder removed (#403)", async (t) => {
  const s = setup(t, {
    onAddReminder: ({ notes }) => {
      notes.find((n) => n.id === 10).deleted_at = "2026-09-30 11:00:00";
    },
  });
  if (!s) return;
  const r = await s.engine.applyDecision(s.notes[0], { kind: "todo", title: "t", text: "x" });
  assert.deepEqual(r, { noteId: 10, error: "Changed while processing" });
  assert.equal(s.reminders.size, 0);
  assert.equal(s.folderOf(10), "Brain dumps");
  assert.equal(rows(s.db).length, 0);
});

test("a folder failure creates no topic or reminder (#404)", async (t) => {
  const s = setup(t, { createFolderError: new Error("A folder with that name already exists") });
  if (!s) return;
  for (const kind of ["grill", "todo"]) {
    await assert.rejects(
      s.engine.applyDecision(s.notes[0], { kind, title: "t", text: "x" }),
      /already exists/
    );
  }
  assert.equal(s.topics.size, 0);
  assert.equal(s.reminders.size, 0);
  assert.equal(rows(s.db).length, 0);
});

test("undo on a deleted note refuses and keeps the reminder (#402)", async (t) => {
  const s = setup(t);
  if (!s) return;
  const r = await s.engine.applyDecision(s.notes[0], { kind: "todo", title: "t", text: "x" });
  s.notes[0].deleted_at = "2026-09-30 12:00:00";
  const result = await s.engine.undo(r.actionId);
  assert.equal(result.undone, false);
  assert.ok(result.error);
  assert.equal(s.reminders.size, 1);
  assert.equal(rows(s.db)[0].undone_at, null);
});

test("undo moves the note back before removing the topic or reminder (#402)", async (t) => {
  const s = setup(t);
  if (!s) return;
  const a = await s.engine.applyDecision(s.notes[0], { kind: "grill", title: "t", text: "x" });
  const b = await s.engine.applyDecision(s.notes[1], { kind: "todo", title: "t", text: "x" });
  s.calls.length = 0;
  await s.engine.undo(a.actionId);
  await s.engine.undo(b.actionId);
  assert.deepEqual(s.calls, ["move:10", "removeTopic:gt-1", "move:11", "removeReminder:rem-1"]);
});

test("undo keeps the reminder when the move back fails (#402)", async (t) => {
  const s = setup(t);
  if (!s) return;
  const r = await s.engine.applyDecision(s.notes[0], { kind: "todo", title: "t", text: "x" });
  s.notesApi.moveNote = () => {
    throw new Error("Note not found");
  };
  await assert.rejects(s.engine.undo(r.actionId), /Note not found/);
  assert.equal(s.reminders.size, 1);
  assert.equal(rows(s.db)[0].undone_at, null);
});

test("Process never files into the Roundups folder, whatever its case", async (t) => {
  const s = setup(t, { folderNames: ["Brain dumps", "Work", "brain dumps - ROUNDUPS"] });
  if (!s) return;
  assert.deepEqual(s.engine.targetFolderNames(), ["Work"]);
  const r = await s.engine.applyDecision(s.notes[0], {
    kind: "note",
    folder: "Brain dumps - Roundups",
    title: "t",
    text: "x",
  });
  assert.equal(r.target, "Inbox");
});
