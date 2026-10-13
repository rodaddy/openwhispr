const test = require("node:test");
const assert = require("node:assert/strict");

const { collapseRepeatedSentences } = require("../../src/helpers/transcriptRepetition");

test("a sentence Whisper looped six times collapses to one", () => {
  const sentence = "I need to trim the silence before the request goes out.";
  const looped = Array(6).fill(sentence).join(" ");
  assert.equal(collapseRepeatedSentences(looped), sentence);
});

test("non-adjacent repeats are left alone", () => {
  const text = "Start here. Something else. Start here.";
  assert.equal(collapseRepeatedSentences(text), text);
});

test("normal text is unchanged", () => {
  const text = "First line. Second line! Third line?";
  assert.equal(collapseRepeatedSentences(text), text);
});

test("adjacent repeats differing only in punctuation and case collapse", () => {
  assert.equal(collapseRepeatedSentences("Hello there. hello there! Bye."), "Hello there. Bye.");
});
