const test = require("node:test");
const assert = require("node:assert/strict");

const loadPrompts = () => import("../../src/config/prompts.ts");
const loadBank = () => import("../../src/config/grill/questionBank.ts");

const DAILY = {
  kind: "daily",
  date: "2026-09-26",
  dayQuestions: [
    "You met Dana Park about Q3 pricing. What surprised you?",
    "In the Acme kickoff, you said 'we ship Fridays'. Say more: why?",
  ],
  standardQuestions: [
    "What did you get wrong, or would you do differently?",
    "What happened yesterday that surprised you?",
  ],
};

test("grill is a registered prompt kind with no persona", async () => {
  const { PROMPT_KINDS, PROMPT_KIND_LIST } = await import("../../src/config/prompts/registry.ts");
  assert.ok(PROMPT_KIND_LIST.includes("grill"));
  assert.equal(PROMPT_KINDS.grill.i18nKey, null);
  assert.doesNotMatch(PROMPT_KINDS.grill.fallback, /Skippy/i);
});

test("daily grill prompt carries the rules verbatim, templates, day and standard questions", async () => {
  const { getAgentSystemPrompt } = await loadPrompts();
  const { GRILL_BANK } = await loadBank();
  const prompt = getAgentSystemPrompt(["search_notes"], "<note>x</note>", DAILY);

  assert.ok(prompt.includes(GRILL_BANK.rules), "interviewer rules section must be verbatim");
  assert.match(prompt, /Daily grill/);
  for (const { template } of GRILL_BANK.dayTemplates) assert.ok(prompt.includes(template));
  for (const q of DAILY.dayQuestions) assert.ok(prompt.includes(q));
  for (const q of DAILY.standardQuestions) assert.ok(prompt.includes(q));
  // Ask day questions before the standard ones.
  assert.ok(prompt.indexOf(DAILY.dayQuestions[1]) < prompt.indexOf(DAILY.standardQuestions[0]));
  assert.doesNotMatch(prompt, /Skippy/i);
  assert.doesNotMatch(prompt, /Lifetime chapter/);
  // Grill mode is an interview: no tool instructions and no RAG notes.
  assert.doesNotMatch(prompt, /search_notes/);
  assert.doesNotMatch(prompt, /<note>x<\/note>/);
});

test("lifetime grill prompt carries only the chosen chapter's questions", async () => {
  const { getAgentSystemPrompt } = await loadPrompts();
  const { GRILL_BANK } = await loadBank();
  const prompt = getAgentSystemPrompt(undefined, undefined, { kind: "lifetime", chapter: 3 });
  const chapter = GRILL_BANK.chapters[2];

  assert.ok(prompt.includes(GRILL_BANK.rules));
  assert.match(prompt, /Lifetime chapter 3: The trading years/);
  for (const q of chapter.questions) assert.ok(prompt.includes(q), q);
  for (const q of GRILL_BANK.chapters[3].questions) assert.ok(!prompt.includes(q), q);
  for (const q of GRILL_BANK.standardQuestions) assert.ok(!prompt.includes(q), q);
  assert.doesNotMatch(prompt, /You met \{who\}/);
  assert.doesNotMatch(prompt, /Skippy/i);
});

test("an unknown chapter is refused", async () => {
  const { buildGrillSessionSection } = await import("../../src/config/prompts/grillPrompt.ts");
  assert.throws(() => buildGrillSessionSection({ kind: "lifetime", chapter: 11 }), /chapter 11/);
});

test("chat without a grill session still gets the chat agent prompt", async () => {
  const { getAgentSystemPrompt } = await loadPrompts();
  assert.match(getAgentSystemPrompt(), /Skippy/);
});

// Every grill closes by asking the same feedback question.
test("daily and lifetime session sections carry the feedback question verbatim", async () => {
  const { buildGrillSessionSection, GRILL_FEEDBACK_QUESTION } =
    await import("../../src/config/prompts/grillPrompt.ts");
  assert.equal(
    GRILL_FEEDBACK_QUESTION,
    "Before we stop: which question today got your best answer, and which one fell flat?"
  );
  const daily = buildGrillSessionSection(DAILY);
  const lifetime = buildGrillSessionSection({ kind: "lifetime", chapter: 3 });
  for (const section of [daily, lifetime]) {
    assert.ok(section.includes(GRILL_FEEDBACK_QUESTION), "the feedback question is verbatim");
    assert.match(section, /word for word/);
  }
  // It is the last thing asked, after the bank questions.
  assert.ok(daily.indexOf(DAILY.standardQuestions[0]) < daily.indexOf(GRILL_FEEDBACK_QUESTION));
});
