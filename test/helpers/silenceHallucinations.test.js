const test = require("node:test");
const assert = require("node:assert/strict");

const { isSilenceHallucination } = require("../../src/helpers/silenceHallucinations");

const PHRASES = [
  "thank you",
  "thank you very much",
  "thanks for watching",
  "thanks for watching!",
  "thank you for watching",
  "you",
  "bye",
  "please subscribe",
  "subtitles by the amara.org community",
  "[blank_audio]",
  "(silence)",
];

test("every listed silence phrase is a hallucination", () => {
  for (const phrase of PHRASES) {
    assert.equal(isSilenceHallucination(phrase), true, phrase);
  }
});

test("mixed case, surrounding punctuation and whitespace still match", () => {
  assert.equal(isSilenceHallucination("  Thank you.  "), true);
  assert.equal(isSilenceHallucination("Thank You!"), true);
  assert.equal(isSilenceHallucination("... Bye ..."), true);
  assert.equal(isSilenceHallucination("Thanks for watching!!!"), true);
  assert.equal(isSilenceHallucination("[BLANK_AUDIO]"), true);
});

test("repeated hallucination sentences collapse to one", () => {
  assert.equal(isSilenceHallucination("Thank you. Thank you. Thank you."), true);
  assert.equal(isSilenceHallucination("Thank you. Thanks for watching."), true);
  assert.equal(isSilenceHallucination("you you you"), true);
});

test("real speech containing a listed phrase is not a hallucination", () => {
  assert.equal(isSilenceHallucination("thank you for the quote"), false);
  assert.equal(isSilenceHallucination("Thank you. Please send the invoice."), false);
  assert.equal(isSilenceHallucination("bye for now, talk tomorrow"), false);
  assert.equal(isSilenceHallucination("Subscribe to the newsletter please"), false);
});

test("empty and non-string input is treated as nothing to paste", () => {
  assert.equal(isSilenceHallucination(""), true);
  assert.equal(isSilenceHallucination("   "), true);
  assert.equal(isSilenceHallucination("..."), true);
  assert.equal(isSilenceHallucination(null), true);
  assert.equal(isSilenceHallucination(undefined), true);
  assert.equal(isSilenceHallucination(42), true);
});
