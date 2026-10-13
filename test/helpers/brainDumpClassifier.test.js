const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBrainDumpPrompt,
  parseDecision,
  FALLBACK_DECISION,
} = require("../../src/helpers/brainDumpClassifier.js");

test("parseDecision accepts each valid kind", () => {
  assert.deepEqual(parseDecision('{"kind":"note","folder":"Work","title":"Idea","text":"body"}'), {
    kind: "note",
    folder: "Work",
    title: "Idea",
    text: "body",
  });
  assert.deepEqual(parseDecision('{"kind":"grill","title":"Pricing","text":"should we"}'), {
    kind: "grill",
    title: "Pricing",
    text: "should we",
  });
  assert.deepEqual(parseDecision('{"kind":"todo","title":"Call Bob","text":"about quote"}'), {
    kind: "todo",
    title: "Call Bob",
    text: "about quote",
  });
});

test("parseDecision reads JSON inside a code fence and drops extra keys", () => {
  const raw = '```json\n{"kind":"todo","title":"T","text":"x","why":"because"}\n```';
  assert.deepEqual(parseDecision(raw), { kind: "todo", title: "T", text: "x" });
});

test("parseDecision falls back to an Inbox note on invalid input and never throws", () => {
  for (const raw of [
    "",
    "not json",
    "{",
    "null",
    "[1,2]",
    '"note"',
    undefined,
    null,
    42,
    { kind: "todo" },
  ]) {
    assert.deepEqual(parseDecision(raw), FALLBACK_DECISION, `input ${String(raw)}`);
  }
});

test("parseDecision falls back when a field is missing or empty", () => {
  assert.deepEqual(parseDecision('{"kind":"todo","text":"x"}'), FALLBACK_DECISION);
  assert.deepEqual(parseDecision('{"kind":"grill","title":"t"}'), FALLBACK_DECISION);
  assert.deepEqual(parseDecision('{"kind":"note","title":"  ","text":"x"}'), FALLBACK_DECISION);
  assert.deepEqual(
    parseDecision('{"kind":"note","title":"t","text":"x","folder":7}'),
    FALLBACK_DECISION
  );
});

test("parseDecision falls back on an unknown kind", () => {
  assert.deepEqual(parseDecision('{"kind":"email","title":"t","text":"x"}'), FALLBACK_DECISION);
});

test("a note with no folder goes to Inbox", () => {
  assert.equal(parseDecision('{"kind":"note","title":"t","text":"x"}').folder, "Inbox");
});

test("the prompt lists the folders and the three kinds", () => {
  const prompt = buildBrainDumpPrompt(["Work", "Recipes"]);
  for (const word of ['"Work"', '"Recipes"', '"note"', '"grill"', '"todo"', "JSON"]) {
    assert.ok(prompt.includes(word), `prompt is missing ${word}`);
  }
});
