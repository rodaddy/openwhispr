const test = require("node:test");
const assert = require("node:assert/strict");

const createMeetingAutoEndController = require("../../src/helpers/meetingAutoEndController");
const {
  SILENCE_WINDOW_MS,
  FAST_SILENCE_MS,
  OWNERSHIP_MIN_ACTIVE_MS,
  OWNERSHIP_CONFIRM_MS,
  TICK_GAP_MS,
  WITHDRAW_BACKOFF_MS,
  WITHDRAW_BACKOFF_MAX_MS,
} = createMeetingAutoEndController;

const START_TIME = 1_000_000;
const TICK_MS = 1_000;

const createHarness = () => {
  let now = START_TIME;
  const proposals = [];
  const controller = createMeetingAutoEndController({
    now: () => now,
    onPropose: (sessionId, reason) => proposals.push({ sessionId, reason }),
  });

  const runFor = (ms) => {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(TICK_MS, remaining);
      now += step;
      remaining -= step;
      controller.tick();
    }
  };

  return {
    controller,
    proposals,
    runFor,
    jump: (ms) => {
      now += ms;
    },
  };
};

const beginOwnership = (controller, sessionId = "s1") =>
  controller.beginSession({ sessionId, eligible: true, reliable: true, externalMicActive: true });

const beginFallback = (controller, sessionId = "s1", { reliable = true } = {}) =>
  controller.beginSession({ sessionId, eligible: true, reliable, externalMicActive: false });

const micReleased = (controller, sessionId = "s1") =>
  controller.handleExternalMicState({ sessionId, reliable: true, externalMicActive: false });

const micAcquired = (controller, sessionId = "s1") =>
  controller.handleExternalMicState({ sessionId, reliable: true, externalMicActive: true });

const audio = (controller, micActive, systemActive, sessionId = "s1") =>
  controller.handleAudioActivity({ sessionId, micActive, systemActive });

test("ownership: a qualifying mic release stops after the confirm window", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller);
  assert.deepEqual(harness.proposals, []);
  harness.runFor(OWNERSHIP_CONFIRM_MS - TICK_MS);
  assert.deepEqual(harness.proposals, []);

  harness.runFor(TICK_MS);
  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "mic-released" }]);
});

// A device flap (Bluetooth reconnect, input-device switch, an app rebuilding
// its input unit for screen share) emits MIC_STOP then MIC_START in the same
// reconcile pass, with no time between them.
test("ownership: a mic release immediately followed by a re-acquire keeps recording", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller);
  micAcquired(harness.controller);

  harness.runFor(4 * OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.proposals, []);
});

test("ownership: remote audio during the confirm window restarts it", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller);
  harness.runFor(OWNERSHIP_CONFIRM_MS - TICK_MS);
  audio(harness.controller, false, true);
  harness.runFor(4 * OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.proposals, []);

  audio(harness.controller, false, false);
  harness.runFor(OWNERSHIP_CONFIRM_MS - TICK_MS);
  assert.deepEqual(harness.proposals, []);

  harness.runFor(TICK_MS);
  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("ownership: remote audio defers stopping until the system channel goes quiet", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  audio(harness.controller, false, true);

  micReleased(harness.controller);
  harness.runFor(2 * SILENCE_WINDOW_MS);
  assert.deepEqual(harness.proposals, []);

  audio(harness.controller, false, false);
  harness.runFor(OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("ownership: mic-channel activity does not mask a qualifying release", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  audio(harness.controller, true, false);

  micReleased(harness.controller);
  harness.runFor(OWNERSHIP_CONFIRM_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("ownership: a brief external mic hold falls back to the silence window", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  audio(harness.controller, true, false);
  micAcquired(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS - TICK_MS);

  micReleased(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS);
  assert.deepEqual(harness.proposals, []);

  audio(harness.controller, false, false);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.proposals, []);
  harness.runFor(TICK_MS);
  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

test("ownership: process exit is ignored while an app owns the mic", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  harness.controller.handleMeetingProcessExit({ sessionId: "s1" });
  harness.runFor(2 * SILENCE_WINDOW_MS);

  assert.deepEqual(harness.proposals, []);
});

test("fallback: both channels staying quiet for 60 seconds stops immediately", () => {
  const harness = createHarness();
  beginFallback(harness.controller);

  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.proposals, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

test("fallback: activity on either channel restarts the silence window", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS - 5_000);

  audio(harness.controller, true, false);
  harness.runFor(5_000);
  audio(harness.controller, false, false);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.proposals, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

test("fallback: process exit shortens the quiet window to 10 seconds", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(20_000);

  harness.controller.handleMeetingProcessExit({ sessionId: "s1" });
  harness.runFor(FAST_SILENCE_MS - TICK_MS);
  assert.deepEqual(harness.proposals, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "process-exit" }]);
});

test("fallback: activity after process exit restores the full silence window", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.controller.handleMeetingProcessExit({ sessionId: "s1" });
  harness.runFor(5_000);

  audio(harness.controller, false, true);
  harness.runFor(5_000);
  audio(harness.controller, false, false);
  harness.runFor(FAST_SILENCE_MS);
  assert.deepEqual(harness.proposals, []);

  harness.runFor(SILENCE_WINDOW_MS - FAST_SILENCE_MS);
  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

test("fallback: a session with no chunks still stops after the silence window", () => {
  const harness = createHarness();
  beginFallback(harness.controller);

  harness.runFor(SILENCE_WINDOW_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

test("fallback: unreliable ownership uses the silence window from session start", () => {
  const harness = createHarness();
  beginFallback(harness.controller, "s1", { reliable: false });

  harness.runFor(SILENCE_WINDOW_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

test("mode transitions: fresh ownership switches fallback into ownership mode", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);

  micAcquired(harness.controller);
  harness.runFor(2 * SILENCE_WINDOW_MS);
  assert.deepEqual(harness.proposals, []);

  micReleased(harness.controller);
  harness.runFor(OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("mode transitions: reliability loss restarts fallback silence from that moment", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  harness.controller.handleExternalMicState({
    sessionId: "s1",
    reliable: false,
    externalMicActive: false,
  });
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.proposals, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

test("mode transitions: an inactive reliable report after reliability loss stays fallback", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  harness.controller.handleExternalMicState({
    sessionId: "s1",
    reliable: false,
    externalMicActive: false,
  });
  harness.runFor(5_000);

  micReleased(harness.controller);
  assert.deepEqual(harness.proposals, []);
  harness.runFor(SILENCE_WINDOW_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

test("clock: a sleep-sized tick gap discards accumulated silence", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);

  harness.jump(TICK_GAP_MS + 1);
  harness.controller.tick();
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.proposals, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

// Every entry point observes the clock, not just tick(): after wake the owner's
// monitor can deliver an activity change before the controller's own tick runs,
// and that path has to discard the pre-sleep silence too.
test("clock: a sleep-sized gap observed through an activity event discards accumulated silence", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);

  harness.jump(TICK_GAP_MS + 1);
  audio(harness.controller, false, false);

  assert.deepEqual(harness.proposals, []);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.proposals, []);

  harness.runFor(TICK_MS);
  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "silence" }]);
});

// endSession drops the session outright, so evidence gathered before it can
// never drive a stop afterwards. Every _deactivateAutoEnd goes through here.
test("ending a session keeps its pending evidence from stopping anything later", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(harness.controller);

  harness.controller.endSession("s1");
  harness.runFor(OWNERSHIP_CONFIRM_MS + SILENCE_WINDOW_MS);

  assert.deepEqual(harness.proposals, []);
});

test("ending a session that is not the live one leaves the live one running", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(harness.controller);

  harness.controller.endSession("s2");
  harness.runFor(OWNERSHIP_CONFIRM_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("clock: a mic release observed on wake does not stop immediately", () => {
  const { controller, jump, runFor, proposals } = createHarness();
  beginOwnership(controller);
  runFor(OWNERSHIP_MIN_ACTIVE_MS);

  jump(TICK_GAP_MS + 1);
  controller.handleExternalMicState({
    sessionId: "s1",
    reliable: true,
    externalMicActive: false,
  });

  assert.deepEqual(proposals, []);
  runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(proposals, []);
  runFor(TICK_MS);
  assert.deepEqual(proposals, [{ sessionId: "s1", reason: "silence" }]);
});

test("lifecycle: an open proposal fires once while nothing contradicts it", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(harness.controller);
  harness.runFor(OWNERSHIP_CONFIRM_MS);

  harness.controller.handleMeetingProcessExit({ sessionId: "s1" });
  micReleased(harness.controller);
  harness.runFor(5 * SILENCE_WINDOW_MS);

  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("windows: the triggers are hardened against mid-meeting false stops", () => {
  assert.equal(OWNERSHIP_CONFIRM_MS, 60_000);
  assert.equal(SILENCE_WINDOW_MS, 120_000);
  assert.equal(FAST_SILENCE_MS, 30_000);
});

const createCancelHarness = () => {
  let now = START_TIME;
  const events = [];
  const controller = createMeetingAutoEndController({
    now: () => now,
    onPropose: (sessionId, reason) => events.push(["propose", sessionId, reason]),
    onCancel: (sessionId, reason, trigger) => events.push(["cancel", sessionId, reason, trigger]),
  });
  const runFor = (ms) => {
    for (let remaining = ms; remaining > 0; remaining -= TICK_MS) {
      now += Math.min(TICK_MS, remaining);
      controller.tick();
    }
  };
  return {
    controller,
    events,
    runFor,
    jump: (ms) => {
      now += ms;
    },
  };
};

for (const [label, micActive, systemActive, trigger] of [
  ["mic", true, false, "mic-activity"],
  ["system", false, true, "system-activity"],
]) {
  test(`proposal: renewed ${label} activity withdraws it and restarts the window`, () => {
    const { controller, events, runFor } = createCancelHarness();
    beginFallback(controller);
    runFor(SILENCE_WINDOW_MS);
    assert.deepEqual(events, [["propose", "s1", "silence"]]);

    audio(controller, micActive, systemActive);
    assert.deepEqual(events[1], ["cancel", "s1", "silence", trigger]);

    // The first withdrawal holds the next ask off for one backoff step; the
    // last held tick restarts the window.
    audio(controller, false, false);
    runFor(WITHDRAW_BACKOFF_MS + SILENCE_WINDOW_MS - 2 * TICK_MS);
    assert.equal(events.length, 2);
    runFor(TICK_MS);
    assert.deepEqual(events[2], ["propose", "s1", "silence"]);
  });
}

test("proposal: the external mic coming back withdraws a mic-released proposal", () => {
  const { controller, events, runFor } = createCancelHarness();
  beginOwnership(controller);
  runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(controller);
  runFor(OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(events, [["propose", "s1", "mic-released"]]);

  micAcquired(controller);
  assert.deepEqual(events[1], ["cancel", "s1", "mic-released", "external-mic"]);
});

test("proposal: activity with no proposal open reports no cancel", () => {
  const { controller, events } = createCancelHarness();
  beginFallback(controller);
  audio(controller, true, true);
  micAcquired(controller);
  assert.deepEqual(events, []);
});

test("suppress: Keep recording holds every path until the grace ends, then starts over", () => {
  const { controller, events, runFor } = createCancelHarness();
  beginFallback(controller);
  runFor(SILENCE_WINDOW_MS);
  assert.equal(events.length, 1);

  const graceMs = 5 * 60_000;
  controller.suppress("s1", START_TIME + SILENCE_WINDOW_MS + graceMs);
  controller.handleMeetingProcessExit({ sessionId: "s1" });
  runFor(graceMs);
  assert.equal(events.length, 1);

  // The last suppressed tick (one before the grace ends) restarts the window.
  runFor(SILENCE_WINDOW_MS - 2 * TICK_MS);
  assert.equal(events.length, 1);
  runFor(TICK_MS);
  assert.deepEqual(events[1], ["propose", "s1", "silence"]);
});

test("suppress: a stale session id is ignored", () => {
  const { controller, events, runFor } = createCancelHarness();
  beginFallback(controller);
  runFor(SILENCE_WINDOW_MS);
  controller.suppress("other", START_TIME + 10 * SILENCE_WINDOW_MS);
  audio(controller, true, false);
  assert.deepEqual(events[1], ["cancel", "s1", "silence", "mic-activity"]);
});

test("guards: stale session ids and ineligible sessions ignore inputs", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller, "other");
  audio(harness.controller, false, false, "other");
  harness.controller.handleMeetingProcessExit({ sessionId: "other" });
  assert.deepEqual(harness.proposals, []);

  harness.controller.beginSession({
    sessionId: "s2",
    eligible: false,
    reliable: true,
    externalMicActive: true,
  });
  micReleased(harness.controller, "s2");
  harness.runFor(2 * SILENCE_WINDOW_MS);
  assert.deepEqual(harness.proposals, []);
});

test("initial state: an already-audible system channel defers ownership stop", () => {
  const harness = createHarness();
  harness.controller.beginSession({
    sessionId: "s1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
    micActive: false,
    systemActive: true,
  });
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller);
  assert.deepEqual(harness.proposals, []);

  audio(harness.controller, false, false);
  harness.runFor(OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.proposals, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("proposal: a sleep-sized gap withdraws it so wake cannot stop the recording", () => {
  const { controller, events, runFor, jump } = createCancelHarness();
  beginFallback(controller);
  runFor(SILENCE_WINDOW_MS);
  assert.deepEqual(events, [["propose", "s1", "silence"]]);

  jump(TICK_GAP_MS + 1);
  controller.tick();
  assert.deepEqual(events[1], ["cancel", "s1", "silence", "clock-gap"]);
});

test("proposal: speech on the mic withdraws an ownership proposal too", () => {
  const { controller, events, runFor } = createCancelHarness();
  beginOwnership(controller);
  runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(controller);
  audio(controller, true, false);
  runFor(OWNERSHIP_CONFIRM_MS);
  // The mic was already active when the card opened; the next utterance after
  // a pause is a fresh edge and withdraws it.
  assert.deepEqual(events, [["propose", "s1", "mic-released"]]);

  audio(controller, false, false);
  audio(controller, true, false);
  assert.deepEqual(events[1], ["cancel", "s1", "mic-released", "mic-activity"]);
});

test("proposal: losing ownership reliability withdraws a mic-released proposal", () => {
  const { controller, events, runFor } = createCancelHarness();
  beginOwnership(controller);
  runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(controller);
  runFor(OWNERSHIP_CONFIRM_MS);

  controller.handleExternalMicState({
    sessionId: "s1",
    reliable: false,
    externalMicActive: false,
  });
  assert.deepEqual(events[1], ["cancel", "s1", "mic-released", "mic-unreliable"]);
});

test("backoff: each withdrawal doubles the wait before asking again, up to the cap", () => {
  const { controller, events, runFor } = createCancelHarness();
  beginFallback(controller);
  const proposeTimes = [];
  const runUntilProposal = () => {
    const before = events.filter(([kind]) => kind === "propose").length;
    let waited = 0;
    while (events.filter(([kind]) => kind === "propose").length === before) {
      runFor(TICK_MS);
      waited += TICK_MS;
      assert.ok(waited <= WITHDRAW_BACKOFF_MAX_MS + SILENCE_WINDOW_MS, "never asked again");
    }
    proposeTimes.push(waited);
  };

  runUntilProposal();
  for (let round = 0; round < 6; round += 1) {
    audio(controller, true, false);
    audio(controller, false, false);
    runUntilProposal();
  }
  // First ask after the plain window, then 1, 2, 4, 8, 15 (cap), 15 minutes more.
  const extra = proposeTimes.slice(1).map((ms) => ms - SILENCE_WINDOW_MS + TICK_MS);
  assert.deepEqual(
    extra,
    [1, 2, 4, 8, 15, 15].map((minutes) => minutes * 60_000)
  );
});

test("backoff: Keep recording resets the backoff", () => {
  const { controller, events, runFor } = createCancelHarness();
  beginFallback(controller);
  runFor(SILENCE_WINDOW_MS);
  audio(controller, true, false);
  audio(controller, false, false);
  runFor(WITHDRAW_BACKOFF_MS + SILENCE_WINDOW_MS);
  assert.equal(events.filter(([kind]) => kind === "propose").length, 2);

  controller.suppress("s1", 0);
  audio(controller, true, false);
  audio(controller, false, false);
  runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.equal(events.filter(([kind]) => kind === "propose").length, 2);
  runFor(TICK_MS);
  assert.equal(events.filter(([kind]) => kind === "propose").length, 3);
  // The withdrawal after Keep is the first again: one backoff step, not two.
  audio(controller, true, false);
  audio(controller, false, false);
  runFor(WITHDRAW_BACKOFF_MS + SILENCE_WINDOW_MS - TICK_MS);
  assert.equal(events.filter(([kind]) => kind === "propose").length, 4);
});

test("backoff: a sleep gap withdraws without adding backoff", () => {
  let now = START_TIME;
  const events = [];
  const controller = createMeetingAutoEndController({
    now: () => now,
    onPropose: (sessionId, reason) => events.push(["propose", reason]),
    onCancel: (sessionId, reason, trigger) => events.push(["cancel", trigger]),
  });
  const runFor = (ms) => {
    for (let remaining = ms; remaining > 0; remaining -= TICK_MS) {
      now += TICK_MS;
      controller.tick();
    }
  };
  beginFallback(controller);
  runFor(SILENCE_WINDOW_MS);
  now += TICK_GAP_MS + 1;
  controller.tick();
  assert.deepEqual(events, [
    ["propose", "silence"],
    ["cancel", "clock-gap"],
  ]);
  runFor(SILENCE_WINDOW_MS);
  assert.deepEqual(events[2], ["propose", "silence"]);
});

test("backoff: losing mic reliability withdraws without adding backoff", () => {
  const { controller, events, runFor } = createCancelHarness();
  beginOwnership(controller);
  runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(controller);
  runFor(OWNERSHIP_CONFIRM_MS);
  controller.handleExternalMicState({ sessionId: "s1", reliable: false, externalMicActive: false });
  assert.deepEqual(events[1], ["cancel", "s1", "mic-released", "mic-unreliable"]);

  runFor(SILENCE_WINDOW_MS);
  assert.deepEqual(events[2], ["propose", "s1", "silence"]);
});
