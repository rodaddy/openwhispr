const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/grill/turnDetector.ts");

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = (SAMPLE_RATE * 30) / 1000;

// A 30ms frame of a 220 Hz sine at the given peak amplitude (RMS = amp / sqrt 2).
function sineFrame(amplitude) {
  const frame = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < frame.length; i++) {
    frame[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
  }
  return frame;
}
const LOUD = sineFrame(0.2);
const QUIET = sineFrame(0.001);

/** Pushes `ms` worth of one frame and returns every event the detector emitted. */
function feed(detector, frameRms, frame, ms) {
  const events = [];
  for (let t = 0; t < ms; t += 30) events.push(detector.push(frameRms(frame)));
  return events;
}

test("frameRms is the root mean square of a frame", async () => {
  const { frameRms } = await load();
  assert.equal(frameRms(new Float32Array([0, 0, 0])), 0);
  assert.ok(Math.abs(frameRms(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9);
  assert.ok(Math.abs(frameRms(LOUD) - 0.2 / Math.SQRT2) < 0.01);
  assert.equal(frameRms(new Float32Array(0)), 0);
});

test("the defaults are the agreed turn rules", async () => {
  const { GRILL_TURN_DEFAULTS } = await load();
  assert.equal(GRILL_TURN_DEFAULTS.frameMs, 30);
  assert.equal(GRILL_TURN_DEFAULTS.speechStartMs, 300);
  assert.equal(GRILL_TURN_DEFAULTS.endSilenceMs, 1800);
  assert.equal(GRILL_TURN_DEFAULTS.maxAnswerMs, 180000);
  assert.equal(GRILL_TURN_DEFAULTS.noSpeechTimeoutMs, 20000);
  assert.ok(GRILL_TURN_DEFAULTS.threshold > 0.001 && GRILL_TURN_DEFAULTS.threshold < 0.1);
});

test("speech starts only after 300ms above the threshold", async () => {
  const { createTurnDetector, frameRms } = await load();
  const detector = createTurnDetector();
  // 270ms of speech is not yet speech.
  assert.ok(feed(detector, frameRms, LOUD, 270).every((e) => e === "waiting"));
  assert.equal(detector.push(frameRms(LOUD)), "speech-start");
  assert.equal(detector.speechStarted(), true);
});

test("a short blip resets the speech-start run", async () => {
  const { createTurnDetector, frameRms } = await load();
  const detector = createTurnDetector();
  feed(detector, frameRms, LOUD, 210);
  feed(detector, frameRms, QUIET, 30);
  assert.ok(feed(detector, frameRms, LOUD, 270).every((e) => e === "waiting"));
  assert.equal(detector.push(frameRms(LOUD)), "speech-start");
});

test("the turn ends after 1.8s of silence following speech, and pauses under that do not end it", async () => {
  const { createTurnDetector, frameRms } = await load();
  const detector = createTurnDetector();
  feed(detector, frameRms, LOUD, 600);
  // A 1.5s thinking pause keeps the turn open.
  assert.ok(feed(detector, frameRms, QUIET, 1500).every((e) => e === "speaking"));
  feed(detector, frameRms, LOUD, 300);
  const events = feed(detector, frameRms, QUIET, 1800);
  assert.equal(events.at(-1), "end");
  assert.ok(events.slice(0, -1).every((e) => e === "speaking"));
  // Terminal: it stays ended.
  assert.equal(detector.push(frameRms(LOUD)), "end");
});

test("no speech within 20s ends the take with no-speech", async () => {
  const { createTurnDetector, frameRms } = await load();
  const detector = createTurnDetector();
  const events = feed(detector, frameRms, QUIET, 20010);
  assert.equal(events.at(-1), "no-speech");
  assert.equal(events.filter((e) => e === "no-speech").length, 1);
  assert.equal(detector.speechStarted(), false);
});

test("an answer is capped at 3 minutes", async () => {
  const { createTurnDetector, frameRms } = await load();
  const detector = createTurnDetector();
  const events = feed(detector, frameRms, LOUD, 180000);
  assert.equal(events.at(-1), "cap");
  assert.equal(events.filter((e) => e === "cap").length, 1);
});

test("the threshold and timings are configurable", async () => {
  const { createTurnDetector, frameRms } = await load();
  const detector = createTurnDetector({ threshold: 0.5, speechStartMs: 60, endSilenceMs: 90 });
  // 0.2 peak is below a 0.5 threshold.
  assert.ok(feed(detector, frameRms, LOUD, 300).every((e) => e === "waiting"));
  const loud = sineFrame(0.99);
  feed(detector, frameRms, loud, 60);
  assert.equal(detector.speechStarted(), true);
  assert.equal(feed(detector, frameRms, QUIET, 90).at(-1), "end");
});
