const test = require("node:test");
const assert = require("node:assert/strict");

test("fails open when no windows were recorded", async () => {
  const { createLocalSpeechGateState, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  assert.deepEqual(getLocalSpeechGateDecision(createLocalSpeechGateState()), {
    skip: false,
    reason: "unavailable",
  });
  assert.deepEqual(getLocalSpeechGateDecision(null), { skip: false, reason: "unavailable" });
});

test("treats near silence as skippable", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.0012, 0.01);
  recordLocalSpeechWindow(state, 0.0016, 0.015);
  recordLocalSpeechWindow(state, 0.0014, 0.012);

  assert.deepEqual(getLocalSpeechGateDecision(state), {
    skip: true,
    reason: "silence",
    peakRms: 0.0016,
    peakAmplitude: 0.015,
    windowCount: 3,
    speechWindowCount: 0,
    maxConsecutiveSpeechWindows: 0,
  });
});

test("rejects isolated noise bursts without sustained speech", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  // All windows have energy above silence but below speech thresholds
  recordLocalSpeechWindow(state, 0.0025, 0.015);
  recordLocalSpeechWindow(state, 0.0028, 0.018);
  recordLocalSpeechWindow(state, 0.0022, 0.014);

  const decision = getLocalSpeechGateDecision(state);

  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "insufficient_speech");
  assert.equal(decision.peakRms, 0.0028);
  assert.equal(decision.peakAmplitude, 0.018);
  assert.equal(decision.windowCount, 3);
  assert.equal(decision.speechWindowCount, 0);
  assert.equal(decision.maxConsecutiveSpeechWindows, 0);
});

test("allows sustained speech-like energy through", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.003, 0.025);
  recordLocalSpeechWindow(state, 0.0056, 0.06);
  recordLocalSpeechWindow(state, 0.0061, 0.065);

  assert.deepEqual(getLocalSpeechGateDecision(state), {
    skip: false,
    reason: "speech_detected",
    peakRms: 0.0061,
    peakAmplitude: 0.065,
    windowCount: 3,
    speechWindowCount: 3,
    maxConsecutiveSpeechWindows: 3,
  });
});

// Feeds one 100 ms window per entry and collects every non-null result.
const feedEndOfSpeech = (recordEndOfSpeechWindow, state, windows) =>
  windows.map((isSpeech) => recordEndOfSpeechWindow(state, isSpeech)).filter(Boolean);
const repeat = (value, count) => Array.from({ length: count }, () => value);

test("ends a take once speech is followed by 800 ms of silence, exactly once", async () => {
  const { createEndOfSpeechState, recordEndOfSpeechWindow } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createEndOfSpeechState();
  const beforeEnd = feedEndOfSpeech(recordEndOfSpeechWindow, state, [
    ...repeat(false, 3),
    ...repeat(true, 4),
    ...repeat(false, 7),
  ]);
  assert.deepEqual(beforeEnd, []);
  assert.equal(recordEndOfSpeechWindow(state, false), "speech_ended");
  assert.deepEqual(
    feedEndOfSpeech(recordEndOfSpeechWindow, state, [...repeat(false, 100), ...repeat(true, 5)]),
    []
  );
});

test("too little speech (a cough) counts as no speech after 8 s", async () => {
  const { createEndOfSpeechState, recordEndOfSpeechWindow } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createEndOfSpeechState();
  const windows = [true, ...repeat(false, 150)];
  const results = windows.map((isSpeech) => recordEndOfSpeechWindow(state, isSpeech));
  assert.deepEqual(results.filter(Boolean), ["no_speech"]);
  assert.equal(results.indexOf("no_speech"), 79);
});

test("reports no speech after 8 s of silence", async () => {
  const { createEndOfSpeechState, recordEndOfSpeechWindow } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createEndOfSpeechState();
  assert.deepEqual(feedEndOfSpeech(recordEndOfSpeechWindow, state, repeat(false, 79)), []);
  assert.equal(recordEndOfSpeechWindow(state, false), "no_speech");
  assert.deepEqual(feedEndOfSpeech(recordEndOfSpeechWindow, state, repeat(false, 100)), []);
});

test("a short pause between words does not end the take", async () => {
  const { createEndOfSpeechState, recordEndOfSpeechWindow } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createEndOfSpeechState();
  assert.deepEqual(
    feedEndOfSpeech(recordEndOfSpeechWindow, state, [
      ...repeat(true, 3),
      ...repeat(false, 5),
      ...repeat(true, 3),
      ...repeat(false, 7),
    ]),
    []
  );
});

test("isSpeechWindow needs both the rms and the peak threshold", async () => {
  const { isSpeechWindow } = await import("../../src/helpers/localSpeechGate.js");

  assert.equal(isSpeechWindow(0.003, 0.02), true);
  assert.equal(isSpeechWindow(0.0029, 0.5), false);
  assert.equal(isSpeechWindow(0.5, 0.019), false);
});
