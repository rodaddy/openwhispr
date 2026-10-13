const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAssistantPlaybackGate,
  ASSISTANT_PLAYBACK_TAIL_MS,
} = require("../../src/helpers/assistantPlaybackGate");

test("audio is dropped while the assistant is playing", () => {
  const gate = createAssistantPlaybackGate();
  gate.markPlaying(1000);
  assert.equal(gate.shouldDropAudio(1000), true);
  assert.equal(gate.shouldDropAudio(999999), true);
});

test("audio is dropped inside the tail after playback stops", () => {
  const gate = createAssistantPlaybackGate();
  gate.markPlaying(1000);
  gate.markStopped(2000);
  assert.equal(gate.shouldDropAudio(2000), true);
  assert.equal(gate.shouldDropAudio(2000 + ASSISTANT_PLAYBACK_TAIL_MS - 1), true);
});

test("audio is accepted once the tail has elapsed", () => {
  const gate = createAssistantPlaybackGate();
  gate.markPlaying(1000);
  gate.markStopped(2000);
  assert.equal(gate.shouldDropAudio(2000 + ASSISTANT_PLAYBACK_TAIL_MS), false);
  assert.equal(gate.shouldDropAudio(5000), false);
});

test("audio is accepted when the assistant has never played", () => {
  const gate = createAssistantPlaybackGate();
  assert.equal(gate.shouldDropAudio(0), false);
  assert.equal(gate.shouldDropAudio(123456), false);
});

test("the tail is 400 ms", () => {
  assert.equal(ASSISTANT_PLAYBACK_TAIL_MS, 400);
});
