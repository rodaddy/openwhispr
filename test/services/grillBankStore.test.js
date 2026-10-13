const test = require("node:test");
const assert = require("node:assert/strict");

const loadStore = () => import("../../src/services/grill/grillBankStore.ts");
const loadBank = () => import("../../src/config/grill/questionBank.ts");

const NOW = new Date(2026, 8, 29, 10, 0, 0);
const ID_RE = /^gq-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("seed rows cover every stored question in the compiled bank", async () => {
  const { seedRowsFromBank } = await loadStore();
  const { GRILL_BANK } = await loadBank();
  const { questions, params } = seedRowsFromBank(GRILL_BANK, NOW);

  const standard = questions.filter((q) => q.section === "standard");
  const dayTemplates = questions.filter((q) => q.section === "day-template");
  const chapters = questions.filter((q) => q.section === "chapter");
  assert.equal(standard.length, 8);
  assert.equal(dayTemplates.length, 5);
  assert.equal(
    chapters.length,
    GRILL_BANK.chapters.reduce((n, c) => n + c.questions.length, 0)
  );

  for (const row of questions) {
    assert.match(row.id, ID_RE);
    assert.equal(row.status, "active");
    assert.equal(row.created_at, NOW.toISOString());
    assert.equal(row.updated_at, NOW.toISOString());
  }
  assert.equal(new Set(questions.map((q) => q.id)).size, questions.length);

  assert.deepEqual(
    standard.map((q) => q.position),
    standard.map((_, i) => i)
  );
  assert.deepEqual(
    dayTemplates.map((q) => q.source),
    GRILL_BANK.dayTemplates.map((t) => t.source)
  );
  for (const chapter of GRILL_BANK.chapters) {
    const rows = chapters.filter((q) => q.chapter === chapter.number);
    assert.deepEqual(
      rows.map((q) => q.text),
      chapter.questions
    );
    assert.deepEqual(
      rows.map((q) => q.position),
      chapter.questions.map((_, i) => i)
    );
  }

  assert.equal(params.max_day_questions, 4);
  assert.equal(params.max_feed_questions, 2);
  assert.deepEqual(
    params.chapter_titles,
    Object.fromEntries(GRILL_BANK.chapters.map((c) => [String(c.number), c.title]))
  );
});

test("a bank rebuilt from seed rows equals the compiled bank", async () => {
  const { seedRowsFromBank, bankFromStore } = await loadStore();
  const { GRILL_BANK } = await loadBank();
  const { questions, params } = seedRowsFromBank(GRILL_BANK, NOW);
  const bank = bankFromStore(questions, params);

  assert.equal(bank.rules, GRILL_BANK.rules);
  assert.equal(bank.lifetimeIntro, GRILL_BANK.lifetimeIntro);
  assert.deepEqual(bank.standardQuestions, GRILL_BANK.standardQuestions);
  assert.deepEqual(bank.dayTemplates, GRILL_BANK.dayTemplates);
  assert.deepEqual(bank.chapters, GRILL_BANK.chapters);
  assert.deepEqual(bank.params, { maxDayQuestions: 4, maxFeedQuestions: 2 });
  assert.deepEqual(
    bank.ids.standard,
    questions.filter((q) => q.section === "standard").map((q) => q.id)
  );
  assert.deepEqual(
    bank.ids.dayTemplates,
    questions.filter((q) => q.section === "day-template").map((q) => q.id)
  );
  assert.deepEqual(
    bank.ids.chapters[1],
    questions.filter((q) => q.chapter === 1).map((q) => q.id)
  );
});

test("a retired row is dropped and the remaining positions still read in order", async () => {
  const { seedRowsFromBank, bankFromStore } = await loadStore();
  const { GRILL_BANK } = await loadBank();
  const { questions, params } = seedRowsFromBank(GRILL_BANK, NOW);
  const retired = questions.find((q) => q.section === "standard" && q.position === 1);
  const rows = questions.map((q) => (q.id === retired.id ? { ...q, status: "retired" } : q));

  const bank = bankFromStore(rows, params);
  assert.equal(bank.standardQuestions.length, 7);
  assert.ok(!bank.standardQuestions.includes(retired.text));
  assert.deepEqual(
    bank.standardQuestions,
    GRILL_BANK.standardQuestions.filter((t) => t !== retired.text)
  );
  assert.ok(!bank.ids.standard.includes(retired.id));
  assert.equal(bank.ids.standard.length, 7);
});

test("loadGrillBank seeds once when the store is empty", async () => {
  const { loadGrillBank } = await loadStore();
  const { GRILL_BANK } = await loadBank();
  const calls = { get: 0, seed: 0 };
  let stored = { questions: [], params: {} };
  const api = {
    grillGetQuestionBank: async () => {
      calls.get += 1;
      return stored;
    },
    grillSeedQuestionBank: async (questions, params) => {
      calls.seed += 1;
      stored = { questions, params };
      return stored;
    },
  };

  const bank = await loadGrillBank(api);
  assert.equal(calls.get, 1);
  assert.equal(calls.seed, 1);
  assert.deepEqual(bank.standardQuestions, GRILL_BANK.standardQuestions);
  assert.equal(bank.ids.standard.length, 8);

  const again = await loadGrillBank(api);
  assert.equal(calls.seed, 1, "a non-empty store is never reseeded");
  assert.deepEqual(again.ids.standard, bank.ids.standard);
});

test("loadGrillBank returns the compiled bank without ids when the api is absent or throws", async () => {
  const { loadGrillBank } = await loadStore();
  const { GRILL_BANK } = await loadBank();

  const missing = await loadGrillBank(undefined);
  assert.equal(missing.ids, undefined);
  assert.equal(missing.params, undefined);
  assert.deepEqual(missing.standardQuestions, GRILL_BANK.standardQuestions);

  const broken = await loadGrillBank({
    grillGetQuestionBank: async () => {
      throw new Error("no ipc");
    },
  });
  assert.equal(broken.ids, undefined);
  assert.deepEqual(broken.chapters, GRILL_BANK.chapters);
});
