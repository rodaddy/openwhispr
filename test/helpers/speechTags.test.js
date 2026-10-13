const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/speechTags.js");

test("stripSpeechTags removes known tags and pauses, tidies the gap, and leaves other brackets", async () => {
  const { stripSpeechTags } = await load();

  assert.equal(stripSpeechTags("[sigh] Fine, Rico."), "Fine, Rico.");
  assert.equal(stripSpeechTags("Fine [laughter], Rico."), "Fine, Rico.");
  assert.equal(stripSpeechTags("Wait [pause 0.5s] for it."), "Wait for it.");

  const untouched = "See [1] and [text](url), said [B EY1 S].\n    indented  code";
  assert.equal(stripSpeechTags(untouched), untouched);
  assert.equal(stripSpeechTags(42), "");
});

test("streaming drops a trailing unfinished tag and keeps other open brackets", async () => {
  const { stripSpeechTags } = await load();
  const streaming = { streaming: true };

  assert.equal(stripSpeechTags("Fine. [sig", streaming), "Fine. ");
  assert.equal(stripSpeechTags("Fine. [", streaming), "Fine. ");
  assert.equal(stripSpeechTags("See [1", streaming), "See [1");
  assert.equal(stripSpeechTags("See [x", streaming), "See [x");
  assert.equal(stripSpeechTags("Fine. [sig"), "Fine. [sig");
});

test("sanitizeForSpeech keeps known tags and drops pauses and unknown tags", async () => {
  const { sanitizeForSpeech } = await load();

  assert.equal(
    sanitizeForSpeech("[sigh] Fine. [pause 1s] Look [whispers] here."),
    "[sigh] Fine. Look here."
  );
  const kept = "Read the [docs](https://x), said [B EY1 S].";
  assert.equal(sanitizeForSpeech(kept), kept);
  assert.equal(sanitizeForSpeech(null), "");
});

test("a tag that is a markdown link's text stays, and so does a bracket attached to a word", async () => {
  const { sanitizeForSpeech, stripSpeechTags } = await load();

  const linked = "See [sigh](https://example.com) and [pause](https://example.com) now";
  assert.equal(stripSpeechTags(linked), linked);
  assert.equal(sanitizeForSpeech(linked), linked);
  assert.equal(stripSpeechTags("Fine [sigh] (again)"), "Fine (again)");

  assert.equal(sanitizeForSpeech("use arr[i] here"), "use arr[i] here");
  assert.equal(sanitizeForSpeech("Fine [whisper] ok"), "Fine ok");
});
