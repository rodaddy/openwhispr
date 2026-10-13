const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_ACTIVATION_MODE,
  HYBRID_TAP_THRESHOLD_MS,
  MIN_LATCHED_STOP_MS,
  PENDING_PRESS_TTL_MS,
  normalizeActivationMode,
  usesKeyRelease,
  toHotkeyRegistrationMode,
  resolveDictationPress,
  resolveDictationRelease,
  resolveHoldStartDelayMs,
  shouldReplayPendingPress,
  resolveHeldDurationMs,
} = require("../../src/helpers/activationMode");

test("fresh profiles default to hybrid without changing invalid explicit normalization", () => {
  assert.equal(DEFAULT_ACTIVATION_MODE, "hybrid");
  assert.equal(normalizeActivationMode("tap"), "tap");
  assert.equal(normalizeActivationMode("push"), "push");
  assert.equal(normalizeActivationMode("hybrid"), "hybrid");
  assert.equal(normalizeActivationMode("invalid"), "tap");
});

test("unknown modes normalize to tap; hybrid survives", () => {
  assert.equal(normalizeActivationMode("hybrid"), "hybrid");
  assert.equal(normalizeActivationMode("push"), "push");
  assert.equal(normalizeActivationMode("tap"), "tap");
  assert.equal(normalizeActivationMode(undefined), "tap");
  assert.equal(normalizeActivationMode("bogus"), "tap");
});

test("hybrid needs key-release plumbing and registers as push", () => {
  assert.equal(usesKeyRelease("tap"), false);
  assert.equal(usesKeyRelease("push"), true);
  assert.equal(usesKeyRelease("hybrid"), true);
  assert.equal(toHotkeyRegistrationMode("hybrid"), "push");
  assert.equal(toHotkeyRegistrationMode("tap"), "tap");
});

test("press: tap toggles, push holds, hybrid holds unless a latched recording runs", () => {
  assert.equal(resolveDictationPress({ mode: "tap", isRecording: false }), "toggle");
  assert.equal(resolveDictationPress({ mode: "tap", isRecording: true }), "toggle");
  assert.equal(resolveDictationPress({ mode: "push", isRecording: false }), "hold");
  assert.equal(resolveDictationPress({ mode: "hybrid", isRecording: false }), "hold");
  assert.equal(resolveDictationPress({ mode: "hybrid", isRecording: true }), "stop");
});

test("release in push mode: stop when recording, cancel otherwise", () => {
  assert.equal(resolveDictationRelease({ mode: "push", heldMs: 50, isRecording: false }), "cancel");
  assert.equal(resolveDictationRelease({ mode: "push", heldMs: 50, isRecording: true }), "stop");
  assert.equal(resolveDictationRelease({ mode: "push", heldMs: 2000, isRecording: true }), "stop");
});

test("release in hybrid mode: short press latches, long press stops", () => {
  const below = HYBRID_TAP_THRESHOLD_MS - 1;
  const atThreshold = HYBRID_TAP_THRESHOLD_MS;
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 80, isRecording: false }),
    "latch"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: below, isRecording: true }),
    "latch"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: atThreshold, isRecording: true }),
    "stop"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 5000, isRecording: true }),
    "stop"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 5000, isRecording: false }),
    "cancel"
  );
});

test("a forced release (listener reset, safety timeout) never latches", () => {
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 10, isRecording: true, force: true }),
    "stop"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 10, isRecording: false, force: true }),
    "cancel"
  );
});

test("hybrid records from the press; push keeps the hold delay", () => {
  assert.equal(resolveHoldStartDelayMs("hybrid", 150), 0);
  assert.equal(resolveHoldStartDelayMs("push", 150), 150);
  assert.equal(resolveHoldStartDelayMs("tap", 150), 150);
});

test("a press parked during processing replays while fresh", () => {
  const pressedAt = 1000;
  const fresh = pressedAt + PENDING_PRESS_TTL_MS;
  const stale = pressedAt + PENDING_PRESS_TTL_MS + 1;
  assert.equal(shouldReplayPendingPress({ mode: "hybrid", pressedAt, now: fresh }), true);
  assert.equal(shouldReplayPendingPress({ mode: "tap", pressedAt, now: fresh }), true);
  assert.equal(shouldReplayPendingPress({ mode: "hybrid", pressedAt, now: stale }), false);
  // A hybrid tap released while waiting still latches a recording.
  assert.equal(
    shouldReplayPendingPress({ mode: "hybrid", pressedAt, now: fresh, released: true }),
    true
  );
  // Push only records while held: a released press has nothing to replay.
  assert.equal(
    shouldReplayPendingPress({ mode: "push", pressedAt, now: fresh, released: true }),
    false
  );
  assert.equal(
    shouldReplayPendingPress({ mode: "push", pressedAt, now: fresh, released: false }),
    true
  );
});

test("a tap-latch-tap cycle on one key", () => {
  // First tap: press with nothing running -> hold state machine; release at 120 ms latches.
  assert.equal(resolveDictationPress({ mode: "hybrid", isRecording: false }), "hold");
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 120, isRecording: true }),
    "latch"
  );
  // Second tap: press with the latched recording running -> stop.
  assert.equal(resolveDictationPress({ mode: "hybrid", isRecording: true }), "stop");
});

test("native event time preserves a quick release delayed in the main-process queue", () => {
  assert.equal(
    resolveHeldDurationMs({
      pressedEventTimeMs: 10_000,
      releasedEventTimeMs: 10_120,
      pressedAtMs: 20_000,
      releasedAtMs: 20_735,
    }),
    120
  );
});

test("native event time preserves a normal hold and invalid native time falls back", () => {
  assert.equal(
    resolveHeldDurationMs({
      pressedEventTimeMs: 10_000,
      releasedEventTimeMs: 10_700,
      pressedAtMs: 20_000,
      releasedAtMs: 20_050,
    }),
    700
  );
  assert.equal(
    resolveHeldDurationMs({
      pressedEventTimeMs: 10_700,
      releasedEventTimeMs: 10_000,
      pressedAtMs: 20_000,
      releasedAtMs: 20_140,
    }),
    140
  );
});

test("a hybrid stop tap right after the start is ignored, not a stop (#549)", () => {
  const press = (activeForMs) =>
    resolveDictationPress({ mode: "hybrid", isRecording: true, activeForMs });
  // Rico's double tap on 2.0.21: the second press came 217 ms after the start.
  assert.equal(press(217), "ignore");
  assert.equal(press(0), "ignore");
  assert.equal(press(MIN_LATCHED_STOP_MS - 1), "ignore");
  assert.equal(press(MIN_LATCHED_STOP_MS), "stop");
  assert.equal(press(5000), "stop");
  assert.equal(press(Infinity), "stop", "an unknown start time still stops");
  // Only a latched hybrid take is guarded.
  assert.equal(
    resolveDictationPress({ mode: "tap", isRecording: true, activeForMs: 10 }),
    "toggle"
  );
  assert.equal(
    resolveDictationPress({ mode: "hybrid", isRecording: false, activeForMs: 10 }),
    "hold"
  );
});
