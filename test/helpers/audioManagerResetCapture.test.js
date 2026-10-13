const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const LOG_KEY = "__resetCaptureLogs";

async function loadHarness(t) {
  globalThis[LOG_KEY] = [];
  t.after(() => {
    delete globalThis[LOG_KEY];
  });
  return loadAudioManager(t, {
    cachePrefix: "openwhispr-reset-capture-test-",
    settingsKey: "__resetCaptureSettings",
    settings: { useLocalWhisper: true, localTranscriptionProvider: "whisper" },
    mockModules: {
      "/utils/logger": `
        const push = (level) => (message, meta) =>
          globalThis.${LOG_KEY}.push({ level, message, meta });
        export default { debug: push("debug"), info: push("info"), warn: push("warn"),
          error: push("error"), logReasoning() {} };
      `,
    },
  });
}

function spies(calls) {
  return {
    micRecovery: { stop: () => calls.push("recovery-stop") },
    preparedMicCapture: { cancel: () => calls.push("prepared-cancel") },
    micStreamHold: { drop: () => calls.push("hold-drop") },
  };
}

test("cancelRecording on a batch recording resets capture and names its source", async (t) => {
  const { createManager } = await loadHarness(t);
  const calls = [];
  const trackStops = [];
  const recorder = {
    state: "recording",
    stop() {},
    stream: { getTracks: () => [{ stop: () => trackStops.push("clone-stop") }] },
  };
  const manager = createManager({
    ...spies(calls),
    mediaRecorder: recorder,
    isRecording: true,
    persistHistory: false,
    cachedMicDeviceId: "stale-device",
    rejectedMicDeviceId: "rejected-device",
    _micWarmedAt: 123,
    teardownSpeechGate() {},
    cleanupPreview() {},
    _markCaptureStreamReleased() {},
    onStateChange() {},
  });

  assert.equal(manager.cancelRecording("escape-hotkey"), true);

  assert.ok(calls.includes("hold-drop"), "held master dropped");
  assert.ok(calls.includes("prepared-cancel"), "prepared capture cancelled");
  assert.equal(manager.cachedMicDeviceId, null);
  assert.equal(manager.rejectedMicDeviceId, null);
  assert.equal(manager._micWarmedAt, 0);
  assert.deepEqual(trackStops, ["clone-stop"]);
  const messages = globalThis[LOG_KEY].map((entry) => [entry.message, entry.meta]);
  assert.deepEqual(
    messages.filter(([message]) => message === "Recording cancelled"),
    [["Recording cancelled", { source: "escape-hotkey" }]]
  );
  assert.deepEqual(
    messages.filter(([message]) => message === "Dictation capture reset"),
    [["Dictation capture reset", { reason: "cancel:escape-hotkey" }]]
  );
});

test("cancelRecording with nothing to cancel neither logs nor resets", async (t) => {
  const { createManager } = await loadHarness(t);
  const calls = [];
  const manager = createManager({ ...spies(calls), isRecording: false, mediaRecorder: null });

  assert.equal(manager.cancelRecording("pill-button"), false);
  assert.deepEqual(calls, ["recovery-stop"]);
  assert.deepEqual(globalThis[LOG_KEY], []);
});

test("resetCapture is idempotent and survives a manager with no capture members", async (t) => {
  const { createManager } = await loadHarness(t);
  const bare = createManager({});
  assert.doesNotThrow(() => bare.resetCapture("no-members"));
  assert.doesNotThrow(() => bare.resetCapture("no-members"));

  const calls = [];
  const manager = createManager({ ...spies(calls), cachedMicDeviceId: "x" });
  manager.resetCapture("twice");
  manager.resetCapture("twice");
  assert.equal(manager.cachedMicDeviceId, null);
  assert.deepEqual(calls, [
    "recovery-stop",
    "prepared-cancel",
    "hold-drop",
    "recovery-stop",
    "prepared-cancel",
    "hold-drop",
  ]);

  const throwing = createManager({
    micRecovery: {
      stop: () => {
        throw new Error("boom");
      },
    },
    preparedMicCapture: {
      cancel: () => {
        throw new Error("boom");
      },
    },
    micStreamHold: {
      drop: () => {
        throw new Error("boom");
      },
    },
  });
  assert.doesNotThrow(() => throwing.resetCapture("throwing"));
});

test("after resetCapture the real hold hands out no clone, so the next take opens fresh", async (t) => {
  const { createManager } = await loadHarness(t);
  const { MicStreamHold: Hold } = await import("../../src/helpers/micStreamHold.js");
  const track = {
    readyState: "live",
    muted: false,
    stop() {
      this.readyState = "ended";
    },
    clone: () => ({}),
  };
  const hold = new Hold({
    holdSeconds: 10,
    setTimer: () => 1,
    clearTimer() {},
    makeStream: (clone) => ({ clone }),
  });
  hold.adoptAndClone({ getAudioTracks: () => [track] }, "key");
  const manager = createManager({ micStreamHold: hold });

  manager.resetCapture("no-audio");

  assert.equal(hold.acquireClone("key"), null);
  assert.equal(track.readyState, "ended");
});
