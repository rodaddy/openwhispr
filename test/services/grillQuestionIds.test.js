// Question ids ride from the store bank into the session spec and onto the
// saved turns (D-L1-4): a planned session carries text -> gq- id
// for every question it puts in the prompt, and a saved note tags the turn that
// asked one plus the follow-ups that chased it.
const test = require("node:test");
const assert = require("node:assert/strict");

const loadSession = () => import("../../src/services/grill/grillSession.ts");
const loadStore = () => import("../../src/services/grill/grillBankStore.ts");
const loadBank = () => import("../../src/config/grill/questionBank.ts");
const loadPrompt = () => import("../../src/config/prompts/grillPrompt.ts");

const NOW = new Date(2026, 8, 26, 10, 0, 0);

// A bank rebuilt from store rows, so every text array has ids beside it.
async function storeBank(params = {}) {
  const { seedRowsFromBank, bankFromStore } = await loadStore();
  const { GRILL_BANK } = await loadBank();
  let n = 0;
  const seed = seedRowsFromBank(GRILL_BANK, NOW, () => `gq-${String(++n).padStart(4, "0")}`);
  return bankFromStore(seed.questions, { ...seed.params, ...params });
}

const MEETING_NOTES = [
  {
    id: 1,
    title: "Vendor call",
    note_type: "meeting",
    created_at: new Date(2026, 8, 26, 8).toISOString().replace("T", " ").slice(0, 19),
    participants: JSON.stringify([{ displayName: "Sam Ortiz" }]),
    transcript: null,
  },
];

test("a daily plan from a store bank carries an id for every day and standard question", async () => {
  const { planGrillSession } = await loadSession();
  const bank = await storeBank();
  const plan = planGrillSession(
    { kind: "daily" },
    { now: NOW, events: [], meetingNotes: MEETING_NOTES },
    bank
  );

  assert.ok(plan.spec.questionIds, "the spec carries questionIds");
  const dayTemplateIds = new Set(bank.ids.dayTemplates);
  assert.equal(plan.spec.dayQuestions.length, 1);
  for (const question of plan.spec.dayQuestions) {
    assert.ok(dayTemplateIds.has(plan.spec.questionIds[question]), `${question} -> a template id`);
  }
  for (const [i, question] of bank.standardQuestions.entries()) {
    assert.equal(plan.spec.questionIds[question], bank.ids.standard[i]);
  }
});

test("a lifetime plan from a store bank carries the chapter title, questions and their ids", async () => {
  const { planGrillSession } = await loadSession();
  const bank = await storeBank();
  const plan = planGrillSession({ kind: "lifetime", chapter: 2 }, { now: NOW }, bank);
  const chapter = bank.chapters.find((c) => c.number === 2);

  assert.equal(plan.spec.chapterTitle, chapter.title);
  assert.deepEqual(plan.spec.chapterQuestions, chapter.questions);
  for (const [i, question] of chapter.questions.entries()) {
    assert.equal(plan.spec.questionIds[question], bank.ids.chapters[2][i]);
  }
});

test("a lifetime section uses the spec's chapter questions over the bank's", async () => {
  const { buildGrillSessionSection } = await loadPrompt();
  const section = buildGrillSessionSection({
    kind: "lifetime",
    chapter: 2,
    chapterTitle: "A newer title",
    chapterQuestions: ["Where did that start?", "Who was there?"],
  });
  assert.match(section, /Lifetime chapter 2: A newer title\./);
  assert.match(section, /1\. Where did that start\?\n2\. Who was there\?/);
});

test("a plan from the compiled bank has no questionIds", async () => {
  const { planGrillSession } = await loadSession();
  const daily = planGrillSession(
    { kind: "daily" },
    { now: NOW, events: [], meetingNotes: MEETING_NOTES }
  );
  const lifetime = planGrillSession({ kind: "lifetime", chapter: 2 }, { now: NOW });
  assert.equal(daily.spec.questionIds, undefined);
  assert.equal(lifetime.spec.questionIds, undefined);
});

test("store params cap the day questions and the feed questions", async () => {
  const { planGrillSession } = await loadSession();
  const bank = await storeBank({ max_day_questions: 1, max_feed_questions: 1 });
  const notes = [
    MEETING_NOTES[0],
    {
      id: 2,
      title: "Pricing sync",
      note_type: "meeting",
      created_at: new Date(2026, 8, 26, 9).toISOString().replace("T", " ").slice(0, 19),
      participants: JSON.stringify([{ displayName: "Dana Park" }]),
      transcript: null,
    },
  ];
  const plan = planGrillSession(
    { kind: "daily" },
    {
      now: NOW,
      events: [],
      meetingNotes: notes,
      feedQuestions: [
        { id: "fq-1", question: "What did the pricing call change?" },
        { id: "fq-2", question: "What is still open on it?" },
      ],
    },
    bank
  );
  assert.equal(plan.spec.dayQuestions.length, 1);
  assert.equal(plan.spec.feedQuestions.length, 1);
  assert.equal(plan.spec.feedQuestions[0].id, "fq-1");
});

test("a saved note tags bank questions, feed questions and their follow-ups", async () => {
  const { buildGrillSessionNote } = await loadSession();
  const bank = await storeBank();
  const standard = bank.standardQuestions[0];
  const standardId = bank.ids.standard[0];
  const spec = {
    kind: "daily",
    date: "2026-09-26",
    dayQuestions: [],
    standardQuestions: [standard],
    feedQuestions: [{ id: "fq-1", question: "What did the pricing call change?" }],
    questionIds: { [standard]: standardId },
  };
  const messages = [
    { role: "assistant", content: "Ready when you are." },
    { role: "user", content: "Go." },
    { role: "assistant", content: standard },
    { role: "user", content: "The vendor call." },
    { role: "assistant", content: "Who pushed back?" },
    { role: "user", content: "Their CFO." },
    { role: "assistant", content: "What did the pricing call change?" },
    { role: "user", content: "Annual billing." },
    { role: "assistant", content: "What made that acceptable?" },
    { role: "user", content: "The discount." },
  ];
  const note = buildGrillSessionNote(spec, messages, new Date(2026, 8, 26, 11), bank);
  const asked = note.turns.filter((t) => t.role === "assistant");

  assert.equal(asked[0].questionId, undefined, "a turn before any tagged question stays untagged");
  assert.equal(asked[0].followUpOf, undefined);
  assert.equal(asked[1].questionId, standardId);
  assert.equal(asked[2].followUpOf, standardId);
  assert.equal(asked[2].questionId, undefined);
  assert.equal(asked[3].questionId, "fq-1");
  assert.equal(asked[4].followUpOf, "fq-1");

  const segments = JSON.parse(note.transcript).filter((s) => s.role === "assistant");
  assert.equal(segments[1].question_id, standardId);
  assert.equal(segments[2].follow_up_of, standardId);
  assert.equal(segments[0].follow_up_of, undefined);
  assert.equal(segments[4].follow_up_of, "fq-1");
});

// The closing feedback question is tagged "feedback", and a
// follow-up after it chases "feedback".
test("a saved note tags the feedback question and its follow-up", async () => {
  const { buildGrillSessionNote } = await loadSession();
  const { GRILL_FEEDBACK_QUESTION } = await loadPrompt();
  const bank = await storeBank();
  const standard = bank.standardQuestions[0];
  const spec = {
    kind: "daily",
    date: "2026-09-26",
    dayQuestions: [],
    standardQuestions: [standard],
    questionIds: { [standard]: bank.ids.standard[0] },
  };
  const messages = [
    { role: "assistant", content: standard },
    { role: "user", content: "The vendor call." },
    { role: "assistant", content: GRILL_FEEDBACK_QUESTION },
    { role: "user", content: "The pricing one landed; the routine one fell flat." },
    { role: "assistant", content: "What made the routine one fall flat?" },
    { role: "user", content: "Too vague." },
  ];
  const note = buildGrillSessionNote(spec, messages, new Date(2026, 8, 26, 11), bank);
  const asked = note.turns.filter((t) => t.role === "assistant");
  assert.equal(asked[1].questionId, "feedback");
  assert.equal(asked[2].followUpOf, "feedback");

  const segments = JSON.parse(note.transcript).filter((s) => s.role === "assistant");
  assert.equal(segments[1].question_id, "feedback");
  assert.equal(segments[2].follow_up_of, "feedback");
});

test("the feedback question is tagged even when the spec carries no question ids", async () => {
  const { buildGrillSessionNote } = await loadSession();
  const { GRILL_FEEDBACK_QUESTION } = await loadPrompt();
  const spec = { kind: "lifetime", chapter: 2 };
  const note = buildGrillSessionNote(
    spec,
    [
      { role: "assistant", content: GRILL_FEEDBACK_QUESTION },
      { role: "user", content: "The first one." },
    ],
    new Date(2026, 8, 26, 11)
  );
  assert.equal(note.turns[0].questionId, "feedback");
});
