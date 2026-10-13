const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/services/grill/grillSession.ts");
const { GRILL_FOLDER_NAME, LIFE_STORY_FOLDER_NAME } = require("../../src/helpers/grillFolders.js");

const NOW = new Date(2026, 8, 26, 10, 0, 0);
const DAILY = {
  kind: "daily",
  date: "2026-09-26",
  dayQuestions: ["You met Dana Park about Q3 pricing. What surprised you?"],
  standardQuestions: ["What happened yesterday that surprised you?"],
};

const MESSAGES = [
  { id: "1", role: "assistant", content: DAILY.dayQuestions[0], isStreaming: false },
  { id: "2", role: "user", content: "She wanted annual billing.", isStreaming: false },
  { id: "3", role: "assistant", content: "Who was it, roughly?", isStreaming: false },
  { id: "4", role: "user", content: "Their CFO.", isStreaming: false },
  { id: "5", role: "assistant", content: "", isStreaming: true },
  { id: "6", role: "tool", content: "ignored", isStreaming: false },
];

test("plans a daily session: day questions first, first question is sent by the interviewer", async () => {
  const { planGrillSession } = await load();
  const plan = planGrillSession(
    { kind: "daily" },
    {
      now: NOW,
      events: [],
      meetingNotes: [
        {
          id: 1,
          title: "Vendor call",
          note_type: "meeting",
          created_at: new Date(2026, 8, 26, 8).toISOString().replace("T", " ").slice(0, 19),
          participants: JSON.stringify([{ displayName: "Sam Ortiz" }]),
          transcript: null,
        },
      ],
    }
  );
  assert.equal(plan.spec.kind, "daily");
  assert.equal(plan.spec.date, "2026-09-26");
  assert.deepEqual(plan.spec.dayQuestions, [
    "You met Sam Ortiz about Vendor call. What surprised you?",
  ]);
  assert.equal(plan.spec.standardQuestions.length, 8);
  assert.equal(plan.firstQuestion, plan.spec.dayQuestions[0]);
  assert.equal(plan.conversationTitle, "Grill 2026-09-26");
});

test("a daily session with no context opens on a standard question", async () => {
  const { planGrillSession } = await load();
  const plan = planGrillSession({ kind: "daily" }, { now: NOW, events: [], meetingNotes: [] });
  assert.deepEqual(plan.spec.dayQuestions, []);
  assert.equal(plan.firstQuestion, plan.spec.standardQuestions[0]);
});

test("plans a lifetime chapter session on the chapter's first question", async () => {
  const { planGrillSession } = await load();
  const plan = planGrillSession({ kind: "lifetime", chapter: 2 }, { now: NOW });
  assert.deepEqual(plan.spec, { kind: "lifetime", chapter: 2 });
  assert.equal(plan.firstQuestion, "What was your first paid job?");
  assert.equal(plan.conversationTitle, "Life Story ch 2: First jobs");
  assert.throws(() => planGrillSession({ kind: "lifetime" }, { now: NOW }), /chapter/);
});

test("a daily session saves to Grill as 'Grill YYYY-MM-DD' with role and text per turn", async () => {
  const { buildGrillSessionNote } = await load();
  const note = buildGrillSessionNote(DAILY, MESSAGES, NOW);

  assert.equal(note.title, "Grill 2026-09-26");
  assert.equal(note.folderName, GRILL_FOLDER_NAME);
  assert.equal(note.noteType, "personal");
  assert.deepEqual(note.turns, [
    { role: "assistant", text: DAILY.dayQuestions[0] },
    { role: "user", text: "She wanted annual billing." },
    { role: "assistant", text: "Who was it, roughly?" },
    { role: "user", text: "Their CFO." },
  ]);
  const stored = JSON.parse(note.transcript);
  assert.deepEqual(
    stored.map((s) => [s.role, s.text, s.source]),
    [
      ["assistant", DAILY.dayQuestions[0], "system"],
      ["user", "She wanted annual billing.", "mic"],
      ["assistant", "Who was it, roughly?", "system"],
      ["user", "Their CFO.", "mic"],
    ]
  );
  assert.equal(
    note.content,
    [
      `**Q:** ${DAILY.dayQuestions[0]}`,
      "**A:** She wanted annual billing.",
      "**Q:** Who was it, roughly?",
      "**A:** Their CFO.",
    ].join("\n\n")
  );
});

test("a lifetime session saves to Life Story as 'Life Story ch N: <title>'", async () => {
  const { buildGrillSessionNote } = await load();
  const note = buildGrillSessionNote({ kind: "lifetime", chapter: 7 }, MESSAGES.slice(0, 2), NOW);
  assert.equal(note.title, 'Life Story ch 7: Why "extend and enhance"');
  assert.equal(note.folderName, LIFE_STORY_FOLDER_NAME);
  assert.equal(note.turns.length, 2);
});

const SPACES = [
  { id: 1, kind: "private", name: "Personal" },
  { id: 2, kind: "team", name: "Acme" },
];

test("saving writes the note into the personal-space folder and stores the turns", async () => {
  const { buildGrillSessionNote, saveGrillSessionNote } = await load();
  const calls = [];
  const api = {
    getSpaces: async () => SPACES,
    getFolders: async (...args) => {
      calls.push(["getFolders", ...args]);
      return [
        { id: 3, name: "Grill", is_default: 1, space_id: 2 },
        { id: 4, name: "Grill", is_default: 0, space_id: 1 },
      ];
    },
    saveNote: async (...args) => {
      calls.push(["saveNote", ...args]);
      return { success: true, note: { id: 42 } };
    },
    updateNote: async (...args) => {
      calls.push(["updateNote", ...args]);
      return { success: true, note: { id: 42 } };
    },
  };
  const note = buildGrillSessionNote(DAILY, MESSAGES, NOW);
  const saved = await saveGrillSessionNote(note, api);
  assert.deepEqual(saved, { success: true, id: 42, turnsSaved: true });
  assert.deepEqual(calls, [
    ["getFolders", 1],
    ["saveNote", note.title, note.content, "personal", null, null, 4],
    ["updateNote", 42, { transcript: note.transcript }],
  ]);
});

// A fake notes API: records every call, and each method can be overridden.
function fakeNotesApi(overrides = {}) {
  const calls = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args]);
      return typeof result === "function" ? result(...args) : result;
    };
  const api = {
    getSpaces: record("getSpaces", SPACES),
    getFolders: record("getFolders", [{ id: 4, name: "Grill", is_default: 0, space_id: 1 }]),
    createFolder: record("createFolder", (name) => ({
      success: true,
      folder: { id: 9, name, is_default: 0 },
    })),
    saveNote: record("saveNote", { success: true, note: { id: 42 } }),
    updateNote: record("updateNote", { success: true, note: { id: 42 } }),
  };
  for (const [name, result] of Object.entries(overrides)) api[name] = record(name, result);
  return { api, calls, names: () => calls.map((c) => c[0]) };
}

function fakeNotify() {
  const events = [];
  return {
    events,
    notify: {
      saved: () => events.push(["saved"]),
      savedWithoutTurns: () => events.push(["savedWithoutTurns"]),
      failed: (reason) => events.push(["failed", reason]),
    },
  };
}

test("a failed turns update is retried once; a retry that works is a plain save", async () => {
  const { buildGrillSessionNote, finishGrillSession } = await load();
  let attempts = 0;
  const { api, names } = fakeNotesApi({
    updateNote: () =>
      ++attempts === 1 ? { success: false, error: "busy" } : { success: true, note: { id: 42 } },
  });
  const { events, notify } = fakeNotify();
  const result = await finishGrillSession(buildGrillSessionNote(DAILY, MESSAGES, NOW), api, notify);
  assert.deepEqual(result, { success: true, id: 42, turnsSaved: true });
  assert.equal(names().filter((n) => n === "updateNote").length, 2);
  assert.deepEqual(events, [["saved"]]);
});

test("turns that still fail after the retry keep the note and say it was saved without them", async () => {
  const { buildGrillSessionNote, finishGrillSession } = await load();
  const { api, names } = fakeNotesApi({
    updateNote: () => {
      throw new Error("disk full");
    },
  });
  const { events, notify } = fakeNotify();
  const result = await finishGrillSession(buildGrillSessionNote(DAILY, MESSAGES, NOW), api, notify);
  assert.deepEqual(result, { success: true, id: 42, turnsSaved: false });
  assert.equal(names().filter((n) => n === "updateNote").length, 2);
  assert.ok(!names().includes("deleteNote"), "the saved note is kept");
  assert.deepEqual(events, [["savedWithoutTurns"]], "never 'not saved' when the note was saved");
});

test("the English text for a note saved without its turns", () => {
  const en = require("../../src/locales/en/translation.json");
  assert.equal(
    en.chat.grill.savedWithoutTurns,
    "Grill saved without its turns; the connector can't send it until you re-save"
  );
});

test("a thrown or unsuccessful saveNote is a failed save, and updateNote never runs", async () => {
  const { buildGrillSessionNote, finishGrillSession } = await load();
  const note = buildGrillSessionNote(DAILY, MESSAGES, NOW);

  const refused = fakeNotesApi({ saveNote: { success: false } });
  const refusedToasts = fakeNotify();
  const r1 = await finishGrillSession(note, refused.api, refusedToasts.notify);
  assert.equal(r1.success, false);
  assert.ok(!refused.names().includes("updateNote"));
  assert.equal(refusedToasts.events.length, 1);
  assert.equal(refusedToasts.events[0][0], "failed");

  const thrown = fakeNotesApi({
    saveNote: () => {
      throw new Error("db locked");
    },
  });
  const thrownToasts = fakeNotify();
  const r2 = await finishGrillSession(note, thrown.api, thrownToasts.notify);
  assert.deepEqual(r2, { success: false, error: "db locked" });
  assert.deepEqual(thrownToasts.events, [["failed", "db locked"]]);
});

test("a successful save shows the saved toast once", async () => {
  const { buildGrillSessionNote, finishGrillSession } = await load();
  const { api } = fakeNotesApi();
  const { events, notify } = fakeNotify();
  const result = await finishGrillSession(buildGrillSessionNote(DAILY, MESSAGES, NOW), api, notify);
  assert.deepEqual(result, { success: true, id: 42, turnsSaved: true });
  assert.deepEqual(events, [["saved"]]);
});

test("a missing target folder is created first; the note never falls back to another folder", async () => {
  const { buildGrillSessionNote, saveGrillSessionNote } = await load();
  const { api, calls } = fakeNotesApi({
    getFolders: [{ id: 1, name: "Personal", is_default: 1, space_id: 1 }],
  });
  const note = buildGrillSessionNote({ kind: "lifetime", chapter: 2 }, MESSAGES, NOW);
  const saved = await saveGrillSessionNote(note, api);
  assert.deepEqual(saved, { success: true, id: 42, turnsSaved: true });
  assert.deepEqual(calls[2], ["createFolder", "Life Story", 1]);
  assert.deepEqual(calls[3], ["saveNote", note.title, note.content, "personal", null, null, 9]);
});

test("a folder that cannot be created fails the save; nothing lands in Personal or no folder", async () => {
  const { buildGrillSessionNote, finishGrillSession } = await load();
  const { api, names } = fakeNotesApi({
    getFolders: [{ id: 1, name: "Personal", is_default: 1, space_id: 1 }],
    createFolder: { success: false, error: "Space not found" },
  });
  const { events, notify } = fakeNotify();
  const result = await finishGrillSession(buildGrillSessionNote(DAILY, MESSAGES, NOW), api, notify);
  assert.equal(result.success, false);
  assert.match(result.error, /Space not found/);
  assert.ok(!names().includes("saveNote"));
  assert.deepEqual(events, [["failed", result.error]]);
});

test("leaving a grill saves the note and shows 'Grill saved' before it leaves", async () => {
  const { leaveGrillSession } = await load();
  const { api, names } = fakeNotesApi();
  const order = [];
  const result = await leaveGrillSession({
    spec: DAILY,
    messages: MESSAGES,
    api,
    notify: { saved: () => order.push("saved"), failed: (r) => order.push(`failed ${r}`) },
    leave: () => order.push(`leave after ${names().join(",")}`),
  });
  assert.deepEqual(result, { success: true, id: 42, turnsSaved: true });
  assert.deepEqual(order, ["saved", "leave after getSpaces,getFolders,saveNote,updateNote"]);
});

test("leaving a grill whose save fails still says so before it leaves", async () => {
  const { leaveGrillSession } = await load();
  const { api } = fakeNotesApi({ saveNote: { success: false } });
  const order = [];
  const result = await leaveGrillSession({
    spec: DAILY,
    messages: MESSAGES,
    api,
    notify: { saved: () => order.push("saved"), failed: () => order.push("failed") },
    leave: () => order.push("leave"),
  });
  assert.equal(result.success, false);
  assert.deepEqual(order, ["failed", "leave"]);
});

test("the English toasts read 'Grill saved' and 'Grill not saved: <reason>'", () => {
  const en = require("../../src/locales/en/translation.json");
  assert.equal(en.chat.grill.saved, "Grill saved");
  assert.equal(en.chat.grill.notSaved, "Grill not saved: {{reason}}");
  assert.equal(
    en.chat.grill.contextFailed,
    "Couldn't read your calendar or notes; starting with standard questions."
  );
});

test("a day-context read failure is logged and the session opens with a visible note first", async () => {
  const { gatherGrillDayContext, planGrillSession, buildGrillOpeningMessages } = await load();
  const logged = [];
  const log = { warn: (message, meta) => logged.push([message, meta?.error]) };
  const context = await gatherGrillDayContext(
    {
      grillGetCalendarEvents: async () => {
        throw new Error("calendar db gone");
      },
      getNotes: async () => {
        throw new Error("notes db gone");
      },
    },
    NOW,
    log
  );
  assert.equal(context.contextFailed, true);
  assert.deepEqual(logged.map((l) => l[1]).sort(), ["calendar db gone", "notes db gone"]);

  const plan = planGrillSession({ kind: "daily" }, context);
  const opening = buildGrillOpeningMessages(plan, {
    contextFailed: context.contextFailed,
    contextFailedNote: "Couldn't read your calendar or notes; starting with standard questions.",
  });
  assert.deepEqual(
    opening.filter((m) => m.display !== "hidden").map((m) => [m.display ?? "message", m.content]),
    [
      ["notice", "Couldn't read your calendar or notes; starting with standard questions."],
      ["message", plan.firstQuestion],
    ]
  );
});

test("an unsuccessful calendar result also counts as a failed day context", async () => {
  const { gatherGrillDayContext } = await load();
  const logged = [];
  const context = await gatherGrillDayContext(
    {
      grillGetCalendarEvents: async () => ({ success: false, events: [] }),
      getNotes: async () => [],
    },
    NOW,
    { warn: (message) => logged.push(message) }
  );
  assert.equal(context.contextFailed, true);
  assert.equal(logged.length, 1);
});

test("a readable day context opens with no note", async () => {
  const { gatherGrillDayContext, planGrillSession, buildGrillOpeningMessages } = await load();
  const context = await gatherGrillDayContext(
    {
      grillGetCalendarEvents: async () => ({ success: true, events: [] }),
      getNotes: async () => [],
    },
    NOW,
    { warn: () => assert.fail("nothing to log") }
  );
  assert.equal(context.contextFailed, false);
  const opening = buildGrillOpeningMessages(planGrillSession({ kind: "daily" }, context), {
    contextFailed: false,
    contextFailedNote: "x",
  });
  assert.ok(opening.every((m) => m.display !== "notice"));
});

test("the model-facing history starts with a user turn that starts the grill", async () => {
  const { planGrillSession, buildGrillOpeningMessages, buildGrillModelHistory } = await load();
  const daily = planGrillSession({ kind: "daily" }, { now: NOW, events: [], meetingNotes: [] });
  const opening = buildGrillOpeningMessages(daily, {
    contextFailed: true,
    contextFailedNote: "note",
  });
  assert.deepEqual(opening[0], {
    role: "user",
    content: "Start my daily grill.",
    display: "hidden",
  });

  // The first request: the opening plus the user's first answer.
  const first = buildGrillModelHistory(daily.spec, [
    ...opening,
    { role: "user", content: "It went fine." },
  ]);
  assert.deepEqual(first, [
    { role: "user", content: "Start my daily grill." },
    { role: "assistant", content: daily.firstQuestion },
    { role: "user", content: "It went fine." },
  ]);

  const lifetime = planGrillSession({ kind: "lifetime", chapter: 3 }, { now: NOW });
  const lifetimeOpening = buildGrillOpeningMessages(lifetime, { contextFailed: false });
  assert.equal(lifetimeOpening[0].content, "Start my lifetime chapter 3 grill.");
  assert.equal(buildGrillModelHistory(lifetime.spec, lifetimeOpening)[0].role, "user");
});

test("a long grill still sends a user turn first after the history window slides", async () => {
  const { buildGrillModelHistory } = await load();
  const long = [];
  for (let i = 0; i < 15; i++) {
    long.push({ role: "assistant", content: `Q${i}` }, { role: "user", content: `A${i}` });
  }
  const history = buildGrillModelHistory(DAILY, long);
  assert.equal(history[0].role, "user");
  assert.equal(history[0].content, "Start my daily grill.");
  assert.equal(history[1].role, "assistant");
  assert.equal(history.at(-1).content, "A14");
});

test("hidden and notice messages never reach the saved note", async () => {
  const { buildGrillSessionNote } = await load();
  const note = buildGrillSessionNote(
    DAILY,
    [
      { role: "user", content: "Start my daily grill.", display: "hidden" },
      { role: "assistant", content: "Couldn't read your calendar.", display: "notice" },
      ...MESSAGES,
    ],
    NOW
  );
  assert.equal(note.turns.length, 4);
  assert.equal(note.turns[0].text, DAILY.dayQuestions[0]);
});

test("a team-space Grill folder is never used; the personal one is created instead", async () => {
  const { buildGrillSessionNote, saveGrillSessionNote } = await load();
  const { api, calls } = fakeNotesApi({
    // A careless getFolders that ignores the space filter still must not win.
    getFolders: [
      { id: 7, name: "Grill", is_default: 1, space_id: 2 },
      { id: 8, name: "Grill", is_default: 0, space_id: 1, deleted_at: "2026-09-01" },
    ],
  });
  const note = buildGrillSessionNote(DAILY, MESSAGES, NOW);
  const saved = await saveGrillSessionNote(note, api);
  assert.deepEqual(saved, { success: true, id: 42, turnsSaved: true });
  assert.deepEqual(calls[1], ["getFolders", 1]);
  assert.deepEqual(calls[2], ["createFolder", "Grill", 1]);
  assert.equal(calls[3][6], 9, "the note lands in the new personal folder");
});

test("no personal space fails the save rather than guessing a space", async () => {
  const { buildGrillSessionNote, finishGrillSession } = await load();
  const { api, names } = fakeNotesApi({ getSpaces: [{ id: 2, kind: "team", name: "Acme" }] });
  const { events, notify } = fakeNotify();
  const result = await finishGrillSession(buildGrillSessionNote(DAILY, MESSAGES, NOW), api, notify);
  assert.equal(result.success, false);
  assert.match(result.error, /personal space/);
  assert.ok(!names().includes("saveNote"));
  assert.equal(events[0][0], "failed");
});

// An in-memory localStorage.
function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// A notes API whose saveNote waits until release() is called.
function gatedNotesApi() {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const fake = fakeNotesApi({
    saveNote: async () => {
      await gate;
      return { success: true, note: { id: 42 } };
    },
  });
  return { ...fake, release: () => release() };
}

async function startedController({ api, storage = memoryStorage(), messages = MESSAGES } = {}) {
  const { createGrillController, planGrillSession } = await load();
  const toasts = fakeNotify();
  const sessions = [];
  let current = messages;
  const controller = createGrillController({
    api,
    notify: toasts.notify,
    storage,
    getMessages: () => current,
    onSessionChange: (s) => sessions.push(s ? "on" : "off"),
  });
  const plan = planGrillSession({ kind: "daily" }, { now: NOW, events: [], meetingNotes: [] });
  controller.begin(plan, 77, messages);
  return {
    controller,
    plan,
    toasts,
    sessions,
    storage,
    setMessages: (m) => (current = m),
  };
}

test("a double click on End saves once; both clicks await the same save", async () => {
  const gated = gatedNotesApi();
  const { controller, toasts } = await startedController({ api: gated.api });
  const first = controller.exit();
  const second = controller.exit();
  gated.release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { success: true, id: 42, turnsSaved: true });
  assert.equal(a, b, "the second trigger gets the same result");
  assert.equal(gated.names().filter((n) => n === "saveNote").length, 1);
  assert.deepEqual(toasts.events, [["saved"]]);
  assert.equal(controller.session(), null);
});

test("switching conversations during End waits for End's save and never starts another", async () => {
  const gated = gatedNotesApi();
  const { controller } = await startedController({ api: gated.api });
  const order = [];
  const end = controller.exit(() => order.push("ended"));
  const select = controller.exit(() => order.push(`selected after ${gated.names().join(",")}`));
  // The unmount save joins too.
  const unmount = controller.unmount();
  gated.release();
  await Promise.all([end, select, unmount]);
  assert.equal(gated.names().filter((n) => n === "saveNote").length, 1);
  assert.deepEqual(order, ["ended", "selected after getSpaces,getFolders,saveNote,updateNote"]);
});

test("unmounting during an active grill saves the session note", async () => {
  const { api, names } = fakeNotesApi();
  const { controller, toasts, sessions, storage } = await startedController({ api });
  const result = await controller.unmount();
  assert.deepEqual(result, { success: true, id: 42, turnsSaved: true });
  assert.deepEqual(names(), ["getSpaces", "getFolders", "saveNote", "updateNote"]);
  assert.deepEqual(toasts.events, [["saved"]]);
  assert.deepEqual(sessions, ["on", "off"]);
  assert.equal(storage.map.size, 0, "a saved grill leaves no draft behind");
});

test("every turn is persisted as a draft; a crash leaves it for the next start to resume", async () => {
  const { api } = fakeNotesApi();
  const storage = memoryStorage();
  const { controller, plan } = await startedController({
    api,
    storage,
    messages: MESSAGES.slice(0, 1),
  });
  controller.recordTurns(MESSAGES.slice(0, 2));
  controller.recordTurns([
    { role: "user", content: "Start my daily grill.", display: "hidden" },
    ...MESSAGES,
  ]);
  // The app dies here: no exit, no unmount.

  const { createGrillController } = await load();
  const sessions = [];
  const next = createGrillController({
    api,
    notify: fakeNotify().notify,
    storage,
    getMessages: () => [],
    onSessionChange: (s) => sessions.push(s),
  });
  const draft = next.pendingDraft();
  assert.equal(draft.plan.spec.kind, "daily");
  assert.equal(draft.plan.conversationTitle, plan.conversationTitle);
  assert.equal(draft.conversationId, 77);
  assert.deepEqual(
    draft.messages.map((m) => [m.role, m.content, m.display ?? null]),
    [
      ["user", "Start my daily grill.", "hidden"],
      ["assistant", DAILY.dayQuestions[0], null],
      ["user", "She wanted annual billing.", null],
      ["assistant", "Who was it, roughly?", null],
      ["user", "Their CFO.", null],
    ],
    "streaming and tool messages are not part of the draft"
  );

  const resumed = next.resumeDraft();
  assert.deepEqual(resumed, draft);
  assert.equal(next.session().plan.conversationTitle, plan.conversationTitle);
  assert.equal(sessions.length, 1);
});

test("'Save it' on a recovered draft saves the grill note and clears the draft", async () => {
  const { api, calls } = fakeNotesApi();
  const storage = memoryStorage();
  const { controller } = await startedController({ api: fakeNotesApi().api, storage });
  controller.recordTurns(MESSAGES);

  const { createGrillController } = await load();
  const toasts = fakeNotify();
  const next = createGrillController({
    api,
    notify: toasts.notify,
    storage,
    getMessages: () => [],
    onSessionChange: () => {},
  });
  const result = await next.saveDraft();
  assert.deepEqual(result, { success: true, id: 42, turnsSaved: true });
  const saveNote = calls.find((c) => c[0] === "saveNote");
  assert.equal(saveNote[1], "Grill 2026-09-26");
  assert.match(saveNote[2], /Their CFO\./);
  assert.deepEqual(toasts.events, [["saved"]]);
  assert.equal(next.pendingDraft(), null);
});

test("a failed save keeps the draft so the transcript is still recoverable", async () => {
  const { api } = fakeNotesApi({ saveNote: { success: false } });
  const { controller, storage } = await startedController({ api });
  controller.recordTurns(MESSAGES);
  const result = await controller.exit();
  assert.equal(result.success, false);
  assert.ok(controller.pendingDraft(), "the draft survives a failed save");
  assert.equal(storage.map.size, 1);
});

test("a corrupt draft is ignored", async () => {
  const { createGrillController, GRILL_DRAFT_KEY } = await load();
  const storage = memoryStorage();
  storage.setItem(GRILL_DRAFT_KEY, "{not json");
  const controller = createGrillController({
    api: fakeNotesApi().api,
    notify: fakeNotify().notify,
    storage,
    getMessages: () => [],
    onSessionChange: () => {},
  });
  assert.equal(controller.pendingDraft(), null);
});

test("the hidden start turn is stored with a display flag and stays hidden when reopened", async () => {
  const { planGrillSession, buildGrillOpeningMessages, persistGrillOpening } = await load();
  const { storedMessageToMessage } =
    await import("../../src/components/chat/useChatPersistence.ts");
  const plan = planGrillSession({ kind: "daily" }, { now: NOW, events: [], meetingNotes: [] });
  const opening = buildGrillOpeningMessages(plan, { contextFailed: true, contextFailedNote: "n" });

  const stored = [];
  await persistGrillOpening(opening, {
    saveUserMessage: async (text, metadata) =>
      stored.push({ role: "user", content: text, metadata: metadata && JSON.stringify(metadata) }),
    saveAssistantMessage: async (content) => stored.push({ role: "assistant", content }),
  });
  assert.deepEqual(stored, [
    { role: "user", content: "Start my daily grill.", metadata: '{"display":"hidden"}' },
    { role: "assistant", content: plan.firstQuestion },
  ]);

  const reopened = stored.map(storedMessageToMessage);
  assert.equal(reopened[0].display, "hidden");
  assert.equal(reopened[1].display, undefined);
  assert.equal(
    storedMessageToMessage({ role: "user", content: "x", metadata: "{bad" }).display,
    undefined
  );
  assert.equal(
    storedMessageToMessage({ role: "user", content: "x", metadata: '{"display":"shout"}' }).display,
    undefined
  );
});

test("the chat list preview skips hidden turns", () => {
  const { DatabaseSync } = require("node:sqlite");
  const { lastVisibleMessageSql } = require("../../src/helpers/agentMessagePreview.js");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT '2026-09-26 10:00:00'
    )
  `);
  const add = db.prepare(
    "INSERT INTO agent_messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)"
  );
  add.run(1, "assistant", "What surprised you?", null);
  add.run(1, "user", "Start my daily grill.", '{"display":"hidden"}');
  add.run(2, "user", "hello", "{bad json");
  const preview = (id) =>
    db.prepare(`SELECT ${lastVisibleMessageSql("content", "?")} AS last`).get(id).last;
  assert.equal(preview(1), "What surprised you?");
  assert.equal(preview(2), "hello");
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/database.js"), "utf8");
  assert.equal(
    source.match(/SELECT content FROM agent_messages WHERE conversation_id = c\.id ORDER BY/g),
    null,
    "every chat-list preview goes through lastVisibleMessageSql"
  );
});

// Seeds storage with a draft left by an earlier grill and returns its exact bytes.
async function seededDraft(storage) {
  const { controller } = await startedController({ api: fakeNotesApi().api, storage });
  controller.recordTurns(MESSAGES);
  const { GRILL_DRAFT_KEY } = await load();
  return storage.getItem(GRILL_DRAFT_KEY);
}

test("with an unsaved draft present, begin() refuses and leaves the draft byte-identical", async () => {
  const { createGrillController, planGrillSession, GRILL_DRAFT_KEY } = await load();
  const storage = memoryStorage();
  const before = await seededDraft(storage);
  const sessions = [];
  const controller = createGrillController({
    api: fakeNotesApi().api,
    notify: fakeNotify().notify,
    storage,
    getMessages: () => [],
    onSessionChange: (s) => sessions.push(s),
  });
  const plan = planGrillSession({ kind: "lifetime", chapter: 1 }, { now: NOW });
  const result = controller.begin(plan, 99, [{ role: "assistant", content: plan.firstQuestion }]);
  assert.deepEqual(result, { started: false, reason: "draft-pending" });
  assert.equal(storage.getItem(GRILL_DRAFT_KEY), before, "the draft is byte-identical");
  assert.equal(controller.session(), null);
  assert.deepEqual(sessions, []);
});

test("begin() with no draft present starts the session", async () => {
  const { createGrillController, planGrillSession } = await load();
  const controller = createGrillController({
    api: fakeNotesApi().api,
    notify: fakeNotify().notify,
    storage: memoryStorage(),
    getMessages: () => [],
    onSessionChange: () => {},
  });
  const plan = planGrillSession({ kind: "daily" }, { now: NOW, events: [], meetingNotes: [] });
  assert.deepEqual(controller.begin(plan, 1, []), { started: true });
  assert.ok(controller.session());
});

test("resuming a draft into a fresh conversation carries on and keeps the draft's turns", async () => {
  const { createGrillController, GRILL_DRAFT_KEY } = await load();
  const storage = memoryStorage();
  const before = JSON.parse(await seededDraft(storage));
  const controller = createGrillController({
    api: fakeNotesApi().api,
    notify: fakeNotify().notify,
    storage,
    getMessages: () => [],
    onSessionChange: () => {},
  });
  const draft = controller.resumeDraft(123);
  assert.deepEqual(draft.messages, before.messages);
  assert.equal(controller.session().conversationId, 123);
  const after = JSON.parse(storage.getItem(GRILL_DRAFT_KEY));
  assert.equal(after.conversationId, 123);
  assert.deepEqual(after.messages, before.messages);
});

test("a failed End offers the draft again right away, in the same session", async () => {
  const { createGrillController, planGrillSession } = await load();
  const storage = memoryStorage();
  const drafts = [];
  const controller = createGrillController({
    api: fakeNotesApi({ saveNote: { success: false } }).api,
    notify: fakeNotify().notify,
    storage,
    getMessages: () => MESSAGES,
    onSessionChange: () => {},
    onDraftChange: (d) => drafts.push(d),
  });
  const plan = planGrillSession({ kind: "daily" }, { now: NOW, events: [], meetingNotes: [] });
  controller.begin(plan, 77, MESSAGES);
  const result = await controller.exit();
  assert.equal(result.success, false);
  assert.equal(controller.session(), null);
  const shown = drafts.at(-1);
  assert.ok(shown, "the Unsaved grill bar has a draft to show");
  assert.equal(shown.plan.conversationTitle, "Grill 2026-09-26");
  assert.deepEqual(shown, controller.pendingDraft());
});

test("a failed 'Save it' offers the draft again; a successful one clears the bar", async () => {
  const { createGrillController } = await load();
  const storage = memoryStorage();
  await seededDraft(storage);
  const drafts = [];
  let fail = true;
  const controller = createGrillController({
    api: fakeNotesApi({
      saveNote: async () => (fail ? { success: false } : { success: true, note: { id: 42 } }),
    }).api,
    notify: fakeNotify().notify,
    storage,
    getMessages: () => [],
    onSessionChange: () => {},
    onDraftChange: (d) => drafts.push(d),
  });
  await controller.saveDraft();
  assert.ok(drafts.at(-1), "the bar is shown again after a failed save");
  fail = false;
  await controller.saveDraft();
  assert.equal(drafts.at(-1), null, "the bar clears once the draft is saved");
});

test("the English hint for a refused start", () => {
  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  assert.equal(en.chat.grill.draftPending, "Resume or save your unsaved grill first");
});

test("discard throws the grill away: no note, no pipeline post, no draft left", async () => {
  const { api, names } = fakeNotesApi({ pipelineSubmitGrillNote: { success: true } });
  const drafts = [];
  const { createGrillController, planGrillSession } = await load();
  const storage = memoryStorage();
  const sessions = [];
  const controller = createGrillController({
    api,
    notify: fakeNotify().notify,
    storage,
    getMessages: () => MESSAGES,
    onSessionChange: (s) => sessions.push(s ? "on" : "off"),
    onDraftChange: (d) => drafts.push(d),
  });
  const plan = planGrillSession({ kind: "daily" }, { now: NOW, events: [], meetingNotes: [] });
  controller.begin(plan, 77, MESSAGES);
  controller.recordTurns(MESSAGES);
  assert.equal(storage.map.size, 1, "the in-progress grill was drafted");

  controller.discard();

  assert.equal(storage.map.size, 0, "the draft storage is empty");
  assert.equal(controller.pendingDraft(), null);
  assert.equal(controller.session(), null);
  assert.ok(!names().includes("saveNote"), "nothing was saved");
  assert.ok(!names().includes("pipelineSubmitGrillNote"), "nothing was posted to the pipeline");
  assert.deepEqual(sessions, ["on", "off"]);
  assert.equal(drafts.at(-1), null, "the Unsaved grill bar is cleared");
});

test("after a discard a new grill starts (no draft refusal)", async () => {
  const { createGrillController, planGrillSession } = await load();
  const storage = memoryStorage();
  const before = await seededDraft(storage);
  assert.ok(before, "a draft is waiting");
  const controller = createGrillController({
    api: fakeNotesApi().api,
    notify: fakeNotify().notify,
    storage,
    getMessages: () => [],
    onSessionChange: () => {},
  });
  const plan = planGrillSession({ kind: "lifetime", chapter: 1 }, { now: NOW });
  assert.deepEqual(controller.begin(plan, 99, []), { started: false, reason: "draft-pending" });
  controller.discard();
  assert.deepEqual(controller.begin(plan, 99, []), { started: true });
  assert.ok(controller.session());
});

// --- Per-question marks on a saved grill (#55, D2) -------------------------

const MARK_TURNS = [
  { role: "assistant", text: "What surprised you?", questionId: "gq-1" },
  { role: "user", text: "The pricing." },
  { role: "assistant", text: "Why that?", followUpOf: "gq-1" },
  { role: "user", text: "It was cheap." },
  { role: "assistant", text: "Anything to change about today's grill?", questionId: "feedback" },
];

test("turnMarkTarget: a tagged interviewer turn marks its own question", async () => {
  const { turnMarkTarget } = await load();
  assert.equal(turnMarkTarget(MARK_TURNS[0], MARK_TURNS), "gq-1");
});

test("turnMarkTarget: a follow-up marks the question it chased", async () => {
  const { turnMarkTarget } = await load();
  assert.equal(turnMarkTarget(MARK_TURNS[2], MARK_TURNS), "gq-1");
});

test("turnMarkTarget: a follow-up whose parent is not in the session marks nothing", async () => {
  const { turnMarkTarget } = await load();
  const orphan = { role: "assistant", text: "And then?", followUpOf: "gq-9" };
  assert.equal(turnMarkTarget(orphan, [...MARK_TURNS, orphan]), null);
});

test("turnMarkTarget: Rico's turns and untagged interviewer turns mark nothing", async () => {
  const { turnMarkTarget } = await load();
  assert.equal(turnMarkTarget(MARK_TURNS[1], MARK_TURNS), null);
  assert.equal(turnMarkTarget({ role: "assistant", text: "Hi." }, MARK_TURNS), null);
  // Even a Rico turn carrying a stray id is never markable.
  assert.equal(turnMarkTarget({ role: "user", text: "x", questionId: "gq-1" }, MARK_TURNS), null);
});

// Rico (#55 Q6): feedback answers feed post pieces and the idea agent, so the
// feedback question's own quality is signal worth marking.
test("turnMarkTarget: the closing feedback turn is markable as 'feedback'", async () => {
  const { turnMarkTarget, GRILL_FEEDBACK_QUESTION_ID } = await load();
  assert.equal(turnMarkTarget(MARK_TURNS[4], MARK_TURNS), GRILL_FEEDBACK_QUESTION_ID);
});

test("grillMarkTargets maps chat lines to the question they mark, skipping hidden and notice lines", async () => {
  const { grillMarkTargets } = await load();
  const spec = { ...DAILY, questionIds: { [DAILY.dayQuestions[0]]: "gq-day" } };
  const targets = grillMarkTargets(spec, [
    { id: "h", role: "user", content: "Start my daily grill.", display: "hidden" },
    { id: "n", role: "assistant", content: "Calendar failed.", display: "notice" },
    ...MESSAGES,
  ]);
  assert.deepEqual(targets, { 1: "gq-day", 3: "gq-day" });
});

test("nextGrillMark: choosing the current mark clears it, another choice replaces it", async () => {
  const { nextGrillMark } = await load();
  assert.equal(nextGrillMark(null, "good"), "good");
  assert.equal(nextGrillMark("good", "weak"), "weak");
  assert.equal(nextGrillMark("retire", "retire"), null);
});

test("writeGrillMark: a set and a clear reach the marks store for the note", async () => {
  const { writeGrillMark } = await load();
  const calls = [];
  const api = {
    grillSetMark: async (...args) => (calls.push(["set", ...args]), { success: true }),
    grillClearMark: async (...args) => (calls.push(["clear", ...args]), { success: true }),
  };
  assert.equal(await writeGrillMark(api, "gq-1", 42, "weak", "too vague"), true);
  assert.equal(await writeGrillMark(api, "gq-1", 42, null), true);
  assert.deepEqual(calls, [
    ["set", "gq-1", 42, "weak", "too vague"],
    ["clear", "gq-1", 42],
  ]);
});

test("writeGrillMark: a refused or thrown write, or a missing bridge, resolves false", async () => {
  const { writeGrillMark } = await load();
  const refused = { grillSetMark: async () => ({ success: false, error: "nope" }) };
  const throws = {
    grillClearMark: async () => {
      throw new Error("ipc gone");
    },
  };
  assert.equal(await writeGrillMark(refused, "gq-1", 1, "good"), false);
  assert.equal(await writeGrillMark(throws, "gq-1", 1, null), false);
  assert.equal(await writeGrillMark({}, "gq-1", 1, "good"), false);
});

test("a daily plan asks pending grill topics first and names exactly the ones it used", async () => {
  const { planGrillSession, gatherGrillDayContext } = await load();
  const topics = [1, 2, 3, 4, 5].map((n) => ({
    id: `t${n}`,
    text: `Topic ${n}`,
    source: "brain-dump",
  }));
  const plan = planGrillSession({ kind: "daily" }, { now: NOW, grillTopics: topics });
  assert.equal(plan.firstQuestion, "From your brain dump: Topic 1");
  assert.equal(plan.spec.dayQuestions.length, 4);
  assert.deepEqual(plan.grillTopicIds, ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(planGrillSession({ kind: "daily" }, { now: NOW }).grillTopicIds, []);

  const context = await gatherGrillDayContext(
    {
      getNotes: async () => [],
      grillTopicsList: async () => ({ success: true, topics: [{ id: "t9", text: "Nine" }] }),
    },
    NOW,
    { warn: () => {} }
  );
  assert.deepEqual(context.grillTopics, [{ id: "t9", text: "Nine" }]);
});

test("askedGrillTopicIds: only topics whose question an assistant turn asked", async () => {
  const { askedGrillTopicIds } = await load();
  const topics = [
    { id: "t1", text: "Hiring plan", source: "brain-dump" },
    { id: "t2", text: "Pricing", source: "manual" },
    { id: "t3", text: "Offsite", source: "brain-dump" },
  ];
  const messages = [
    { role: "user", content: "Start my daily grill.", display: "hidden" },
    { role: "assistant", content: "From your brain dump: Hiring plan" },
    { role: "user", content: "Topic you added: Pricing" },
    { role: "assistant", content: "Tell me about the Offsite plans." },
  ];
  assert.deepEqual(askedGrillTopicIds(topics, messages), ["t1", "t3"]);
  assert.deepEqual(askedGrillTopicIds(topics, []), []);
  assert.deepEqual(askedGrillTopicIds(undefined, messages), []);
});

async function topicController() {
  const { createGrillController, planGrillSession } = await load();
  const marked = [];
  const api = fakeNotesApi({
    grillTopicsMarkUsed: async (ids) => {
      marked.push(ids);
      return { success: true, marked: ids.length };
    },
  }).api;
  const topics = [
    { id: "t1", text: "Hiring plan", source: "brain-dump" },
    { id: "t2", text: "Pricing", source: "manual" },
  ];
  const plan = planGrillSession({ kind: "daily" }, { now: NOW, grillTopics: topics });
  const messages = [
    { role: "assistant", content: plan.firstQuestion },
    { role: "user", content: "We hire two." },
  ];
  const controller = createGrillController({
    api,
    notify: fakeNotify().notify,
    storage: memoryStorage(),
    getMessages: () => messages,
    onSessionChange: () => {},
  });
  controller.begin(plan, 1, messages);
  return { controller, marked };
}

test("a grill marks used only the topics it asked, at exit; discard marks none", async () => {
  const saved = await topicController();
  assert.deepEqual(saved.marked, [], "starting marks nothing");
  await saved.controller.exit();
  assert.deepEqual(saved.marked, [["t1"]]);

  const thrown = await topicController();
  thrown.controller.discard();
  await thrown.controller.exit();
  assert.deepEqual(thrown.marked, []);
});
