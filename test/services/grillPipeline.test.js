const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/grill/grillSession.ts");
const loadPrompt = () => import("../../src/config/prompts/grillPrompt.ts");

const NOW = new Date(2026, 8, 26, 10, 0, 0);
const FEED = [
  { id: "fq-1", question: "OpenAI News says X. Agree or disagree?" },
  { id: "fq-2", question: "Anthropic shipped Y. What are your clients missing?" },
  { id: "fq-3", question: "A third question never asked." },
];
const MEETING = {
  id: 1,
  title: "Vendor call",
  note_type: "meeting",
  created_at: new Date(2026, 8, 26, 8).toISOString().replace("T", " ").slice(0, 19),
  participants: JSON.stringify([{ displayName: "Sam Ortiz" }]),
  transcript: null,
};

test("up to two feed questions are woven in after the day questions", async () => {
  const { planGrillSession } = await load();
  const plan = planGrillSession(
    { kind: "daily" },
    { now: NOW, events: [], meetingNotes: [MEETING], feedQuestions: FEED }
  );
  assert.deepEqual(plan.spec.feedQuestions, FEED.slice(0, 2));
  assert.equal(plan.firstQuestion, plan.spec.dayQuestions[0]);
  assert.equal(plan.startedAt, NOW.toISOString());

  const { buildGrillSessionSection } = await loadPrompt();
  const section = buildGrillSessionSection(plan.spec);
  const day = section.indexOf("Day questions");
  const feed = section.indexOf("Feed questions");
  const standard = section.indexOf("Standard questions");
  assert.ok(day >= 0 && day < feed && feed < standard, section);
  assert.match(section, /word for word/);
  assert.ok(section.includes(FEED[0].question) && section.includes(FEED[1].question));
  assert.equal(section.includes(FEED[2].question), false);
});

test("with no day questions the first feed question opens the session", async () => {
  const { planGrillSession } = await load();
  const plan = planGrillSession(
    { kind: "daily" },
    { now: NOW, events: [], meetingNotes: [], feedQuestions: FEED.slice(0, 1) }
  );
  assert.equal(plan.firstQuestion, FEED[0].question);
});

test("no feed questions leave the daily plan unchanged, and lifetime never takes them", async () => {
  const { planGrillSession } = await load();
  const daily = planGrillSession({ kind: "daily" }, { now: NOW, events: [], meetingNotes: [] });
  assert.equal(Object.hasOwn(daily.spec, "feedQuestions"), false);
  const lifetime = planGrillSession(
    { kind: "lifetime", chapter: 2 },
    { now: NOW, feedQuestions: FEED }
  );
  assert.deepEqual(lifetime.spec, { kind: "lifetime", chapter: 2 });
});

test("an interviewer turn that asked a feed question carries its question_id into the note", async () => {
  const { planGrillSession, buildGrillSessionNote } = await load();
  const plan = planGrillSession(
    { kind: "daily" },
    { now: NOW, events: [], meetingNotes: [], feedQuestions: FEED.slice(0, 2) }
  );
  const messages = [
    { role: "user", content: "Start my daily grill.", display: "hidden" },
    { role: "assistant", content: FEED[0].question },
    { role: "user", content: "Disagree." },
    { role: "assistant", content: "Why, concretely?" },
    { role: "user", content: "Cost." },
    { role: "assistant", content: `Next one.  ${FEED[1].question.toLowerCase()}` },
    { role: "user", content: "They miss the setup." },
  ];
  const ended = new Date(2026, 8, 26, 10, 12, 0);
  const note = buildGrillSessionNote(plan.spec, messages, ended, undefined, {
    startedAt: plan.startedAt,
  });
  assert.deepEqual(
    note.turns.map((t) => t.questionId ?? null),
    ["fq-1", null, null, null, "fq-2", null]
  );
  const stored = JSON.parse(note.transcript);
  assert.deepEqual(
    stored.map((s) => s.question_id ?? null),
    ["fq-1", null, null, null, "fq-2", null]
  );
  assert.equal(stored[1].question_id, undefined, "rico turns carry no question_id");
  assert.deepEqual(note.pipeline, {
    kind: "daily",
    chapter: null,
    startedAt: NOW.toISOString(),
    endedAt: ended.toISOString(),
  });
});

test("a saved grill with its turns is handed to the pipeline; the save never waits on it", async () => {
  const { buildGrillSessionNote, saveGrillSessionNote } = await load();
  const submitted = [];
  let settle;
  const api = {
    getSpaces: async () => [{ id: 1, kind: "private" }],
    getFolders: async () => [{ id: 4, name: "Grill", is_default: 0, space_id: 1 }],
    createFolder: async () => ({ success: false }),
    saveNote: async () => ({ success: true, note: { id: 42 } }),
    updateNote: async () => ({ success: true, note: { id: 42 } }),
    pipelineSubmitGrillNote: (id, meta) => {
      submitted.push([id, meta]);
      return new Promise((resolve) => (settle = resolve));
    },
  };
  const spec = { kind: "daily", date: "2026-09-26", dayQuestions: [], standardQuestions: ["Q?"] };
  const note = buildGrillSessionNote(
    spec,
    [
      { role: "assistant", content: "Q?" },
      { role: "user", content: "A." },
    ],
    NOW
  );
  const result = await saveGrillSessionNote(note, api);
  assert.deepEqual(result, { success: true, id: 42, turnsSaved: true });
  assert.deepEqual(submitted, [[42, note.pipeline]]);
  settle({ success: true });
});

test("a pipeline hand-off that throws or rejects never fails the save", async () => {
  const { buildGrillSessionNote, saveGrillSessionNote } = await load();
  for (const submit of [
    () => {
      throw new Error("ipc gone");
    },
    () => Promise.reject(new Error("ipc gone")),
  ]) {
    const api = {
      getSpaces: async () => [{ id: 1, kind: "private" }],
      getFolders: async () => [{ id: 5, name: "Life Story", is_default: 0, space_id: 1 }],
      createFolder: async () => ({ success: false }),
      saveNote: async () => ({ success: true, note: { id: 7 } }),
      updateNote: async () => ({ success: true, note: { id: 7 } }),
      pipelineSubmitGrillNote: submit,
    };
    const spec = { kind: "lifetime", chapter: 2 };
    const note = buildGrillSessionNote(
      spec,
      [
        { role: "assistant", content: "Q?" },
        { role: "user", content: "A." },
      ],
      NOW
    );
    assert.deepEqual(await saveGrillSessionNote(note, api), {
      success: true,
      id: 7,
      turnsSaved: true,
    });
  }
});

test("a grill saved without its turns is not handed to the pipeline", async () => {
  const { buildGrillSessionNote, saveGrillSessionNote } = await load();
  const submitted = [];
  const api = {
    getSpaces: async () => [{ id: 1, kind: "private" }],
    getFolders: async () => [{ id: 4, name: "Grill", is_default: 0, space_id: 1 }],
    createFolder: async () => ({ success: false }),
    saveNote: async () => ({ success: true, note: { id: 42 } }),
    updateNote: async () => ({ success: false }),
    pipelineSubmitGrillNote: async (...args) => submitted.push(args),
  };
  const spec = { kind: "daily", date: "2026-09-26", dayQuestions: [], standardQuestions: ["Q?"] };
  const note = buildGrillSessionNote(
    spec,
    [
      { role: "assistant", content: "Q?" },
      { role: "user", content: "A." },
    ],
    NOW
  );
  const result = await saveGrillSessionNote(note, api);
  assert.equal(result.turnsSaved, false);
  assert.deepEqual(submitted, []);
});

test("feed questions are read at start; an unreachable pipeline is flagged and logged by code only", async () => {
  const { gatherGrillFeedQuestions } = await load();
  const warnings = [];
  const log = { warn: (...args) => warnings.push(args) };

  assert.deepEqual(
    await gatherGrillFeedQuestions(
      { pipelineGetQuestions: async () => ({ success: true, configured: true, questions: FEED }) },
      log
    ),
    { questions: FEED, failed: false }
  );
  assert.deepEqual(
    await gatherGrillFeedQuestions(
      { pipelineGetQuestions: async () => ({ success: true, configured: false, questions: [] }) },
      log
    ),
    { questions: [], failed: false }
  );
  assert.deepEqual(
    await gatherGrillFeedQuestions(
      {
        pipelineGetQuestions: async () => ({
          success: false,
          code: "UNREACHABLE",
          error: "Pipeline is unreachable",
        }),
      },
      log
    ),
    { questions: [], failed: true }
  );
  assert.deepEqual(
    await gatherGrillFeedQuestions(
      {
        pipelineGetQuestions: async () => {
          throw new Error("ipc gone");
        },
      },
      log
    ),
    { questions: [], failed: true }
  );
  assert.deepEqual(await gatherGrillFeedQuestions({}, log), { questions: [], failed: false });
  assert.equal(warnings.length, 2);
});

test("an unreachable pipeline shows one line before the first question", async () => {
  const { planGrillSession, buildGrillOpeningMessages } = await load();
  const plan = planGrillSession({ kind: "daily" }, { now: NOW, events: [], meetingNotes: [] });
  const opening = buildGrillOpeningMessages(plan, {
    feedFailed: true,
    feedFailedNote: "Couldn't reach the pipeline; starting without feed questions.",
  });
  assert.deepEqual(
    opening.map((m) => [m.role, m.display ?? null]),
    [
      ["user", "hidden"],
      ["assistant", "notice"],
      ["assistant", null],
    ]
  );
  assert.equal(opening[1].content, "Couldn't reach the pipeline; starting without feed questions.");
  const quiet = buildGrillOpeningMessages(plan, {});
  assert.equal(
    quiet.some((m) => m.display === "notice"),
    false
  );
});
