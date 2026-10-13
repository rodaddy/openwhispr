const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/llmRequestTimeout.js");

test("non-streaming LLM requests use the fixed 30-second timeout", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(typeof getLlmRequestTimeoutSeconds, "function");
  assert.equal(getLlmRequestTimeoutSeconds(), 30);
});

test("streaming LLM requests keep their fixed 60-second timeout", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(typeof getLlmRequestTimeoutSeconds, "function");
  assert.equal(getLlmRequestTimeoutSeconds({ streaming: true }), 60);
});

test("a per-call timeout overrides the default for either request kind", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(getLlmRequestTimeoutSeconds({ timeoutSeconds: 240 }), 240);
  assert.equal(getLlmRequestTimeoutSeconds({ streaming: true, timeoutSeconds: 240 }), 240);
  assert.equal(getLlmRequestTimeoutSeconds({ timeoutSeconds: 0 }), 30);
  assert.equal(getLlmRequestTimeoutSeconds({ timeoutSeconds: undefined }), 30);
});

test("long-input timeout starts at a 60-second floor", async () => {
  const { getLongInputTimeoutSeconds } = await load();

  assert.equal(getLongInputTimeoutSeconds(0), 60);
  assert.equal(getLongInputTimeoutSeconds(-5), 60);
  assert.equal(getLongInputTimeoutSeconds(NaN), 60);
});

test("long-input timeout grows 30 seconds per 10K characters", async () => {
  const { getLongInputTimeoutSeconds } = await load();

  assert.equal(getLongInputTimeoutSeconds(10_000), 90);
  assert.equal(getLongInputTimeoutSeconds(50_000), 210);
  // Note 96: a 154,170-char meeting transcript gets several minutes.
  const meeting = getLongInputTimeoutSeconds(154_170);
  assert.ok(meeting >= 300 && meeting < 600, `got ${meeting}s`);
});

test("long-input timeout stops at a 10-minute ceiling", async () => {
  const { getLongInputTimeoutSeconds } = await load();

  assert.equal(getLongInputTimeoutSeconds(180_000), 600);
  assert.equal(getLongInputTimeoutSeconds(5_000_000), 600);
});
