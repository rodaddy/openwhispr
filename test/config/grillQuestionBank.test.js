const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const BANK_PATH = path.join(ROOT, "src/config/grill/question-bank.md");

const loadBank = () => import("../../src/config/grill/questionBank.ts");
const loadText = () => import("../../src/config/grill/questionBankText.ts");

test("the seed module embeds question-bank.md byte for byte", async () => {
  const { GRILL_BANK_FILE } = await loadText();
  assert.equal(GRILL_BANK_FILE, fs.readFileSync(BANK_PATH, "utf8"));
});

test("parses rules, day templates, standard questions and ten chapters", async () => {
  const { GRILL_BANK } = await loadBank();
  assert.match(GRILL_BANK.rules, /^## Rules the interviewer follows\n/);
  assert.match(GRILL_BANK.rules, /1\. \*\*One question at a time\.\*\*/);
  assert.match(GRILL_BANK.rules, /8\. \*\*Stop on time\.\*\*/);
  assert.doesNotMatch(GRILL_BANK.rules, /## What each answer becomes/);

  assert.equal(GRILL_BANK.dayTemplates.length, 5);
  assert.deepEqual(GRILL_BANK.dayTemplates[0], {
    source: "Calendar or meeting",
    template: "You met {who} about {topic}. What surprised you?",
  });

  assert.equal(GRILL_BANK.standardQuestions.length, 8);
  assert.equal(GRILL_BANK.standardQuestions[0], "What happened yesterday that surprised you?");
  assert.equal(
    GRILL_BANK.standardQuestions[3],
    "What common advice about AI or small business did you hear lately? Do you agree or disagree?"
  );

  assert.equal(GRILL_BANK.chapters.length, 10);
  assert.deepEqual(
    GRILL_BANK.chapters.map((c) => c.number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.equal(GRILL_BANK.chapters[0].title, "Roots and family");
  assert.equal(GRILL_BANK.chapters[6].title, 'Why "extend and enhance"');
  assert.equal(GRILL_BANK.chapters[0].questions[0], "Where did you grow up?");
  assert.equal(
    GRILL_BANK.chapters[6].questions.at(-1),
    "Tell one story where a tool made someone better at their work."
  );
});

test("prettier leaves the verbatim bank and its generated module alone", async () => {
  const prettier = await import("prettier");
  const ignorePath = path.join(ROOT, ".prettierignore");
  for (const file of [
    "src/config/grill/question-bank.md",
    "src/config/grill/questionBankText.ts",
  ]) {
    const info = await prettier.getFileInfo(path.join(ROOT, file), { ignorePath });
    assert.equal(info.ignored, true, `${file} must be in the root .prettierignore`);
  }
});
